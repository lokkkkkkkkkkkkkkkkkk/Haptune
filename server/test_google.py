"""Google connections with Google itself replaced by a fake (google_link._http): incremental scopes, encrypted
refresh tokens, revoking, Calendar events with Meet links that sync back, Drive uploads, contacts."""
import base64
import json
import os
import sys
import time

os.environ.setdefault("HAPTUNE_DATA", "")
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))

import pytest
from fastapi.testclient import TestClient

import academy
import accounts
import google_link as G
import accounts as A
from sqlalchemy import select
from app import app

client = TestClient(app)


class FakeGoogle:
    def __init__(self):
        self.calls = []
        self.events = {}
        self.grant = set(G.SCOPES.values())

    def __call__(self, method, url, *, token=None, data=None, form=None, headers=None, timeout=20):
        self.calls.append((method, url.split("?")[0], token, form))
        if url == G.TOKEN_URL and form["grant_type"] == "authorization_code":
            want = {"code-cal-1234": [G.SCOPES["calendar"]], "code-drive-1234": [G.SCOPES["drive"]], "code-none-1234": [],
                    "code-all-1234": list(G.SCOPES.values()), "code-two-1234": [G.SCOPES["calendar"], G.SCOPES["drive"]]}[form["code"]]
            return {"access_token": "at-1", "expires_in": 3600, "refresh_token": "rt-secret", "scope": " ".join(["openid", "email", *want])}
        if url == G.TOKEN_URL:
            assert form["refresh_token"] == "rt-secret"
            return {"access_token": "at-2", "expires_in": 3600}
        if url == G.REVOKE_URL:
            return {}
        if url.startswith(G.CAL) and method == "POST":
            ev = json.loads(data)
            eid = f"ev{len(self.events) + 1}"
            self.events[eid] = {**ev, "id": eid, "hangoutLink": f"https://meet.google.com/{eid}", "status": "confirmed"}
            return self.events[eid]
        if url.startswith(G.CAL) and method == "GET":
            return self.events.get(url.split("/")[-1].split("?")[0])
        if url.startswith(G.CAL) and method in ("PATCH", "DELETE"):
            return {}
        if url.startswith("https://www.googleapis.com/upload/drive"):
            assert b"Content-Type: application/pdf" in data
            return {"id": "f1", "name": "Report.pdf", "webViewLink": "https://drive.google.com/file/d/f1"}
        if url.startswith(G.PEOPLE.split("?")[0]):
            return {"connections": [{"names": [{"displayName": "Ben Ong"}], "emailAddresses": [{"value": "ben@gmail.com"}]},
                                    {"names": [{"displayName": "Mei"}], "emailAddresses": [{"value": "mei@gmail.com"}]}]}
        raise AssertionError(f"unexpected call {method} {url}")


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("HAPTUNE_SIGNIN_REQUIRED", "1")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "shh")
    monkeypatch.setenv("HAPTUNE_TOKEN_KEY", "a-long-random-token-key")
    academy.reset_engine(f"sqlite:///{tmp_path/'g.db'}")
    fake = FakeGoogle()
    monkeypatch.setattr(G, "_http", fake)
    G._access.clear()
    yield fake
    accounts.limiter.hits.clear()


