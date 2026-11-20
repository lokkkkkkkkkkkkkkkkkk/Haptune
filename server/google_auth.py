"""Sign in with Google without Google's button iframe (Part 4).

Google's "Continue as …" button runs inside an iframe and hands the result back from a popup; when a browser
blocks that hand-back (third-party cookie and storage rules, an extension, a stale One Tap set-up), the click
opens and closes Google's window and nothing happens. These two ways don't depend on it:

  popup     the website asks Google for a one-time code with Google's OAuth popup (the same window the
            Calendar / Drive permissions use, redirect "postmessage", nothing to register) and sends it to
            POST /c/auth/google/code. The server swaps it for tokens with GOOGLE_CLIENT_SECRET and checks the
            ID token.
  redirect  if the popup can't open, the whole page goes to Google and comes back:
            POST /c/auth/google/start -> Google -> GET /c/auth/google/callback -> the website with a one-time
            code in the address (#gsignin=…) -> POST /c/auth/google/finish. The callback address must be in
            the Web client's "Authorised redirect URIs" (SETUP.md §3f). The phone app uses it with a pairing
            code: the browser signs in and the app, which waits on the code, is signed in to the same account.

Both ask only for name and email (openid email profile) so every Google user can sign in without an
"unverified app" screen; Calendar, Drive and Contacts are asked for right after, in one step (google_link.py).
A Google account in an app whose OAuth consent screen is still "Testing" must be on its test user list: Google
then answers access_denied, and the app says exactly that.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import urllib.parse

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, insert, select, update

import accounts as A
import google_link as G
from academy import _now, engine

router = APIRouter(prefix="/c/auth/google", tags=["signin"])

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
BASIC = "openid email profile"
STATE_TTL = 900.0
LOGIN_TTL = 300.0


def _exchange(code: str, redirect_uri: str, client_id: str = "") -> tuple[dict, dict]:
    """Code -> tokens -> checked ID-token claims. `client_id`: the client the code was asked for."""
    cid, secret = G._client(client_id)
    r = G._http("POST", G.TOKEN_URL, form={"code": code, "client_id": cid, "client_secret": secret, "redirect_uri": redirect_uri, "grant_type": "authorization_code"})
    if not r.get("id_token"):
        raise HTTPException(400, {"code": "google_no_id", "message": "Google did not say who you are. Please try again."})
    info = A.verify_google(r["id_token"])
    if client_id:
        G.remember_web_client(cid)
    return r, info


def _after(uid: str, r: dict, email: str) -> None:
    """Permissions granted earlier come back with include_granted_scopes: keep them linked."""
    granted = set((r.get("scope") or "").split())
    if granted & set(G.SCOPES.values()):
        try:
            G.store_grant(uid, granted, r, email)
        except HTTPException:
            pass                                    # signing in still works; Connections asks again


class CodeIn(BaseModel):
    code: str = Field(..., min_length=10, max_length=2048)
    device: str = Field("", max_length=60)
    client_id: str = Field("", max_length=200)     # the Web client the website's popup used


@router.post("/code")
def with_code(body: CodeIn, request: Request, authorization: str = Header("")):
    A.rate(request, "google", 30, 3600)
    r, info = _exchange(body.code, "postmessage", body.client_id)
    tok = A._token(authorization)
    here = A.user_from_token(tok)
    out = A.google_login(info, here, tok if here else None, body.device, request)
    _after(out["me"]["id"], r, out["me"].get("email") or "")
    return out


# ------------------------------------------------------------------------------------------------ redirect
def _public_base(request: Request) -> str:
    env = os.environ.get("HAPTUNE_PUBLIC_URL", "").strip().rstrip("/")
    if env:
        return env
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    if not re.match(r"^(localhost|127\.0\.0\.1)(:\d+)?$", host):
        proto = "https"
    return f"{proto}://{host}"


def callback_url(request: Request) -> str:
    return f"{_public_base(request)}/c/auth/google/callback"


def _allowed_return(url: str) -> bool:
    """Only back to our own website (or this machine, for tests): never an open redirect."""
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if u.scheme not in ("http", "https") or not u.netloc:
        return False
    origin = f"{u.scheme}://{u.netloc}"
    site = os.environ.get("HAPTUNE_SITE_URL", "https://haptune.name.my").rstrip("/")
    if origin == site or re.match(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$", origin):
        return True
    extra = os.environ.get("HAPTUNE_CORS_ORIGINS", "")
    return any(x.strip() and (x.strip() == origin or (x.strip() == ".*")) for x in extra.split(","))


class StartIn(BaseModel):
    return_to: str = Field(..., max_length=300)
    pair: str = Field("", max_length=12)
    device: str = Field("", max_length=60)
    hint: str = Field("", max_length=200)
    client_id: str = Field("", max_length=200)
    fresh: bool = False                             # switching account: don't link to the account signed in here


@router.post("/start")
def start(body: StartIn, request: Request, authorization: str = Header("")):
    A.rate(request, "google-start", 60, 3600)
    if not _allowed_return(body.return_to):
        raise HTTPException(400, "That return address isn't allowed.")
    cid, _ = G._client(body.client_id)
    here = None if body.fresh else A.user_from_token(A._token(authorization))
    state = secrets.token_urlsafe(24)
    with engine().begin() as c:
        c.execute(insert(A.kv).values(k=f"gstate:{state}", v=json.dumps({"ret": body.return_to.split("#")[0], "uid": here["id"] if here else None,
                                                                           "pair": re.sub(r"[^A-Z0-9]", "", body.pair.upper()), "device": body.device, "cid": cid if body.client_id else "", "at": _now()})))
    q = {"client_id": cid, "redirect_uri": callback_url(request), "response_type": "code", "scope": BASIC, "state": state,
         "include_granted_scopes": "true", "access_type": "offline", "prompt": "select_account"}
    if body.hint:
        q["login_hint"] = body.hint
    return {"url": f"{AUTH_URL}?{urllib.parse.urlencode(q)}"}


def _pop(c, key: str, ttl: float) -> dict | None:
    row = c.execute(select(A.kv.c.v).where(A.kv.c.k == key)).scalar()
    c.execute(delete(A.kv).where(A.kv.c.k == key))
    d = json.loads(row) if row else None
    return d if d and d.get("at", 0) + ttl >= _now() else None


@router.get("/callback")
def callback(request: Request, state: str = "", code: str = "", error: str = ""):
    with engine().begin() as c:
        st = _pop(c, f"gstate:{state[:60]}", STATE_TTL) if state else None
    if not st:
        return RedirectResponse(os.environ.get("HAPTUNE_SITE_URL", "https://haptune.name.my").rstrip("/") + "/app/#gsignin_error=expired", status_code=303)
    ret = st["ret"]
    if error or not code:
        return RedirectResponse(f"{ret}#gsignin_error={urllib.parse.quote((error or 'cancelled')[:40])}", status_code=303)
    try:
        r, info = _exchange(code, callback_url(request), st.get("cid") or "")
        here = None
        if st.get("uid"):
            from academy import users as U
            with engine().connect() as c:
                row = c.execute(select(U).where(U.c.id == st["uid"])).mappings().first()
            here = dict(row) if row else None
        out = A.google_login(info, here, None, st.get("device") or "Google", request)
    except HTTPException as e:
        msg = e.detail.get("code") if isinstance(e.detail, dict) else "failed"
        return RedirectResponse(f"{ret}#gsignin_error={urllib.parse.quote(str(msg)[:40])}", status_code=303)
    uid = out["me"]["id"]
    _after(uid, r, out["me"].get("email") or "")
    with engine().begin() as c:
        if st.get("pair"):                                       # the phone app waits on this pairing code
            d = A._pair_get(c, st["pair"])
            if d is not None:
                d["user"] = uid
                c.execute(update(A.kv).where(A.kv.c.k == f"pair:{st['pair']}").values(v=json.dumps(d)))
                return RedirectResponse(f"{ret}#gsignin=paired", status_code=303)
        one = secrets.token_urlsafe(24)
        c.execute(insert(A.kv).values(k=f"glogin:{one}", v=json.dumps({"token": out["token"], "at": _now()})))
    return RedirectResponse(f"{ret}#gsignin={one}", status_code=303)


class FinishIn(BaseModel):
    code: str = Field(..., min_length=10, max_length=80)


@router.post("/finish")
def finish(body: FinishIn, request: Request):
    A.rate(request, "google-finish", 60, 3600)
    with engine().begin() as c:
        d = _pop(c, f"glogin:{body.code}", LOGIN_TTL)
    if not d:
        raise HTTPException(404, {"code": "expired", "message": "That sign-in has expired. Please try again."})
    return {"token": d["token"], "me": A.me_json(A.current(f"Bearer {d['token']}"))}


@router.get("/status")
def status(request: Request, web: str = ""):
    """What the website needs to know before showing Google's sign-in (no secrets): whether it's set up, the client
    and the callback address to register. `web`: the website's own client ID; `web_known` says whether the server
    accepts it (when it doesn't, Google's window shows "no registered origin" or the code can't be swapped)."""
    ids = A.google_client_ids()
    out = {"configured": bool(ids and os.environ.get("GOOGLE_CLIENT_SECRET")), "client_id": G.web_client_id(ids), "callback": callback_url(request)}
    if web:
        out["web_known"] = web in ids
    return out
