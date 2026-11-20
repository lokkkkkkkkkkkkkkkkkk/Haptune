"""Learn (Part 2 C): assignment kinds and turning in, To do / Done / Missing, the path, the teacher overview and
nudges, private comments, guardians and their weekly summary, the Drive folder, roster import."""
import os
import sys
import time

os.environ.setdefault("HAPTUNE_DATA", "")
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

import academy
import accounts as A
import classroom
import learn
from app import app

client = TestClient(app)
DAY = 86400


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    academy.reset_engine(f"sqlite:///{tmp_path/'l.db'}")
    monkeypatch.setenv("HAPTUNE_SIGNIN_REQUIRED", "0")
    A.limiter.hits.clear()
    yield


def person(name):
    r = client.post("/c/auth/guest", json={"name": name})
    return {"Authorization": "Bearer " + r.json()["token"]}


def uid_of(h):
    return client.get("/academy/me", headers=h).json()["user"]["id"]


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t))


def setup_class(n_students=1):
    t = person("Ms Tan")
    cls = client.post("/academy/classes", json={"name": "Violin 1"}, headers=t).json()["class"]
    students = [person(f"Student {i}") for i in range(n_students)]
    for s in students:
        assert client.post("/academy/join", json={"code": cls["join_code"]}, headers=s).status_code == 200
    return t, cls["id"], students


def assignment(t, cid, title, days=3, kind="play", prompt=""):
    r = client.post(f"/academy/classes/{cid}/assignments", json={"title": title, "piece_title": "Ode to Joy", "due_at": iso(time.time() + days * DAY)}, headers=t)
    assert r.status_code == 200, r.text
    aid = r.json()["id"] if "id" in r.json() else r.json()["assignment"]["id"]
    if kind != "play":
        assert client.put(f"/academy/assignments/{aid}/meta", json={"kind": kind, "prompt": prompt}, headers=t).status_code == 200
    return aid


def make_past_due(aid):
    with academy.engine().begin() as c:
        c.execute(update(academy.assignments).where(academy.assignments.c.id == aid).values(opens_at=time.time() - 5 * DAY, due_at=time.time() - DAY))


def test_kinds_turn_in_and_my_work():
    t, cid, [s] = setup_class()
    play = assignment(t, cid, "Scales")
    theory = assignment(t, cid, "Name the key", kind="theory", prompt="What key is Ode to Joy in?")
    late = assignment(t, cid, "Old piece")
    make_past_due(late)
    cw = client.get(f"/academy/classes/{cid}/classwork", headers=s).json()
    kinds = {a["title"]: a["kind"] for a in cw["assignments"]}
    assert kinds == {"Scales": "play", "Name the key": "theory", "Old piece": "play"}
    assert [a["prompt"] for a in cw["assignments"] if a["title"] == "Name the key"] == ["What key is Ode to Joy in?"]
    one = client.get(f"/academy/assignments/{theory}", headers=s).json()
    assert one["kind"] == "theory" and one["prompt"] == "What key is Ode to Joy in?"
    # Play Along work isn't turned in with text; empty answers are refused
    assert client.post(f"/academy/assignments/{play}/turn-in", json={"text": "done"}, headers=s).status_code == 400
    assert client.post(f"/academy/assignments/{theory}/turn-in", json={"text": "  "}, headers=s).status_code == 400
    assert client.post(f"/academy/assignments/{theory}/turn-in", json={"text": "D major"}, headers=t).status_code == 403   # teachers don't hand in
    assert client.post(f"/academy/assignments/{theory}/turn-in", json={"text": "D major"}, headers=s).status_code == 200
    w = client.get("/academy/me/work", headers=s).json()
    assert [a["title"] for a in w["done"]] == ["Name the key"]
    assert [a["title"] for a in w["missing"]] == ["Old piece"]
    assert [a["title"] for a in w["todo"]] == ["Scales"] and w["todo"][0]["kind"] == "play"
    # the teacher heard about it
    kinds = [n["kind"] for n in client.get("/c/notifications", headers=t).json()["items"]]
    assert "class_turned_in" in kinds


