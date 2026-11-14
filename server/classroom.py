"""The Classroom structure around Academy classes (academy.py), at the level people know from Google Classroom.

  Stream     announcements from the teacher (and posts from students when the teacher allows), with comments;
             a muted student can read but not post or comment.
  Classwork  assignments (academy.py: piece, bars, target tempo, minimum score, opens / due, late flag) grouped by
             topic, each with an optional rubric; submissions are Play Along takes.
  People     teachers and students, invite by email, remove (academy.py), mute.
  Grades     a grid of students x assignments with each student's best Play Along score, tries, late flags and the
             teacher's rubric grade; downloadable as CSV.
  Feedback   on any submission or shared take: text, stickers and bars to work on (academy.py), plus an audio
             comment and highlighted bars.
  Sessions   scheduled lessons of the class: a Google Calendar event with a Meet link for the teacher and the
             students (when the teacher has connected Google Calendar), synced both ways, and an .ics file for
             everyone else.
  Notices    in-app notifications for new assignments, announcements, feedback and sessions; email as well when
             SMTP is set up (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM).
"""
from __future__ import annotations

import base64
import csv
import io
import os
import smtplib
import time
import uuid
from email.message import EmailMessage

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import JSON, Boolean, Column, Float, Integer, LargeBinary, String, Table, Text, delete, func, insert, select, update

import accounts as A
from academy import (DAY, _iso, _membership, _now, _require, assignments, classes, current_user, engine, members, meta,
                     submissions, takes, users)

router = APIRouter(prefix="/academy", tags=["classroom"])

posts = Table("class_posts", meta,
              Column("id", String(36), primary_key=True),
              Column("class_id", String(36), nullable=False, index=True),
              Column("author_id", String(36), nullable=False),
              Column("kind", String(12), nullable=False, default="announcement"),     # announcement | post
              Column("text", Text, nullable=False),
              Column("piece_title", String(160), nullable=False, default=""),
              Column("link", String(400), nullable=False, default=""),
              Column("pinned", Boolean, nullable=False, default=False),
              Column("created", Float, nullable=False))
comments = Table("class_comments", meta,
                 Column("id", String(36), primary_key=True),
                 Column("post_id", String(36), nullable=False, index=True),
                 Column("author_id", String(36), nullable=False),
                 Column("text", Text, nullable=False),
                 Column("created", Float, nullable=False))
topics = Table("class_topics", meta,
               Column("id", String(36), primary_key=True),
               Column("class_id", String(36), nullable=False, index=True),
               Column("name", String(80), nullable=False),
               Column("position", Integer, nullable=False, default=0))
asg_meta = Table("assignment_meta", meta,
                 Column("assignment_id", String(36), primary_key=True),
                 Column("topic_id", String(36), nullable=True),
                 Column("rubric", JSON, nullable=True))                  # [{"criterion": "Notes", "points": 4}, ...]
grades = Table("class_grades", meta,
               Column("assignment_id", String(36), primary_key=True),
               Column("user_id", String(36), primary_key=True),
               Column("rubric_scores", JSON, nullable=True),
               Column("grade", Float, nullable=True),
               Column("returned", Boolean, nullable=False, default=False),
               Column("updated", Float, nullable=False))
mutes = Table("class_mutes", meta,
              Column("class_id", String(36), primary_key=True),
              Column("user_id", String(36), primary_key=True),
              Column("until", Float, nullable=False))
audio_notes = Table("feedback_audio", meta,
                    Column("id", String(36), primary_key=True),
                    Column("target", String(10), nullable=False),           # submission | take
                    Column("target_id", String(36), nullable=False, index=True),
                    Column("teacher_id", String(36), nullable=False),
                    Column("audio", LargeBinary, nullable=False),
                    Column("audio_type", String(40), nullable=False),
                    Column("bars", JSON, nullable=True),
                    Column("text", Text, nullable=False, default=""),
                    Column("created", Float, nullable=False))
sessions_t = Table("class_sessions", meta,
                   Column("id", String(36), primary_key=True),
                   Column("class_id", String(36), nullable=False, index=True),
                   Column("title", String(160), nullable=False),
                   Column("start", Float, nullable=False),
                   Column("minutes", Integer, nullable=False, default=45),
                   Column("meet_url", String(300), nullable=False, default=""),
                   Column("event_id", String(200), nullable=False, default=""),
                   Column("cancelled", Boolean, nullable=False, default=False),
                   Column("created_by", String(36), nullable=False),
                   Column("synced", Float, nullable=True),
                   Column("created", Float, nullable=False))

