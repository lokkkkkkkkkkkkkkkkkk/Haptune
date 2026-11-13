"""Academy classes: teachers and students learning together, any time, inside a time window.

Teachers make a class and get a short join code. They set assignments ("missions"): a piece (MusicXML),
which bars, at what speed, the score to aim for, and when it opens and is due. Students practise
whenever they like before the due date; each Play Along result (and an optional short recording) is
submitted to the teacher, who answers with comments, stickers and bars to focus on. The class has a
feed and a weekly leaderboard.

A device asks for an identity once (POST /academy/me) and keeps the token it gets back. A one-time link
code moves that identity to another device; with a handle and password (community.py) the same account
can also sign in on several devices at once.

Storage: SQLAlchemy Core on DATABASE_URL (SQLite file by default, Postgres in production).
"""
from __future__ import annotations

import base64
import hashlib
import os
import secrets
import tempfile
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import (JSON, Boolean, Column, Float, ForeignKey, Integer, LargeBinary, MetaData, String, Table, Text,
                        create_engine, delete, func, insert, select, update)

router = APIRouter(prefix="/academy", tags=["academy"])
meta = MetaData()

users = Table("users", meta,
              Column("id", String(36), primary_key=True),
              Column("token_hash", String(64), unique=True, nullable=False),
              Column("name", String(60), nullable=False),
              Column("color", String(12), nullable=False, default="blue"),
              Column("link_code", String(12), nullable=True),
              Column("link_expires", Float, nullable=True),
              Column("created", Float, nullable=False))
classes = Table("classes", meta,
                Column("id", String(36), primary_key=True),
                Column("name", String(80), nullable=False),
                Column("description", Text, nullable=False, default=""),
                Column("teacher_id", String(36), ForeignKey("users.id"), nullable=False),
                Column("join_code", String(10), unique=True, nullable=False),
                Column("color", String(12), nullable=False, default="orange"),
                Column("archived", Boolean, nullable=False, default=False),
                Column("visibility", String(10), nullable=False, default="private"),   # private (code / link) | public (listed)
                Column("instrument", String(24), nullable=False, default=""),
                Column("level", String(16), nullable=False, default=""),
                Column("created", Float, nullable=False))
members = Table("members", meta,
                Column("class_id", String(36), ForeignKey("classes.id"), primary_key=True),
                Column("user_id", String(36), ForeignKey("users.id"), primary_key=True),
                Column("role", String(10), nullable=False),
                Column("joined", Float, nullable=False))
assignments = Table("assignments", meta,
                    Column("id", String(36), primary_key=True),
                    Column("class_id", String(36), ForeignKey("classes.id"), nullable=False),
                    Column("title", String(120), nullable=False),
                    Column("instructions", Text, nullable=False, default=""),
                    Column("piece_title", String(160), nullable=False, default=""),
                    Column("musicxml", Text, nullable=True),
                    Column("bars_from", Integer, nullable=True),
                    Column("bars_to", Integer, nullable=True),
                    Column("part", String(40), nullable=False, default=""),
                    Column("mode", String(10), nullable=False, default="wait"),
                    Column("tempo_pct", Integer, nullable=False, default=100),
                    Column("goal", Integer, nullable=False, default=80),
                    Column("points", Integer, nullable=False, default=50),
                    Column("attempts", Integer, nullable=True),
                    Column("listen_url", String(400), nullable=True),
                    Column("opens_at", Float, nullable=False),
                    Column("due_at", Float, nullable=False),
                    Column("created", Float, nullable=False))
submissions = Table("submissions", meta,
                    Column("id", String(36), primary_key=True),
                    Column("assignment_id", String(36), ForeignKey("assignments.id"), nullable=False),
                    Column("user_id", String(36), ForeignKey("users.id"), nullable=False),
                    Column("accuracy", Float, nullable=False),
                    Column("timing", Float, nullable=True),
                    Column("tempo_pct", Integer, nullable=True),
                    Column("seconds", Integer, nullable=False, default=0),
                    Column("bars", JSON, nullable=True),
                    Column("note", Text, nullable=False, default=""),
                    Column("recording", LargeBinary, nullable=True),
                    Column("recording_type", String(40), nullable=True),
                    Column("late", Boolean, nullable=False, default=False),
                    Column("points", Integer, nullable=False, default=0),
                    Column("created", Float, nullable=False))
# Signed-in devices of one account (phone, tablet, PC). A device made with POST /academy/me keeps using
# users.token_hash; signing in with a handle and password (community.py) adds a row here.
sessions = Table("sessions", meta,
                 Column("token_hash", String(64), primary_key=True),
                 Column("user_id", String(36), ForeignKey("users.id"), nullable=False),
                 Column("label", String(60), nullable=False, default=""),
                 Column("created", Float, nullable=False),
                 Column("last_seen", Float, nullable=False))
feedback = Table("feedback", meta,
                 Column("id", String(36), primary_key=True),
                 Column("submission_id", String(36), ForeignKey("submissions.id"), nullable=False),
                 Column("teacher_id", String(36), ForeignKey("users.id"), nullable=False),
                 Column("text", Text, nullable=False, default=""),
                 Column("stickers", JSON, nullable=True),
                 Column("focus_bars", JSON, nullable=True),
                 Column("created", Float, nullable=False))

# Practice takes a student shares with a class outside any assignment ("hear me play this"), so the teacher sees
# all their practice and can listen any time; with comments from the teacher.
takes = Table("takes", meta,
              Column("id", String(36), primary_key=True),
              Column("class_id", String(36), ForeignKey("classes.id"), nullable=False, index=True),
              Column("user_id", String(36), ForeignKey("users.id"), nullable=False, index=True),
              Column("piece_title", String(160), nullable=False, default=""),
              Column("accuracy", Float, nullable=False),
              Column("timing", Float, nullable=True),
              Column("tempo_pct", Integer, nullable=True),
              Column("seconds", Integer, nullable=False, default=0),
              Column("bars", JSON, nullable=True),                 # [[bar, accuracy], ...]
              Column("wrong", JSON, nullable=True),                # [{bar, want, played}], the first wrong notes
              Column("mode", String(10), nullable=False, default=""),
              Column("note", Text, nullable=False, default=""),
              Column("recording", LargeBinary, nullable=True),
              Column("recording_type", String(40), nullable=True),
              Column("created", Float, nullable=False))
