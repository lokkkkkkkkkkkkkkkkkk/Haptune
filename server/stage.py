"""Stage: the front of the community. Who is here now, what is trending, one search for scores and requests,
the daily challenge with friends, emoji reactions, and Notes (rewards) that turn into useful things.

Everything here builds on community.py (posts, replies, follows) and accounts.py (accounts, ledger).

Numbers shown to people are real. "Online" counts accounts this server heard from in the last five minutes;
nothing is padded.

Notes
    Earned by helping and practising (the amounts are in accounts.RULES and community.REWARDS), never bought.
    They can be used for: a bigger reward on your own request, a spotlight, a Plus week, or a Pro pass. A rank
    (Listener ... Maestro) follows the Notes someone has earned by contributing over time and never goes down
    when Notes are spent.
"""
from __future__ import annotations

import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import Column, Float, Integer, String, Table, and_, func, insert, or_, select, update

import accounts as A
import community as CM
from academy import _iso, _now, engine, meta

router = APIRouter(prefix="/c", tags=["stage"])

daily_entries = Table("daily_entries", meta,
                      Column("day", String(10), primary_key=True),
                      Column("user_id", String(36), primary_key=True),
                      Column("song", String(20), nullable=False),
                      Column("accuracy", Float, nullable=False),
                      Column("tempo_pct", Integer, nullable=False, default=100),
                      Column("seconds", Integer, nullable=False, default=0),
                      Column("created", Float, nullable=False))

DAILY = {"entry": 5, "top": [15, 10, 5], "nudges_per_day": 5}
RANKS = [("listener", 0), ("player", 100), ("soloist", 400), ("arranger", 1200), ("virtuoso", 3000), ("maestro", 8000)]
# What Notes can be exchanged for. Passes cost real money to run (AI), so each is limited per person and the
# number of Pro passes a month is capped for the whole server (HAPTUNE_PASSES_PER_MONTH).
REDEEM = {
    "plus_week": {"cost": 500, "tier": "plus", "days": 7, "every_days": 30},
    "pro_3": {"cost": 700, "tier": "pro", "days": 3, "every_days": 30},
    "pro_7": {"cost": 1400, "tier": "pro", "days": 7, "every_days": 30},
}
PASSES_PER_MONTH = int(os.environ.get("HAPTUNE_PASSES_PER_MONTH", "200"))
CONTRIB = ("help", "help_pot", "helpful", "answer", "share", "saved", "challenge", "challenge_top", "daily", "daily_top", "practice")
EMOJI = ("like", "love", "fire", "bravo", "wow")


def _day(t: float | None = None) -> str:
    return datetime.fromtimestamp(t or _now(), timezone.utc).strftime("%Y-%m-%d")


def _daily_song(day: str) -> tuple[str, str]:
    n = (datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc) - datetime(2026, 1, 1, tzinfo=timezone.utc)).days
    return CM.CHALLENGES[(n * 5 + 3) % len(CM.CHALLENGES)]


# ------------------------------------------------------------------------------------------- trending
def _heat(p: dict, now: float) -> float:
    age_days = max(0.0, (now - p["created"]) / 86400.0)
    raw = p["wants"] * 3 + p["likes"] + p["saves"] * 2 + p["replies"] + (2 if p["pot"] else 0)
    return (raw + 1) / (1.0 + age_days / 5.0)


def _trending(c, me, limit: int = 10) -> list[dict]:
    now = _now()
    cond = CM._visible_posts(c, me) + [CM.posts.c.visibility == "public", CM.posts.c.created > now - 45 * 86400,
                                       or_(and_(CM.posts.c.type == "request", CM.posts.c.status == "open"), CM.posts.c.type == "share")]
    rows = [dict(r) for r in c.execute(select(CM.posts).where(and_(*cond)).order_by(CM.posts.c.bumped.desc()).limit(200)).mappings().all()]
    rows.sort(key=lambda p: -_heat(p, now))
    rows = rows[:limit]
    people = CM._people(c, [r["user_id"] for r in rows])
    return [_brief(r, people) for r in rows]


def _brief(p: dict, people: dict) -> dict:
    now = _now()
    claimed = bool(p["claimed_by"] and (p["claim_until"] or 0) > now and p["status"] == "open")
    return {"id": p["id"], "kind": "request" if p["type"] == "request" else "score", "title": p["title"], "artist": p["artist"],
            "instrument": (p["instruments"] or [""])[0], "wants": p["wants"], "likes": p["likes"], "saves": p["saves"],
            "heat": p["wants"] if p["type"] == "request" else p["likes"] + p["saves"],
            "status": "claimed" if claimed else p["status"], "author": people.get(p["user_id"]), "created": _iso(p["created"])}


