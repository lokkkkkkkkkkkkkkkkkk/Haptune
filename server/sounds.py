"""Sounds on Stage: short multitrack pieces people make in the app's mixer and post (screens/sound.jsx).

A Sound is posted as one mixdown (audio) plus its project (tempo, key, tracks and their settings; no raw track
audio) and, when it has notation, the sheet (MusicXML) so listeners can practise it ("Get the sheet").
"Layer with me": anyone can download a public Sound's mixdown, record a new track on top and post it as a new
version (parent_id); versions form a tree and keep the credits.

Safety and limits
  * the person confirms the rights (their own work, public domain, or licensed); every Sound can be reported,
    a copyright report from the owner takes it down at once, three reports hide it until the developer looks;
  * uploads are checked by their first bytes (WAV, MP3, AAC/MP4, Ogg, WebM, FLAC), never served as anything else
    (fixed content type, nosniff, as an attachment when downloaded), and transcoded with ffmpeg to AAC when the
    server has it (`ffmpeg` on PATH), which also re-checks that it really is audio;
  * duration, size and the number of Sounds kept depend on the plan (LIMITS).
"""
from __future__ import annotations

import json
import shutil
import struct
import subprocess
import tempfile
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import JSON, Boolean, Column, Float, Integer, LargeBinary, String, Table, Text, delete, func, insert, select, update

import accounts as A
from academy import _iso, _now, engine, meta

router = APIRouter(prefix="/c", tags=["sounds"])

LIMITS = {"free": {"seconds": 90, "bytes": 8 << 20, "keep": 30},
          "plus": {"seconds": 240, "bytes": 20 << 20, "keep": 200},
          "pro": {"seconds": 600, "bytes": 50 << 20, "keep": 1000},
          "dev": {"seconds": 900, "bytes": 80 << 20, "keep": 100000}}
RIGHTS = {"own", "pd", "licensed"}
WAV_BYTES_PER_SECOND = 48000 * 2 * 2      # stereo 16-bit at up to 48 kHz
MAX_PROJECT = 200_000
MAX_XML = 3 << 20

sounds = Table("sounds", meta,
               Column("id", String(16), primary_key=True),
               Column("user_id", String(36), nullable=False, index=True),
               Column("title", String(120), nullable=False),
               Column("body", String(1000), nullable=False, default=""),
               Column("seconds", Float, nullable=False),
               Column("audio", LargeBinary, nullable=False),
               Column("audio_type", String(40), nullable=False),
               Column("project", JSON, nullable=True),
               Column("sheet_xml", Text, nullable=True),
               Column("parent_id", String(16), nullable=True, index=True),
               Column("rights", String(10), nullable=False),
               Column("likes", Integer, nullable=False, default=0),
               Column("reports", Integer, nullable=False, default=0),
               Column("hidden", Boolean, nullable=False, default=False),
               Column("created", Float, nullable=False))
sound_likes = Table("sound_likes", meta, Column("sound_id", String(16), primary_key=True), Column("user_id", String(36), primary_key=True))
sound_reports = Table("sound_reports", meta,
                      Column("id", Integer, primary_key=True, autoincrement=True),
                      Column("sound_id", String(16), nullable=False, index=True),
                      Column("user_id", String(36), nullable=False),
                      Column("reason", String(12), nullable=False),
                      Column("note", String(500), nullable=False, default=""),
                      Column("created", Float, nullable=False))


def sniff(data: bytes) -> str | None:
    """The audio type from the file's first bytes, or None if it is not audio we accept."""
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data[:4] == b"OggS":
        return "audio/ogg"
    if data[:4] == b"fLaC":
        return "audio/flac"
    if data[:4] == b"\x1aE\xdf\xa3":
        return "audio/webm"
    if data[4:8] == b"ftyp":
        return "audio/mp4"
    if data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        return "audio/mpeg"
    return None


def wav_seconds(data: bytes) -> float | None:
    """Duration of a PCM WAV from its header (finds the fmt and data chunks)."""
    try:
        i, rate, block = 12, None, None
        while i + 8 <= len(data):
            cid, size = data[i:i + 4], struct.unpack("<I", data[i + 4:i + 8])[0]
            if cid == b"fmt ":
                ch, rate = struct.unpack("<HI", data[i + 10:i + 16])
                block = struct.unpack("<H", data[i + 20:i + 22])[0]
            elif cid == b"data" and rate and block:
                return size / block / rate
            i += 8 + size + (size & 1)
    except struct.error:
        return None
    return None


