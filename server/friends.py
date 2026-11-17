"""Stage with friends (Part 2 D): friend requests, messages between friends, challenges (beat my score, a class
challenge), comments at a moment of a Sound, reposts, and the Friends feed.

Friends     a request that the other person accepts (follows stay one-way, in community.py). Asking someone who
            already asked you makes you friends at once. Blocking (community.py) ends it and stops new requests.
Messages    only between friends, text only, rate-limited; blocked or unfriended conversations stop.
Challenges  "Beat my score": you send a friend a piece with your score; they play it and the better score wins.
            A teacher can open the same kind of challenge to a whole class for a week, with a leaderboard.
            (The daily riff and the weekly challenge stay in stage.py / community.py.)
Moments     comments on a Sound at a time in it (SoundCloud's timed comments).
Reposts     share a Stage post or a Sound with the people who follow you; they show in their Friends feed.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import Column, Float, Integer, String, Table, Text, and_, delete, func, insert, or_, select, update

import accounts as A
import community as CM
import sounds as SD
from academy import _iso, _now, classes, engine, members, meta

router = APIRouter(prefix="/c", tags=["friends"])

friend_requests = Table("friend_requests", meta,
                        Column("sender", String(36), primary_key=True),
                        Column("receiver", String(36), primary_key=True, index=True),
                        Column("created", Float, nullable=False))
friendships = Table("friendships", meta,                     # one row per pair, a < b
                    Column("a", String(36), primary_key=True),
                    Column("b", String(36), primary_key=True, index=True),
                    Column("created", Float, nullable=False))
messages = Table("direct_messages", meta,
                 Column("id", String(36), primary_key=True),
                 Column("pair", String(80), nullable=False, index=True),          # "<a>:<b>", a < b
                 Column("sender", String(36), nullable=False),
                 Column("text", Text, nullable=False),
                 Column("created", Float, nullable=False),
                 Column("read", Float, nullable=True))
duels = Table("duels", meta,
              Column("id", String(16), primary_key=True),
              Column("sender", String(36), nullable=False, index=True),
              Column("receiver", String(36), nullable=True, index=True),           # a friend, or
              Column("class_id", String(36), nullable=True, index=True),           # a whole class
              Column("piece_title", String(160), nullable=False),
              Column("catalog_id", String(80), nullable=False, default=""),
              Column("score", Float, nullable=False),                              # the sender's accuracy (0..1)
              Column("tempo_pct", Integer, nullable=False, default=100),
              Column("ends", Float, nullable=False),
              Column("created", Float, nullable=False))
duel_entries = Table("duel_entries", meta,
                     Column("duel_id", String(16), primary_key=True),
                     Column("user_id", String(36), primary_key=True),
                     Column("score", Float, nullable=False),
                     Column("tempo_pct", Integer, nullable=False, default=100),
                     Column("created", Float, nullable=False))
moments = Table("sound_moments", meta,
                Column("id", String(36), primary_key=True),
                Column("sound_id", String(16), nullable=False, index=True),
                Column("user_id", String(36), nullable=False),
                Column("at", Float, nullable=False),                            # seconds into the Sound
                Column("text", String(280), nullable=False),
                Column("created", Float, nullable=False))
reposts = Table("reposts", meta,
                Column("user_id", String(36), primary_key=True),
                Column("target", String(20), primary_key=True),                 # p:<post id> | s:<sound id>
                Column("created", Float, nullable=False))

DUEL_DAYS = 7
CLASS_DAYS = 7


def _pair(x: str, y: str) -> tuple[str, str]:
    return (x, y) if x < y else (y, x)


def are_friends(c, x: str, y: str) -> bool:
    a, b = _pair(x, y)
    return bool(c.execute(select(friendships.c.a).where(friendships.c.a == a, friendships.c.b == b)).first())


def friend_ids(c, uid: str) -> list[str]:
    return [r[0] for r in c.execute(select(friendships.c.b).where(friendships.c.a == uid)).all()] + \
           [r[0] for r in c.execute(select(friendships.c.a).where(friendships.c.b == uid)).all()]


def _blocked_either(c, x: str, y: str) -> bool:
    return bool(c.execute(select(CM.blocks.c.blocker).where(or_(and_(CM.blocks.c.blocker == x, CM.blocks.c.blocked == y),
                                                                 and_(CM.blocks.c.blocker == y, CM.blocks.c.blocked == x)))).first())


def _need_handle(me: A.Me) -> None:
    """Things other people see (requests, messages, challenges, comments) need a real sign-in and a username."""
    A.require_registered(me)
    if not me.acc.get("handle"):
        raise HTTPException(403, {"code": "handle_needed", "message": "Choose a username first (Me > Account)."})


def _other(c, handle: str, me: A.Me) -> dict:
    user, _ = CM._user_by_handle(c, handle)
    if user["id"] == me.id:
        raise HTTPException(400, "That's you!")
    return user


# -------------------------------------------------------------------------------------------- friends
@router.get("/friends")
def friends(me: A.Me = Depends(A.current)):
    with engine().connect() as c:
        ids = friend_ids(c, me.id)
        inc = [r[0] for r in c.execute(select(friend_requests.c.sender).where(friend_requests.c.receiver == me.id).order_by(friend_requests.c.created.desc())).all()]
        out = [r[0] for r in c.execute(select(friend_requests.c.receiver).where(friend_requests.c.sender == me.id)).all()]
        people = CM._people(c, ids + inc + out)
    return {"friends": sorted([people[i] for i in ids], key=lambda p: p["name"].lower()), "incoming": [people[i] for i in inc], "outgoing": [people[i] for i in out]}


@router.post("/friends/{handle}")
def add_friend(handle: str, request: Request, me: A.Me = Depends(A.current)):
    """Asks to be friends; if they already asked you, you are friends now."""
    _need_handle(me)
    A.rate(request, f"friend:{me.id}", 40, 3600)
    with engine().begin() as c:
        u = _other(c, handle, me)
        if _blocked_either(c, me.id, u["id"]):
            raise HTTPException(403, "You can't add this person.")
        if are_friends(c, me.id, u["id"]):
            return {"state": "friends"}
        if c.execute(select(friend_requests.c.sender).where(friend_requests.c.sender == u["id"], friend_requests.c.receiver == me.id)).first():
            c.execute(delete(friend_requests).where(friend_requests.c.sender == u["id"], friend_requests.c.receiver == me.id))
            a, b = _pair(me.id, u["id"])
            c.execute(insert(friendships).values(a=a, b=b, created=_now()))
            A.notify(c, u["id"], "friend_accepted", actor=me.id)
            return {"state": "friends"}
        if not c.execute(select(friend_requests.c.sender).where(friend_requests.c.sender == me.id, friend_requests.c.receiver == u["id"])).first():
            if c.execute(select(func.count()).select_from(friend_requests).where(friend_requests.c.sender == me.id)).scalar() >= 100:
                raise HTTPException(409, "You have a lot of requests waiting. Wait for some answers first.")
            c.execute(insert(friend_requests).values(sender=me.id, receiver=u["id"], created=_now()))
            A.notify(c, u["id"], "friend_request", actor=me.id)
    return {"state": "requested"}


@router.delete("/friends/{handle}")
def remove_friend(handle: str, me: A.Me = Depends(A.current)):
    """Unfriends, cancels your request, or declines theirs."""
    with engine().begin() as c:
        u = _other(c, handle, me)
        a, b = _pair(me.id, u["id"])
        c.execute(delete(friendships).where(friendships.c.a == a, friendships.c.b == b))
        c.execute(delete(friend_requests).where(or_(and_(friend_requests.c.sender == me.id, friend_requests.c.receiver == u["id"]),
                                                    and_(friend_requests.c.sender == u["id"], friend_requests.c.receiver == me.id))))
    return {"state": "none"}


def friend_state(c, me_id: str | None, other: str) -> str:
    """none | requested (you asked) | incoming (they asked) | friends."""
    if not me_id or me_id == other:
        return "none"
    if are_friends(c, me_id, other):
        return "friends"
    if c.execute(select(friend_requests.c.sender).where(friend_requests.c.sender == me_id, friend_requests.c.receiver == other)).first():
        return "requested"
    if c.execute(select(friend_requests.c.sender).where(friend_requests.c.sender == other, friend_requests.c.receiver == me_id)).first():
        return "incoming"
    return "none"


@router.get("/friends/state/{handle}")
def state_of(handle: str, me: A.Me = Depends(A.current)):
    with engine().connect() as c:
        u, _ = CM._user_by_handle(c, handle)
        return {"state": friend_state(c, me.id, u["id"])}


# -------------------------------------------------------------------------------------------- messages
class MessageIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)


@router.get("/dms")
def threads(me: A.Me = Depends(A.current)):
    """Your conversations, newest first, with the last message and how many you haven't read."""
    with engine().connect() as c:
        rows = c.execute(select(messages.c.pair, func.max(messages.c.created)).where(or_(messages.c.pair.like(f"{me.id}:%"), messages.c.pair.like(f"%:{me.id}")))
                         .group_by(messages.c.pair).order_by(func.max(messages.c.created).desc()).limit(100)).all()
        out = []
        others = {}
        for pair, _ in rows:
            a, b = pair.split(":")
            others[pair] = b if a == me.id else a
        people = CM._people(c, list(others.values()))
        for pair, _ in rows:
            last = c.execute(select(messages).where(messages.c.pair == pair).order_by(messages.c.created.desc()).limit(1)).mappings().first()
            unread = c.execute(select(func.count()).select_from(messages).where(messages.c.pair == pair, messages.c.sender != me.id, messages.c.read.is_(None))).scalar()
            out.append({"with": people[others[pair]], "last": {"text": last["text"][:140], "mine": last["sender"] == me.id, "at": _iso(last["created"])}, "unread": unread,
                        "friends": are_friends(c, me.id, others[pair])})
    return {"items": out, "unread": sum(x["unread"] for x in out)}