def user(monkeypatch, sub, email, name):
    h = {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": name}).json()["token"]}
    monkeypatch.setattr(accounts, "verify_google", lambda cred: {"sub": sub, "email": email, "email_verified": "true", "given_name": name})
    client.post("/c/auth/google", json={"credential": "c" * 40}, headers=h)
    return h


def test_only_the_scope_a_feature_needs_and_only_these_three():
    assert set(G.SCOPES) == {"calendar", "drive", "contacts"}
    assert G.SCOPES["drive"].endswith("drive.file")             # only files Haptune makes, never the whole Drive
    assert not any(s.endswith("/calendar") or s.endswith("/drive") for s in G.SCOPES.values())
    src = open(os.path.join(os.path.dirname(__file__), "google_link.py")).read()
    for f in G.SCOPES:                                          # every scope is used by an endpoint
        assert f'access_token(me.id, "{f}")' in src or f'access_token(uid, "{f}")' in src


def test_connect_lists_and_revokes(fresh, monkeypatch):
    h = user(monkeypatch, "g1", "t@gmail.com", "Ms Tan")
    st = client.get("/c/google/connections", headers=h).json()
    assert st["available"] and not any(f["linked"] for f in st["features"])
    # a code for calendar only links calendar
    st = client.post("/c/google/connect", json={"code": "code-cal-1234", "feature": "calendar"}, headers=h).json()
    assert {f["id"]: f["linked"] for f in st["features"]} == {"calendar": True, "drive": False, "contacts": False}
    # Google said no to the box: nothing changes
    r = client.post("/c/google/connect", json={"code": "code-none-1234", "feature": "drive"}, headers=h)
    assert r.status_code == 400 and r.json()["detail"]["code"] == "scope_not_granted"
    # the refresh token is stored encrypted, never as plain text
    row = G.link_of(client.get("/c/me", headers=h).json()["id"])
    assert "rt-secret" not in row["refresh_enc"] and G.decrypt(row["refresh_enc"]) == "rt-secret"
    # drive needs its own permission
    pdf = base64.b64encode(b"%PDF-1.4 report").decode()
    r = client.post("/c/google/drive/upload", json={"name": "Report.pdf", "mime": "application/pdf", "data_b64": pdf}, headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "google_scope_needed" and r.json()["detail"]["feature"] == "drive"
    client.post("/c/google/connect", json={"code": "code-drive-1234", "feature": "drive"}, headers=h)
    r = client.post("/c/google/drive/upload", json={"name": "Report.pdf", "mime": "application/pdf", "data_b64": pdf}, headers=h)
    assert r.json()["link"].startswith("https://drive.google.com/")
    assert client.post("/c/google/drive/upload", json={"name": "x.html", "mime": "text/html", "data_b64": pdf}, headers=h).status_code == 422
    # revoke one, then all (which also revokes at Google)
    st = client.delete("/c/google/connections/drive", headers=h).json()
    assert [f["id"] for f in st["features"] if f["linked"]] == ["calendar"]
    st = client.delete("/c/google/connections/all", headers=h).json()
    assert not any(f["linked"] for f in st["features"])
    assert any(c[1] == G.REVOKE_URL for c in fresh.calls)


def test_not_set_up_and_not_signed_in(monkeypatch):
    g = {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": "G"}).json()["token"]}
    assert client.post("/c/google/connect", json={"code": "code-cal-1234", "feature": "calendar"}, headers=g).status_code == 401
    assert client.post("/c/google/connect", json={"code": "code-cal-1234", "feature": "photos"}, headers=g).status_code == 422
    monkeypatch.delenv("GOOGLE_CLIENT_SECRET")
    h = user(monkeypatch, "g9", "z@gmail.com", "Z")
    assert client.post("/c/google/connect", json={"code": "code-cal-1234", "feature": "calendar"}, headers=h).status_code == 503


def test_class_session_makes_a_meet_event_and_syncs_back(fresh, monkeypatch):
    t = user(monkeypatch, "t1", "teacher@gmail.com", "Ms Tan")
    cl = client.post("/academy/classes", json={"name": "Piano A"}, headers=t).json()["class"]
    s = user(monkeypatch, "s1", "ben@gmail.com", "Ben")
    client.post("/academy/join", json={"code": cl["join_code"]}, headers=s)
    start = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400))
    # without Calendar the session is still made (and is in the .ics file)
    r = client.post(f"/academy/classes/{cl['id']}/sessions", json={"title": "Lesson 1", "start": start, "minutes": 45}, headers=t).json()
    assert r["calendar"] is False and r["session"]["meet_url"] == ""
    # with Calendar: a Google event with a Meet link, the student invited, reminders set
    client.post("/c/google/connect", json={"code": "code-cal-1234", "feature": "calendar"}, headers=t)
    r = client.post(f"/academy/classes/{cl['id']}/sessions", json={"title": "Lesson 2", "start": start, "minutes": 60}, headers=t).json()
    assert r["calendar"] and r["session"]["meet_url"].startswith("https://meet.google.com/")
    ev = fresh.events["ev1"]
    assert ev["attendees"] == [{"email": "ben@gmail.com"}] and ev["conferenceData"]["createRequest"]["conferenceSolutionKey"]["type"] == "hangoutsMeet"
    assert {o["method"] for o in ev["reminders"]["overrides"]} == {"popup", "email"}
    # the teacher cancels it in Google Calendar: the class sees it cancelled
    fresh.events["ev1"]["status"] = "cancelled"
    import classroom
    with academy.engine().begin() as c:
        c.execute(classroom.sessions_t.update().values(synced=0))
    ses = client.get(f"/academy/classes/{cl['id']}/sessions", headers=s).json()["sessions"]
    assert [x["cancelled"] for x in ses] == [False, True]
    ics = client.get(f"/academy/classes/{cl['id']}/sessions.ics", headers=s)
    assert ics.headers["content-type"].startswith("text/calendar") and ics.text.count("BEGIN:VEVENT") == 2 and "STATUS:CANCELLED" in ics.text
    assert "TRIGGER:-PT30M" in ics.text
    # students cannot schedule
    assert client.post(f"/academy/classes/{cl['id']}/sessions", json={"title": "x", "start": start}, headers=s).status_code == 403
    kinds = [n["kind"] for n in client.get("/c/notifications", headers=s).json()["items"]]
    assert "class_session" in kinds


def test_contacts_for_inviting(fresh, monkeypatch):
    h = user(monkeypatch, "c1", "t@gmail.com", "T")
    assert client.get("/c/google/contacts", headers=h).status_code == 409
    with academy.engine().begin() as c:
        c.execute(G.links.insert().values(user_id=client.get("/c/me", headers=h).json()["id"], scopes=["contacts"], refresh_enc=G.encrypt("rt-secret"),
                                          email="t@gmail.com", created=0, updated=0))
    got = client.get("/c/google/contacts", params={"q": "ben"}, headers=h).json()["contacts"]
    assert got == [{"name": "Ben Ong", "email": "ben@gmail.com"}]


def test_all_at_once_keeps_what_was_allowed(monkeypatch):
    h = user(monkeypatch, "g-all", "all@gmail.com", "Ana")
    r = client.get("/c/google/connections", headers=h).json()
    assert r["signed_in_google"] and not r["all_linked"]
    # Google lets people untick one: the other two are kept
    r = client.post("/c/google/connect", json={"code": "code-two-1234", "feature": "all"}, headers=h).json()
    assert {f["id"] for f in r["features"] if f["linked"]} == {"calendar", "drive"} and not r["all_linked"]
    r = client.post("/c/google/connect", json={"code": "code-all-1234", "feature": "all"}, headers=h).json()
    assert r["all_linked"]
    assert client.post("/c/google/connect", json={"code": "code-none-1234", "feature": "all"}, headers=h).status_code == 400


def test_phone_app_links_through_a_one_time_ticket(monkeypatch):
    h = user(monkeypatch, "g-tk", "tk@gmail.com", "Tan")
    tk = client.post("/c/google/ticket", headers=h).json()["ticket"]
    info = client.get(f"/c/google/ticket/{tk}").json()
    assert info["email"] == "tk@gmail.com" and info["client_id"].startswith("cid")
    # the website, signed in as nobody, links the permissions to the phone's account
    r = client.post("/c/google/connect", json={"code": "code-all-1234", "feature": "all", "ticket": tk})
    assert r.status_code == 200, r.text
    assert client.get("/c/google/connections", headers=h).json()["all_linked"]
    # once only
    assert client.post("/c/google/connect", json={"code": "code-all-1234", "feature": "all", "ticket": tk}).status_code == 401
    assert client.get(f"/c/google/ticket/{tk}").status_code == 404
    # guests can't make tickets
    g = {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": "G"}).json()["token"]}
    assert client.post("/c/google/ticket", headers=g).status_code in (401, 403)


def test_staff_check_says_why(monkeypatch):
    monkeypatch.setenv("HAPTUNE_OWNER_EMAILS", "boss@gmail.com")
    h = user(monkeypatch, "g-x", "other@gmail.com", "Oth")
    assert client.get("/c/me/staff-check", headers=h).json()["reason"] == "other_email"
    h2 = user(monkeypatch, "g-boss", "Boss@gmail.com", "Boss")
    assert client.get("/c/me/staff-check", headers=h2).json()["reason"] == "ok"
    g = {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": "G"}).json()["token"]}
    assert client.get("/c/me/staff-check", headers=g).json()["reason"] == "not_google"
    monkeypatch.setenv("HAPTUNE_OWNER_EMAILS", "")
    assert client.get("/c/me/staff-check", headers=h).json()["reason"] == "owner_not_set"


def test_owner_locked_out_by_a_changed_key_can_set_2fa_up_again(monkeypatch):
    monkeypatch.setenv("HAPTUNE_OWNER_EMAILS", "boss2@gmail.com")
    h = user(monkeypatch, "g-boss2", "boss2@gmail.com", "Boss")
    sec = client.post("/c/me/2fa/setup", headers=h).json()["secret"]
    assert client.post("/c/me/2fa/enable", json={"code": accounts.totp(sec)}, headers=h).status_code == 200
    assert client.post("/c/me/2fa/setup", headers=h).status_code == 409
    monkeypatch.setenv("HAPTUNE_TOKEN_KEY", "another-long-random-key")          # the secret can't be read any more
    assert client.get("/c/me/staff-check", headers=h).json()["totp_readable"] is False
    sec2 = client.post("/c/me/2fa/setup", headers=h).json()["secret"]
    assert client.post("/c/me/2fa/enable", json={"code": accounts.totp(sec2)}, headers=h).status_code == 200


def _fake_id(monkeypatch, sub, email):
    monkeypatch.setattr(accounts, "verify_google", lambda tok: {"sub": sub, "email": email, "email_verified": "true", "given_name": "Yu"})


def test_sign_in_with_a_popup_code_links_the_account_on_this_device(monkeypatch, fresh):
    # Google's token endpoint answers a sign-in code with an ID token (basic scopes only)
    real = fresh.__call__
    def fake(method, url, **kw):
        if url == G.TOKEN_URL and kw["form"].get("code") == "code-signin-1234":
            assert kw["form"]["redirect_uri"] == "postmessage"
            return {"access_token": "at-s", "expires_in": 3600, "id_token": "idtok", "scope": "openid email profile"}
        return real(method, url, **kw)
    monkeypatch.setattr(G, "_http", fake)
    h = {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": "Lok"}).json()["token"]}
    client.post("/c/auth/password", json={"handle": "lokk", "password": "a-long-password"}, headers=h)
    _fake_id(monkeypatch, "g-yslok", "yslok@gmail.com")
    r = client.post("/c/auth/google/code", json={"code": "code-signin-1234"}, headers=h)
    assert r.status_code == 200, r.text
    me = r.json()["me"]
    assert me["handle"] == "lokk" and me["google"] and me["email"] == "yslok@gmail.com"     # linked, same account
    # someone else, no account here: a new account
    r2 = client.post("/c/auth/google/code", json={"code": "code-signin-1234"}).json()
    assert r2["me"]["handle"] == "lokk"                                                      # same Google account -> same person
    assert G.link_of(me["id"]) is None                                                         # basic scopes: nothing to keep


def test_sign_in_by_redirect_and_for_the_phone_app(monkeypatch, fresh):
    real = fresh.__call__
    def fake(method, url, **kw):
        if url == G.TOKEN_URL and kw["form"].get("code") == "code-redirect-1234":
            assert kw["form"]["redirect_uri"].endswith("/c/auth/google/callback")
            return {"access_token": "at-r", "expires_in": 3600, "id_token": "idtok", "refresh_token": "rt-secret", "scope": "openid email " + G.SCOPES["drive"]}
        return real(method, url, **kw)
    monkeypatch.setattr(G, "_http", fake)
    monkeypatch.setenv("HAPTUNE_SITE_URL", "https://haptune.name.my")
    _fake_id(monkeypatch, "g-new", "new@gmail.com")
    # an open redirect is refused
    assert client.post("/c/auth/google/start", json={"return_to": "https://evil.example/app/"}).status_code == 400
    url = client.post("/c/auth/google/start", json={"return_to": "https://haptune.name.my/app/"}).json()["url"]
    q = dict(x.split("=", 1) for x in url.split("?", 1)[1].split("&"))
    assert "scope=openid+email+profile" in url and q["prompt"] == "select_account"
    r = client.get(f"/c/auth/google/callback?state={q['state']}&code=code-redirect-1234", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"].startswith("https://haptune.name.my/app/#gsignin=")
    one = r.headers["location"].split("#gsignin=")[1]
    me = client.post("/c/auth/google/finish", json={"code": one}).json()["me"]
    assert me["email"] == "new@gmail.com"
    assert G.link_of(me["id"])["scopes"] == ["drive"]                                          # Drive granted earlier: kept
    assert client.post("/c/auth/google/finish", json={"code": one}).status_code == 404         # once only
    # the same state can't be used twice; "access denied" (Testing mode, not a test user) comes back as an error
    url = client.post("/c/auth/google/start", json={"return_to": "https://haptune.name.my/app/"}).json()["url"]
    st = dict(x.split("=", 1) for x in url.split("?", 1)[1].split("&"))["state"]
    r = client.get(f"/c/auth/google/callback?state={st}&error=access_denied", follow_redirects=False)
    assert r.headers["location"].endswith("#gsignin_error=access_denied")
    # the phone app: a pairing code, signed in in the browser, the app gets the account
    code = client.post("/c/auth/pair").json()["code"]
    url = client.post("/c/auth/google/start", json={"return_to": "https://haptune.name.my/app/", "pair": code}).json()["url"]
    st = dict(x.split("=", 1) for x in url.split("?", 1)[1].split("&"))["state"]
    r = client.get(f"/c/auth/google/callback?state={st}&code=code-redirect-1234", follow_redirects=False)
    assert r.headers["location"].endswith("#gsignin=paired")
    p = client.get(f"/c/auth/pair/{code}").json()
    assert p["status"] == "done" and p["me"]["email"] == "new@gmail.com"
    assert client.get("/c/auth/google/status").json()["configured"] is True


def test_the_website_says_which_google_client_it_used(monkeypatch, fresh):
    # GOOGLE_CLIENT_IDS also holds the Android client; it may even come first. The website's popup only works with
    # the Web client, so the website says which one it used and the server swaps the code with that one.
    ids = A.google_client_ids()
    web = ids[0]
    monkeypatch.setenv("GOOGLE_CLIENT_IDS", ",".join(["android-1.apps.googleusercontent.com", *ids]))
    seen = {}
    real = fresh.__call__
    def fake(method, url, **kw):
        if url == G.TOKEN_URL and kw["form"].get("code") == "code-web-client-1":
            seen["cid"] = kw["form"]["client_id"]
            return {"access_token": "at-w", "expires_in": 3600, "id_token": "idtok", "scope": "openid email profile"}
        return real(method, url, **kw)
    monkeypatch.setattr(G, "_http", fake)
    st = client.get(f"/c/auth/google/status?web={web}").json()
    assert st["web_known"] is True
    assert client.get("/c/auth/google/status?web=someone-else").json()["web_known"] is False
    _fake_id(monkeypatch, "g-webclient", "web@gmail.com")
    r = client.post("/c/auth/google/code", json={"code": "code-web-client-1", "client_id": web})
    assert r.status_code == 200, r.text
    assert seen["cid"] == web
    # remembered: refreshing tokens and the redirect sign-in use the Web client from now on
    assert G.web_client_id() == web
    assert client.get("/c/auth/google/status").json()["client_id"] == web
    # a client the server doesn't know is refused with words the owner can act on
    bad = client.post("/c/auth/google/code", json={"code": "code-web-client-1", "client_id": "nope"})
    assert bad.status_code == 400 and "GOOGLE_CLIENT_IDS" in bad.text


def test_switching_account_by_redirect_does_not_link(monkeypatch, fresh):
    monkeypatch.setenv("HAPTUNE_SITE_URL", "https://haptune.name.my")
    h = {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": "A"}).json()["token"]}
    client.post("/c/auth/password", json={"handle": "first_one", "password": "a-long-password"}, headers=h)
    url = client.post("/c/auth/google/start", json={"return_to": "https://haptune.name.my/app/", "fresh": True}, headers=h).json()["url"]
    state = dict(x.split("=", 1) for x in url.split("?", 1)[1].split("&"))["state"]
    with academy.engine().connect() as c:
        st = json.loads(c.execute(select(A.kv.c.v).where(A.kv.c.k == f"gstate:{state}")).scalar())
    assert st["uid"] is None