AUDIO_TYPES = ("audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/aac")
MAX_AUDIO_NOTE = 2 * 1024 * 1024


# -------------------------------------------------------------------------------------------- helpers
def send_email(to: list[str], subject: str, body: str) -> int:
    """Sends a plain email when SMTP is set up; returns how many went out. Tests replace this function."""
    host = os.environ.get("SMTP_HOST", "")
    to = [x for x in to if x and "@" in x]
    if not host or not to:
        return 0
    msg = EmailMessage()
    msg["From"] = os.environ.get("SMTP_FROM", "Melovyn <no-reply@haptune.name.my>")
    msg["Bcc"] = ", ".join(to)
    msg["Subject"] = subject[:200]
    msg.set_content(body[:8000])
    try:
        with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "587")), timeout=15) as s:
            s.starttls()
            if os.environ.get("SMTP_USER"):
                s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
            s.send_message(msg)
        return len(to)
    except Exception:
        return 0


def _people(c, cid: str, role: str | None = None) -> list[dict]:
    q = (select(users.c.id, users.c.name, users.c.color, members.c.role, members.c.joined, A.accounts.c.email)
         .join(members, members.c.user_id == users.c.id).join(A.accounts, A.accounts.c.user_id == users.c.id, isouter=True)
         .where(members.c.class_id == cid))
    if role:
        q = q.where(members.c.role == role)
    return [dict(r) for r in c.execute(q.order_by(users.c.name)).mappings().all()]


def _tell_class(c, cid: str, kind: str, *, exclude: str = "", email_subject: str = "", email_body: str = "", **data) -> None:
    """In-app notification to everyone in the class (and an email when SMTP is set up)."""
    cl = c.execute(select(classes.c.name).where(classes.c.id == cid)).scalar() or ""
    ppl = [p for p in _people(c, cid) if p["id"] != exclude]
    for p in ppl:
        A.notify(c, p["id"], kind, class_id=cid, class_name=cl, **data)
    if email_subject:
        send_email([p["email"] for p in ppl if p.get("email")], f"{cl}: {email_subject}", email_body)


def _muted(c, cid: str, uid: str) -> bool:
    until = c.execute(select(mutes.c.until).where(mutes.c.class_id == cid, mutes.c.user_id == uid)).scalar()
    return bool(until and until > _now())


def _name_map(c, ids) -> dict:
    ids = list({i for i in ids if i})
    if not ids:
        return {}
    return {r["id"]: {"id": r["id"], "name": r["name"], "color": r["color"]} for r in c.execute(select(users.c.id, users.c.name, users.c.color).where(users.c.id.in_(ids))).mappings().all()}


# -------------------------------------------------------------------------------------------- stream
class PostIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    piece_title: str = Field("", max_length=160)
    link: str = Field("", max_length=400, pattern=r"^(https://\S+)?$")
    pinned: bool = False


@router.get("/classes/{cid}/stream")
def stream(cid: str, me: dict = Depends(current_user), limit: int = 40):
    with engine().connect() as c:
        role = _require(c, cid, me["id"])
        rows = [dict(r) for r in c.execute(select(posts).where(posts.c.class_id == cid).order_by(posts.c.pinned.desc(), posts.c.created.desc()).limit(max(1, min(100, limit)))).mappings().all()]
        cm = {}
        if rows:
            for r in c.execute(select(comments).where(comments.c.post_id.in_([p["id"] for p in rows])).order_by(comments.c.created)).mappings().all():
                cm.setdefault(r["post_id"], []).append(dict(r))
        names = _name_map(c, [p["author_id"] for p in rows] + [x["author_id"] for v in cm.values() for x in v])
        muted = _muted(c, cid, me["id"])
    return {"role": role, "muted": muted, "posts": [{
        "id": p["id"], "kind": p["kind"], "text": p["text"], "piece_title": p["piece_title"], "link": p["link"], "pinned": p["pinned"],
        "author": names.get(p["author_id"]), "created": _iso(p["created"]), "mine": p["author_id"] == me["id"],
        "comments": [{"id": x["id"], "text": x["text"], "author": names.get(x["author_id"]), "created": _iso(x["created"]), "mine": x["author_id"] == me["id"]} for x in cm.get(p["id"], [])],
    } for p in rows]}