def test_path_places_for_a_student_and_counts_for_the_teacher():
    t, cid, [s, s2] = setup_class(2)
    tid = client.post(f"/academy/classes/{cid}/topics", json={"name": "Week 1", "position": 0}, headers=t).json()["id"]
    a1, a2, a3 = assignment(t, cid, "One", 2), assignment(t, cid, "Two", 3), assignment(t, cid, "Three", 4)
    for a in (a1, a2):
        assert client.put(f"/academy/assignments/{a}/meta", json={"topic_id": tid}, headers=t).status_code == 200
    client.post(f"/academy/assignments/{a1}/submissions", json={"accuracy": 0.95, "seconds": 60}, headers=s)
    p = client.get(f"/academy/classes/{cid}/path", headers=s).json()
    places = {a["title"]: a["place"] for g in p["topics"] for a in g["assignments"]}
    assert places == {"One": "done", "Two": "now", "Three": "next"}
    assert p["topics"][0]["name"] == "Week 1" and p["done"] == 1 and p["total"] == 3
    tp = client.get(f"/academy/classes/{cid}/path", headers=t).json()
    assert {a["title"]: (a["done"], a["of"]) for g in tp["topics"] for a in g["assignments"]} == {"One": (1, 2), "Two": (0, 2), "Three": (0, 2)}


def test_teacher_overview_and_nudges_once_a_day():
    t, cid, [s, s2] = setup_class(2)
    a = assignment(t, cid, "Scales")
    client.post(f"/academy/assignments/{a}/submissions", json={"accuracy": 0.6, "seconds": 60}, headers=s)
    with academy.engine().begin() as c:                       # everyone joined a while ago
        c.execute(update(academy.members).where(academy.members.c.class_id == cid).values(joined=time.time() - 10 * DAY))
    o = client.get("/academy/teacher/overview", headers=t).json()["classes"][0]
    assert o["students"] == 2 and o["to_review"] == 1
    assert [q["name"] for q in o["quiet"]] == ["Student 1"]
    quiet = o["quiet"][0]["id"]
    assert client.post(f"/academy/classes/{cid}/nudge", json={"user_ids": [quiet]}, headers=s).status_code == 403
    assert client.post(f"/academy/classes/{cid}/nudge", json={"user_ids": [quiet, "nobody"], "text": "A few minutes today?"}, headers=t).json() == {"sent": 1, "skipped": 0}
    assert client.post(f"/academy/classes/{cid}/nudge", json={"user_ids": [quiet]}, headers=t).json() == {"sent": 0, "skipped": 1}
    n = client.get("/c/notifications", headers=s2).json()["items"]
    assert n[0]["kind"] == "class_nudge" and n[0]["data"]["text"] == "A few minutes today?"
    assert client.get("/academy/teacher/overview", headers=t).json()["classes"][0]["quiet"][0]["nudged"]


def test_private_comments_stay_between_one_student_and_the_teacher():
    t, cid, [s, s2] = setup_class(2)
    a = assignment(t, cid, "Scales")
    assert client.post(f"/academy/assignments/{a}/private", json={"text": "Bar 3 is hard for me"}, headers=s).status_code == 200
    me_s = uid_of(s)
    assert client.post(f"/academy/assignments/{a}/private", json={"text": "Try it at 60%"}, headers=t).status_code == 400   # which student?
    assert client.post(f"/academy/assignments/{a}/private", json={"text": "Try it at 60%", "student": me_s}, headers=t).status_code == 200
    mine = client.get(f"/academy/assignments/{a}/private", headers=s).json()["items"]
    assert [x["text"] for x in mine] == ["Bar 3 is hard for me", "Try it at 60%"] and mine[0]["mine"] and not mine[1]["mine"]
    assert client.get(f"/academy/assignments/{a}/private", headers=s2).json()["items"] == []
    assert len(client.get(f"/academy/assignments/{a}/private?student={me_s}", headers=t).json()["items"]) == 2
    assert client.get(f"/academy/assignments/{a}/private?student={me_s}", headers=person("Stranger")).status_code == 404
    kinds = [n["kind"] for n in client.get("/c/notifications", headers=t).json()["items"]]
    assert "class_private" in kinds


