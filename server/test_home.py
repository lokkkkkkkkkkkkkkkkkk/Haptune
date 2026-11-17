"""Home in one call: new things, Learn and Stage band, class pieces; for a teacher, takes to review and quiet students."""
import os
import sys
import time

os.environ.setdefault("HAPTUNE_DATA", "")
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))

import pytest
from fastapi.testclient import TestClient

import academy
import accounts as A
from app import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    academy.reset_engine(f"sqlite:///{tmp_path/'h.db'}")
    monkeypatch.setenv("HAPTUNE_SIGNIN_REQUIRED", "0")
    A.limiter.hits.clear()
    yield


def person(name):
    r = client.post("/c/auth/guest", json={"name": name})
    return {"Authorization": "Bearer " + r.json()["token"]}


def test_home_for_a_guest_and_for_a_teacher_and_student():
    anon = client.get("/c/homescreen").json()
    assert set(anon) >= {"new", "learn", "stage", "class_pieces", "trending"} and anon["learn"]["classes"] == 0
    t, s = person("Ms Tan"), person("Ben")
    tok_t = t["Authorization"].split()[1]
    cls = client.post("/academy/classes", json={"name": "Violin 1"}, headers=t).json()["class"]
    cid, code = cls["id"], cls["join_code"]
    assert client.post("/academy/join", json={"code": code}, headers=s).status_code == 200
    due = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() + 3 * 86400))
    r = client.post(f"/academy/classes/{cid}/assignments", json={"title": "Scales", "piece_title": "Ode to Joy", "due_at": due}, headers=t)
    assert r.status_code == 200, r.text
    h = client.get("/c/homescreen", headers=s).json()
    assert h["learn"]["todo"] == 1 and h["learn"]["next_assignment"]["piece"] == "Ode to Joy" and h["class_pieces"] == ["Ode to Joy"]
    th = client.get("/c/homescreen", headers=t).json()
    assert th["learn"]["teacher"]["students"] == 1 and th["learn"]["teacher"]["inactive"] == 1
    assert "daily" in th["stage"] and th["stage"]["open_requests"] == 0


def test_find_returns_classes_people_and_posts():
    t = person("Ms Tan")
    assert client.post("/c/auth/password", json={"handle": "ms_tan", "password": "longenough1"}, headers=t).status_code == 200
    assert client.post("/academy/classes", json={"name": "Violin Beginners"}, headers=t).status_code == 200
    u = person("Visitor")
    assert client.get("/c/find?q=violin", headers=u).json()["classes"] == []            # private class: not for strangers
    r = client.get("/c/find?q=violin", headers=t).json()
    assert [x["title"] for x in r["classes"]] == ["Violin Beginners"]                  # but yours
    assert [x["handle"] for x in client.get("/c/find?q=tan", headers=u).json()["people"]] == ["ms_tan"]
    assert client.get("/c/find?q=a").json() == {"classes": [], "people": [], "sounds": [], "posts": []}