def transcode(data: bytes, kind: str) -> tuple[bytes, str, float | None]:
    """With ffmpeg on the server: re-encode to AAC (smaller, and proves the file is real audio). Tests replace this."""
    ff = shutil.which("ffmpeg")
    if not ff:
        return data, kind, wav_seconds(data) if kind == "audio/wav" else None
    with tempfile.TemporaryDirectory() as d:
        src, dst = f"{d}/in", f"{d}/out.m4a"
        open(src, "wb").write(data)
        r = subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-i", src, "-vn", "-ac", "2", "-c:a", "aac", "-b:a", "128k", dst], capture_output=True, timeout=120)
        if r.returncode != 0:
            raise HTTPException(415, "That file could not be read as audio.")
        out = open(dst, "rb").read()
        probe = subprocess.run([shutil.which("ffprobe") or "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", dst], capture_output=True, text=True, timeout=30)
        try:
            secs = float(probe.stdout.strip())
        except ValueError:
            secs = None
        return out, "audio/mp4", secs


def _limits(me: A.Me) -> dict:
    return LIMITS.get(me.tier, LIMITS["free"])


def _card(s: dict, people: dict, me_id: str | None, liked: set) -> dict:
    p = s.get("project") or {}
    return {"id": s["id"], "title": s["title"], "body": s["body"], "seconds": round(s["seconds"], 1), "likes": s["likes"], "liked": s["id"] in liked,
            "author": people.get(s["user_id"]), "mine": s["user_id"] == me_id, "parent_id": s["parent_id"], "has_sheet": bool(s.get("has_sheet")),
            "tempo": p.get("tempo"), "key": p.get("key"), "tracks": len(p.get("tracks", [])), "credits": p.get("credits", []), "created": _iso(s["created"])}


def _people(c, ids) -> dict:
    import community
    return community._people(c, ids)


def _limit_user(me: A.Me, key: str, n: int, window: float, msg: str) -> None:
    import community
    community._limit_user(me, key, n, window, msg)


@router.post("/sounds")
async def post_sound(title: str = Form(..., min_length=1, max_length=120), body: str = Form("", max_length=1000), rights: str = Form(...),
                     project: str = Form("{}"), parent_id: str = Form(""), sheet_xml: str = Form(""), audio: UploadFile = File(...),
                     me: A.Me = Depends(A.current)):
    A.require_registered(me)
    _limit_user(me, "sound_post", 12, 3600, "That's a lot of Sounds in an hour. Please wait a little before posting more.")
    if rights not in RIGHTS:
        raise HTTPException(400, {"code": "rights", "message": "Say whose music this is: your own, public domain, or licensed to you."})
    lim = _limits(me)
    # The app uploads its mixdown as WAV (a minute is ~10 MB), and the server stores it as AAC (~1 MB). So a WAV may
    # be as big as the plan's longest Sound in CD-quality stereo; the size limit applies to what is kept.
    wav_cap = WAV_BYTES_PER_SECOND * lim["seconds"] + (1 << 16)
    data = await audio.read(max(lim["bytes"], wav_cap) + 1)
    kind = sniff(data)
    if not kind:
        raise HTTPException(415, "That file is not audio Melovyn can play (WAV, MP3, AAC, Ogg, WebM or FLAC).")
    if len(data) > (wav_cap if kind == "audio/wav" else lim["bytes"]):
        raise HTTPException(413, {"code": "too_big", "message": f"Sounds can be up to {lim['bytes'] >> 20} MB on your plan."})
    if len(project) > MAX_PROJECT or len(sheet_xml) > MAX_XML:
        raise HTTPException(413, "That project is too big.")
    try:
        proj = json.loads(project or "{}")
        if not isinstance(proj, dict):
            raise ValueError
    except ValueError:
        raise HTTPException(400, "The project could not be read.")
    if sheet_xml and "<score-partwise" not in sheet_xml[:4000]:
        raise HTTPException(400, "The sheet must be MusicXML.")
    if kind == "audio/wav" and (wav_seconds(data) or 0) > lim["seconds"] + 1:
        raise HTTPException(413, {"code": "too_long", "message": f"Sounds can be up to {lim['seconds']} seconds on your plan."})
    out, out_type, secs = transcode(data, kind)
    secs = secs or float(proj.get("seconds") or 0)
    if not secs or secs > lim["seconds"] + 1:
        raise HTTPException(413, {"code": "too_long", "message": f"Sounds can be up to {lim['seconds']} seconds on your plan."})
    if len(out) > lim["bytes"]:
        raise HTTPException(413, {"code": "too_big", "message": f"Sounds can be up to {lim['bytes'] >> 20} MB on your plan."})
    sid = uuid.uuid4().hex[:12]
    with engine().begin() as c:
        if c.execute(select(func.count()).select_from(sounds).where(sounds.c.user_id == me.id)).scalar() >= lim["keep"]:
            raise HTTPException(409, {"code": "quota", "message": "You have kept as many Sounds as your plan allows. Delete an old one first."})
        if parent_id and not c.execute(select(sounds.c.id).where(sounds.c.id == parent_id, sounds.c.hidden.is_(False))).first():
            raise HTTPException(404, "The Sound you layered on is gone.")
        c.execute(insert(sounds).values(id=sid, user_id=me.id, title=title.strip(), body=body.strip(), seconds=secs, audio=out, audio_type=out_type,
                                        project=proj, sheet_xml=sheet_xml or None, parent_id=parent_id or None, rights=rights, likes=0, reports=0,
                                        hidden=False, created=_now()))
        if parent_id:
            owner = c.execute(select(sounds.c.user_id).where(sounds.c.id == parent_id)).scalar()
            if owner and owner != me.id:
                A.notify(c, owner, "sound_layered", actor=me.id, sound=sid, parent=parent_id)
    return {"id": sid, "seconds": round(secs, 1), "audio_type": out_type}


