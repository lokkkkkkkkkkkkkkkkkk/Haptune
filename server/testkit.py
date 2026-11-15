"""Helpers for the server tests: make an account staff with Developer mode on (2-step verification included)."""
import uuid

import accounts as A


def two_step(client, h) -> str:
    """Sets up and turns on 2-step verification; returns the secret (codes: A.totp(secret, offset))."""
    secret = client.post("/c/me/2fa/setup", headers=h).json()["secret"]
    r = client.post("/c/me/2fa/enable", json={"code": A.totp(secret)}, headers=h)
    assert r.status_code == 200, r.text
    return secret


def dev_mode_on(client, h, secret: str | None = None, offset: int = 1) -> dict:
    """Switches Developer mode on for this sign-in (a later code than the last one used: each code works once)."""
    secret = secret or two_step(client, h)
    r = client.post("/c/me/devmode", json={"on": True, "code": A.totp(secret, offset)}, headers=h)
    assert r.status_code == 200, r.text
    return {"secret": secret, "me": r.json()}


def make_developer(client, h, code: str) -> dict:
    """The earlier route (HAPTUNE_ADMIN_CODE), then Developer mode on: a developer with every scope."""
    client.post("/c/auth/password", json={"handle": "dev_" + uuid.uuid4().hex[:8], "password": "longenough1"}, headers=h)
    assert client.post("/c/me/dev", json={"code": code}, headers=h).status_code == 200
    return dev_mode_on(client, h)["me"]