@router.post("/classes/{cid}/stream")
def new_post(cid: str, body: PostIn, me: dict = Depends(current_user)):
    with engine().begin() as c:
        role = _require(c, cid, me["id"])
        if role != "teacher" and _muted(c, cid, me["id"]):
            raise HTTPException(403, "Your teacher has paused your posts in this class for now.")
        pid = str(uuid.uuid4())
        kind = "announcement" if role == "teacher" else "post"
        c.execute(insert(posts).values(id=pid, class_id=cid, author_id=me["id"], kind=kind, text=body.text.strip(), piece_title=body.piece_title.strip(),
                                       link=body.link.strip(), pinned=body.pinned and role == "teacher", created=_now()))
        if kind == "announcement":
            _tell_class(c, cid, "class_announcement", exclude=me["id"], post=pid, email_subject="New announcement", email_body=body.text.strip())
    return {"id": pid, "kind": kind}


class CommentIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=1500)


@router.post("/stream/{pid}/comments")
def comment(pid: str, body: CommentIn, me: dict = Depends(current_user)):
    with engine().begin() as c:
        p = c.execute(select(posts).where(posts.c.id == pid)).mappings().first()
        if p is None:
            raise HTTPException(404, "Post not found.")
        role = _require(c, p["class_id"], me["id"])
        if role != "teacher" and _muted(c, p["class_id"], me["id"]):
            raise HTTPException(403, "Your teacher has paused your comments in this class for now.")
        cid_ = str(uuid.uuid4())
        c.execute(insert(comments).values(id=cid_, post_id=pid, author_id=me["id"], text=body.text.strip(), created=_now()))
        if p["author_id"] != me["id"]:
            A.notify(c, p["author_id"], "class_comment", class_id=p["class_id"], post=pid)
    return {"id": cid_}


@router.delete("/stream/{pid}")
def delete_post(pid: str, me: dict = Depends(current_user)):
    with engine().begin() as c:
        p = c.execute(select(posts).where(posts.c.id == pid)).mappings().first()
        if p is None:
            raise HTTPException(404, "Post not found.")
        role = _require(c, p["class_id"], me["id"])
        if role != "teacher" and p["author_id"] != me["id"]:
            raise HTTPException(403, "Only the teacher or the author can remove this.")
        c.execute(delete(comments).where(comments.c.post_id == pid))
        c.execute(delete(posts).where(posts.c.id == pid))
    return {"ok": True}


@router.delete("/comments/{xid}")
def delete_comment(xid: str, me: dict = Depends(current_user)):
    with engine().begin() as c:
        x = c.execute(select(comments).where(comments.c.id == xid)).mappings().first()
        if x is None:
            raise HTTPException(404, "Comment not found.")
        p = c.execute(select(posts).where(posts.c.id == x["post_id"])).mappings().first()
        role = _require(c, p["class_id"], me["id"])
        if role != "teacher" and x["author_id"] != me["id"]:
            raise HTTPException(403, "Only the teacher or the author can remove this.")
        c.execute(delete(comments).where(comments.c.id == xid))
    return {"ok": True}


# -------------------------------------------------------------------------------------------- classwork: topics, rubrics
class TopicIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    position: int = Field(0, ge=0, le=999)


@router.get("/classes/{cid}/classwork")
def classwork(cid: str, me: dict = Depends(current_user)):
    """Assignments grouped by topic, with each one's rubric, and (for a student) their best score."""
    now = _now()
    with engine().connect() as c:
        role = _require(c, cid, me["id"])
        tps = [dict(t) for t in c.execute(select(topics).where(topics.c.class_id == cid).order_by(topics.c.position, topics.c.name)).mappings().all()]
        asg = [dict(a) for a in c.execute(select(assignments.c.id, assignments.c.title, assignments.c.piece_title, assignments.c.goal, assignments.c.tempo_pct,
                                                 assignments.c.opens_at, assignments.c.due_at, assignments.c.points)
                                          .where(assignments.c.class_id == cid).order_by(assignments.c.due_at)).mappings().all()]
        if role != "teacher":
            asg = [a for a in asg if a["opens_at"] <= now]
        am = {r["assignment_id"]: dict(r) for r in c.execute(select(asg_meta).where(asg_meta.c.assignment_id.in_([a["id"] for a in asg] or ["-"]))).mappings().all()}
        best = {}
        if role != "teacher":
            for r in c.execute(select(submissions.c.assignment_id, func.max(submissions.c.accuracy), func.count())
                               .where(submissions.c.user_id == me["id"], submissions.c.assignment_id.in_([a["id"] for a in asg] or ["-"]))
                               .group_by(submissions.c.assignment_id)).all():
                best[r[0]] = {"best": round(r[1] * 100), "tries": r[2]}
    items = [{**{k: a[k] for k in ("id", "title", "piece_title", "goal", "tempo_pct", "points")}, "opens_at": _iso(a["opens_at"]), "due_at": _iso(a["due_at"]),
              "late": now > a["due_at"], "topic_id": am.get(a["id"], {}).get("topic_id"), "rubric": am.get(a["id"], {}).get("rubric") or [],
              **({"mine": best.get(a["id"])} if role != "teacher" else {})} for a in asg]
    return {"role": role, "topics": [{"id": t["id"], "name": t["name"], "position": t["position"]} for t in tps], "assignments": items}


