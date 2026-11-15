"""Owner, developers and Developer mode; 2-step verification; scopes on every admin endpoint; the audit log;
analytics collection and the dashboard (also with 100k events); feature flags; sessions; data export."""
import json
import os
import random
import sys
import time

os.environ.setdefault("HAPTUNE_DATA", "")
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))

import pytest
from fastapi.testclient import TestClient

import academy
import accounts as A
import analytics as AN
import app as app_module
import testkit
from app import app

client = TestClient(app)
OWNER = "owner@melovyn.test"


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    academy.reset_engine(f"sqlite:///{tmp_path/'a.db'}")
    monkeypatch.setenv("HAPTUNE_OWNER_EMAILS", OWNER)
    monkeypatch.setenv("HAPTUNE_SIGNIN_REQUIRED", "0")
    A.limiter.hits.clear()
    app_module._limiter.hits.clear()
    yield
    A.limiter.hits.clear()


def guest(name="Ana"):
    r = client.post("/c/auth/guest", json={"name": name})
    return {"Authorization": "Bearer " + r.json()["token"]}


def google(monkeypatch, name, email, sub=None):
    h = guest(name)
    monkeypatch.setattr(A, "verify_google", lambda cred: {"sub": sub or email, "email": email, "email_verified": "true", "given_name": name})
    r = client.post("/c/auth/google", json={"credential": "c" * 40}, headers=h)
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}, r.json()["me"]


def registered(name, handle):
    h = guest(name)
    assert client.post("/c/auth/password", json={"handle": handle, "password": "longenough1"}, headers=h).status_code == 200
    return h


def owner(monkeypatch):
    h, me = google(monkeypatch, "Lok", OWNER)
    assert me["staff"]["role"] == "owner" and me["staff"]["dev_mode"] is False and me["tier"] != "dev"
    st = testkit.dev_mode_on(client, h)
    assert st["me"]["staff"]["dev_mode"] and st["me"]["tier"] == "dev"
    return h, st["secret"]


ADMIN_GETS = {   # endpoint -> scope it needs
    "/c/admin/overview": "read_analytics", "/c/admin/analytics/overview": "read_analytics", "/c/admin/analytics/activity": "read_analytics",
    "/c/admin/analytics/funnels": "read_analytics", "/c/admin/analytics/features": "read_analytics", "/c/admin/analytics/errors": "read_analytics",
    "/c/admin/users": "manage_users", "/c/admin/payments": "manage_users", "/c/admin/feedback": "manage_users",
    "/c/admin/flags": "feature_flags", "/c/admin/reports": "moderate_stage", "/c/admin/sounds": "moderate_stage",
    "/c/admin/teachers": "verify_teachers", "/c/admin/tutors": "verify_teachers",
    "/c/admin/access": "owner", "/c/admin/audit": "owner",
}


def test_owner_needs_two_step_and_developer_mode(monkeypatch):
    h, me = google(monkeypatch, "Lok", OWNER)
    assert client.get("/c/admin/analytics/overview", headers=h).json()["detail"]["code"] == "dev_mode_off"
    assert client.post("/c/me/devmode", json={"on": True, "code": "123456"}, headers=h).json()["detail"]["code"] == "totp_required"
    secret = testkit.two_step(client, h)
    assert client.post("/c/me/devmode", json={"on": True, "code": "000000"}, headers=h).status_code == 400
    assert client.post("/c/me/2fa/disable", json={"code": A.totp(secret, 1)}, headers=h).status_code == 409    # staff keep it
    testkit.dev_mode_on(client, h, secret, offset=1)
    for path in ADMIN_GETS:
        assert client.get(path, headers=h).status_code == 200, path                                           # the owner: everything
    # the same account on another device is not in Developer mode
    monkeypatch.setattr(A, "verify_google", lambda cred: {"sub": OWNER, "email": OWNER, "email_verified": "true"})
    other = {"Authorization": "Bearer " + client.post("/c/auth/google", json={"credential": "c" * 40}).json()["token"]}
    assert client.get("/c/admin/users", headers=other).status_code == 403
    # off again
    assert client.post("/c/me/devmode", json={"on": False}, headers=h).json()["staff"]["dev_mode"] is False
    assert client.get("/c/admin/users", headers=h).status_code == 403
    # a used code can't be used again
    st = client.post("/c/me/devmode", json={"on": True, "code": A.totp(secret, 1)}, headers=h)
    assert st.status_code == 400
    # an email that isn't verified by Google never makes an owner
    monkeypatch.setattr(A, "verify_google", lambda cred: {"sub": "x2", "email": OWNER, "email_verified": "false"})
    r = client.post("/c/auth/google", json={"credential": "c" * 40}, headers=guest("Fake"))
    assert r.json()["me"]["staff"] is None