take_comments = Table("take_comments", meta,
                      Column("id", String(36), primary_key=True),
                      Column("take_id", String(36), ForeignKey("takes.id"), nullable=False, index=True),
                      Column("teacher_id", String(36), ForeignKey("users.id"), nullable=False),
                      Column("text", Text, nullable=False, default=""),
                      Column("stickers", JSON, nullable=True),
                      Column("focus_bars", JSON, nullable=True),
                      Column("created", Float, nullable=False))

COLORS = ["blue", "pink", "green", "orange", "purple", "teal", "indigo", "red"]
STICKERS = {"star", "fire", "clap", "heart", "rocket", "trophy", "music", "thumbs"}
CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"            # no 0/O, 1/I/L
MAX_XML = 3 * 1024 * 1024
MAX_REC = 8 * 1024 * 1024                  # about 15 minutes of compressed audio
DAY = 86400.0

_engine = None


_engine_lock = threading.Lock()


def engine():
    """The database. Made once: the lock stops two first requests from both creating the tables."""
    global _engine
    if _engine is not None:
        return _engine
    with _engine_lock:
        return _make_engine()


def _make_engine():
    global _engine
    if _engine is None:
        url = os.environ.get("DATABASE_URL") or "sqlite:///" + os.path.join(
            os.environ.get("HAPTUNE_DATA", tempfile.gettempdir()), "haptune-academy.db")
        if url.startswith("postgres://"):
            url = "postgresql+psycopg://" + url[len("postgres://"):]
        args = {"connect_args": {"check_same_thread": False}} if url.startswith("sqlite") else {"pool_pre_ping": True}
        eng = create_engine(url, future=True, **args)
        meta.create_all(eng)
        _add_missing_columns(eng)
        _engine = eng                                  # only visible to others once it is ready
    return _engine


def _add_missing_columns(eng) -> None:
    """New versions add columns to tables that already hold people's data. create_all only makes missing
    tables, so columns the database doesn't have yet are added here (existing rows get the column's default)."""
    from sqlalchemy import inspect, text
    insp = inspect(eng)
    with eng.begin() as c:
        for table in meta.sorted_tables:
            have = {col["name"] for col in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in have:
                    continue
                ddl = f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {col.type.compile(eng.dialect)}'
                default = getattr(col.default, "arg", None) if col.default is not None else None
                if isinstance(default, bool):
                    ddl += f" DEFAULT {'TRUE' if default else 'FALSE'}" if eng.dialect.name != "sqlite" else f" DEFAULT {int(default)}"
                elif isinstance(default, (int, float)):
                    ddl += f" DEFAULT {default}"
                elif isinstance(default, str):
                    ddl += " DEFAULT '" + default.replace("'", "''") + "'"
                elif not col.nullable:
                    ddl += " DEFAULT ''" if "CHAR" in ddl.upper() or "TEXT" in ddl.upper() else " DEFAULT 0"
                if not col.nullable and "DEFAULT" in ddl:
                    ddl += " NOT NULL"
                c.execute(text(ddl))


def reset_engine(url: str | None = None) -> None:
    """Tests: point the Academy at a fresh database."""
    global _engine
    if url:
        os.environ["DATABASE_URL"] = url
    _engine = None


def _now() -> float:
    return time.time()


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _code(n: int = 6) -> str:
    return "".join(secrets.choice(CODE_CHARS) for _ in range(n))


def _iso(t: float | None) -> str | None:
    return datetime.fromtimestamp(t, tz=timezone.utc).isoformat().replace("+00:00", "Z") if t else None


def _parse_time(s: str | None, default: float) -> float:
    if not s:
        return default
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        raise HTTPException(400, f"Not a date: {s}")


# ---------------------------------------------------------------------------- identity
def current_user(authorization: str = Header("")) -> dict:
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "Open the Academy once to get your profile.")
    h = _hash(token)
    with engine().connect() as c:
        row = c.execute(select(users).where(users.c.token_hash == h)).mappings().first()
        if row is None:
            uid = c.execute(select(sessions.c.user_id).where(sessions.c.token_hash == h)).scalar()
            if uid:
                row = c.execute(select(users).where(users.c.id == uid)).mappings().first()
    if row is None:
        raise HTTPException(401, "This device's Academy profile was not found.")
    return dict(row)


def _user_json(u: dict) -> dict:
    return {"id": u["id"], "name": u["name"], "color": u["color"]}


class NewUser(BaseModel):
    name: str = Field("", max_length=60)


@router.post("/me")
def create_me(body: NewUser, request: Request):
    from app import _limit                                     # same per-device/IP limiter as the AI endpoints
    _limit(request, "academy-user", 20)
    token = secrets.token_urlsafe(32)
    uid = str(uuid.uuid4())
    name = body.name.strip() or "Musician"
    color = COLORS[int(hashlib.md5(uid.encode()).hexdigest(), 16) % len(COLORS)]
    with engine().begin() as c:
        c.execute(insert(users).values(id=uid, token_hash=_hash(token), name=name, color=color, created=_now()))
    return {"user": {"id": uid, "name": name, "color": color}, "token": token}


class Rename(BaseModel):
    name: str = Field(..., min_length=1, max_length=60)


@router.patch("/me")
def rename(body: Rename, me: dict = Depends(current_user)):
    with engine().begin() as c:
        c.execute(update(users).where(users.c.id == me["id"]).values(name=body.name.strip()))
    return {"user": {**_user_json(me), "name": body.name.strip()}}


@router.post("/me/link-code")
def link_code(me: dict = Depends(current_user)):
    code = _code(8)
    with engine().begin() as c:
        c.execute(update(users).where(users.c.id == me["id"]).values(link_code=code, link_expires=_now() + 15 * 60))
    return {"code": code, "expires_in": 900}


class Claim(BaseModel):
    code: str = Field(..., min_length=6, max_length=12)