@router.post("/classes/{cid}/topics")
def add_topic(cid: str, body: TopicIn, me: dict = Depends(current_user)):
    with engine().begin() as c:
        _require(c, cid, me["id"], "teacher")
        if c.execute(select(func.count()).select_from(topics).where(topics.c.class_id == cid)).scalar() >= 50:
            raise HTTPException(409, "That's enough topics for one class.")
        tid = str(uuid.uuid4())
        c.execute(insert(topics).values(id=tid, class_id=cid, name=body.name.strip(), position=body.position))
    return {"id": tid}


@router.delete("/topics/{tid}")
def del_topic(tid: str, me: dict = Depends(current_user)):
    with engine().begin() as c:
        t = c.execute(select(topics).where(topics.c.id == tid)).mappings().first()
        if t is None:
            raise HTTPException(404, "Topic not found.")
        _require(c, t["class_id"], me["id"], "teacher")
        c.execute(update(asg_meta).where(asg_meta.c.topic_id == tid).values(topic_id=None))
        c.execute(delete(topics).where(topics.c.id == tid))
    return {"ok": True}


class Criterion(BaseModel):
    criterion: str = Field(..., min_length=1, max_length=80)
    points: int = Field(..., ge=1, le=100)


class MetaIn(BaseModel):
    topic_id: str | None = None
    rubric: list[Criterion] = Field(default_factory=list, max_length=12)


@router.put("/assignments/{aid}/meta")
def set_meta(aid: str, body: MetaIn, me: dict = Depends(current_user)):
    with engine().begin() as c:
        a = c.execute(select(assignments.c.class_id).where(assignments.c.id == aid)).scalar()
        if a is None:
            raise HTTPException(404, "Assignment not found.")
        _require(c, a, me["id"], "teacher")
        if body.topic_id and c.execute(select(topics.c.class_id).where(topics.c.id == body.topic_id)).scalar() != a:
            raise HTTPException(400, "That topic is in another class.")
        vals = {"topic_id": body.topic_id, "rubric": [x.model_dump() for x in body.rubric]}
        if c.execute(select(asg_meta.c.assignment_id).where(asg_meta.c.assignment_id == aid)).first():
            c.execute(update(asg_meta).where(asg_meta.c.assignment_id == aid).values(**vals))
        else:
            c.execute(insert(asg_meta).values(assignment_id=aid, **vals))
    return {"ok": True}


# -------------------------------------------------------------------------------------------- people
@router.get("/classes/{cid}/people")
def people(cid: str, me: dict = Depends(current_user)):
    with engine().connect() as c:
        role = _require(c, cid, me["id"])
        ppl = _people(c, cid)
        muted = {r["user_id"]: r["until"] for r in c.execute(select(mutes).where(mutes.c.class_id == cid)).mappings().all()}
    now = _now()
    out = lambda r: {"id": r["id"], "name": r["name"], "color": r["color"], "role": r["role"], "joined": _iso(r["joined"]),  # noqa: E731
                     "muted": muted.get(r["id"], 0) > now, **({"email": r["email"] or ""} if role == "teacher" else {})}
    return {"role": role, "teachers": [out(r) for r in ppl if r["role"] == "teacher"], "students": [out(r) for r in ppl if r["role"] == "student"]}


class MuteIn(BaseModel):
    minutes: int = Field(..., ge=0, le=60 * 24 * 60)        # 0 = unmute


@router.post("/classes/{cid}/people/{uid}/mute")
def mute(cid: str, uid: str, body: MuteIn, me: dict = Depends(current_user)):
    with engine().begin() as c:
        _require(c, cid, me["id"], "teacher")
        if _membership(c, cid, uid) != "student":
            raise HTTPException(404, "Student not found.")
        c.execute(delete(mutes).where(mutes.c.class_id == cid, mutes.c.user_id == uid))
        if body.minutes:
            c.execute(insert(mutes).values(class_id=cid, user_id=uid, until=_now() + body.minutes * 60))
    return {"ok": True, "muted": bool(body.minutes)}


class InviteIn(BaseModel):
    emails: list[str] = Field(..., min_length=1, max_length=50)


