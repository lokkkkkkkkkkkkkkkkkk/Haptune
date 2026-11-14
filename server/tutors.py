"""Find a tutor: teachers make a profile and pay a small one-time verification fee; students search for free,
ask for a lesson, the teacher accepts (and may suggest another time), and the student confirms. Lessons can be
online (a private video room is made when the lesson is confirmed) or in person, at a fixed weekly time or
whenever suits. After a lesson the student rates the teacher with stars.

Melovyn introduces the two and keeps the schedule; the lesson fee itself is agreed and paid between them.

A profile is listed once it is paid for AND the developer has looked at it (Developer panel > Tutors), so
"verified" means a person checked it.
"""
from __future__ import annotations

import secrets
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import JSON, Boolean, Column, Float, Integer, String, Table, Text, and_, cast, func, insert, or_, select, update

import accounts as A
import billing
import community as CM
from academy import _iso, _now, engine, meta

router = APIRouter(prefix="/c", tags=["tutors"])

tutors = Table("tutors", meta,
               Column("user_id", String(36), primary_key=True),
               Column("headline", String(120), nullable=False, default=""),
               Column("bio", Text, nullable=False, default=""),
               Column("instruments", JSON, nullable=True),
               Column("levels", JSON, nullable=True),                    # beginner | intermediate | advanced
               Column("languages", JSON, nullable=True),
               Column("city", String(80), nullable=False, default=""),
               Column("online", Boolean, nullable=False, default=True),
               Column("in_person", Boolean, nullable=False, default=False),
               Column("rate", String(60), nullable=False, default=""),   # shown as written, e.g. "RM 60 an hour"
               Column("times", String(300), nullable=False, default=""),  # when they usually teach, in their words
               Column("status", String(10), nullable=False, default="draft"),  # draft | pending | verified | paused | rejected
               Column("paid", Boolean, nullable=False, default=False),
               Column("paid_ref", String(60), nullable=False, default=""),
               Column("admin_note", String(300), nullable=False, default=""),
               Column("rating_sum", Integer, nullable=False, default=0),
               Column("rating_n", Integer, nullable=False, default=0),
               Column("lessons_done", Integer, nullable=False, default=0),
               Column("created", Float, nullable=False),
               Column("updated", Float, nullable=False))
lessons = Table("lessons", meta,
                Column("id", String(16), primary_key=True),
                Column("tutor_id", String(36), nullable=False, index=True),
                Column("student_id", String(36), nullable=False, index=True),
                Column("kind", String(10), nullable=False, default="online"),       # online | in_person
                Column("instrument", String(24), nullable=False, default=""),
                Column("at", Float, nullable=True),                                 # when (None = "whenever suits": the teacher proposes)
                Column("weekly", Boolean, nullable=False, default=False),           # the same time every week
                Column("minutes", Integer, nullable=False, default=45),
                Column("message", String(600), nullable=False, default=""),
                Column("reply", String(600), nullable=False, default=""),
                Column("status", String(10), nullable=False, default="requested"),  # requested | accepted | confirmed | done | declined | cancelled
                Column("room", String(120), nullable=False, default=""),
                Column("rating", Integer, nullable=True),
                Column("review", String(600), nullable=False, default=""),
                Column("created", Float, nullable=False),
                Column("updated", Float, nullable=False))

LEVELS = {"beginner", "intermediate", "advanced"}


def _mark_paid(uid: str, ref: str) -> None:
    """Called by billing when the verification fee arrives (Stripe or an approved transfer)."""
    with engine().begin() as c:
        row = c.execute(select(tutors).where(tutors.c.user_id == uid)).mappings().first()
        if row is None:
            c.execute(insert(tutors).values(user_id=uid, paid=True, paid_ref=ref[:60], status="draft", created=_now(), updated=_now()))
            return
        status = "pending" if row["status"] in ("draft", "rejected") and row["headline"] and row["bio"] else row["status"]
        c.execute(update(tutors).where(tutors.c.user_id == uid).values(paid=True, paid_ref=ref[:60], status=status, updated=_now()))


billing.PAID_HOOKS["teacher"] = _mark_paid


