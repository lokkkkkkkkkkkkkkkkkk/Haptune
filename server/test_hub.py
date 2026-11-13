"""The teaching hub: sign-in rule, Google sign-in, app pairing, open classes, shared takes and progress."""
import base64
import os
import sys


os.environ.setdefault("HAPTUNE_DATA", "")
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))

import pytest
from fastapi.testclient import TestClient

import academy
import accounts
from app import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setenv("HAPTUNE_SIGNIN_REQUIRED", "1")
    academy.reset_engine(f"sqlite:///{tmp_path/'hub.db'}")
    yield


def guest(name="Sam"):
    r = client.post("/c/auth/guest", json={"name": name})
    assert r.status_code == 200
    return {"Authorization": "Bearer " + r.json()["token"]}


def google(monkeypatch, sub, email="a@example.com", name="Ana"):
    monkeypatch.setattr(accounts, "verify_google", lambda cred: {"sub": sub, "email": email, "email_verified": "true", "given_name": name})


def test_sign_in_is_needed_to_teach_join_and_post(monkeypatch):
    h = guest()
    r = client.post("/academy/classes", json={"name": "Piano"}, headers=h)
    assert r.status_code == 401 and r.json()["detail"]["code"] == "signin_required"
    assert client.post("/c/posts", json={"type": "question", "title": "Hi there", "body": "hello"}, headers=h).status_code == 401
    assert client.get("/c/me", headers=h).json()["registered"] is False
    # Google sign-in links Google to the account this device already has
    google(monkeypatch, "g-1")
    r = client.post("/c/auth/google", json={"credential": "x" * 40}, headers=h)
    assert r.status_code == 200
    me = r.json()["me"]
    assert me["registered"] and me["google"] and me["email"] == "a@example.com"
    assert client.post("/academy/classes", json={"name": "Piano"}, headers=h).status_code == 200
    # signing in again (another device, no token) reaches the same account
    r2 = client.post("/c/auth/google", json={"credential": "y" * 40})
    assert r2.json()["me"]["id"] == me["id"] and r2.json()["token"] != h["Authorization"][7:]
    # a username and password also counts
    h2 = guest("Lee")
    assert client.post("/c/auth/password", json={"handle": "lee_music", "password": "longenough1"}, headers=h2).status_code == 200
    assert client.get("/c/me", headers=h2).json()["registered"] is True


def test_hub_role_is_remembered():
    h = guest()
    assert client.patch("/c/me", json={"hub_role": "teacher"}, headers=h).json()["hub_role"] == "teacher"
    assert client.patch("/c/me", json={"hub_role": "pirate"}, headers=h).json()["hub_role"] == ""


def test_pairing_signs_the_app_in(monkeypatch):
    code = client.post("/c/auth/pair").json()["code"]
    assert client.get(f"/c/auth/pair/{code}").json()["status"] == "waiting"
    web = guest()
    assert client.post(f"/c/auth/pair/{code}/approve", headers=web).status_code == 401      # the website must be signed in
    google(monkeypatch, "g-2")
    client.post("/c/auth/google", json={"credential": "z" * 40}, headers=web)
    assert client.post(f"/c/auth/pair/{code}/approve", headers=web).status_code == 200
    done = client.get(f"/c/auth/pair/{code}").json()
    assert done["status"] == "done" and done["me"]["google"]
    assert client.get(f"/c/auth/pair/{code}").status_code == 404                            # codes work once


def signed_in(monkeypatch, sub, name):
    h = guest(name)
    google(monkeypatch, sub, f"{sub}@example.com", name)
    client.post("/c/auth/google", json={"credential": "c" * 40}, headers=h)
    return h


def test_open_classes_links_takes_and_progress(monkeypatch):
    teacher = signed_in(monkeypatch, "t", "Ms Tan")
    cl = client.post("/academy/classes", json={"name": "Open Violin", "description": "Beginners welcome", "visibility": "public", "instrument": "violin"}, headers=teacher).json()["class"]
    private = client.post("/academy/classes", json={"name": "Private Piano"}, headers=teacher).json()["class"]
    found = client.get("/academy/discover", params={"q": "violin"}).json()["classes"]
    assert [c["name"] for c in found] == ["Open Violin"] and found[0]["teacher"]["name"] == "Ms Tan"
    assert client.get("/academy/discover").json()["classes"][0]["id"] == cl["id"]           # private classes are not listed
    # a link or QR code shows the class before joining
    pv = client.get(f"/academy/preview/{private['join_code']}").json()
    assert pv["class"]["name"] == "Private Piano"
    student = signed_in(monkeypatch, "s", "Ben")
    assert client.post(f"/academy/classes/{private['id']}/join", headers=student).status_code == 404   # private: code only
    assert client.post(f"/academy/classes/{cl['id']}/join", headers=student).json()["class"]["role"] == "student"
    # the student shares a practice take with its recording and the notes that went wrong
    audio = base64.b64encode(b"\x00" * 2000).decode()
    r = client.post("/academy/takes", json={"class_ids": [cl["id"]], "piece_title": "Minuet", "accuracy": 0.72, "seconds": 95, "mode": "wait",
                                            "bars": [[1, 1.0], [2, 0.5], [3, 0.8]], "wrong": [{"bar": 2, "want": "F#5", "played": "F5"}],
                                            "recording_b64": audio, "recording_type": "audio/webm"}, headers=student)
    assert r.status_code == 200
    tid = r.json()["takes"][0]
    assert client.post("/academy/takes", json={"class_ids": [private["id"]], "accuracy": 0.5}, headers=student).status_code == 403
    # the teacher sees everyone's progress, then one student, and can listen and comment
    prog = client.get(f"/academy/classes/{cl['id']}/progress", headers=teacher).json()["students"]
    assert prog[0]["name"] == "Ben" and prog[0]["takes"] == 1 and prog[0]["accuracy"] == 72 and prog[0]["recordings"] == 1
    assert client.get(f"/academy/classes/{cl['id']}/progress", headers=student).status_code == 403
    sid = prog[0]["id"]
    det = client.get(f"/academy/classes/{cl['id']}/students/{sid}", headers=teacher).json()
    assert det["items"][0]["wrong"][0]["want"] == "F#5" and det["tricky"][0]["bar"] == 2
    rec = client.get(f"/academy/takes/{tid}/recording", headers=teacher)
    assert rec.status_code == 200 and rec.headers["content-type"] == "audio/webm" and len(rec.content) == 2000
    assert client.post(f"/academy/takes/{tid}/feedback", json={"text": "Watch the F sharp", "focus_bars": [2]}, headers=teacher).status_code == 200
    mine = client.get(f"/academy/classes/{cl['id']}/students/{sid}", headers=student).json()
    assert mine["items"][0]["feedback"][0]["text"] == "Watch the F sharp"
    # the teacher can close the class to new people by changing the code, or make it private
    old = cl["join_code"]
    ed = client.patch(f"/academy/classes/{cl['id']}", json={"visibility": "private", "new_code": True}, headers=teacher).json()
    assert ed["visibility"] == "private" and ed["join_code"] != old
    assert client.get(f"/academy/preview/{old}").status_code == 404