@router.post("/classes/{cid}/invite")
def invite(cid: str, body: InviteIn, me: dict = Depends(current_user)):
    """Invites people by email: anyone with a Melovyn account on that email gets a notification; an email goes
    out to all when SMTP is set up. The reply always has the join link and a WhatsApp share link as well."""
    from urllib.parse import quote
    emails = sorted({e.strip().lower() for e in body.emails if "@" in e and len(e) <= 200})
    if not emails:
        raise HTTPException(400, "Add at least one email address.")
    site = os.environ.get("HAPTUNE_SITE_URL", "https://haptune.name.my").rstrip("/")
    with engine().begin() as c:
        _require(c, cid, me["id"], "teacher")
        cl = c.execute(select(classes.c.name, classes.c.join_code).where(classes.c.id == cid)).mappings().first()
        link = f"{site}/app/#join/{cl['join_code']}"
        text = f"Join my class \"{cl['name']}\" on Melovyn: {link} (code {cl['join_code']})"
        found = c.execute(select(A.accounts.c.user_id).where(func.lower(A.accounts.c.email).in_(emails))).scalars().all()
        for uid in found:
            A.notify(c, uid, "class_invite", class_id=cid, class_name=cl["name"], code=cl["join_code"])
    sent = send_email(emails, f"Invitation: {cl['name']}", text)
    return {"invited": len(emails), "on_melovyn": len(found), "emailed": sent, "link": link, "text": text,
            "whatsapp": "https://wa.me/?text=" + quote(text), "mailto": "mailto:?bcc=" + quote(",".join(emails)) + "&subject=" + quote(f"Invitation: {cl['name']}") + "&body=" + quote(text)}


# -------------------------------------------------------------------------------------------- grades
def _grid(c, cid: str) -> dict:
    asg = [dict(a) for a in c.execute(select(assignments.c.id, assignments.c.title, assignments.c.goal, assignments.c.due_at, assignments.c.points)
                                      .where(assignments.c.class_id == cid).order_by(assignments.c.due_at)).mappings().all()]
    ids = [a["id"] for a in asg] or ["-"]
    sts = _people(c, cid, "student")
    cells: dict = {s["id"]: {} for s in sts}
    for r in c.execute(select(submissions.c.user_id, submissions.c.assignment_id, func.max(submissions.c.accuracy), func.count(),
                              func.max(submissions.c.late.cast(Integer)), func.min(submissions.c.created))
                       .where(submissions.c.assignment_id.in_(ids)).group_by(submissions.c.user_id, submissions.c.assignment_id)).all():
        if r[0] in cells:
            cells[r[0]][r[1]] = {"best": round(r[2] * 100), "tries": r[3], "late": bool(r[4]), "first": _iso(r[5])}
    for g in c.execute(select(grades).where(grades.c.assignment_id.in_(ids))).mappings().all():
        if g["user_id"] in cells:
            cell = cells[g["user_id"]].setdefault(g["assignment_id"], {"best": None, "tries": 0, "late": False})
            cell.update({"grade": g["grade"], "rubric_scores": g["rubric_scores"] or [], "returned": g["returned"]})
    goal = {a["id"]: a["goal"] for a in asg}
    for uid, row in cells.items():
        for aid, cell in row.items():
            cell["status"] = "graded" if cell.get("grade") is not None else "reached" if (cell.get("best") or 0) >= goal.get(aid, 80) else "turned_in" if cell.get("tries") else "missing"
    return {"assignments": [{"id": a["id"], "title": a["title"], "goal": a["goal"], "due_at": _iso(a["due_at"]), "points": a["points"]} for a in asg],
            "students": [{"id": s["id"], "name": s["name"], "color": s["color"]} for s in sts], "cells": cells}


@router.get("/classes/{cid}/grades")
def class_grades(cid: str, me: dict = Depends(current_user)):
    with engine().connect() as c:
        _require(c, cid, me["id"], "teacher")
        import teachers
        teachers.check_reports(c, cid, me["id"])
        return _grid(c, cid)