@router.get("/dms/{handle}")
def thread(handle: str, before: float | None = None, me: A.Me = Depends(A.current)):
    with engine().begin() as c:
        u = _other(c, handle, me)
        pair = ":".join(_pair(me.id, u["id"]))
        q = select(messages).where(messages.c.pair == pair)
        if before:
            q = q.where(messages.c.created < before)
        rows = list(reversed(c.execute(q.order_by(messages.c.created.desc()).limit(80)).mappings().all()))
        c.execute(update(messages).where(messages.c.pair == pair, messages.c.sender != me.id, messages.c.read.is_(None)).values(read=_now()))
        people = CM._people(c, [u["id"]])
        can = are_friends(c, me.id, u["id"]) and not _blocked_either(c, me.id, u["id"])
    return {"with": people[u["id"]], "can_send": can, "items": [{"id": r["id"], "text": r["text"], "mine": r["sender"] == me.id, "at": _iso(r["created"]), "t": r["created"]} for r in rows]}


@router.post("/dms/{handle}")
def send(handle: str, body: MessageIn, request: Request, me: A.Me = Depends(A.current)):
    _need_handle(me)
    A.rate(request, f"dm:{me.id}", 30, 60, "Slow down a little.")
    with engine().begin() as c:
        u = _other(c, handle, me)
        if not are_friends(c, me.id, u["id"]) or _blocked_either(c, me.id, u["id"]):
            raise HTTPException(403, "You can message friends only.")
        mid = str(uuid.uuid4())
        now = _now()
        c.execute(insert(messages).values(id=mid, pair=":".join(_pair(me.id, u["id"])), sender=me.id, text=body.text.strip(), created=now))
        # one notification per conversation until it is read (no flood)
        if not c.execute(select(A.notifications.c.id).where(A.notifications.c.user_id == u["id"], A.notifications.c.kind == "dm",
                                                            A.notifications.c.actor_id == me.id, A.notifications.c.read.is_(False))).first():
            A.notify(c, u["id"], "dm", actor=me.id)
    return {"id": mid, "at": _iso(now)}


