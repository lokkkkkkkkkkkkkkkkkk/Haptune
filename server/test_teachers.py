"""Verified teachers: the permission matrix (teachers.py)."""
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
    monkeypatch.setenv("HAPTUNE_TEACHER_DOMAINS", "musicschool.edu.my")
    monkeypatch.setenv("HAPTUNE_ADMIN_CODE", "dev-code-long-enough")
    academy.reset_engine(f"sqlite:///{tmp_path/'t.db'}")
    yield
    accounts.limiter.hits.clear()          # these tests make many accounts from one address


def guest(name="Sam"):
    r = client.post("/c/auth/guest", json={"name": name})
    return {"Authorization": "Bearer " + r.json()["token"]}


def google_user(monkeypatch, sub, email, name="Ana"):
    h = guest(name)
    monkeypatch.setattr(accounts, "verify_google", lambda cred: {"sub": sub, "email": email, "email_verified": "true", "given_name": name})
    assert client.post("/c/auth/google", json={"credential": "c" * 40}, headers=h).status_code == 200
    return h


def admin(monkeypatch):
    h = google_user(monkeypatch, "admin", "dev@example.com", "Dev")
    assert client.post("/c/me/dev", json={"code": "dev-code-long-enough"}, headers=h).status_code == 200
    return h


def test_unverified_teacher_runs_a_small_private_class_only(monkeypatch):
    t = google_user(monkeypatch, "t1", "teacher@gmail.com", "Ms Lim")
    assert client.get("/c/me", headers=t).json()["verified_teacher"] is False
    # open class: no; private class: yes
    r = client.post("/academy/classes", json={"name": "Open", "visibility": "public"}, headers=t)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "teacher_unverified"
    cl = client.post("/academy/classes", json={"name": "Piano"}, headers=t).json()["class"]
    assert client.patch(f"/academy/classes/{cl['id']}", json={"visibility": "public"}, headers=t).status_code == 403
    # three students may join; the fourth is turned away
    for i in range(3):
        s = google_user(monkeypatch, f"s{i}", f"s{i}@gmail.com", f"S{i}")
        assert client.post("/academy/join", json={"code": cl["join_code"]}, headers=s).status_code == 200
    s4 = google_user(monkeypatch, "s4", "s4@gmail.com", "S4")
    r = client.post("/academy/join", json={"code": cl["join_code"]}, headers=s4)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "class_full_unverified"
    # reports of the small class still reach the teacher
    assert client.get(f"/academy/classes/{cl['id']}/progress", headers=t).status_code == 200


def test_music_school_domain_is_verified_at_once(monkeypatch):
    t = google_user(monkeypatch, "t2", "ms.tan@musicschool.edu.my", "Ms Tan")
    r = client.post("/c/teacher/verify", json={"org": "KL Music School", "role_text": "Piano teacher"}, headers=t).json()
    assert r["verified"] and r["method"] == "domain"
    assert client.get("/c/me", headers=t).json()["verified_teacher"] is True
    cl = client.post("/academy/classes", json={"name": "Open Piano", "visibility": "public"}, headers=t)
    assert cl.status_code == 200
    found = client.get("/academy/discover").json()["classes"][0]
    assert found["teacher"]["verified"] is True
    for i in range(5):                                          # no student limit for a verified teacher
        s = google_user(monkeypatch, f"x{i}", f"x{i}@gmail.com", f"X{i}")
        assert client.post(f"/academy/classes/{cl.json()['class']['id']}/join", headers=s).status_code == 200


def test_review_flow_with_a_document(monkeypatch):
    t = google_user(monkeypatch, "t3", "piano.lee@gmail.com", "Mr Lee")
    pdf = base64.b64encode(b"%PDF-1.4 fake staff card").decode()
    r = client.post("/c/teacher/verify", json={"org": "Lee Piano Studio", "doc_b64": pdf, "doc_type": "application/pdf"}, headers=t).json()
    assert r["status"] == "pending" and r["has_doc"] and not r["verified"]
    # a file that lies about its type is refused
    bad = base64.b64encode(b"<html>not a pdf</html>").decode()
    assert client.post("/c/teacher/verify", json={"org": "XY", "doc_b64": bad, "doc_type": "application/pdf"}, headers=t).status_code == 415
    assert client.post("/c/teacher/verify", json={"org": "XY", "doc_b64": bad, "doc_type": "text/html"}, headers=t).status_code == 415
    # only the developer sees the queue and the document, and decides
    assert client.get("/c/admin/teachers", headers=t).status_code == 403
    a = admin(monkeypatch)
    q = client.get("/c/admin/teachers", headers=a).json()["teachers"]
    assert [x["org"] for x in q] == ["Lee Piano Studio"] and q[0]["has_doc"]
    doc = client.get(f"/c/admin/teachers/{q[0]['user_id']}/doc", headers=a)
    assert doc.headers["content-type"] == "application/pdf" and "attachment" in doc.headers["content-disposition"]
    assert client.post(f"/c/admin/teachers/{q[0]['user_id']}", json={"decision": "verify"}, headers=a).json()["verified"]
    assert client.post("/academy/classes", json={"name": "Open", "visibility": "public"}, headers=t).status_code == 200
    kinds = [n["kind"] for n in client.get("/c/notifications", headers=t).json()["items"]]
    assert "teacher_verified" in kinds


def test_who_cannot_ask_to_be_verified(monkeypatch):
    g = guest()
    assert client.post("/c/teacher/verify", json={"org": "School"}, headers=g).status_code == 401      # not signed in
    p = guest("Pat")
    assert client.post("/c/auth/password", json={"handle": "pat_music", "password": "longenough1"}, headers=p).status_code == 200
    r = client.post("/c/teacher/verify", json={"org": "School"}, headers=p)                             # no verified email
    assert r.status_code == 400 and r.json()["detail"]["code"] == "verified_email_needed"
    assert client.post("/c/teacher/verify", json={"org": "School"}).status_code == 401                  # no token at all


def test_developer_is_always_verified(monkeypatch):
    a = admin(monkeypatch)
    assert client.get("/c/teacher/verify", headers=a).json()["verified"] is True
    assert client.post("/academy/classes", json={"name": "Dev open", "visibility": "public"}, headers=a).status_code == 200
