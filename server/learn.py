"""Learn, grown up (Part 2 C): what a music class needs beyond Stream / Classwork / People / Grades.

  Kinds        an assignment is Play Along (the default) or record a take, a theory question, compose, or listen
               and answer; the kinds that aren't Play Along are turned in with text and/or a link (turn_in).
  My work      To do · Done · Missing across all your classes (/academy/me/work).
  Path         a class's topics in order with each assignment's place for you: done, now, next, later.
  Teacher      every class at a glance: takes to review, students quiet for a week, work missing; a nudge to the
               quiet ones (at most one a day each).
  Private      a private comment thread between one student and the teacher on one assignment.
  Guardians    a parent or guardian gets a weekly summary (minutes, takes, done / missing, the teacher's last words)
               by email when SMTP is set up, and a private link that shows the same page without an account.
  Drive        the class's Google Drive folder (a link the teacher pastes), shown in Classwork.
  Roster       paste or upload a list (a Google Classroom / school export: name, email) to invite everyone.
"""
from __future__ import annotations

import csv
import io
import os
import re
import secrets
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import Column, Float, String, Table, Text, delete, func, insert, select, update

import accounts as A
from academy import (DAY, _assignment_json, _assignment_status, _iso, _membership, _now, _require, assignments, classes, current_user,
                     engine, feedback, members, meta, submissions, takes, users)
import classroom as CR

router = APIRouter(prefix="/academy", tags=["learn"])

private_notes = Table("assignment_private", meta,
                      Column("id", String(36), primary_key=True),
                      Column("assignment_id", String(36), nullable=False, index=True),
                      Column("student_id", String(36), nullable=False, index=True),
                      Column("author_id", String(36), nullable=False),
                      Column("text", Text, nullable=False),
                      Column("created", Float, nullable=False))
guardians = Table("guardians", meta,
                  Column("id", String(36), primary_key=True),
                  Column("student_id", String(36), nullable=False, index=True),
                  Column("email", String(200), nullable=False),
                  Column("name", String(80), nullable=False, default=""),
                  Column("token", String(64), nullable=False, unique=True),
                  Column("added_by", String(36), nullable=False),
                  Column("last_sent", Float, nullable=True),
                  Column("created", Float, nullable=False))
nudges = Table("class_nudges", meta,
               Column("class_id", String(36), primary_key=True),
               Column("user_id", String(36), primary_key=True),
               Column("sent", Float, nullable=False))
class_drive = Table("class_drive", meta,
                    Column("class_id", String(36), primary_key=True),
                    Column("url", String(400), nullable=False),
                    Column("updated", Float, nullable=False))

QUIET_DAYS = 7
NUDGE_GAP = 20 * 3600
MAX_GUARDIANS = 3
DRIVE_RE = re.compile(r"^https://(drive|docs)\.google\.com/[\w\-./?=&%#]+$")


def _kinds(c, ids: list[str]) -> dict:
    if not ids:
        return {}
    return {r[0]: {"kind": r[1] or "play", "prompt": r[2] or ""} for r in c.execute(
        select(CR.asg_meta.c.assignment_id, CR.asg_meta.c.kind, CR.asg_meta.c.prompt).where(CR.asg_meta.c.assignment_id.in_(ids))).all()}


