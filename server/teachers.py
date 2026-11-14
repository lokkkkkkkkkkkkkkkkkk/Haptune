"""Verified teachers.

Only a verified teacher may run an open (listed) class, be listed as a tutor, or receive the practice reports of
a class bigger than a few students. Anyone signed in may still run a small private class (up to
UNVERIFIED_MAX_STUDENTS students) to try it out with their own students.

Verification needs two things:
  1. an email address the sign-in provider has verified (Google today; the account's `email` is only stored
     when Google says it is verified, see accounts.google_signin), and
  2. a teacher verification request: school or organisation, role, and optionally a document (a staff card or a
     certificate, PDF/JPEG/PNG, up to 3 MB). An email on a music school's domain listed in
     HAPTUNE_TEACHER_DOMAINS (comma-separated, e.g. "musicschool.edu.my,conservatory.org") is approved at once;
     every other request waits for the developer (Developer panel > Teachers). A tutor profile the developer has
     verified (tutors.py) counts too.

Permission matrix (tested in test_teachers.py):
                              guest   signed in   verified teacher   developer
  private class (<= 3 students)  -        yes           yes              yes
  private class (> 3 students)   -        -             yes              yes
  open class                     -        -             yes              yes
  listed as a tutor              -        -             yes (tutors.py)  yes
  class reports                  -     own small class  yes              yes
"""
from __future__ import annotations

import base64
import os

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import Column, Float, LargeBinary, String, Table, Text, func, insert, select, update

import accounts as A
from academy import _iso, _now, classes, engine, members, meta

router = APIRouter(prefix="/c", tags=["teachers"])

UNVERIFIED_MAX_STUDENTS = 3
MAX_DOC = 3 * 1024 * 1024
DOC_TYPES = {"application/pdf": b"%PDF", "image/jpeg": b"\xff\xd8\xff", "image/png": b"\x89PNG"}

verifications = Table("teacher_verifications", meta,
                      Column("user_id", String(36), primary_key=True),
                      Column("org", String(160), nullable=False, default=""),
                      Column("role_text", String(120), nullable=False, default=""),
                      Column("email", String(200), nullable=False, default=""),
                      Column("doc", LargeBinary, nullable=True),
                      Column("doc_type", String(40), nullable=True),
                      Column("status", String(10), nullable=False, default="pending"),   # pending | verified | rejected
                      Column("method", String(10), nullable=False, default=""),          # domain | review | tutor
                      Column("admin_note", String(300), nullable=False, default=""),
                      Column("created", Float, nullable=False),
                      Column("decided", Float, nullable=True))


def allowed_domains() -> set[str]:
    return {d.strip().lower().lstrip("@") for d in os.environ.get("HAPTUNE_TEACHER_DOMAINS", "").split(",") if d.strip()}


def _domain_ok(email: str) -> bool:
    dom = email.rsplit("@", 1)[-1].lower() if "@" in email else ""
    return bool(dom) and any(dom == d or dom.endswith("." + d) for d in allowed_domains())


def is_verified(uid: str, c=None) -> bool:
    """True for a verified teacher (by request, by domain, or a verified tutor) and for the developer."""
    def check(cx) -> bool:
        acc = cx.execute(select(A.accounts).where(A.accounts.c.user_id == uid)).mappings().first()
        if acc and A.effective_tier(dict(acc)) == "dev":
            return True
        if cx.execute(select(verifications.c.status).where(verifications.c.user_id == uid)).scalar() == "verified":
            return True
        try:
            from tutors import tutors as tutor_t
            return cx.execute(select(tutor_t.c.status).where(tutor_t.c.user_id == uid)).scalar() == "verified"
        except Exception:
            return False
    if c is not None:
        return check(c)
    with engine().connect() as cx:
        return check(cx)


def students_in(c, cid: str) -> int:
    return c.execute(select(func.count()).select_from(members).where(members.c.class_id == cid, members.c.role == "student")).scalar() or 0


def require_for_open_class(c, uid: str) -> None:
    if not is_verified(uid, c):
        raise HTTPException(403, {"code": "teacher_unverified", "message": "Only verified teachers can run open classes. Ask to be verified in Me > Teach."})


def check_join(c, cid: str) -> None:
    """A class run by an unverified teacher takes at most a few students."""
    teacher = c.execute(select(classes.c.teacher_id).where(classes.c.id == cid)).scalar()
    if teacher and not is_verified(teacher, c) and students_in(c, cid) >= UNVERIFIED_MAX_STUDENTS:
        raise HTTPException(403, {"code": "class_full_unverified",
                                  "message": f"This class is full ({UNVERIFIED_MAX_STUDENTS} students) until the teacher is verified."})


def check_reports(c, cid: str, uid: str) -> None:
    """Practice reports of a class go to a verified teacher, or to anyone running a small private class."""
    if not is_verified(uid, c) and students_in(c, cid) > UNVERIFIED_MAX_STUDENTS:
        raise HTTPException(403, {"code": "teacher_unverified", "message": "Get verified to see the reports of a bigger class."})


