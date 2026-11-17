"""Product analytics without a third-party SDK, and feature flags.

Collection
    The app batches events (ui/analytics.js) and sends them every 30 s or when the page is hidden: POST /c/events.
    The server adds its own (sign-ins, server errors). Only names in EVENTS are kept, props are capped, IP
    addresses are never stored: only a two-letter country (Cloudflare's CF-IPCountry when the site is proxied,
    else the region of the device's language setting, e.g. en-MY -> MY). People can switch usage statistics off
    in Settings (the app then sends nothing), export them (GET /c/me/export) and delete them with the account.

Storage
    `events`: raw events, kept RAW_DAYS (180) days. At ingest the server also updates two small roll-ups the
    dashboard reads, so it stays fast however many events there are:
      counters   (day, name, platform, screen) -> count and total value (seconds, scores)
      actor_days (day, actor) -> platform, country: who was active each day (DAU/WAU/MAU, retention, splits)
    An actor is the account id, or "d:<device id>" before an account exists.

Dashboard (Developer mode, scope read_analytics): overview, activity feed and funnels, features (time per
screen), errors grouped by message. Feature flags (scope feature_flags): on / off / beta, for a percentage of
people or for named people, read by the app at start (GET /c/flags).
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import JSON, Column, Float, Integer, String, Table, and_, delete, func, insert, or_, select, update

import accounts as A
from academy import _iso, _now, engine, meta

router = APIRouter(prefix="/c", tags=["analytics"])
RAW_DAYS = 180
MAX_BATCH = 200

# name -> what `value` means (shown in the dashboard)
EVENTS = {
    "session_start": "", "session_end": "seconds", "screen_view": "", "screen_time": "seconds",
    "piece_open": "", "play_along_start": "", "play_along_finish": "score %", "listen": "",
    "create_export": "", "post_created": "", "class_joined": "", "sound_made": "seconds", "sound_check": "",
    "hapi_ask": "", "search": "", "error": "", "next_step": "", "deep_link": "",
    # added by the server
    "sign_in": "", "sign_up": "", "server_error": "",
}
CLIENT_EVENTS = set(EVENTS) - {"sign_in", "sign_up", "server_error"}
PLATFORMS = {"web", "homescreen", "android", "ios", "desktop", "server"}
FUNNELS = {
    "practise": ("Find → Practise → Report → Share", ["piece_open", "play_along_start", "play_along_finish", "post_created"]),
    "create": ("Create → Export", ["screen_view:create", "create_export"]),
    "stage": ("Stage request → fulfilled", ["post_created:request", "request_fulfilled"]),
}

events = Table("events", meta,
               Column("id", Integer, primary_key=True, autoincrement=True),
               Column("ts", Float, nullable=False, index=True),
               Column("day", String(10), nullable=False, index=True),
               Column("actor", String(40), nullable=False, index=True),
               Column("user_id", String(36), nullable=True, index=True),
               Column("name", String(24), nullable=False, index=True),
               Column("screen", String(40), nullable=False, default=""),
               Column("label", String(200), nullable=False, default=""),
               Column("value", Float, nullable=True),
               Column("props", JSON, nullable=True),
               Column("platform", String(12), nullable=False, default=""),
               Column("country", String(2), nullable=False, default=""))
counters = Table("event_counters", meta,
                 Column("day", String(10), primary_key=True),
                 Column("name", String(24), primary_key=True),
                 Column("platform", String(12), primary_key=True),
                 Column("screen", String(40), primary_key=True),
                 Column("n", Integer, nullable=False, default=0),
                 Column("total", Float, nullable=False, default=0))
actor_days = Table("actor_days", meta,
                   Column("day", String(10), primary_key=True),
                   Column("actor", String(40), primary_key=True),
                   Column("platform", String(12), nullable=False, default=""),
                   Column("country", String(2), nullable=False, default=""))
flags = Table("feature_flags", meta,
              Column("key", String(40), primary_key=True),
              Column("state", String(8), nullable=False, default="on"),      # on | off | beta
              Column("percent", Integer, nullable=False, default=100),       # share of people who get it (on/beta)
              Column("users", JSON, nullable=True),                          # handles who always get it
              Column("note", String(300), nullable=False, default=""),
              Column("updated", Float, nullable=False),
              Column("by", String(36), nullable=False, default=""))

# features the app knows how to hide (key -> label); a flag that isn't set is on for everyone
FLAGS = {
    "hapi": "Hapi, the AI helper", "sounds": "Sounds (mixer, Stage sounds)", "improvise": "AI improvisation",
    "chord_editor": "Chord-sheet editor", "tutors": "Find a tutor", "google": "Google Calendar / Drive / Contacts",
    "academy": "Academy courses", "daily": "Daily challenge",
}


# ----------------------------------------------------------------------------------------- helpers
def day_of(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def country_of(request: Request | None, lang: str = "") -> str:
    cc = (request.headers.get("cf-ipcountry") if request else "") or ""
    if not re.fullmatch(r"[A-Za-z]{2}", cc) or cc.upper() in ("XX", "T1"):
        m = re.search(r"[-_]([A-Za-z]{2})$", lang or "")
        cc = m.group(1) if m else ""
    return cc.upper()[:2]


def _upsert(c, table, keys: dict, add: dict, set_: dict | None = None) -> None:
    """Adds `add` to the counters of the row with these keys (creates it); portable SQLite / PostgreSQL."""
    name = c.engine.dialect.name
    if name in ("sqlite", "postgresql"):
        mod = __import__(f"sqlalchemy.dialects.{name}", fromlist=["insert"])
        stmt = mod.insert(table).values(**keys, **add, **(set_ or {}))
        upd = {k: table.c[k] + stmt.excluded[k] for k in add}
        upd.update({k: stmt.excluded[k] for k in (set_ or {})})
        c.execute(stmt.on_conflict_do_update(index_elements=list(keys), set_=upd) if upd else stmt.on_conflict_do_nothing(index_elements=list(keys)))
        return
    row = c.execute(select(table).where(*[table.c[k] == v for k, v in keys.items()])).mappings().first()
    if row:
        c.execute(update(table).where(*[table.c[k] == v for k, v in keys.items()]).values(**{k: row[k] + v for k, v in add.items()}, **(set_ or {})))
    else:
        c.execute(insert(table).values(**keys, **add, **(set_ or {})))


def ingest(c, rows: list[dict]) -> int:
    """Stores clean events and updates the roll-ups. rows: {ts, actor, user_id, name, screen, label, value, props, platform, country}."""
    if not rows:
        return 0
    for r in rows:
        r["day"] = day_of(r["ts"])
    c.execute(insert(events), rows)
    agg: dict = defaultdict(lambda: [0, 0.0])
    seen: dict = {}
    for r in rows:
        screen = r["screen"] if r["name"] in ("screen_view", "screen_time") else ""
        k = (r["day"], r["name"], r["platform"], screen)
        agg[k][0] += 1
        agg[k][1] += float(r["value"] or 0)
        seen.setdefault((r["day"], r["actor"]), (r["platform"], r["country"]))
    for (d, n, p, s), (cnt, tot) in agg.items():
        _upsert(c, counters, {"day": d, "name": n, "platform": p, "screen": s}, {"n": cnt, "total": tot})
    for (d, a), (p, cc) in seen.items():
        if p == "server":
            continue
        _upsert(c, actor_days, {"day": d, "actor": a}, {}, {"platform": p, "country": cc})
    return len(rows)


_last_purge = [0.0]


def purge_old(c, now: float | None = None) -> int:
    """Raw events older than RAW_DAYS go; the roll-ups stay (they hold no personal detail beyond the actor id,
    which is removed with the account)."""
    cut = (now or _now()) - RAW_DAYS * 86400
    return c.execute(delete(events).where(events.c.ts < cut)).rowcount or 0


def server_event(uid: str | None, name: str, *, label: str = "", platform: str = "server", request: Request | None = None, props: dict | None = None) -> None:
    """An event from the server itself (sign-ins, server errors). Never fails the request that records it."""
    try:
        with engine().begin() as c:
            ingest(c, [{"ts": _now(), "actor": uid or "server", "user_id": uid, "name": name, "screen": "", "label": label[:200], "value": None,
                        "props": props, "platform": platform, "country": country_of(request)}])
    except Exception:                                                   # noqa: BLE001
        pass


# ----------------------------------------------------------------------------------------- collection
class EventIn(BaseModel):
    name: str = Field(..., max_length=24)
    t: float | None = None                       # ms since epoch on the device (clamped to the last day)
    screen: str = Field("", max_length=40)
    label: str = Field("", max_length=200)
    value: float | None = None
    props: dict | None = None


class BatchIn(BaseModel):
    events: list[EventIn] = Field(..., max_length=MAX_BATCH)
    device: str = Field("", max_length=64)
    token: str = Field("", max_length=200)       # sendBeacon can't send headers, so the sign-in comes in the body
    platform: str = Field("web", max_length=12)
    lang: str = Field("", max_length=16)


@router.post("/events")
async def collect(request: Request, authorization: str = Header("")):
    """Takes a JSON batch (sent as text/plain by sendBeacon, so no preflight is needed)."""
    raw = await request.body()
    if len(raw) > 64_000:
        raise HTTPException(413, "Too many events at once.")
    try:
        body = BatchIn(**json.loads(raw or b"{}"))
    except Exception:                                                   # noqa: BLE001
        raise HTTPException(400, "Bad events.")
    device = re.sub(r"[^A-Za-z0-9_-]", "", body.device)[:36]
    A.rate(request, f"events:{device or A.client_ip(request)}", 120, 3600, "Too many events.")
    user = A.user_from_token(A._token(authorization) or body.token)
    uid = user["id"] if user else None
    actor = uid or (f"d:{device}" if device else "")
    if not actor:
        return {"ok": True, "kept": 0}
    platform = body.platform if body.platform in PLATFORMS - {"server"} else "web"
    cc = country_of(request, body.lang)
    now = _now()
    rows = []
    for e in body.events:
        if e.name not in CLIENT_EVENTS:
            continue
        ts = min(now, max(now - 86400, (e.t / 1000) if e.t else now))
        props = e.props if e.props and len(json.dumps(e.props)) <= 1000 else None
        val = e.value if e.value is None or -1e7 < e.value < 1e7 else None
        rows.append({"ts": ts, "actor": actor, "user_id": uid, "name": e.name, "screen": e.screen.strip()[:40], "label": e.label.strip()[:200],
                     "value": val, "props": props, "platform": platform, "country": cc})
    with engine().begin() as c:
        n = ingest(c, rows)
        if now - _last_purge[0] > 3600:
            _last_purge[0] = now
            purge_old(c, now)
    return {"ok": True, "kept": n}


# ----------------------------------------------------------------------------------------- flags
def bucket(key: str, who: str) -> int:
    return int(hashlib.sha256(f"{key}:{who}".encode()).hexdigest()[:8], 16) % 100


def flags_for(handle: str | None, who: str, staff: bool = False) -> dict:
    with engine().connect() as c:
        rows = {r["key"]: dict(r) for r in c.execute(select(flags)).mappings().all()}
    out = {}
    for k in FLAGS:
        f = rows.get(k)
        if not f:
            out[k] = "on"
            continue
        named = handle and handle.lower() in [str(x).lower().lstrip("@") for x in (f["users"] or [])]
        if f["state"] == "off":
            out[k] = "on" if named else ("staff" if staff else "off")
        else:
            inside = named or bucket(k, who) < f["percent"]
            out[k] = f["state"] if inside else ("staff" if staff else "off")
    return out


@router.get("/flags")
def get_flags(request: Request, authorization: str = Header("")):
    me = A.optional(authorization) if A._token(authorization) else None
    who = me.id if me else (request.headers.get("x-haptune-device") or A.client_ip(request))
    return {"flags": flags_for(me.acc["handle"] if me else None, who, staff=bool(me and me.dev_mode))}


class FlagIn(BaseModel):
    state: str = Field(..., pattern="^(on|off|beta)$")
    percent: int = Field(100, ge=0, le=100)
    users: list[str] = Field(default_factory=list, max_length=200)
    note: str = Field("", max_length=300)


@router.get("/admin/flags")
def admin_flags(me: A.Me = Depends(A.require_scope("feature_flags"))):
    with engine().connect() as c:
        rows = {r["key"]: dict(r) for r in c.execute(select(flags)).mappings().all()}
    return {"items": [{"key": k, "label": lab, **({"state": "on", "percent": 100, "users": [], "note": "", "updated": None}
                                                   | ({kk: rows[k][kk] for kk in ("state", "percent", "users", "note")} | {"updated": _iso(rows[k]["updated"])} if k in rows else {}))}
                      for k, lab in FLAGS.items()]}


@router.post("/admin/flags/{key}")
def admin_set_flag(key: str, body: FlagIn, me: A.Me = Depends(A.require_scope("feature_flags"))):
    if key not in FLAGS:
        raise HTTPException(404, "No such feature.")
    users = [re.sub(r"[^a-z0-9_.]", "", u.lower().lstrip("@"))[:24] for u in body.users if u.strip()]
    with engine().begin() as c:
        old = c.execute(select(flags).where(flags.c.key == key)).mappings().first()
        vals = {"state": body.state, "percent": body.percent, "users": users, "note": body.note.strip(), "updated": _now(), "by": me.id}
        if old:
            c.execute(update(flags).where(flags.c.key == key).values(**vals))
        else:
            c.execute(insert(flags).values(key=key, **vals))
        A.audit(c, me, "feature_flag", None, before={k: old[k] for k in ("state", "percent", "users")} if old else None,
                after={"key": key, "state": body.state, "percent": body.percent, "users": users})
    return {"ok": True}


# ----------------------------------------------------------------------------------------- dashboard
def _days(n: int, end: float | None = None) -> list[str]:
    e = datetime.fromtimestamp(end or _now(), tz=timezone.utc).date()
    return [(e - timedelta(days=i)).isoformat() for i in range(n - 1, -1, -1)]


@router.get("/admin/analytics/overview")
def overview(me: A.Me = Depends(A.require_scope("read_analytics"))):
    t0 = time.perf_counter()
    now = _now()
    d30 = _days(30)
    since = {"today": d30[-1], "7d": d30[-7], "30d": d30[0]}
    acc = A.accounts
    with engine().connect() as c:
        def cnt(name: str, frm: str) -> int:
            return int(c.execute(select(func.coalesce(func.sum(counters.c.n), 0)).where(counters.c.name == name, counters.c.day >= frm)).scalar())

        def total(name: str, frm: str) -> float:
            return float(c.execute(select(func.coalesce(func.sum(counters.c.total), 0)).where(counters.c.name == name, counters.c.day >= frm)).scalar())

        def active(frm: str) -> int:
            return int(c.execute(select(func.count(func.distinct(actor_days.c.actor))).where(actor_days.c.day >= frm)).scalar())

        signups = {k: int(c.execute(select(func.count()).select_from(acc).where(acc.c.created >= (now - {"today": 86400, "7d": 7 * 86400, "30d": 30 * 86400}[k]),
                                                                                  or_(acc.c.google_sub.isnot(None), acc.c.pw_hash.isnot(None)))).scalar()) for k in since}
        sessions_n, sessions_s = cnt("session_end", since["30d"]), total("session_end", since["30d"])
        daily = {r[0]: r[1] for r in c.execute(select(actor_days.c.day, func.count()).where(actor_days.c.day >= d30[0]).group_by(actor_days.c.day)).all()}
        new_daily = {r[0]: r[1] for r in c.execute(select(counters.c.day, func.sum(counters.c.n)).where(counters.c.name == "sign_in", counters.c.day >= d30[0]).group_by(counters.c.day)).all()}
        platforms = Counter({r[0] or "web": r[1] for r in c.execute(select(actor_days.c.platform, func.count(func.distinct(actor_days.c.actor))).where(actor_days.c.day >= d30[0]).group_by(actor_days.c.platform)).all()})
        countries = [{"country": r[0], "people": r[1]} for r in c.execute(select(actor_days.c.country, func.count(func.distinct(actor_days.c.actor)).label("n"))
                                                                              .where(actor_days.c.day >= d30[0], actor_days.c.country != "").group_by(actor_days.c.country).order_by(func.count(func.distinct(actor_days.c.actor)).desc()).limit(8)).all()]
        method = {"google": int(c.execute(select(func.count()).select_from(acc).where(acc.c.google_sub.isnot(None))).scalar()),
                  "password": int(c.execute(select(func.count()).select_from(acc).where(acc.c.google_sub.is_(None), acc.c.pw_hash.isnot(None))).scalar()),
                  "guest": int(c.execute(select(func.count()).select_from(acc).where(acc.c.google_sub.is_(None), acc.c.pw_hash.is_(None))).scalar())}
        practice_min = int(c.execute(select(func.coalesce(func.sum(A.practice_log.c.minutes), 0)).where(A.practice_log.c.day >= since["30d"])).scalar())
        import academy
        import community
        import sounds as S
        stage_posts = int(c.execute(select(func.count()).select_from(community.posts).where(community.posts.c.created >= now - 30 * 86400)).scalar())
        sounds_made = int(c.execute(select(func.count()).select_from(S.sounds).where(S.sounds.c.created >= now - 30 * 86400)).scalar())
        # a class is active when someone handed in work or shared a take with it in the last 30 days
        act = {r[0] for r in c.execute(select(academy.assignments.c.class_id).join(academy.submissions, academy.submissions.c.assignment_id == academy.assignments.c.id)
                                       .where(academy.submissions.c.created >= now - 30 * 86400).distinct()).all()}
        act |= {r[0] for r in c.execute(select(academy.takes.c.class_id).where(academy.takes.c.created >= now - 30 * 86400).distinct()).all()}
        classes_active = len(act)
        classes_total = int(c.execute(select(func.count()).select_from(academy.classes).where(academy.classes.c.archived.is_(False))).scalar())
        # retention: people first seen 31-60 days ago (so D30 has had time), back on day 1 / 7 / 30
        cohort_from, cohort_to = _days(61)[0], _days(31)[0]
        firsts = c.execute(select(actor_days.c.actor, func.min(actor_days.c.day)).group_by(actor_days.c.actor)
                           .having(and_(func.min(actor_days.c.day) >= cohort_from, func.min(actor_days.c.day) <= cohort_to))).all()
        first = {a: d for a, d in firsts}
        signins = {k: cnt("sign_in", v) for k, v in since.items()}
        act = {"dau": active(since["today"]), "wau": active(since["7d"]), "mau": active(since["30d"])}
        played, opened = cnt("play_along_finish", since["30d"]), cnt("piece_open", since["30d"])
        seen = set()
        if first:
            ids = list(first)
            for i in range(0, len(ids), 500):
                seen |= {(a, d) for a, d in c.execute(select(actor_days.c.actor, actor_days.c.day).where(actor_days.c.actor.in_(ids[i:i + 500]))).all()}

    def ret(n: int) -> float | None:
        if not first:
            return None
        back = sum(1 for a, d in first.items() if ((a, (datetime.fromisoformat(d) + timedelta(days=n)).date().isoformat()) in seen))
        return round(100 * back / len(first), 1)

    return {
        "signups": signups,
        "signins": signins, "active": act,
        "avg_session_min": round(sessions_s / sessions_n / 60, 1) if sessions_n else None,
        "practice_minutes": practice_min, "pieces_played": played, "pieces_opened": opened,
        "sounds_made": sounds_made, "stage_posts": stage_posts, "classes": {"active": classes_active, "total": classes_total},
        "retention": {"cohort": len(first), "d1": ret(1), "d7": ret(7), "d30": ret(30)},
        "signin_methods": method, "platforms": dict(platforms), "countries": countries,
        "daily": [{"day": d, "active": daily.get(d, 0), "signins": int(new_daily.get(d, 0) or 0)} for d in d30],
        "ms": round((time.perf_counter() - t0) * 1000),
    }


@router.get("/admin/analytics/activity")
def activity(name: str = "", platform: str = "", handle: str = "", limit: int = 200, me: A.Me = Depends(A.require_scope("read_analytics"))):
    """The last 24 hours, newest first. Who did it is shown only to developers who may also manage users."""
    cond = [events.c.ts >= _now() - 86400]
    if name:
        cond.append(events.c.name == name)
    if platform:
        cond.append(events.c.platform == platform)
    personal = me.is_owner or "manage_users" in me.scopes
    with engine().connect() as c:
        if handle and personal:
            uid = c.execute(select(A.accounts.c.user_id).where(A.accounts.c.handle == handle.lower().lstrip("@"))).scalar()
            cond.append(events.c.user_id == (uid or "-"))
        rows = c.execute(select(events).where(*cond).order_by(events.c.ts.desc()).limit(max(1, min(500, limit)))).mappings().all()
        handles = {}
        if personal:
            ids = list({r["user_id"] for r in rows if r["user_id"]})
            handles = {u: h for u, h in c.execute(select(A.accounts.c.user_id, A.accounts.c.handle).where(A.accounts.c.user_id.in_(ids or ["-"]))).all()}
    return {"items": [{"t": _iso(r["ts"]), "name": r["name"], "screen": r["screen"], "label": r["label"] if r["name"] not in ("error", "server_error") or personal else r["label"][:80],
                       "value": r["value"], "platform": r["platform"], "country": r["country"], "who": handles.get(r["user_id"]) if personal else None} for r in rows],
            "personal": personal}


@router.get("/admin/analytics/funnels")
def funnels(days: int = 30, me: A.Me = Depends(A.require_scope("read_analytics"))):
    since = _now() - max(1, min(180, days)) * 86400
    out = []
    with engine().connect() as c:
        rows = c.execute(select(events.c.actor, events.c.name, events.c.screen, events.c.label, func.min(events.c.ts))
                         .where(events.c.ts >= since, events.c.name.in_(["piece_open", "play_along_start", "play_along_finish", "post_created", "screen_view", "create_export"]))
                         .group_by(events.c.actor, events.c.name, events.c.screen, events.c.label)).all()
        firsts: dict = defaultdict(dict)
        for actor, name, screen, label, ts in rows:
            keys = [name, f"{name}:{screen}" if screen else None, f"{name}:{label}" if label else None]
            for k in filter(None, keys):
                firsts[actor][k] = min(ts, firsts[actor].get(k, ts))
        import community
        req = c.execute(select(community.posts.c.user_id, community.posts.c.status).where(community.posts.c.type == "request", community.posts.c.created >= since)).all()
    for fid, (label, steps) in FUNNELS.items():
        if fid == "stage":
            n = len(req)
            done = sum(1 for _, st in req if st == "done")
            out.append({"id": fid, "label": label, "steps": [{"step": "Request posted", "people": n}, {"step": "Fulfilled", "people": done}]})
            continue
        counts = []
        for i, st in enumerate(steps):
            k = 0
            for actor, f in firsts.items():
                ok, t = True, 0.0
                for s_ in steps[:i + 1]:
                    if s_ not in f or f[s_] < t:
                        ok = False
                        break
                    t = f[s_]
                k += ok
            counts.append({"step": st.replace("_", " "), "people": k})
        out.append({"id": fid, "label": label, "steps": counts})
    return {"days": days, "funnels": out}


@router.get("/admin/analytics/features")
def features(days: int = 30, me: A.Me = Depends(A.require_scope("read_analytics"))):
    frm = _days(max(1, min(180, days)))[0]
    with engine().connect() as c:
        screens = c.execute(select(counters.c.screen, counters.c.name, func.sum(counters.c.n), func.sum(counters.c.total))
                            .where(counters.c.day >= frm, counters.c.name.in_(["screen_view", "screen_time"])).group_by(counters.c.screen, counters.c.name)).all()
        evs = c.execute(select(counters.c.name, func.sum(counters.c.n), func.sum(counters.c.total)).where(counters.c.day >= frm).group_by(counters.c.name)).all()
    by: dict = defaultdict(lambda: {"views": 0, "minutes": 0.0})
    for screen, name, n, tot in screens:
        if name == "screen_view":
            by[screen or "?"]["views"] += int(n)
        else:
            by[screen or "?"]["minutes"] += round(float(tot or 0) / 60, 1)
    return {"screens": sorted([{"screen": k, **v} for k, v in by.items()], key=lambda x: -x["minutes"] - x["views"] / 100),
            "events": [{"name": n, "count": int(k), "total": round(float(t or 0), 1), "unit": EVENTS.get(n, "")} for n, k, t in sorted(evs, key=lambda x: -x[1])]}


@router.get("/admin/analytics/errors")
def errors(days: int = 7, me: A.Me = Depends(A.require_scope("read_analytics"))):
    since = _now() - max(1, min(180, days)) * 86400
    personal = me.is_owner or "manage_users" in me.scopes
    with engine().connect() as c:
        groups = c.execute(select(events.c.name, events.c.label, func.count(), func.count(func.distinct(events.c.actor)), func.max(events.c.ts))
                           .where(events.c.ts >= since, events.c.name.in_(["error", "server_error"]))
                           .group_by(events.c.name, events.c.label).order_by(func.count().desc()).limit(100)).all()
        out = []
        for name, label, n, people, last in groups:
            sample = c.execute(select(events.c.screen, events.c.platform, events.c.props, events.c.user_id).where(events.c.name == name, events.c.label == label, events.c.ts >= since)
                               .order_by(events.c.ts.desc()).limit(5)).mappings().all()
            who = []
            if personal:
                ids = list({s["user_id"] for s in sample if s["user_id"]})
                who = [h for (h,) in c.execute(select(A.accounts.c.handle).where(A.accounts.c.user_id.in_(ids or ["-"]))).all()]
            out.append({"source": "server" if name == "server_error" else "app", "message": label, "count": int(n), "people": int(people), "last": _iso(last),
                        "screens": sorted({s["screen"] for s in sample if s["screen"]}), "platforms": sorted({s["platform"] for s in sample}),
                        "device": (sample[0]["props"] or {}).get("ua", "") if sample else "", "who": who})
    return {"days": days, "items": out}