@router.post("/me/claim")
def claim(body: Claim, request: Request):
    from app import _limit
    _limit(request, "academy-claim", 30)
    code = body.code.strip().upper().replace("-", "")
    with engine().begin() as c:
        row = c.execute(select(users).where(users.c.link_code == code)).mappings().first()
        if row is None or (row["link_expires"] or 0) < _now():
            raise HTTPException(404, "That code has expired. Make a new one on your other device.")
        token = secrets.token_urlsafe(32)
        c.execute(update(users).where(users.c.id == row["id"]).values(token_hash=_hash(token), link_code=None, link_expires=None))
    return {"user": _user_json(dict(row)), "token": token}


# ---------------------------------------------------------------------------- classes
def _membership(c, cid: str, uid: str) -> str | None:
    return c.execute(select(members.c.role).where(members.c.class_id == cid, members.c.user_id == uid)).scalar()


def _require(c, cid: str, uid: str, role: str | None = None) -> str:
    r = _membership(c, cid, uid)
    if r is None or (role and r != role):
        raise HTTPException(403 if r else 404, "Only the teacher can do that." if r else "Class not found.")
    return r


def _assignment_status(a: dict, mine: list[dict], now: float) -> str:
    best = max((s["accuracy"] for s in mine), default=None)
    if best is not None and best * 100 >= a["goal"]:
        return "done"
    if now < a["opens_at"]:
        return "upcoming"
    if now > a["due_at"]:
        return "late" if best is None else "tried"
    if best is not None:
        return "tried"
    return "due-soon" if a["due_at"] - now < 2 * DAY else "open"


def _assignment_json(a: dict, include_xml: bool = False) -> dict:
    out = {k: a[k] for k in ("id", "class_id", "title", "instructions", "piece_title", "bars_from", "bars_to", "part",
                             "mode", "tempo_pct", "goal", "points", "attempts", "listen_url")}
    out["opens_at"], out["due_at"] = _iso(a["opens_at"]), _iso(a["due_at"])
    out["has_piece"] = bool(a.get("musicxml"))
    if include_xml:
        out["musicxml"] = a.get("musicxml")
    return out


class NewClass(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    description: str = Field("", max_length=2000)
    color: str = "orange"
    visibility: str = Field("private", pattern="^(private|public)$")
    instrument: str = Field("", max_length=24)
    level: str = Field("", max_length=16)


def _registered_or_401(uid: str) -> None:
    """Teaching and joining classes need a real sign-in (Google, or a username and password)."""
    from accounts import accounts as acc_t, is_registered, signin_required, effective_tier
    if not signin_required():
        return
    with engine().connect() as c:
        acc = c.execute(select(acc_t).where(acc_t.c.user_id == uid)).mappings().first()
    if not is_registered(dict(acc) if acc else None) and effective_tier(dict(acc) if acc else None) != "dev":
        raise HTTPException(401, {"code": "signin_required", "message": "Sign in first (Google, or a username and password)."})


@router.post("/classes")
def create_class(body: NewClass, me: dict = Depends(current_user)):
    _registered_or_401(me["id"])
    cid = str(uuid.uuid4())
    with engine().begin() as c:
        for _ in range(20):
            code = _code(6)
            if not c.execute(select(classes.c.id).where(classes.c.join_code == code)).first():
                break
        c.execute(insert(classes).values(id=cid, name=body.name.strip(), description=body.description.strip(), teacher_id=me["id"],
                                         join_code=code, color=body.color if body.color in COLORS else "orange",
                                         archived=False, visibility=body.visibility, instrument=body.instrument.strip(),
                                         level=body.level.strip(), created=_now()))
        c.execute(insert(members).values(class_id=cid, user_id=me["id"], role="teacher", joined=_now()))
    return {"class": {"id": cid, "name": body.name.strip(), "join_code": code, "role": "teacher", "visibility": body.visibility}}


class Join(BaseModel):
    code: str = Field(..., min_length=4, max_length=12)


@router.post("/join")
def join(body: Join, request: Request, me: dict = Depends(current_user)):
    from app import _limit
    _limit(request, "academy-join", 60)
    _registered_or_401(me["id"])
    code = body.code.strip().upper().replace("-", "").replace(" ", "")
    with engine().begin() as c:
        cl = c.execute(select(classes).where(classes.c.join_code == code, classes.c.archived.is_(False))).mappings().first()
        if cl is None:
            raise HTTPException(404, "No class has that code. Check it with your teacher.")
        if _membership(c, cl["id"], me["id"]) is None:
            c.execute(insert(members).values(class_id=cl["id"], user_id=me["id"], role="student", joined=_now()))
        role = _membership(c, cl["id"], me["id"])
    return {"class": {"id": cl["id"], "name": cl["name"], "role": role, "color": cl["color"]}}


@router.get("/me")
def me_overview(me: dict = Depends(current_user)):
    now = _now()
    out_classes, todo = [], []
    with engine().connect() as c:
        rows = c.execute(select(classes, members.c.role).join(members, members.c.class_id == classes.c.id)
                         .where(members.c.user_id == me["id"], classes.c.archived.is_(False))
                         .order_by(classes.c.created)).mappings().all()
        for r in rows:
            n_students = c.execute(select(func.count()).select_from(members).where(members.c.class_id == r["id"], members.c.role == "student")).scalar()
            asg = c.execute(select(assignments).where(assignments.c.class_id == r["id"])).mappings().all()
            entry = {"id": r["id"], "name": r["name"], "role": r["role"], "color": r["color"], "students": n_students,
                     "assignments": len(asg)}
            if r["role"] == "teacher":
                entry["join_code"] = r["join_code"]
                pending = 0
                for a in asg:
                    sub_ids = [x[0] for x in c.execute(select(submissions.c.id).where(submissions.c.assignment_id == a["id"])).all()]
                    if sub_ids:
                        reviewed = {x[0] for x in c.execute(select(feedback.c.submission_id).where(feedback.c.submission_id.in_(sub_ids))).all()}
                        pending += len([s for s in sub_ids if s not in reviewed])
                entry["to_review"] = pending
            else:
                for a in asg:
                    mine = [dict(s) for s in c.execute(select(submissions.c.accuracy).where(submissions.c.assignment_id == a["id"], submissions.c.user_id == me["id"])).mappings().all()]
                    status = _assignment_status(dict(a), mine, now)
                    if status in ("open", "due-soon", "tried", "late", "upcoming"):
                        todo.append({**_assignment_json(dict(a)), "status": status, "class_name": r["name"], "class_color": r["color"],
                                     "best": round(max((s["accuracy"] for s in mine), default=0) * 100) if mine else None})
            out_classes.append(entry)
    order = {"due-soon": 0, "late": 1, "open": 2, "tried": 3, "upcoming": 4}
    todo.sort(key=lambda a: (order.get(a["status"], 9), a["due_at"] or ""))
    return {"user": _user_json(me), "classes": out_classes, "todo": todo}


@router.get("/classes/{cid}")
def class_detail(cid: str, me: dict = Depends(current_user)):
    now = _now()
    with engine().connect() as c:
        role = _require(c, cid, me["id"])
        cl = c.execute(select(classes).where(classes.c.id == cid)).mappings().first()
        people = c.execute(select(users.c.id, users.c.name, users.c.color, members.c.role)
                           .join(members, members.c.user_id == users.c.id).where(members.c.class_id == cid)
                           .order_by(members.c.joined)).mappings().all()
        students = [p for p in people if p["role"] == "student"]
        asg_out = []
        for a in c.execute(select(assignments).where(assignments.c.class_id == cid).order_by(assignments.c.due_at)).mappings().all():
            a = dict(a)
            item = _assignment_json(a)
            subs = c.execute(select(submissions.c.user_id, submissions.c.accuracy).where(submissions.c.assignment_id == a["id"])).mappings().all()
            if role == "teacher":
                best: dict[str, float] = {}
                for s in subs:
                    best[s["user_id"]] = max(best.get(s["user_id"], 0), s["accuracy"])
                item["submitted"] = len(best)
                item["reached_goal"] = sum(1 for v in best.values() if v * 100 >= a["goal"])
                item["students"] = len(students)
            else:
                mine = [dict(s) for s in subs if s["user_id"] == me["id"]]
                item["status"] = _assignment_status(a, mine, now)
                item["best"] = round(max((s["accuracy"] for s in mine), default=0) * 100) if mine else None
                item["tries"] = len(mine)
            asg_out.append(item)
    out = {"id": cl["id"], "name": cl["name"], "description": cl["description"], "color": cl["color"], "role": role,
           "visibility": cl.get("visibility") or "private", "instrument": cl.get("instrument") or "", "level": cl.get("level") or "",
           "teacher": next(({"id": p["id"], "name": p["name"]} for p in people if p["role"] == "teacher"), None),
           "members": [{"id": p["id"], "name": p["name"], "color": p["color"], "role": p["role"]} for p in people],
           "assignments": asg_out}
    if role == "teacher" or cl.get("visibility") == "public":
        out["join_code"] = cl["join_code"]                 # an open class can be passed on by anyone in it
    return out


@router.delete("/classes/{cid}/members/{uid}")
def remove_member(cid: str, uid: str, me: dict = Depends(current_user)):
    with engine().begin() as c:
        role = _require(c, cid, me["id"])
        if uid != me["id"] and role != "teacher":
            raise HTTPException(403, "Only the teacher can do that.")
        if role == "teacher" and uid == me["id"]:
            c.execute(update(classes).where(classes.c.id == cid).values(archived=True))
            return {"archived": True}
        c.execute(delete(members).where(members.c.class_id == cid, members.c.user_id == uid))
    return {"removed": uid}


# ---------------------------------------------------------------------------- assignments
class AssignmentIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=120)
    instructions: str = Field("", max_length=4000)
    piece_title: str = Field("", max_length=160)
    musicxml: str | None = None
    bars_from: int | None = Field(None, ge=0, le=5000)
    bars_to: int | None = Field(None, ge=0, le=5000)
    part: str = Field("", max_length=40)
    mode: str = Field("wait", pattern="^(wait|tempo|listen)$")
    tempo_pct: int = Field(100, ge=30, le=200)
    goal: int = Field(80, ge=0, le=100)
    points: int = Field(50, ge=0, le=1000)
    attempts: int | None = Field(None, ge=1, le=100)
    listen_url: str | None = Field(None, max_length=400)
    opens_at: str | None = None
    due_at: str | None = None