# ------------------------------------------------------------------------------------------- pulse
def _counts(c) -> dict:
    day_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    week = CM._week_start()
    return {
        "online": max(1, A.online_now()), "practising": A.practising_now(),
        "today": c.execute(select(func.count()).select_from(A.accounts).where(A.accounts.c.last_seen >= day_start)).scalar() or 0,
        "members": c.execute(select(func.count()).select_from(A.accounts)).scalar() or 0,
        "open_requests": c.execute(select(func.count()).select_from(CM.posts).where(
            CM.posts.c.type == "request", CM.posts.c.status == "open", CM.posts.c.hidden.is_(False))).scalar() or 0,
        "scores_week": (c.execute(select(func.count()).select_from(CM.replies).where(CM.replies.c.status == "accepted", CM.replies.c.updated > week)).scalar() or 0)
        + (c.execute(select(func.count()).select_from(CM.posts).where(CM.posts.c.type == "share", CM.posts.c.created > week, CM.posts.c.hidden.is_(False))).scalar() or 0),
    }


def _daily_brief(c, me) -> dict:
    day = _day()
    song, title = _daily_song(day)
    players = c.execute(select(func.count()).select_from(daily_entries).where(daily_entries.c.day == day)).scalar() or 0
    mine = c.execute(select(daily_entries.c.accuracy).where(daily_entries.c.day == day, daily_entries.c.user_id == (me.id if me else "-"))).scalar()
    return {"day": day, "song": song, "title": title, "players": players, "mine": mine}


@router.get("/pulse")
def pulse(request: Request, me: A.Me | None = Depends(A.optional), practising: bool = False):
    """A small, cheap call the app makes while open: who is here, what is hot, today's challenge."""
    if me:
        A.touch(me.id, practising)
    with engine().connect() as c:
        return {**_counts(c), "trending": _trending(c, me, 8), "daily": _daily_brief(c, me)}


@router.get("/search")
def search(q: str = "", me: A.Me | None = Depends(A.optional)):
    """Scores on Stage and open requests that match a song name: what Home shows next to the free library."""
    text = q.strip()[:60]
    if len(text) < 2:
        return {"scores": [], "requests": []}
    like = f"%{text}%"
    match = or_(CM.posts.c.title.ilike(like), CM.posts.c.song.ilike(like), CM.posts.c.artist.ilike(like))
    with engine().connect() as c:
        cond = CM._visible_posts(c, me) + [CM.posts.c.visibility == "public", match]
        scores = c.execute(select(CM.posts).where(and_(*cond), CM.posts.c.type == "share")
                           .order_by((CM.posts.c.likes + CM.posts.c.saves * 2).desc(), CM.posts.c.created.desc()).limit(6)).mappings().all()
        reqs = c.execute(select(CM.posts).where(and_(*cond), CM.posts.c.type == "request", CM.posts.c.status.in_(["open", "done"]))
                         .order_by(CM.posts.c.wants.desc(), CM.posts.c.created.desc()).limit(6)).mappings().all()
        people = CM._people(c, [r["user_id"] for r in list(scores) + list(reqs)])
    return {"scores": [_brief(dict(r), people) for r in scores], "requests": [_brief(dict(r), people) for r in reqs]}