def _work_for(c, uid: str, class_ids: list[str] | None = None) -> dict:
    """To do · Done · Missing for one student (all their classes, or the given ones)."""
    now = _now()
    q = select(members.c.class_id).where(members.c.user_id == uid, members.c.role == "student")
    cids = [r[0] for r in c.execute(q).all()]
    if class_ids is not None:
        cids = [x for x in cids if x in class_ids]
    if not cids:
        return {"todo": [], "done": [], "missing": []}
    names = {r[0]: r[1] for r in c.execute(select(classes.c.id, classes.c.name).where(classes.c.id.in_(cids))).all()}
    asg = [dict(a) for a in c.execute(select(assignments).where(assignments.c.class_id.in_(cids), assignments.c.opens_at <= now)
                                      .order_by(assignments.c.due_at)).mappings().all()]
    ids = [a["id"] for a in asg]
    mine: dict = {}
    for r in c.execute(select(submissions.c.assignment_id, submissions.c.accuracy).where(submissions.c.user_id == uid,
                                                                                         submissions.c.assignment_id.in_(ids or ["-"]))).all():
        mine.setdefault(r[0], []).append({"accuracy": r[1]})
    kinds = _kinds(c, ids)
    out = {"todo": [], "done": [], "missing": []}
    for a in asg:
        st = _assignment_status(a, mine.get(a["id"], []), now)
        k = kinds.get(a["id"], {"kind": "play", "prompt": ""})
        item = {**_assignment_json(a), **k, "status": st, "class_name": names.get(a["class_id"], ""),
                "best": round(max(s["accuracy"] for s in mine[a["id"]]) * 100) if a["id"] in mine and k["kind"] == "play" else None}
        out["done" if st == "done" else "missing" if st == "late" else "todo"].append(item)
    out["done"].sort(key=lambda x: x["due_at"], reverse=True)
    return out


def _last_active(c, uids: list[str]) -> dict:
    """The last time each person practised (a hand-in or a shared take)."""
    out: dict = {}
    for t in (submissions, takes):
        for r in c.execute(select(t.c.user_id, func.max(t.c.created)).where(t.c.user_id.in_(uids or ["-"])).group_by(t.c.user_id)).all():
            out[r[0]] = max(out.get(r[0], 0), r[1] or 0)
    return out


# -------------------------------------------------------------------------------------------- my work, turning in
@router.get("/me/work")
def my_work(me: dict = Depends(current_user)):
    with engine().connect() as c:
        return _work_for(c, me["id"])


class TurnInIn(BaseModel):
    text: str = Field("", max_length=4000)
    link: str = Field("", max_length=400, pattern=r"^(https://\S+)?$")


@router.post("/assignments/{aid}/turn-in")
def turn_in(aid: str, body: TurnInIn, me: dict = Depends(current_user)):
    """Hands in an assignment that isn't Play Along (a recording link, a theory answer, a composition)."""
    if not body.text.strip() and not body.link:
        raise HTTPException(400, "Write your answer or add a link.")
    now = _now()
    with engine().begin() as c:
        a = c.execute(select(assignments).where(assignments.c.id == aid)).mappings().first()
        if a is None:
            raise HTTPException(404, "Assignment not found.")
        _require(c, a["class_id"], me["id"], "student")
        if _kinds(c, [aid]).get(aid, {}).get("kind", "play") == "play":
            raise HTTPException(400, "This one is handed in with Play Along.")
        if now < a["opens_at"]:
            raise HTTPException(409, "This assignment isn't open yet.")
        note = (body.text.strip() + ("\n" + body.link if body.link else "")).strip()[:4000]
        sid = str(uuid.uuid4())
        c.execute(insert(submissions).values(id=sid, assignment_id=aid, user_id=me["id"], accuracy=1.0, seconds=0, mode="turnin", note=note,
                                             late=now > a["due_at"], created=now))
        teacher = c.execute(select(members.c.user_id).where(members.c.class_id == a["class_id"], members.c.role == "teacher")).scalars().all()
        for t in teacher:
            A.notify(c, t, "class_turned_in", class_id=a["class_id"], assignment=aid, title=a["title"], student=me["name"])
    return {"id": sid, "status": "done"}


