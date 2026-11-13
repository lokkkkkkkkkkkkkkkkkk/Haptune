"""Paying on the website: Stripe checkout and renewals, and DuitNow / bank transfer approved by the developer."""
import os
os.environ.setdefault("HAPTUNE_SIGNIN_REQUIRED", "0")   # these tests use guest accounts; test_hub.py checks the sign-in rule
import hashlib
import hmac
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "engine"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import academy  # noqa: E402
import accounts  # noqa: E402
import app as app_module  # noqa: E402
import billing  # noqa: E402
from app import app  # noqa: E402

client = TestClient(app)
WH = "whsec_test"


class FakeStripe:
    """Remembers what was asked and answers like Stripe for the few calls the server makes."""

    def __init__(self):
        self.calls = []
        self.subs = {}
        self.sessions = {}

    def __call__(self, method, path, data=None):
        self.calls.append((method, path, data))
        if (method, path) == ("POST", "/checkout/sessions"):
            sid = f"cs_test_{len(self.sessions) + 1}"
            self.sessions[sid] = {"id": sid, "url": f"https://checkout.stripe.com/c/pay/{sid}", "mode": data["mode"], "payment_status": "unpaid",
                                  "client_reference_id": data["client_reference_id"], "metadata": data["metadata"], "customer": None, "subscription": None}
            return self.sessions[sid]
        if method == "GET" and path.startswith("/checkout/sessions/"):
            return self.sessions[path.rsplit("/", 1)[1]]
        if method == "GET" and path.startswith("/subscriptions/"):
            return self.subs[path.rsplit("/", 1)[1]]
        if (method, path) == ("POST", "/billing_portal/sessions"):
            return {"url": "https://billing.stripe.com/p/session/test"}
        raise AssertionError(f"unexpected Stripe call {method} {path}")

    def pay(self, sid, period_end):
        """The person pays on Stripe's page: a subscription now exists."""
        s = self.sessions[sid]
        s.update(payment_status="paid", customer="cus_1", subscription="sub_1")
        self.subs["sub_1"] = {"id": "sub_1", "status": "active", "customer": "cus_1", "current_period_end": period_end, "metadata": s["metadata"]}
        return s


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    academy.reset_engine(f"sqlite:///{tmp_path}/b.db")
    app_module._limiter.hits.clear()
    accounts.limiter.hits.clear()
    monkeypatch.setenv("HAPTUNE_ADMIN_CODE", "let-me-in-please-123")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_x")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", WH)
    fake = FakeStripe()
    monkeypatch.setattr(billing, "stripe", fake)
    yield fake


def person(name="Aina"):
    r = client.post("/c/auth/guest", json={"name": name})
    return {"Authorization": f"Bearer {r.json()['token']}"}, r.json()["me"]


def dev():
    h, me = person("Lok")
    client.post("/c/me/dev", json={"code": "let-me-in-please-123"}, headers=h)
    return h, me


