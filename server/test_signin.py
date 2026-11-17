"""Sign in with Apple (a real RS256 check against a key we make), the sign-in methods list, never removing the
last way in, and account deletion / export covering the Part 2 data."""
import base64
import json
import os
import sys
import time

os.environ.setdefault("HAPTUNE_DATA", "")
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi.testclient import TestClient

import academy
import accounts as A
import signin
from app import app

client = TestClient(app)
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def jwk():
    n = KEY.public_key().public_numbers()
    return {"kid": "k1", "kty": "RSA", "alg": "RS256", "n": b64(n.n.to_bytes(256, "big")), "e": b64(n.e.to_bytes(3, "big"))}


def apple_token(sub="apple-001", aud="my.melovyn.web", exp=None, email="ana@privaterelay.appleid.com"):
    head = b64(json.dumps({"alg": "RS256", "kid": "k1"}).encode())
    body = b64(json.dumps({"iss": "https://appleid.apple.com", "aud": aud, "sub": sub, "exp": exp or time.time() + 600, "email": email, "email_verified": "true"}).encode())
    sig = KEY.sign(f"{head}.{body}".encode(), padding.PKCS1v15(), hashes.SHA256())
    return f"{head}.{body}.{b64(sig)}"


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    academy.reset_engine(f"sqlite:///{tmp_path/'si.db'}")
    monkeypatch.setenv("APPLE_CLIENT_IDS", "my.melovyn.web,my.melovyn.app")
    monkeypatch.setattr(signin, "_apple_keys", lambda: {"k1": jwk()})
    yield
    A.limiter.hits.clear()


def test_apple_token_is_checked_for_real():
    claims = signin.verify_apple(apple_token())
    assert claims["sub"] == "apple-001"
    with pytest.raises(Exception):
        signin.verify_apple(apple_token(aud="someone.else"))
    with pytest.raises(Exception):
        signin.verify_apple(apple_token(exp=time.time() - 5))
    t = apple_token()
    head, body, sig = t.split(".")
    forged = b64(json.dumps({**json.loads(base64.urlsafe_b64decode(body + "==")), "sub": "someone-else"}).encode())
    with pytest.raises(Exception):
        signin.verify_apple(f"{head}.{forged}.{sig}")


def test_apple_sign_in_links_to_this_device_then_signs_in_elsewhere():
    guest = client.post("/c/auth/guest", json={"name": "Ana"}).json()
    h = {"Authorization": f"Bearer {guest['token']}"}
    r = client.post("/c/auth/apple", json={"id_token": apple_token(), "name": "Ana"}, headers=h).json()
    assert r["me"]["id"] == guest["me"]["id"]                    # this device's account got Apple
    other = client.post("/c/auth/apple", json={"id_token": apple_token()}).json()
    assert other["me"]["id"] == guest["me"]["id"] and other["token"] != guest["token"]
    m = client.get("/c/me/signin", headers=h).json()
    assert {x["id"]: x["linked"] for x in m["methods"]} == {"google": False, "apple": True, "password": False}
    # Apple is the only way in: it can't be removed
    assert client.delete("/c/me/signin/apple", headers=h).status_code == 409
    assert client.post("/c/auth/password", json={"handle": "ana_k", "password": "longenough1"}, headers=h).status_code == 200
    m = client.get("/c/me/signin", headers=h).json()
    assert [x["id"] for x in m["methods"] if x["can_remove"]] == ["apple"]
    assert client.delete("/c/me/signin/apple", headers=h).status_code == 200
    assert client.post("/c/auth/apple", json={"id_token": apple_token()}).json()["me"]["id"] != guest["me"]["id"]   # no longer linked


def test_delete_and_export_cover_friends_messages_and_parents():
    def user(name):
        h = {"Authorization": "Bearer " + client.post("/c/auth/guest", json={"name": name}).json()["token"]}
        client.post("/c/auth/password", json={"handle": name.lower() + "_q", "password": "longenough1"}, headers=h)
        return h
    a, b = user("Ana"), user("Ben")
    client.post("/c/friends/ben_q", headers=a)
    client.post("/c/friends/ana_q", headers=b)
    client.post("/c/dms/ben_q", json={"text": "hello"}, headers=a)
    client.post("/academy/me/guardians", json={"email": "mum@example.com"}, headers=a)
    data = client.get("/c/me/export", headers=a).json()
    assert len(data["friends"]) == 1 and data["messages"][0]["text"] == "hello" and data["guardians"][0]["email"] == "mum@example.com"
    assert client.delete("/c/me", headers=a).json() == {"deleted": True}
    import learn
    assert client.get("/c/friends", headers=b).json()["friends"] == []
    assert client.get("/c/dms", headers=b).json()["items"] == []
    with academy.engine().connect() as c:
        assert c.execute(learn.guardians.select()).first() is None
