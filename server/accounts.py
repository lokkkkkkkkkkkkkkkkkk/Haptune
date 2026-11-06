"""Accounts, plans, credits and notifications: one account per person, shared with Academy classes.

Identity
    Every device gets an account straight away (POST /c/auth/guest, or the older POST /academy/me): no form to
    fill in before practising or browsing the community. Choosing a handle and password (POST /c/auth/password)
    lets the same account sign in on other devices, such as a PC (POST /c/auth/login). A recovery code, shown
    once, resets a forgotten password.

Plans (see PLANS)
    Free covers everything that costs the developer nothing to run: practice, playback, imports, the basic
    (non-AI) scanner and the whole community. Features that call the paid AI API (reading sheet music with AI,
    finding songs online, the Hapi tutor) need Plus or Pro, each with a monthly allowance, so no plan can cost
    more to run than it earns. The developer account (role "admin") has no limits.
    Purchases are made in the store (Google Play now, the App Store later) through RevenueCat, which tells this
    server which plan an account has (POST /c/billing/sync, or its webhook). Credits never turn into money.

Credits
    Earned by helping (community.py), practising and challenges; spent on request rewards, spotlights and
    "a week of Plus". They are an extra: nothing in the app needs credits to be used.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import urllib.request
import uuid
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import JSON, Boolean, Column, Float, ForeignKey, Integer, String, Table, Text, case, delete, func, insert, select, update

from academy import COLORS, _hash, _iso, _now, engine, meta, sessions, users

router = APIRouter(prefix="/c", tags=["accounts"])

accounts = Table("accounts", meta,
                 Column("user_id", String(36), ForeignKey("users.id"), primary_key=True),
                 Column("handle", String(24), unique=True, nullable=False),
                 Column("pw_hash", String(200), nullable=True),
                 Column("recovery_hash", String(64), nullable=True),
                 Column("role", String(12), nullable=False, default="user"),     # user | admin | banned
                 Column("tier", String(8), nullable=False, default="free"),       # free | plus | pro
                 Column("tier_until", Float, nullable=True),
                 Column("tier_source", String(16), nullable=False, default=""),   # store | grant | credits
                 Column("credits", Integer, nullable=False, default=0),
                 Column("avatar", JSON, nullable=True),
                 Column("instruments", JSON, nullable=True),
                 Column("level", String(16), nullable=False, default=""),
                 Column("bio", String(300), nullable=False, default=""),
                 Column("lang", String(10), nullable=False, default="en"),
                 Column("guidelines", Boolean, nullable=False, default=False),
                 Column("streak", Integer, nullable=False, default=0),
                 Column("last_day", String(10), nullable=True),
                 Column("bonus_month", String(7), nullable=True),
                 Column("plus_redeemed", Float, nullable=True),
                 Column("created", Float, nullable=False),
                 Column("last_seen", Float, nullable=False))
ledger = Table("ledger", meta,
               Column("id", Integer, primary_key=True, autoincrement=True),
               Column("user_id", String(36), ForeignKey("users.id"), nullable=False, index=True),
               Column("delta", Integer, nullable=False),
               Column("reason", String(24), nullable=False),
               Column("minted", Boolean, nullable=False, default=False),   # made by Haptune (not moved between people)
               Column("ref", String(40), nullable=False, default=""),
               Column("note", String(160), nullable=False, default=""),
               Column("created", Float, nullable=False, index=True))
usage = Table("usage", meta,
              Column("user_id", String(36), primary_key=True),
              Column("kind", String(12), primary_key=True),
              Column("period", String(7), primary_key=True),
              Column("used", Integer, nullable=False, default=0))
practice_log = Table("practice_log", meta,
                     Column("user_id", String(36), primary_key=True),
                     Column("day", String(10), primary_key=True),
                     Column("minutes", Integer, nullable=False, default=0))
notifications = Table("notifications", meta,
                      Column("id", Integer, primary_key=True, autoincrement=True),
                      Column("user_id", String(36), nullable=False, index=True),
                      Column("kind", String(16), nullable=False),
                      Column("actor_id", String(36), nullable=True),
                      Column("post_id", String(16), nullable=True),
                      Column("data", JSON, nullable=True),
                      Column("read", Boolean, nullable=False, default=False),
                      Column("created", Float, nullable=False))
app_feedback = Table("app_feedback", meta,
                     Column("id", String(16), primary_key=True),
                     Column("user_id", String(36), nullable=True),
                     Column("device", String(64), nullable=False, default=""),
                     Column("category", String(16), nullable=False),
                     Column("message", Text, nullable=False),
                     Column("contact", String(120), nullable=False, default=""),
                     Column("diagnostics", JSON, nullable=True),
                     Column("status", String(12), nullable=False, default="new"),
                     Column("admin_note", Text, nullable=False, default=""),
                     Column("created", Float, nullable=False))
kv = Table("kv", meta, Column("k", String(64), primary_key=True), Column("v", Text, nullable=False))

# ----------------------------------------------------------------------------------------------- plans
# Monthly allowances. read_pages / find / tutor call the paid AI API, so the free plan has none of them
# (override with HAPTUNE_PLANS_JSON, e.g. {"free": {"tutor": 3}} to give free users a taste).
# Costs per use with the models set in fly.toml (measured, see README): a page about $0.01-0.05,
# a search about $0.05-0.30, a tutor answer well under $0.01. At these allowances even a member who uses
# everything every month costs less than the plan earns after the store's 15%.
PLANS = {
    "free": {"read_pages": 0, "find": 0, "tutor": 0, "open_requests": 3, "monthly_credits": 0, "spotlights": 0},
    "plus": {"read_pages": 30, "find": 15, "tutor": 300, "open_requests": 10, "monthly_credits": 100, "spotlights": 1},
    "pro": {"read_pages": 120, "find": 50, "tutor": 1500, "open_requests": 30, "monthly_credits": 300, "spotlights": 4},
}
try:
    for _tier, _over in json.loads(os.environ.get("HAPTUNE_PLANS_JSON") or "{}").items():
        if _tier in PLANS and isinstance(_over, dict):
            PLANS[_tier].update({k: int(v) for k, v in _over.items() if k in PLANS[_tier]})
except (ValueError, TypeError):
    pass
# Shown in the app before the store answers with the local price. The store prices are set in the
# Play Console / App Store Connect; these are the suggested ones.
PRICES = {
    "plus": {"monthly": {"usd": "3.99", "myr": "14.90"}, "yearly": {"usd": "24.99", "myr": "99.90"}},
    "pro": {"monthly": {"usd": "7.99", "myr": "29.90"}, "yearly": {"usd": "59.99", "myr": "229.90"}},
}
AI_KINDS = ("read_pages", "find", "tutor")
TIER_RANK = {"free": 0, "plus": 1, "pro": 2, "dev": 3}

RULES = {                               # the credit economy, shown to people in the app (Community > Credits)
    "welcome": 100,
    "daily_practice": 5, "daily_practice_minutes": 5, "streak_week": 20,
    "plus_week_cost": 1500, "plus_week_every_days": 30,
}

ADMIN_HANDLES = {h.strip().lower() for h in os.environ.get("HAPTUNE_ADMINS", "").split(",") if h.strip()}
RESERVED = {"admin", "administrator", "haptune", "hapi", "support", "help", "moderator", "mod", "official", "system",
            "deleted", "staff", "root", "api", "me", "null", "undefined"}
HANDLE_RE = re.compile(r"^[a-z][a-z0-9_.]{2,19}$")
GHOST_ID = "00000000-0000-0000-0000-000000000000"


class _Limiter:
    def __init__(self):
        self.hits: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def allow(self, key: str, limit: int, window: float) -> bool:
        now = time.time()
        with self.lock:
            q = self.hits[key]
            while q and now - q[0] > window:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(now)
            return True


limiter = _Limiter()


def client_ip(request: Request) -> str:
    return (request.headers.get("fly-client-ip") or (request.client.host if request.client else "") or "?").strip()


def rate(request: Request, key: str, limit: int, window: float, message: str = "Too many tries. Please wait a little.") -> None:
    if not limiter.allow(f"{key}:{client_ip(request)}", limit, window):
        raise HTTPException(429, message)


def month() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def new_id(n: int = 12) -> str:
    return uuid.uuid4().hex[:n]


# ----------------------------------------------------------------------------------------------- passwords
def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$16384$8$1$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(h).decode()


def check_password(pw: str, stored: str | None) -> bool:
    try:
        _, n, r, p, salt, h = (stored or "").split("$")
        got = hashlib.scrypt(pw.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(got, base64.b64decode(h))
    except (ValueError, TypeError):
        return False


# ----------------------------------------------------------------------------------------------- accounts
def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]", "", (name or "").lower())[:12]
    return s if s and s[0].isalpha() else "player"


def ensure_account(c, user: dict) -> dict:
    """The account row of an identity, made (with the welcome credits) the first time."""
    row = c.execute(select(accounts).where(accounts.c.user_id == user["id"])).mappings().first()
    if row:
        return dict(row)
    base = _slug(user.get("name", ""))
    for _ in range(40):
        handle = f"{base}{secrets.randbelow(9000) + 1000}"
        if not c.execute(select(accounts.c.user_id).where(accounts.c.handle == handle)).first():
            break
    now = _now()
    c.execute(insert(accounts).values(user_id=user["id"], handle=handle, credits=RULES["welcome"], created=now, last_seen=now,
                                      avatar={"color": user.get("color") or "purple"}, instruments=[]))
    c.execute(insert(ledger).values(user_id=user["id"], delta=RULES["welcome"], reason="welcome", minted=True, created=now))
    return dict(c.execute(select(accounts).where(accounts.c.user_id == user["id"])).mappings().first())


def effective_tier(acc: dict | None) -> str:
    if not acc:
        return "free"
    if acc.get("role") == "admin" or acc.get("handle", "").lower() in ADMIN_HANDLES:
        return "dev"
    t = acc.get("tier") or "free"
    if t != "free" and acc.get("tier_until") and acc["tier_until"] < _now():
        return "free"
    return t if t in PLANS else "free"


def plan_limits(tier: str) -> dict:
    if tier == "dev":
        return {k: None for k in PLANS["pro"]}                   # no limits for the developer
    return dict(PLANS.get(tier, PLANS["free"]))


def user_from_token(token: str) -> dict | None:
    if not token:
        return None
    h = _hash(token)
    with engine().connect() as c:
        row = c.execute(select(users).where(users.c.token_hash == h)).mappings().first()
        if row is None:
            uid = c.execute(select(sessions.c.user_id).where(sessions.c.token_hash == h)).scalar()
            if uid:
                row = c.execute(select(users).where(users.c.id == uid)).mappings().first()
                c.execute(update(sessions).where(sessions.c.token_hash == h).values(last_seen=_now()))
                c.commit()
    return dict(row) if row else None


class Me:
    """The signed-in person: identity (users row) + account."""

    def __init__(self, user: dict, acc: dict):
        self.user, self.acc = user, acc
        self.id = user["id"]
        self.tier = effective_tier(acc)

    @property
    def is_admin(self) -> bool:
        return self.tier == "dev"


def _token(authorization: str) -> str:
    return (authorization or "").removeprefix("Bearer ").strip()


def current(authorization: str = Header("")) -> Me:
    user = user_from_token(_token(authorization))
    if user is None:
        raise HTTPException(401, "Please open Haptune online once to make your account.")
    with engine().begin() as c:
        acc = ensure_account(c, user)
        if acc["role"] == "banned":
            raise HTTPException(403, "This account can no longer use the community.")
        c.execute(update(accounts).where(accounts.c.user_id == user["id"]).values(last_seen=_now()))
        _monthly_bonus(c, acc)
    return Me(user, acc)


def reload(uid: str) -> Me:
    with engine().connect() as c:
        user = dict(c.execute(select(users).where(users.c.id == uid)).mappings().first())
        acc = dict(c.execute(select(accounts).where(accounts.c.user_id == uid)).mappings().first())
    return Me(user, acc)


def optional(authorization: str = Header("")) -> Me | None:
    try:
        return current(authorization)
    except HTTPException:
        return None


def require_admin(me: Me = Depends(current)) -> Me:
    if not me.is_admin:
        raise HTTPException(403, "Only the developer can do that.")
    return me


def grant(c, uid: str, delta: int, reason: str, *, minted: bool = True, ref: str = "", note: str = "") -> int:
    """Changes a balance and writes the ledger line. Raises 402 when a spend is more than the balance."""
    bal = c.execute(select(accounts.c.credits).where(accounts.c.user_id == uid)).scalar() or 0
    if delta < 0 and bal + delta < 0:
        raise HTTPException(402, {"code": "credits", "message": "Not enough credits.", "credits": bal})
    c.execute(update(accounts).where(accounts.c.user_id == uid).values(credits=bal + delta))
    c.execute(insert(ledger).values(user_id=uid, delta=delta, reason=reason, minted=minted, ref=ref, note=note[:160], created=_now()))
    return bal + delta


def notify(c, uid: str, kind: str, *, actor: str | None = None, post: str | None = None, **data) -> None:
    if uid and uid != actor and uid != GHOST_ID:
        c.execute(insert(notifications).values(user_id=uid, kind=kind, actor_id=actor, post_id=post, data=data or None, created=_now()))


def _monthly_bonus(c, acc: dict) -> None:
    tier = effective_tier(acc)
    n = PLANS.get(tier, {}).get("monthly_credits", 0) if tier != "dev" else 0
    if n and acc.get("bonus_month") != month():
        c.execute(update(accounts).where(accounts.c.user_id == acc["user_id"]).values(bonus_month=month()))
        grant(c, acc["user_id"], n, "plan_bonus", note=f"{tier} {month()}")
        notify(c, acc["user_id"], "credits", amount=n, reason="plan_bonus")


def usage_of(c, uid: str, tier: str) -> dict:
    rows = c.execute(select(usage.c.kind, usage.c.used).where(usage.c.user_id == uid, usage.c.period == month())).all()
    used = {k: u for k, u in rows}
    lim = plan_limits(tier)
    return {k: {"used": used.get(k, 0), "limit": lim.get(k)} for k in AI_KINDS}


def _avatar(acc: dict, user: dict) -> dict:
    a = dict(acc.get("avatar") or {})
    a.setdefault("color", user.get("color") or "purple")
    return a


def public_user(user: dict, acc: dict | None) -> dict:
    """What anyone may see about a person."""
    acc = acc or {}
    tier = effective_tier(acc) if acc else "free"
    return {"id": user["id"], "handle": acc.get("handle", ""), "name": user.get("name") or "Musician",
            "avatar": _avatar(acc, user), "instruments": acc.get("instruments") or [], "level": acc.get("level", ""),
            "badge": "dev" if tier == "dev" else tier if tier in ("plus", "pro") else None}


def me_json(me: Me) -> dict:
    with engine().connect() as c:
        acc = dict(c.execute(select(accounts).where(accounts.c.user_id == me.id)).mappings().first())
        unread = c.execute(select(func.count()).select_from(notifications).where(notifications.c.user_id == me.id, notifications.c.read.is_(False))).scalar()
        u = usage_of(c, me.id, me.tier)
        n_sessions = c.execute(select(func.count()).select_from(sessions).where(sessions.c.user_id == me.id)).scalar()
    return {**public_user(me.user, acc), "bio": acc["bio"], "lang": acc["lang"], "role": acc["role"], "is_admin": me.is_admin,
            "tier": me.tier, "tier_until": _iso(acc["tier_until"]) if me.tier not in ("free", "dev") else None,
            "tier_source": acc["tier_source"], "credits": acc["credits"], "streak": acc["streak"], "usage": u,
            "limits": plan_limits(me.tier), "unread": unread, "guidelines": acc["guidelines"], "has_password": bool(acc["pw_hash"]),
            "devices": n_sessions + 1, "joined": _iso(acc["created"])}


def _new_identity(c, name: str) -> tuple[dict, str]:
    token = secrets.token_urlsafe(32)
    uid = str(uuid.uuid4())
    name = (name or "").strip()[:60] or "Musician"
    color = COLORS[int(hashlib.md5(uid.encode()).hexdigest(), 16) % len(COLORS)]
    c.execute(insert(users).values(id=uid, token_hash=_hash(token), name=name, color=color, created=_now()))
    return {"id": uid, "name": name, "color": color}, token


# ----------------------------------------------------------------------------------------------- endpoints
class GuestIn(BaseModel):
    name: str = Field("", max_length=60)


@router.post("/auth/guest")
def guest(body: GuestIn, request: Request):
    """A new account for this device, no questions asked (it can get a password later)."""
    rate(request, "guest", 20, 86400, "Too many new accounts from this network today.")
    with engine().begin() as c:
        user, token = _new_identity(c, body.name)
        ensure_account(c, user)
    me = current(f"Bearer {token}")
    return {"token": token, "me": me_json(me)}


@router.get("/me")
def get_me(me: Me = Depends(current)):
    return me_json(me)


class MeIn(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=60)
    handle: str | None = Field(None, max_length=24)
    avatar: dict | None = None
    instruments: list[str] | None = None
    level: str | None = Field(None, max_length=16)
    bio: str | None = Field(None, max_length=300)
    lang: str | None = Field(None, max_length=10)
    guidelines: bool | None = None


def _check_handle(c, handle: str, uid: str) -> str:
    h = (handle or "").strip().lower().lstrip("@")
    if not HANDLE_RE.match(h):
        raise HTTPException(400, "A username is 3-20 letters, numbers, dots or underscores, starting with a letter.")
    if h in RESERVED:
        raise HTTPException(400, "That username is reserved.")
    other = c.execute(select(accounts.c.user_id).where(accounts.c.handle == h)).scalar()
    if other and other != uid:
        raise HTTPException(409, "That username is taken.")
    return h


@router.patch("/me")
def patch_me(body: MeIn, me: Me = Depends(current)):
    from community import clean_text
    vals = {}
    with engine().begin() as c:
        if body.name is not None:
            c.execute(update(users).where(users.c.id == me.id).values(name=clean_text(body.name, 60)))
        if body.handle is not None:
            vals["handle"] = _check_handle(c, body.handle, me.id)
        if body.avatar is not None:
            vals["avatar"] = {k: str(v)[:24] for k, v in list(body.avatar.items())[:6]}
        if body.instruments is not None:
            vals["instruments"] = [str(x)[:24] for x in body.instruments[:6]]
        if body.level is not None:
            vals["level"] = body.level if body.level in ("", "beginner", "intermediate", "advanced", "teacher") else ""
        if body.bio is not None:
            vals["bio"] = clean_text(body.bio, 300)
        if body.lang is not None:
            vals["lang"] = body.lang
        if body.guidelines:
            vals["guidelines"] = True
        if vals:
            c.execute(update(accounts).where(accounts.c.user_id == me.id).values(**vals))
    return me_json(reload(me.id))


class PasswordIn(BaseModel):
    handle: str = Field(..., max_length=24)
    password: str = Field(..., min_length=8, max_length=200)


@router.post("/auth/password")
def set_password(body: PasswordIn, me: Me = Depends(current)):
    """Choose a username and password, so this account can also sign in on other devices."""
    code = "-".join(secrets.token_hex(2).upper() for _ in range(4))
    with engine().begin() as c:
        handle = _check_handle(c, body.handle, me.id)
        c.execute(update(accounts).where(accounts.c.user_id == me.id).values(
            handle=handle, pw_hash=hash_password(body.password), recovery_hash=_hash(code.replace("-", ""))))
    return {"handle": handle, "recovery_code": code}


class LoginIn(BaseModel):
    handle: str = Field(..., max_length=24)
    password: str = Field(..., max_length=200)
    device: str = Field("", max_length=60)


def _session(c, uid: str, label: str) -> str:
    token = secrets.token_urlsafe(32)
    c.execute(insert(sessions).values(token_hash=_hash(token), user_id=uid, label=label[:60], created=_now(), last_seen=_now()))
    return token


@router.post("/auth/login")
def login(body: LoginIn, request: Request):
    h = body.handle.strip().lower().lstrip("@")
    rate(request, f"login:{h}", 10, 900)
    with engine().begin() as c:
        acc = c.execute(select(accounts).where(accounts.c.handle == h)).mappings().first()
        if not acc or not check_password(body.password, acc["pw_hash"]):
            raise HTTPException(401, "That username and password don't match.")
        token = _session(c, acc["user_id"], body.device)
    return {"token": token, "me": me_json(current(f"Bearer {token}"))}


class RecoverIn(BaseModel):
    handle: str = Field(..., max_length=24)
    code: str = Field(..., max_length=40)
    password: str = Field(..., min_length=8, max_length=200)


@router.post("/auth/recover")
def recover(body: RecoverIn, request: Request):
    h = body.handle.strip().lower().lstrip("@")
    rate(request, f"recover:{h}", 8, 3600)
    code = re.sub(r"[^0-9A-Fa-f]", "", body.code).upper()
    new_code = "-".join(secrets.token_hex(2).upper() for _ in range(4))
    with engine().begin() as c:
        acc = c.execute(select(accounts).where(accounts.c.handle == h)).mappings().first()
        if not acc or not acc["recovery_hash"] or not hmac.compare_digest(acc["recovery_hash"], _hash(code)):
            raise HTTPException(401, "That recovery code doesn't match.")
        c.execute(update(accounts).where(accounts.c.user_id == acc["user_id"]).values(
            pw_hash=hash_password(body.password), recovery_hash=_hash(new_code.replace("-", ""))))
        token = _session(c, acc["user_id"], "recovered")
    return {"token": token, "recovery_code": new_code, "me": me_json(current(f"Bearer {token}"))}


@router.post("/auth/logout")
def logout(authorization: str = Header("")):
    with engine().begin() as c:
        c.execute(delete(sessions).where(sessions.c.token_hash == _hash(_token(authorization))))
    return {"ok": True}


@router.delete("/me")
def delete_me(me: Me = Depends(current)):
    """Deletes the account: profile, sign-ins, notifications and credits go; posts stay as 'Deleted user' so
    threads still read sensibly (Google Play and the App Store ask for this to be possible in the app)."""
    from community import forget_user
    with engine().begin() as c:
        forget_user(c, me.id)
        for t in (notifications, practice_log, usage, ledger):
            c.execute(delete(t).where(t.c.user_id == me.id))
        c.execute(delete(sessions).where(sessions.c.user_id == me.id))
        c.execute(delete(accounts).where(accounts.c.user_id == me.id))
        c.execute(update(users).where(users.c.id == me.id).values(name="Deleted user", token_hash=_hash(secrets.token_hex(16)),
                                                                    link_code=None, link_expires=None))
    return {"deleted": True}


class DevIn(BaseModel):
    code: str = Field(..., min_length=8, max_length=200)


@router.post("/me/dev")
def claim_dev(body: DevIn, request: Request, me: Me = Depends(current)):
    """The developer unlocks everything on their own account with the code in HAPTUNE_ADMIN_CODE."""
    rate(request, "dev", 5, 3600)
    want = os.environ.get("HAPTUNE_ADMIN_CODE", "")
    if len(want) < 12 or not hmac.compare_digest(want, body.code.strip()):
        raise HTTPException(403, "That code isn't right.")
    with engine().begin() as c:
        c.execute(update(accounts).where(accounts.c.user_id == me.id).values(role="admin"))
    return me_json(reload(me.id))


@router.get("/plans")
def plans():
    return {"plans": PLANS, "prices": PRICES, "rules": RULES, "revenuecat": bool(os.environ.get("REVENUECAT_SECRET"))}


# ----------------------------------------------------------------------------------------------- AI allowances
def ai_user(request: Request) -> Me | None:
    try:
        return current(request.headers.get("authorization", ""))
    except HTTPException:
        return None


def charge_ai(request: Request, kind: str, amount: int = 1) -> Me | None:
    """Counts `amount` uses of an AI feature against the month's allowance, or explains why it can't run.
    402 = the plan doesn't include it (the app shows the plans); 429 = this month's allowance is used up."""
    me = ai_user(request)
    tier = me.tier if me else "free"
    limit = plan_limits(tier).get(kind)
    names = {"read_pages": "Reading music with AI", "find": "Finding songs online", "tutor": "Hapi the tutor"}
    if limit == 0:
        raise HTTPException(402, {"code": "plan_required", "feature": kind, "tier": tier,
                                  "message": f"{names.get(kind, kind)} is part of Haptune Plus."})
    if me is None or limit is None:
        return me
    with engine().begin() as c:
        row = c.execute(select(usage.c.used).where(usage.c.user_id == me.id, usage.c.kind == kind, usage.c.period == month())).scalar()
        used = row or 0
        if used + amount > limit:
            raise HTTPException(429, {"code": "plan_limit", "feature": kind, "tier": tier, "limit": limit, "used": used,
                                      "message": f"You've used this month's {names.get(kind, kind).lower()} ({limit}). It refills on the 1st."})
        if row is None:
            c.execute(insert(usage).values(user_id=me.id, kind=kind, period=month(), used=amount))
        else:
            c.execute(update(usage).where(usage.c.user_id == me.id, usage.c.kind == kind, usage.c.period == month()).values(used=used + amount))
    return me


def refund_ai(me: Me | None, kind: str, amount: int = 1) -> None:
    if me is None:
        return
    with engine().begin() as c:
        c.execute(update(usage).where(usage.c.user_id == me.id, usage.c.kind == kind, usage.c.period == month())
                  .values(used=case((usage.c.used > amount, usage.c.used - amount), else_=0)))


# ----------------------------------------------------------------------------------------------- store purchases
def _revenuecat_tier(app_user_id: str) -> tuple[str, float | None] | None:
    """Asks RevenueCat which plan this account has paid for: ('plus'|'pro'|'free', expiry)."""
    key = os.environ.get("REVENUECAT_SECRET", "")
    if not key:
        return None
    req = urllib.request.Request(f"https://api.revenuecat.com/v1/subscribers/{app_user_id}",
                                 headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.load(r)
    best, until = "free", None
    for name, ent in (data.get("subscriber", {}).get("entitlements") or {}).items():
        tier = "pro" if "pro" in name.lower() else "plus" if "plus" in name.lower() else None
        if not tier:
            continue
        exp = ent.get("expires_date")
        t = datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp() if exp else None
        if t is None or t > _now():
            if TIER_RANK[tier] > TIER_RANK[best]:
                best, until = tier, t
    return best, until


def sync_store(uid: str) -> str:
    got = _revenuecat_tier(uid)
    if got is None:
        raise HTTPException(503, "Purchases aren't connected on this server yet.")
    tier, until = got
    with engine().begin() as c:
        acc = c.execute(select(accounts).where(accounts.c.user_id == uid)).mappings().first()
        if acc is None:
            raise HTTPException(404, "No such account.")
        if tier != "free":
            c.execute(update(accounts).where(accounts.c.user_id == uid).values(tier=tier, tier_until=until, tier_source="store"))
        elif acc["tier_source"] == "store":
            c.execute(update(accounts).where(accounts.c.user_id == uid).values(tier="free", tier_until=None, tier_source=""))
    return tier


@router.post("/billing/sync")
def billing_sync(request: Request, me: Me = Depends(current)):
    rate(request, "billing", 30, 3600)
    sync_store(me.id)
    return me_json(reload(me.id))


@router.post("/billing/revenuecat")
async def revenuecat_webhook(request: Request, authorization: str = Header("")):
    want = os.environ.get("REVENUECAT_WEBHOOK_AUTH", "")
    if not want or not hmac.compare_digest(want, authorization):
        raise HTTPException(401, "Not allowed.")
    body = await request.json()
    uid = (body.get("event") or {}).get("app_user_id") or ""
    if re.fullmatch(r"[0-9a-f-]{36}", uid):
        sync_store(uid)
    return {"ok": True}


# ----------------------------------------------------------------------------------------------- credits
@router.get("/wallet")
def wallet(me: Me = Depends(current)):
    with engine().connect() as c:
        rows = c.execute(select(ledger).where(ledger.c.user_id == me.id).order_by(ledger.c.id.desc()).limit(60)).mappings().all()
        bal = c.execute(select(accounts.c.credits, accounts.c.plus_redeemed).where(accounts.c.user_id == me.id)).first()
    from community import REWARDS
    return {"credits": bal[0], "plus_week_available": not bal[1] or bal[1] < _now() - RULES["plus_week_every_days"] * 86400,
            "history": [{"delta": r["delta"], "reason": r["reason"], "ref": r["ref"], "note": r["note"], "at": _iso(r["created"])} for r in rows],
            "rules": {**RULES, **REWARDS}}


@router.post("/credits/plus-week")
def plus_week(me: Me = Depends(current)):
    """Top helpers can turn credits into a week of Plus (once a month)."""
    if me.tier in ("pro", "dev"):
        raise HTTPException(400, "Your plan already includes Plus.")
    with engine().begin() as c:
        acc = c.execute(select(accounts).where(accounts.c.user_id == me.id)).mappings().first()
        if acc["plus_redeemed"] and acc["plus_redeemed"] > _now() - RULES["plus_week_every_days"] * 86400:
            raise HTTPException(429, "You can do this once a month.")
        grant(c, me.id, -RULES["plus_week_cost"], "plus_week", minted=False)
        start = max(_now(), acc["tier_until"] or 0) if acc["tier"] == "plus" else _now()
        c.execute(update(accounts).where(accounts.c.user_id == me.id).values(
            tier="plus", tier_until=start + 7 * 86400, tier_source=acc["tier_source"] if acc["tier"] == "plus" and acc["tier_source"] == "store" else "credits",
            plus_redeemed=_now()))
    return me_json(reload(me.id))


# ----------------------------------------------------------------------------------------------- practice
class PracticeIn(BaseModel):
    minutes: float = Field(..., ge=0, le=240)


@router.post("/practice")
def log_practice(body: PracticeIn, me: Me = Depends(current)):
    """Practice time from the app: daily credits and the streak (a week in a row earns a bonus)."""
    day = today()
    m = int(round(body.minutes))
    out = {"credits": 0, "streak": me.acc["streak"]}
    with engine().begin() as c:
        row = c.execute(select(practice_log.c.minutes).where(practice_log.c.user_id == me.id, practice_log.c.day == day)).scalar()
        before = row or 0
        total = min(600, before + m)
        if row is None:
            c.execute(insert(practice_log).values(user_id=me.id, day=day, minutes=total))
        else:
            c.execute(update(practice_log).where(practice_log.c.user_id == me.id, practice_log.c.day == day).values(minutes=total))
        if before < RULES["daily_practice_minutes"] <= total:
            acc = c.execute(select(accounts).where(accounts.c.user_id == me.id)).mappings().first()
            yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
            streak = acc["streak"] + 1 if acc["last_day"] == yesterday else 1 if acc["last_day"] != day else acc["streak"]
            c.execute(update(accounts).where(accounts.c.user_id == me.id).values(streak=streak, last_day=day))
            n = RULES["daily_practice"] + (RULES["streak_week"] if streak % 7 == 0 else 0)
            grant(c, me.id, n, "practice", note=f"{streak}-day streak")
            out = {"credits": n, "streak": streak}
    return out


# ----------------------------------------------------------------------------------------------- notifications
@router.get("/notifications")
def list_notifications(me: Me = Depends(current), limit: int = 40):
    from community import posts as posts_t
    with engine().connect() as c:
        rows = c.execute(select(notifications).where(notifications.c.user_id == me.id).order_by(notifications.c.id.desc()).limit(min(limit, 100))).mappings().all()
        actors = {r["actor_id"] for r in rows if r["actor_id"]}
        people = {}
        if actors:
            for u in c.execute(select(users, accounts).join(accounts, accounts.c.user_id == users.c.id, isouter=True).where(users.c.id.in_(actors))).mappings().all():
                people[u["id"]] = public_user(dict(u), dict(u) if u["handle"] else None)
        pids = {r["post_id"] for r in rows if r["post_id"]}
        titles = dict(c.execute(select(posts_t.c.id, posts_t.c.title).where(posts_t.c.id.in_(pids))).all()) if pids else {}
    return {"items": [{"id": r["id"], "kind": r["kind"], "actor": people.get(r["actor_id"]), "post_id": r["post_id"],
                       "post_title": titles.get(r["post_id"]), "data": r["data"] or {}, "read": r["read"], "at": _iso(r["created"])} for r in rows]}


class ReadIn(BaseModel):
    ids: list[int] | None = None


@router.post("/notifications/read")
def read_notifications(body: ReadIn, me: Me = Depends(current)):
    with engine().begin() as c:
        q = update(notifications).where(notifications.c.user_id == me.id)
        if body.ids:
            q = q.where(notifications.c.id.in_(body.ids[:200]))
        c.execute(q.values(read=True))
    return {"ok": True}


# ----------------------------------------------------------------------------------------------- feedback
class FeedbackIn(BaseModel):
    category: str = Field(..., max_length=16)
    message: str = Field(..., min_length=3, max_length=4000)
    contact: str = Field("", max_length=120)
    diagnostics: dict | None = None


@router.post("/feedback")
def send_feedback(body: FeedbackIn, request: Request, authorization: str = Header("")):
    """Problem reports and ideas from inside the app; the developer reads them in the app's admin panel."""
    rate(request, "feedback", 12, 86400, "Thanks! You've sent a lot today; please try again tomorrow.")
    user = user_from_token(_token(authorization))
    diag = body.diagnostics or {}
    if len(json.dumps(diag)) > 20000:
        diag = {"note": "diagnostics too large"}
    with engine().begin() as c:
        c.execute(insert(app_feedback).values(
            id=new_id(), user_id=user["id"] if user else None, device=(request.headers.get("x-haptune-device") or "")[:64],
            category=body.category if body.category in ("bug", "idea", "question", "content", "billing", "other") else "other",
            message=body.message.strip(), contact=body.contact.strip(), diagnostics=diag, created=_now()))
    return {"ok": True}