@router.post("/classes/{cid}/assignments")
def create_assignment(cid: str, body: AssignmentIn, me: dict = Depends(current_user)):
    if body.musicxml and len(body.musicxml.encode()) > MAX_XML:
        raise HTTPException(413, "That piece is too big to share (3 MB max).")
    now = _now()
    opens = _parse_time(body.opens_at, now)
    due = _parse_time(body.due_at, opens + 7 * DAY)
    if due <= opens:
        raise HTTPException(400, "The due date must be after the start date.")
    aid = str(uuid.uuid4())
    with engine().begin() as c:
        _require(c, cid, me["id"], "teacher")
        c.execute(insert(assignments).values(id=aid, class_id=cid, title=body.title.strip(), instructions=body.instructions.strip(),
                                             piece_title=body.piece_title.strip(), musicxml=body.musicxml, bars_from=body.bars_from,
                                             bars_to=body.bars_to, part=body.part, mode=body.mode, tempo_pct=body.tempo_pct,
                                             goal=body.goal, points=body.points, attempts=body.attempts, listen_url=body.listen_url,
                                             opens_at=opens, due_at=due, created=now))
        a = c.execute(select(assignments).where(assignments.c.id == aid)).mappings().first()
    return {"assignment": _assignment_json(dict(a))}


def _load_assignment(c, aid: str) -> dict:
    a = c.execute(select(assignments).where(assignments.c.id == aid)).mappings().first()
    if a is None:
        raise HTTPException(404, "Assignment not found.")
    return dict(a)


