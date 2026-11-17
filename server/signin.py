"""Sign-in at the core (Part 2 E): Sign in with Apple next to Google and username + password, and the list of
ways someone signs in with a safe way to remove one.

Apple     the app gets an identity token (a JWT signed by Apple) from "Sign in with Apple" (web: Apple's JS
          popup; iPhone: the native sheet). The server checks it against Apple's public keys
          (https://appleid.apple.com/auth/keys, kept for an hour), the issuer, the audience (APPLE_CLIENT_IDS:
          the Services ID for the web and the bundle ID for the app) and the expiry. Like Google: a known Apple
          account signs in; a new one is linked to the account on this device, or gets a new account.
Methods   GET /c/me/signin lists Google, Apple and username + password; DELETE /c/me/signin/{google|apple}
          removes one only while another way to sign in remains, so nobody locks themselves out.
"""
from __future__ import annotations

import base64
import json
import os
import time
import urllib.request

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, update

import accounts as A
from academy import engine, users

router = APIRouter(prefix="/c", tags=["signin"])

APPLE_ISS = "https://appleid.apple.com"
_keys: dict = {"at": 0.0, "keys": {}}


def apple_client_ids() -> list[str]:
    return [x.strip() for x in os.environ.get("APPLE_CLIENT_IDS", "").split(",") if x.strip()]


def _b64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _apple_keys() -> dict:
    if time.time() - _keys["at"] < 3600 and _keys["keys"]:
        return _keys["keys"]
    with urllib.request.urlopen(APPLE_ISS + "/auth/keys", timeout=15) as r:
        data = json.load(r)
    _keys.update(at=time.time(), keys={k["kid"]: k for k in data.get("keys", [])})
    return _keys["keys"]


def verify_jwt_rs256(token: str, jwk: dict) -> dict:
    """Checks an RS256 signature with a JSON Web Key and returns the claims (no other checks)."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    head, body, sig = token.split(".")
    pub = rsa.RSAPublicNumbers(int.from_bytes(_b64(jwk["e"]), "big"), int.from_bytes(_b64(jwk["n"]), "big")).public_key()
    pub.verify(_b64(sig), f"{head}.{body}".encode(), padding.PKCS1v15(), hashes.SHA256())
    return json.loads(_b64(body))


def verify_apple(id_token: str) -> dict:
    """Checks an Apple identity token and returns its claims. Tests replace this function."""
    ids = apple_client_ids()
    if not ids:
        raise HTTPException(503, "Sign in with Apple isn't set up on this server yet.")
    try:
        head = json.loads(_b64(id_token.split(".")[0]))
        if head.get("alg") != "RS256":
            raise ValueError("alg")
        jwk = _apple_keys().get(head.get("kid"))
        if jwk is None:                                   # Apple rotated its keys: fetch them again once
            _keys["at"] = 0
            jwk = _apple_keys().get(head.get("kid"))
        claims = verify_jwt_rs256(id_token, jwk)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(401, "Apple could not confirm that sign-in. Please try again.")
    if claims.get("iss") != APPLE_ISS or claims.get("aud") not in ids:
        raise HTTPException(401, "That Apple sign-in was meant for another app.")
    if float(claims.get("exp", 0)) < time.time():
        raise HTTPException(401, "That Apple sign-in has expired. Please try again.")
    if not claims.get("sub"):
        raise HTTPException(401, "Apple did not say who you are.")
    return claims


class AppleIn(BaseModel):
    id_token: str = Field(..., min_length=20, max_length=4096)
    name: str = Field("", max_length=60)                  # Apple sends the name only the first time, to the app
    device: str = Field("", max_length=60)


@router.post("/auth/apple")
def apple_signin(body: AppleIn, request: Request, authorization: str = Header("")):
    A.rate(request, "apple", 30, 3600)
    info = verify_apple(body.id_token)
    sub = str(info["sub"])[:64]
    verified = str(info.get("email_verified", "true")).lower() in ("true", "1")
    email = (info.get("email") or "")[:200] if verified else ""
    name = body.name.strip()[:60]
    with engine().begin() as c:
        uid = c.execute(select(A.accounts.c.user_id).where(A.accounts.c.apple_sub == sub)).scalar()
        if uid:
            token = A._session(c, uid, body.device or "Apple")
        else:
            here = A.user_from_token(A._token(authorization))
            acc = c.execute(select(A.accounts).where(A.accounts.c.user_id == here["id"])).mappings().first() if here else None
            if here and acc and not acc["apple_sub"]:
                uid = here["id"]
                token = A._token(authorization)
                c.execute(update(A.accounts).where(A.accounts.c.user_id == uid).values(apple_sub=sub, email=acc["email"] or email))
                if name and here.get("name") in ("", "Musician"):
                    c.execute(update(users).where(users.c.id == uid).values(name=name))
            else:
                user, token = A._new_identity(c, name)
                uid = user["id"]
                A.ensure_account(c, user)
                c.execute(update(A.accounts).where(A.accounts.c.user_id == uid).values(apple_sub=sub, email=email))
    A._signed_in(uid, "apple", request, body.device)
    return {"token": token, "me": A.me_json(A.current(f"Bearer {token}"))}


def _methods(acc: dict) -> list[dict]:
    return [{"id": "google", "linked": bool(acc.get("google_sub")), "email": acc.get("email") if acc.get("google_sub") else None},
            {"id": "apple", "linked": bool(acc.get("apple_sub"))},
            {"id": "password", "linked": bool(acc.get("pw_hash")), "handle": acc.get("handle") if acc.get("pw_hash") else None}]


@router.get("/me/signin")
def signin_methods(me: A.Me = Depends(A.current)):
    ms = _methods(me.acc)
    n = sum(m["linked"] for m in ms)
    return {"methods": [{**m, "can_remove": m["linked"] and n > 1 and m["id"] != "password"} for m in ms],
            "google_available": bool(A.google_client_ids()), "apple_available": bool(apple_client_ids())}


@router.delete("/me/signin/{method}")
def remove_method(method: str, me: A.Me = Depends(A.current)):
    if method not in ("google", "apple"):
        raise HTTPException(400, "Only Google or Apple can be removed here.")
    with engine().begin() as c:
        acc = dict(c.execute(select(A.accounts).where(A.accounts.c.user_id == me.id)).mappings().first())
        left = [m for m in _methods(acc) if m["linked"] and m["id"] != method]
        if not left:
            raise HTTPException(409, {"code": "last_method", "message": "This is your only way to sign in. Add a username and password (or another one) first."})
        col = "google_sub" if method == "google" else "apple_sub"
        c.execute(update(A.accounts).where(A.accounts.c.user_id == me.id).values(**{col: None}))
        A.audit(c, me, f"signin_removed_{method}", me.id)
    if method == "google":
        try:                                                # the Calendar / Drive / Contacts links go with it
            import google_link
            google_link.revoke("all", me)
        except Exception:                                   # noqa: BLE001
            pass
    return signin_methods(A.reload(me.id, me))