def _tutor_json(t: dict, person: dict | None, full: bool = False) -> dict:
    n = t["rating_n"]
    out = {"user": person, "headline": t["headline"], "instruments": t["instruments"] or [], "levels": t["levels"] or [],
           "languages": t["languages"] or [], "city": t["city"], "online": t["online"], "in_person": t["in_person"], "rate": t["rate"],
           "rating": round(t["rating_sum"] / n, 2) if n else None, "ratings": n, "lessons": t["lessons_done"], "verified": t["status"] == "verified"}
    if full:
        out.update(bio=t["bio"], times=t["times"])
    return out


@router.get("/tutors")
def list_tutors(instrument: str = "", online: bool = False, in_person: bool = False, q: str = "", me: A.Me | None = Depends(A.optional)):
    cond = [tutors.c.status == "verified"]
    if instrument:
        cond.append(cast(tutors.c.instruments, String).like(f'%"{instrument[:24]}"%'))
    if online:
        cond.append(tutors.c.online.is_(True))
    if in_person:
        cond.append(tutors.c.in_person.is_(True))
    if q.strip():
        like = f"%{q.strip()[:40]}%"
        cond.append(or_(tutors.c.headline.ilike(like), tutors.c.city.ilike(like), tutors.c.bio.ilike(like)))
    with engine().connect() as c:
        rows = c.execute(select(tutors).where(and_(*cond)).order_by(
            (tutors.c.rating_sum * 1.0 / func.max(tutors.c.rating_n, 1)).desc(), tutors.c.lessons_done.desc(), tutors.c.created).limit(60)).mappings().all()
        people = CM._people(c, [r["user_id"] for r in rows])
    return {"items": [_tutor_json(dict(r), people.get(r["user_id"])) for r in rows], "fee": billing.TEACHER_FEE}


@router.get("/tutors/{handle}")
def get_tutor(handle: str, me: A.Me | None = Depends(A.optional)):
    with engine().connect() as c:
        user, _acc = CM._user_by_handle(c, handle)
        t = c.execute(select(tutors).where(tutors.c.user_id == user["id"])).mappings().first()
        if not t or (t["status"] != "verified" and not (me and (me.id == user["id"] or me.is_admin))):
            raise HTTPException(404, "This teacher isn't listed.")
        revs = c.execute(select(lessons).where(lessons.c.tutor_id == user["id"], lessons.c.rating.is_not(None))
                         .order_by(lessons.c.updated.desc()).limit(20)).mappings().all()
        people = CM._people(c, [user["id"]] + [r["student_id"] for r in revs])
    return {**_tutor_json(dict(t), people.get(user["id"]), full=True),
            "reviews": [{"by": people.get(r["student_id"]), "rating": r["rating"], "review": r["review"], "at": _iso(r["updated"])} for r in revs]}


class TutorIn(BaseModel):
    headline: str = Field(..., min_length=4, max_length=120)
    bio: str = Field(..., min_length=20, max_length=2000)
    instruments: list[str] = Field(..., min_length=1, max_length=8)
    levels: list[str] = Field(default_factory=list, max_length=3)
    languages: list[str] = Field(default_factory=list, max_length=6)
    city: str = Field("", max_length=80)
    online: bool = True
    in_person: bool = False
    rate: str = Field("", max_length=60)
    times: str = Field("", max_length=300)


@router.get("/tutor/me")
def my_tutor(me: A.Me = Depends(A.current)):
    with engine().connect() as c:
        t = c.execute(select(tutors).where(tutors.c.user_id == me.id)).mappings().first()
    prof = None
    if t:
        prof = {**_tutor_json(dict(t), A.public_user(me.user, me.acc), full=True), "status": t["status"], "paid": t["paid"], "admin_note": t["admin_note"]}
    return {"profile": prof, "fee": billing.TEACHER_FEE, "stripe": billing.stripe_on()}


