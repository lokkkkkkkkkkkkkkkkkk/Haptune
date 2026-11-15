"""Paying for a plan outside the app stores.

Three ways to pay lead to the same account, so a plan bought once works on every device:

    Google Play     in the Android app, through RevenueCat (accounts.py). Google's rules require it there.
    Stripe          card payment on the website: a Stripe Checkout page, renewals by webhook, and Stripe's own
                    customer portal to change card or cancel.
    DuitNow / bank  for Malaysia: the person pays by DuitNow QR or a transfer to the bank account, quoting a short
                    code, and tells us. The developer checks the bank and approves it in the app's developer panel.
                    These do not renew by themselves.

Set on the server (fly secrets):  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
Optional:  HAPTUNE_PAY_BANK, HAPTUNE_PAY_ACCOUNT, HAPTUNE_PAY_NAME (shown for transfers), HAPTUNE_SITE_URL,
           STRIPE_PRICE_<PLUS|PRO>_<MONTHLY|YEARLY>_<MYR|USD> (Price ids made in the Stripe dashboard; without them
           the price is sent with each checkout).

The same two ways also pay the one-time teacher verification fee (tutors.py).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import Column, Float, String, Table, Text, func, insert, select, update

import accounts as A
from academy import _iso, _now, engine, meta

router = APIRouter(prefix="/c", tags=["billing"])

payments = Table("payments", meta,
                 Column("id", String(16), primary_key=True),
                 Column("user_id", String(36), nullable=False, index=True),
                 Column("product", String(12), nullable=False),            # plus | pro | teacher
                 Column("period", String(8), nullable=False, default=""),  # monthly | yearly | once
                 Column("amount", String(12), nullable=False),
                 Column("currency", String(4), nullable=False, default="myr"),
                 Column("method", String(10), nullable=False),             # duitnow | transfer
                 Column("code", String(12), nullable=False, index=True),   # quoted in the bank reference
                 Column("payer", String(80), nullable=False, default=""),
                 Column("note", String(300), nullable=False, default=""),
                 Column("receipt", Text, nullable=True),                   # a small picture of the receipt (data URL)
                 Column("status", String(10), nullable=False, default="started"),  # started | pending | approved | rejected
                 Column("admin_note", String(300), nullable=False, default=""),
                 Column("created", Float, nullable=False),
                 Column("decided", Float, nullable=True))

SITE = (os.environ.get("HAPTUNE_SITE_URL") or "https://haptune.name.my").rstrip("/")
TEACHER_FEE = {"myr": "20.00", "usd": "4.99"}
PERIOD_DAYS = {"monthly": 31, "yearly": 366}
GRACE = 2 * 86400                         # a renewal that arrives a little late doesn't switch the plan off
STRIPE_API = "https://api.stripe.com/v1"


def bank() -> dict:
    return {"bank": os.environ.get("HAPTUNE_PAY_BANK", "CIMB Bank"), "account": os.environ.get("HAPTUNE_PAY_ACCOUNT", "7647680094"),
            "name": os.environ.get("HAPTUNE_PAY_NAME", "")}


def stripe_on() -> bool:
    return bool(os.environ.get("STRIPE_SECRET_KEY"))


def price_of(product: str, period: str, currency: str) -> str:
    if product == "teacher":
        return TEACHER_FEE[currency]
    try:
        return A.PRICES[product][period][currency]
    except KeyError:
        raise HTTPException(400, "Unknown plan.") from None


# ----------------------------------------------------------------------------------------------- Stripe
def _flatten(data: dict, prefix: str = "") -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for k, v in data.items():
        key = f"{prefix}[{k}]" if prefix else str(k)
        if isinstance(v, dict):
            out.extend(_flatten(v, key))
        elif isinstance(v, (list, tuple)):
            for i, item in enumerate(v):
                out.extend(_flatten(item, f"{key}[{i}]") if isinstance(item, dict) else [(f"{key}[{i}]", str(item))])
        elif v is not None:
            out.append((key, "true" if v is True else "false" if v is False else str(v)))
    return out


def stripe(method: str, path: str, data: dict | None = None) -> dict:
    """One call to Stripe's API (form-encoded, as Stripe expects). Tests replace this function."""
    key = os.environ.get("STRIPE_SECRET_KEY", "")
    if not key:
        raise HTTPException(503, "Card payments aren't switched on yet.")
    body = urllib.parse.urlencode(_flatten(data or {})).encode() if data else None
    url = STRIPE_API + path
    if method == "GET" and body:
        url, body = url + "?" + body.decode(), None
    req = urllib.request.Request(url, data=body, method=method, headers={
        "Authorization": "Basic " + base64.b64encode((key + ":").encode()).decode(), "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e).get("error", {}).get("message", "")
        except Exception:
            msg = ""
        raise HTTPException(502, f"The payment service said: {msg or e.code}") from None
    except Exception:
        raise HTTPException(502, "The payment service could not be reached. Please try again.") from None


class CheckoutIn(BaseModel):
    product: Literal["plus", "pro", "teacher"]
    period: Literal["monthly", "yearly", "once"] = "monthly"
    currency: Literal["myr", "usd"] = "myr"


@router.get("/billing/options")
def options(me: A.Me | None = Depends(A.optional)):
    """What the plans screen needs to offer the right ways to pay."""
    mine = []
    if me:
        with engine().connect() as c:
            rows = c.execute(select(payments).where(payments.c.user_id == me.id, payments.c.status.in_(["pending", "rejected"]))
                             .order_by(payments.c.created.desc()).limit(3)).mappings().all()
        mine = [_pay_json(dict(r)) for r in rows]
    return {"stripe": stripe_on(), "manual": bank(), "prices": A.PRICES, "teacher_fee": TEACHER_FEE, "site": SITE, "mine": mine,
            "manage": bool(me and me.acc.get("tier_source") == "stripe" and me.acc.get("stripe_customer"))}


@router.post("/billing/stripe/checkout")
def checkout(body: CheckoutIn, request: Request, me: A.Me = Depends(A.current)):
    """Starts a card payment: returns the address of Stripe's checkout page for this plan."""
    A.rate(request, "checkout", 20, 3600)
    once = body.product == "teacher"
    period = "once" if once else body.period
    if not once and period not in PERIOD_DAYS:
        raise HTTPException(400, "Choose monthly or yearly.")
    amount = price_of(body.product, period, body.currency)
    name = "Melovyn teacher verification" if once else f"Melovyn {body.product.capitalize()} ({period})"
    env_price = os.environ.get(f"STRIPE_PRICE_{body.product}_{period}_{body.currency}".upper())
    item: dict = {"quantity": 1}
    if env_price:
        item["price"] = env_price
    else:
        item["price_data"] = {"currency": body.currency, "unit_amount": int(round(float(amount) * 100)), "product_data": {"name": name}}
        if not once:
            item["price_data"]["recurring"] = {"interval": "month" if period == "monthly" else "year"}
    meta_ = {"uid": me.id, "product": body.product, "period": period}
    data: dict = {
        "mode": "payment" if once else "subscription", "line_items": [item], "client_reference_id": me.id, "metadata": meta_,
        "success_url": f"{SITE}/app/?paid={{CHECKOUT_SESSION_ID}}", "cancel_url": f"{SITE}/app/#plans", "allow_promotion_codes": True,
    }
    if not once:
        data["subscription_data"] = {"metadata": meta_}
    if me.acc.get("stripe_customer"):
        data["customer"] = me.acc["stripe_customer"]
    s = stripe("POST", "/checkout/sessions", data)
    return {"url": s["url"], "id": s["id"]}


def _apply_subscription(sub: dict) -> str | None:
    """Makes the account match a Stripe subscription (Stripe is the source of truth). Returns the user id."""
    md = sub.get("metadata") or {}
    uid, product = md.get("uid"), md.get("product")
    if not uid or product not in ("plus", "pro"):
        return None
    live = sub.get("status") in ("active", "trialing", "past_due")
    end = sub.get("current_period_end") or (sub.get("items", {}).get("data") or [{}])[0].get("current_period_end") or 0
    with engine().begin() as c:
        acc = c.execute(select(A.accounts).where(A.accounts.c.user_id == uid)).mappings().first()
        if not acc:
            return None
        if live and end:
            c.execute(update(A.accounts).where(A.accounts.c.user_id == uid).values(
                tier=product, tier_until=float(end) + GRACE, tier_source="stripe", pass_days=None,
                stripe_customer=sub.get("customer") or acc["stripe_customer"], stripe_sub=sub.get("id")))
        elif acc["tier_source"] == "stripe" and acc["stripe_sub"] == sub.get("id"):
            c.execute(update(A.accounts).where(A.accounts.c.user_id == uid).values(tier="free", tier_until=None, tier_source="", stripe_sub=None))
    return uid


def _apply_session(sess: dict) -> str | None:
    """A finished checkout: a subscription is synced from Stripe; a one-time payment marks the teacher as paid."""
    if sess.get("payment_status") not in ("paid", "no_payment_required"):
        return None
    md = sess.get("metadata") or {}
    uid = sess.get("client_reference_id") or md.get("uid")
    if not uid:
        return None
    if sess.get("mode") == "subscription" and sess.get("subscription"):
        sub_id = sess["subscription"] if isinstance(sess["subscription"], str) else sess["subscription"].get("id")
        return _apply_subscription(stripe("GET", f"/subscriptions/{sub_id}"))
    if md.get("product") == "teacher":
        paid_hooks_run("teacher", uid, f"stripe:{sess.get('id', '')}")
        if sess.get("customer"):
            with engine().begin() as c:
                c.execute(update(A.accounts).where(A.accounts.c.user_id == uid).values(stripe_customer=sess["customer"]))
    return uid


PAID_HOOKS: dict = {}                     # product -> fn(user id, reference): what a one-time payment unlocks


def paid_hooks_run(product: str, uid: str, ref: str) -> None:
    fn = PAID_HOOKS.get(product)
    if fn:
        fn(uid, ref)


class SyncIn(BaseModel):
    session: str = Field(..., min_length=8, max_length=200)


@router.post("/billing/stripe/sync")
def stripe_sync(body: SyncIn, me: A.Me = Depends(A.current)):
    """The app calls this when the person comes back from the checkout page, so the plan is on at once
    (the webhook does the same a moment later, and handles every renewal after that)."""
    sess = stripe("GET", f"/checkout/sessions/{urllib.parse.quote(body.session)}")
    if (sess.get("client_reference_id") or "") != me.id:
        raise HTTPException(403, "That payment belongs to another account.")
    _apply_session(sess)
    return A.me_json(A.reload(me.id))


@router.post("/billing/stripe/portal")
def portal(me: A.Me = Depends(A.current)):
    """Stripe's page to change the card, see invoices or cancel."""
    cust = me.acc.get("stripe_customer")
    if not cust:
        raise HTTPException(404, "There is no card subscription on this account.")
    s = stripe("POST", "/billing_portal/sessions", {"customer": cust, "return_url": f"{SITE}/app/#plans"})
    return {"url": s["url"]}


def verify_stripe_signature(payload: bytes, header: str, secret: str, tolerance: int = 600) -> bool:
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        t = int(parts["t"])
    except (ValueError, KeyError):
        return False
    if abs(time.time() - t) > tolerance:
        return False
    want = hmac.new(secret.encode(), f"{t}.".encode() + payload, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(want, v) for k, v in (p.split("=", 1) for p in header.split(",") if "=" in p) if k == "v1")


@router.post("/billing/stripe/webhook")
async def stripe_webhook(request: Request):
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
    payload = await request.body()
    if not secret or not verify_stripe_signature(payload, request.headers.get("stripe-signature", ""), secret):
        raise HTTPException(400, "Bad signature.")
    event = json.loads(payload)
    kind, obj = event.get("type", ""), (event.get("data") or {}).get("object") or {}
    if kind == "checkout.session.completed":
        _apply_session(obj)
    elif kind in ("customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.created"):
        _apply_subscription(obj if kind.endswith("deleted") else stripe("GET", f"/subscriptions/{obj.get('id')}"))
    elif kind in ("invoice.paid", "invoice.payment_failed"):
        sub_id = obj.get("subscription") or ((obj.get("parent") or {}).get("subscription_details") or {}).get("subscription")
        if sub_id:
            _apply_subscription(stripe("GET", f"/subscriptions/{sub_id}"))
    return {"ok": True}


# ----------------------------------------------------------------------------------------------- DuitNow / bank transfer
def _pay_json(p: dict, full: bool = False) -> dict:
    out = {"id": p["id"], "product": p["product"], "period": p["period"], "amount": p["amount"], "currency": p["currency"], "method": p["method"],
           "code": p["code"], "status": p["status"], "payer": p["payer"], "admin_note": p["admin_note"], "created": _iso(p["created"])}
    if full:
        out.update(note=p["note"], receipt=p["receipt"])
    return out


class ManualIn(BaseModel):
    product: Literal["plus", "pro", "teacher"]
    period: Literal["monthly", "yearly", "once"] = "monthly"
    method: Literal["duitnow", "transfer"] = "duitnow"


@router.post("/billing/manual")
def manual_start(body: ManualIn, request: Request, me: A.Me = Depends(A.current)):
    """Step 1: what to pay, where, and the code to quote. Nothing is charged; the person pays in their bank app."""
    A.rate(request, "manual", 20, 86400)
    period = "once" if body.product == "teacher" else body.period
    if body.product != "teacher" and period not in PERIOD_DAYS:
        raise HTTPException(400, "Choose monthly or yearly.")
    amount = price_of(body.product, period, "myr")
    with engine().begin() as c:
        old = c.execute(select(payments).where(payments.c.user_id == me.id, payments.c.status == "started", payments.c.product == body.product,
                                               payments.c.period == period)).mappings().first()
        if old:
            c.execute(update(payments).where(payments.c.id == old["id"]).values(method=body.method))
            p = {**dict(old), "method": body.method}
        else:
            code = "HT" + "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
            p = {"id": A.new_id(), "user_id": me.id, "product": body.product, "period": period, "amount": amount, "currency": "myr",
                 "method": body.method, "code": code, "payer": "", "note": "", "receipt": None, "status": "started", "admin_note": "",
                 "created": _now(), "decided": None}
            c.execute(insert(payments).values(**p))
    return {**_pay_json(p), **bank()}


class PaidIn(BaseModel):
    payer: str = Field(..., min_length=2, max_length=80)
    note: str = Field("", max_length=300)
    receipt: str | None = Field(None, max_length=1_400_000)      # a data: URL of a picture, about 1 MB at most


@router.post("/billing/manual/{pid}/paid")
def manual_paid(pid: str, body: PaidIn, me: A.Me = Depends(A.current)):
    """Step 2: "I've paid". The payment waits for the developer to see it in the bank and approve it."""
    if body.receipt and not body.receipt.startswith("data:image/"):
        raise HTTPException(400, "The receipt must be a picture.")
    with engine().begin() as c:
        p = c.execute(select(payments).where(payments.c.id == pid, payments.c.user_id == me.id)).mappings().first()
        if not p:
            raise HTTPException(404, "That payment isn't there.")
        if p["status"] not in ("started", "rejected"):
            raise HTTPException(409, "This payment was already sent in.")
        waiting = c.execute(select(func.count()).select_from(payments).where(payments.c.user_id == me.id, payments.c.status == "pending")).scalar() or 0
        if waiting >= 3:
            raise HTTPException(429, "You already have payments waiting to be checked.")
        c.execute(update(payments).where(payments.c.id == pid).values(status="pending", payer=body.payer.strip(), note=body.note.strip(),
                                                                      receipt=body.receipt, created=_now(), admin_note=""))
        out = dict(c.execute(select(payments).where(payments.c.id == pid)).mappings().first())
    return _pay_json(out)


@router.get("/admin/payments")
def admin_payments(me: A.Me = Depends(A.require_admin), status: str = "pending"):
    with engine().connect() as c:
        rows = c.execute(select(payments).where(payments.c.status == status).order_by(payments.c.created.desc()).limit(100)).mappings().all()
        people = {u["user_id"]: {"handle": u["handle"]} for u in c.execute(select(A.accounts.c.user_id, A.accounts.c.handle).where(
            A.accounts.c.user_id.in_([r["user_id"] for r in rows] or ["-"]))).mappings().all()}
        names = dict(c.execute(select(A.users.c.id, A.users.c.name).where(A.users.c.id.in_([r["user_id"] for r in rows] or ["-"]))).all())
    return {"items": [{**_pay_json(dict(r), full=True), "user": {**people.get(r["user_id"], {}), "name": names.get(r["user_id"], "")}} for r in rows]}


class DecideIn(BaseModel):
    action: Literal["approve", "reject"]
    note: str = Field("", max_length=300)


def grant_plan(c, uid: str, product: str, period: str, source: str = "manual") -> float:
    """Turns a plan on for the period paid for; time left on the same plan is kept."""
    acc = c.execute(select(A.accounts).where(A.accounts.c.user_id == uid)).mappings().first()
    start = _now()
    if acc["tier"] == product and (acc["tier_until"] or 0) > start and acc["tier_source"] in ("manual", "grant"):
        start = acc["tier_until"]
    until = start + PERIOD_DAYS[period] * 86400
    c.execute(update(A.accounts).where(A.accounts.c.user_id == uid).values(tier=product, tier_until=until, tier_source=source, pass_days=None))
    return until


@router.post("/admin/payments/{pid}")
def admin_decide(pid: str, body: DecideIn, me: A.Me = Depends(A.require_admin)):
    with engine().begin() as c:
        p = c.execute(select(payments).where(payments.c.id == pid)).mappings().first()
        if not p:
            raise HTTPException(404, "No such payment.")
        if p["status"] != "pending":
            raise HTTPException(409, "Already decided.")
        c.execute(update(payments).where(payments.c.id == pid).values(status="approved" if body.action == "approve" else "rejected",
                                                                      admin_note=body.note.strip(), decided=_now(), receipt=None))
        if body.action == "approve":
            if p["product"] == "teacher":
                pass                                             # handled below, outside this transaction
            else:
                grant_plan(c, p["user_id"], p["product"], p["period"])
            A.notify(c, p["user_id"], "paid_ok", product=p["product"], period=p["period"])
        else:
            A.notify(c, p["user_id"], "paid_no", product=p["product"], note=body.note.strip())
    if body.action == "approve" and p["product"] == "teacher":
        paid_hooks_run("teacher", p["user_id"], f"manual:{p['code']}")
    return {"ok": True}