@router.get("/assignments/{aid}")
def get_assignment(aid: str, me: dict = Depends(current_user)):
    now = _now()
    with engine().connect() as c:
        a = _load_assignment(c, aid)
        role = _require(c, a["class_id"], me["id"])
        q = select(submissions.c.id, submissions.c.user_id, submissions.c.accuracy, submissions.c.timing, submissions.c.tempo_pct,
                   submissions.c.seconds, submissions.c.bars, submissions.c.note, submissions.c.late, submissions.c.points,
                   submissions.c.created, submissions.c.recording_type, users.c.name).join(users, users.c.id == submissions.c.user_id)\
            .where(submissions.c.assignment_id == aid).order_by(submissions.c.created.desc())
        if role != "teacher":
            q = q.where(submissions.c.user_id == me["id"])
        subs = [dict(s) for s in c.execute(q).mappings().all()]
        fb = {}
        if subs:
            for f in c.execute(select(feedback).where(feedback.c.submission_id.in_([s["id"] for s in subs]))).mappings().all():
                fb.setdefault(f["submission_id"], []).append({"text": f["text"], "stickers": f["stickers"] or [],
                                                              "focus_bars": f["focus_bars"] or [], "created": _iso(f["created"])})
    out = _assignment_json(a, include_xml=True)
    out["role"] = role
    out["submissions"] = [{"id": s["id"], "student": {"id": s["user_id"], "name": s["name"]}, "accuracy": round(s["accuracy"] * 100),
                           "timing": round(s["timing"] * 100) if s["timing"] is not None else None, "tempo_pct": s["tempo_pct"],
                           "seconds": s["seconds"], "bars": s["bars"] or [], "note": s["note"], "late": s["late"], "points": s["points"],
                           "created": _iso(s["created"]), "has_recording": bool(s["recording_type"]), "feedback": fb.get(s["id"], [])}
                          for s in subs]
    if role != "teacher":
        out["status"] = _assignment_status(a, [{"accuracy": s["accuracy"] / 100} for s in out["submissions"]], now)
    return out


@router.delete("/assignments/{aid}")
def delete_assignment(aid: str, me: dict = Depends(current_user)):
    with engine().begin() as c:
        a = _load_assignment(c, aid)
        _require(c, a["class_id"], me["id"], "teacher")
        sub_ids = [x[0] for x in c.execute(select(submissions.c.id).where(submissions.c.assignment_id == aid)).all()]
        if sub_ids:
            c.execute(delete(feedback).where(feedback.c.submission_id.in_(sub_ids)))
        c.execute(delete(submissions).where(submissions.c.assignment_id == aid))
        c.execute(delete(assignments).where(assignments.c.id == aid))
    return {"deleted": aid}


class SubmissionIn(BaseModel):
    accuracy: float = Field(..., ge=0, le=1)
    timing: float | None = Field(None, ge=0, le=1)
    tempo_pct: int | None = Field(None, ge=10, le=300)
    seconds: int = Field(0, ge=0, le=6 * 3600)
    bars: list[float] = Field(default_factory=list, max_length=2000)
    bar_numbers: list[int] = Field(default_factory=list, max_length=2000)   # the bar each accuracy belongs to
    note: str = Field("", max_length=1000)
    recording_b64: str | None = None
    recording_type: str | None = Field(None, max_length=40)


@router.post("/assignments/{aid}/submissions")
def submit(aid: str, body: SubmissionIn, me: dict = Depends(current_user)):
    now = _now()
    rec = None
    if body.recording_b64:
        try:
            rec = base64.b64decode(body.recording_b64, validate=True)
        except ValueError:
            raise HTTPException(400, "The recording could not be read.")
        if len(rec) > MAX_REC:
            raise HTTPException(413, "The recording is too long (about 15 minutes fit).")
    with engine().begin() as c:
        a = _load_assignment(c, aid)
        _require(c, a["class_id"], me["id"], "student")
        if now < a["opens_at"]:
            raise HTTPException(409, "This assignment hasn't opened yet.")
        tries = c.execute(select(func.count()).select_from(submissions).where(submissions.c.assignment_id == aid, submissions.c.user_id == me["id"])).scalar()
        if a["attempts"] and tries >= a["attempts"]:
            raise HTTPException(409, "You've used all your tries for this one.")
        late = now > a["due_at"]
        reached = body.accuracy * 100 >= a["goal"]
        earlier_best = c.execute(select(func.max(submissions.c.accuracy)).where(submissions.c.assignment_id == aid, submissions.c.user_id == me["id"])).scalar()
        already = earlier_best is not None and earlier_best * 100 >= a["goal"]
        points = 0 if already else a["points"] if reached else round(a["points"] * 0.3)
        if late:
            points //= 2
        sid = str(uuid.uuid4())
        bars = [round(float(x), 3) for x in body.bars]
        if body.bar_numbers and len(body.bar_numbers) == len(bars):
            bars = [[int(n), a] for n, a in zip(body.bar_numbers, bars)]                   # [[bar, accuracy], ...]
        c.execute(insert(submissions).values(id=sid, assignment_id=aid, user_id=me["id"], accuracy=body.accuracy, timing=body.timing,
                                             tempo_pct=body.tempo_pct, seconds=body.seconds, bars=bars,
                                             note=body.note.strip(), recording=rec, recording_type=body.recording_type if rec else None,
                                             late=late, points=points, created=now))
    return {"submission": {"id": sid, "reached_goal": reached, "late": late, "points": points}}


@router.get("/submissions/{sid}/recording")
def recording(sid: str, me: dict = Depends(current_user)):
    with engine().connect() as c:
        s = c.execute(select(submissions).where(submissions.c.id == sid)).mappings().first()
        if s is None or not s["recording"]:
            raise HTTPException(404, "No recording.")
        a = _load_assignment(c, s["assignment_id"])
        role = _require(c, a["class_id"], me["id"])
        if role != "teacher" and s["user_id"] != me["id"]:
            raise HTTPException(403, "Only the teacher can listen to this.")
    return Response(content=s["recording"], media_type=s["recording_type"] or "audio/mp4")


class FeedbackIn(BaseModel):
    text: str = Field("", max_length=2000)
    stickers: list[str] = Field(default_factory=list, max_length=8)
    focus_bars: list[int] = Field(default_factory=list, max_length=64)