@router.put("/tutor/me")
def save_tutor(body: TutorIn, me: A.Me = Depends(A.current)):
    """Saves the teaching profile. Once the fee is paid it goes to the developer to be checked, then it is listed."""
    A.require_registered(me)
    if not (body.online or body.in_person):
        raise HTTPException(400, "Choose online, in person, or both.")
    vals = dict(headline=CM.clean_text(body.headline, 120), bio=CM.clean_text(body.bio, 2000), instruments=[i[:24] for i in body.instruments],
                levels=[x for x in body.levels if x in LEVELS], languages=[x[:20] for x in body.languages], city=CM.clean_text(body.city, 80),
                online=body.online, in_person=body.in_person, rate=CM.clean_text(body.rate, 60), times=CM.clean_text(body.times, 300), updated=_now())
    with engine().begin() as c:
        t = c.execute(select(tutors).where(tutors.c.user_id == me.id)).mappings().first()
        if t is None:
            c.execute(insert(tutors).values(user_id=me.id, status="draft", created=_now(), **vals))
        else:
            status = "pending" if t["paid"] and t["status"] in ("draft", "rejected") else t["status"]
            c.execute(update(tutors).where(tutors.c.user_id == me.id).values(status=status, **vals))
    return my_tutor(me)


# ------------------------------------------------------------------------------------------- lessons
def _lesson_json(l: dict, people: dict, me_id: str) -> dict:
    mine = "teacher" if l["tutor_id"] == me_id else "student"
    return {"id": l["id"], "role": mine, "teacher": people.get(l["tutor_id"]), "student": people.get(l["student_id"]), "kind": l["kind"],
            "instrument": l["instrument"], "at": _iso(l["at"]) if l["at"] else None, "weekly": l["weekly"], "minutes": l["minutes"],
            "message": l["message"], "reply": l["reply"], "status": l["status"], "room": l["room"] if l["status"] in ("confirmed", "done") else "",
            "rating": l["rating"], "review": l["review"], "created": _iso(l["created"])}


class LessonIn(BaseModel):
    tutor: str = Field(..., max_length=24)
    kind: Literal["online", "in_person"] = "online"
    instrument: str = Field("", max_length=24)
    at: float | None = None                    # seconds since 1970; leave out for "whenever suits you"
    weekly: bool = False
    minutes: int = Field(45, ge=15, le=180)
    message: str = Field("", max_length=600)


@router.post("/lessons")
def request_lesson(body: LessonIn, request: Request, me: A.Me = Depends(A.current)):
    A.rate(request, "lesson", 20, 86400)
    with engine().begin() as c:
        user, _acc = CM._user_by_handle(c, body.tutor)
        t = c.execute(select(tutors).where(tutors.c.user_id == user["id"], tutors.c.status == "verified")).mappings().first()
        if not t:
            raise HTTPException(404, "This teacher isn't listed.")
        if user["id"] == me.id:
            raise HTTPException(400, "That's you.")
        if body.kind == "online" and not t["online"] or body.kind == "in_person" and not t["in_person"]:
            raise HTTPException(400, "This teacher doesn't teach that way.")
        if body.at is not None and body.at < _now() + 1800:
            raise HTTPException(400, "Choose a time at least half an hour from now.")
        open_n = c.execute(select(func.count()).select_from(lessons).where(lessons.c.student_id == me.id, lessons.c.tutor_id == user["id"],
                                                                         lessons.c.status.in_(["requested", "accepted"]))).scalar() or 0
        if open_n >= 3:
            raise HTTPException(429, "You already have requests waiting with this teacher.")
        lid = A.new_id()
        c.execute(insert(lessons).values(id=lid, tutor_id=user["id"], student_id=me.id, kind=body.kind, instrument=body.instrument, at=body.at,
                                         weekly=body.weekly, minutes=body.minutes, message=CM.clean_text(body.message, 600), created=_now(), updated=_now()))
        A.notify(c, user["id"], "lesson", actor=me.id, lesson=lid, what="requested")
    return my_lessons(me)


@router.get("/lessons")
def my_lessons(me: A.Me = Depends(A.current)):
    with engine().connect() as c:
        rows = c.execute(select(lessons).where(or_(lessons.c.tutor_id == me.id, lessons.c.student_id == me.id))
                         .order_by(lessons.c.updated.desc()).limit(80)).mappings().all()
        people = CM._people(c, [r["tutor_id"] for r in rows] + [r["student_id"] for r in rows])
    return {"items": [_lesson_json(dict(r), people, me.id) for r in rows]}


class LessonAct(BaseModel):
    action: Literal["accept", "decline", "confirm", "cancel", "done"]
    at: float | None = None
    reply: str = Field("", max_length=600)
    rating: int | None = Field(None, ge=1, le=5)
    review: str = Field("", max_length=600)