# -------------------------------------------------------------------------------------------- challenges
class DuelIn(BaseModel):
    handle: str | None = None
    class_id: str | None = None
    piece_title: str = Field(..., min_length=1, max_length=160)
    catalog_id: str = Field("", max_length=80, pattern=r"^[A-Za-z0-9_.-]*$")
    score: float = Field(..., ge=0, le=1)
    tempo_pct: int = Field(100, ge=25, le=300)


class EntryIn(BaseModel):
    score: float = Field(..., ge=0, le=1)
    tempo_pct: int = Field(100, ge=25, le=300)


def _duel_json(c, d: dict, me_id: str) -> dict:
    ents = [dict(e) for e in c.execute(select(duel_entries).where(duel_entries.c.duel_id == d["id"]).order_by(duel_entries.c.score.desc(), duel_entries.c.created)).mappings().all()]
    people = CM._people(c, [d["sender"], d["receiver"]] + [e["user_id"] for e in ents])
    board = [{"who": people[d["sender"]], "score": round(d["score"] * 100), "tempo_pct": d["tempo_pct"], "starter": True}] + \
            [{"who": people[e["user_id"]], "score": round(e["score"] * 100), "tempo_pct": e["tempo_pct"]} for e in ents]
    board.sort(key=lambda x: (-x["score"], -x["tempo_pct"]))
    mine = next((e for e in ents if e["user_id"] == me_id), None)
    cname = c.execute(select(classes.c.name).where(classes.c.id == d["class_id"])).scalar() if d["class_id"] else None
    over = _now() > d["ends"] or (d["receiver"] and mine is not None) or (d["receiver"] and ents)
    return {"id": d["id"], "piece_title": d["piece_title"], "catalog_id": d["catalog_id"], "from": people[d["sender"]], "to": people.get(d["receiver"]) if d["receiver"] else None,
            "class": {"id": d["class_id"], "name": cname} if d["class_id"] else None, "score": round(d["score"] * 100), "tempo_pct": d["tempo_pct"],
            "ends": _iso(d["ends"]), "over": bool(over), "mine": round(mine["score"] * 100) if mine else None, "sent_by_me": d["sender"] == me_id,
            "board": board[:20], "winner": board[0]["who"] if over and board else None}