# -------------------------------------------------------------------------------------------- path
@router.get("/classes/{cid}/path")
def path(cid: str, me: dict = Depends(current_user)):
    """The class's topics in order, each with its assignments; for a student each one's place on the way
    (done · now · next · later · missing), for a teacher how many students have done it."""
    now = _now()
    with engine().connect() as c:
        role = _require(c, cid, me["id"])
        tps = [dict(t) for t in c.execute(select(CR.topics).where(CR.topics.c.class_id == cid).order_by(CR.topics.c.position, CR.topics.c.name)).mappings().all()]
        asg = [dict(a) for a in c.execute(select(assignments).where(assignments.c.class_id == cid).order_by(assignments.c.opens_at, assignments.c.due_at)).mappings().all()]
        if role != "teacher":
            asg = [a for a in asg if a["opens_at"] <= now]
        ids = [a["id"] for a in asg]
        topic_of = {r[0]: r[1] for r in c.execute(select(CR.asg_meta.c.assignment_id, CR.asg_meta.c.topic_id).where(CR.asg_meta.c.assignment_id.in_(ids or ["-"]))).all()}
        kinds = _kinds(c, ids)
        if role == "teacher":
            n = c.execute(select(func.count()).select_from(members).where(members.c.class_id == cid, members.c.role == "student")).scalar() or 0
            done = {}
            goal = {a["id"]: a["goal"] for a in asg}
            for r in c.execute(select(submissions.c.assignment_id, submissions.c.user_id, func.max(submissions.c.accuracy))
                               .where(submissions.c.assignment_id.in_(ids or ["-"])).group_by(submissions.c.assignment_id, submissions.c.user_id)).all():
                if r[2] * 100 >= goal[r[0]]:
                    done[r[0]] = done.get(r[0], 0) + 1
            state = {aid: {"done": done.get(aid, 0), "of": n} for aid in ids}
        else:
            mine: dict = {}
            for r in c.execute(select(submissions.c.assignment_id, submissions.c.accuracy).where(submissions.c.user_id == me["id"], submissions.c.assignment_id.in_(ids or ["-"]))).all():
                mine.setdefault(r[0], []).append({"accuracy": r[1]})
            state, seen_now = {}, False
            for a in asg:
                st = _assignment_status(a, mine.get(a["id"], []), now)
                if st == "done":
                    place = "done"
                elif st == "late":
                    place = "missing"
                elif not seen_now:
                    place, seen_now = "now", True
                else:
                    place = "next" if all(v["place"] != "next" for v in state.values()) else "later"
                state[a["id"]] = {"place": place, "status": st, "best": round(max(s["accuracy"] for s in mine[a["id"]]) * 100) if a["id"] in mine else None}
    def row(a):
        k = kinds.get(a["id"], {"kind": "play", "prompt": ""})
        st = dict(state.get(a["id"], {}))
        if k["kind"] != "play" and "best" in st:
            st["best"] = None                                  # a turned-in answer has no score
        return {"id": a["id"], "title": a["title"], "piece_title": a["piece_title"], "due_at": _iso(a["due_at"]), **k, **st}
    groups = [{"id": t["id"], "name": t["name"], "assignments": [row(a) for a in asg if topic_of.get(a["id"]) == t["id"]]} for t in tps]
    loose = [row(a) for a in asg if topic_of.get(a["id"]) not in {t["id"] for t in tps}]
    if loose:
        groups.append({"id": None, "name": "", "assignments": loose})
    total = len(asg)
    done_n = sum(1 for v in state.values() if v.get("place") == "done") if role != "teacher" else None
    return {"role": role, "topics": [g for g in groups if g["assignments"]], "total": total, "done": done_n, "drive_url": drive_url(cid)}