@router.get("/stage")
def stage(me: A.Me | None = Depends(A.optional)):
    """The front page of Stage in one call: scores to play, songs people want, who needs help with what."""
    if me:
        A.touch(me.id)
    with engine().begin() as c:
        CM._housekeeping(c)
    with engine().connect() as c:
        vis = CM._visible_posts(c, me) + [CM.posts.c.visibility == "public"]
        P = CM.posts
        new_scores = c.execute(select(P).where(and_(*vis), P.c.type == "share").order_by(P.c.created.desc()).limit(10)).mappings().all()
        wanted = c.execute(select(P).where(and_(*vis), P.c.type == "request", P.c.status == "open")
                           .order_by(P.c.wants.desc(), P.c.created.desc()).limit(8)).mappings().all()
        mine_instr = (me.acc.get("instruments") or []) if me else []
        help_rows = []
        if mine_instr:
            from sqlalchemy import String as _S, cast
            ors = [cast(P.c.instruments, _S).like(f'%"{i}"%') for i in mine_instr[:4]]
            help_rows = c.execute(select(P).where(and_(*vis), P.c.type == "request", P.c.status == "open", or_(*ors))
                                  .order_by(P.c.created.desc()).limit(6)).mappings().all()
        delivered = c.execute(select(P).where(and_(*vis), P.c.type == "request", P.c.status == "done").order_by(P.c.bumped.desc()).limit(5)).mappings().all()
        questions = c.execute(select(P).where(and_(*vis), P.c.type == "question", P.c.status == "open").order_by(P.c.created.desc()).limit(4)).mappings().all()
        wins = c.execute(select(P).where(and_(*vis), P.c.type == "show").order_by(P.c.created.desc()).limit(6)).mappings().all()
        rows = list(new_scores) + list(wanted) + list(help_rows) + list(delivered) + list(questions) + list(wins)
        people = CM._people(c, [r["user_id"] for r in rows] + [r["claimed_by"] for r in rows])
        mine_r = CM._my_reactions(c, me, [f"p:{r['id']}" for r in rows])
        out = {"counts": _counts(c), "trending": _trending(c, me, 10), "daily": _daily_brief(c, me)}
    pj = lambda rr: [CM._post_json(dict(r), people, mine_r, me) for r in rr]  # noqa: E731
    out.update({"new_scores": pj(new_scores), "wanted": pj(wanted), "help_wanted": pj(help_rows), "delivered": pj(delivered),
                "questions": pj(questions), "wins": pj(wins), "helpers": CM.leaderboard("helpers", "week", me)["items"][:5],
                "challenge": CM.challenge(me)})
    return out


# ------------------------------------------------------------------------------------------- daily challenge
def _award_daily(c, day: str) -> None:
    if c.execute(select(A.kv.c.v).where(A.kv.c.k == f"daily:{day}")).first():
        return
    top = c.execute(select(daily_entries.c.user_id).where(daily_entries.c.day == day)
                    .order_by(daily_entries.c.accuracy.desc(), daily_entries.c.tempo_pct.desc(), daily_entries.c.created).limit(3)).all()
    for i, (uid,) in enumerate(top):
        A.grant(c, uid, DAILY["top"][i], "daily_top", ref=day, note=f"#{i + 1} on {day}")
        A.notify(c, uid, "challenge", place=i + 1, day=day, credits=DAILY["top"][i])
    c.execute(insert(A.kv).values(k=f"daily:{day}", v=str(_now())))


def _daily_streak(c, uid: str) -> int:
    days = {d for (d,) in c.execute(select(daily_entries.c.day).where(daily_entries.c.user_id == uid)
                                    .order_by(daily_entries.c.day.desc()).limit(400)).all()}
    d = datetime.now(timezone.utc)
    if d.strftime("%Y-%m-%d") not in days:
        d -= timedelta(days=1)
    n = 0
    while d.strftime("%Y-%m-%d") in days:
        n += 1
        d -= timedelta(days=1)
    return n