@router.get("/sounds")
def list_sounds(limit: int = 20, offset: int = 0, me: A.Me | None = Depends(A.optional)):
    with engine().connect() as c:
        rows = [dict(r) for r in c.execute(select(sounds.c.id, sounds.c.user_id, sounds.c.title, sounds.c.body, sounds.c.seconds, sounds.c.likes,
                                                  sounds.c.parent_id, sounds.c.project, sounds.c.created, (sounds.c.sheet_xml.isnot(None)).label("has_sheet"))
                                           .where(sounds.c.hidden.is_(False)).order_by(sounds.c.created.desc())
                                           .limit(max(1, min(50, limit))).offset(max(0, offset))).mappings().all()]
        people = _people(c, [r["user_id"] for r in rows])
        liked = set(c.execute(select(sound_likes.c.sound_id).where(sound_likes.c.user_id == (me.id if me else "-"))).scalars().all())
    return {"items": [_card(r, people, me.id if me else None, liked) for r in rows]}


@router.get("/sounds/{sid}")
def get_sound(sid: str, me: A.Me | None = Depends(A.optional)):
    with engine().connect() as c:
        s = c.execute(select(sounds).where(sounds.c.id == sid)).mappings().first()
        if s is None or (s["hidden"] and not (me and (me.is_admin or me.id == s["user_id"]))):
            raise HTTPException(404, "This Sound is not here (any more).")
        s = dict(s)
        s["has_sheet"] = bool(s["sheet_xml"])
        # the versions: the chain up to the first Sound, and the layers made on this one
        chain, cur = [], s["parent_id"]
        while cur and len(chain) < 20:
            p = c.execute(select(sounds.c.id, sounds.c.title, sounds.c.user_id, sounds.c.parent_id, sounds.c.hidden).where(sounds.c.id == cur)).mappings().first()
            if not p:
                break
            if not p["hidden"]:
                chain.insert(0, dict(p))
            cur = p["parent_id"]
        kids = [dict(k) for k in c.execute(select(sounds.c.id, sounds.c.title, sounds.c.user_id).where(sounds.c.parent_id == sid, sounds.c.hidden.is_(False))
                                           .order_by(sounds.c.created)).mappings().all()]
        people = _people(c, [s["user_id"]] + [x["user_id"] for x in chain + kids])
        liked = set(c.execute(select(sound_likes.c.sound_id).where(sound_likes.c.user_id == (me.id if me else "-"))).scalars().all())
    out = _card(s, people, me.id if me else None, liked)
    out["project"] = s["project"]
    out["versions"] = {"before": [{"id": x["id"], "title": x["title"], "author": people.get(x["user_id"])} for x in chain],
                       "layers": [{"id": x["id"], "title": x["title"], "author": people.get(x["user_id"])} for x in kids]}
    return out


@router.get("/sounds/{sid}/audio")
def sound_audio(sid: str, download: bool = False):
    with engine().connect() as c:
        s = c.execute(select(sounds.c.audio, sounds.c.audio_type, sounds.c.title, sounds.c.hidden).where(sounds.c.id == sid)).mappings().first()
    if s is None or s["hidden"]:
        raise HTTPException(404, "This Sound is not here (any more).")
    ext = {"audio/mp4": "m4a", "audio/wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/webm": "webm", "audio/flac": "flac"}.get(s["audio_type"], "audio")
    headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=86400"}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="sound.{ext}"'
    return Response(content=s["audio"], media_type=s["audio_type"], headers=headers)


@router.get("/sounds/{sid}/sheet")
def sound_sheet(sid: str):
    with engine().connect() as c:
        s = c.execute(select(sounds.c.sheet_xml, sounds.c.hidden).where(sounds.c.id == sid)).mappings().first()
    if s is None or s["hidden"] or not s["sheet_xml"]:
        raise HTTPException(404, "This Sound has no sheet.")
    return Response(content=s["sheet_xml"], media_type="application/vnd.recordare.musicxml+xml", headers={"X-Content-Type-Options": "nosniff"})


