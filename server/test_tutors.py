"""Find a tutor: a paid, checked profile is listed; request -> accept -> confirm -> done with stars."""
import os
os.environ.setdefault("HAPTUNE_SIGNIN_REQUIRED", "0")   # these tests use guest accounts; test_hub.py checks the sign-in rule
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
import tutors  # noqa: E402
from app import app  # noqa: E402

client = TestClient(app)
PROFILE = {"headline": "Violin for children and adults", "bio": "Twelve years of teaching, ABRSM grades 1 to 8, patient and fun.",
           "instruments": ["violin"], "levels": ["beginner", "intermediate"], "languages": ["English", "中文"], "city": "Kuala Lumpur",
           "online": True, "in_person": True, "rate": "RM 60 an hour", "times": "Weekday evenings, Saturday mornings"}


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    academy.reset_engine(f"sqlite:///{tmp_path}/t.db")
    app_module._limiter.hits.clear()
    accounts.limiter.hits.clear()
    monkeypatch.setenv("HAPTUNE_ADMIN_CODE", "let-me-in-please-123")
    yield


def person(name="Aina"):
    r = client.post("/c/auth/guest", json={"name": name})
    return {"Authorization": f"Bearer {r.json()['token']}"}, r.json()["me"]


def dev():
    h, me = person("Lok")
    client.post("/c/me/dev", json={"code": "let-me-in-please-123"}, headers=h)
    return h, me


def listed_teacher(d):
    th, tm = person("Teacher Tan")
    assert client.put("/c/tutor/me", json=PROFILE, headers=th).json()["profile"]["status"] == "draft"
    p = client.post("/c/billing/manual", json={"product": "teacher"}, headers=th).json()
    assert p["amount"] == "20.00" and p["period"] == "once"
    client.post(f"/c/billing/manual/{p['id']}/paid", json={"payer": "Tan"}, headers=th)
    client.post(f"/c/admin/payments/{p['id']}", json={"action": "approve"}, headers=d)
    return th, tm


def test_a_profile_is_listed_only_when_paid_and_checked():
    d, _ = dev()
    th, tm = person("Teacher Tan")
    assert client.get("/c/tutor/me", headers=th).json()["profile"] is None
    assert client.put("/c/tutor/me", json={**PROFILE, "online": False, "in_person": False}, headers=th).status_code == 400
    assert client.put("/c/tutor/me", json=PROFILE, headers=th).json()["profile"]["status"] == "draft"
    assert client.get("/c/tutors").json()["items"] == []                                  # not paid: not listed
    assert client.get(f"/c/tutors/{tm['handle']}").status_code == 404
    p = client.post("/c/billing/manual", json={"product": "teacher"}, headers=th).json()
    client.post(f"/c/billing/manual/{p['id']}/paid", json={"payer": "Tan"}, headers=th)
    client.post(f"/c/admin/payments/{p['id']}", json={"action": "approve"}, headers=d)
    mine = client.get("/c/tutor/me", headers=th).json()["profile"]
    assert mine["paid"] and mine["status"] == "pending"
    assert client.get("/c/tutors").json()["items"] == []                                  # paid but not checked yet
    waiting = client.get("/c/admin/tutors", headers=d).json()["items"]
    assert [w["user"]["handle"] for w in waiting] == [tm["handle"]] and waiting[0]["paid"]
    assert client.post(f"/c/admin/tutors/{tm['handle']}", json={"action": "verify"}, headers=th).status_code == 403
    client.post(f"/c/admin/tutors/{tm['handle']}", json={"action": "verify"}, headers=d)
    got = client.get("/c/tutors", params={"instrument": "violin", "online": True}).json()["items"]
    assert len(got) == 1 and got[0]["verified"] and got[0]["rate"] == "RM 60 an hour" and got[0]["rating"] is None
    assert client.get("/c/tutors", params={"instrument": "piano"}).json()["items"] == []
    assert client.get(f"/c/tutors/{tm['handle']}").json()["bio"].startswith("Twelve years")