def webhook(event):
    body = json.dumps(event).encode()
    t = int(time.time())
    sig = hmac.new(WH.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return client.post("/c/billing/stripe/webhook", content=body, headers={"Stripe-Signature": f"t={t},v1={sig}", "Content-Type": "application/json"})


def test_card_checkout_turns_the_plan_on_and_renewals_keep_it(fresh):
    h, me = person()
    opt = client.get("/c/billing/options", headers=h).json()
    assert opt["stripe"] and opt["manual"]["account"] == "7647680094" and opt["manual"]["bank"] == "CIMB Bank" and not opt["manage"]
    r = client.post("/c/billing/stripe/checkout", json={"product": "pro", "period": "monthly", "currency": "myr"}, headers=h)
    assert r.status_code == 200 and r.json()["url"].startswith("https://checkout.stripe.com/")
    sent = fresh.calls[-1][2]
    assert sent["mode"] == "subscription" and sent["client_reference_id"] == me["id"]
    assert sent["line_items"][0]["price_data"] == {"currency": "myr", "unit_amount": 2990, "product_data": {"name": "Haptune Pro (monthly)"},
                                                    "recurring": {"interval": "month"}}
    assert "/app/?paid={CHECKOUT_SESSION_ID}" in sent["success_url"]
    sid = r.json()["id"]
    assert client.get("/c/me", headers=h).json()["tier"] == "free"                 # nothing until it is paid
    end = int(time.time()) + 30 * 86400
    sess = fresh.pay(sid, end)
    now = client.post("/c/billing/stripe/sync", json={"session": sid}, headers=h).json()
    assert now["tier"] == "pro" and now["tier_source"] == "stripe" and now["limits"]["read_pages"] >= 1
    assert client.get("/c/billing/options", headers=h).json()["manage"]
    assert client.post("/c/billing/stripe/portal", headers=h).json()["url"].startswith("https://billing.stripe.com/")
    # someone else can't claim this payment
    other, _ = person("Bala")
    assert client.post("/c/billing/stripe/sync", json={"session": sid}, headers=other).status_code == 403
    # a renewal: Stripe tells the server, the plan runs on
    fresh.subs["sub_1"]["current_period_end"] = end + 30 * 86400
    assert webhook({"type": "invoice.paid", "data": {"object": {"subscription": "sub_1"}}}).status_code == 200
    until = client.get("/c/me", headers=h).json()["tier_until"]
    assert until and until[:10] > time.strftime("%Y-%m-%d", time.gmtime(end + 20 * 86400))
    # cancelled and ended: back to Free
    fresh.subs["sub_1"]["status"] = "canceled"
    assert webhook({"type": "customer.subscription.deleted", "data": {"object": fresh.subs["sub_1"]}}).status_code == 200
    assert client.get("/c/me", headers=h).json()["tier"] == "free"
    assert sess["metadata"]["product"] == "pro"


def test_webhook_needs_stripes_signature(fresh):
    body = json.dumps({"type": "invoice.paid", "data": {"object": {"subscription": "sub_1"}}})
    assert client.post("/c/billing/stripe/webhook", content=body, headers={"Stripe-Signature": "t=1,v1=bad"}).status_code == 400
    assert client.post("/c/billing/stripe/webhook", content=body).status_code == 400
    t = int(time.time()) - 3600                                                    # an old, replayed message
    sig = hmac.new(WH.encode(), f"{t}.".encode() + body.encode(), hashlib.sha256).hexdigest()
    assert client.post("/c/billing/stripe/webhook", content=body, headers={"Stripe-Signature": f"t={t},v1={sig}"}).status_code == 400


def test_duitnow_or_bank_transfer_waits_for_the_developer(fresh):
    h, me = person()
    d, _ = dev()
    start = client.post("/c/billing/manual", json={"product": "plus", "period": "yearly", "method": "duitnow"}, headers=h).json()
    assert start["amount"] == "99.90" and start["account"] == "7647680094" and start["code"].startswith("HT") and start["status"] == "started"
    again = client.post("/c/billing/manual", json={"product": "plus", "period": "yearly", "method": "transfer"}, headers=h).json()
    assert again["code"] == start["code"]                                           # the same code until it is used
    assert client.get("/c/admin/payments", headers=d).json()["items"] == []        # not sent in yet
    assert client.post(f"/c/billing/manual/{start['id']}/paid", json={"payer": "A"}, headers=h).status_code == 422
    sent = client.post(f"/c/billing/manual/{start['id']}/paid", json={"payer": "Aina binti Ali", "receipt": "data:image/png;base64,AAAA"}, headers=h)
    assert sent.status_code == 200 and sent.json()["status"] == "pending"
    assert client.get("/c/me", headers=h).json()["tier"] == "free"
    assert client.get("/c/billing/options", headers=h).json()["mine"][0]["status"] == "pending"
    assert client.get("/c/admin/payments", headers=h).status_code == 403            # only the developer
    waiting = client.get("/c/admin/payments", headers=d).json()["items"]
    assert len(waiting) == 1 and waiting[0]["payer"] == "Aina binti Ali" and waiting[0]["user"]["handle"] == me["handle"] and waiting[0]["receipt"]
    assert client.post(f"/c/admin/payments/{start['id']}", json={"action": "approve"}, headers=d).json() == {"ok": True}
    now = client.get("/c/me", headers=h).json()
    assert now["tier"] == "plus" and now["tier_source"] == "manual"
    days = (time.mktime(time.strptime(now["tier_until"][:10], "%Y-%m-%d")) - time.time()) / 86400
    assert 360 < days < 370
    assert "paid_ok" in [n["kind"] for n in client.get("/c/notifications", headers=h).json()["items"]]
    assert client.post(f"/c/admin/payments/{start['id']}", json={"action": "approve"}, headers=d).status_code == 409


def test_a_rejected_transfer_can_be_sent_again(fresh):
    h, _ = person()
    d, _ = dev()
    p = client.post("/c/billing/manual", json={"product": "pro", "period": "monthly"}, headers=h).json()
    client.post(f"/c/billing/manual/{p['id']}/paid", json={"payer": "Aina"}, headers=h)
    client.post(f"/c/admin/payments/{p['id']}", json={"action": "reject", "note": "No transfer with this code yet."}, headers=d)
    mine = client.get("/c/billing/options", headers=h).json()["mine"][0]
    assert mine["status"] == "rejected" and "No transfer" in mine["admin_note"] and client.get("/c/me", headers=h).json()["tier"] == "free"
    assert client.post(f"/c/billing/manual/{p['id']}/paid", json={"payer": "Aina", "note": "Sent at 3 pm"}, headers=h).json()["status"] == "pending"


def test_card_payments_say_so_when_not_switched_on(fresh, monkeypatch):
    monkeypatch.delenv("STRIPE_SECRET_KEY")
    monkeypatch.undo()                                                              # the real billing.stripe again
    os.environ.pop("STRIPE_SECRET_KEY", None)
    h, _ = person()
    assert client.get("/c/billing/options").json()["stripe"] is False
    assert client.post("/c/billing/stripe/checkout", json={"product": "plus"}, headers=h).status_code == 503