@router.post("/submissions/{sid}/feedback")
def give_feedback(sid: str, body: FeedbackIn, me: dict = Depends(current_user)):
    if not body.text.strip() and not body.stickers and not body.focus_bars:
        raise HTTPException(400, "Write a comment or pick a sticker.")
    with engine().begin() as c:
        s = c.execute(select(submissions).where(submissions.c.id == sid)).mappings().first()
        if s is None:
            raise HTTPException(404, "Submission not found.")
        a = _load_assignment(c, s["assignment_id"])
        _require(c, a["class_id"], me["id"], "teacher")
        fid = str(uuid.uuid4())
        c.execute(insert(feedback).values(id=fid, submission_id=sid, teacher_id=me["id"], text=body.text.strip(),
                                          stickers=[x for x in body.stickers if x in STICKERS], focus_bars=body.focus_bars,
                                          created=_now()))
    return {"feedback": {"id": fid}}


# ---------------------------------------------------------------------------- feed and leaderboard
@router.get("/classes/{cid}/feed")
def feed(cid: str, me: dict = Depends(current_user), limit: int = 30):
    with engine().connect() as c:
        _require(c, cid, me["id"])
        rows = c.execute(select(submissions.c.id, submissions.c.accuracy, submissions.c.created, submissions.c.points,
                                users.c.name, users.c.color, users.c.id.label("uid"), assignments.c.title, assignments.c.goal)
                         .join(users, users.c.id == submissions.c.user_id)
                         .join(assignments, assignments.c.id == submissions.c.assignment_id)
                         .where(assignments.c.class_id == cid).order_by(submissions.c.created.desc()).limit(min(100, limit))).mappings().all()
        fbs = c.execute(select(feedback.c.created, feedback.c.stickers, feedback.c.submission_id, users.c.name)
                        .join(submissions, submissions.c.id == feedback.c.submission_id)
                        .join(assignments, assignments.c.id == submissions.c.assignment_id)
                        .join(users, users.c.id == submissions.c.user_id)
                        .where(assignments.c.class_id == cid).order_by(feedback.c.created.desc()).limit(min(100, limit))).mappings().all()
    items = [{"type": "goal" if r["accuracy"] * 100 >= r["goal"] else "practice", "who": {"id": r["uid"], "name": r["name"], "color": r["color"]},
              "assignment": r["title"], "accuracy": round(r["accuracy"] * 100), "points": r["points"], "at": _iso(r["created"])} for r in rows]
    items += [{"type": "feedback", "who": {"name": f["name"]}, "stickers": f["stickers"] or [], "at": _iso(f["created"])} for f in fbs]
    items.sort(key=lambda x: x["at"], reverse=True)
    return {"items": items[:limit]}


@router.get("/classes/{cid}/leaderboard")
def leaderboard(cid: str, me: dict = Depends(current_user), days: int = 7):
    since = _now() - max(1, min(365, days)) * DAY
    with engine().connect() as c:
        _require(c, cid, me["id"])
        rows = c.execute(select(users.c.id, users.c.name, users.c.color, func.coalesce(func.sum(submissions.c.points), 0).label("points"),
                                func.count(submissions.c.id).label("takes"), func.coalesce(func.sum(submissions.c.seconds), 0).label("seconds"))
                         .select_from(members.join(users, users.c.id == members.c.user_id)
                                      .outerjoin(submissions, (submissions.c.user_id == users.c.id) & (submissions.c.created >= since)
                                                 & submissions.c.assignment_id.in_(select(assignments.c.id).where(assignments.c.class_id == cid))))
                         .where(members.c.class_id == cid, members.c.role == "student")
                         .group_by(users.c.id, users.c.name, users.c.color)).mappings().all()
    board = sorted(({"id": r["id"], "name": r["name"], "color": r["color"], "points": int(r["points"]), "takes": int(r["takes"]),
                     "minutes": round(int(r["seconds"]) / 60)} for r in rows), key=lambda x: (-x["points"], -x["minutes"], x["name"]))
    for i, b in enumerate(board):
        b["rank"] = i + 1
        b["me"] = b["id"] == me["id"]
    return {"days": days, "board": board}