@router.post("/lessons/{lid}")
def act_on_lesson(lid: str, body: LessonAct, me: A.Me = Depends(A.current)):
    """requested --teacher accepts (may set the time)--> accepted --student confirms--> confirmed --student--> done (+ stars)."""
    with engine().begin() as c:
        l = c.execute(select(lessons).where(lessons.c.id == lid)).mappings().first()
        if not l or me.id not in (l["tutor_id"], l["student_id"]):
            raise HTTPException(404, "That lesson isn't there.")
        teacher = me.id == l["tutor_id"]
        other = l["student_id"] if teacher else l["tutor_id"]
        vals: dict = {"updated": _now()}
        if body.action == "accept":
            if not teacher or l["status"] != "requested":
                raise HTTPException(400, "Only the teacher can accept a new request.")
            at = body.at if body.at is not None else l["at"]
            if at is None:
                raise HTTPException(400, "Suggest a time for the lesson.")
            vals.update(status="accepted", at=at, reply=CM.clean_text(body.reply, 600))
        elif body.action == "confirm":
            if teacher or l["status"] != "accepted":
                raise HTTPException(400, "The student confirms once the teacher has accepted.")
            vals.update(status="confirmed")
            if l["kind"] == "online":
                vals["room"] = "https://meet.jit.si/Melovyn-" + secrets.token_urlsafe(9)
        elif body.action == "decline":
            if not teacher or l["status"] not in ("requested", "accepted"):
                raise HTTPException(400, "This can't be declined now.")
            vals.update(status="declined", reply=CM.clean_text(body.reply, 600))
        elif body.action == "cancel":
            if l["status"] not in ("requested", "accepted", "confirmed"):
                raise HTTPException(400, "This can't be cancelled now.")
            vals.update(status="cancelled")
        else:  # done
            if teacher or l["status"] != "confirmed":
                raise HTTPException(400, "The student marks a confirmed lesson as done.")
            if l["at"] and l["at"] > _now():
                raise HTTPException(400, "The lesson hasn't happened yet.")
            vals.update(status="done", rating=body.rating, review=CM.clean_text(body.review, 600))
            c.execute(update(tutors).where(tutors.c.user_id == l["tutor_id"]).values(
                lessons_done=tutors.c.lessons_done + 1, rating_sum=tutors.c.rating_sum + (body.rating or 0),
                rating_n=tutors.c.rating_n + (1 if body.rating else 0)))
        c.execute(update(lessons).where(lessons.c.id == lid).values(**vals))
        A.notify(c, other, "lesson", actor=me.id, lesson=lid, what=vals.get("status", body.action))
    return my_lessons(me)


# ------------------------------------------------------------------------------------------- the developer
@router.get("/admin/tutors")
def admin_tutors(me: A.Me = Depends(A.require_admin), status: str = "pending"):
    with engine().connect() as c:
        rows = c.execute(select(tutors).where(tutors.c.status == status).order_by(tutors.c.updated.desc()).limit(100)).mappings().all()
        people = CM._people(c, [r["user_id"] for r in rows])
    return {"items": [{**_tutor_json(dict(r), people.get(r["user_id"]), full=True), "paid": r["paid"], "paid_ref": r["paid_ref"]} for r in rows]}


class TutorDecide(BaseModel):
    action: Literal["verify", "reject", "pause"]
    note: str = Field("", max_length=300)


@router.post("/admin/tutors/{handle}")
def admin_tutor(handle: str, body: TutorDecide, me: A.Me = Depends(A.require_admin)):
    with engine().begin() as c:
        user, _acc = CM._user_by_handle(c, handle)
        t = c.execute(select(tutors).where(tutors.c.user_id == user["id"])).mappings().first()
        if not t:
            raise HTTPException(404, "No teaching profile.")
        status = {"verify": "verified", "reject": "rejected", "pause": "paused"}[body.action]
        c.execute(update(tutors).where(tutors.c.user_id == user["id"]).values(status=status, admin_note=body.note.strip(), updated=_now()))
        A.notify(c, user["id"], "tutor", what=status, note=body.note.strip())
    return {"ok": True}