@router.get("/daily")
def daily(me: A.Me | None = Depends(A.optional)):
    """Today's tune: everyone plays the same short piece; friends (people you follow) are listed first."""
    day = _day()
    song, title = _daily_song(day)
    yesterday = _day(_now() - 86400)
    with engine().begin() as c:
        _award_daily(c, yesterday)
    order = [daily_entries.c.accuracy.desc(), daily_entries.c.tempo_pct.desc(), daily_entries.c.created]
    with engine().connect() as c:
        rows = c.execute(select(daily_entries).where(daily_entries.c.day == day).order_by(*order).limit(20)).mappings().all()
        count = c.execute(select(func.count()).select_from(daily_entries).where(daily_entries.c.day == day)).scalar() or 0
        mine = c.execute(select(daily_entries).where(daily_entries.c.day == day, daily_entries.c.user_id == (me.id if me else "-"))).mappings().first()
        friends, waiting = [], []
        if me:
            ids = [r[0] for r in c.execute(select(CM.follows.c.followee).where(CM.follows.c.follower == me.id).limit(300)).all()]
            if ids:
                friends = c.execute(select(daily_entries).where(daily_entries.c.day == day, daily_entries.c.user_id.in_(ids + [me.id])).order_by(*order).limit(30)).mappings().all()
                played = {r["user_id"] for r in friends}
                waiting = [i for i in ids if i not in played][:12]
        last = c.execute(select(daily_entries).where(daily_entries.c.day == yesterday).order_by(*order).limit(3)).mappings().all()
        people = CM._people(c, [r["user_id"] for r in list(rows) + list(friends) + list(last)] + waiting)
        rank = None
        if mine:
            rank = 1 + (c.execute(select(func.count()).select_from(daily_entries).where(
                daily_entries.c.day == day, or_(daily_entries.c.accuracy > mine["accuracy"],
                                                and_(daily_entries.c.accuracy == mine["accuracy"], daily_entries.c.tempo_pct > mine["tempo_pct"])))).scalar() or 0)
        streak = _daily_streak(c, me.id) if me else 0
    entry = lambda r: {"user": people.get(r["user_id"]), "accuracy": r["accuracy"], "tempo_pct": r["tempo_pct"], "seconds": r["seconds"]}  # noqa: E731
    tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return {"day": day, "song": song, "title": title, "ends": tomorrow.isoformat().replace("+00:00", "Z"), "players": count,
            "entries": [entry(r) for r in rows], "friends": [entry(r) for r in friends], "waiting": [people[i] for i in waiting if i in people],
            "mine": {**entry(mine), "rank": rank} if mine else None, "streak": streak,
            "yesterday": {"title": _daily_song(yesterday)[1], "winners": [entry(r) for r in last]},
            "rewards": DAILY, "online": max(1, A.online_now())}


class DailyIn(BaseModel):
    song: str = Field(..., max_length=20)
    accuracy: float = Field(..., ge=0, le=1)
    tempo_pct: int = Field(100, ge=30, le=200)
    seconds: int = Field(0, ge=0, le=7200)


@router.post("/daily/entry")
def enter_daily(body: DailyIn, me: A.Me = Depends(A.current)):
    day = _day()
    song, title = _daily_song(day)
    if body.song != song:
        raise HTTPException(400, f"Today's tune is {title}.")
    earned = 0
    with engine().begin() as c:
        old = c.execute(select(daily_entries).where(daily_entries.c.day == day, daily_entries.c.user_id == me.id)).mappings().first()
        if old is None:
            c.execute(insert(daily_entries).values(day=day, user_id=me.id, song=song, accuracy=body.accuracy, tempo_pct=body.tempo_pct,
                                                   seconds=body.seconds, created=_now()))
            A.grant(c, me.id, DAILY["entry"], "daily", ref=day, note=title)
            earned = DAILY["entry"]
        elif (body.accuracy, body.tempo_pct) > (old["accuracy"], old["tempo_pct"]):
            c.execute(update(daily_entries).where(daily_entries.c.day == day, daily_entries.c.user_id == me.id).values(
                accuracy=body.accuracy, tempo_pct=body.tempo_pct, seconds=body.seconds, created=_now()))
    return {**daily(me), "earned": earned}


class NudgeIn(BaseModel):
    handle: str = Field(..., max_length=24)


@router.post("/daily/nudge")
def nudge(body: NudgeIn, me: A.Me = Depends(A.current)):
    """"Your turn!": tells a friend you follow that today's tune is waiting (a few a day, once per friend)."""
    day = _day()
    with engine().begin() as c:
        user, _acc = CM._user_by_handle(c, body.handle)
        if not c.execute(select(CM.follows.c.follower).where(CM.follows.c.follower == me.id, CM.follows.c.followee == user["id"])).first():
            raise HTTPException(403, "Follow them first.")
        if c.execute(select(daily_entries.c.user_id).where(daily_entries.c.day == day, daily_entries.c.user_id == user["id"])).first():
            return {"ok": True, "played": True}
        sent = c.execute(select(func.count()).select_from(A.notifications).where(
            A.notifications.c.actor_id == me.id, A.notifications.c.kind == "nudge", A.notifications.c.created > _now() - 86400)).scalar() or 0
        again = c.execute(select(A.notifications.c.id).where(A.notifications.c.actor_id == me.id, A.notifications.c.kind == "nudge",
                                                             A.notifications.c.user_id == user["id"], A.notifications.c.created > _now() - 86400)).first()
        if again:
            return {"ok": True, "already": True}
        if sent >= DAILY["nudges_per_day"]:
            raise HTTPException(429, "That's enough nudges for today.")
        A.notify(c, user["id"], "nudge", actor=me.id, day=day, title=_daily_song(day)[1])
    return {"ok": True}


