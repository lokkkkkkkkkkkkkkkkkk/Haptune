"""The Haptune community: the reason to use Haptune instead of a plain score app.

    Requests   "I need this song for violin, beginner" + a YouTube link or photos of a page. Others want it too
               (+1, and they can add credits to the reward). A helper claims it for 48 hours, makes the score
               (in Haptune or any notation app) and submits MusicXML. The requester plays it in the app, then
               accepts it with a star rating or asks for changes. The reward is bigger when the help is fast,
               good and large (see REWARDS), with caps so nobody can farm credits. Other useful submissions and
               comments get a share too.
    Questions  Ask the community instead of the paid AI tutor; the accepted answer earns credits.
    Library    Scores people share. Public domain and your own work are listed for everyone; anything else is
               shared by link only (unlisted), as copyrighted songs should stay private.
    Show       "I played Ode to Joy at 96%!": practice wins with claps.
    Challenge  One public-domain song a week; best Play Along accuracy wins; credits for taking part and the top 3.
    Plus profiles, follows, blocks, a feed, leaderboards (helpers, practice, challenge), reports with
    automatic hiding after three reports, and an admin panel for the developer (moderation, feedback, plans).

Songs from YouTube are only linked (never downloaded), and scores of copyrighted songs made for a request
are delivered privately to the requester and the people who wanted it, never listed publicly.
"""
from __future__ import annotations

import base64
import gzip
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import (JSON, Boolean, Column, Float, ForeignKey, Integer, LargeBinary, String, Table, Text, and_, case, cast,
                        delete, func, insert, or_, select, update)

import accounts as A
from academy import _iso, _now, classes as classes_t, engine, meta, users

router = APIRouter(prefix="/c", tags=["community"])

posts = Table("posts", meta,
              Column("id", String(16), primary_key=True),
              Column("user_id", String(36), ForeignKey("users.id"), nullable=False, index=True),
              Column("type", String(10), nullable=False),                  # request | question | share | show
              Column("title", String(140), nullable=False),
              Column("body", Text, nullable=False, default=""),
              Column("song", String(140), nullable=False, default=""),
              Column("artist", String(100), nullable=False, default=""),
              Column("instruments", JSON, nullable=True),
              Column("level", String(16), nullable=False, default=""),
              Column("link", String(400), nullable=False, default=""),
              Column("licence", String(12), nullable=False, default=""),   # pd | own | arr | copyrighted | unknown
              Column("visibility", String(10), nullable=False, default="public"),
              Column("file_id", String(16), nullable=True),
              Column("attachments", JSON, nullable=True),
              Column("data", JSON, nullable=True),
              Column("status", String(10), nullable=False, default="open"),  # open | done | closed
              Column("pot", Integer, nullable=False, default=0),
              Column("wants", Integer, nullable=False, default=0),
              Column("likes", Integer, nullable=False, default=0),
              Column("replies", Integer, nullable=False, default=0),
              Column("saves", Integer, nullable=False, default=0),
              Column("accepted_reply", String(16), nullable=True),
              Column("claimed_by", String(36), nullable=True),
              Column("claim_until", Float, nullable=True),
              Column("spotlight_until", Float, nullable=True),
              Column("lang", String(10), nullable=False, default=""),
              Column("hidden", Boolean, nullable=False, default=False),
              Column("hide_reason", String(40), nullable=False, default=""),
              Column("created", Float, nullable=False, index=True),
              Column("bumped", Float, nullable=False, index=True))
replies = Table("replies", meta,
                Column("id", String(16), primary_key=True),
                Column("post_id", String(16), ForeignKey("posts.id"), nullable=False, index=True),
                Column("user_id", String(36), nullable=False, index=True),
                Column("kind", String(12), nullable=False),                 # comment | answer | submission
                Column("body", Text, nullable=False, default=""),
                Column("file_id", String(16), nullable=True),
                Column("bars", Integer, nullable=False, default=0),
                Column("notes", Integer, nullable=False, default=0),
                Column("status", String(10), nullable=False, default=""),   # "" | accepted | changes | helpful
                Column("note", Text, nullable=False, default=""),
                Column("rating", Integer, nullable=True),
                Column("reward", Integer, nullable=False, default=0),
                Column("likes", Integer, nullable=False, default=0),
                Column("hidden", Boolean, nullable=False, default=False),
                Column("created", Float, nullable=False),
                Column("updated", Float, nullable=False))
files = Table("files", meta,
              Column("id", String(16), primary_key=True),
              Column("user_id", String(36), nullable=False),
              Column("kind", String(10), nullable=False),                   # musicxml | image | pdf
              Column("name", String(120), nullable=False, default=""),
              Column("mime", String(60), nullable=False, default=""),
              Column("size", Integer, nullable=False, default=0),
              Column("data", LargeBinary, nullable=True),                    # gzip for MusicXML; dropped when expired
              Column("post_id", String(16), nullable=True, index=True),
              Column("created", Float, nullable=False))
reactions = Table("reactions", meta,
                  Column("user_id", String(36), primary_key=True),
                  Column("target", String(20), primary_key=True),          # p:<post id> | r:<reply id>
                  Column("kind", String(8), primary_key=True),             # like | want | save
                  Column("created", Float, nullable=False))
pot_adds = Table("pot_adds", meta,
                 Column("id", Integer, primary_key=True, autoincrement=True),
                 Column("post_id", String(16), nullable=False, index=True),
                 Column("user_id", String(36), nullable=False),
                 Column("amount", Integer, nullable=False),
                 Column("refunded", Boolean, nullable=False, default=False),
                 Column("created", Float, nullable=False))
follows = Table("follows", meta,
                Column("follower", String(36), primary_key=True),
                Column("followee", String(36), primary_key=True, index=True),
                Column("created", Float, nullable=False))
blocks = Table("blocks", meta,
               Column("blocker", String(36), primary_key=True),
               Column("blocked", String(36), primary_key=True),
               Column("created", Float, nullable=False))
reports = Table("reports", meta,
                Column("id", String(16), primary_key=True),
                Column("reporter", String(36), nullable=False),
                Column("target", String(20), nullable=False, index=True),
                Column("target_user", String(36), nullable=True),
                Column("reason", String(16), nullable=False),
                Column("note", String(500), nullable=False, default=""),
                Column("status", String(10), nullable=False, default="open"),
                Column("created", Float, nullable=False),
                Column("handled", Float, nullable=True))
challenge_entries = Table("challenge_entries", meta,
                          Column("week", String(8), primary_key=True),
                          Column("user_id", String(36), primary_key=True),
                          Column("song", String(20), nullable=False),
                          Column("accuracy", Float, nullable=False),
                          Column("tempo_pct", Integer, nullable=False, default=100),
                          Column("seconds", Integer, nullable=False, default=0),
                          Column("created", Float, nullable=False))

# --------------------------------------------------------------------------------------- the reward rules
REWARDS = {
    # A request's reward = what the requester and supporters put in (all of it) + Haptune's bonus:
    #   bonus = size x speed x quality, at most bonus_cap, and at most daily_help_cap a day for each helper.
    "size_min": 10, "size_max": 60, "size_notes_per_credit": 20,          # bigger scores earn more
    "speed": [[24, 1.5], [72, 1.25], [168, 1.0]], "speed_late": 0.8,      # hours after the request
    "quality": {"5": 1.5, "4": 1.2, "3": 1.0, "2": 0.7, "1": 0.5},       # the requester's stars
    "bonus_cap": 300, "daily_help_cap": 600,
    "runner_up_share": 0.3, "runner_up_cap": 40,                          # other submissions marked helpful
    "helpful_comment": 5, "helpful_per_post": 3,
    "answer": 10, "answer_speed": [[1, 2.0], [24, 1.5]],
    "share": 10, "shares_per_day": 3, "share_saved": 2, "share_saved_cap": 50,
    "challenge_entry": 10, "challenge_top": [50, 30, 20],
    "spotlight_cost": 30, "spotlight_hours": 24,
    "claim_hours": 48, "max_claims": 3, "request_days": 30, "max_pot": 2000,
}
CHALLENGES = [  # public-domain songs from the app's songbook, one a week
    ("odetojoy", "Ode to Joy"), ("twinkle", "Twinkle, Twinkle, Little Star"), ("canon", "Canon in D"),
    ("greensleeves", "Greensleeves"), ("tigers", "Two Tigers"), ("amazinggrace", "Amazing Grace"),
    ("furelise", "Für Elise"), ("auldlangsyne", "Auld Lang Syne"), ("mary", "Mary Had a Little Lamb"),
    ("silentnight", "Silent Night"), ("jingle", "Jingle Bells"), ("birthday", "Happy Birthday"),
]
LICENCES = {"pd", "own", "arr", "copyrighted", "unknown"}
PUBLIC_OK = {"pd", "own", "arr"}           # may be listed publicly (arr = an arrangement of a public-domain tune)
MAX_XML = 3 * 1024 * 1024
MAX_ATTACH = 2 * 1024 * 1024