def test_guardians_weekly_summary_and_their_page(monkeypatch):
    t, cid, [s] = setup_class()
    a = assignment(t, cid, "Scales")
    old = assignment(t, cid, "Old piece")
    make_past_due(old)
    client.post(f"/academy/assignments/{a}/submissions", json={"accuracy": 0.9, "seconds": 600}, headers=s)
    g = client.post("/academy/me/guardians", json={"email": "Mum@Example.com", "name": "Mum"}, headers=s).json()
    assert g["email"] == "mum@example.com" and "#guardian/" in g["link"]
    assert client.post("/academy/me/guardians", json={"email": "mum@example.com"}, headers=s).json()["id"] == g["id"]      # no duplicates
    assert client.post("/academy/me/guardians", json={"email": "not an email"}, headers=s).status_code == 422
    sid = uid_of(s)
    assert client.post(f"/academy/classes/{cid}/students/{sid}/guardians", json={"email": "dad@example.com"}, headers=t).status_code == 200
    assert client.post(f"/academy/classes/{cid}/students/{sid}/guardians", json={"email": "x@example.com"}, headers=s).status_code == 403
    sent = []
    monkeypatch.setattr(classroom, "send_email", lambda to, subject, body: sent.append((to, subject, body)) or len(to))
    r = client.post(f"/academy/classes/{cid}/guardian-summaries", headers=t).json()
    assert r == {"students": 1, "guardians": 2, "emailed": 2}
    to, subject, body = sent[0]
    assert subject == "Student 0's week on Haptune" and "Practice: 10 min, 1 take, best 90%" in body and "Missing:" in body and "Old piece" in body
    page = client.get("/academy/guardian/" + g["link"].rsplit("/", 1)[1]).json()
    assert page["student"] == "Student 0" and page["minutes"] == 10 and [x["title"] for x in page["missing"]] == ["Old piece"]
    assert client.get("/academy/guardian/not-a-real-token-at-all-xx").status_code == 404
    assert client.delete(f"/academy/me/guardians/{g['id']}", headers=s).status_code == 200
    assert client.get("/academy/guardian/" + g["link"].rsplit("/", 1)[1]).status_code == 404


def test_drive_folder_and_roster_import(monkeypatch):
    t, cid, [s] = setup_class()
    assert client.put(f"/academy/classes/{cid}/drive", json={"url": "https://evil.example.com/x"}, headers=t).status_code == 400
    assert client.put(f"/academy/classes/{cid}/drive", json={"url": "https://drive.google.com/drive/folders/abc123"}, headers=s).status_code == 403
    assert client.put(f"/academy/classes/{cid}/drive", json={"url": "https://drive.google.com/drive/folders/abc123"}, headers=t).status_code == 200
    assert client.get(f"/academy/classes/{cid}/classwork", headers=s).json()["drive_url"] == "https://drive.google.com/drive/folders/abc123"
    csv_text = "First Name,Last Name,Email Address\nAisha,Rahman,aisha@school.edu\nWei,Lim,WEI@school.edu\nNo,Email,\nAisha,Rahman,aisha@school.edu\n"
    assert learn.parse_roster(csv_text) == [{"email": "aisha@school.edu", "name": "Aisha Rahman"}, {"email": "wei@school.edu", "name": "Wei Lim"}]
    assert learn.parse_roster("Siti <siti@x.my>; ben@y.com\nKumar kumar@z.org") == [
        {"email": "siti@x.my", "name": "Siti"}, {"email": "ben@y.com", "name": ""}, {"email": "kumar@z.org", "name": "Kumar"}]
    monkeypatch.setattr(classroom, "send_email", lambda to, subject, body: len(to))
    r = client.post(f"/academy/classes/{cid}/roster", json={"text": csv_text}, headers=t).json()
    assert r["found"] == 2 and r["invited"] == 2 and r["emailed"] == 2 and "#join/" in r["link"]
    assert client.post(f"/academy/classes/{cid}/roster", json={"text": "no emails here"}, headers=t).status_code == 400
    assert client.post(f"/academy/classes/{cid}/roster", json={"text": csv_text}, headers=s).status_code == 403
