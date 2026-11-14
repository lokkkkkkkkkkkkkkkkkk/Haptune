"""Classroom structure: stream with comments and mute, topics and rubrics, people and invites, grades grid and
CSV, audio feedback, notifications and email."""
import base64
import csv
import io
import os
import sys

os.environ.setdefault("HAPTUNE_DATA", "")
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))

import pytest
from fastapi.testclient import TestClient

import academy
import accounts
import classroom
from app import app

client = TestClient(app)
MAIL = []


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("HAPTUNE_SIGNIN_REQUIRED", "1")
    academy.reset_engine(f"sqlite:///{tmp_path/'cr.db'}")
    MAIL.clear()
    monkeypatch.setattr(classroom, "send_email", lambda to, subject, body: MAIL.append((sorted(to), subject)) or len(to))
    yield
    accounts.limiter.hits.clear()


def user(monkeypatch, sub, name):
    h = {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": name}).json()["token"]}
    monkeypatch.setattr(accounts, "verify_google", lambda cred: {"sub": sub, "email": f"{sub}@gmail.com", "email_verified": "true", "given_name": name})
    client.post("/c/auth/google", json={"credential": "c" * 40}, headers=h)
    return h


def setup_class(monkeypatch, n=2):
    t = user(monkeypatch, "teacher", "Ms Tan")
    cl = client.post("/academy/classes", json={"name": "Violin 1"}, headers=t).json()["class"]
    ss = []
    for i in range(n):
        s = user(monkeypatch, f"stu{i}", f"Student {i}")
        assert client.post("/academy/join", json={"code": cl["join_code"]}, headers=s).status_code == 200
        ss.append(s)
    return t, cl, ss


def kinds(h):
    return [n["kind"] for n in client.get("/c/notifications", headers=h).json()["items"]]


def test_stream_announcements_comments_and_mute(monkeypatch):
    t, cl, (s1, s2) = setup_class(monkeypatch)
    r = client.post(f"/academy/classes/{cl['id']}/stream", json={"text": "Concert on Friday!", "pinned": True}, headers=t).json()
    assert r["kind"] == "announcement"
    assert "class_announcement" in kinds(s1)
    assert MAIL and MAIL[-1][0] == ["stu0@gmail.com", "stu1@gmail.com"]
    pid = r["id"]
    assert client.post(f"/academy/stream/{pid}/comments", json={"text": "Can't wait"}, headers=s1).status_code == 200
    st = client.get(f"/academy/classes/{cl['id']}/stream", headers=s2).json()
    assert st["posts"][0]["pinned"] and st["posts"][0]["comments"][0]["text"] == "Can't wait"
    # a student's own post is a post, never pinned
    assert client.post(f"/academy/classes/{cl['id']}/stream", json={"text": "Practised 30 min", "pinned": True}, headers=s1).json()["kind"] == "post"
    # the teacher mutes a student for an hour: they read but cannot post or comment
    sid1 = client.get(f"/academy/classes/{cl['id']}/people", headers=t).json()["students"][0]["id"]
    assert client.post(f"/academy/classes/{cl['id']}/people/{sid1}/mute", json={"minutes": 60}, headers=t).json()["muted"]
    assert client.post(f"/academy/stream/{pid}/comments", json={"text": "hi"}, headers=s1).status_code == 403
    assert client.get(f"/academy/classes/{cl['id']}/stream", headers=s1).json()["muted"] is True
    client.post(f"/academy/classes/{cl['id']}/people/{sid1}/mute", json={"minutes": 0}, headers=t)
    assert client.post(f"/academy/stream/{pid}/comments", json={"text": "hi again"}, headers=s1).status_code == 200
    # students cannot mute, and cannot delete the teacher's post
    assert client.post(f"/academy/classes/{cl['id']}/people/{sid1}/mute", json={"minutes": 5}, headers=s2).status_code == 403
    assert client.delete(f"/academy/stream/{pid}", headers=s2).status_code == 403
    assert client.delete(f"/academy/stream/{pid}", headers=t).status_code == 200
    # outsiders see nothing
    o = user(monkeypatch, "out", "Outsider")
    assert client.get(f"/academy/classes/{cl['id']}/stream", headers=o).status_code in (403, 404)


def test_classwork_topics_rubric_grades_and_csv(monkeypatch):
    t, cl, (s1, s2) = setup_class(monkeypatch)
    a = client.post(f"/academy/classes/{cl['id']}/assignments", json={"title": "Scale of G", "goal": 80, "tempo_pct": 75}, headers=t).json()["assignment"]
    assert "class_assignment" in kinds(s1)
    top = client.post(f"/academy/classes/{cl['id']}/topics", json={"name": "Week 1"}, headers=t).json()["id"]
    rubric = [{"criterion": "Notes", "points": 5}, {"criterion": "Rhythm", "points": 5}]
    assert client.put(f"/academy/assignments/{a['id']}/meta", json={"topic_id": top, "rubric": rubric}, headers=t).status_code == 200
    cw = client.get(f"/academy/classes/{cl['id']}/classwork", headers=s1).json()
    assert cw["topics"][0]["name"] == "Week 1" and cw["assignments"][0]["topic_id"] == top and cw["assignments"][0]["rubric"] == rubric
    assert cw["assignments"][0]["tempo_pct"] == 75 and cw["assignments"][0]["mine"] is None
    # submissions are Play Along takes
    client.post(f"/academy/assignments/{a['id']}/submissions", json={"accuracy": 0.6, "seconds": 40}, headers=s1)
    client.post(f"/academy/assignments/{a['id']}/submissions", json={"accuracy": 0.9, "seconds": 40}, headers=s1)
    assert client.get(f"/academy/classes/{cl['id']}/classwork", headers=s1).json()["assignments"][0]["mine"] == {"best": 90, "tries": 2}
    g = client.get(f"/academy/classes/{cl['id']}/grades", headers=t).json()
    st = {s["name"]: s["id"] for s in g["students"]}
    assert g["cells"][st["Student 0"]][a["id"]]["best"] == 90 and g["cells"][st["Student 0"]][a["id"]]["status"] == "reached"
    assert g["cells"][st["Student 1"]] == {}
    # rubric grade: one score per line, within its points
    assert client.put(f"/academy/assignments/{a['id']}/grades/{st['Student 0']}", json={"rubric_scores": [6, 5]}, headers=t).status_code == 400
    assert client.put(f"/academy/assignments/{a['id']}/grades/{st['Student 0']}", json={"rubric_scores": [4]}, headers=t).status_code == 400
    r = client.put(f"/academy/assignments/{a['id']}/grades/{st['Student 0']}", json={"rubric_scores": [4, 5]}, headers=t).json()
    assert r["grade"] == 9
    assert "class_graded" in kinds(s1)
    assert client.get(f"/academy/classes/{cl['id']}/grades", headers=s1).status_code == 403
    rows = list(csv.reader(io.StringIO(client.get(f"/academy/classes/{cl['id']}/grades.csv", headers=t).text)))
    assert rows[0] == ["Student", "Scale of G (best %)", "Scale of G (grade)"]
    assert ["Student 0", "90", "9.0"] in rows and ["Student 1", "", ""] in rows


def test_csv_never_starts_a_cell_with_a_formula(monkeypatch):
    t = user(monkeypatch, "teacher2", "Ms Tan")
    cl = client.post("/academy/classes", json={"name": "C"}, headers=t).json()["class"]
    s = {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": "=HYPERLINK(1)"}).json()["token"]}
    monkeypatch.setattr(accounts, "verify_google", lambda cred: {"sub": "evil", "email": "e@gmail.com", "email_verified": "true"})
    client.post("/c/auth/google", json={"credential": "c" * 40}, headers=s)
    client.post("/academy/join", json={"code": cl["join_code"]}, headers=s)
    text = client.get(f"/academy/classes/{cl['id']}/grades.csv", headers=t).text
    assert "\n=HYPERLINK" not in text and "'=HYPERLINK" in text


def test_people_invite_and_audio_feedback(monkeypatch):
    t, cl, (s1,) = setup_class(monkeypatch, 1)
    other = user(monkeypatch, "mei", "Mei")                    # already has an account on that email
    r = client.post(f"/academy/classes/{cl['id']}/invite", json={"emails": ["mei@gmail.com", "new@school.my", "bad"]}, headers=t).json()
    assert r["invited"] == 2 and r["on_melovyn"] == 1 and r["whatsapp"].startswith("https://wa.me/?text=") and cl["join_code"] in r["text"]
    assert "class_invite" in kinds(other)
    ppl = client.get(f"/academy/classes/{cl['id']}/people", headers=t).json()
    assert [p["name"] for p in ppl["teachers"]] == ["Ms Tan"] and ppl["students"][0]["email"] == "stu0@gmail.com"
    assert "email" not in client.get(f"/academy/classes/{cl['id']}/people", headers=s1).json()["students"][0]    # students don't see emails
    # a voice comment on a submission, with highlighted bars
    a = client.post(f"/academy/classes/{cl['id']}/assignments", json={"title": "Minuet"}, headers=t).json()["assignment"]
    sub = client.post(f"/academy/assignments/{a['id']}/submissions", json={"accuracy": 0.7}, headers=s1).json()["submission"]["id"]
    audio = base64.b64encode(b"\x1aE\xdf\xa3" + b"\x00" * 500).decode()
    assert client.post(f"/academy/submissions/{sub}/audio-feedback", json={"audio_b64": audio, "audio_type": "text/html"}, headers=t).status_code == 415
    assert client.post(f"/academy/submissions/{sub}/audio-feedback", json={"audio_b64": audio, "audio_type": "audio/webm"}, headers=s1).status_code == 403
    nid = client.post(f"/academy/submissions/{sub}/audio-feedback", json={"audio_b64": audio, "audio_type": "audio/webm;codecs=opus", "bars": [3, 4], "text": "Listen"}, headers=t).json()["id"]
    notes = client.get(f"/academy/submissions/{sub}/audio-feedback", headers=s1).json()["notes"]
    assert notes[0]["bars"] == [3, 4]
    got = client.get(f"/academy/audio-feedback/{nid}", headers=s1)
    assert got.headers["content-type"] == "audio/webm" and got.headers["x-content-type-options"] == "nosniff"
    assert "class_feedback" in kinds(s1)
    # text feedback (academy.py) notifies too
    client.post(f"/academy/submissions/{sub}/feedback", json={"text": "Good"}, headers=t)
    assert kinds(s1).count("class_feedback") == 2