@router.post("/duels")
def new_duel(body: DuelIn, request: Request, me: A.Me = Depends(A.current)):
    """Beat my score: to a friend (handle) or, for a teacher, to a whole class (class_id) for a week."""
    _need_handle(me)
    A.rate(request, f"duel:{me.id}", 30, 3600)
    if bool(body.handle) == bool(body.class_id):
        raise HTTPException(400, "Choose a friend or a class.")
    now = _now()
    did = uuid.uuid4().hex[:12]
    with engine().begin() as c:
        if body.handle:
            u = _other(c, body.handle, me)
            if not are_friends(c, me.id, u["id"]):
                raise HTTPException(403, "You can challenge friends only.")
            c.execute(insert(duels).values(id=did, sender=me.id, receiver=u["id"], class_id=None, piece_title=body.piece_title.strip(), catalog_id=body.catalog_id,
                                           score=body.score, tempo_pct=body.tempo_pct, ends=now + DUEL_DAYS * 86400, created=now))
            A.notify(c, u["id"], "duel", actor=me.id, duel=did, title=body.piece_title.strip(), score=round(body.score * 100))
        else:
            role = c.execute(select(members.c.role).where(members.c.class_id == body.class_id, members.c.user_id == me.id)).scalar()
            if role != "teacher":
                raise HTTPException(403, "Only the class's teacher can open a class challenge.")
            c.execute(insert(duels).values(id=did, sender=me.id, receiver=None, class_id=body.class_id, piece_title=body.piece_title.strip(), catalog_id=body.catalog_id,
                                           score=body.score, tempo_pct=body.tempo_pct, ends=now + CLASS_DAYS * 86400, created=now))
            name = c.execute(select(classes.c.name).where(classes.c.id == body.class_id)).scalar() or ""
            for uid in c.execute(select(members.c.user_id).where(members.c.class_id == body.class_id, members.c.role == "student")).scalars().all():
                A.notify(c, uid, "class_challenge", actor=me.id, duel=did, title=body.piece_title.strip(), class_id=body.class_id, class_name=name)
        return _duel_json(c, dict(c.execute(select(duels).where(duels.c.id == did)).mappings().first()), me.id)


def _can_see(c, d: dict, uid: str) -> bool:
    if uid in (d["sender"], d["receiver"]):
        return True
    return bool(d["class_id"] and c.execute(select(members.c.user_id).where(members.c.class_id == d["class_id"], members.c.user_id == uid)).first())


@router.get("/duels")
def my_duels(me: A.Me = Depends(A.current)):
    with engine().connect() as c:
        cids = [r[0] for r in c.execute(select(members.c.class_id).where(members.c.user_id == me.id)).all()]
        rows = c.execute(select(duels).where(or_(duels.c.sender == me.id, duels.c.receiver == me.id, duels.c.class_id.in_(cids or ["-"])))
                         .order_by(duels.c.created.desc()).limit(50)).mappings().all()
        items = [_duel_json(c, dict(d), me.id) for d in rows]
    return {"open": [x for x in items if not x["over"]], "done": [x for x in items if x["over"]][:20]}


