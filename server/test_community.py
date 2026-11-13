"""Accounts, plans (AI allowances) and the community (run: python -m pytest -q server)."""
import os
os.environ.setdefault("HAPTUNE_SIGNIN_REQUIRED", "0")   # these tests use guest accounts; test_hub.py checks the sign-in rule
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "engine"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import academy  # noqa: E402
import accounts  # noqa: E402
import app as app_module  # noqa: E402
import community  # noqa: E402
from app import app  # noqa: E402

client = TestClient(app)
XML = open(os.path.join(HERE, "..", "engine", "samples", "minuet_violin.musicxml"), encoding="utf-8").read()


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    academy.reset_engine(f"sqlite:///{tmp_path}/c.db")
    app_module._limiter.hits.clear()
    accounts.limiter.hits.clear()
    monkeypatch.setenv("HAPTUNE_ADMIN_CODE", "let-me-in-please-123")
    yield


def person(name="Aina"):
    r = client.post("/c/auth/guest", json={"name": name})
    assert r.status_code == 200, r.text
    tok = r.json()["token"]
    return {"Authorization": f"Bearer {tok}"}, r.json()["me"]


def dev():
    h, me = person("Lok")
    assert client.post("/c/me/dev", json={"code": "let-me-in-please-123"}, headers=h).json()["tier"] == "dev"
    return h, me


def credits(h):
    return client.get("/c/me", headers=h).json()["credits"]


# ------------------------------------------------------------------------------------------- accounts & plans
def test_guest_account_has_welcome_credits_and_free_plan():
    h, me = person()
    assert me["credits"] == 100 and me["tier"] == "free" and me["handle"].startswith("aina")
    assert me["usage"]["tutor"] == {"used": 0, "limit": 0}
    plans = client.get("/c/plans").json()
    # reading printed music with AI is a Pro tool; Plus has the song finder and the tutor
    assert plans["plans"]["pro"]["read_pages"] >= 1 and plans["plans"]["plus"]["read_pages"] == 0 and plans["plans"]["free"]["read_pages"] == 0
    assert plans["plans"]["plus"]["find"] >= 1 and plans["plans"]["plus"]["tutor"] >= 1
    assert plans["prices"]["plus"]["monthly"]["myr"] == "14.90"
    assert client.get("/c/me").status_code == 401


