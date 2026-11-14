"""Google account connections, asked for only when a feature is used (incremental authorisation).

Signing in with Google (accounts.py) asks for nothing but the person's name and email. Each feature below asks
Google for its own permission the first time someone uses it, and for nothing else:

  calendar   https://www.googleapis.com/auth/calendar.events   lessons and class sessions become calendar events
                                                                 with a Google Meet link, reminders and
                                                                 attendees; edits made in Google Calendar come
                                                                 back (two-way)
  drive      https://www.googleapis.com/auth/drive.file         export reports, sheets and sounds to Drive (only
                                                                 files Melovyn makes; it cannot see anything else)
  contacts   https://www.googleapis.com/auth/contacts.readonly  optional: pick students' emails to invite

The web app gets a one-time code from Google Identity Services (initCodeClient, ux_mode "popup",
include_granted_scopes) for exactly the scope it needs and sends it to POST /c/google/connect. The server swaps
it for tokens (GOOGLE_CLIENT_SECRET stays on the server) and keeps the refresh token encrypted with
HAPTUNE_TOKEN_KEY (AES-GCM). Access tokens live only in memory. Account > Connections lists what is linked and
can revoke each permission or everything (revoking also tells Google).

WhatsApp has no free public API: the app shares invites with wa.me links instead, and anyone not on Google can
download a class's sessions as an .ics calendar file (academy sessions).
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
import time
import urllib.parse
import urllib.request

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import JSON, Column, Float, String, Table, Text, delete, insert, select, update

import accounts as A
from academy import _now, engine, meta

router = APIRouter(prefix="/c/google", tags=["google"])

SCOPES = {
    "calendar": "https://www.googleapis.com/auth/calendar.events",
    "drive": "https://www.googleapis.com/auth/drive.file",
    "contacts": "https://www.googleapis.com/auth/contacts.readonly",
}
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink"
PEOPLE = "https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses&pageSize=200"
MAX_DRIVE = 25 * 1024 * 1024

links = Table("google_links", meta,
              Column("user_id", String(36), primary_key=True),
              Column("scopes", JSON, nullable=True),                 # features granted: ["calendar", ...]
              Column("refresh_enc", Text, nullable=False),
              Column("email", String(200), nullable=False, default=""),
              Column("created", Float, nullable=False),
              Column("updated", Float, nullable=False))

_access: dict[str, tuple[str, float]] = {}                         # user id -> (access token, expiry)
_lock = threading.Lock()


# ------------------------------------------------------------------------------------------------ plumbing
def _http(method: str, url: str, *, token: str | None = None, data: bytes | None = None, form: dict | None = None,
          headers: dict | None = None, timeout: float = 20) -> dict:
    """One call to a Google API. Tests replace this function."""
    h = dict(headers or {})
    if token:
        h["Authorization"] = f"Bearer {token}"
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        h["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
    except urllib.error.HTTPError as e:
        raise HTTPException(502 if e.code >= 500 else 400, f"Google said no ({e.code}).")
    except Exception:
        raise HTTPException(502, "Could not reach Google. Please try again.")
    return json.loads(body) if body else {}


def _key() -> bytes:
    secret = os.environ.get("HAPTUNE_TOKEN_KEY", "")
    if len(secret) < 16:
        raise HTTPException(503, "Google connections aren't set up on this server yet.")
    return hashlib.sha256(secret.encode()).digest()


def encrypt(text: str) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = os.urandom(12)
    return base64.b64encode(nonce + AESGCM(_key()).encrypt(nonce, text.encode(), b"melovyn-google")).decode()


def decrypt(blob: str) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    raw = base64.b64decode(blob)
    return AESGCM(_key()).decrypt(raw[:12], raw[12:], b"melovyn-google").decode()


def _client() -> tuple[str, str]:
    ids = A.google_client_ids()
    secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    if not ids or not secret:
        raise HTTPException(503, "Google connections aren't set up on this server yet.")
    return ids[0], secret


def link_of(uid: str) -> dict | None:
    with engine().connect() as c:
        row = c.execute(select(links).where(links.c.user_id == uid)).mappings().first()
    return dict(row) if row else None


def has(uid: str, feature: str) -> bool:
    row = link_of(uid)
    return bool(row and feature in (row["scopes"] or []))


def access_token(uid: str, feature: str) -> str:
    """A fresh access token for a feature the person has granted (refreshed from the stored refresh token)."""
    row = link_of(uid)
    if not row or feature not in (row["scopes"] or []):
        raise HTTPException(409, {"code": "google_scope_needed", "feature": feature, "scope": SCOPES[feature],
                                  "message": "Connect Google for this first."})
    with _lock:
        tok = _access.get(uid)
        if tok and tok[1] > time.time() + 60:
            return tok[0]
    cid, secret = _client()
    r = _http("POST", TOKEN_URL, form={"client_id": cid, "client_secret": secret, "grant_type": "refresh_token", "refresh_token": decrypt(row["refresh_enc"])})
    if not r.get("access_token"):
        raise HTTPException(409, {"code": "google_scope_needed", "feature": feature, "scope": SCOPES[feature], "message": "Please connect Google again."})
    with _lock:
        _access[uid] = (r["access_token"], time.time() + float(r.get("expires_in", 3000)))
    return r["access_token"]


# ------------------------------------------------------------------------------------------------ connect / list / revoke
class ConnectIn(BaseModel):
    code: str = Field(..., min_length=10, max_length=2048)
    feature: str = Field(..., pattern="^(calendar|drive|contacts)$")


@router.post("/connect")
def connect(body: ConnectIn, me: A.Me = Depends(A.current)):
    A.require_registered(me)
    cid, secret = _client()
    r = _http("POST", TOKEN_URL, form={"code": body.code, "client_id": cid, "client_secret": secret, "redirect_uri": "postmessage", "grant_type": "authorization_code"})
    granted = set((r.get("scope") or "").split())
    if SCOPES[body.feature] not in granted:
        raise HTTPException(400, {"code": "scope_not_granted", "message": "Google did not give that permission. Please tick the box and try again."})
    features = sorted(f for f, sc in SCOPES.items() if sc in granted)
    row = link_of(me.id)
    refresh = r.get("refresh_token") or (decrypt(row["refresh_enc"]) if row else "")
    if not refresh:
        raise HTTPException(400, "Google did not send a lasting permission. Please remove Melovyn in your Google account and connect again.")
    vals = dict(scopes=sorted(set(features) | set((row or {}).get("scopes") or [])), refresh_enc=encrypt(refresh), email=me.acc.get("email") or "", updated=_now())
    with engine().begin() as c:
        if row:
            c.execute(update(links).where(links.c.user_id == me.id).values(**vals))
        else:
            c.execute(insert(links).values(user_id=me.id, created=_now(), **vals))
    if r.get("access_token"):
        with _lock:
            _access[me.id] = (r["access_token"], time.time() + float(r.get("expires_in", 3000)))
    return connections(me)


@router.get("/connections")
def connections(me: A.Me = Depends(A.current)):
    row = link_of(me.id)
    granted = (row or {}).get("scopes") or []
    return {"available": bool(A.google_client_ids() and os.environ.get("GOOGLE_CLIENT_SECRET")),
            "client_id": (A.google_client_ids() or [""])[0], "email": (row or {}).get("email") or me.acc.get("email") or "",
            "features": [{"id": f, "scope": SCOPES[f], "linked": f in granted} for f in SCOPES]}


@router.delete("/connections/{feature}")
def revoke(feature: str, me: A.Me = Depends(A.current)):
    """Removes one permission ('calendar', 'drive', 'contacts') or all of them ('all'). With nothing left, the
    stored token is revoked at Google and deleted here."""
    if feature != "all" and feature not in SCOPES:
        raise HTTPException(404, "No such connection.")
    row = link_of(me.id)
    if not row:
        return connections(me)
    left = [] if feature == "all" else [f for f in (row["scopes"] or []) if f != feature]
    with engine().begin() as c:
        if left:
            c.execute(update(links).where(links.c.user_id == me.id).values(scopes=left, updated=_now()))
        else:
            try:
                _http("POST", REVOKE_URL, form={"token": decrypt(row["refresh_enc"])})
            except HTTPException:
                pass                                              # deleted here either way
            c.execute(delete(links).where(links.c.user_id == me.id))
    with _lock:
        _access.pop(me.id, None)
    return connections(me)


# ------------------------------------------------------------------------------------------------ calendar
def calendar_event(uid: str, *, title: str, start: float, minutes: int, description: str = "", attendees: list[str] = (),
                   meet: bool = True, request_id: str = "") -> dict:
    """Creates an event in the person's primary calendar (with a Meet link and reminders)."""
    tok = access_token(uid, "calendar")
    iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))  # noqa: E731
    ev = {"summary": title[:200], "description": description[:4000], "start": {"dateTime": iso(start)}, "end": {"dateTime": iso(start + minutes * 60)},
          "attendees": [{"email": e} for e in attendees if "@" in e][:100],
          "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 30}, {"method": "email", "minutes": 24 * 60}]}}
    if meet:
        ev["conferenceData"] = {"createRequest": {"requestId": request_id or os.urandom(8).hex(), "conferenceSolutionKey": {"type": "hangoutsMeet"}}}
    r = _http("POST", f"{CAL}?conferenceDataVersion=1&sendUpdates=all", token=tok, data=json.dumps(ev).encode(), headers={"Content-Type": "application/json"})
    return {"event_id": r.get("id", ""), "meet_url": r.get("hangoutLink") or "", "html_link": r.get("htmlLink") or ""}


def calendar_get(uid: str, event_id: str) -> dict | None:
    """The event as it is now in Google Calendar (the teacher may have moved or cancelled it there)."""
    tok = access_token(uid, "calendar")
    r = _http("GET", f"{CAL}/{urllib.parse.quote(event_id)}", token=tok)
    if not r:
        return None
    start = r.get("start", {}).get("dateTime")
    end = r.get("end", {}).get("dateTime")
    st = _rfc3339(start) if start else None
    return {"title": r.get("summary") or "", "start": st, "minutes": round((_rfc3339(end) - st) / 60) if st and end else None,
            "cancelled": r.get("status") == "cancelled", "meet_url": r.get("hangoutLink") or ""}


def calendar_update(uid: str, event_id: str, *, title: str | None = None, start: float | None = None, minutes: int | None = None, cancel: bool = False) -> None:
    tok = access_token(uid, "calendar")
    url = f"{CAL}/{urllib.parse.quote(event_id)}?sendUpdates=all"
    if cancel:
        _http("DELETE", url, token=tok)
        return
    iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))  # noqa: E731
    patch: dict = {}
    if title is not None:
        patch["summary"] = title[:200]
    if start is not None:
        patch["start"] = {"dateTime": iso(start)}
        patch["end"] = {"dateTime": iso(start + (minutes or 45) * 60)}
    _http("PATCH", url, token=tok, data=json.dumps(patch).encode(), headers={"Content-Type": "application/json"})