@router.get("/duels/{did}")
def one_duel(did: str, me: A.Me = Depends(A.current)):
    with engine().connect() as c:
        d = c.execute(select(duels).where(duels.c.id == did)).mappings().first()
        if d is None or not _can_see(c, dict(d), me.id):
            raise HTTPException(404, "Challenge not found.")
        return _duel_json(c, dict(d), me.id)


@router.post("/duels/{did}/entry")
def enter_duel(did: str, body: EntryIn, me: A.Me = Depends(A.current)):
    """Your score for a challenge (a friend's once; a class's as often as you like, the best counts)."""
    now = _now()
    with engine().begin() as c:
        d = c.execute(select(duels).where(duels.c.id == did)).mappings().first()
        if d is None or not _can_see(c, dict(d), me.id) or d["sender"] == me.id:
            raise HTTPException(404, "Challenge not found.")
        if now > d["ends"]:
            raise HTTPException(409, "This challenge has ended.")
        have = c.execute(select(duel_entries).where(duel_entries.c.duel_id == did, duel_entries.c.user_id == me.id)).mappings().first()
        if have and d["receiver"]:
            raise HTTPException(409, "You already answered this challenge.")
        if have:
            if body.score > have["score"]:
                c.execute(update(duel_entries).where(duel_entries.c.duel_id == did, duel_entries.c.user_id == me.id).values(score=body.score, tempo_pct=body.tempo_pct, created=now))
        else:
            c.execute(insert(duel_entries).values(duel_id=did, user_id=me.id, score=body.score, tempo_pct=body.tempo_pct, created=now))
        if d["receiver"]:
            won = body.score > d["score"] or (body.score == d["score"] and body.tempo_pct > d["tempo_pct"])
            A.notify(c, d["sender"], "duel_answered", actor=me.id, duel=did, title=d["piece_title"], won=won, score=round(body.score * 100))
        return _duel_json(c, dict(d), me.id)


# -------------------------------------------------------------------------------------------- moments on a Sound
class MomentIn(BaseModel):
    at: float = Field(..., ge=0, le=6 * 3600)
    text: str = Field(..., min_length=1, max_length=280)


@router.get("/sounds/{sid}/moments")
def sound_moments(sid: str, me: A.Me | None = Depends(A.optional)):
    with engine().connect() as c:
        if not c.execute(select(SD.sounds.c.id).where(SD.sounds.c.id == sid, SD.sounds.c.hidden.is_(False))).first():
            raise HTTPException(404, "Sound not found.")
        hidden = CM._blocked_by(c, me) if me else set()
        rows = [dict(r) for r in c.execute(select(moments).where(moments.c.sound_id == sid).order_by(moments.c.at)).mappings().all() if r["user_id"] not in hidden]
        people = CM._people(c, [r["user_id"] for r in rows])
    return {"items": [{"id": r["id"], "at": round(r["at"], 1), "text": r["text"], "who": people[r["user_id"]], "mine": bool(me and r["user_id"] == me.id)} for r in rows]}


@router.post("/sounds/{sid}/moments")
def add_moment(sid: str, body: MomentIn, request: Request, me: A.Me = Depends(A.current)):
    _need_handle(me)
    A.rate(request, f"moment:{me.id}", 20, 60, "Slow down a little.")
    with engine().begin() as c:
        s = c.execute(select(SD.sounds.c.id, SD.sounds.c.user_id, SD.sounds.c.seconds).where(SD.sounds.c.id == sid, SD.sounds.c.hidden.is_(False))).mappings().first()
        if s is None:
            raise HTTPException(404, "Sound not found.")
        if _blocked_either(c, me.id, s["user_id"]):
            raise HTTPException(403, "You can't comment here.")
        mid = str(uuid.uuid4())
        c.execute(insert(moments).values(id=mid, sound_id=sid, user_id=me.id, at=min(body.at, s["seconds"] or body.at), text=body.text.strip(), created=_now()))
        A.notify(c, s["user_id"], "moment", actor=me.id, sound=sid, at=round(body.at, 1))
    return {"id": mid}