def test_recovery_codes_work_once(monkeypatch):
    h, _ = google(monkeypatch, "Lok", OWNER)
    secret = client.post("/c/me/2fa/setup", headers=h).json()["secret"]
    codes = client.post("/c/me/2fa/enable", json={"code": A.totp(secret)}, headers=h).json()["recovery_codes"]
    assert len(codes) == 10
    assert client.post("/c/me/devmode", json={"on": True, "code": codes[0]}, headers=h).status_code == 200
    client.post("/c/me/devmode", json={"on": False}, headers=h)
    assert client.post("/c/me/devmode", json={"on": True, "code": codes[0]}, headers=h).status_code == 400
    assert client.get("/c/me/2fa", headers=h).json()["recovery_left"] == 9


def test_role_matrix_scopes_and_instant_revoke(monkeypatch):
    o, _ = owner(monkeypatch)
    dh = registered("Dev", "dev_amy")
    plain = registered("User", "plain_user")
    # nobody else gets in
    for path in ADMIN_GETS:
        assert client.get(path, headers=plain).status_code == 403
    # one scope
    r = client.post("/c/admin/access", json={"handle": "dev_amy", "scopes": ["read_analytics"], "days": 7, "reason": "helps with stats"}, headers=o)
    assert r.status_code == 200, r.text
    me = client.get("/c/me", headers=dh).json()
    assert me["staff"]["role"] == "developer" and me["staff"]["scopes"] == ["read_analytics"] and me["staff"]["expires"]
    assert "dev_access" in [n["kind"] for n in client.get("/c/notifications", headers=dh).json()["items"]]
    testkit.dev_mode_on(client, dh)
    for path, scope in ADMIN_GETS.items():
        want = 200 if scope == "read_analytics" else 403
        assert client.get(path, headers=dh).status_code == want, (path, scope)
    # a developer can't touch the owner, or grant access
    assert client.post("/c/admin/access", json={"handle": "plain_user", "scopes": ["manage_users"], "days": 1, "reason": "nope"}, headers=dh).status_code == 403
    # more scopes, then revoke: the next call is refused
    client.post("/c/admin/access", json={"handle": "dev_amy", "scopes": ["read_analytics", "manage_users"], "days": 0, "reason": "support"}, headers=o)
    assert client.get("/c/admin/users", headers=dh).status_code == 403                                  # new scopes: Developer mode again
    assert client.delete("/c/admin/access/dev_amy", headers=o).status_code == 200
    assert client.get("/c/admin/analytics/overview", headers=dh).status_code == 403
    assert client.get("/c/me", headers=dh).json()["staff"] is None
    # an expired grant counts for nothing
    client.post("/c/admin/access", json={"handle": "dev_amy", "scopes": ["read_analytics"], "days": 1, "reason": "short"}, headers=o)
    with academy.engine().begin() as c:
        c.execute(A.dev_grants.update().values(expires=time.time() - 5))
    assert client.get("/c/me", headers=dh).json()["staff"] is None


def test_the_owner_cannot_be_demoted_or_removed(monkeypatch):
    o, _ = owner(monkeypatch)
    oh = client.get("/c/me", headers=o).json()["handle"]
    dh = registered("Dev", "dev_bob")
    client.post("/c/admin/access", json={"handle": "dev_bob", "scopes": list(A.SCOPES), "days": 0, "reason": "all"}, headers=o)
    testkit.dev_mode_on(client, dh)
    assert client.delete(f"/c/admin/access/{oh}", headers=o).status_code == 403
    assert client.post("/c/admin/access", json={"handle": oh, "scopes": ["read_analytics"], "days": 1, "reason": "testing"}, headers=o).status_code == 400
    assert client.post(f"/c/admin/users/{oh}/suspend", json={"on": True}, headers=dh).status_code == 403
    assert client.post(f"/c/admin/users/{oh}/delete", json={"confirm": oh}, headers=dh).status_code == 403
    assert client.post(f"/c/admin/users/{oh}/role", json={"role": "banned"}, headers=dh).status_code in (403, 404, 422)
    # a developer can't act on another developer; the owner can
    eh = registered("Eve", "dev_eve")
    client.post("/c/admin/access", json={"handle": "dev_eve", "scopes": ["read_analytics"], "days": 0, "reason": "testing"}, headers=o)
    assert client.post("/c/admin/users/dev_eve/suspend", json={"on": True}, headers=dh).status_code == 403
    assert client.post("/c/admin/users/dev_eve/suspend", json={"on": True}, headers=o).status_code == 200
    assert client.get("/c/me", headers=eh).status_code == 403                                             # suspended
    # the old "admin" role can't be given from the app any more
    assert client.post("/c/admin/users/plain/role", json={"role": "admin"}, headers=o).status_code == 422
    # the old developer code is retired once there is an owner
    monkeypatch.setenv("HAPTUNE_ADMIN_CODE", "let-me-in-please-123")
    assert client.post("/c/me/dev", json={"code": "let-me-in-please-123"}, headers=guest()).status_code == 410