def test_ai_features_need_a_plan_and_have_monthly_allowances(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    from haptune.ai import claude as claude_mod
    monkeypatch.setattr(claude_mod.Claude, "ask_text", lambda self, *a, **k: "Play slowly.")
    h, me = person()
    r = client.post("/ai/tutor", json={"question": "How do I count?"}, headers=h)
    assert r.status_code == 402 and r.json()["detail"]["code"] == "plan_required"
    assert client.post("/ai/tutor", json={"question": "How?"}).status_code == 402            # no account at all
    d, _ = dev()
    assert client.post("/c/admin/grant", json={"handle": me["handle"], "tier": "plus", "days": 30}, headers=d).status_code == 200
    monkeypatch.setitem(accounts.OVERRIDES, "plus", {"tutor": 2})
    assert [client.post("/ai/tutor", json={"question": "How?"}, headers=h).status_code for _ in range(3)] == [200, 200, 429]
    assert client.get("/c/me", headers=h).json()["usage"]["tutor"] == {"used": 2, "limit": 2}
    # the developer has no limits
    assert all(client.post("/ai/tutor", json={"question": "How?"}, headers=d).status_code == 200 for _ in range(4))
    # a failed AI call is not counted
    from haptune.ai.claude import AIError

    def broken(self, *a, **k):
        raise AIError("busy")
    monkeypatch.setattr(claude_mod.Claude, "ask_text", broken)
    monkeypatch.setitem(accounts.OVERRIDES, "plus", {"tutor": 3})
    assert client.post("/ai/tutor", json={"question": "How?"}, headers=h).status_code == 502
    assert client.get("/c/me", headers=h).json()["usage"]["tutor"]["used"] == 2


def test_ai_read_counts_pdf_pages(monkeypatch):
    import fitz
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(app_module, "_run_read", lambda *a: None)
    doc = fitz.open()
    for _ in range(3):
        doc.new_page()
    pdf = doc.tobytes()
    h, me = person()
    d, _ = dev()
    client.post("/c/admin/grant", json={"handle": me["handle"], "tier": "plus", "days": 30}, headers=d)
    monkeypatch.setitem(accounts.OVERRIDES, "plus", {"read_pages": 10})
    r = client.post("/ai/read", files={"file": ("p.pdf", pdf, "application/pdf")}, headers=h)
    assert r.status_code == 200 and r.json()["pages"] == 3
    assert client.get("/c/me", headers=h).json()["usage"]["read_pages"]["used"] == 3


def test_password_login_on_another_device_and_recovery():
    h, me = person("Wei Ming")
    r = client.post("/c/auth/password", json={"handle": "weiming", "password": "violin-2026"}, headers=h)
    assert r.status_code == 200
    code = r.json()["recovery_code"]
    other, _ = person("Someone")
    assert client.post("/c/auth/password", json={"handle": "WeiMing", "password": "abcdefgh"}, headers=other).status_code == 409
    assert client.post("/c/auth/login", json={"handle": "weiming", "password": "wrong-one"}).status_code == 401
    pc = client.post("/c/auth/login", json={"handle": "@WeiMing", "password": "violin-2026", "device": "PC"}).json()
    assert pc["me"]["id"] == me["id"] and pc["me"]["devices"] == 2
    # the same account in Academy classes, from the PC
    assert client.get("/academy/me", headers={"Authorization": f"Bearer {pc['token']}"}).status_code == 200
    rec = client.post("/c/auth/recover", json={"handle": "weiming", "code": code, "password": "new-password-1"}).json()
    assert rec["me"]["id"] == me["id"] and rec["recovery_code"] != code
    assert client.post("/c/auth/login", json={"handle": "weiming", "password": "new-password-1"}).status_code == 200
    assert client.post("/c/auth/password", json={"handle": "admin", "password": "abcdefgh"}, headers=h).status_code == 400


def test_practice_credits_once_a_day_and_plus_week_for_credits():
    h, me = person()
    assert client.post("/c/practice", json={"minutes": 3}, headers=h).json()["credits"] == 0
    assert client.post("/c/practice", json={"minutes": 4}, headers=h).json() == {"credits": 5, "streak": 1}
    assert client.post("/c/practice", json={"minutes": 20}, headers=h).json()["credits"] == 0
    assert credits(h) == 105
    assert client.post("/c/credits/plus-week", headers=h).status_code == 402          # not enough credits
    d, _ = dev()
    client.post("/c/admin/credits", json={"handle": me["handle"], "delta": 1500}, headers=d)
    r = client.post("/c/credits/plus-week", headers=h)
    assert r.status_code == 200 and r.json()["tier"] == "plus" and r.json()["credits"] == 105
    assert client.post("/c/credits/plus-week", headers=h).status_code in (402, 429)


# ------------------------------------------------------------------------------------------- requests
def test_request_flow_rewards_fast_good_help_and_keeps_the_score_private():
    asker, a = person("Aina")
    fan, f = person("Bala")
    helper, hp = person("Chen")
    stranger, _ = person("Dina")
    r = client.post("/c/posts", headers=asker, json={
        "type": "request", "title": "Minuet in G for violin", "song": "Minuet in G", "artist": "Petzold", "instruments": ["violin"],
        "level": "beginner", "link": "https://www.youtube.com/watch?v=abcdefghijk", "licence": "copyrighted", "pot": 50})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    assert credits(asker) == 50
    assert client.post(f"/c/posts/{pid}/want", json={"add": 20}, headers=fan).json()["pot"] == 70
    listed = client.get("/c/posts", params={"type": "request", "instrument": "violin"}).json()["items"]
    assert [p["id"] for p in listed] == [pid] and listed[0]["wants"] == 1
    assert client.post(f"/c/posts/{pid}/claim", headers=helper).json()["claimed"]["by"]["handle"] == hp["handle"]
    assert client.post(f"/c/posts/{pid}/claim", headers=stranger).status_code == 409
    sub = client.post(f"/c/posts/{pid}/replies", json={"kind": "submission", "body": "Here you go!", "xml": XML}, headers=helper).json()
    rep = sub["replies_list"][-1]
    assert rep["file"]["bars"] > 10 and sub["claimed"] is None
    # only the asker, the people who wanted it and the helper may open the score of a copyrighted song
    fid = client.get(f"/c/posts/{pid}", headers=asker).json()["replies_list"][-1]["file"]["id"]
    assert client.get(f"/c/files/{fid}", headers=asker).status_code == 200
    assert client.get(f"/c/files/{fid}", headers=fan).status_code == 200
    assert client.get(f"/c/files/{fid}", headers=stranger).status_code == 404
    assert client.post(f"/c/replies/{rep['id']}/accept", json={"rating": 5}, headers=stranger).status_code == 403
    before = credits(helper)
    done = client.post(f"/c/replies/{rep['id']}/accept", json={"rating": 5, "thanks": "Perfect, thank you!"}, headers=asker).json()
    assert done["status"] == "done"
    earned = credits(helper) - before
    size = min(60, max(10, 10 + max(rep["file"]["notes"] // 20, rep["file"]["bars"] // 4)))
    assert earned == 70 + round(size * 1.5 * 1.5)                 # the pot + bonus (fast and five stars)
    kinds = [n["kind"] for n in client.get("/c/notifications", headers=fan).json()["items"]]
    assert "ready" in kinds
    assert client.post(f"/c/posts/{pid}/publish", headers=asker).status_code == 400   # copyrighted: never listed
    lb = client.get("/c/leaderboard", params={"board": "helpers"}).json()["items"]
    assert lb[0]["user"]["handle"] == hp["handle"] and lb[0]["value"] == earned
    prof = client.get(f"/c/users/{hp['handle']}").json()
    assert "first_help" in prof["badges"] and "speedy" in prof["badges"] and prof["stats"]["helps"] == 1


def test_closing_a_request_gives_every_credit_back():
    asker, _ = person()
    fan, _ = person("Bala")
    pid = client.post("/c/posts", headers=asker, json={"type": "request", "title": "Some song", "pot": 30}).json()["id"]
    client.post(f"/c/posts/{pid}/want", json={"add": 10}, headers=fan)
    assert credits(asker) == 70 and credits(fan) == 90
    assert client.patch(f"/c/posts/{pid}", json={"status": "closed"}, headers=asker).json()["status"] == "closed"
    assert credits(asker) == 100 and credits(fan) == 100


def test_free_plan_has_three_open_requests_and_credits_are_optional():
    h, _ = person()
    for i in range(3):
        assert client.post("/c/posts", headers=h, json={"type": "request", "title": f"Song {i}"}).status_code == 200
    r = client.post("/c/posts", headers=h, json={"type": "request", "title": "Song 4"})
    assert r.status_code == 402 and r.json()["detail"]["code"] == "open_requests"
    assert credits(h) == 100                                         # asking for help never needs credits


def test_questions_helpful_replies_and_caps():
    asker, _ = person()
    helpers = [person(f"Helper{i}") for i in range(5)]
    pid = client.post("/c/posts", headers=asker, json={"type": "question", "title": "How do I play a trill?"}).json()["id"]
    for h, _ in helpers:
        client.post(f"/c/posts/{pid}/replies", json={"kind": "answer", "body": "Alternate the two notes quickly."}, headers=h)
    rs = client.get(f"/c/posts/{pid}", headers=asker).json()["replies_list"]
    b0 = credits(helpers[0][0])
    client.post(f"/c/replies/{rs[0]['id']}/accept", json={"rating": 4}, headers=asker)
    assert credits(helpers[0][0]) - b0 == round(10 * 2.0 * 1.2)        # answered within the hour, four stars
    codes = [client.post(f"/c/replies/{r['id']}/helpful", headers=asker).status_code for r in rs[1:]]
    assert codes == [200, 200, 200, 429]
    assert credits(helpers[1][0]) == 105


def test_library_shares_public_domain_and_keeps_copyrighted_unlisted():
    h, me = person()
    pd = client.post("/c/posts", headers=h, json={"type": "share", "title": "Minuet in G", "licence": "pd", "xml": XML}).json()
    cr = client.post("/c/posts", headers=h, json={"type": "share", "title": "A pop song", "licence": "copyrighted", "xml": XML}).json()
    assert pd["visibility"] == "public" and cr["visibility"] == "unlisted"
    listed = [p["id"] for p in client.get("/c/posts", params={"type": "share"}).json()["items"]]
    assert listed == [pd["id"]]
    assert client.get(f"/c/files/{cr['file_id']}").status_code == 200          # anyone with the link
    assert credits(h) == 110                                                 # the public-domain share earned 10
    other, _ = person("Bala")
    assert client.post("/c/react", json={"target": f"p:{pd['id']}", "kind": "save"}, headers=other).json()["on"] is True
    assert credits(h) == 112
    mine = client.get("/c/posts", params={"mine": True}, headers=h).json()["items"]
    assert len(mine) == 2


def test_reports_hide_after_three_and_admin_can_restore():
    author, _ = person("Spammer")
    pid = client.post("/c/posts", headers=author, json={"type": "question", "title": "Buy cheap followers"}).json()["id"]
    for i in range(3):
        h, _ = person(f"R{i}")
        assert client.post("/c/report", json={"target": f"p:{pid}", "reason": "spam"}, headers=h).status_code == 200
    assert pid not in [p["id"] for p in client.get("/c/posts").json()["items"]]
    d, _ = dev()
    reps = client.get("/c/admin/reports", headers=d).json()["items"]
    assert reps and reps[0]["target"] == f"p:{pid}"
    client.post(f"/c/admin/reports/{reps[0]['id']}", json={"action": "restore"}, headers=d)
    assert pid in [p["id"] for p in client.get("/c/posts").json()["items"]]
    assert client.get("/c/admin/overview", headers=author).status_code == 403


def test_blocking_hides_posts_and_stops_replies():
    a, am = person("Aina")
    b, bm = person("Bala")
    pid = client.post("/c/posts", headers=a, json={"type": "question", "title": "Best rosin?"}).json()["id"]
    client.post("/c/posts", headers=b, json={"type": "question", "title": "Bala's question"})
    client.post(f"/c/users/{bm['handle']}/block", headers=a)
    titles = [p["title"] for p in client.get("/c/posts", headers=a).json()["items"]]
    assert "Bala's question" not in titles
    assert client.post(f"/c/posts/{pid}/replies", json={"kind": "answer", "body": "Any"}, headers=b).status_code == 403


def test_friendly_words_only():
    h, _ = person()
    r = client.post("/c/posts", headers=h, json={"type": "question", "title": "this is shit"})
    assert r.status_code == 400
    assert client.post("/c/posts", headers=h, json={"type": "question", "title": "Shitake mushrooms and music?"}).status_code == 200


def test_weekly_challenge_entries_and_feedback_inbox():
    h, me = person()
    ch = client.get("/c/challenge").json()
    assert client.post("/c/challenge/entry", json={"song": "nope", "accuracy": 0.9}, headers=h).status_code == 400
    r = client.post("/c/challenge/entry", json={"song": ch["song"], "accuracy": 0.82, "tempo_pct": 100}, headers=h).json()
    assert r["mine"]["accuracy"] == 0.82 and credits(h) == 110
    client.post("/c/challenge/entry", json={"song": ch["song"], "accuracy": 0.95, "tempo_pct": 100}, headers=h)
    assert client.get("/c/challenge", headers=h).json()["mine"]["accuracy"] == 0.95 and credits(h) == 110
    assert client.post("/c/feedback", json={"category": "bug", "message": "Stuck after jumping bars", "diagnostics": {"v": "1"}}).status_code == 200
    d, _ = dev()
    fb = client.get("/c/admin/feedback", headers=d).json()["items"]
    assert fb[0]["message"] == "Stuck after jumping bars" and fb[0]["category"] == "bug"


def test_community_home_and_deleting_an_account():
    a, am = person("Aina")
    client.patch("/c/me", json={"instruments": ["violin"], "bio": "Learning violin"}, headers=a)
    b, _ = person("Bala")
    pid = client.post("/c/posts", headers=b, json={"type": "request", "title": "Canon for violin", "instruments": ["violin"]}).json()["id"]
    home = client.get("/c/home", headers=a).json()
    assert [p["id"] for p in home["for_you"]] == [pid] and home["counts"]["open_requests"] == 1 and home["challenge"]["song"]
    assert client.delete("/c/me", headers=b).json()["deleted"] is True
    p = client.get(f"/c/posts/{pid}").json()
    assert p["author"]["name"] == "Deleted user" and p["status"] == "closed"
    assert client.get("/c/me", headers=b).status_code == 401


def test_allowances_follow_the_cost_of_the_models(monkeypatch):
    """A plan's AI budget stays the same; a cheaper model gives more pages, searches and answers."""
    for k in ("HAPTUNE_AI_MODEL", "HAPTUNE_AI_MODEL_READ", "HAPTUNE_AI_MODEL_REREAD", "HAPTUNE_AI_MODEL_TUTOR"):
        monkeypatch.delenv(k, raising=False)
    opus = accounts.ai_allowance("pro", "read_pages")
    monkeypatch.setenv("HAPTUNE_AI_MODEL_READ", "claude-haiku-5-5")
    monkeypatch.setenv("HAPTUNE_AI_MODEL_REREAD", "claude-opus-5-5")
    cascade = accounts.ai_allowance("pro", "read_pages")
    monkeypatch.setenv("HAPTUNE_AI_MODEL_REREAD", "claude-haiku-5-5")
    haiku = accounts.ai_allowance("pro", "read_pages")
    assert 1 <= opus < cascade < haiku
    for tier in ("plus", "pro"):
        for kind in ("read_pages", "find", "tutor"):              # within the plan's budget (but at least one use)
            n, per_use = accounts.ai_allowance(tier, kind), accounts.unit_cost(kind)
            assert n <= 1 or n * per_use <= accounts.AI_BUDGET[tier] * accounts.BUDGET_SPLIT[tier][kind] + 1e-9
    assert accounts.ai_allowance("plus", "read_pages") == 0        # Pro only
    assert accounts.ai_allowance("free", "tutor") == 0 and accounts.ai_allowance("pro", "tutor") > accounts.ai_allowance("plus", "tutor")
    monkeypatch.setitem(accounts.OVERRIDES, "free", {"tutor": 3})
    assert accounts.ai_allowance("free", "tutor") == 3


def test_haiku_requests_leave_out_the_server_side_fallback():
    from haptune.ai.claude import FALLBACK_BETA, fallback_args
    assert fallback_args("claude-haiku-5-5") == {"betas": []}
    assert fallback_args("claude-sonnet-5-5") == {"betas": [FALLBACK_BETA], "fallbacks": "default"}
    assert fallback_args("claude-opus-5-5")["fallbacks"] == "default"


def test_song_searches_are_shared_for_a_week(monkeypatch):
    """Someone already searched for this song: the answer comes back at once, free, without using the allowance."""
    from haptune.ai import finder
    calls = []

    class FakeAI:
        model = "fake"
        usage = type("U", (), {"to_json": lambda self: {}})()

        def __init__(self, **kw):
            pass

        def run_tools(self, system, user, tools, **kw):
            calls.append(user)
            return {"song": {"title": "Canon", "artist": "Pachelbel", "copyrighted": False}, "advice": "", "listen_url": None,
                    "candidates": [{"title": "Canon", "arrangement": "Violin", "instrument": "violin", "level": "easy", "format": "musicxml",
                                    "file_url": "https://example.org/canon.musicxml", "page_url": "https://example.org/", "source": "Example",
                                    "license": "Public domain", "pages": None}]}
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(finder, "Claude", FakeAI)
    monkeypatch.setattr(finder, "_verify", lambda c: {**c, "verified": True})
    monkeypatch.setitem(accounts.OVERRIDES, "plus", {"find": 1})
    d, _ = dev()
    a, am = person("Aina")
    b, bm = person("Bala")
    for m in (am, bm):
        client.post("/c/admin/grant", json={"handle": m["handle"], "tier": "plus", "days": 30}, headers=d)
    assert client.post("/ai/find", json={"query": "Canon in D", "instrument": "violin"}, headers=a).status_code == 200
    r = client.post("/ai/find", json={"query": "  canon IN d ", "instrument": "violin"}, headers=b)
    assert r.status_code == 200 and r.json().get("cached") is True and len(calls) == 1
    assert client.get("/c/me", headers=b).json()["usage"]["find"]["used"] == 0
    assert client.post("/ai/find", json={"query": "Canon in D", "instrument": "violin"}, headers=a).status_code == 200   # cached: free again
    assert client.post("/ai/find", json={"query": "Air on the G string", "instrument": "violin"}, headers=a).status_code == 429


def test_moments_are_everyday_posts_with_photos_and_recordings():
    import base64 as b64
    h = _guest("Mia") if "_guest" in globals() else {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": "Mia"}).json()["token"]}
    png = b64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100).decode()
    audio = b64.b64encode(b"\x00" * 3000).decode()
    r = client.post("/c/posts", json={"type": "moment", "body": "First recital today!\nSo nervous", "attachments": [
        {"name": "me.png", "mime": "image/png", "data": png}, {"name": "take.webm", "mime": "audio/webm;codecs=opus", "data": audio}]}, headers=h)
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["type"] == "moment" and p["title"] == "First recital today!" and len(p["attachments"]) == 2
    aid = [a for a in p["attachments"] if a["mime"].startswith("audio")][0]["id"]
    assert client.get(f"/c/files/{aid}").status_code == 200                          # anyone can play it
    assert client.post("/c/posts", json={"type": "moment", "body": ""}, headers=h).status_code == 400
    assert client.post("/c/posts", json={"type": "question", "title": "x"}, headers=h).status_code == 400
    feed = client.get("/c/posts", params={"type": "moment"}).json()
    assert feed["items"][0]["id"] == p["id"]