@router.delete("/moments/{mid}")
def del_moment(mid: str, me: A.Me = Depends(A.current)):
    with engine().begin() as c:
        m = c.execute(select(moments).where(moments.c.id == mid)).mappings().first()
        if m is None:
            raise HTTPException(404, "Not found.")
        owner = c.execute(select(SD.sounds.c.user_id).where(SD.sounds.c.id == m["sound_id"])).scalar()
        if me.id not in (m["user_id"], owner) and not me.is_admin:
            raise HTTPException(403, "Not yours.")
        c.execute(delete(moments).where(moments.c.id == mid))
    return {"ok": True}


# -------------------------------------------------------------------------------------------- reposts and the Friends feed
class RepostIn(BaseModel):
    target: str = Field(..., pattern=r"^(p|s):[A-Za-z0-9_-]{4,40}$")


@router.post("/reposts")
def repost(body: RepostIn, me: A.Me = Depends(A.current)):
    _need_handle(me)
    kind, tid = body.target.split(":", 1)
    with engine().begin() as c:
        if kind == "p":
            owner = c.execute(select(CM.posts.c.user_id).where(CM.posts.c.id == tid, CM.posts.c.hidden.is_(False), CM.posts.c.visibility == "public")).scalar()
        else:
            owner = c.execute(select(SD.sounds.c.user_id).where(SD.sounds.c.id == tid, SD.sounds.c.hidden.is_(False))).scalar()
        if owner is None:
            raise HTTPException(404, "Not found.")
        if not c.execute(select(reposts.c.user_id).where(reposts.c.user_id == me.id, reposts.c.target == body.target)).first():
            c.execute(insert(reposts).values(user_id=me.id, target=body.target, created=_now()))
            A.notify(c, owner, "repost", actor=me.id, **({"post": tid} if kind == "p" else {"sound": tid}))
        n = c.execute(select(func.count()).select_from(reposts).where(reposts.c.target == body.target)).scalar()
    return {"reposted": True, "count": n}


@router.delete("/reposts/{target}")
def unrepost(target: str, me: A.Me = Depends(A.current)):
    with engine().begin() as c:
        c.execute(delete(reposts).where(reposts.c.user_id == me.id, reposts.c.target == target))
        n = c.execute(select(func.count()).select_from(reposts).where(reposts.c.target == target)).scalar()
    return {"reposted": False, "count": n}