@router.get("/classes/{cid}/grades.csv")
def class_grades_csv(cid: str, me: dict = Depends(current_user)):
    with engine().connect() as c:
        _require(c, cid, me["id"], "teacher")
        import teachers
        teachers.check_reports(c, cid, me["id"])
        g = _grid(c, cid)
        name = c.execute(select(classes.c.name).where(classes.c.id == cid)).scalar() or "class"
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Student"] + [f"{a['title']} (best %)" for a in g["assignments"]] + [f"{a['title']} (grade)" for a in g["assignments"]])
    safe = lambda v: ("'" + v) if isinstance(v, str) and v[:1] in "=+-@" else v  # noqa: E731   (no formulas in spreadsheets)
    for s in g["students"]:
        row = g["cells"].get(s["id"], {})
        w.writerow([safe(s["name"])] + [row.get(a["id"], {}).get("best", "") if row.get(a["id"], {}).get("best") is not None else "" for a in g["assignments"]]
                   + [row.get(a["id"], {}).get("grade", "") if row.get(a["id"], {}).get("grade") is not None else "" for a in g["assignments"]])
    fname = "".join(ch for ch in name if ch.isalnum() or ch in " -_")[:60].strip() or "class"
    return Response(content=buf.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{fname} grades.csv"'})


class GradeIn(BaseModel):
    rubric_scores: list[int] = Field(default_factory=list, max_length=12)
    grade: float | None = Field(None, ge=0, le=1000)
    returned: bool = True


@router.put("/assignments/{aid}/grades/{uid}")
def set_grade(aid: str, uid: str, body: GradeIn, me: dict = Depends(current_user)):
    with engine().begin() as c:
        cid = c.execute(select(assignments.c.class_id).where(assignments.c.id == aid)).scalar()
        if cid is None:
            raise HTTPException(404, "Assignment not found.")
        _require(c, cid, me["id"], "teacher")
        if _membership(c, cid, uid) != "student":
            raise HTTPException(404, "Student not found.")
        rubric = c.execute(select(asg_meta.c.rubric).where(asg_meta.c.assignment_id == aid)).scalar() or []
        if body.rubric_scores and len(body.rubric_scores) != len(rubric):
            raise HTTPException(400, "Give one score for each line of the rubric.")
        for sc, cr in zip(body.rubric_scores, rubric):
            if sc < 0 or sc > cr["points"]:
                raise HTTPException(400, f"{cr['criterion']}: 0 to {cr['points']}.")
        grade = body.grade if body.grade is not None else (float(sum(body.rubric_scores)) if body.rubric_scores else None)
        vals = dict(rubric_scores=body.rubric_scores, grade=grade, returned=body.returned, updated=_now())
        if c.execute(select(grades.c.user_id).where(grades.c.assignment_id == aid, grades.c.user_id == uid)).first():
            c.execute(update(grades).where(grades.c.assignment_id == aid, grades.c.user_id == uid).values(**vals))
        else:
            c.execute(insert(grades).values(assignment_id=aid, user_id=uid, **vals))
        if body.returned:
            A.notify(c, uid, "class_graded", class_id=cid, assignment=aid, grade=grade)
    return {"grade": grade, "returned": body.returned}


# -------------------------------------------------------------------------------------------- audio feedback
class AudioNoteIn(BaseModel):
    audio_b64: str = Field(..., max_length=MAX_AUDIO_NOTE * 2)
    audio_type: str = Field(..., max_length=40)
    bars: list[int] = Field(default_factory=list, max_length=64)
    text: str = Field("", max_length=2000)


def _target_class(c, target: str, tid: str) -> tuple[str, str]:
    if target == "submission":
        row = c.execute(select(submissions.c.user_id, assignments.c.class_id).join(assignments, assignments.c.id == submissions.c.assignment_id)
                        .where(submissions.c.id == tid)).first()
    elif target == "take":
        row = c.execute(select(takes.c.user_id, takes.c.class_id).where(takes.c.id == tid)).first()
    else:
        raise HTTPException(404, "Nothing to comment on.")
    if row is None:
        raise HTTPException(404, "Not found.")
    return row[1], row[0]


def add_audio_note(target: str, tid: str, body: AudioNoteIn, me: dict):
    if body.audio_type.split(";")[0] not in AUDIO_TYPES:
        raise HTTPException(415, "That is not an audio recording.")
    try:
        audio = base64.b64decode(body.audio_b64, validate=True)
    except ValueError:
        raise HTTPException(400, "The recording could not be read.")
    if not audio or len(audio) > MAX_AUDIO_NOTE:
        raise HTTPException(413, "Voice comments can be up to about 2 minutes.")
    with engine().begin() as c:
        cid, student = _target_class(c, target, tid)
        _require(c, cid, me["id"], "teacher")
        nid = str(uuid.uuid4())
        c.execute(insert(audio_notes).values(id=nid, target=target, target_id=tid, teacher_id=me["id"], audio=audio, audio_type=body.audio_type.split(";")[0],
                                             bars=body.bars, text=body.text.strip(), created=_now()))
        A.notify(c, student, "class_feedback", class_id=cid, target=target, target_id=tid)
    return {"id": nid}


def list_audio_notes(target: str, tid: str, me: dict):
    with engine().connect() as c:
        cid, student = _target_class(c, target, tid)
        role = _require(c, cid, me["id"])
        if role != "teacher" and student != me["id"]:
            raise HTTPException(403, "Only the teacher and the student can hear this.")
        rows = c.execute(select(audio_notes.c.id, audio_notes.c.bars, audio_notes.c.text, audio_notes.c.created)
                         .where(audio_notes.c.target == target, audio_notes.c.target_id == tid).order_by(audio_notes.c.created)).mappings().all()
    return {"notes": [{"id": r["id"], "bars": r["bars"] or [], "text": r["text"], "created": _iso(r["created"])} for r in rows]}


@router.post("/submissions/{tid}/audio-feedback")
def add_audio_submission(tid: str, body: AudioNoteIn, me: dict = Depends(current_user)):
    return add_audio_note("submission", tid, body, me)


@router.post("/takes/{tid}/audio-feedback")
def add_audio_take(tid: str, body: AudioNoteIn, me: dict = Depends(current_user)):
    return add_audio_note("take", tid, body, me)


@router.get("/submissions/{tid}/audio-feedback")
def list_audio_submission(tid: str, me: dict = Depends(current_user)):
    return list_audio_notes("submission", tid, me)


@router.get("/takes/{tid}/audio-feedback")
def list_audio_take(tid: str, me: dict = Depends(current_user)):
    return list_audio_notes("take", tid, me)


@router.get("/audio-feedback/{nid}")
def audio_note(nid: str, me: dict = Depends(current_user)):
    with engine().connect() as c:
        n = c.execute(select(audio_notes).where(audio_notes.c.id == nid)).mappings().first()
        if n is None:
            raise HTTPException(404, "Not found.")
        cid, student = _target_class(c, n["target"], n["target_id"])
        role = _require(c, cid, me["id"])
        if role != "teacher" and student != me["id"]:
            raise HTTPException(403, "Only the teacher and the student can hear this.")
    return Response(content=n["audio"], media_type=n["audio_type"], headers={"X-Content-Type-Options": "nosniff"})


# -------------------------------------------------------------------------------------------- sessions (calendar)
class SessionIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=160)
    start: str = Field(..., max_length=40)                 # ISO 8601
    minutes: int = Field(45, ge=10, le=600)
    meet: bool = True