# Words that are never friendly (English, Malay, Chinese). Latin words match whole words only.
_BAD_LATIN = ["fuck", "fucking", "shit", "bitch", "cunt", "nigger", "nigga", "faggot", "asshole", "whore", "slut", "retard",
              "pukimak", "puki", "lancau", "pantat", "keparat", "kimak", "butoh", "sundal"]
_BAD_CJK = ["操你", "傻逼", "傻屄", "他妈的", "贱人", "婊子", "屌你", "肏", "去死"]
_BAD_RE = re.compile(r"\b(" + "|".join(_BAD_LATIN) + r")\b", re.I)


def clean_text(s: str | None, limit: int) -> str:
    s = re.sub(r"[ \t]+", " ", (s or "").replace("\r", "")).strip()[:limit]
    if _BAD_RE.search(s) or any(w in s for w in _BAD_CJK):
        raise HTTPException(400, "Please keep Haptune friendly: that text has words we don't allow.")
    return s


def _limit_user(me: A.Me, key: str, n: int, window: float, msg: str) -> None:
    if me.is_admin:
        return
    if not A.limiter.allow(f"{key}:{me.id}", n, window):
        raise HTTPException(429, msg)


# --------------------------------------------------------------------------------------- helpers
def _week(t: float | None = None) -> str:
    d = datetime.fromtimestamp(t or _now(), tz=timezone.utc)
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def _week_start(t: float | None = None) -> float:
    d = datetime.fromtimestamp(t or _now(), tz=timezone.utc)
    start = (d - timedelta(days=d.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return start.timestamp()


def _period_start(period: str) -> float:
    if period == "week":
        return _week_start()
    if period == "month":
        d = datetime.now(timezone.utc)
        return d.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()
    return 0.0


def _challenge_for(week: str) -> tuple[str, str]:
    y, w = week.split("-W")
    return CHALLENGES[(int(y) * 53 + int(w)) % len(CHALLENGES)]


def _score_size(xml: str) -> tuple[int, int]:
    """Bars (in the first part) and notes in a MusicXML text."""
    first = xml.split("</part>", 1)[0]
    bars = len(re.findall(r"<measure\b", first))
    notes = len(re.findall(r"<note\b", xml)) - len(re.findall(r"<rest\b", xml))
    return bars, max(0, notes)


def _save_file(c, uid: str, kind: str, name: str, mime: str, raw: bytes, post_id: str | None = None) -> str:
    fid = A.new_id()
    data = gzip.compress(raw) if kind == "musicxml" else raw
    c.execute(insert(files).values(id=fid, user_id=uid, kind=kind, name=name[:120], mime=mime[:60], size=len(raw), data=data,
                                   post_id=post_id, created=_now()))
    return fid


def _check_xml(xml: str | None) -> str:
    if not xml or len(xml) > MAX_XML:
        raise HTTPException(400, "Attach the score as MusicXML (up to 3 MB).")
    head = xml[:2000]
    if "<score-partwise" not in head and "<score-timewise" not in head:
        raise HTTPException(400, "That isn't a MusicXML score.")
    return xml


def _people(c, ids) -> dict:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    out = {}
    rows = c.execute(select(users, A.accounts).join(A.accounts, A.accounts.c.user_id == users.c.id, isouter=True).where(users.c.id.in_(ids))).mappings().all()
    for r in rows:
        out[r["id"]] = A.public_user(dict(r), dict(r) if r["handle"] else None)
    for i in ids:
        out.setdefault(i, {"id": i, "handle": "", "name": "Deleted user", "avatar": {"color": "gray"}, "instruments": [], "level": "", "badge": None})
    return out


def _blocked_by(c, me: A.Me | None) -> set:
    if not me:
        return set()
    return {r[0] for r in c.execute(select(blocks.c.blocked).where(blocks.c.blocker == me.id)).all()}


def _my_reactions(c, me: A.Me | None, targets: list[str]) -> set:
    if not me or not targets:
        return set()
    return {(r[0], r[1]) for r in c.execute(select(reactions.c.target, reactions.c.kind).where(reactions.c.user_id == me.id, reactions.c.target.in_(targets))).all()}


def _post_json(p: dict, people: dict, mine: set, me: A.Me | None, full: bool = False) -> dict:
    now = _now()
    claimed = p["claimed_by"] if p["claimed_by"] and (p["claim_until"] or 0) > now and p["status"] == "open" else None
    body = p["body"] if full else (p["body"][:240] + ("…" if len(p["body"]) > 240 else ""))
    return {
        "id": p["id"], "type": p["type"], "title": p["title"], "body": body, "song": p["song"], "artist": p["artist"],
        "instruments": p["instruments"] or [], "level": p["level"], "link": p["link"], "licence": p["licence"], "visibility": p["visibility"],
        "status": p["status"], "pot": p["pot"], "wants": p["wants"], "likes": p["likes"], "replies": p["replies"], "saves": p["saves"],
        "author": people.get(p["user_id"]), "created": _iso(p["created"]), "bumped": _iso(p["bumped"]),
        "claimed": {"by": people.get(claimed), "until": _iso(p["claim_until"])} if claimed else None,
        "spotlight": bool(p["spotlight_until"] and p["spotlight_until"] > now), "has_file": bool(p["file_id"]),
        "file_id": p["file_id"] if p["visibility"] != "private" else None,
        "attachments": p["attachments"] or [], "data": p["data"] or {}, "hidden": p["hidden"],
        "me": {"wanted": (f"p:{p['id']}", "want") in mine, "liked": (f"p:{p['id']}", "like") in mine, "saved": (f"p:{p['id']}", "save") in mine,
               "is_author": bool(me and me.id == p["user_id"]), "claimed": bool(me and claimed == me.id)},
    }


def _visible_posts(c, me: A.Me | None):
    blocked = _blocked_by(c, me)
    cond = [posts.c.hidden.is_(False)]
    if blocked:
        cond.append(posts.c.user_id.not_in(blocked))
    return cond


def _housekeeping(c) -> None:
    """Runs at most once an hour: closes old unanswered requests (refunding the reward) and lets go of the
    pictures attached to finished requests after 60 days, so the server's disk never fills up."""
    last = c.execute(select(A.kv.c.v).where(A.kv.c.k == "housekeeping")).scalar()
    if last and float(last) > _now() - 3600:
        return
    c.execute(A.kv.delete().where(A.kv.c.k == "housekeeping"))
    c.execute(insert(A.kv).values(k="housekeeping", v=str(_now())))
    old = c.execute(select(posts).where(posts.c.type.in_(["request", "question"]), posts.c.status == "open",
                                        posts.c.created < _now() - REWARDS["request_days"] * 86400)).mappings().all()
    for p in old:
        _close(c, dict(p), "expired")
    done = [r[0] for r in c.execute(select(posts.c.id).where(posts.c.status.in_(["done", "closed"]), posts.c.bumped < _now() - 60 * 86400)).all()]
    if done:
        c.execute(update(files).where(files.c.post_id.in_(done), files.c.kind.in_(["image", "pdf"])).values(data=None))


def _close(c, p: dict, why: str) -> None:
    """Closes a request or question without an accepted answer and gives every credit back."""
    for add in c.execute(select(pot_adds).where(pot_adds.c.post_id == p["id"], pot_adds.c.refunded.is_(False))).mappings().all():
        A.grant(c, add["user_id"], add["amount"], "refund", minted=False, ref=p["id"], note=p["title"][:80])
    c.execute(update(pot_adds).where(pot_adds.c.post_id == p["id"]).values(refunded=True))
    c.execute(update(posts).where(posts.c.id == p["id"]).values(status="closed", pot=0, claimed_by=None, claim_until=None))
    if why == "expired":
        A.notify(c, p["user_id"], "expired", post=p["id"])


def forget_user(c, uid: str) -> None:
    """Account deletion: their posts and replies stay, shown as 'Deleted user'; everything personal goes."""
    for p in c.execute(select(posts).where(posts.c.user_id == uid, posts.c.status == "open")).mappings().all():
        _close(c, dict(p), "deleted")
    ghost = A.GHOST_ID
    if not c.execute(select(users.c.id).where(users.c.id == ghost)).first():
        c.execute(insert(users).values(id=ghost, token_hash="-", name="Deleted user", color="gray", created=_now()))
    c.execute(update(posts).where(posts.c.user_id == uid).values(user_id=ghost))
    c.execute(update(replies).where(replies.c.user_id == uid).values(user_id=ghost))
    for t, col in ((reactions, reactions.c.user_id), (follows, follows.c.follower), (follows, follows.c.followee),
                   (blocks, blocks.c.blocker), (blocks, blocks.c.blocked), (challenge_entries, challenge_entries.c.user_id)):
        c.execute(delete(t).where(col == uid))


def _load_post(c, pid: str) -> dict:
    p = c.execute(select(posts).where(posts.c.id == pid)).mappings().first()
    if not p:
        raise HTTPException(404, "That post isn't there any more.")
    return dict(p)


def _bump(c, pid: str, **extra) -> None:
    c.execute(update(posts).where(posts.c.id == pid).values(bumped=_now(), **extra))


# --------------------------------------------------------------------------------------- posts
class Attachment(BaseModel):
    name: str = Field("", max_length=120)
    mime: str = Field(..., max_length=60)
    data: str = Field(..., max_length=int(MAX_ATTACH * 1.4))     # base64


class PostIn(BaseModel):
    type: Literal["request", "question", "share", "show"]
    title: str = Field(..., min_length=2, max_length=120)
    body: str = Field("", max_length=4000)
    song: str = Field("", max_length=140)
    artist: str = Field("", max_length=100)
    instruments: list[str] = Field(default_factory=list, max_length=6)
    level: str = Field("", max_length=16)
    link: str = Field("", max_length=400)
    licence: str = Field("", max_length=12)
    visibility: str = Field("public", max_length=10)
    xml: str | None = None
    attachments: list[Attachment] = Field(default_factory=list, max_length=3)
    pot: int = Field(0, ge=0, le=REWARDS["max_pot"])
    data: dict | None = None
    lang: str = Field("", max_length=10)


@router.post("/posts")
def create_post(body: PostIn, me: A.Me = Depends(A.current)):
    _limit_user(me, "post", 10, 3600, "That's a lot of posts for one hour. Please take a short break.")
    title = clean_text(body.title, 120)
    text = clean_text(body.body, 4000)
    link = body.link.strip()
    if link and not re.match(r"^https?://\S+$", link):
        raise HTTPException(400, "The link should start with http:// or https://")
    licence = body.licence if body.licence in LICENCES else ("unknown" if body.type in ("request", "share") else "")
    visibility = body.visibility if body.visibility in ("public", "unlisted") else "public"
    if body.type == "share" and licence not in PUBLIC_OK:
        visibility = "unlisted"           # copyrighted or unknown: shared by link only, never listed
    pid, now = A.new_id(), _now()
    with engine().begin() as c:
        _housekeeping(c)
        if body.type == "request":
            limit = A.plan_limits(me.tier).get("open_requests")
            n_open = c.execute(select(func.count()).select_from(posts).where(posts.c.user_id == me.id, posts.c.type == "request",
                                                                              posts.c.status == "open", posts.c.hidden.is_(False))).scalar()
            if limit is not None and n_open >= limit:
                raise HTTPException(402, {"code": "open_requests", "limit": limit, "tier": me.tier,
                                          "message": f"You have {n_open} open requests. Close one, or get more with Plus."})
        file_id = None
        data = dict(body.data or {})
        if body.type == "share":
            xml = _check_xml(body.xml)
            bars, notes = _score_size(xml)
            data.update(bars=bars, notes=notes)
            file_id = _save_file(c, me.id, "musicxml", f"{title}.musicxml", "application/vnd.recordare.musicxml+xml", xml.encode(), pid)
        if body.type == "show":
            data = {k: data[k] for k in ("accuracy", "minutes", "piece", "mode", "tempo_pct", "instrument") if k in data}
        atts = []
        for a in body.attachments if body.type in ("request", "question") else []:
            try:
                raw = base64.b64decode(a.data, validate=True)
            except ValueError:
                raise HTTPException(400, "An attachment couldn't be read.")
            kind = "pdf" if a.mime == "application/pdf" else "image" if a.mime in ("image/jpeg", "image/png", "image/webp") else None
            if not kind or len(raw) > MAX_ATTACH:
                raise HTTPException(400, "Attach photos (JPEG/PNG) or a PDF of up to 2 MB each.")
            fid = _save_file(c, me.id, kind, a.name or kind, a.mime, raw, pid)
            atts.append({"id": fid, "name": a.name[:120], "mime": a.mime, "size": len(raw)})
        c.execute(insert(posts).values(
            id=pid, user_id=me.id, type=body.type, title=title, body=text, song=clean_text(body.song, 140), artist=clean_text(body.artist, 100),
            instruments=[i[:24] for i in body.instruments[:6]], level=body.level if body.level in ("", "beginner", "intermediate", "advanced") else "",
            link=link, licence=licence, visibility=visibility, file_id=file_id, attachments=atts or None, data=data or None,
            status="open" if body.type in ("request", "question") else "done", lang=body.lang[:10], created=now, bumped=now))
        if body.pot and body.type in ("request", "question"):
            A.grant(c, me.id, -body.pot, "pot", minted=False, ref=pid, note=title[:80])
            c.execute(insert(pot_adds).values(post_id=pid, user_id=me.id, amount=body.pot, created=now))
            c.execute(update(posts).where(posts.c.id == pid).values(pot=body.pot))
        if body.type == "share" and licence in PUBLIC_OK:
            shared_today = c.execute(select(func.count()).select_from(A.ledger).where(
                A.ledger.c.user_id == me.id, A.ledger.c.reason == "share", A.ledger.c.created > now - 86400)).scalar()
            if shared_today < REWARDS["shares_per_day"]:
                A.grant(c, me.id, REWARDS["share"], "share", ref=pid, note=title[:80])
        # followers hear about new requests and shares
        if body.type in ("request", "share", "show"):
            for (fid_,) in c.execute(select(follows.c.follower).where(follows.c.followee == me.id).limit(500)).all():
                A.notify(c, fid_, "new_post", actor=me.id, post=pid, type=body.type)
    return get_post(pid, me)


@router.get("/posts")
def list_posts(me: A.Me | None = Depends(A.optional), type: str = "", status: str = "", instrument: str = "", q: str = "",
               sort: str = "new", author: str = "", following: bool = False, saved: bool = False, mine: bool = False,
               limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0, le=5000)):
    with engine().begin() as c:
        _housekeeping(c)
    with engine().connect() as c:
        cond = _visible_posts(c, me)
        if type:
            cond.append(posts.c.type.in_(type.split(",")))
        if status and status != "all":
            cond.append(posts.c.status.in_(status.split(",")))
        if instrument:
            cond.append(cast(posts.c.instruments, String).like(f'%"{instrument[:24]}"%'))
        if q.strip():
            like = f"%{q.strip()[:60]}%"
            cond.append(or_(posts.c.title.ilike(like), posts.c.song.ilike(like), posts.c.artist.ilike(like), posts.c.body.ilike(like)))
        if author:
            uid = c.execute(select(A.accounts.c.user_id).where(A.accounts.c.handle == author.lower().lstrip("@"))).scalar()
            cond.append(posts.c.user_id == (uid or "-"))
            if me and uid == me.id:
                mine = True
        if mine and me:
            cond.append(posts.c.user_id == me.id)          # your own posts, unlisted ones too
        else:
            cond.append(posts.c.visibility == "public")
        if following and me:
            cond.append(posts.c.user_id.in_(select(follows.c.followee).where(follows.c.follower == me.id)))
        if saved and me:
            cond.append(posts.c.id.in_(select(func.substr(reactions.c.target, 3)).where(reactions.c.user_id == me.id, reactions.c.kind == "save")))
        order = {"new": [posts.c.created.desc()], "active": [posts.c.bumped.desc()], "wanted": [posts.c.wants.desc(), posts.c.created.desc()],
                 "reward": [posts.c.pot.desc(), posts.c.created.desc()], "popular": [(posts.c.likes + posts.c.saves * 2).desc(), posts.c.created.desc()]}.get(sort, [posts.c.created.desc()])
        rows = c.execute(select(posts).where(and_(*cond)).order_by(*order).limit(limit).offset(offset)).mappings().all()
        people = _people(c, [r["user_id"] for r in rows] + [r["claimed_by"] for r in rows])
        mine_r = _my_reactions(c, me, [f"p:{r['id']}" for r in rows])
    return {"items": [_post_json(dict(r), people, mine_r, me) for r in rows], "next": offset + limit if len(rows) == limit else None}


def _can_see_file(c, me: A.Me | None, f: dict) -> bool:
    if me and (me.is_admin or me.id == f["user_id"]):
        return True
    if f["kind"] in ("image", "pdf"):
        return True                                              # pictures of a request: helpers need them
    p = c.execute(select(posts).where(posts.c.id == f["post_id"])).mappings().first() if f["post_id"] else None
    if p and p["file_id"] == f["id"]:
        return p["visibility"] in ("public", "unlisted") and not p["hidden"]
    r = c.execute(select(replies).where(replies.c.file_id == f["id"])).mappings().first()
    if not r:
        return False
    p = c.execute(select(posts).where(posts.c.id == r["post_id"])).mappings().first()
    if not p:
        return False
    if r["status"] == "accepted" and p["licence"] in PUBLIC_OK:
        return True
    if not me:
        return False
    if me.id == p["user_id"]:
        return True
    return bool(c.execute(select(reactions.c.user_id).where(reactions.c.user_id == me.id, reactions.c.target == f"p:{p['id']}", reactions.c.kind == "want")).first())


@router.get("/posts/{pid}")
def get_post(pid: str, me: A.Me | None = Depends(A.optional)):
    with engine().connect() as c:
        p = _load_post(c, pid)
        if p["hidden"] and not (me and (me.is_admin or me.id == p["user_id"])):
            raise HTTPException(404, "This post was removed.")
        blocked = _blocked_by(c, me)
        rs = [dict(r) for r in c.execute(select(replies).where(replies.c.post_id == pid).order_by(replies.c.created)).mappings().all()
              if r["user_id"] not in blocked and (not r["hidden"] or (me and me.is_admin))]
        people = _people(c, [p["user_id"], p["claimed_by"]] + [r["user_id"] for r in rs])
        mine = _my_reactions(c, me, [f"p:{pid}"] + [f"r:{r['id']}" for r in rs])
        is_owner = bool(me and (me.id == p["user_id"] or me.is_admin))
        helpful_given = sum(1 for r in rs if r["status"] == "helpful")
        out_r = []
        for r in rs:
            f = None
            if r["file_id"]:
                frow = c.execute(select(files.c.id, files.c.user_id, files.c.kind, files.c.post_id).where(files.c.id == r["file_id"])).mappings().first()
                if frow and _can_see_file(c, me, dict(frow)):
                    f = {"id": r["file_id"], "bars": r["bars"], "notes": r["notes"]}
                else:
                    f = {"id": None, "bars": r["bars"], "notes": r["notes"], "private": True}
            out_r.append({"id": r["id"], "kind": r["kind"], "body": r["body"], "author": people.get(r["user_id"]), "status": r["status"],
                          "note": r["note"], "rating": r["rating"], "reward": r["reward"], "likes": r["likes"], "liked": (f"r:{r['id']}", "like") in mine,
                          "file": f, "hidden": r["hidden"], "created": _iso(r["created"]),
                          "can": {"accept": is_owner and p["status"] == "open" and r["kind"] in ("submission", "answer") and r["user_id"] != p["user_id"],
                                  "helpful": is_owner and r["status"] == "" and r["user_id"] != p["user_id"] and helpful_given < REWARDS["helpful_per_post"],
                                  "changes": is_owner and p["status"] == "open" and r["kind"] == "submission" and r["status"] == "",
                                  "delete": bool(me and (me.is_admin or me.id == r["user_id"]))}})
        out = _post_json(p, people, mine, me, full=True)
        out["replies_list"] = out_r
        out["can"] = {"edit": is_owner, "close": is_owner and p["status"] == "open" and p["type"] in ("request", "question"),
                      "claim": bool(me) and p["type"] == "request" and p["status"] == "open" and not (me and me.id == p["user_id"]),
                      "submit": bool(me) and p["type"] == "request" and p["status"] == "open" and not (me and me.id == p["user_id"]),
                      "answer": bool(me) and p["type"] == "question" and p["status"] == "open",
                      "publish": is_owner and p["type"] == "request" and p["status"] == "done" and p["licence"] in PUBLIC_OK}
    return out


class PostPatch(BaseModel):
    title: str | None = Field(None, min_length=2, max_length=120)
    body: str | None = Field(None, max_length=4000)
    status: Literal["closed"] | None = None
    licence: str | None = None


@router.patch("/posts/{pid}")
def edit_post(pid: str, body: PostPatch, me: A.Me = Depends(A.current)):
    with engine().begin() as c:
        p = _load_post(c, pid)
        if me.id != p["user_id"] and not me.is_admin:
            raise HTTPException(403, "Only the author can change this.")
        vals = {}
        if body.title is not None:
            vals["title"] = clean_text(body.title, 120)
        if body.body is not None:
            vals["body"] = clean_text(body.body, 4000)
        if body.licence in LICENCES:
            vals["licence"] = body.licence
            if p["type"] == "share" and body.licence not in PUBLIC_OK:
                vals["visibility"] = "unlisted"
        if vals:
            c.execute(update(posts).where(posts.c.id == pid).values(**vals))
        if body.status == "closed" and p["status"] == "open":
            _close(c, p, "closed")
    return get_post(pid, me)


@router.delete("/posts/{pid}")
def delete_post(pid: str, me: A.Me = Depends(A.current)):
    with engine().begin() as c:
        p = _load_post(c, pid)
        if me.id != p["user_id"] and not me.is_admin:
            raise HTTPException(403, "Only the author can delete this.")
        if p["status"] == "open":
            _close(c, p, "deleted")
        c.execute(update(posts).where(posts.c.id == pid).values(hidden=True, hide_reason="deleted"))
    return {"deleted": True}


class WantIn(BaseModel):
    add: int = Field(0, ge=0, le=REWARDS["max_pot"])


@router.post("/posts/{pid}/want")
def want(pid: str, body: WantIn, me: A.Me = Depends(A.current)):
    """'I want this too': lifts the request in the list, and can add credits to its reward."""
    with engine().begin() as c:
        p = _load_post(c, pid)
        if p["type"] not in ("request", "question") or p["hidden"]:
            raise HTTPException(400, "You can only back requests and questions.")
        t = f"p:{pid}"
        had = c.execute(select(reactions.c.user_id).where(reactions.c.user_id == me.id, reactions.c.target == t, reactions.c.kind == "want")).first()
        if not had and me.id != p["user_id"]:
            c.execute(insert(reactions).values(user_id=me.id, target=t, kind="want", created=_now()))
            c.execute(update(posts).where(posts.c.id == pid).values(wants=posts.c.wants + 1))
            A.notify(c, p["user_id"], "want", actor=me.id, post=pid)
        if body.add:
            if p["status"] != "open":
                raise HTTPException(400, "This one is finished already.")
            A.grant(c, me.id, -body.add, "pot", minted=False, ref=pid, note=p["title"][:80])
            c.execute(insert(pot_adds).values(post_id=pid, user_id=me.id, amount=body.add, created=_now()))
            c.execute(update(posts).where(posts.c.id == pid).values(pot=posts.c.pot + body.add))
    return get_post(pid, me)


@router.delete("/posts/{pid}/want")
def unwant(pid: str, me: A.Me = Depends(A.current)):
    with engine().begin() as c:
        n = c.execute(delete(reactions).where(reactions.c.user_id == me.id, reactions.c.target == f"p:{pid}", reactions.c.kind == "want")).rowcount
        if n:
            c.execute(update(posts).where(posts.c.id == pid).values(wants=case((posts.c.wants > 0, posts.c.wants - 1), else_=0)))
    return get_post(pid, me)


@router.post("/posts/{pid}/claim")
def claim(pid: str, me: A.Me = Depends(A.current)):
    """'I'm working on it' for 48 hours, so two people don't make the same score."""
    with engine().begin() as c:
        p = _load_post(c, pid)
        now = _now()
        if p["type"] != "request" or p["status"] != "open":
            raise HTTPException(400, "Only open requests can be claimed.")
        if p["user_id"] == me.id:
            raise HTTPException(400, "This is your own request.")
        if p["claimed_by"] and p["claimed_by"] != me.id and (p["claim_until"] or 0) > now:
            raise HTTPException(409, "Someone is already working on this one.")
        active = c.execute(select(func.count()).select_from(posts).where(posts.c.claimed_by == me.id, posts.c.claim_until > now,
                                                                          posts.c.status == "open", posts.c.id != pid)).scalar()
        if active >= REWARDS["max_claims"] and not me.is_admin:
            raise HTTPException(429, f"You're working on {active} requests already. Finish one first.")
        c.execute(update(posts).where(posts.c.id == pid).values(claimed_by=me.id, claim_until=now + REWARDS["claim_hours"] * 3600))
        A.notify(c, p["user_id"], "claim", actor=me.id, post=pid)
    return get_post(pid, me)


@router.delete("/posts/{pid}/claim")
def unclaim(pid: str, me: A.Me = Depends(A.current)):
    with engine().begin() as c:
        c.execute(update(posts).where(posts.c.id == pid, posts.c.claimed_by == me.id).values(claimed_by=None, claim_until=None))
    return get_post(pid, me)


@router.post("/posts/{pid}/spotlight")
def spotlight(pid: str, me: A.Me = Depends(A.current)):
    """Puts a request at the top for a day: free with Plus/Pro (a few a month), otherwise for credits."""
    with engine().begin() as c:
        p = _load_post(c, pid)
        if p["user_id"] != me.id or p["type"] != "request" or p["status"] != "open":
            raise HTTPException(400, "You can spotlight your own open requests.")
        free = A.plan_limits(me.tier).get("spotlights")
        used = c.execute(select(func.count()).select_from(A.ledger).where(A.ledger.c.user_id == me.id, A.ledger.c.reason == "spotlight",
                                                                            A.ledger.c.created > _period_start("month"))).scalar()
        if free is None or used < free:
            c.execute(insert(A.ledger).values(user_id=me.id, delta=0, reason="spotlight", minted=False, ref=pid, note="included in plan", created=_now()))
        else:
            A.grant(c, me.id, -REWARDS["spotlight_cost"], "spotlight", minted=False, ref=pid, note=p["title"][:80])
        c.execute(update(posts).where(posts.c.id == pid).values(spotlight_until=_now() + REWARDS["spotlight_hours"] * 3600, bumped=_now()))
    return get_post(pid, me)


# --------------------------------------------------------------------------------------- replies
class ReplyIn(BaseModel):
    kind: Literal["comment", "answer", "submission"]
    body: str = Field("", max_length=2000)
    xml: str | None = None


@router.post("/posts/{pid}/replies")
def reply(pid: str, body: ReplyIn, me: A.Me = Depends(A.current)):
    _limit_user(me, "reply", 40, 3600, "That's a lot of replies for one hour. Please take a short break.")
    text = clean_text(body.body, 2000)
    with engine().begin() as c:
        p = _load_post(c, pid)
        if p["hidden"]:
            raise HTTPException(404, "This post was removed.")
        if c.execute(select(blocks.c.blocker).where(blocks.c.blocker == p["user_id"], blocks.c.blocked == me.id)).first():
            raise HTTPException(403, "You can't reply here.")
        rid, now = A.new_id(), _now()
        file_id, bars, notes = None, 0, 0
        if body.kind == "submission":
            if p["type"] != "request" or p["status"] != "open":
                raise HTTPException(400, "Scores can be sent to open requests.")
            if p["user_id"] == me.id:
                raise HTTPException(400, "This is your own request.")
            xml = _check_xml(body.xml)
            bars, notes = _score_size(xml)
            file_id = _save_file(c, me.id, "musicxml", f"{p['title']}.musicxml", "application/vnd.recordare.musicxml+xml", xml.encode(), pid)
        elif body.kind == "answer":
            if p["type"] != "question" or p["status"] != "open":
                raise HTTPException(400, "Answers go on open questions.")
            if len(text) < 2:
                raise HTTPException(400, "Write your answer first.")
        elif len(text) < 1:
            raise HTTPException(400, "Write something first.")
        c.execute(insert(replies).values(id=rid, post_id=pid, user_id=me.id, kind=body.kind, body=text, file_id=file_id, bars=bars, notes=notes,
                                         created=now, updated=now))
        extra = {"replies": posts.c.replies + 1}
        if body.kind == "submission" and p["claimed_by"] == me.id:
            extra.update(claimed_by=None, claim_until=None)
        _bump(c, pid, **extra)
        A.notify(c, p["user_id"], {"submission": "submission", "answer": "answer"}.get(body.kind, "comment"), actor=me.id, post=pid)
    return get_post(pid, me)


def _speed(hours: float, table: list, late: float) -> float:
    for h, m in table:
        if hours <= h:
            return m
    return late


def _minted_today(c, uid: str) -> int:
    return c.execute(select(func.coalesce(func.sum(A.ledger.c.delta), 0)).where(
        A.ledger.c.user_id == uid, A.ledger.c.minted.is_(True), A.ledger.c.reason.in_(["help", "helpful", "answer"]),
        A.ledger.c.created > _now() - 86400)).scalar()


def _pay_bonus(c, uid: str, amount: int, reason: str, pid: str, title: str) -> int:
    """Haptune's bonus, within the helper's daily cap."""
    room = max(0, REWARDS["daily_help_cap"] - _minted_today(c, uid))
    amount = max(0, min(amount, room))
    if amount:
        A.grant(c, uid, amount, reason, minted=True, ref=pid, note=title[:80])
    return amount


class AcceptIn(BaseModel):
    rating: int = Field(..., ge=1, le=5)
    thanks: str = Field("", max_length=500)


@router.post("/replies/{rid}/accept")
def accept(rid: str, body: AcceptIn, me: A.Me = Depends(A.current)):
    """The requester (or asker) accepts a score (or answer): the helper gets the reward."""
    with engine().begin() as c:
        r = c.execute(select(replies).where(replies.c.id == rid)).mappings().first()
        if not r:
            raise HTTPException(404, "That reply isn't there any more.")
        p = _load_post(c, r["post_id"])
        if me.id != p["user_id"] and not me.is_admin:
            raise HTTPException(403, "Only the person who asked can accept.")
        if p["status"] != "open" or r["kind"] not in ("submission", "answer") or r["user_id"] == p["user_id"]:
            raise HTTPException(400, "This can't be accepted.")
        hours = max(0.0, (r["created"] - p["created"]) / 3600)
        quality = REWARDS["quality"][str(body.rating)]
        if r["kind"] == "submission":
            size = max(REWARDS["size_min"], min(REWARDS["size_max"], REWARDS["size_min"] + max(r["notes"] // REWARDS["size_notes_per_credit"], r["bars"] // 4)))
            bonus = min(REWARDS["bonus_cap"], round(size * _speed(hours, REWARDS["speed"], REWARDS["speed_late"]) * quality))
            reason = "help"
        else:
            bonus = round(REWARDS["answer"] * _speed(hours, REWARDS["answer_speed"], 1.0) * quality)
            reason = "answer"
        paid = _pay_bonus(c, r["user_id"], bonus, reason, p["id"], p["title"])
        if p["pot"]:
            A.grant(c, r["user_id"], p["pot"], "help_pot", minted=False, ref=p["id"], note=p["title"][:80])
        total = paid + p["pot"]
        thanks = clean_text(body.thanks, 500)
        c.execute(update(replies).where(replies.c.id == rid).values(status="accepted", rating=body.rating, reward=total, note=thanks, updated=_now()))
        c.execute(update(pot_adds).where(pot_adds.c.post_id == p["id"]).values(refunded=True))
        _bump(c, p["id"], status="done", accepted_reply=rid, claimed_by=None, claim_until=None)
        A.notify(c, r["user_id"], "accepted", actor=me.id, post=p["id"], credits=total, rating=body.rating)
        if p["type"] == "request":
            for (uid,) in c.execute(select(reactions.c.user_id).where(reactions.c.target == f"p:{p['id']}", reactions.c.kind == "want")).all():
                A.notify(c, uid, "ready", actor=r["user_id"], post=p["id"])
    return get_post(p["id"], me)


@router.post("/replies/{rid}/helpful")
def helpful(rid: str, me: A.Me = Depends(A.current)):
    """Thanks for a reply that helped (a second score, a good tip): a smaller reward."""
    with engine().begin() as c:
        r = c.execute(select(replies).where(replies.c.id == rid)).mappings().first()
        if not r:
            raise HTTPException(404, "That reply isn't there any more.")
        p = _load_post(c, r["post_id"])
        if me.id != p["user_id"] and not me.is_admin:
            raise HTTPException(403, "Only the person who asked can do that.")
        if r["status"] or r["user_id"] == p["user_id"]:
            raise HTTPException(400, "Already marked.")
        given = c.execute(select(func.count()).select_from(replies).where(replies.c.post_id == p["id"], replies.c.status == "helpful")).scalar()
        if given >= REWARDS["helpful_per_post"]:
            raise HTTPException(429, f"You can thank {REWARDS['helpful_per_post']} replies on one post.")
        if r["kind"] == "submission":
            size = max(REWARDS["size_min"], min(REWARDS["size_max"], REWARDS["size_min"] + r["notes"] // REWARDS["size_notes_per_credit"]))
            amount = min(REWARDS["runner_up_cap"], round(size * REWARDS["runner_up_share"]))
        else:
            amount = REWARDS["helpful_comment"]
        paid = _pay_bonus(c, r["user_id"], amount, "helpful", p["id"], p["title"])
        c.execute(update(replies).where(replies.c.id == rid).values(status="helpful", reward=paid, updated=_now()))
        A.notify(c, r["user_id"], "helpful", actor=me.id, post=p["id"], credits=paid)
    return get_post(p["id"], me)


class ChangesIn(BaseModel):
    note: str = Field(..., min_length=2, max_length=1000)


@router.post("/replies/{rid}/changes")
def ask_changes(rid: str, body: ChangesIn, me: A.Me = Depends(A.current)):
    with engine().begin() as c:
        r = c.execute(select(replies).where(replies.c.id == rid)).mappings().first()
        if not r:
            raise HTTPException(404, "That reply isn't there any more.")
        p = _load_post(c, r["post_id"])
        if me.id != p["user_id"] and not me.is_admin:
            raise HTTPException(403, "Only the person who asked can do that.")
        c.execute(update(replies).where(replies.c.id == rid).values(status="changes", note=clean_text(body.note, 1000), updated=_now()))
        A.notify(c, r["user_id"], "changes", actor=me.id, post=p["id"])
    return get_post(p["id"], me)


@router.delete("/replies/{rid}")
def delete_reply(rid: str, me: A.Me = Depends(A.current)):
    with engine().begin() as c:
        r = c.execute(select(replies).where(replies.c.id == rid)).mappings().first()
        if not r:
            raise HTTPException(404, "That reply isn't there any more.")
        if me.id != r["user_id"] and not me.is_admin:
            raise HTTPException(403, "Only the author can delete this.")
        if r["status"] == "accepted":
            raise HTTPException(400, "An accepted score stays, so the requester keeps it.")
        c.execute(update(replies).where(replies.c.id == rid).values(hidden=True))
    return {"deleted": True}


@router.post("/posts/{pid}/publish")
def publish(pid: str, me: A.Me = Depends(A.current)):
    """The requester shares the accepted score of a public-domain (or own) song in the Library."""
    with engine().begin() as c:
        p = _load_post(c, pid)
        if me.id != p["user_id"] or p["status"] != "done" or not p["accepted_reply"] or p["licence"] not in PUBLIC_OK:
            raise HTTPException(400, "Only finished requests for public-domain songs can be shared.")
        r = c.execute(select(replies).where(replies.c.id == p["accepted_reply"])).mappings().first()
        nid, now = A.new_id(), _now()
        c.execute(insert(posts).values(id=nid, user_id=r["user_id"], type="share", title=p["song"] or p["title"], body=f"Made for a request by @{me.acc['handle']}.",
                                       song=p["song"], artist=p["artist"], instruments=p["instruments"], level=p["level"], licence=p["licence"],
                                       visibility="public", file_id=r["file_id"], data={"bars": r["bars"], "notes": r["notes"], "from_request": pid},
                                       status="done", created=now, bumped=now))
        A.notify(c, r["user_id"], "published", actor=me.id, post=nid)
    return get_post(nid, me)


# --------------------------------------------------------------------------------------- reactions, files
class ReactIn(BaseModel):
    target: str = Field(..., max_length=20)
    kind: Literal["like", "save"]


@router.post("/react")
def react(body: ReactIn, me: A.Me = Depends(A.current)):
    """Toggles a clap (like) on a post or reply, or saves a shared score."""
    m = re.fullmatch(r"([pr]):([0-9a-f]{6,16})", body.target)
    if not m:
        raise HTTPException(400, "Unknown target.")
    table, col = (posts, posts.c.likes) if m.group(1) == "p" else (replies, replies.c.likes)
    with engine().begin() as c:
        row = c.execute(select(table).where(table.c.id == m.group(2))).mappings().first()
        if not row:
            raise HTTPException(404, "That isn't there any more.")
        had = c.execute(select(reactions.c.user_id).where(reactions.c.user_id == me.id, reactions.c.target == body.target, reactions.c.kind == body.kind)).first()
        target_col = posts.c.saves if body.kind == "save" else col
        if had:
            c.execute(delete(reactions).where(reactions.c.user_id == me.id, reactions.c.target == body.target, reactions.c.kind == body.kind))
            c.execute(update(table).where(table.c.id == row["id"]).values({target_col.name: target_col - 1}))
            on = False
        else:
            c.execute(insert(reactions).values(user_id=me.id, target=body.target, kind=body.kind, created=_now()))
            c.execute(update(table).where(table.c.id == row["id"]).values({target_col.name: target_col + 1}))
            on = True
            if body.kind == "like":
                A.notify(c, row["user_id"], "like", actor=me.id, post=row.get("post_id") or row["id"])
            if body.kind == "save" and m.group(1) == "p" and row["type"] == "share" and row["user_id"] != me.id:
                earned = c.execute(select(func.coalesce(func.sum(A.ledger.c.delta), 0)).where(
                    A.ledger.c.user_id == row["user_id"], A.ledger.c.reason == "saved", A.ledger.c.ref == row["id"])).scalar()
                if earned < REWARDS["share_saved_cap"]:
                    A.grant(c, row["user_id"], REWARDS["share_saved"], "saved", ref=row["id"], note=row["title"][:80])
    return {"on": on}


@router.get("/files/{fid}")
def get_file(fid: str, me: A.Me | None = Depends(A.optional)):
    with engine().connect() as c:
        f = c.execute(select(files).where(files.c.id == fid)).mappings().first()
        if not f or not _can_see_file(c, me, dict(f)):
            raise HTTPException(404, "That file isn't available to you.")
        if f["data"] is None:
            raise HTTPException(410, "This attachment has expired.")
    data = gzip.decompress(f["data"]) if f["kind"] == "musicxml" else f["data"]
    name = re.sub(r"[^\w .-]", "_", f["name"] or "file")[:80]
    return Response(content=data, media_type=f["mime"] or "application/octet-stream",
                    headers={"Content-Disposition": f'inline; filename="{name}"', "Cache-Control": "private, max-age=3600"})


# --------------------------------------------------------------------------------------- people
def _badges(c, uid: str, acc: dict | None) -> tuple[list[str], dict]:
    helps = c.execute(select(func.count()).select_from(replies).where(replies.c.user_id == uid, replies.c.kind == "submission", replies.c.status == "accepted")).scalar()
    answers = c.execute(select(func.count()).select_from(replies).where(replies.c.user_id == uid, replies.c.kind == "answer", replies.c.status == "accepted")).scalar()
    fives = c.execute(select(func.count()).select_from(replies).where(replies.c.user_id == uid, replies.c.rating == 5)).scalar()
    avg = c.execute(select(func.avg(replies.c.rating)).where(replies.c.user_id == uid, replies.c.rating.is_not(None))).scalar()
    shares = c.execute(select(func.count()).select_from(posts).where(posts.c.user_id == uid, posts.c.type == "share", posts.c.hidden.is_(False))).scalar()
    weeks = c.execute(select(func.count()).select_from(challenge_entries).where(challenge_entries.c.user_id == uid)).scalar()
    speedy = c.execute(select(func.count()).select_from(replies.join(posts, posts.c.id == replies.c.post_id)).where(
        replies.c.user_id == uid, replies.c.status == "accepted", replies.c.created - posts.c.created < 86400)).scalar()
    champion = c.execute(select(func.count()).select_from(A.ledger).where(A.ledger.c.user_id == uid, A.ledger.c.reason == "challenge_top")).scalar()
    teacher = c.execute(select(func.count()).select_from(classes_t).where(classes_t.c.teacher_id == uid)).scalar()
    earned = c.execute(select(func.coalesce(func.sum(A.ledger.c.delta), 0)).where(A.ledger.c.user_id == uid, A.ledger.c.reason.in_(["help", "help_pot", "helpful", "answer"]))).scalar()
    tier = A.effective_tier(acc) if acc else "free"
    b = []
    if tier == "dev":
        b.append("dev")
    if helps >= 1:
        b.append("first_help")
    if helps >= 5:
        b.append("helper_5")
    if helps >= 25:
        b.append("helper_25")
    if speedy:
        b.append("speedy")
    if fives >= 3:
        b.append("five_star")
    if answers >= 3:
        b.append("answerer")
    if shares >= 3:
        b.append("librarian")
    if weeks >= 3:
        b.append("challenger")
    if champion:
        b.append("champion")
    if acc and acc.get("streak", 0) >= 7:
        b.append("streak_7")
    if teacher:
        b.append("teacher")
    if tier in ("plus", "pro"):
        b.append("supporter")
    return b, {"helps": helps, "answers": answers, "rating": round(avg, 2) if avg else None, "shares": shares, "challenges": weeks,
               "earned": earned, "streak": (acc or {}).get("streak", 0)}


def _user_by_handle(c, handle: str) -> tuple[dict, dict]:
    acc = c.execute(select(A.accounts).where(A.accounts.c.handle == handle.lower().lstrip("@"))).mappings().first()
    if not acc:
        raise HTTPException(404, "No one has that username.")
    user = c.execute(select(users).where(users.c.id == acc["user_id"])).mappings().first()
    return dict(user), dict(acc)


@router.get("/users/{handle}")
def profile(handle: str, me: A.Me | None = Depends(A.optional)):
    with engine().connect() as c:
        user, acc = _user_by_handle(c, handle)
        badges, stats = _badges(c, user["id"], acc)
        followers = c.execute(select(func.count()).select_from(follows).where(follows.c.followee == user["id"])).scalar()
        following = c.execute(select(func.count()).select_from(follows).where(follows.c.follower == user["id"])).scalar()
        is_following = bool(me and c.execute(select(follows.c.follower).where(follows.c.follower == me.id, follows.c.followee == user["id"])).first())
        is_blocked = bool(me and c.execute(select(blocks.c.blocker).where(blocks.c.blocker == me.id, blocks.c.blocked == user["id"])).first())
    return {**A.public_user(user, acc), "bio": acc["bio"], "joined": _iso(acc["created"]), "badges": badges, "stats": stats,
            "followers": followers, "following": following, "is_following": is_following, "is_blocked": is_blocked,
            "is_me": bool(me and me.id == user["id"])}


@router.post("/users/{handle}/follow")
def follow(handle: str, me: A.Me = Depends(A.current)):
    with engine().begin() as c:
        user, _ = _user_by_handle(c, handle)
        if user["id"] == me.id:
            raise HTTPException(400, "That's you!")
        if not c.execute(select(follows.c.follower).where(follows.c.follower == me.id, follows.c.followee == user["id"])).first():
            c.execute(insert(follows).values(follower=me.id, followee=user["id"], created=_now()))
            A.notify(c, user["id"], "follow", actor=me.id)
    return profile(handle, me)


@router.delete("/users/{handle}/follow")
def unfollow(handle: str, me: A.Me = Depends(A.current)):
    with engine().begin() as c:
        user, _ = _user_by_handle(c, handle)
        c.execute(delete(follows).where(follows.c.follower == me.id, follows.c.followee == user["id"]))
    return profile(handle, me)


@router.post("/users/{handle}/block")
def block(handle: str, me: A.Me = Depends(A.current)):
    """Hides their posts and replies from you, and stops them replying to your posts."""
    with engine().begin() as c:
        user, _ = _user_by_handle(c, handle)
        if user["id"] == me.id:
            raise HTTPException(400, "That's you!")
        if not c.execute(select(blocks.c.blocker).where(blocks.c.blocker == me.id, blocks.c.blocked == user["id"])).first():
            c.execute(insert(blocks).values(blocker=me.id, blocked=user["id"], created=_now()))
        c.execute(delete(follows).where(or_(and_(follows.c.follower == me.id, follows.c.followee == user["id"]),
                                            and_(follows.c.follower == user["id"], follows.c.followee == me.id))))
    return profile(handle, me)


@router.delete("/users/{handle}/block")
def unblock(handle: str, me: A.Me = Depends(A.current)):
    with engine().begin() as c:
        user, _ = _user_by_handle(c, handle)
        c.execute(delete(blocks).where(blocks.c.blocker == me.id, blocks.c.blocked == user["id"]))
    return profile(handle, me)


@router.get("/blocks")
def my_blocks(me: A.Me = Depends(A.current)):
    with engine().connect() as c:
        ids = [r[0] for r in c.execute(select(blocks.c.blocked).where(blocks.c.blocker == me.id)).all()]
        people = _people(c, ids)
    return {"items": [people[i] for i in ids]}


# --------------------------------------------------------------------------------------- boards
@router.get("/leaderboard")
def leaderboard(board: Literal["helpers", "practice", "challenge"] = "helpers", period: Literal["week", "month", "all"] = "week",
                me: A.Me | None = Depends(A.optional)):
    since = _period_start(period)
    with engine().connect() as c:
        if board == "helpers":
            q = (select(A.ledger.c.user_id, func.sum(A.ledger.c.delta).label("v"))
                 .where(A.ledger.c.reason.in_(["help", "help_pot", "helpful", "answer"]), A.ledger.c.created >= since)
                 .group_by(A.ledger.c.user_id).order_by(func.sum(A.ledger.c.delta).desc()).limit(30))
        elif board == "practice":
            day0 = datetime.fromtimestamp(since, tz=timezone.utc).strftime("%Y-%m-%d") if since else "0000"
            q = (select(A.practice_log.c.user_id, func.sum(A.practice_log.c.minutes).label("v")).where(A.practice_log.c.day >= day0)
                 .group_by(A.practice_log.c.user_id).order_by(func.sum(A.practice_log.c.minutes).desc()).limit(30))
        else:
            q = (select(challenge_entries.c.user_id, challenge_entries.c.accuracy.label("v")).where(challenge_entries.c.week == _week())
                 .order_by(challenge_entries.c.accuracy.desc(), challenge_entries.c.tempo_pct.desc(), challenge_entries.c.created).limit(30))
        rows = c.execute(q).all()
        people = _people(c, [r[0] for r in rows])
    items = [{"rank": i + 1, "user": people[r[0]], "value": round(float(r[1]), 3) if board == "challenge" else int(r[1] or 0)} for i, r in enumerate(rows)]
    mine = next((x for x in items if me and x["user"]["id"] == me.id), None)
    return {"board": board, "period": period, "items": items, "me": mine}


def _award_challenge(c, week: str) -> None:
    if c.execute(select(A.kv.c.v).where(A.kv.c.k == f"challenge:{week}")).first():
        return
    top = c.execute(select(challenge_entries.c.user_id).where(challenge_entries.c.week == week)
                    .order_by(challenge_entries.c.accuracy.desc(), challenge_entries.c.tempo_pct.desc(), challenge_entries.c.created).limit(3)).all()
    for i, (uid,) in enumerate(top):
        A.grant(c, uid, REWARDS["challenge_top"][i], "challenge_top", ref=week, note=f"#{i + 1} in {week}")
        A.notify(c, uid, "challenge", place=i + 1, week=week, credits=REWARDS["challenge_top"][i])
    c.execute(insert(A.kv).values(k=f"challenge:{week}", v=str(_now())))


@router.get("/challenge")
def challenge(me: A.Me | None = Depends(A.optional)):
    week = _week()
    last = _week(_now() - 7 * 86400)
    song, title = _challenge_for(week)
    with engine().begin() as c:
        _award_challenge(c, last)
    with engine().connect() as c:
        rows = c.execute(select(challenge_entries).where(challenge_entries.c.week == week)
                         .order_by(challenge_entries.c.accuracy.desc(), challenge_entries.c.tempo_pct.desc(), challenge_entries.c.created).limit(20)).mappings().all()
        last_rows = c.execute(select(challenge_entries).where(challenge_entries.c.week == last)
                              .order_by(challenge_entries.c.accuracy.desc(), challenge_entries.c.tempo_pct.desc(), challenge_entries.c.created).limit(3)).mappings().all()
        mine = c.execute(select(challenge_entries).where(challenge_entries.c.week == week, challenge_entries.c.user_id == (me.id if me else "-"))).mappings().first()
        count = c.execute(select(func.count()).select_from(challenge_entries).where(challenge_entries.c.week == week)).scalar()
        people = _people(c, [r["user_id"] for r in rows] + [r["user_id"] for r in last_rows])
    entry = lambda r: {"user": people[r["user_id"]], "accuracy": r["accuracy"], "tempo_pct": r["tempo_pct"], "seconds": r["seconds"]}  # noqa: E731
    return {"week": week, "song": song, "title": title, "ends": _iso(_week_start() + 7 * 86400), "entries": [entry(r) for r in rows],
            "count": count, "mine": entry(mine) if mine else None, "last_week": {"song": _challenge_for(last)[1], "winners": [entry(r) for r in last_rows]},
            "rewards": {"entry": REWARDS["challenge_entry"], "top": REWARDS["challenge_top"]}}


class EntryIn(BaseModel):
    song: str = Field(..., max_length=20)
    accuracy: float = Field(..., ge=0, le=1)
    tempo_pct: int = Field(100, ge=30, le=200)
    seconds: int = Field(0, ge=0, le=7200)


@router.post("/challenge/entry")
def enter_challenge(body: EntryIn, me: A.Me = Depends(A.current)):
    week = _week()
    song, title = _challenge_for(week)
    if body.song != song:
        raise HTTPException(400, f"This week's challenge is {title}.")
    with engine().begin() as c:
        old = c.execute(select(challenge_entries).where(challenge_entries.c.week == week, challenge_entries.c.user_id == me.id)).mappings().first()
        if old is None:
            c.execute(insert(challenge_entries).values(week=week, user_id=me.id, song=song, accuracy=body.accuracy, tempo_pct=body.tempo_pct,
                                                       seconds=body.seconds, created=_now()))
            A.grant(c, me.id, REWARDS["challenge_entry"], "challenge", ref=week, note=title)
        elif (body.accuracy, body.tempo_pct) > (old["accuracy"], old["tempo_pct"]):
            c.execute(update(challenge_entries).where(challenge_entries.c.week == week, challenge_entries.c.user_id == me.id).values(
                accuracy=body.accuracy, tempo_pct=body.tempo_pct, seconds=body.seconds, created=_now()))
    return challenge(me)


@router.get("/home")
def home(me: A.Me | None = Depends(A.optional)):
    """Everything the Community tab shows first, in one call."""
    now = _now()
    with engine().begin() as c:
        _housekeeping(c)
    with engine().connect() as c:
        cond = _visible_posts(c, me) + [posts.c.visibility == "public"]
        spot = c.execute(select(posts).where(and_(*cond), posts.c.type == "request", posts.c.status == "open", posts.c.spotlight_until > now)
                         .order_by(posts.c.spotlight_until.desc()).limit(5)).mappings().all()
        mine_instr = (me.acc.get("instruments") or []) if me else []
        match = []
        if mine_instr:
            ors = [cast(posts.c.instruments, String).like(f'%"{i}"%') for i in mine_instr[:4]]
            match = c.execute(select(posts).where(and_(*cond), posts.c.type == "request", posts.c.status == "open", or_(*ors))
                              .order_by(posts.c.created.desc()).limit(6)).mappings().all()
        fresh = c.execute(select(posts).where(and_(*cond), posts.c.type == "request", posts.c.status == "open")
                          .order_by(posts.c.created.desc()).limit(6)).mappings().all()
        questions = c.execute(select(posts).where(and_(*cond), posts.c.type == "question", posts.c.status == "open")
                              .order_by(posts.c.created.desc()).limit(4)).mappings().all()
        shows = c.execute(select(posts).where(and_(*cond), posts.c.type.in_(["show", "share"]))
                          .order_by(posts.c.created.desc()).limit(8)).mappings().all()
        done = c.execute(select(posts).where(and_(*cond), posts.c.type == "request", posts.c.status == "done")
                         .order_by(posts.c.bumped.desc()).limit(4)).mappings().all()
        counts = {"open_requests": c.execute(select(func.count()).select_from(posts).where(posts.c.type == "request", posts.c.status == "open", posts.c.hidden.is_(False))).scalar(),
                  "helped_week": c.execute(select(func.count()).select_from(replies).where(replies.c.status == "accepted", replies.c.updated > _week_start())).scalar(),
                  "members": c.execute(select(func.count()).select_from(A.accounts)).scalar()}
        all_rows = list(spot) + list(match) + list(fresh) + list(questions) + list(shows) + list(done)
        people = _people(c, [r["user_id"] for r in all_rows] + [r["claimed_by"] for r in all_rows])
        mine_r = _my_reactions(c, me, [f"p:{r['id']}" for r in all_rows])
    pj = lambda rows: [_post_json(dict(r), people, mine_r, me) for r in rows]  # noqa: E731
    return {"spotlight": pj(spot), "for_you": pj(match), "new_requests": pj(fresh), "questions": pj(questions), "shows": pj(shows),
            "recently_done": pj(done), "counts": counts, "helpers": leaderboard("helpers", "week", me)["items"][:5], "challenge": challenge(me)}


# --------------------------------------------------------------------------------------- reports
class ReportIn(BaseModel):
    target: str = Field(..., max_length=20)          # p:<post> | r:<reply> | u:<handle>
    reason: Literal["spam", "rude", "copyright", "unsafe", "wrong", "other"]
    note: str = Field("", max_length=500)


@router.post("/report")
def report(body: ReportIn, me: A.Me = Depends(A.current)):
    """Anyone can report a post, reply or person. Three reports from different people hide it until the
    developer has looked (Google Play and the App Store require a way to report and block)."""
    _limit_user(me, "report", 20, 86400, "Thanks for keeping Haptune friendly. That's enough reports for today.")
    m = re.fullmatch(r"([pru]):([\w.]{3,40})", body.target)
    if not m:
        raise HTTPException(400, "Unknown target.")
    with engine().begin() as c:
        kind, key = m.group(1), m.group(2)
        owner = None
        if kind == "p":
            owner = c.execute(select(posts.c.user_id).where(posts.c.id == key)).scalar()
        elif kind == "r":
            owner = c.execute(select(replies.c.user_id).where(replies.c.id == key)).scalar()
        else:
            owner = c.execute(select(A.accounts.c.user_id).where(A.accounts.c.handle == key.lower())).scalar()
        if not owner:
            raise HTTPException(404, "That isn't there any more.")
        if not c.execute(select(reports.c.id).where(reports.c.reporter == me.id, reports.c.target == body.target, reports.c.status == "open")).first():
            c.execute(insert(reports).values(id=A.new_id(), reporter=me.id, target=body.target, target_user=owner, reason=body.reason,
                                             note=body.note.strip()[:500], created=_now()))
        n = c.execute(select(func.count(func.distinct(reports.c.reporter))).where(reports.c.target == body.target, reports.c.status == "open")).scalar()
        if n >= 3 and kind in ("p", "r"):
            t = posts if kind == "p" else replies
            c.execute(update(t).where(t.c.id == key).values(hidden=True, **({"hide_reason": "reported"} if kind == "p" else {})))
    return {"ok": True}


# --------------------------------------------------------------------------------------- admin
@router.get("/admin/overview")
def admin_overview(me: A.Me = Depends(A.require_admin)):
    with engine().connect() as c:
        count = lambda t, *w: c.execute(select(func.count()).select_from(t).where(*w)).scalar()  # noqa: E731
        day = _now() - 86400
        return {
            "members": count(A.accounts), "active_today": count(A.accounts, A.accounts.c.last_seen > day),
            "plus": count(A.accounts, A.accounts.c.tier == "plus"), "pro": count(A.accounts, A.accounts.c.tier == "pro"),
            "posts_today": count(posts, posts.c.created > day), "open_requests": count(posts, posts.c.type == "request", posts.c.status == "open"),
            "open_reports": count(reports, reports.c.status == "open"), "new_feedback": count(A.app_feedback, A.app_feedback.c.status == "new"),
            "ai_this_month": {k: c.execute(select(func.coalesce(func.sum(A.usage.c.used), 0)).where(A.usage.c.kind == k, A.usage.c.period == A.month())).scalar()
                              for k in A.AI_KINDS},
            "credits_minted_week": c.execute(select(func.coalesce(func.sum(A.ledger.c.delta), 0)).where(A.ledger.c.minted.is_(True), A.ledger.c.created > _week_start())).scalar(),
        }


@router.get("/admin/reports")
def admin_reports(me: A.Me = Depends(A.require_admin), status: str = "open"):
    with engine().connect() as c:
        rows = c.execute(select(reports).where(reports.c.status == status).order_by(reports.c.created.desc()).limit(100)).mappings().all()
        people = _people(c, [r["reporter"] for r in rows] + [r["target_user"] for r in rows])
        out = []
        for r in rows:
            kind, key = r["target"].split(":", 1)
            preview = ""
            post_id = None
            if kind == "p":
                p = c.execute(select(posts.c.title, posts.c.body, posts.c.hidden).where(posts.c.id == key)).first()
                preview, post_id = (f"{p[0]} — {p[1][:200]}" if p else ""), key
            elif kind == "r":
                rr = c.execute(select(replies.c.body, replies.c.post_id).where(replies.c.id == key)).first()
                preview, post_id = (rr[0][:240] if rr else ""), (rr[1] if rr else None)
            out.append({"id": r["id"], "target": r["target"], "post_id": post_id, "reason": r["reason"], "note": r["note"], "preview": preview,
                        "reporter": people.get(r["reporter"]), "user": people.get(r["target_user"]), "at": _iso(r["created"])})
    return {"items": out}


class ModIn(BaseModel):
    action: Literal["hide", "restore", "dismiss", "ban"]


@router.post("/admin/reports/{rid}")
def admin_handle_report(rid: str, body: ModIn, me: A.Me = Depends(A.require_admin)):
    with engine().begin() as c:
        r = c.execute(select(reports).where(reports.c.id == rid)).mappings().first()
        if not r:
            raise HTTPException(404, "No such report.")
        kind, key = r["target"].split(":", 1)
        t = posts if kind == "p" else replies if kind == "r" else None
        if body.action in ("hide", "ban") and t is not None:
            c.execute(update(t).where(t.c.id == key).values(hidden=True))
            A.notify(c, r["target_user"], "mod", action="hidden")
        if body.action == "restore" and t is not None:
            c.execute(update(t).where(t.c.id == key).values(hidden=False))
        if body.action == "ban" and r["target_user"]:
            c.execute(update(A.accounts).where(A.accounts.c.user_id == r["target_user"]).values(role="banned"))
        c.execute(update(reports).where(reports.c.target == r["target"], reports.c.status == "open").values(status="done", handled=_now()))
    return {"ok": True}


@router.get("/admin/feedback")
def admin_feedback(me: A.Me = Depends(A.require_admin), status: str = "new"):
    with engine().connect() as c:
        q = select(A.app_feedback).order_by(A.app_feedback.c.created.desc()).limit(100)
        if status != "all":
            q = q.where(A.app_feedback.c.status == status)
        rows = c.execute(q).mappings().all()
        people = _people(c, [r["user_id"] for r in rows])
    return {"items": [{"id": r["id"], "category": r["category"], "message": r["message"], "contact": r["contact"], "diagnostics": r["diagnostics"],
                       "status": r["status"], "note": r["admin_note"], "user": people.get(r["user_id"]) if r["user_id"] else None,
                       "at": _iso(r["created"])} for r in rows]}


class FeedbackPatch(BaseModel):
    status: Literal["new", "seen", "done"]
    note: str = Field("", max_length=2000)


@router.post("/admin/feedback/{fid}")
def admin_feedback_update(fid: str, body: FeedbackPatch, me: A.Me = Depends(A.require_admin)):
    with engine().begin() as c:
        c.execute(update(A.app_feedback).where(A.app_feedback.c.id == fid).values(status=body.status, admin_note=body.note))
    return {"ok": True}


class GrantIn(BaseModel):
    handle: str = Field(..., max_length=24)
    tier: Literal["free", "plus", "pro"]
    days: int = Field(30, ge=0, le=3650)


@router.post("/admin/grant")
def admin_grant(body: GrantIn, me: A.Me = Depends(A.require_admin)):
    """Gives a tester (or a teacher you work with) a plan for some days. days=0: no end date."""
    with engine().begin() as c:
        user, acc = _user_by_handle(c, body.handle)
        until = None if body.days == 0 or body.tier == "free" else _now() + body.days * 86400
        c.execute(update(A.accounts).where(A.accounts.c.user_id == user["id"]).values(
            tier=body.tier, tier_until=until, tier_source="grant" if body.tier != "free" else ""))
        A.notify(c, user["id"], "plan", tier=body.tier, days=body.days)
    return {"ok": True, "handle": acc["handle"], "tier": body.tier, "until": _iso(until)}


class CreditsIn(BaseModel):
    handle: str = Field(..., max_length=24)
    delta: int = Field(..., ge=-100000, le=100000)
    note: str = Field("", max_length=160)


@router.post("/admin/credits")
def admin_credits(body: CreditsIn, me: A.Me = Depends(A.require_admin)):
    with engine().begin() as c:
        user, _ = _user_by_handle(c, body.handle)
        bal = A.grant(c, user["id"], body.delta, "admin", note=body.note)
        A.notify(c, user["id"], "credits", amount=body.delta, reason="admin")
    return {"ok": True, "credits": bal}


class RoleIn(BaseModel):
    role: Literal["user", "banned", "admin"]


@router.post("/admin/users/{handle}/role")
def admin_role(handle: str, body: RoleIn, me: A.Me = Depends(A.require_admin)):
    with engine().begin() as c:
        user, _ = _user_by_handle(c, handle)
        c.execute(update(A.accounts).where(A.accounts.c.user_id == user["id"]).values(role=body.role))
    return {"ok": True}
