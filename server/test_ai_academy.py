"""AI endpoints (with a fake model) and Academy classes (run: python -m pytest -q server)."""
import os
import sys
import tempfile
import time
import warnings

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "engine"))
sys.path.insert(0, os.path.join(HERE, "..", "engine", "tests"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import academy  # noqa: E402
import app as app_module  # noqa: E402
from app import app  # noqa: E402

client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh(monkeypatch, tmp_path):
    academy.reset_engine(f"sqlite:///{tmp_path}/academy.db")
    app_module._limiter.hits.clear()
    yield


# ---------------------------------------------------------------------------- AI
def test_ai_status_and_read_need_a_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert client.get("/ai/status").json()["ai"] is False
    r = client.post("/ai/read", files={"file": ("a.pdf", b"%PDF-1.4", "application/pdf")})
    assert r.status_code == 503


def test_tutor_answers_in_the_app_language(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert client.post("/ai/tutor", json={"question": "Why scales?"}).status_code == 503
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    seen = {}

    def fake_ask_text(self, system, prompt, **kw):
        seen.update(system=system, prompt=prompt, **kw)
        return "Scales train your fingers. Try G major slowly, 4 times."

    from haptune.ai import claude as claude_mod
    monkeypatch.setattr(claude_mod.Claude, "ask_text", fake_ask_text)
    r = client.post("/ai/tutor", json={"question": "Why scales?", "instrument": "violin", "level": 3, "lang": "ms"})
    assert r.status_code == 200 and r.json()["answer"].startswith("Scales")
    assert "violin" in seen["prompt"] and "Bahasa Melayu" in seen["prompt"] and seen["effort"] == "low"
    assert client.post("/ai/tutor", json={"question": ""}).status_code == 422


def test_ai_read_job_with_fake_model(monkeypatch):
    from ai_fixtures import FakeReaderClient, render_pdf, score_to_bars
    from haptune.ai import reader as reader_mod
    from haptune.ai.claude import Claude
    path = os.path.join(HERE, "..", "engine", "samples", "minuet_violin.musicxml")
    bars, meta = score_to_bars(path)
    pdf = render_pdf(path, bars_per_line=4)
    fake = FakeReaderClient(bars, meta, bars_per_line=4, instrument="violin")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(reader_mod, "Claude", lambda: Claude(client=fake))
    r = client.post("/ai/read", files={"file": ("minuet.pdf", pdf, "application/pdf")},
                    data={"instrument": "violin", "title": "Minuet"}, headers={"X-Haptune-Device": "dev-1"})
    assert r.status_code == 200, r.text
    jid = r.json()["id"]
    for _ in range(200):
        st = client.get(f"/jobs/{jid}").json()
        if st["status"] in ("done", "error"):
            break
        time.sleep(0.05)
    assert st["status"] == "done", st
    res = client.get(f"/jobs/{jid}/result").json()
    assert "<score-partwise" in res["musicxml"] and res["score"]["schema"] == "haptune.score/1"
    assert res["report"]["bars"] == len(bars) and res["flags"] == []
    assert res["report"]["parts"][0]["instrument"] == "violin"


def test_ai_read_is_rate_limited(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(app_module, "READS_PER_DAY", 1)
    monkeypatch.setattr(app_module, "_run_read", lambda *a: None)
    h = {"X-Haptune-Device": "dev-2"}
    assert client.post("/ai/read", files={"file": ("a.pdf", b"%PDF", "application/pdf")}, headers=h).status_code == 200
    assert client.post("/ai/read", files={"file": ("a.pdf", b"%PDF", "application/pdf")}, headers=h).status_code == 429


def test_tutor_answer_is_plain_text():
    assert app_module._plain("**Slow down:** count aloud.\n## Try this\nPlay __C D E__.") == \
        "Slow down: count aloud.\nTry this\nPlay C D E."


def test_ai_limits_ignore_a_made_up_forwarded_address(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(app_module, "READS_PER_DAY", 1)              # 3 a day per address
    monkeypatch.setattr(app_module, "_run_read", lambda *a: None)
    pdf = {"file": ("a.pdf", b"%PDF", "application/pdf")}
    codes = [client.post("/ai/read", files=pdf, headers={"X-Forwarded-For": f"10.0.0.{i}"}).status_code for i in range(4)]
    assert codes == [200, 200, 200, 429]
    # behind Fly, its proxy says who the client is
    assert client.post("/ai/read", files=pdf, headers={"Fly-Client-IP": "203.0.113.7"}).status_code == 200


def test_ai_whole_server_daily_cap(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setitem(app_module.ALL_PER_DAY, "read", 2)
    monkeypatch.setattr(app_module, "_run_read", lambda *a: None)
    pdf = {"file": ("a.pdf", b"%PDF", "application/pdf")}
    codes = [client.post("/ai/read", files=pdf, headers={"Fly-Client-IP": f"203.0.113.{i}", "X-Haptune-Device": f"d{i}"}).status_code
             for i in range(3)]
    assert codes == [200, 200, 429]


def test_ai_find_with_fake_model(monkeypatch):
    from haptune.ai import finder
    found = {"song": {"title": "Ode to Joy", "artist": "Beethoven", "copyrighted": False}, "advice": "Public domain.",
             "listen_url": "https://www.youtube.com/watch?v=abcdefghijk",
             "candidates": [
                 {"title": "Ode to Joy", "arrangement": "Piano", "instrument": "piano", "level": "easy", "format": "pdf",
                  "file_url": "https://example.org/ode.pdf", "page_url": "https://example.org/", "source": "Example", "license": "Public domain", "pages": 1},
                 {"title": "Ode to Joy", "arrangement": "Violin", "instrument": "violin", "level": "easy", "format": "musicxml",
                  "file_url": "https://example.org/ode.musicxml", "page_url": "https://example.org/", "source": "Example", "license": "CC BY", "pages": None}]}

    class FakeAI:
        model = "fake"
        usage = type("U", (), {"to_json": lambda self: {}})()

        def run_tools(self, system, user, tools, **kw):
            assert "Ode to Joy" in user and any(t.get("type", "").startswith("web_search") for t in tools)
            return found

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(finder, "Claude", FakeAI)
    monkeypatch.setattr(finder, "_verify", lambda c: {**c, "verified": False})
    r = client.post("/ai/find", json={"query": "Ode to Joy", "instrument": "violin"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [c["format"] for c in body["candidates"]] == ["musicxml", "pdf"]       # playable formats first
    assert body["youtube_id"] == "abcdefghijk"


def test_find_link_helpers():
    from haptune.ai.finder import _clean_title, youtube_id
    assert youtube_id("https://youtu.be/dQw4w9WgXcQ?t=3") == "dQw4w9WgXcQ"
    assert youtube_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x") == "dQw4w9WgXcQ"
    assert youtube_id("https://www.youtube.com/shorts/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert youtube_id("https://example.com/watch?v=dQw4w9WgXcQ") is None
    assert _clean_title("Canon in D (Official Video) [4K] | Some Channel") == "Canon in D"


def test_fetch_refuses_private_addresses():
    for url in ("http://127.0.0.1/a.pdf", "http://localhost:8000/health", "file:///etc/passwd", "http://10.0.0.1/x"):
        r = client.get("/ai/fetch", params={"url": url})
        assert r.status_code == 422, url


def test_sniff_formats():
    from haptune.ai.finder import sniff_format
    assert sniff_format(b"%PDF-1.7 ...") == "pdf"
    assert sniff_format(b"MThd\x00\x00\x00\x06") == "midi"
    assert sniff_format(b'<?xml version="1.0"?><score-partwise version="4.0">') == "musicxml"
    assert sniff_format(b"X:1\nT:Tune\nK:G\nGABc|") == "abc"
    assert sniff_format(b"<html><body>hi</body></html>") is None


# ---------------------------------------------------------------------------- Academy
def _user(name):
    r = client.post("/academy/me", json={"name": name})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}, r.json()["user"]


XML = open(os.path.join(HERE, "..", "engine", "samples", "minuet_violin.musicxml"), encoding="utf-8").read()


def test_academy_class_flow():
    teacher, _ = _user("Ms Tan")
    alice, alice_u = _user("Alice")
    bob, _ = _user("Bob")
    cl = client.post("/academy/classes", json={"name": "Violin Grade 2"}, headers=teacher).json()["class"]
    code = cl["join_code"]
    assert len(code) == 6 and cl["role"] == "teacher"
    assert client.post("/academy/join", json={"code": code.lower()}, headers=alice).json()["class"]["role"] == "student"
    assert client.post("/academy/join", json={"code": code}, headers=bob).status_code == 200
    assert client.post("/academy/join", json={"code": "ZZZZZZ"}, headers=bob).status_code == 404
    # only the teacher sets work
    due = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3 * 86400))
    body = {"title": "Minuet bars 1-8", "piece_title": "Minuet in G", "musicxml": XML, "bars_from": 1, "bars_to": 8,
            "tempo_pct": 80, "goal": 85, "points": 100, "due_at": due, "instructions": "Slow and even."}
    assert client.post(f"/academy/classes/{cl['id']}/assignments", json=body, headers=alice).status_code == 403
    a = client.post(f"/academy/classes/{cl['id']}/assignments", json=body, headers=teacher).json()["assignment"]
    # the student sees it in their to-do list
    me = client.get("/academy/me", headers=alice).json()
    assert [t["id"] for t in me["todo"]] == [a["id"]] and me["todo"][0]["status"] == "open"
    detail = client.get(f"/academy/assignments/{a['id']}", headers=alice).json()
    assert detail["musicxml"].startswith("<?xml") and detail["submissions"] == []
    # two tries: below the goal, then reaching it
    r1 = client.post(f"/academy/assignments/{a['id']}/submissions", json={"accuracy": 0.6, "seconds": 120, "bars": [1, 0.5], "bar_numbers": [3, 4]}, headers=alice).json()
    assert r1["submission"]["points"] == 30 and not r1["submission"]["reached_goal"]
    import base64
    rec = base64.b64encode(b"\x00\x01fake-audio").decode()
    r2 = client.post(f"/academy/assignments/{a['id']}/submissions",
                     json={"accuracy": 0.9, "seconds": 200, "note": "Better!", "recording_b64": rec, "recording_type": "audio/webm"},
                     headers=alice).json()
    assert r2["submission"]["reached_goal"] and r2["submission"]["points"] == 100
    assert client.get("/academy/me", headers=alice).json()["todo"] == []          # done: off the to-do list
    # the teacher reviews
    over = client.get("/academy/me", headers=teacher).json()["classes"][0]
    assert over["role"] == "teacher" and over["to_review"] == 2 and over["students"] == 2
    td = client.get(f"/academy/assignments/{a['id']}", headers=teacher).json()
    assert len(td["submissions"]) == 2 and td["submissions"][0]["has_recording"]
    assert td["submissions"][1]["bars"] == [[3, 1.0], [4, 0.5]]                   # each accuracy keeps its bar number
    sid = td["submissions"][0]["id"]
    assert client.get(f"/academy/submissions/{sid}/recording", headers=teacher).content == b"\x00\x01fake-audio"
    assert client.get(f"/academy/submissions/{sid}/recording", headers=bob).status_code == 403
    assert client.post(f"/academy/submissions/{sid}/feedback", json={"text": "Lovely tone", "stickers": ["star", "nope"], "focus_bars": [5]},
                       headers=teacher).status_code == 200
    assert client.post(f"/academy/submissions/{sid}/feedback", json={"text": "hi"}, headers=alice).status_code == 403
    mine = client.get(f"/academy/assignments/{a['id']}", headers=alice).json()
    assert mine["submissions"][0]["feedback"][0]["stickers"] == ["star"] and mine["status"] == "done"
    # class view, feed and leaderboard
    cv = client.get(f"/academy/classes/{cl['id']}", headers=teacher).json()
    assert cv["assignments"][0]["submitted"] == 1 and cv["assignments"][0]["reached_goal"] == 1 and cv["join_code"] == code
    assert "join_code" not in client.get(f"/academy/classes/{cl['id']}", headers=alice).json()
    feed = client.get(f"/academy/classes/{cl['id']}/feed", headers=bob).json()["items"]
    assert {i["type"] for i in feed} == {"goal", "practice", "feedback"}
    board = client.get(f"/academy/classes/{cl['id']}/leaderboard", headers=bob).json()["board"]
    assert board[0]["name"] == "Alice" and board[0]["points"] == 130 and board[1]["points"] == 0


def test_academy_windows_attempts_and_links():
    teacher, _ = _user("T")
    st, _ = _user("S")
    cl = client.post("/academy/classes", json={"name": "C"}, headers=teacher).json()["class"]
    client.post("/academy/join", json={"code": cl["join_code"]}, headers=st)
    later = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400))
    much_later = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 5 * 86400))
    a = client.post(f"/academy/classes/{cl['id']}/assignments", json={"title": "Next week", "opens_at": later, "due_at": much_later, "attempts": 1},
                    headers=teacher).json()["assignment"]
    assert client.get("/academy/me", headers=st).json()["todo"][0]["status"] == "upcoming"
    assert client.post(f"/academy/assignments/{a['id']}/submissions", json={"accuracy": 1}, headers=st).status_code == 409
    past = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 3 * 86400))
    yesterday = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 86400))
    b = client.post(f"/academy/classes/{cl['id']}/assignments", json={"title": "Overdue", "opens_at": past, "due_at": yesterday, "attempts": 1, "points": 40},
                    headers=teacher).json()["assignment"]
    late = client.post(f"/academy/assignments/{b['id']}/submissions", json={"accuracy": 0.95}, headers=st).json()["submission"]
    assert late["late"] and late["points"] == 20
    assert client.post(f"/academy/assignments/{b['id']}/submissions", json={"accuracy": 0.95}, headers=st).status_code == 409
    assert client.post(f"/academy/classes/{cl['id']}/assignments", json={"title": "x", "opens_at": later, "due_at": past},
                       headers=teacher).status_code == 400
    # move the student's profile to another device with a one-time code
    code = client.post("/academy/me/link-code", headers=st).json()["code"]
    new = client.post("/academy/me/claim", json={"code": code}).json()
    assert new["user"]["name"] == "S"
    assert client.get("/academy/me", headers=st).status_code == 401                 # the old token stops working
    assert client.get("/academy/me", headers={"Authorization": "Bearer " + new["token"]}).status_code == 200
    assert client.post("/academy/me/claim", json={"code": code}).status_code == 404   # codes work once
    assert client.get("/academy/me").status_code == 401