@router.get("/feed/friends")
def friends_feed(me: A.Me = Depends(A.current)):
    """What your friends and the people you follow posted, made and reposted, newest first."""
    with engine().connect() as c:
        ids = set(friend_ids(c, me.id)) | {r[0] for r in c.execute(select(CM.follows.c.followee).where(CM.follows.c.follower == me.id)).all()}
        ids -= CM._blocked_by(c, me)
        ids = list(ids) or ["-"]
        P = CM.posts
        prow = c.execute(select(P).where(P.c.user_id.in_(ids), P.c.hidden.is_(False), P.c.visibility == "public").order_by(P.c.created.desc()).limit(30)).mappings().all()
        srow = c.execute(select(SD.sounds.c.id, SD.sounds.c.title, SD.sounds.c.user_id, SD.sounds.c.seconds, SD.sounds.c.created)
                         .where(SD.sounds.c.user_id.in_(ids), SD.sounds.c.hidden.is_(False)).order_by(SD.sounds.c.created.desc()).limit(30)).mappings().all()
        rrow = c.execute(select(reposts).where(reposts.c.user_id.in_(ids)).order_by(reposts.c.created.desc()).limit(30)).mappings().all()
        rp_posts = {r["target"][2:] for r in rrow if r["target"].startswith("p:")}
        rp_sounds = {r["target"][2:] for r in rrow if r["target"].startswith("s:")}
        extra_p = {r["id"]: dict(r) for r in c.execute(select(P).where(P.c.id.in_(list(rp_posts) or ["-"]), P.c.hidden.is_(False))).mappings().all()}
        extra_s = {r["id"]: dict(r) for r in c.execute(select(SD.sounds.c.id, SD.sounds.c.title, SD.sounds.c.user_id, SD.sounds.c.seconds, SD.sounds.c.created)
                                                      .where(SD.sounds.c.id.in_(list(rp_sounds) or ["-"]), SD.sounds.c.hidden.is_(False))).mappings().all()}
        everyone = [r["user_id"] for r in prow] + [r["user_id"] for r in srow] + [r["user_id"] for r in rrow] + \
                   [r["user_id"] for r in extra_p.values()] + [r["user_id"] for r in extra_s.values()] + [r["claimed_by"] for r in list(prow) + list(extra_p.values())]
        people = CM._people(c, everyone)
        mine_r = CM._my_reactions(c, me, [f"p:{r['id']}" for r in list(prow) + list(extra_p.values())])
        rp_counts = {r[0]: r[1] for r in c.execute(select(reposts.c.target, func.count()).group_by(reposts.c.target)).all()}
        my_rp = {r[0] for r in c.execute(select(reposts.c.target).where(reposts.c.user_id == me.id)).all()}
    def snd(s):
        return {"id": s["id"], "title": s["title"], "by": people[s["user_id"]], "seconds": round(s["seconds"] or 0, 1)}
    items = [{"kind": "post", "at": r["created"], "post": CM._post_json(dict(r), people, mine_r, me), "reposts": rp_counts.get(f"p:{r['id']}", 0), "reposted": f"p:{r['id']}" in my_rp} for r in prow]
    items += [{"kind": "sound", "at": s["created"], "sound": snd(s), "reposts": rp_counts.get(f"s:{s['id']}", 0), "reposted": f"s:{s['id']}" in my_rp} for s in srow]
    for r in rrow:
        tid = r["target"][2:]
        if r["target"].startswith("p:") and tid in extra_p:
            items.append({"kind": "post", "at": r["created"], "by": people[r["user_id"]], "post": CM._post_json(extra_p[tid], people, mine_r, me),
                          "reposts": rp_counts.get(r["target"], 0), "reposted": r["target"] in my_rp})
        elif r["target"].startswith("s:") and tid in extra_s:
            items.append({"kind": "sound", "at": r["created"], "by": people[r["user_id"]], "sound": snd(extra_s[tid]),
                          "reposts": rp_counts.get(r["target"], 0), "reposted": r["target"] in my_rp})
    items.sort(key=lambda x: -x["at"])
    for x in items:
        x["at"] = _iso(x["at"])
    return {"items": items[:50]}


# -------------------------------------------------------------------------------------------- your data
def forget(c, uid: str) -> None:
    """Deleting an account removes its friendships, requests, messages (both sides of each conversation it was
    in), challenges, moments and reposts."""
    c.execute(delete(friendships).where(or_(friendships.c.a == uid, friendships.c.b == uid)))
    c.execute(delete(friend_requests).where(or_(friend_requests.c.sender == uid, friend_requests.c.receiver == uid)))
    c.execute(delete(messages).where(or_(messages.c.pair.like(f"{uid}:%"), messages.c.pair.like(f"%:{uid}"))))
    mine = [r[0] for r in c.execute(select(duels.c.id).where(or_(duels.c.sender == uid, duels.c.receiver == uid))).all()]
    c.execute(delete(duel_entries).where(or_(duel_entries.c.user_id == uid, duel_entries.c.duel_id.in_(mine or ["-"]))))
    c.execute(delete(duels).where(duels.c.id.in_(mine or ["-"])))
    c.execute(delete(moments).where(moments.c.user_id == uid))
    c.execute(delete(reposts).where(reposts.c.user_id == uid))


def export(c, uid: str) -> dict:
    rows = lambda q: [dict(r) for r in c.execute(q).mappings().all()]  # noqa: E731
    return {"friends": friend_ids(c, uid),
            "friend_requests": rows(select(friend_requests).where(or_(friend_requests.c.sender == uid, friend_requests.c.receiver == uid))),
            "messages": rows(select(messages.c.id, messages.c.sender, messages.c.text, messages.c.created).where(
                or_(messages.c.pair.like(f"{uid}:%"), messages.c.pair.like(f"%:{uid}")))),
            "challenges": rows(select(duels).where(or_(duels.c.sender == uid, duels.c.receiver == uid))),
            "challenge_scores": rows(select(duel_entries).where(duel_entries.c.user_id == uid)),
            "sound_moments": rows(select(moments).where(moments.c.user_id == uid)),
            "reposts": rows(select(reposts).where(reposts.c.user_id == uid))}