def _rfc3339(s: str) -> float:
    """'2026-11-20T10:00:00+08:00' or '...Z' -> epoch seconds."""
    from datetime import datetime
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


# ------------------------------------------------------------------------------------------------ drive
class DriveIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    mime: str = Field(..., pattern=r"^(application/(pdf|zip|json|vnd\.recordare\.musicxml\+xml|octet-stream)|audio/(wav|mpeg|mp4|webm|midi)|text/(plain|csv)|image/png)$")
    data_b64: str = Field(..., max_length=MAX_DRIVE * 2)


@router.post("/drive/upload")
def drive_upload(body: DriveIn, me: A.Me = Depends(A.current)):
    try:
        data = base64.b64decode(body.data_b64, validate=True)
    except ValueError:
        raise HTTPException(400, "The file could not be read.")
    if len(data) > MAX_DRIVE:
        raise HTTPException(413, "That file is too big for Drive from here (25 MB max).")
    tok = access_token(me.id, "drive")
    boundary = "melovyn" + os.urandom(8).hex()
    meta_json = json.dumps({"name": body.name}).encode()
    payload = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".encode() + meta_json
               + f"\r\n--{boundary}\r\nContent-Type: {body.mime}\r\n\r\n".encode() + data + f"\r\n--{boundary}--".encode())
    r = _http("POST", DRIVE_UPLOAD, token=tok, data=payload, headers={"Content-Type": f"multipart/related; boundary={boundary}"}, timeout=60)
    return {"id": r.get("id"), "name": r.get("name"), "link": r.get("webViewLink")}


# ------------------------------------------------------------------------------------------------ contacts
@router.get("/contacts")
def contacts(q: str = "", me: A.Me = Depends(A.current)):
    tok = access_token(me.id, "contacts")
    r = _http("GET", PEOPLE, token=tok)
    out = []
    ql = q.lower().strip()
    for p in r.get("connections", []):
        name = ((p.get("names") or [{}])[0].get("displayName") or "").strip()
        for e in p.get("emailAddresses") or []:
            v = (e.get("value") or "").strip()
            if v and (not ql or ql in v.lower() or ql in name.lower()):
                out.append({"name": name, "email": v})
    return {"contacts": out[:100]}