# -------------------------------------------------------------------------------------------- teacher at a glance
def _overview(c, cid: str) -> dict:
    now = _now()
    sts = CR._people(c, cid, "student")
    ids = [s["id"] for s in sts]
    last = _last_active(c, ids)
    joined = {s["id"]: s["joined"] for s in sts}
    quiet = sorted([{"id": s["id"], "name": s["name"], "days": int((now - (last.get(s["id"]) or joined[s["id"]] or now)) // DAY)}
                    for s in sts if (last.get(s["id"]) or 0) < now - QUIET_DAYS * DAY and (joined[s["id"]] or now) < now - 2 * DAY],
                   key=lambda x: -x["days"])
    asg_ids = [r[0] for r in c.execute(select(assignments.c.id).where(assignments.c.class_id == cid)).all()]
    sub_ids = [r[0] for r in c.execute(select(submissions.c.id).where(submissions.c.assignment_id.in_(asg_ids or ["-"]))).all()]
    reviewed = {r[0] for r in c.execute(select(feedback.c.submission_id).where(feedback.c.submission_id.in_(sub_ids or ["-"]))).all()}
    to_review = len([x for x in sub_ids if x not in reviewed])         # the same count as the class card (academy.py)
    missing = []
    for s in sts:
        n = len(_work_for(c, s["id"], [cid])["missing"])
        if n:
            missing.append({"id": s["id"], "name": s["name"], "n": n})
    nudged = {r[0]: r[1] for r in c.execute(select(nudges.c.user_id, nudges.c.sent).where(nudges.c.class_id == cid)).all()}
    for q in quiet:
        q["nudged"] = _iso(nudged[q["id"]]) if q["id"] in nudged else None
    return {"students": len(sts), "to_review": to_review, "quiet": quiet, "missing": sorted(missing, key=lambda x: -x["n"])}


@router.get("/teacher/overview")
def teacher_overview(me: dict = Depends(current_user)):
    with engine().connect() as c:
        rows = c.execute(select(classes.c.id, classes.c.name, classes.c.color).join(members, members.c.class_id == classes.c.id)
                         .where(members.c.user_id == me["id"], members.c.role == "teacher", classes.c.archived.is_(False))).mappings().all()
        return {"classes": [{"id": r["id"], "name": r["name"], "color": r["color"], **_overview(c, r["id"])} for r in rows]}


class NudgeIn(BaseModel):
    user_ids: list[str] = Field(..., min_length=1, max_length=200)
    text: str = Field("", max_length=300)


@router.post("/classes/{cid}/nudge")
def nudge(cid: str, body: NudgeIn, me: dict = Depends(current_user)):
    """A friendly reminder to practise, at most one a day for each student."""
    now = _now()
    sent, skipped = 0, 0
    with engine().begin() as c:
        _require(c, cid, me["id"], "teacher")
        name = c.execute(select(classes.c.name).where(classes.c.id == cid)).scalar() or ""
        students = set(c.execute(select(members.c.user_id).where(members.c.class_id == cid, members.c.role == "student")).scalars().all())
        for uid in dict.fromkeys(body.user_ids):
            if uid not in students:
                continue
            last = c.execute(select(nudges.c.sent).where(nudges.c.class_id == cid, nudges.c.user_id == uid)).scalar()
            if last and now - last < NUDGE_GAP:
                skipped += 1
                continue
            A.notify(c, uid, "class_nudge", actor=me["id"], class_id=cid, class_name=name, text=body.text.strip()[:300])
            if last:
                c.execute(update(nudges).where(nudges.c.class_id == cid, nudges.c.user_id == uid).values(sent=now))
            else:
                c.execute(insert(nudges).values(class_id=cid, user_id=uid, sent=now))
            sent += 1
    return {"sent": sent, "skipped": skipped}


# -------------------------------------------------------------------------------------------- private comments
class PrivateIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    student: str | None = None


def _private_scope(c, aid: str, me: dict, student: str | None) -> tuple[dict, str, str]:
    a = c.execute(select(assignments.c.id, assignments.c.class_id, assignments.c.title).where(assignments.c.id == aid)).mappings().first()
    if a is None:
        raise HTTPException(404, "Assignment not found.")
    role = _require(c, a["class_id"], me["id"])
    if role == "teacher":
        if not student or _membership(c, a["class_id"], student) != "student":
            raise HTTPException(400, "Choose the student.")
        return dict(a), role, student
    return dict(a), role, me["id"]


@router.get("/assignments/{aid}/private")
def private_thread(aid: str, student: str | None = None, me: dict = Depends(current_user)):
    with engine().connect() as c:
        a, role, sid = _private_scope(c, aid, me, student)
        rows = c.execute(select(private_notes).where(private_notes.c.assignment_id == aid, private_notes.c.student_id == sid)
                         .order_by(private_notes.c.created)).mappings().all()
        names = CR._name_map(c, [r["author_id"] for r in rows])
    return {"items": [{"id": r["id"], "text": r["text"], "at": _iso(r["created"]), "mine": r["author_id"] == me["id"], "author": names.get(r["author_id"])}
                      for r in rows]}


@router.post("/assignments/{aid}/private")
def private_post(aid: str, body: PrivateIn, me: dict = Depends(current_user)):
    with engine().begin() as c:
        a, role, sid = _private_scope(c, aid, me, body.student)
        if c.execute(select(func.count()).select_from(private_notes).where(private_notes.c.assignment_id == aid, private_notes.c.student_id == sid)).scalar() >= 200:
            raise HTTPException(409, "This conversation is full.")
        nid = str(uuid.uuid4())
        c.execute(insert(private_notes).values(id=nid, assignment_id=aid, student_id=sid, author_id=me["id"], text=body.text.strip(), created=_now()))
        to = [sid] if role == "teacher" else c.execute(select(members.c.user_id).where(members.c.class_id == a["class_id"], members.c.role == "teacher")).scalars().all()
        for uid in to:
            A.notify(c, uid, "class_private", class_id=a["class_id"], assignment=aid, title=a["title"], name=me["name"], student=sid)
    return {"id": nid}


# -------------------------------------------------------------------------------------------- guardians
def guardian_summary(c, student_id: str, days: int = 7) -> dict:
    """What a parent sees each week: practice, assignments done / missing / to do, the teacher's latest words."""
    now = _now()
    since = now - days * DAY
    u = c.execute(select(users.c.name).where(users.c.id == student_id)).scalar() or ""
    secs, n, best = 0, 0, None
    for t in (submissions, takes):
        for r in c.execute(select(t.c.seconds, t.c.accuracy, t.c.mode).where(t.c.user_id == student_id, t.c.created >= since)).all():
            if r[2] == "turnin":
                continue
            secs += r[0] or 0
            n += 1
            best = max(best or 0, r[1])
    work = _work_for(c, student_id)
    recent_done = [x for x in work["done"] if x["due_at"] and x["due_at"] >= _iso(since)]
    sub_ids = [r[0] for r in c.execute(select(submissions.c.id).where(submissions.c.user_id == student_id)).all()]
    notes = [dict(r) for r in c.execute(select(feedback.c.text, feedback.c.created).where(feedback.c.submission_id.in_(sub_ids or ["-"]), feedback.c.text != "")
                                        .order_by(feedback.c.created.desc()).limit(3)).mappings().all()]
    cls = [r[0] for r in c.execute(select(classes.c.name).join(members, members.c.class_id == classes.c.id).where(members.c.user_id == student_id, members.c.role == "student")).all()]
    return {"student": u, "classes": cls, "days": days, "minutes": round(secs / 60), "takes": n, "best": round(best * 100) if best is not None else None,
            "done": [{"title": x["title"], "class": x["class_name"], "best": x["best"]} for x in recent_done[:8]],
            "missing": [{"title": x["title"], "class": x["class_name"], "due_at": x["due_at"]} for x in work["missing"][:8]],
            "todo": [{"title": x["title"], "class": x["class_name"], "due_at": x["due_at"]} for x in work["todo"][:8]],
            "teacher_notes": [{"text": x["text"][:400], "at": _iso(x["created"])} for x in notes]}


def summary_text(s: dict, link: str) -> str:
    lines = [f"{s['student']}'s week on Melovyn" + (f" ({', '.join(s['classes'])})" if s["classes"] else ""), "",
             f"Practice: {s['minutes']} min, {s['takes']} take{'s' if s['takes'] != 1 else ''}" + (f", best {s['best']}%" if s["best"] is not None else "")]
    if s["done"]:
        lines += ["", "Done:"] + [f"  - {x['title']} ({x['class']})" + (f" {x['best']}%" if x["best"] is not None else "") for x in s["done"]]
    if s["missing"]:
        lines += ["", "Missing:"] + [f"  - {x['title']} ({x['class']}), was due {x['due_at'][:10]}" for x in s["missing"]]
    if s["todo"]:
        lines += ["", "Coming up:"] + [f"  - {x['title']} ({x['class']}), due {x['due_at'][:10]}" for x in s["todo"]]
    if s["teacher_notes"]:
        lines += ["", "From the teacher:"] + [f"  \"{x['text']}\"" for x in s["teacher_notes"]]
    lines += ["", f"See it any time: {link}", "", "You get this because a teacher or your child added your email in Melovyn. Reply STOP to be removed."]
    return "\n".join(lines)


class GuardianIn(BaseModel):
    email: str = Field(..., min_length=5, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    name: str = Field("", max_length=80)


def _guardian_json(g: dict) -> dict:
    site = os.environ.get("HAPTUNE_SITE_URL", "https://haptune.name.my").rstrip("/")
    return {"id": g["id"], "email": g["email"], "name": g["name"], "link": f"{site}/app/#guardian/{g['token']}", "last_sent": _iso(g["last_sent"]) if g["last_sent"] else None}


def _add_guardian(c, student: str, body: GuardianIn, by: str) -> dict:
    if c.execute(select(func.count()).select_from(guardians).where(guardians.c.student_id == student)).scalar() >= MAX_GUARDIANS:
        raise HTTPException(409, f"Up to {MAX_GUARDIANS} parents or guardians.")
    email = body.email.strip().lower()
    have = c.execute(select(guardians).where(guardians.c.student_id == student, guardians.c.email == email)).mappings().first()
    if have:
        return _guardian_json(dict(have))
    g = {"id": str(uuid.uuid4()), "student_id": student, "email": email, "name": body.name.strip(), "token": secrets.token_urlsafe(24),
         "added_by": by, "last_sent": None, "created": _now()}
    c.execute(insert(guardians).values(**g))
    return _guardian_json(g)


@router.get("/me/guardians")
def my_guardians(me: dict = Depends(current_user)):
    with engine().connect() as c:
        return {"items": [_guardian_json(dict(g)) for g in c.execute(select(guardians).where(guardians.c.student_id == me["id"])).mappings().all()]}


@router.post("/me/guardians")
def add_my_guardian(body: GuardianIn, me: dict = Depends(current_user)):
    with engine().begin() as c:
        return _add_guardian(c, me["id"], body, me["id"])


@router.delete("/me/guardians/{gid}")
def remove_my_guardian(gid: str, me: dict = Depends(current_user)):
    with engine().begin() as c:
        n = c.execute(delete(guardians).where(guardians.c.id == gid, guardians.c.student_id == me["id"])).rowcount
    if not n:
        raise HTTPException(404, "Not found.")
    return {"ok": True}


@router.get("/classes/{cid}/students/{uid}/guardians")
def student_guardians(cid: str, uid: str, me: dict = Depends(current_user)):
    with engine().connect() as c:
        _require(c, cid, me["id"], "teacher")
        if _membership(c, cid, uid) != "student":
            raise HTTPException(404, "Student not found.")
        return {"items": [_guardian_json(dict(g)) for g in c.execute(select(guardians).where(guardians.c.student_id == uid)).mappings().all()]}


@router.post("/classes/{cid}/students/{uid}/guardians")
def add_student_guardian(cid: str, uid: str, body: GuardianIn, me: dict = Depends(current_user)):
    with engine().begin() as c:
        _require(c, cid, me["id"], "teacher")
        if _membership(c, cid, uid) != "student":
            raise HTTPException(404, "Student not found.")
        return _add_guardian(c, uid, body, me["id"])


@router.post("/classes/{cid}/guardian-summaries")
def send_summaries(cid: str, me: dict = Depends(current_user)):
    """Sends this week's summary to the parents of every student in the class (email when SMTP is set up)."""
    now = _now()
    with engine().begin() as c:
        _require(c, cid, me["id"], "teacher")
        sts = [s["id"] for s in CR._people(c, cid, "student")]
        gs = [dict(g) for g in c.execute(select(guardians).where(guardians.c.student_id.in_(sts or ["-"]))).mappings().all()]
        emailed = 0
        for g in gs:
            s = guardian_summary(c, g["student_id"])
            emailed += CR.send_email([g["email"]], f"{s['student']}'s week on Melovyn", summary_text(s, _guardian_json(g)["link"]))
            c.execute(update(guardians).where(guardians.c.id == g["id"]).values(last_sent=now))
    return {"students": len(sts), "guardians": len(gs), "emailed": emailed}


@router.get("/guardian/{token}")
def guardian_page(token: str):
    """The page a parent opens from the email: no account needed; the token is the key."""
    if len(token) < 20:
        raise HTTPException(404, "This link isn't valid.")
    with engine().connect() as c:
        g = c.execute(select(guardians).where(guardians.c.token == token)).mappings().first()
        if g is None:
            raise HTTPException(404, "This link isn't valid any more.")
        return {"guardian": g["name"], **guardian_summary(c, g["student_id"])}


# -------------------------------------------------------------------------------------------- Drive folder, roster
def drive_url(cid: str) -> str:
    with engine().connect() as c:
        return c.execute(select(class_drive.c.url).where(class_drive.c.class_id == cid)).scalar() or ""


class DriveIn(BaseModel):
    url: str = Field("", max_length=400)


@router.put("/classes/{cid}/drive")
def set_drive(cid: str, body: DriveIn, me: dict = Depends(current_user)):
    url = body.url.strip()
    if url and not DRIVE_RE.match(url):
        raise HTTPException(400, "Paste the link of a Google Drive folder (https://drive.google.com/...).")
    with engine().begin() as c:
        _require(c, cid, me["id"], "teacher")
        c.execute(delete(class_drive).where(class_drive.c.class_id == cid))
        if url:
            c.execute(insert(class_drive).values(class_id=cid, url=url, updated=_now()))
    return {"url": url}


EMAIL_RE = re.compile(r"[^@\s,;<>\"']+@[^@\s,;<>\"']+\.[A-Za-z]{2,}")


def parse_roster(text: str) -> list[dict]:
    """People from a pasted list or a CSV export (Google Classroom, a school system): any row with an email; a
    name from a "name" / "first name" + "last name" column, or the text before the email."""
    text = (text or "")[:200_000]
    rows = list(csv.reader(io.StringIO(text)))
    out, seen = [], set()
    head = [h.strip().lower() for h in rows[0]] if rows and not any(EMAIL_RE.search(x) for x in rows[0]) else None
    for r in rows[1:] if head else rows:
        line = ",".join(r)
        found = list(EMAIL_RE.finditer(line))
        prev = 0
        for i, m in enumerate(found):
            email = m.group(0).lower()
            name = ""
            if head and i == 0:
                col = {h: (r[k].strip() if k < len(r) else "") for k, h in enumerate(head)}
                name = col.get("name") or col.get("full name") or " ".join(x for x in (col.get("first name", ""), col.get("last name", "")) if x)
            if not name and not head:
                name = re.sub(r"[<>\"',;]", " ", line[prev:m.start()]).strip()
            prev = m.end()
            if email not in seen:
                seen.add(email)
                out.append({"email": email, "name": name[:80]})
    return out[:300]


class RosterIn(BaseModel):
    text: str = Field(..., min_length=3, max_length=200_000)


@router.post("/classes/{cid}/roster")
def import_roster(cid: str, body: RosterIn, me: dict = Depends(current_user)):
    people = parse_roster(body.text)
    if not people:
        raise HTTPException(400, "No email addresses found in that list.")
    res = {"found": len(people), "invited": 0, "on_melovyn": 0, "emailed": 0}
    for i in range(0, len(people), 50):
        r = CR.invite(cid, CR.InviteIn(emails=[p["email"] for p in people[i:i + 50]]), me)
        for k in ("invited", "on_melovyn", "emailed"):
            res[k] += r[k]
        res["link"] = r["link"]
    res["people"] = people[:50]
    return res