def _session_json(s: dict) -> dict:
    return {"id": s["id"], "title": s["title"], "start": _iso(s["start"]), "minutes": s["minutes"], "meet_url": s["meet_url"],
            "calendar": bool(s["event_id"]), "cancelled": s["cancelled"]}


def _parse_iso(s: str) -> float:
    from datetime import datetime
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        raise HTTPException(400, "The start time could not be read.")


@router.post("/classes/{cid}/sessions")
def add_session(cid: str, body: SessionIn, me: dict = Depends(current_user)):
    import google_link as G
    start = _parse_iso(body.start)
    if start < _now() - 3600:
        raise HTTPException(400, "That time has already passed.")
    with engine().connect() as c:
        _require(c, cid, me["id"], "teacher")
        emails = [p["email"] for p in _people(c, cid, "student") if p.get("email")]
        cname = c.execute(select(classes.c.name).where(classes.c.id == cid)).scalar()
    ev = {"event_id": "", "meet_url": ""}
    if G.has(me["id"], "calendar"):
        ev = G.calendar_event(me["id"], title=f"{cname}: {body.title}", start=start, minutes=body.minutes,
                              description="A Melovyn class session.", attendees=emails, meet=body.meet)
    sid = str(uuid.uuid4())
    with engine().begin() as c:
        c.execute(insert(sessions_t).values(id=sid, class_id=cid, title=body.title.strip(), start=start, minutes=body.minutes, meet_url=ev["meet_url"],
                                            event_id=ev["event_id"], cancelled=False, created_by=me["id"], synced=_now(), created=_now()))
        _tell_class(c, cid, "class_session", exclude=me["id"], session=sid, title=body.title.strip(), start=_iso(start))
        s = dict(c.execute(select(sessions_t).where(sessions_t.c.id == sid)).mappings().first())
    return {"session": _session_json(s), "calendar": bool(ev["event_id"])}