# ------------------------------------------------------------------------------------------- emoji reactions
class EmojiIn(BaseModel):
    target: str = Field(..., max_length=20)
    kind: Literal["like", "love", "fire", "bravo", "wow"]


@router.post("/emoji")
def emoji(body: EmojiIn, me: A.Me = Depends(A.current)):
    """One reaction per person on a post or reply: tapping the same one removes it, another one replaces it.
    All reactions count towards the post's total, which is what "popular" sorts by."""
    m = re.fullmatch(r"([pr]):([0-9a-f]{6,16})", body.target)
    if not m:
        raise HTTPException(400, "Unknown target.")
    table = CM.posts if m.group(1) == "p" else CM.replies
    R = CM.reactions
    with engine().begin() as c:
        row = c.execute(select(table).where(table.c.id == m.group(2))).mappings().first()
        if not row:
            raise HTTPException(404, "That isn't there any more.")
        had = [k for (k,) in c.execute(select(R.c.kind).where(R.c.user_id == me.id, R.c.target == body.target, R.c.kind.in_(EMOJI))).all()]
        from sqlalchemy import delete
        if had:
            c.execute(delete(R).where(R.c.user_id == me.id, R.c.target == body.target, R.c.kind.in_(EMOJI)))
        mine = None
        if body.kind not in had:
            c.execute(insert(R).values(user_id=me.id, target=body.target, kind=body.kind, created=_now()))
            mine = body.kind
            if not had:
                A.notify(c, row["user_id"], "like", actor=me.id, post=row.get("post_id") or row["id"], emoji=body.kind)
        delta = (1 if mine else 0) - (1 if had else 0)
        if delta:
            c.execute(update(table).where(table.c.id == row["id"]).values(likes=table.c.likes + delta))
        counts = dict(c.execute(select(R.c.kind, func.count()).where(R.c.target == body.target, R.c.kind.in_(EMOJI)).group_by(R.c.kind)).all())
    return {"mine": mine, "counts": counts, "total": sum(counts.values())}


@router.get("/emoji")
def emoji_counts(targets: str = "", me: A.Me | None = Depends(A.optional)):
    """Reaction counts (and mine) for up to 40 posts/replies: targets=p:abc,r:def"""
    ids = [t for t in targets.split(",") if re.fullmatch(r"[pr]:[0-9a-f]{6,16}", t)][:40]
    if not ids:
        return {"items": {}}
    R = CM.reactions
    with engine().connect() as c:
        rows = c.execute(select(R.c.target, R.c.kind, func.count()).where(R.c.target.in_(ids), R.c.kind.in_(EMOJI)).group_by(R.c.target, R.c.kind)).all()
        mine = dict(c.execute(select(R.c.target, R.c.kind).where(R.c.target.in_(ids), R.c.kind.in_(EMOJI), R.c.user_id == (me.id if me else "-"))).all())
    out: dict = {t: {"counts": {}, "mine": mine.get(t)} for t in ids}
    for target, kind, n in rows:
        out[target]["counts"][kind] = n
    return {"items": out}


# ------------------------------------------------------------------------------------------- Notes and ranks
def rank_of(lifetime: int) -> dict:
    i = max(k for k, (_, need) in enumerate(RANKS) if lifetime >= need)
    nxt = RANKS[i + 1] if i + 1 < len(RANKS) else None
    return {"id": RANKS[i][0], "index": i, "lifetime": lifetime, "next": nxt[0] if nxt else None, "next_at": nxt[1] if nxt else None,
            "from": RANKS[i][1]}


def lifetime_earned(c, uid: str) -> int:
    return int(c.execute(select(func.coalesce(func.sum(A.ledger.c.delta), 0)).where(
        A.ledger.c.user_id == uid, A.ledger.c.delta > 0, A.ledger.c.reason.in_(CONTRIB))).scalar() or 0)


def _passes_this_month(c) -> int:
    start = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()
    return c.execute(select(func.count()).select_from(A.ledger).where(A.ledger.c.reason == "pass", A.ledger.c.created >= start)).scalar() or 0