def test_user_actions_and_audit_for_every_one(monkeypatch):
    o, _ = owner(monkeypatch)
    u = registered("Mei", "mei_ling")
    assert [x["handle"] for x in client.get("/c/admin/users?q=mei", headers=o).json()["items"]] == ["mei_ling"]
    assert client.get("/c/admin/users?who=all", headers=o).json()["total"] > client.get("/c/admin/users", headers=o).json()["total"] - 1
    steps = [
        ("post", "/c/admin/users/mei_ling/plan", {"tier": "pro", "days": 0}, "plan_change"),
        ("post", "/c/admin/users/mei_ling/teacher", {"on": True}, "teacher_on"),
        ("post", "/c/admin/users/mei_ling/message", {"text": "Welcome to the beta!"}, "message"),
        ("get", "/c/admin/users/mei_ling", None, "viewed_user"),
        ("get", "/c/admin/users/mei_ling/export", None, "export_user"),
        ("post", "/c/admin/users/mei_ling/suspend", {"on": True}, "suspend"),
        ("post", "/c/admin/users/mei_ling/suspend", {"on": False}, "unsuspend"),
        ("post", "/c/admin/flags/hapi", {"state": "beta", "percent": 50, "users": ["mei_ling"]}, "feature_flag"),
    ]
    for method, path, body, action in steps:
        r = getattr(client, method)(path, json=body, headers=o) if body is not None else client.get(path, headers=o)
        assert r.status_code == 200, (path, r.text)
        top = client.get("/c/admin/audit?limit=1", headers=o).json()["items"][0]
        assert top["action"] == action, (path, top)
    prof = client.get("/c/admin/users/mei_ling", headers=o).json()
    assert prof["plan"] == "pro" and prof["role"] == "teacher"
    assert client.get("/c/me", headers=u).json()["tier"] == "pro"
    assert "staff_message" in [n["kind"] for n in client.get("/c/notifications", headers=u).json()["items"]]
    # delete: the username must be typed again
    assert client.post("/c/admin/users/mei_ling/delete", json={"confirm": "wrong"}, headers=o).status_code == 400
    assert client.post("/c/admin/users/mei_ling/delete", json={"confirm": "mei_ling"}, headers=o).status_code == 200
    assert client.get("/c/admin/audit?action=delete_user", headers=o).json()["total"] == 1
    # the audit log is append-only (no way to change or delete) and exports as CSV
    assert client.delete("/c/admin/audit", headers=o).status_code == 405
    csv = client.get("/c/admin/audit/export", headers=o)
    assert csv.headers["content-type"].startswith("text/csv") and "plan_change" in csv.text