# ---------------------------------------------------------------------------- the open hub
class ClassEdit(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    description: str | None = Field(None, max_length=2000)
    color: str | None = None
    visibility: str | None = Field(None, pattern="^(private|public)$")
    instrument: str | None = Field(None, max_length=24)
    level: str | None = Field(None, max_length=16)
    new_code: bool = False


@router.patch("/classes/{cid}")
def edit_class(cid: str, body: ClassEdit, me: dict = Depends(current_user)):
    vals = {k: (v.strip() if isinstance(v, str) else v) for k, v in body.model_dump().items() if v is not None and k != "new_code"}
    if "color" in vals and vals["color"] not in COLORS:
        vals.pop("color")
    with engine().begin() as c:
        _require(c, cid, me["id"], "teacher")
        if body.new_code:                                              # the old code and link stop working
            for _ in range(20):
                code = _code(6)
                if not c.execute(select(classes.c.id).where(classes.c.join_code == code)).first():
                    break
            vals["join_code"] = code
        if vals:
            c.execute(update(classes).where(classes.c.id == cid).values(**vals))
    return class_detail(cid, me)


def _class_card(c, cl: dict) -> dict:
    teacher = c.execute(select(users.c.name, users.c.color).where(users.c.id == cl["teacher_id"])).mappings().first()
    n = c.execute(select(func.count()).select_from(members).where(members.c.class_id == cl["id"], members.c.role == "student")).scalar()
    return {"id": cl["id"], "name": cl["name"], "description": cl["description"][:400], "color": cl["color"],
            "visibility": cl.get("visibility") or "private", "instrument": cl.get("instrument") or "", "level": cl.get("level") or "",
            "teacher": {"name": teacher["name"] if teacher else "", "color": teacher["color"] if teacher else "blue"}, "students": n}


@router.get("/discover")
def discover(q: str = "", instrument: str = "", limit: int = 40):
    """Open classes anyone can join (no sign-in needed to look)."""
    words = [w for w in q.lower().split() if w]
    with engine().connect() as c:
        rows = c.execute(select(classes).where(classes.c.archived.is_(False), classes.c.visibility == "public")
                         .order_by(classes.c.created.desc()).limit(400)).mappings().all()
        out = []
        for r in rows:
            r = dict(r)
            if instrument and (r.get("instrument") or "") != instrument:
                continue
            hay = f"{r['name']} {r['description']} {r.get('instrument', '')}".lower()
            if words and not all(w in hay for w in words):
                continue
            out.append(_class_card(c, r))
            if len(out) >= max(1, min(100, limit)):
                break
    out.sort(key=lambda x: -x["students"])
    return {"classes": out}


@router.get("/preview/{code}")
def preview(code: str, request: Request):
    """What a join link or QR code opens: the class, before joining."""
    from app import _limit
    _limit(request, "academy-preview", 120)
    code = code.strip().upper().replace("-", "").replace(" ", "")
    with engine().connect() as c:
        cl = c.execute(select(classes).where(classes.c.join_code == code, classes.c.archived.is_(False))).mappings().first()
        if cl is None:
            raise HTTPException(404, "No class has that code. Check it with your teacher.")
        return {"class": _class_card(c, dict(cl)), "code": code}


@router.post("/classes/{cid}/join")
def join_open(cid: str, request: Request, me: dict = Depends(current_user)):
    """Joins an open (public) class from the list."""
    from app import _limit
    _limit(request, "academy-join", 60)
    _registered_or_401(me["id"])
    with engine().begin() as c:
        cl = c.execute(select(classes).where(classes.c.id == cid, classes.c.archived.is_(False))).mappings().first()
        if cl is None or (cl.get("visibility") or "private") != "public":
            raise HTTPException(404, "This class is not open to join. Ask the teacher for the code.")
        if _membership(c, cid, me["id"]) is None:
            c.execute(insert(members).values(class_id=cid, user_id=me["id"], role="student", joined=_now()))
    return {"class": {"id": cl["id"], "name": cl["name"], "role": _role(cid, me["id"]), "color": cl["color"]}}


def _role(cid: str, uid: str) -> str | None:
    with engine().connect() as c:
        return _membership(c, cid, uid)


# ---------------------------------------------------------------------------- practice takes
class TakeIn(BaseModel):
    class_ids: list[str] = Field(..., min_length=1, max_length=10)
    piece_title: str = Field("", max_length=160)
    accuracy: float = Field(..., ge=0, le=1)
    timing: float | None = Field(None, ge=0, le=1)
    tempo_pct: int | None = Field(None, ge=10, le=300)
    seconds: int = Field(0, ge=0, le=6 * 3600)
    bars: list[list[float]] = Field(default_factory=list, max_length=2000)
    wrong: list[dict] = Field(default_factory=list, max_length=60)
    mode: str = Field("", max_length=10)
    note: str = Field("", max_length=1000)
    recording_b64: str | None = None
    recording_type: str | None = Field(None, max_length=40)


@router.post("/takes")
def share_take(body: TakeIn, me: dict = Depends(current_user)):
    """A student shares a practice take (result, the notes that went wrong, and the recording) with their class."""
    rec = None
    if body.recording_b64:
        try:
            rec = base64.b64decode(body.recording_b64, validate=True)
        except ValueError:
            raise HTTPException(400, "The recording could not be read.")
        if len(rec) > MAX_REC:
            raise HTTPException(413, "The recording is too long (about 15 minutes fit).")
    wrong = [{"bar": int(w.get("bar", 0)), "want": str(w.get("want", ""))[:8], "played": str(w.get("played", ""))[:8]} for w in body.wrong[:60]]
    bars = [[int(b[0]), round(float(b[1]), 3)] for b in body.bars if len(b) == 2]
    ids = []
    with engine().begin() as c:
        for cid in dict.fromkeys(body.class_ids):
            if _membership(c, cid, me["id"]) != "student":
                raise HTTPException(403, "You can share with classes you are a student in.")
            tid = str(uuid.uuid4())
            c.execute(insert(takes).values(id=tid, class_id=cid, user_id=me["id"], piece_title=body.piece_title.strip(), accuracy=body.accuracy,
                                           timing=body.timing, tempo_pct=body.tempo_pct, seconds=body.seconds, bars=bars, wrong=wrong,
                                           mode=body.mode, note=body.note.strip(), recording=rec,
                                           recording_type=body.recording_type if rec else None, created=_now()))
            ids.append(tid)
    return {"takes": ids}


def _take_json(t: dict, comments: list[dict] | None = None) -> dict:
    return {"id": t["id"], "kind": "take", "class_id": t["class_id"], "piece_title": t["piece_title"], "accuracy": round(t["accuracy"] * 100),
            "timing": round(t["timing"] * 100) if t["timing"] is not None else None, "tempo_pct": t["tempo_pct"], "seconds": t["seconds"],
            "bars": t["bars"] or [], "wrong": t["wrong"] or [], "mode": t["mode"], "note": t["note"], "has_recording": bool(t["recording_type"]),
            "created": _iso(t["created"]), "feedback": comments or []}


@router.get("/takes/{tid}/recording")
def take_recording(tid: str, me: dict = Depends(current_user)):
    with engine().connect() as c:
        t = c.execute(select(takes).where(takes.c.id == tid)).mappings().first()
        if t is None or not t["recording"]:
            raise HTTPException(404, "No recording.")
        role = _membership(c, t["class_id"], me["id"])
        if role != "teacher" and t["user_id"] != me["id"]:
            raise HTTPException(403, "Only the teacher can listen to this.")
    return Response(content=t["recording"], media_type=t["recording_type"] or "audio/mp4")


@router.post("/takes/{tid}/feedback")
def take_feedback(tid: str, body: FeedbackIn, me: dict = Depends(current_user)):
    if not body.text.strip() and not body.stickers and not body.focus_bars:
        raise HTTPException(400, "Write a comment or pick a sticker.")
    with engine().begin() as c:
        t = c.execute(select(takes).where(takes.c.id == tid)).mappings().first()
        if t is None:
            raise HTTPException(404, "Take not found.")
        _require(c, t["class_id"], me["id"], "teacher")
        fid = str(uuid.uuid4())
        c.execute(insert(take_comments).values(id=fid, take_id=tid, teacher_id=me["id"], text=body.text.strip(),
                                               stickers=[x for x in body.stickers if x in STICKERS], focus_bars=body.focus_bars, created=_now()))
    return {"feedback": {"id": fid}}


# ---------------------------------------------------------------------------- progress (what the teacher sees)
def _student_rows(c, cid: str) -> list[dict]:
    return [dict(r) for r in c.execute(select(users.c.id, users.c.name, users.c.color, members.c.joined)
                                       .join(members, members.c.user_id == users.c.id)
                                       .where(members.c.class_id == cid, members.c.role == "student")
                                       .order_by(users.c.name)).mappings().all()]


@router.get("/classes/{cid}/progress")
def class_progress(cid: str, me: dict = Depends(current_user)):
    """One line per student: practice this week, average accuracy, assignments reached, last seen, trend."""
    now = _now()
    week = now - 7 * DAY
    with engine().connect() as c:
        _require(c, cid, me["id"], "teacher")
        asg = [dict(a) for a in c.execute(select(assignments.c.id, assignments.c.goal, assignments.c.opens_at).where(assignments.c.class_id == cid)).mappings().all()]
        open_asg = [a for a in asg if a["opens_at"] <= now]
        asg_ids = [a["id"] for a in asg]
        goal = {a["id"]: a["goal"] for a in asg}
        out = []
        for st in _student_rows(c, cid):
            subs = [dict(x) for x in c.execute(select(submissions.c.assignment_id, submissions.c.accuracy, submissions.c.seconds, submissions.c.created)
                                               .where(submissions.c.user_id == st["id"], submissions.c.assignment_id.in_(asg_ids or ["-"]))).mappings().all()]
            tks = [dict(x) for x in c.execute(select(takes.c.accuracy, takes.c.seconds, takes.c.created, takes.c.recording_type)
                                              .where(takes.c.user_id == st["id"], takes.c.class_id == cid)).mappings().all()]
            allp = sorted([(x["created"], x["accuracy"], x["seconds"]) for x in subs] + [(x["created"], x["accuracy"], x["seconds"]) for x in tks])
            reached = {x["assignment_id"] for x in subs if x["accuracy"] * 100 >= goal.get(x["assignment_id"], 80)}
            recent = [a for t0, a, _ in allp if t0 >= week]
            last5 = [a for _, a, _ in allp[-5:]]
            first5 = [a for _, a, _ in allp[:5]]
            out.append({"id": st["id"], "name": st["name"], "color": st["color"], "joined": _iso(st["joined"]),
                        "takes": len(allp), "minutes_week": round(sum(s for t0, _, s in allp if t0 >= week) / 60),
                        "accuracy": round(sum(last5) / len(last5) * 100) if last5 else None,
                        "trend": round((sum(last5) / len(last5) - sum(first5) / len(first5)) * 100) if len(allp) >= 4 else None,
                        "week_takes": len(recent), "done": len(reached), "assigned": len(open_asg),
                        "recordings": sum(1 for x in tks if x["recording_type"]),
                        "last": _iso(allp[-1][0]) if allp else None})
    return {"students": out}


@router.get("/classes/{cid}/students/{uid}")
def student_detail(cid: str, uid: str, me: dict = Depends(current_user)):
    """Everything one student has done in the class, newest first: assignment tries and shared practice takes,
    each with its score, the bars and notes that went wrong, the recording and the teacher's comments."""
    with engine().connect() as c:
        role = _require(c, cid, me["id"])
        if role != "teacher" and uid != me["id"]:
            raise HTTPException(403, "Only the teacher can see this.")
        st = c.execute(select(users.c.id, users.c.name, users.c.color).where(users.c.id == uid)).mappings().first()
        if st is None or _membership(c, cid, uid) != "student":
            raise HTTPException(404, "Student not found.")
        rows = c.execute(select(submissions.c.id, submissions.c.accuracy, submissions.c.timing, submissions.c.tempo_pct, submissions.c.seconds,
                                submissions.c.bars, submissions.c.note, submissions.c.late, submissions.c.created, submissions.c.recording_type,
                                assignments.c.title, assignments.c.goal, assignments.c.id.label("aid"))
                         .join(assignments, assignments.c.id == submissions.c.assignment_id)
                         .where(assignments.c.class_id == cid, submissions.c.user_id == uid)).mappings().all()
        fb = {}
        if rows:
            for f in c.execute(select(feedback).where(feedback.c.submission_id.in_([r["id"] for r in rows]))).mappings().all():
                fb.setdefault(f["submission_id"], []).append({"text": f["text"], "stickers": f["stickers"] or [], "focus_bars": f["focus_bars"] or [], "created": _iso(f["created"])})
        items = [{"id": r["id"], "kind": "assignment", "assignment_id": r["aid"], "piece_title": r["title"], "goal": r["goal"],
                  "accuracy": round(r["accuracy"] * 100), "timing": round(r["timing"] * 100) if r["timing"] is not None else None,
                  "tempo_pct": r["tempo_pct"], "seconds": r["seconds"], "bars": r["bars"] or [], "note": r["note"], "late": r["late"],
                  "has_recording": bool(r["recording_type"]), "created": _iso(r["created"]), "feedback": fb.get(r["id"], [])} for r in rows]
        trows = [dict(t) for t in c.execute(select(takes).where(takes.c.class_id == cid, takes.c.user_id == uid)).mappings().all()]
        tc = {}
        if trows:
            for f in c.execute(select(take_comments).where(take_comments.c.take_id.in_([t["id"] for t in trows]))).mappings().all():
                tc.setdefault(f["take_id"], []).append({"text": f["text"], "stickers": f["stickers"] or [], "focus_bars": f["focus_bars"] or [], "created": _iso(f["created"])})
        items += [_take_json(t, tc.get(t["id"])) for t in trows]
    items.sort(key=lambda x: x["created"], reverse=True)
    # the bars this student most often gets wrong, over everything
    weak: dict[int, list[float]] = {}
    for it in items:
        for b in it["bars"]:
            if isinstance(b, list) and len(b) == 2:
                weak.setdefault(int(b[0]), []).append(float(b[1]))
    tricky = sorted(((bar, sum(v) / len(v)) for bar, v in weak.items() if len(v) >= 1), key=lambda x: x[1])[:8]
    return {"student": {"id": st["id"], "name": st["name"], "color": st["color"]}, "role": role, "items": items,
            "tricky": [{"bar": b, "accuracy": round(a * 100)} for b, a in tricky if a < 0.85]}