def test_lesson_request_accept_confirm_done_and_stars():
    d, _ = dev()
    th, tm = listed_teacher(d)
    client.post(f"/c/admin/tutors/{tm['handle']}", json={"action": "verify"}, headers=d)
    sh, sm = person("Student Siti")
    when = time.time() + 3 * 86400
    r = client.post("/c/lessons", json={"tutor": tm["handle"], "kind": "online", "instrument": "violin", "message": "Grade 3 exam in March"}, headers=sh)
    assert r.status_code == 200, r.text
    lid = r.json()["items"][0]["id"]
    assert r.json()["items"][0]["status"] == "requested" and r.json()["items"][0]["at"] is None     # "whenever suits"
    assert client.post(f"/c/lessons/{lid}", json={"action": "confirm"}, headers=sh).status_code == 400   # not accepted yet
    assert client.post(f"/c/lessons/{lid}", json={"action": "accept"}, headers=th).status_code == 400    # the teacher must name a time
    assert client.post(f"/c/lessons/{lid}", json={"action": "accept", "at": when}, headers=sh).status_code == 400   # only the teacher
    acc = client.post(f"/c/lessons/{lid}", json={"action": "accept", "at": when, "reply": "Saturday 10 am works"}, headers=th).json()["items"][0]
    assert acc["status"] == "accepted" and acc["room"] == "" and acc["role"] == "teacher"
    conf = client.post(f"/c/lessons/{lid}", json={"action": "confirm"}, headers=sh).json()["items"][0]
    assert conf["status"] == "confirmed" and conf["room"].startswith("https://meet.jit.si/Melovyn-") and conf["role"] == "student"
    assert client.get("/c/lessons", headers=th).json()["items"][0]["room"] == conf["room"]             # both see the same room
    assert "lesson" in [n["kind"] for n in client.get("/c/notifications", headers=th).json()["items"]]
    assert client.post(f"/c/lessons/{lid}", json={"action": "done", "rating": 5}, headers=sh).status_code == 400   # it hasn't happened yet
    with academy.engine().begin() as c:
        c.execute(tutors.lessons.update().where(tutors.lessons.c.id == lid).values(at=time.time() - 3600))
    assert client.post(f"/c/lessons/{lid}", json={"action": "done", "rating": 5, "review": "Clear and kind."}, headers=th).status_code == 400
    done = client.post(f"/c/lessons/{lid}", json={"action": "done", "rating": 5, "review": "Clear and kind."}, headers=sh).json()["items"][0]
    assert done["status"] == "done" and done["rating"] == 5
    prof = client.get(f"/c/tutors/{tm['handle']}").json()
    assert prof["rating"] == 5 and prof["ratings"] == 1 and prof["lessons"] == 1 and prof["reviews"][0]["review"] == "Clear and kind."
    # strangers can't see or touch someone else's lesson
    xh, _ = person("Stranger")
    assert client.post(f"/c/lessons/{lid}", json={"action": "cancel"}, headers=xh).status_code == 404
    assert client.post("/c/lessons", json={"tutor": tm["handle"], "kind": "online"}, headers=th).status_code == 400    # not with yourself


def test_teacher_can_decline_and_either_can_cancel():
    d, _ = dev()
    th, tm = listed_teacher(d)
    client.post(f"/c/admin/tutors/{tm['handle']}", json={"action": "verify"}, headers=d)
    sh, _ = person("Siti")
    a = client.post("/c/lessons", json={"tutor": tm["handle"], "kind": "in_person", "at": time.time() + 86400, "weekly": True}, headers=sh).json()["items"][0]
    assert a["weekly"] and a["kind"] == "in_person"
    assert client.post(f"/c/lessons/{a['id']}", json={"action": "decline", "reply": "Fully booked this term"}, headers=th).json()["items"][0]["status"] == "declined"
    b = client.post("/c/lessons", json={"tutor": tm["handle"], "kind": "online", "at": time.time() + 86400}, headers=sh).json()["items"][0]
    assert client.post(f"/c/lessons/{b['id']}", json={"action": "cancel"}, headers=sh).json()["items"][0]["status"] == "cancelled"
    assert client.post("/c/lessons", json={"tutor": tm["handle"], "kind": "online", "at": time.time() + 60}, headers=sh).status_code == 400
    client.post(f"/c/admin/tutors/{tm['handle']}", json={"action": "pause"}, headers=d)
    assert client.post("/c/lessons", json={"tutor": tm["handle"], "kind": "online"}, headers=sh).status_code == 404