@router.post("/sounds/{sid}/like")
def like(sid: str, me: A.Me = Depends(A.current)):
    _limit_user(me, "sound_like", 120, 3600, "Slow down a little.")
    with engine().begin() as c:
        if not c.execute(select(sounds.c.id).where(sounds.c.id == sid)).first():
            raise HTTPException(404, "No such Sound.")
        if c.execute(select(sound_likes).where(sound_likes.c.sound_id == sid, sound_likes.c.user_id == me.id)).first():
            c.execute(delete(sound_likes).where(sound_likes.c.sound_id == sid, sound_likes.c.user_id == me.id))
            c.execute(update(sounds).where(sounds.c.id == sid).values(likes=sounds.c.likes - 1))
            on = False
        else:
            c.execute(insert(sound_likes).values(sound_id=sid, user_id=me.id))
            c.execute(update(sounds).where(sounds.c.id == sid).values(likes=sounds.c.likes + 1))
            on = True
        n = c.execute(select(sounds.c.likes).where(sounds.c.id == sid)).scalar()
    return {"liked": on, "likes": n}


class ReportIn(BaseModel):
    reason: str = Field(..., pattern="^(copyright|abuse|other)$")
    note: str = Field("", max_length=500)
    owner: bool = False                 # "I own the rights to this music" (a takedown request)


@router.post("/sounds/{sid}/report")
def report(sid: str, body: ReportIn, me: A.Me = Depends(A.current)):
    A.require_registered(me)
    _limit_user(me, "sound_report", 20, 3600, "You've sent many reports in an hour. Thank you; please wait a little.")
    with engine().begin() as c:
        if not c.execute(select(sounds.c.id).where(sounds.c.id == sid)).first():
            raise HTTPException(404, "No such Sound.")
        if c.execute(select(sound_reports.c.id).where(sound_reports.c.sound_id == sid, sound_reports.c.user_id == me.id)).first():
            return {"ok": True}
        c.execute(insert(sound_reports).values(sound_id=sid, user_id=me.id, reason=body.reason, note=body.note.strip(), created=_now()))
        n = c.execute(select(func.count()).select_from(sound_reports).where(sound_reports.c.sound_id == sid)).scalar()
        takedown = body.reason == "copyright" and body.owner
        c.execute(update(sounds).where(sounds.c.id == sid).values(reports=n, hidden=sounds.c.hidden | (n >= 3) | takedown))
    return {"ok": True, "hidden": takedown or n >= 3}


@router.delete("/sounds/{sid}")
def delete_sound(sid: str, me: A.Me = Depends(A.current)):
    with engine().begin() as c:
        s = c.execute(select(sounds.c.user_id).where(sounds.c.id == sid)).first()
        if s is None:
            raise HTTPException(404, "No such Sound.")
        if s[0] != me.id and not me.is_admin:
            raise HTTPException(403, "Only the person who posted it can delete it.")
        c.execute(update(sounds).where(sounds.c.parent_id == sid).values(parent_id=None))
        c.execute(delete(sound_likes).where(sound_likes.c.sound_id == sid))
        c.execute(delete(sound_reports).where(sound_reports.c.sound_id == sid))
        c.execute(delete(sounds).where(sounds.c.id == sid))
    return {"ok": True}


class AdminIn(BaseModel):
    action: str = Field(..., pattern="^(hide|restore|delete)$")


@router.get("/admin/sounds")
def admin_sounds(me: A.Me = Depends(A.require_admin)):
    with engine().connect() as c:
        rows = c.execute(select(sounds.c.id, sounds.c.title, sounds.c.user_id, sounds.c.reports, sounds.c.hidden, sounds.c.rights)
                         .where(sounds.c.reports > 0).order_by(sounds.c.reports.desc())).mappings().all()
        reps = {}
        for r in c.execute(select(sound_reports).where(sound_reports.c.sound_id.in_([x["id"] for x in rows] or ["-"]))).mappings().all():
            reps.setdefault(r["sound_id"], []).append({"reason": r["reason"], "note": r["note"]})
    return {"items": [{**dict(r), "reports_list": reps.get(r["id"], [])} for r in rows]}


@router.post("/admin/sounds/{sid}")
def admin_sound(sid: str, body: AdminIn, me: A.Me = Depends(A.require_admin)):
    if body.action == "delete":
        return delete_sound(sid, me)
    with engine().begin() as c:
        c.execute(update(sounds).where(sounds.c.id == sid).values(hidden=body.action == "hide", **({"reports": 0} if body.action == "restore" else {})))
    return {"ok": True}
