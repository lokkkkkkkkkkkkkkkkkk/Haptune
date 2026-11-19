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
import urllib.parse
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
                 Column("pass_days", Integer, nullable=True),                  # length of a pass bought with Notes
                 Column("stripe_customer", String(40), nullable=True),
                 Column("stripe_sub", String(40), nullable=True),
                 Column("google_sub", String(64), nullable=True, index=True),   # Sign in with Google (the Google account id)
                 Column("apple_sub", String(64), nullable=True, index=True),    # Sign in with Apple (signin.py)
                 Column("email", String(200), nullable=True),                    # from Google, shown only to the person
                 Column("hub_role", String(10), nullable=False, default=""),     # teacher | student | "" (Learn asks once)
                 Column("totp_secret", String(300), nullable=True),             # 2-step verification (encrypted when HAPTUNE_TOKEN_KEY is set)
                 Column("totp_on", Boolean, nullable=False, default=False),
                 Column("totp_recovery", JSON, nullable=True),                  # hashes of unused recovery codes
                 Column("totp_last_step", Integer, nullable=True),              # a code works once
                 Column("created", Float, nullable=False),
                 Column("last_seen", Float, nullable=False))
ledger = Table("ledger", meta,
               Column("id", Integer, primary_key=True, autoincrement=True),
               Column("user_id", String(36), ForeignKey("users.id"), nullable=False, index=True),
               Column("delta", Integer, nullable=False),
               Column("reason", String(24), nullable=False),
               Column("minted", Boolean, nullable=False, default=False),   # made by Melovyn (not moved between people)
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
                      Column("kind", String(32), nullable=False),
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
# Staff. The owner is set only by HAPTUNE_OWNER_EMAILS; developers are granted by the owner with scopes and an end date.
dev_grants = Table("dev_grants", meta,
                   Column("user_id", String(36), primary_key=True),
                   Column("scopes", JSON, nullable=False),
                   Column("expires", Float, nullable=True),
                   Column("reason", String(300), nullable=False, default=""),
                   Column("granted_by", String(36), nullable=False),
                   Column("created", Float, nullable=False))
# Developer mode is switched on per sign-in (one device), with a 2-step code, for a few hours.
elevations = Table("elevations", meta,
                   Column("token_hash", String(64), primary_key=True),
                   Column("user_id", String(36), nullable=False, index=True),
                   Column("until", Float, nullable=False),
                   Column("created", Float, nullable=False))
# Every staff action, append-only (no endpoint changes or deletes rows).
audit_log = Table("audit_log", meta,
                  Column("id", Integer, primary_key=True, autoincrement=True),
                  Column("actor", String(36), nullable=False, index=True),
                  Column("action", String(40), nullable=False, index=True),
                  Column("target", String(36), nullable=True, index=True),
                  Column("before", JSON, nullable=True),
                  Column("after", JSON, nullable=True),
                  Column("note", String(500), nullable=False, default=""),
                  Column("created", Float, nullable=False, index=True))

# ----------------------------------------------------------------------------------------------- plans
# Features that call the paid AI API (read_pages, find, tutor) are not in the free plan. For Plus and Pro, each
# member gets a monthly AI budget in US$, kept under what the plan earns after the store's 15% (Plus earns about
# US$1.77-3.39 a month, Pro about US$4.25-6.79), so no plan can cost more than it brings in. The allowances people
# see (pages, searches, answers) are worked out from that budget and what one use costs on the model each feature
# runs on (fly.toml: HAPTUNE_AI_MODEL_READ / _REREAD / _FIND / _TUTOR). A cheaper model therefore gives
# everyone more, automatically. Fixed numbers can still be set with HAPTUNE_PLANS_JSON,
# e.g. {"plus": {"read_pages": 20}} or {"free": {"tutor": 3}} (null = no limit).
PLANS = {
    "free": {"open_requests": 3, "monthly_credits": 0, "spotlights": 0},
    "plus": {"open_requests": 10, "monthly_credits": 100, "spotlights": 1},
    "pro": {"open_requests": 30, "monthly_credits": 300, "spotlights": 4},
}
AI_BUDGET = {"free": 0.0, "plus": 1.00, "pro": 4.00}
# Reading printed music with AI is a Pro tool: it is the costly feature, and it is for people who will check and
# edit the result. Plus has the song finder and the tutor.
BUDGET_SPLIT = {"plus": {"read_pages": 0.0, "find": 0.65, "tutor": 0.35},
                "pro": {"read_pages": 0.65, "find": 0.20, "tutor": 0.15}}
NEEDS = {"read_pages": "pro", "find": "plus", "tutor": "plus"}      # the lowest plan that includes each AI feature
# What one use typically costs on each model family (US$; measured on the Claude API, see the README and
# engine/tools/model_bench.py). The song finder needs web search, which runs on Sonnet or Opus.
UNIT_COST = {
    "read_pages": {"opus": 0.30, "sonnet": 0.15, "haiku": 0.02},
    "find": {"opus": 0.45, "sonnet": 0.25, "haiku": 0.25},
    "tutor": {"opus": 0.010, "sonnet": 0.005, "haiku": 0.0005},
}
OVERRIDES: dict = {}
try:
    for _tier, _over in json.loads(os.environ.get("HAPTUNE_PLANS_JSON") or "{}").items():
        if _tier in PLANS and isinstance(_over, dict):
            OVERRIDES[_tier] = {k: (None if v is None else int(v)) for k, v in _over.items()}
except (ValueError, TypeError):
    pass


def feature_model(kind: str) -> str:
    """The model an AI feature runs on: read, reread, find or tutor."""
    from haptune.ai.claude import DEFAULT_MODEL
    if kind == "reread":
        return os.environ.get("HAPTUNE_AI_MODEL_REREAD") or feature_model("read")
    return os.environ.get(f"HAPTUNE_AI_MODEL_{kind.upper()}") or os.environ.get("HAPTUNE_AI_MODEL") or DEFAULT_MODEL


def _family(model: str) -> str:
    return "haiku" if "haiku" in model else "sonnet" if "sonnet" in model else "opus"


def unit_cost(kind: str) -> float:
    if kind == "read_pages":
        first, again = feature_model("read"), feature_model("reread")
        c = UNIT_COST[kind][_family(first)]
        return c + (0.15 * UNIT_COST[kind][_family(again)] if again != first else 0.0)   # about 15% of bars are re-read
    return UNIT_COST[kind][_family(feature_model({"find": "find", "tutor": "tutor"}[kind]))]


def ai_allowance(tier: str, kind: str) -> int | None:
    over = OVERRIDES.get(tier, {})
    if kind in over:
        return over[kind]
    budget = AI_BUDGET.get(tier, 0.0) * BUDGET_SPLIT.get(tier, {}).get(kind, 0.0)
    return max(1, int(budget / unit_cost(kind))) if budget > 0 else 0


def plan_table() -> dict:
    return {tier: {**vals, **{k: v for k, v in OVERRIDES.get(tier, {}).items() if k in vals},
                   **{k: ai_allowance(tier, k) for k in ("read_pages", "find", "tutor")}} for tier, vals in PLANS.items()}


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


def today_minus(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")


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
    t = acc.get("tier") or "free"
    if t != "free" and acc.get("tier_until") and acc["tier_until"] < _now():
        return "free"
    return t if t in PLANS else "free"


def plan_limits(tier: str, acc: dict | None = None) -> dict:
    table = plan_table()
    if tier == "dev":
        return {k: None for k in table["pro"]}                   # no limits for the developer
    lim = dict(table.get(tier, table["free"]))
    # A pass earned with Notes lasts days, not a month: its AI allowance is the matching share of the month's.
    if acc and acc.get("tier_source") == "notes" and acc.get("pass_days"):
        share = min(1.0, acc["pass_days"] / 30.0)
        for k in AI_KINDS:
            if lim.get(k):
                lim[k] = max(1, int(lim[k] * share + 0.5))
    return lim


# ----------------------------------------------------------------------------------------------- who is here now
PRESENCE: dict[str, float] = {}           # user id -> when last heard from (this server is one machine)
PRACTISING: dict[str, float] = {}


def touch(uid: str, practising: bool = False) -> None:
    now = time.time()
    PRESENCE[uid] = now
    if practising:
        PRACTISING[uid] = now
    if len(PRESENCE) > 20000:                                    # forget people not seen for an hour
        for k in [k for k, v in PRESENCE.items() if now - v > 3600]:
            PRESENCE.pop(k, None)
            PRACTISING.pop(k, None)


def online_now(window: float = 300.0) -> int:
    now = time.time()
    return sum(1 for v in PRESENCE.values() if now - v <= window)


def practising_now(window: float = 150.0) -> int:
    now = time.time()
    return sum(1 for v in PRACTISING.values() if now - v <= window)


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


# ----------------------------------------------------------------------------------------------- staff
# Roles, most powerful first: owner > developer > verified teacher (teachers.py) > user.
SCOPES = ("read_analytics", "manage_users", "feature_flags", "moderate_stage", "verify_teachers")
DEV_MODE_HOURS = float(os.environ.get("HAPTUNE_DEV_MODE_HOURS", "8"))


def owner_emails() -> set[str]:
    return {e.strip().lower() for e in os.environ.get("HAPTUNE_OWNER_EMAILS", "").split(",") if e.strip()}


def is_owner_acc(acc: dict | None) -> bool:
    """The owner signed in with Google (a verified email) and that email is in HAPTUNE_OWNER_EMAILS. Nothing in
    the app can make or unmake the owner."""
    return bool(acc and acc.get("google_sub") and (acc.get("email") or "").lower() in owner_emails())


def staff_of(acc: dict | None, grant_row: dict | None) -> tuple[str | None, set[str]]:
    """(role, scopes): ('owner', all) | ('developer', scopes) | (None, set())."""
    if not acc or acc.get("role") == "banned":
        return None, set()
    if is_owner_acc(acc):
        return "owner", set(SCOPES)
    if grant_row and (grant_row.get("expires") is None or grant_row["expires"] > _now()):
        return "developer", {x for x in (grant_row.get("scopes") or []) if x in SCOPES}
    # earlier ways to become the developer (the HAPTUNE_ADMIN_CODE claim, HAPTUNE_ADMINS): every scope, and the
    # owner can revoke them in Access
    if acc.get("role") == "admin" or (acc.get("handle") or "").lower() in ADMIN_HANDLES:
        return "developer", set(SCOPES)
    return None, set()


class Me:
    """The signed-in person: identity (users row) + account, and for staff their role, scopes and whether
    Developer mode is on for this sign-in. With Developer mode off, staff use the app like anyone else."""

    def __init__(self, user: dict, acc: dict, *, token_hash: str | None = None, grant_row: dict | None = None, elevated_until: float | None = None):
        self.user, self.acc = user, acc
        self.id = user["id"]
        self.token_hash = token_hash
        self.staff, self.scopes = staff_of(acc, grant_row)
        self.grant_row = grant_row
        self.dev_until = elevated_until if (self.staff and elevated_until and elevated_until > _now()) else None
        self.dev_mode = self.dev_until is not None
        self.tier = "dev" if self.dev_mode else effective_tier(acc)

    @property
    def is_owner(self) -> bool:
        return self.staff == "owner"

    def can(self, scope: str) -> bool:
        return self.dev_mode and scope in self.scopes

    @property
    def is_admin(self) -> bool:
        """Moderation powers on content (hidden posts, deleting others' posts): Developer mode + moderate_stage."""
        return self.can("moderate_stage")


def _token(authorization: str) -> str:
    return (authorization or "").removeprefix("Bearer ").strip()


def _staff_rows(c, uid: str, token_hash: str | None) -> tuple[dict | None, float | None]:
    g = c.execute(select(dev_grants).where(dev_grants.c.user_id == uid)).mappings().first()
    until = None
    if token_hash:
        until = c.execute(select(elevations.c.until).where(elevations.c.token_hash == token_hash, elevations.c.user_id == uid)).scalar()
    return (dict(g) if g else None), until


def current(authorization: str = Header("")) -> Me:
    tok = _token(authorization)
    user = user_from_token(tok)
    if user is None:
        raise HTTPException(401, "Please open Melovyn online once to make your account.")
    with engine().begin() as c:
        acc = ensure_account(c, user)
        if acc["role"] == "banned":
            raise HTTPException(403, "This account can no longer use the community.")
        c.execute(update(accounts).where(accounts.c.user_id == user["id"]).values(last_seen=_now()))
        _monthly_bonus(c, acc)
        g, until = _staff_rows(c, user["id"], _hash(tok))
    touch(user["id"])
    return Me(user, acc, token_hash=_hash(tok), grant_row=g, elevated_until=until)


def reload(uid: str, like: Me | None = None) -> Me:
    """The account again after a change; `like` keeps that sign-in's Developer mode."""
    th = like.token_hash if like else None
    with engine().connect() as c:
        user = dict(c.execute(select(users).where(users.c.id == uid)).mappings().first())
        acc = dict(c.execute(select(accounts).where(accounts.c.user_id == uid)).mappings().first())
        g, until = _staff_rows(c, uid, th)
    return Me(user, acc, token_hash=th, grant_row=g, elevated_until=until)


def optional(authorization: str = Header("")) -> Me | None:
    try:
        return current(authorization)
    except HTTPException:
        return None


def _staff_gate(me: Me, scope: str | None) -> Me:
    if not me.staff:
        raise HTTPException(403, "Only the owner and developers can do that.")
    if not me.dev_mode:
        raise HTTPException(403, {"code": "dev_mode_off", "message": "Switch on Developer mode first (Me > Developer mode)."})
    if scope == "owner" and not me.is_owner:
        raise HTTPException(403, {"code": "owner_only", "message": "Only the owner can do that."})
    if scope and scope != "owner" and scope not in me.scopes:
        raise HTTPException(403, {"code": "scope", "scope": scope, "message": "Your developer access doesn't include this."})
    return me


def require_scope(scope: str | None):
    """FastAPI dependency: staff, Developer mode on for this sign-in, and `scope` ('owner' = the owner only)."""
    def dep(me: Me = Depends(current)) -> Me:
        return _staff_gate(me, scope)
    return dep


def require_admin(me: Me = Depends(current)) -> Me:
    """Any staff member in Developer mode (endpoints that need a particular scope use require_scope)."""
    return _staff_gate(me, None)


def audit(c, me: Me, action: str, target: str | None = None, before=None, after=None, note: str = "") -> None:
    c.execute(insert(audit_log).values(actor=me.id, action=action[:40], target=target, before=before, after=after, note=(note or "")[:500], created=_now()))


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
    n = plan_table().get(tier, {}).get("monthly_credits", 0) if tier != "dev" else 0
    if acc.get("tier_source") in ("notes", "credits"):
        n = 0                                                    # a pass earned with Notes doesn't hand Notes back
    if n and acc.get("bonus_month") != month():
        c.execute(update(accounts).where(accounts.c.user_id == acc["user_id"]).values(bonus_month=month()))
        grant(c, acc["user_id"], n, "plan_bonus", note=f"{tier} {month()}")
        notify(c, acc["user_id"], "credits", amount=n, reason="plan_bonus")


def usage_of(c, uid: str, tier: str, acc: dict | None = None) -> dict:
    rows = c.execute(select(usage.c.kind, usage.c.used).where(usage.c.user_id == uid, usage.c.period == month())).all()
    used = {k: u for k, u in rows}
    lim = plan_limits(tier, acc)
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
        u = usage_of(c, me.id, me.tier, acc)
        n_sessions = c.execute(select(func.count()).select_from(sessions).where(sessions.c.user_id == me.id)).scalar()
        import teachers
        verified_teacher = teachers.is_verified(me.id, c)
    return {**public_user(me.user, acc), "verified_teacher": verified_teacher, "bio": acc["bio"], "lang": acc["lang"], "role": acc["role"], "is_admin": me.is_admin,
            "tier": me.tier, "tier_until": _iso(acc["tier_until"]) if me.tier not in ("free", "dev") else None,
            "tier_source": acc["tier_source"], "credits": acc["credits"], "streak": acc["streak"], "usage": u,
            "limits": plan_limits(me.tier, acc), "unread": unread, "guidelines": acc["guidelines"], "has_password": bool(acc["pw_hash"]),
            "registered": is_registered(acc), "google": bool(acc.get("google_sub")), "email": acc.get("email") or "", "hub_role": acc.get("hub_role") or "",
            "devices": n_sessions + 1, "joined": _iso(acc["created"]),
            "staff": {"role": me.staff, "scopes": sorted(me.scopes), "dev_mode": me.dev_mode, "dev_until": _iso(me.dev_until) if me.dev_until else None,
                      "expires": _iso(me.grant_row["expires"]) if me.grant_row and me.grant_row.get("expires") else None} if me.staff else None,
            "totp": bool(acc.get("totp_on") and _unseal(acc.get("totp_secret")))}


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
    hub_role: str | None = Field(None, max_length=10)


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
        if body.hub_role is not None:
            vals["hub_role"] = body.hub_role if body.hub_role in ("", "teacher", "student") else ""
        if vals:
            c.execute(update(accounts).where(accounts.c.user_id == me.id).values(**vals))
    return me_json(reload(me.id, me))


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


def _signed_in(uid: str, method: str, request: Request | None, device: str = "") -> None:
    import analytics
    d = (device or "").lower()
    plat = "android" if "android" in d else "ios" if ("iphone" in d or "ipad" in d or "ios" in d) else "web"
    analytics.server_event(uid, "sign_in", label=method, platform=plat, request=request)


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
    _signed_in(acc["user_id"], "password", request, body.device)
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


# ----------------------------------------------------------------------------------------------- signing in
def is_registered(acc: dict | None) -> bool:
    """Signed in with Google, or has a username and password: an account that can come back on any device."""
    return bool(acc and (acc.get("pw_hash") or acc.get("google_sub") or acc.get("apple_sub")))


def signin_required() -> bool:
    return os.environ.get("HAPTUNE_SIGNIN_REQUIRED", "1") != "0"


def require_registered(me: Me) -> None:
    """Online features that other people see (teaching, joining a class, posting) need a real sign-in."""
    if signin_required() and not is_registered(me.acc) and not me.is_admin:
        raise HTTPException(401, {"code": "signin_required", "message": "Sign in first (Google, or a username and password)."})


def registered(me: Me = Depends(current)) -> Me:
    require_registered(me)
    return me


def google_client_ids() -> list[str]:
    return [x.strip() for x in os.environ.get("GOOGLE_CLIENT_IDS", os.environ.get("GOOGLE_CLIENT_ID", "")).split(",") if x.strip()]


def verify_google(credential: str) -> dict:
    """Checks a Google ID token (from Sign in with Google) with Google and returns its claims.
    Tests replace this function."""
    ids = google_client_ids()
    if not ids:
        raise HTTPException(503, "Sign in with Google isn't set up on this server yet.")
    from urllib.parse import quote
    try:
        with urllib.request.urlopen("https://oauth2.googleapis.com/tokeninfo?id_token=" + quote(credential), timeout=15) as r:
            info = json.load(r)
    except Exception:
        raise HTTPException(401, "Google could not confirm that sign-in. Please try again.")
    if info.get("aud") not in ids or info.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise HTTPException(401, "That Google sign-in was meant for another app.")
    if float(info.get("exp", 0)) < time.time():
        raise HTTPException(401, "That Google sign-in has expired. Please try again.")
    if not info.get("sub"):
        raise HTTPException(401, "Google did not say who you are.")
    return info


class GoogleIn(BaseModel):
    credential: str = Field(..., min_length=20, max_length=4096)
    device: str = Field("", max_length=60)


@router.post("/auth/google")
def google_signin(body: GoogleIn, request: Request, authorization: str = Header("")):
    """Sign in with Google. A Google account seen before signs in to its Melovyn account (on this device too);
    a new one is linked to the account this device already has (so nothing is lost), or gets a new account."""
    rate(request, "google", 30, 3600)
    info = verify_google(body.credential)
    sub = str(info["sub"])[:64]
    email = (info.get("email") or "")[:200] if str(info.get("email_verified", "true")).lower() in ("true", "1") else ""
    name = (info.get("given_name") or info.get("name") or "").strip()[:60]
    with engine().begin() as c:
        uid = c.execute(select(accounts.c.user_id).where(accounts.c.google_sub == sub)).scalar()
        if uid:
            token = _session(c, uid, body.device or "Google")
            c.execute(update(accounts).where(accounts.c.user_id == uid).values(email=email or accounts.c.email))
        else:
            here = user_from_token(_token(authorization))
            acc = c.execute(select(accounts).where(accounts.c.user_id == here["id"])).mappings().first() if here else None
            if here and acc and not acc["google_sub"]:
                uid = here["id"]
                token = _token(authorization)                           # this device keeps its sign-in
                c.execute(update(accounts).where(accounts.c.user_id == uid).values(google_sub=sub, email=email))
                if name and (here.get("name") in ("", "Musician")):
                    c.execute(update(users).where(users.c.id == uid).values(name=name))
            else:
                user, token = _new_identity(c, name)
                uid = user["id"]
                ensure_account(c, user)
                c.execute(update(accounts).where(accounts.c.user_id == uid).values(google_sub=sub, email=email))
    _signed_in(uid, "google", request, body.device)
    return {"token": token, "me": me_json(current(f"Bearer {token}"))}


# Pairing: the phone or tablet app shows a code, the person signs in on the website (where Google sign-in works)
# and approves it there, and the app is then signed in to the same account. Codes last 10 minutes.
PAIR_TTL = 600.0
PAIR_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def _pair_get(c, code: str) -> dict | None:
    row = c.execute(select(kv.c.v).where(kv.c.k == f"pair:{code}")).scalar()
    if not row:
        return None
    d = json.loads(row)
    if d.get("created", 0) + PAIR_TTL < _now():
        c.execute(delete(kv).where(kv.c.k == f"pair:{code}"))
        return None
    return d


@router.post("/auth/pair")
def pair_start(request: Request):
    rate(request, "pair", 30, 3600)
    code = "".join(secrets.choice(PAIR_CHARS) for _ in range(8))
    with engine().begin() as c:
        c.execute(insert(kv).values(k=f"pair:{code}", v=json.dumps({"created": _now(), "user": None})))
    return {"code": code, "expires_in": int(PAIR_TTL)}


@router.post("/auth/pair/{code}/approve")
def pair_approve(code: str, me: Me = Depends(current)):
    require_registered(me)
    code = re.sub(r"[^A-Z0-9]", "", code.upper())
    with engine().begin() as c:
        d = _pair_get(c, code)
        if d is None:
            raise HTTPException(404, "That code has expired. Make a new one in the app.")
        d["user"] = me.id
        c.execute(update(kv).where(kv.c.k == f"pair:{code}").values(v=json.dumps(d)))
    return {"ok": True}


@router.get("/auth/pair/{code}")
def pair_poll(code: str, request: Request):
    rate(request, "pair-poll", 600, 3600)
    code = re.sub(r"[^A-Z0-9]", "", code.upper())
    with engine().begin() as c:
        d = _pair_get(c, code)
        if d is None:
            raise HTTPException(404, "That code has expired.")
        if not d.get("user"):
            return {"status": "waiting"}
        c.execute(delete(kv).where(kv.c.k == f"pair:{code}"))
        token = _session(c, d["user"], "paired app")
    return {"status": "done", "token": token, "me": me_json(current(f"Bearer {token}"))}


@router.delete("/me")
def delete_me(me: Me = Depends(current)):
    """Deletes the account: profile, sign-ins, notifications and credits go; posts stay as 'Deleted user' so
    threads still read sensibly (Google Play and the App Store ask for this to be possible in the app)."""
    with engine().begin() as c:
        delete_account(c, me.id)
    return {"deleted": True}


def delete_account(c, uid: str) -> None:
    from community import forget_user
    forget_user(c, uid)
    for mod in ("friends", "learn"):                                    # Part 2: friends, messages, guardians, ...
        try:
            __import__(mod).forget(c, uid)
        except ImportError:
            pass
    for t in (notifications, practice_log, usage, ledger, elevations, dev_grants):
        c.execute(delete(t).where(t.c.user_id == uid))
    try:
        import analytics
        c.execute(delete(analytics.events).where(analytics.events.c.user_id == uid))
    except Exception:                                                   # noqa: BLE001
        pass
    c.execute(delete(sessions).where(sessions.c.user_id == uid))
    c.execute(delete(accounts).where(accounts.c.user_id == uid))
    c.execute(update(users).where(users.c.id == uid).values(name="Deleted user", token_hash=_hash(secrets.token_hex(16)),
                                                          link_code=None, link_expires=None))


class DevIn(BaseModel):
    code: str = Field(..., min_length=8, max_length=200)


@router.post("/me/dev")
def claim_dev(body: DevIn, request: Request, me: Me = Depends(current)):
    """The developer unlocks everything on their own account with the code in HAPTUNE_ADMIN_CODE."""
    rate(request, "dev", 5, 3600)
    if owner_emails():
        raise HTTPException(410, "Developer access is now given by the owner (Developer mode > Access).")
    want = os.environ.get("HAPTUNE_ADMIN_CODE", "")
    if len(want) < 12 or not hmac.compare_digest(want, body.code.strip()):
        raise HTTPException(403, "That code isn't right.")
    with engine().begin() as c:
        c.execute(update(accounts).where(accounts.c.user_id == me.id).values(role="admin"))
    return me_json(reload(me.id, me))


# ----------------------------------------------------------------------------------------------- 2-step verification
# TOTP (RFC 6238: 6 digits, 30 s, SHA-1), the codes authenticator apps (Google Authenticator, Microsoft
# Authenticator, 1Password...) make. Required for the owner and developers before Developer mode switches on.
B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


def totp(secret: str, offset: int = 0, at: float | None = None) -> str:
    key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
    counter = int((at if at is not None else time.time()) // 30) + offset
    h = hmac.new(key, counter.to_bytes(8, "big"), hashlib.sha1).digest()
    o = h[-1] & 15
    return f"{(int.from_bytes(h[o:o + 4], 'big') & 0x7FFFFFFF) % 1_000_000:06d}"


def _seal(secret: str) -> str:
    if len(os.environ.get("HAPTUNE_TOKEN_KEY", "")) >= 16:
        import google_link
        return "enc:" + google_link.encrypt(secret)
    return "plain:" + secret


def _unseal(stored: str | None) -> str | None:
    if not stored:
        return None
    if stored.startswith("enc:"):
        import google_link
        try:
            return google_link.decrypt(stored[4:])
        except Exception:                                       # noqa: BLE001 - HAPTUNE_TOKEN_KEY changed since
            return None
    return stored.removeprefix("plain:")


def _recovery_codes() -> tuple[list[str], list[str]]:
    codes = [f"{secrets.token_hex(2)}-{secrets.token_hex(2)}" for _ in range(10)]
    return codes, [_hash(x.replace("-", "")) for x in codes]


def check_2fa(c, acc: dict, code: str) -> bool:
    """A current code from the app (each works once), or an unused recovery code (then used up)."""
    code = re.sub(r"[\s-]", "", code or "").lower()
    secret = _unseal(acc.get("totp_secret"))
    if not secret or not code:
        return False
    if re.fullmatch(r"\d{6}", code):
        now = int(time.time() // 30)
        for off in (-1, 0, 1):
            step = now + off
            if (acc.get("totp_last_step") or 0) < step and hmac.compare_digest(totp(secret, off), code):
                c.execute(update(accounts).where(accounts.c.user_id == acc["user_id"]).values(totp_last_step=step))
                return True
        return False
    left = list(acc.get("totp_recovery") or [])
    h = _hash(code)
    if h in left:
        left.remove(h)
        c.execute(update(accounts).where(accounts.c.user_id == acc["user_id"]).values(totp_recovery=left))
        return True
    return False


class CodeIn(BaseModel):
    code: str = Field("", max_length=20)


@router.get("/me/staff-check")
def staff_check(me: Me = Depends(current)):
    """Why this account is or isn't the owner, in words the person can act on (about themselves only)."""
    acc = me.acc
    email = (acc.get("email") or "").lower()
    if me.staff:
        reason = "ok"
    elif not owner_emails():
        reason = "owner_not_set"                # HAPTUNE_OWNER_EMAILS is empty on the server
    elif not acc.get("google_sub"):
        reason = "not_google"                   # signed in another way (username, Apple, a device-only account)
    elif not email:
        reason = "no_email"                     # Google didn't share a verified email: sign in with Google again
    elif email not in owner_emails():
        reason = "other_email"
    else:
        reason = "unknown"
    return {"reason": reason, "email": acc.get("email") or "", "google": bool(acc.get("google_sub")), "registered": is_registered(acc),
            "staff": me.staff, "totp": bool(acc.get("totp_on")), "totp_readable": bool(_unseal(acc.get("totp_secret"))) if acc.get("totp_on") else None}


@router.get("/me/2fa")
def twofa_status(me: Me = Depends(current)):
    # a secret the server can no longer read (its key changed) counts as off, so it can be set up again
    return {"on": bool(me.acc.get("totp_on") and _unseal(me.acc.get("totp_secret"))), "recovery_left": len(me.acc.get("totp_recovery") or []), "required": bool(me.staff)}


@router.post("/me/2fa/setup")
def twofa_setup(me: Me = Depends(current)):
    """A new secret to add to an authenticator app (shown as a QR code and as text). Not on until confirmed."""
    require_registered(me)
    # on, and still readable: it stays. (If the server's key changed, the old secret can't be read any more and the
    # owner, signed in with Google, sets it up again instead of being locked out of Developer mode for good.)
    if me.acc.get("totp_on") and _unseal(me.acc.get("totp_secret")):
        raise HTTPException(409, "2-step verification is already on.")
    secret = "".join(secrets.choice(B32) for _ in range(32))
    with engine().begin() as c:
        c.execute(update(accounts).where(accounts.c.user_id == me.id).values(totp_secret=_seal(secret), totp_on=False, totp_last_step=None))
    label = urllib.parse.quote(f"Melovyn:{me.acc['handle']}")
    return {"secret": secret, "uri": f"otpauth://totp/{label}?secret={secret}&issuer=Melovyn&digits=6&period=30"}


@router.post("/me/2fa/enable")
def twofa_enable(body: CodeIn, request: Request, me: Me = Depends(current)):
    rate(request, f"2fa:{me.id}", 10, 900)
    if me.acc.get("totp_on"):
        raise HTTPException(409, "2-step verification is already on.")
    codes, hashes = _recovery_codes()
    with engine().begin() as c:
        if not check_2fa(c, {**me.acc, "totp_recovery": []}, body.code):
            raise HTTPException(400, "That code isn't right. Check the time on your phone and try the newest code.")
        c.execute(update(accounts).where(accounts.c.user_id == me.id).values(totp_on=True, totp_recovery=hashes))
        if me.staff:
            audit(c, me, "2fa_on", me.id)
    return {"on": True, "recovery_codes": codes}


@router.post("/me/2fa/recovery")
def twofa_new_recovery(body: CodeIn, request: Request, me: Me = Depends(current)):
    rate(request, f"2fa:{me.id}", 10, 900)
    codes, hashes = _recovery_codes()
    with engine().begin() as c:
        if not me.acc.get("totp_on") or not check_2fa(c, me.acc, body.code):
            raise HTTPException(400, "That code isn't right.")
        c.execute(update(accounts).where(accounts.c.user_id == me.id).values(totp_recovery=hashes))
    return {"recovery_codes": codes}


@router.post("/me/2fa/disable")
def twofa_disable(body: CodeIn, request: Request, me: Me = Depends(current)):
    rate(request, f"2fa:{me.id}", 10, 900)
    if me.staff:
        raise HTTPException(409, "The owner and developers must keep 2-step verification on.")
    with engine().begin() as c:
        if not me.acc.get("totp_on") or not check_2fa(c, me.acc, body.code):
            raise HTTPException(400, "That code isn't right.")
        c.execute(update(accounts).where(accounts.c.user_id == me.id).values(totp_on=False, totp_secret=None, totp_recovery=None))
    return {"on": False}


class DevModeIn(BaseModel):
    on: bool
    code: str = Field("", max_length=20)


@router.post("/me/devmode")
def dev_mode(body: DevModeIn, request: Request, me: Me = Depends(current)):
    """Developer mode for this sign-in only: needs a 2-step code to switch on, ends after DEV_MODE_HOURS."""
    if not me.staff:
        raise HTTPException(403, "Only the owner and developers have Developer mode.")
    with engine().begin() as c:
        if not body.on:
            c.execute(delete(elevations).where(elevations.c.token_hash == me.token_hash))
            audit(c, me, "dev_mode_off", me.id)
        else:
            if not me.acc.get("totp_on"):
                raise HTTPException(409, {"code": "totp_required", "message": "Set up 2-step verification first."})
            rate(request, f"2fa:{me.id}", 10, 900)
            if not check_2fa(c, me.acc, body.code):
                raise HTTPException(400, "That code isn't right.")
            c.execute(delete(elevations).where(elevations.c.token_hash == me.token_hash))
            c.execute(insert(elevations).values(token_hash=me.token_hash, user_id=me.id, until=_now() + DEV_MODE_HOURS * 3600, created=_now()))
            audit(c, me, "dev_mode_on", me.id)
    return me_json(reload(me.id, me))


# ----------------------------------------------------------------------------------------------- sign-ins and devices
@router.get("/me/sessions")
def my_sessions(me: Me = Depends(current)):
    """Where this account is signed in: the device that made it, and every sign-in since (other devices)."""
    with engine().connect() as c:
        rows = c.execute(select(sessions).where(sessions.c.user_id == me.id).order_by(sessions.c.last_seen.desc())).mappings().all()
        elev = {r[0] for r in c.execute(select(elevations.c.token_hash).where(elevations.c.user_id == me.id, elevations.c.until > _now())).all()}
    out = [{"id": "device", "label": "The device this account was made on", "created": _iso(me.acc["created"]), "seen": None,
            "current": me.token_hash == me.user["token_hash"], "dev_mode": me.user["token_hash"] in elev}]
    out += [{"id": r["token_hash"][:16], "label": r["label"] or "Signed in", "created": _iso(r["created"]), "seen": _iso(r["last_seen"]),
             "current": r["token_hash"] == me.token_hash, "dev_mode": r["token_hash"] in elev} for r in rows]
    return {"items": out}


def _end_session(c, me: Me, sid: str) -> None:
    if sid == "device":
        if not is_registered(me.acc):
            raise HTTPException(409, "This account has no sign-in yet: signing out its first device would lose it.")
        c.execute(delete(elevations).where(elevations.c.token_hash == me.user["token_hash"]))
        c.execute(update(users).where(users.c.id == me.id).values(token_hash=_hash(secrets.token_hex(24))))
        return
    for r in c.execute(select(sessions.c.token_hash).where(sessions.c.user_id == me.id)).all():
        if r[0].startswith(sid) and len(sid) >= 8:
            c.execute(delete(elevations).where(elevations.c.token_hash == r[0]))
            c.execute(delete(sessions).where(sessions.c.token_hash == r[0]))
            return
    raise HTTPException(404, "That sign-in has already ended.")


@router.delete("/me/sessions/{sid}")
def end_session(sid: str, me: Me = Depends(current)):
    with engine().begin() as c:
        _end_session(c, me, sid[:64])
        if me.staff:
            audit(c, me, "session_signed_out", me.id, note=sid[:16])
    return {"ok": True}


@router.post("/me/sessions/others")
def end_other_sessions(me: Me = Depends(current)):
    with engine().begin() as c:
        for r in c.execute(select(sessions.c.token_hash).where(sessions.c.user_id == me.id, sessions.c.token_hash != me.token_hash)).all():
            c.execute(delete(elevations).where(elevations.c.token_hash == r[0]))
            c.execute(delete(sessions).where(sessions.c.token_hash == r[0]))
        if me.token_hash != me.user["token_hash"] and is_registered(me.acc):
            _end_session(c, me, "device")
        if me.staff:
            audit(c, me, "sessions_signed_out", me.id, note="all other devices")
    return {"ok": True}


# ----------------------------------------------------------------------------------------------- your data
def export_user(c, uid: str) -> dict:
    """Everything kept about a person, as JSON (for them, or for the owner answering a data request)."""
    import academy
    import community
    acc = dict(c.execute(select(accounts).where(accounts.c.user_id == uid)).mappings().first() or {})
    for k in ("pw_hash", "recovery_hash", "totp_secret", "totp_recovery", "totp_last_step", "stripe_customer", "stripe_sub"):
        acc.pop(k, None)
    user = dict(c.execute(select(users.c.id, users.c.name, users.c.created).where(users.c.id == uid)).mappings().first() or {})
    rows = lambda t, col="user_id", cols=None: [dict(r) for r in c.execute(select(*(cols or [t])).where(t.c[col] == uid)).mappings().all()]  # noqa: E731
    out = {"exported": _iso(_now()), "user": user, "account": acc,
           "notifications": rows(notifications), "practice": rows(practice_log), "credits": rows(ledger), "ai_usage": rows(usage),
           "posts": rows(community.posts), "replies": rows(community.replies),
           "class_memberships": rows(academy.members),
           "takes": rows(academy.takes, cols=[academy.takes.c.id, academy.takes.c.class_id, academy.takes.c.piece_title, academy.takes.c.accuracy, academy.takes.c.created]),
           "feedback_sent": rows(app_feedback)}
    for mod in ("friends", "learn"):
        try:
            out.update(__import__(mod).export(c, uid))
        except ImportError:
            pass
    try:
        import sounds
        out["sounds"] = rows(sounds.sounds, cols=[sounds.sounds.c.id, sounds.sounds.c.title, sounds.sounds.c.seconds, sounds.sounds.c.created])
    except Exception:                                                   # noqa: BLE001
        pass
    try:
        import analytics
        out["usage_events"] = rows(analytics.events, cols=[analytics.events.c.ts, analytics.events.c.name, analytics.events.c.screen,
                                                           analytics.events.c.label, analytics.events.c.value, analytics.events.c.platform, analytics.events.c.country])
    except Exception:                                                   # noqa: BLE001
        pass
    return json.loads(json.dumps(out, default=str))


@router.get("/me/export")
def export_me(request: Request, me: Me = Depends(current)):
    rate(request, f"export:{me.id}", 5, 3600)
    with engine().connect() as c:
        return export_user(c, me.id)


@router.get("/plans")
def plans():
    return {"plans": plan_table(), "prices": PRICES, "rules": RULES, "revenuecat": bool(os.environ.get("REVENUECAT_SECRET")),
            "models": {k: feature_model(k) for k in ("read", "reread", "find", "tutor")}}


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
    limit = plan_limits(tier, me.acc if me else None).get(kind)
    names = {"read_pages": "Reading music with AI", "find": "Finding songs online", "tutor": "Hapi the tutor"}
    if limit == 0:
        need = NEEDS.get(kind, "plus")
        raise HTTPException(402, {"code": "plan_required", "feature": kind, "tier": tier, "need": need,
                                  "message": f"{names.get(kind, kind)} is part of Melovyn {need.capitalize()}."})
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
    return me_json(reload(me.id, me))


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
    return me_json(reload(me.id, me))


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