def _sync(cid: str) -> None:
    """Brings back changes made in Google Calendar (moved, renamed, cancelled), at most once a minute a session."""
    import google_link as G
    with engine().connect() as c:
        rows = [dict(r) for r in c.execute(select(sessions_t).where(sessions_t.c.class_id == cid, sessions_t.c.event_id != "", sessions_t.c.cancelled.is_(False),
                                                                     sessions_t.c.start > _now() - DAY)).mappings().all()]
    for s in rows:
        if s["synced"] and _now() - s["synced"] < 60 or not G.has(s["created_by"], "calendar"):
            continue
        try:
            ev = G.calendar_get(s["created_by"], s["event_id"])
        except HTTPException:
            continue
        vals = {"synced": _now()}
        if ev is None or ev["cancelled"]:
            vals["cancelled"] = True
        else:
            if ev["start"]:
                vals["start"] = ev["start"]
            if ev["minutes"]:
                vals["minutes"] = ev["minutes"]
            if ev["meet_url"]:
                vals["meet_url"] = ev["meet_url"]
        with engine().begin() as c:
            c.execute(update(sessions_t).where(sessions_t.c.id == s["id"]).values(**vals))


@router.get("/classes/{cid}/sessions")
def list_sessions(cid: str, me: dict = Depends(current_user)):
    with engine().connect() as c:
        _require(c, cid, me["id"])
    _sync(cid)
    with engine().connect() as c:
        rows = c.execute(select(sessions_t).where(sessions_t.c.class_id == cid, sessions_t.c.start > _now() - DAY).order_by(sessions_t.c.start)).mappings().all()
    return {"sessions": [_session_json(dict(r)) for r in rows]}


class SessionEdit(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=160)
    start: str | None = Field(None, max_length=40)
    minutes: int | None = Field(None, ge=10, le=600)
    cancel: bool = False


@router.patch("/sessions/{sid}")
def edit_session(sid: str, body: SessionEdit, me: dict = Depends(current_user)):
    import google_link as G
    with engine().connect() as c:
        s = c.execute(select(sessions_t).where(sessions_t.c.id == sid)).mappings().first()
        if s is None:
            raise HTTPException(404, "Session not found.")
        _require(c, s["class_id"], me["id"], "teacher")
    start = _parse_iso(body.start) if body.start else None
    if s["event_id"] and G.has(s["created_by"], "calendar"):
        G.calendar_update(s["created_by"], s["event_id"], title=body.title, start=start, minutes=body.minutes or s["minutes"], cancel=body.cancel)
    vals = {k: v for k, v in {"title": body.title, "start": start, "minutes": body.minutes}.items() if v is not None}
    if body.cancel:
        vals["cancelled"] = True
    with engine().begin() as c:
        if vals:
            c.execute(update(sessions_t).where(sessions_t.c.id == sid).values(**vals, synced=_now()))
        s2 = dict(c.execute(select(sessions_t).where(sessions_t.c.id == sid)).mappings().first())
        if body.cancel or start:
            _tell_class(c, s["class_id"], "class_session_changed", exclude=me["id"], session=sid, cancelled=body.cancel)
    return {"session": _session_json(s2)}


def ics_text(cal_name: str, items: list[dict]) -> str:
    """An iCalendar file (RFC 5545) with each session and a reminder 30 minutes before."""
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    fmt = lambda t: time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(t))  # noqa: E731
    esc = lambda x: str(x).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")  # noqa: E731
    out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Melovyn//Classes//EN", "CALSCALE:GREGORIAN", f"X-WR-CALNAME:{esc(cal_name)}"]
    for s in items:
        out += ["BEGIN:VEVENT", f"UID:{s['id']}@melovyn", f"DTSTAMP:{stamp}", f"DTSTART:{fmt(s['start'])}", f"DTEND:{fmt(s['start'] + s['minutes'] * 60)}",
                f"SUMMARY:{esc(s['title'])}", *( [f"URL:{s['meet_url']}", f"LOCATION:{esc(s['meet_url'])}"] if s.get("meet_url") else []),
                *(["STATUS:CANCELLED"] if s.get("cancelled") else []),
                "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Class soon", "TRIGGER:-PT30M", "END:VALARM", "END:VEVENT"]
    out.append("END:VCALENDAR")
    return "\r\n".join(out) + "\r\n"


@router.get("/classes/{cid}/sessions.ics")
def sessions_ics(cid: str, me: dict = Depends(current_user)):
    with engine().connect() as c:
        _require(c, cid, me["id"])
        name = c.execute(select(classes.c.name).where(classes.c.id == cid)).scalar() or "Class"
        rows = [dict(r) for r in c.execute(select(sessions_t).where(sessions_t.c.class_id == cid).order_by(sessions_t.c.start)).mappings().all()]
    items = [{**r, "title": f"{name}: {r['title']}"} for r in rows]
    return Response(content=ics_text(name, items), media_type="text/calendar; charset=utf-8", headers={"Content-Disposition": 'attachment; filename="class.ics"'})