def status_of(uid: str) -> dict:
    with engine().connect() as c:
        row = c.execute(select(verifications).where(verifications.c.user_id == uid)).mappings().first()
        verified = is_verified(uid, c)
    out = {"verified": verified, "status": "verified" if verified else (row["status"] if row else "none"),
           "max_students_unverified": UNVERIFIED_MAX_STUDENTS}
    if row:
        out.update({"org": row["org"], "role_text": row["role_text"], "method": row["method"], "note": row["admin_note"],
                    "has_doc": bool(row["doc_type"]), "created": _iso(row["created"])})
    return out


class VerifyIn(BaseModel):
    org: str = Field(..., min_length=2, max_length=160)
    role_text: str = Field("", max_length=120)
    doc_b64: str | None = Field(None, max_length=MAX_DOC * 2)
    doc_type: str | None = Field(None, max_length=40)


@router.get("/teacher/verify")
def my_verification(me: A.Me = Depends(A.current)):
    return status_of(me.id)


@router.post("/teacher/verify")
def request_verification(body: VerifyIn, me: A.Me = Depends(A.current)):
    A.require_registered(me)
    email = (me.acc.get("email") or "").strip()
    if not me.acc.get("google_sub") or not email:
        raise HTTPException(400, {"code": "verified_email_needed", "message": "Sign in with Google first, so we know your email is really yours."})
    doc = None
    if body.doc_b64:
        if body.doc_type not in DOC_TYPES:
            raise HTTPException(415, "The document must be a PDF, JPEG or PNG.")
        try:
            doc = base64.b64decode(body.doc_b64, validate=True)
        except ValueError:
            raise HTTPException(400, "The document could not be read.")
        if len(doc) > MAX_DOC:
            raise HTTPException(413, "The document is too big (3 MB max).")
        if not doc.startswith(DOC_TYPES[body.doc_type]):
            raise HTTPException(415, "That file is not the kind it says it is.")
    instant = _domain_ok(email)
    vals = dict(org=body.org.strip(), role_text=body.role_text.strip(), email=email, doc=doc, doc_type=body.doc_type if doc else None,
                status="verified" if instant else "pending", method="domain" if instant else "review", admin_note="",
                created=_now(), decided=_now() if instant else None)
    with engine().begin() as c:
        if c.execute(select(verifications.c.user_id).where(verifications.c.user_id == me.id)).first():
            c.execute(update(verifications).where(verifications.c.user_id == me.id).values(**vals))
        else:
            c.execute(insert(verifications).values(user_id=me.id, **vals))
        if instant:
            A.notify(c, me.id, "teacher_verified")
    return status_of(me.id)


class DecideIn(BaseModel):
    decision: str = Field(..., pattern="^(verify|reject)$")
    note: str = Field("", max_length=300)


@router.get("/admin/teachers")
def admin_list(status: str = "pending", me: A.Me = Depends(A.require_admin)):
    with engine().connect() as c:
        rows = c.execute(select(verifications.c.user_id, verifications.c.org, verifications.c.role_text, verifications.c.email,
                                verifications.c.doc_type, verifications.c.status, verifications.c.method, verifications.c.created)
                         .where(verifications.c.status == status).order_by(verifications.c.created)).mappings().all()
        names = {r["id"]: r for r in c.execute(select(A.users.c.id, A.users.c.name).where(A.users.c.id.in_([r["user_id"] for r in rows] or ["-"]))).mappings().all()}
    return {"teachers": [{"user_id": r["user_id"], "name": names.get(r["user_id"], {}).get("name", ""), "org": r["org"], "role_text": r["role_text"],
                          "email": r["email"], "has_doc": bool(r["doc_type"]), "status": r["status"], "method": r["method"],
                          "created": _iso(r["created"])} for r in rows]}


@router.get("/admin/teachers/{uid}/doc")
def admin_doc(uid: str, me: A.Me = Depends(A.require_admin)):
    with engine().connect() as c:
        row = c.execute(select(verifications.c.doc, verifications.c.doc_type).where(verifications.c.user_id == uid)).mappings().first()
    if not row or not row["doc"]:
        raise HTTPException(404, "No document.")
    # never served inline as HTML: a fixed, checked type, and as a download
    return Response(content=row["doc"], media_type=row["doc_type"], headers={"Content-Disposition": "attachment; filename=document", "X-Content-Type-Options": "nosniff"})


@router.post("/admin/teachers/{uid}")
def admin_decide(uid: str, body: DecideIn, me: A.Me = Depends(A.require_admin)):
    with engine().begin() as c:
        if not c.execute(select(verifications.c.user_id).where(verifications.c.user_id == uid)).first():
            raise HTTPException(404, "No request from that person.")
        c.execute(update(verifications).where(verifications.c.user_id == uid).values(
            status="verified" if body.decision == "verify" else "rejected", admin_note=body.note.strip(), decided=_now()))
        A.notify(c, uid, "teacher_verified" if body.decision == "verify" else "teacher_rejected", note=body.note.strip())
    return status_of(uid)