def test_events_flags_sessions_and_export(monkeypatch):
    o, _ = owner(monkeypatch)
    u = registered("Sam", "sam_piano")
    tok = u["Authorization"].split()[1]
    batch = {"device": "dev123", "token": tok, "platform": "android", "lang": "en-MY", "events": [
        {"name": "session_start"}, {"name": "screen_view", "screen": "summary"}, {"name": "screen_time", "screen": "summary", "value": 90},
        {"name": "piece_open", "label": "Ode to Joy"}, {"name": "play_along_start"}, {"name": "play_along_finish", "value": 88, "label": "Ode to Joy"},
        {"name": "error", "label": "TypeError: x is undefined", "screen": "piece", "props": {"ua": "Pixel 8"}},
        {"name": "session_end", "value": 600}, {"name": "not_allowed"}, {"name": "screen_view", "screen": "x" * 39, "props": {"big": "y" * 5000}}]}
    r = client.post("/c/events", content=json.dumps(batch), headers={"content-type": "text/plain"})
    assert r.json()["kept"] == 9                                                        # the unknown name is dropped
    with academy.engine().connect() as c:
        rows = c.execute(AN.events.select()).mappings().all()
        assert {x["country"] for x in rows if x["platform"] == "android"} == {"MY"} and not any("ip" in json.dumps(dict(x), default=str).lower() for x in rows if x["props"])
        assert [x for x in rows if x["screen"].startswith("xxx")][0]["props"] is None    # props too big
    ov = client.get("/c/admin/analytics/overview", headers=o).json()
    assert ov["active"]["dau"] >= 1 and ov["platforms"].get("android") == 1 and ov["avg_session_min"] == 10.0 and ov["pieces_played"] == 1
    assert ov["countries"][0]["country"] == "MY" and ov["signin_methods"]["google"] == 1
    funnel = {f["id"]: f for f in client.get("/c/admin/analytics/funnels", headers=o).json()["funnels"]}
    assert [s["people"] for s in funnel["practise"]["steps"]][:3] == [1, 1, 1]
    feats = client.get("/c/admin/analytics/features", headers=o).json()
    assert feats["screens"][0]["screen"] == "summary" and feats["screens"][0]["minutes"] == 1.5
    errs = client.get("/c/admin/analytics/errors", headers=o).json()["items"]
    assert errs[0]["message"].startswith("TypeError") and errs[0]["who"] == ["sam_piano"]
    act = client.get("/c/admin/analytics/activity?name=piece_open", headers=o).json()
    assert act["items"][0]["who"] == "sam_piano" and act["items"][0]["label"] == "Ode to Joy"
    prof = client.get("/c/admin/users/sam_piano", headers=o).json()
    assert prof["pieces"] == ["Ode to Joy"] and prof["time_by_screen"]["summary"] == 1.5 and prof["errors"]
    # flags: off for everyone but named people; the app reads them
    client.post("/c/admin/flags/sounds", json={"state": "off", "users": ["sam_piano"]}, headers=o)
    assert client.get("/c/flags", headers=u).json()["flags"]["sounds"] == "on"
    assert client.get("/c/flags", headers=guest()).json()["flags"]["sounds"] == "off"
    assert client.get("/c/flags").json()["flags"]["hapi"] == "on"
    # sessions: list and sign another device out
    client.post("/c/auth/login", json={"handle": "sam_piano", "password": "longenough1", "device": "PC"})
    items = client.get("/c/me/sessions", headers=u).json()["items"]
    assert [x["label"] for x in items][:2] == ["The device this account was made on", "PC"] and items[0]["current"]
    assert client.delete(f"/c/me/sessions/{items[1]['id']}", headers=u).status_code == 200
    assert len(client.get("/c/me/sessions", headers=u).json()["items"]) == 1
    # your own data, then deleting the account removes the events too
    data = client.get("/c/me/export", headers=u).json()
    assert data["account"]["handle"] == "sam_piano" and "pw_hash" not in data["account"] and len(data["usage_events"]) == 10 and "sign_in" in [e["name"] for e in data["usage_events"]]
    sam = client.get("/c/me", headers=u).json()["id"]
    client.delete("/c/me", headers=u)
    with academy.engine().connect() as c:
        assert not c.execute(AN.events.select().where(AN.events.c.user_id == sam)).first()


def test_raw_events_are_kept_180_days():
    now = time.time()
    with academy.engine().begin() as c:
        AN.ingest(c, [{"ts": now - 200 * 86400, "actor": "d:a", "user_id": None, "name": "screen_view", "screen": "x", "label": "", "value": None, "props": None, "platform": "web", "country": ""},
                      {"ts": now - 10, "actor": "d:a", "user_id": None, "name": "screen_view", "screen": "x", "label": "", "value": None, "props": None, "platform": "web", "country": ""}])
        assert AN.purge_old(c, now) == 1
        assert c.execute(AN.counters.select()).first()                                   # roll-ups stay


def test_dashboard_is_fast_with_100k_events(monkeypatch):
    o, _ = owner(monkeypatch)
    rnd = random.Random(7)
    now = time.time()
    names = ["screen_view", "screen_time", "piece_open", "play_along_start", "play_along_finish", "session_start", "session_end", "error", "post_created"]
    screens = ["summary", "library", "piece", "write", "community", "academy", "sound"]
    rows = []
    for i in range(100_000):
        n = rnd.choice(names)
        rows.append({"ts": now - rnd.random() * 90 * 86400, "actor": f"d:{rnd.randint(1, 3000)}", "user_id": None, "name": n,
                     "screen": rnd.choice(screens) if n.startswith("screen") or n == "error" else "", "label": f"Error {rnd.randint(1, 30)}" if n == "error" else (f"Piece {rnd.randint(1, 400)}" if n == "piece_open" else ""),
                     "value": rnd.random() * 600 if n in ("screen_time", "session_end", "play_along_finish") else None, "props": None,
                     "platform": rnd.choice(["web", "android", "homescreen"]), "country": rnd.choice(["MY", "SG", "TW", "US", ""])})
    with academy.engine().begin() as c:
        for i in range(0, len(rows), 5000):
            AN.ingest(c, rows[i:i + 5000])
    for path in ["/c/admin/analytics/overview", "/c/admin/analytics/activity", "/c/admin/analytics/funnels", "/c/admin/analytics/features",
                 "/c/admin/analytics/errors", "/c/admin/users?who=all"]:
        t0 = time.perf_counter()
        r = client.get(path, headers=o)
        ms = (time.perf_counter() - t0) * 1000
        assert r.status_code == 200, path
        print(f"{path}: {ms:.0f} ms")
        assert ms < 1500, f"{path} took {ms:.0f} ms"
    assert client.get("/c/admin/analytics/overview", headers=o).json()["active"]["mau"] > 2500