def _redeem_state(c, me: A.Me, acc: dict) -> list[dict]:
    paid = acc["tier_source"] in ("store", "stripe", "manual", "grant") and A.effective_tier(acc) != "free"
    last = acc["plus_redeemed"] or 0
    out = []
    for key, it in REDEEM.items():
        why = None
        if me.tier == "dev" or (paid and A.TIER_RANK[A.effective_tier(acc)] >= A.TIER_RANK[it["tier"]]):
            why = "have"                                             # their plan already includes it
        elif paid:
            why = "paid"                                             # on a paid plan: upgrade instead of a pass
        elif last > _now() - it["every_days"] * 86400:
            why = "wait"
        elif it["tier"] == "pro" and _passes_this_month(c) >= PASSES_PER_MONTH:
            why = "sold_out"
        elif acc["credits"] < it["cost"]:
            why = "notes"
        out.append({"id": key, **it, "available": why is None, "why": why,
                    "again": _iso(last + it["every_days"] * 86400) if why == "wait" else None})
    return out


@router.get("/rewards")
def rewards(me: A.Me = Depends(A.current)):
    """Everything the Rewards screen shows: balance, rank, how Notes are earned, what they unlock, history."""
    with engine().connect() as c:
        acc = dict(c.execute(select(A.accounts).where(A.accounts.c.user_id == me.id)).mappings().first())
        life = lifetime_earned(c, me.id)
        rows = c.execute(select(A.ledger).where(A.ledger.c.user_id == me.id).order_by(A.ledger.c.id.desc()).limit(60)).mappings().all()
        redeem = _redeem_state(c, me, acc)
        week = int(c.execute(select(func.coalesce(func.sum(A.ledger.c.delta), 0)).where(
            A.ledger.c.user_id == me.id, A.ledger.c.delta > 0, A.ledger.c.created > _now() - 7 * 86400)).scalar() or 0)
    R, RU = CM.REWARDS, A.RULES
    earn = [
        {"id": "deliver", "icon": "staff", "amount": f"{R['size_min']}–{R['bonus_cap']}", "extra": "pot"},
        {"id": "answer", "icon": "quiz", "amount": str(R["answer"])},
        {"id": "share", "icon": "books", "amount": str(R["share"]), "per_save": R["share_saved"]},
        {"id": "helpful", "icon": "heart", "amount": str(R["helpful_comment"])},
        {"id": "daily", "icon": "bolt", "amount": str(DAILY["entry"]), "top": DAILY["top"][0]},
        {"id": "weekly", "icon": "trophy", "amount": str(R["challenge_entry"]), "top": R["challenge_top"][0]},
        {"id": "practice", "icon": "flame", "amount": str(RU["daily_practice"]), "streak": RU["streak_week"]},
    ]
    return {"notes": acc["credits"], "week": week, "rank": rank_of(life), "ranks": [{"id": r, "at": n} for r, n in RANKS], "earn": earn,
            "redeem": redeem, "spotlight_cost": R["spotlight_cost"],
            "history": [{"delta": r["delta"], "reason": r["reason"], "ref": r["ref"], "note": r["note"], "at": _iso(r["created"])} for r in rows]}


class RedeemIn(BaseModel):
    item: Literal["plus_week", "pro_3", "pro_7"]


@router.post("/rewards/redeem")
def redeem(body: RedeemIn, me: A.Me = Depends(A.current)):
    it = REDEEM[body.item]
    with engine().begin() as c:
        acc = dict(c.execute(select(A.accounts).where(A.accounts.c.user_id == me.id)).mappings().first())
        state = next(x for x in _redeem_state(c, me, acc) if x["id"] == body.item)
        if not state["available"]:
            msg = {"have": "Your plan already includes this.", "paid": "You are on a paid plan: upgrade it instead.",
                   "wait": "You can do this once a month.", "sold_out": "This month's passes are all taken. They come back on the 1st.",
                   "notes": "Not enough Notes yet."}[state["why"]]
            raise HTTPException(402 if state["why"] == "notes" else 409, {"code": "credits" if state["why"] == "notes" else state["why"], "message": msg})
        A.grant(c, me.id, -it["cost"], "pass", minted=False, note=f"{it['tier']} {it['days']} days")
        start = max(_now(), acc["tier_until"] or 0) if acc["tier"] == it["tier"] and acc["tier_source"] == "notes" else _now()
        c.execute(update(A.accounts).where(A.accounts.c.user_id == me.id).values(
            tier=it["tier"], tier_until=start + it["days"] * 86400, tier_source="notes", pass_days=it["days"], plus_redeemed=_now()))
    return A.me_json(A.reload(me.id))
