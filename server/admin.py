"""The Developer-mode dashboard's people side: Users, Access (who are developers) and the Audit log.

Every endpoint needs Developer mode on for this sign-in (accounts.require_scope) and a scope:
  Users (list, profile, plan, suspend, message, export, delete)   manage_users
  Verified teacher on/off                                         verify_teachers
  Access (grant / revoke developers) and Audit                    the owner only
Rules no one can get round from the app: the owner is set only by HAPTUNE_OWNER_EMAILS, so the owner can't be
demoted, suspended or deleted here; only the owner acts on developers; every action and every look at one
person's timeline is written to the append-only audit log.
"""
from __future__ import annotations

import csv
import io
import json

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, insert, or_, select, update

import accounts as A
from academy import _iso, _now, engine, members, takes, users

router = APIRouter(prefix="/c/admin", tags=["admin"])


def _by_handle(c, handle: str) -> tuple[dict, dict]:
    acc = c.execute(select(A.accounts).where(A.accounts.c.handle == handle.lower().lstrip("@"))).mappings().first()
    if not acc:
        raise HTTPException(404, "No one has that username.")
    user = c.execute(select(users).where(users.c.id == acc["user_id"])).mappings().first()
    return dict(user), dict(acc)


def _grant_row(c, uid: str) -> dict | None:
    g = c.execute(select(A.dev_grants).where(A.dev_grants.c.user_id == uid)).mappings().first()
    return dict(g) if g else None


def role_of(c, acc: dict) -> str:
    staff, _ = A.staff_of(acc, _grant_row(c, acc["user_id"]))
    if staff:
        return staff
    import teachers
    return "teacher" if teachers.is_verified(acc["user_id"], c) else "user"


def check_can_act_on(c, me: A.Me, uid: str, acc: dict, *, what: str = "change") -> None:
    staff, _ = A.staff_of(acc, _grant_row(c, uid))
    if staff == "owner" and what in ("change", "delete"):
        raise HTTPException(403, {"code": "owner_protected", "message": "The owner's account can't be changed here."})
    if staff == "developer" and not me.is_owner:
        raise HTTPException(403, {"code": "owner_only", "message": "Only the owner can act on a developer."})


# ----------------------------------------------------------------------------------------- users
@router.get("/users")
def list_users(q: str = "", who: str = "signed_in", limit: int = 50, offset: int = 0, me: A.Me = Depends(A.require_scope("manage_users"))):
    """who: signed_in (Google or password) | all (guests too) | staff | teachers. Newest activity first."""
    import analytics as AN
    import community
    import teachers
    acc, u = A.accounts, users
    cond = []
    if who != "all":
        cond.append(or_(acc.c.google_sub.isnot(None), acc.c.pw_hash.isnot(None)))
    if q.strip():
        like = f"%{q.strip().lower().lstrip('@')[:60]}%"
        cond.append(or_(func.lower(acc.c.handle).like(like), func.lower(u.c.name).like(like), func.lower(func.coalesce(acc.c.email, "")).like(like)))
    with engine().connect() as c:
        if who == "staff":
            cond.append(or_(acc.c.user_id.in_(select(A.dev_grants.c.user_id)), acc.c.role == "admin", acc.c.email.in_(list(A.owner_emails()) or ["-"])))
        if who == "teachers":
            cond.append(acc.c.user_id.in_(select(teachers.verifications.c.user_id).where(teachers.verifications.c.status == "verified")))
        base = select(acc, u.c.name).join(u, u.c.id == acc.c.user_id).where(*cond)
        total = c.execute(select(func.count()).select_from(base.subquery())).scalar()
        rows = [dict(r) for r in c.execute(base.order_by(acc.c.last_seen.desc()).limit(max(1, min(200, limit))).offset(max(0, offset))).mappings().all()]
        ids = [r["user_id"] for r in rows] or ["-"]
        ev = AN.events
        stats = {uid: (n, s or 0) for uid, n, s in c.execute(select(ev.c.user_id, func.count(), func.sum(ev.c.value))
                                                               .where(ev.c.user_id.in_(ids), ev.c.name == "session_end").group_by(ev.c.user_id)).all()}
        pieces = dict(c.execute(select(ev.c.user_id, func.count(func.distinct(ev.c.label))).where(ev.c.user_id.in_(ids), ev.c.name == "piece_open").group_by(ev.c.user_id)).all())
        finished = dict(c.execute(select(ev.c.user_id, func.count()).where(ev.c.user_id.in_(ids), ev.c.name == "play_along_finish").group_by(ev.c.user_id)).all())
        shared = dict(c.execute(select(takes.c.user_id, func.count()).where(takes.c.user_id.in_(ids)).group_by(takes.c.user_id)).all())
        posts = dict(c.execute(select(community.posts.c.user_id, func.count()).where(community.posts.c.user_id.in_(ids)).group_by(community.posts.c.user_id)).all())
        klass = dict(c.execute(select(members.c.user_id, func.count()).where(members.c.user_id.in_(ids)).group_by(members.c.user_id)).all())
        device = {}
        for uid, plat in c.execute(select(ev.c.user_id, ev.c.platform).where(ev.c.user_id.in_(ids), ev.c.platform != "server").order_by(ev.c.ts)).all():
            device[uid] = plat
        roles = {r["user_id"]: role_of(c, r) for r in rows}
        vt = {x for (x,) in c.execute(select(teachers.verifications.c.user_id).where(teachers.verifications.c.user_id.in_(ids), teachers.verifications.c.status == "verified")).all()}
    return {"total": total, "items": [{
        "handle": r["handle"], "name": r["name"], "email": r["email"] or "", "role": roles[r["user_id"]], "verified_teacher": r["user_id"] in vt or roles[r["user_id"]] in ("owner", "developer"),
        "how": "google" if r["google_sub"] else "password" if r["pw_hash"] else "guest", "suspended": r["role"] == "banned",
        "joined": _iso(r["created"]), "seen": _iso(r["last_seen"]),
        "minutes": round((stats.get(r["user_id"], (0, 0))[1]) / 60), "sessions": stats.get(r["user_id"], (0, 0))[0],
        "pieces": pieces.get(r["user_id"], 0), "takes": finished.get(r["user_id"], 0) + shared.get(r["user_id"], 0),
        "posts": posts.get(r["user_id"], 0), "classes": klass.get(r["user_id"], 0),
        "plan": A.effective_tier(r), "until": _iso(r["tier_until"]) if r["tier_until"] else None, "device": device.get(r["user_id"], ""),
    } for r in rows]}


@router.get("/users/{handle}")
def user_profile(handle: str, me: A.Me = Depends(A.require_scope("manage_users"))):
    """One person and their timeline (last 180 days). Looking is itself written to the audit log."""
    import analytics as AN
    import community
    with engine().begin() as c:
        user, acc = _by_handle(c, handle)
        uid = user["id"]
        ev = AN.events
        tl = [dict(r) for r in c.execute(select(ev.c.ts, ev.c.name, ev.c.screen, ev.c.label, ev.c.value, ev.c.platform, ev.c.country, ev.c.props)
                                         .where(ev.c.user_id == uid).order_by(ev.c.ts.desc()).limit(400)).mappings().all()]
        time_by = {s: round((t or 0) / 60, 1) for s, t in c.execute(select(ev.c.screen, func.sum(ev.c.value)).where(ev.c.user_id == uid, ev.c.name == "screen_time").group_by(ev.c.screen)).all()}
        posts = [dict(r) for r in c.execute(select(community.posts.c.id, community.posts.c.type, community.posts.c.title, community.posts.c.hidden, community.posts.c.created)
                                            .where(community.posts.c.user_id == uid).order_by(community.posts.c.created.desc()).limit(50)).mappings().all()]
        reps = community.reports
        reported = [dict(r) for r in c.execute(select(reps.c.reason, reps.c.target, reps.c.status, reps.c.created).where(reps.c.target_user == uid).order_by(reps.c.created.desc()).limit(50)).mappings().all()]
        reporting = int(c.execute(select(func.count()).select_from(reps).where(reps.c.reporter == uid)).scalar())
        g = _grant_row(c, uid)
        role = role_of(c, acc)
        A.audit(c, me, "viewed_user", uid)
    pick = lambda name: [{"t": _iso(r["ts"]), **{k: r[k] for k in ("screen", "label", "value", "platform", "country")}} for r in tl if r["name"] == name]  # noqa: E731
    return {
        "handle": acc["handle"], "name": user["name"], "email": acc["email"] or "", "role": role, "suspended": acc["role"] == "banned",
        "how": "google" if acc["google_sub"] else "password" if acc["pw_hash"] else "guest", "totp": bool(acc.get("totp_on")),
        "plan": A.effective_tier(acc), "until": _iso(acc["tier_until"]) if acc["tier_until"] else None, "joined": _iso(acc["created"]), "seen": _iso(acc["last_seen"]),
        "developer": {"scopes": g["scopes"], "expires": _iso(g["expires"]) if g["expires"] else None, "reason": g["reason"]} if g else None,
        "timeline": [{"t": _iso(r["ts"]), "name": r["name"], "screen": r["screen"], "label": r["label"], "value": r["value"], "platform": r["platform"], "country": r["country"]} for r in tl[:200]],
        "sign_ins": pick("sign_in")[:30], "errors": pick("error")[:30] + pick("server_error")[:10],
        "sound_checks": [{"t": _iso(r["ts"]), "props": r["props"]} for r in tl if r["name"] == "sound_check"][:10],
        "pieces": sorted({r["label"] for r in tl if r["name"] in ("piece_open", "play_along_finish") and r["label"]})[:60],
        "time_by_screen": dict(sorted(time_by.items(), key=lambda x: -x[1])), "posts": [{**p, "created": _iso(p["created"])} for p in posts],
        "reported": [{**r, "created": _iso(r["created"])} for r in reported], "reports_sent": reporting,
    }


class PlanIn(BaseModel):
    tier: str = Field(..., pattern="^(free|plus|pro)$")
    days: int = Field(30, ge=0, le=3650)


@router.post("/users/{handle}/plan")
def set_plan(handle: str, body: PlanIn, me: A.Me = Depends(A.require_scope("manage_users"))):
    with engine().begin() as c:
        user, acc = _by_handle(c, handle)
        until = None if body.days == 0 or body.tier == "free" else _now() + body.days * 86400
        c.execute(update(A.accounts).where(A.accounts.c.user_id == user["id"]).values(tier=body.tier, tier_until=until, tier_source="grant" if body.tier != "free" else ""))
        A.notify(c, user["id"], "plan", tier=body.tier, days=body.days)
        A.audit(c, me, "plan_change", user["id"], before={"tier": acc["tier"], "until": acc["tier_until"]}, after={"tier": body.tier, "days": body.days})
    return {"ok": True, "handle": acc["handle"], "tier": body.tier, "until": _iso(until)}


class OnIn(BaseModel):
    on: bool
    note: str = Field("", max_length=300)


@router.post("/users/{handle}/teacher")
def set_teacher(handle: str, body: OnIn, me: A.Me = Depends(A.require_scope("verify_teachers"))):
    import teachers as T
    with engine().begin() as c:
        user, acc = _by_handle(c, handle)
        v = T.verifications
        old = c.execute(select(v.c.status).where(v.c.user_id == user["id"])).scalar()
        status = "verified" if body.on else "rejected"
        if old is None:
            c.execute(insert(v).values(user_id=user["id"], email=acc["email"] or "", status=status, method="admin", admin_note=body.note.strip(), created=_now(), decided=_now()))
        else:
            c.execute(update(v).where(v.c.user_id == user["id"]).values(status=status, method="admin", admin_note=body.note.strip(), decided=_now()))
        A.notify(c, user["id"], "teacher_verified" if body.on else "teacher_rejected", note=body.note.strip())
        A.audit(c, me, "teacher_on" if body.on else "teacher_off", user["id"], before={"status": old}, after={"status": status}, note=body.note)
    return {"ok": True}


@router.post("/users/{handle}/suspend")
def suspend(handle: str, body: OnIn, me: A.Me = Depends(A.require_scope("manage_users"))):
    with engine().begin() as c:
        user, acc = _by_handle(c, handle)
        check_can_act_on(c, me, user["id"], acc)
        role = "banned" if body.on else ("user" if acc["role"] == "banned" else acc["role"])
        c.execute(update(A.accounts).where(A.accounts.c.user_id == user["id"]).values(role=role))
        if body.on:
            c.execute(delete(A.elevations).where(A.elevations.c.user_id == user["id"]))
        A.audit(c, me, "suspend" if body.on else "unsuspend", user["id"], before={"role": acc["role"]}, after={"role": role}, note=body.note)
    return {"ok": True}


class MessageIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=1000)
    email: bool = False


@router.post("/users/{handle}/message")
def message(handle: str, body: MessageIn, me: A.Me = Depends(A.require_scope("manage_users"))):
    with engine().begin() as c:
        user, acc = _by_handle(c, handle)
        A.notify(c, user["id"], "staff_message", text=body.text.strip())
        A.audit(c, me, "message", user["id"], after={"email": body.email}, note=body.text.strip()[:300])
    sent = 0
    if body.email and acc["email"]:
        import classroom
        sent = classroom.send_email([acc["email"]], "A message from Haptune", body.text.strip())
    return {"ok": True, "emailed": bool(sent)}


@router.get("/users/{handle}/export")
def export(handle: str, me: A.Me = Depends(A.require_scope("manage_users"))):
    with engine().begin() as c:
        user, _ = _by_handle(c, handle)
        A.audit(c, me, "export_user", user["id"])
        data = A.export_user(c, user["id"])
    return Response(json.dumps(data, ensure_ascii=False, indent=1), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="melovyn-{handle.lstrip("@")}.json"'})


class ConfirmIn(BaseModel):
    confirm: str = Field(..., max_length=24)          # the username typed again


@router.post("/users/{handle}/delete")
def delete_user(handle: str, body: ConfirmIn, me: A.Me = Depends(A.require_scope("manage_users"))):
    with engine().begin() as c:
        user, acc = _by_handle(c, handle)
        if body.confirm.strip().lower().lstrip("@") != acc["handle"]:
            raise HTTPException(400, "Type the username to confirm.")
        check_can_act_on(c, me, user["id"], acc, what="delete")
        if user["id"] == me.id:
            raise HTTPException(400, "Delete your own account from Me > Account.")
        A.audit(c, me, "delete_user", user["id"], before={"handle": acc["handle"], "email": acc["email"]})
        A.delete_account(c, user["id"])
    return {"ok": True}


# ----------------------------------------------------------------------------------------- access (the owner)
class AccessIn(BaseModel):
    handle: str = Field(..., max_length=24)
    scopes: list[str] = Field(..., min_length=1, max_length=len(A.SCOPES))
    days: int = Field(30, ge=0, le=3650)               # 0 = until revoked
    reason: str = Field(..., min_length=3, max_length=300)


def _who(c, ids) -> dict:
    return {u: h for u, h in c.execute(select(A.accounts.c.user_id, A.accounts.c.handle).where(A.accounts.c.user_id.in_(list(ids) or ["-"]))).all()}


@router.get("/access")
def list_access(me: A.Me = Depends(A.require_scope("owner"))):
    with engine().connect() as c:
        grants = [dict(r) for r in c.execute(select(A.dev_grants)).mappings().all()]
        legacy = [dict(r) for r in c.execute(select(A.accounts).where(or_(A.accounts.c.role == "admin", func.lower(A.accounts.c.handle).in_(list(A.ADMIN_HANDLES) or ["-"])))).mappings().all()]
        owners = [dict(r) for r in c.execute(select(A.accounts).where(A.accounts.c.google_sub.isnot(None), func.lower(A.accounts.c.email).in_(list(A.owner_emails()) or ["-"]))).mappings().all()]
        accs = {r["user_id"]: dict(r) for r in c.execute(select(A.accounts).where(A.accounts.c.user_id.in_([g["user_id"] for g in grants] or ["-"]))).mappings().all()}
        names = _who(c, [g["granted_by"] for g in grants])
        live = {u for (u,) in c.execute(select(A.elevations.c.user_id).where(A.elevations.c.until > _now())).all()}
    out = [{"handle": o["handle"], "email": o["email"], "role": "owner", "scopes": list(A.SCOPES), "expires": None, "reason": "HAPTUNE_OWNER_EMAILS", "totp": bool(o["totp_on"]),
            "dev_mode_now": o["user_id"] in live, "revocable": False} for o in owners]
    for g in grants:
        a = accs.get(g["user_id"], {})
        out.append({"handle": a.get("handle", "?"), "email": a.get("email") or "", "role": "developer", "scopes": g["scopes"], "expires": _iso(g["expires"]) if g["expires"] else None,
                    "expired": bool(g["expires"] and g["expires"] < _now()), "reason": g["reason"], "granted_by": names.get(g["granted_by"]), "granted": _iso(g["created"]),
                    "totp": bool(a.get("totp_on")), "dev_mode_now": g["user_id"] in live, "revocable": True})
    for l in legacy:
        if A.is_owner_acc(l) or any(g["user_id"] == l["user_id"] for g in grants):
            continue
        out.append({"handle": l["handle"], "email": l["email"] or "", "role": "developer", "scopes": list(A.SCOPES), "expires": None,
                    "reason": "Earlier developer code / HAPTUNE_ADMINS", "totp": bool(l["totp_on"]), "dev_mode_now": l["user_id"] in live, "revocable": True, "legacy": True})
    return {"items": out, "scopes": list(A.SCOPES)}


@router.post("/access")
def grant_access(body: AccessIn, request: Request, me: A.Me = Depends(A.require_scope("owner"))):
    scopes = sorted({s for s in body.scopes if s in A.SCOPES})
    if not scopes:
        raise HTTPException(400, "Choose at least one scope.")
    with engine().begin() as c:
        user, acc = _by_handle(c, body.handle)
        if A.is_owner_acc(acc):
            raise HTTPException(400, "That's the owner: they already have everything.")
        if not A.is_registered(acc):
            raise HTTPException(400, "They need to sign in with Google or a password first.")
        if acc["role"] == "banned":
            raise HTTPException(400, "That account is suspended.")
        old = _grant_row(c, user["id"])
        expires = None if body.days == 0 else _now() + body.days * 86400
        vals = {"scopes": scopes, "expires": expires, "reason": body.reason.strip(), "granted_by": me.id, "created": _now()}
        if old:
            c.execute(update(A.dev_grants).where(A.dev_grants.c.user_id == user["id"]).values(**vals))
        else:
            c.execute(insert(A.dev_grants).values(user_id=user["id"], **vals))
        if acc["role"] == "admin":                       # the grant replaces the old all-scopes developer role
            c.execute(update(A.accounts).where(A.accounts.c.user_id == user["id"]).values(role="user"))
        c.execute(delete(A.elevations).where(A.elevations.c.user_id == user["id"]))   # new scopes: switch Developer mode on again
        A.notify(c, user["id"], "dev_access", scopes=scopes, expires=_iso(expires) if expires else None)
        A.audit(c, me, "grant_developer", user["id"], before={"scopes": old["scopes"], "expires": old["expires"]} if old else None,
                after={"scopes": scopes, "expires": expires}, note=body.reason.strip())
    if acc["email"]:
        import classroom
        classroom.send_email([acc["email"]], "You have developer access to Haptune",
                             f"The owner gave you developer access ({', '.join(scopes)})" + (f" until {_iso(expires)[:10]}" if expires else "") +
                             ".\n\nTo use it: Me > Developer mode. You'll set up 2-step verification the first time.\n\nReason: " + body.reason.strip())
    return {"ok": True}


@router.delete("/access/{handle}")
def revoke_access(handle: str, me: A.Me = Depends(A.require_scope("owner"))):
    with engine().begin() as c:
        user, acc = _by_handle(c, handle)
        if A.is_owner_acc(acc):
            raise HTTPException(403, {"code": "owner_protected", "message": "The owner can't be removed; that is set only on the server."})
        old = _grant_row(c, user["id"])
        legacy = acc["role"] == "admin" or acc["handle"].lower() in A.ADMIN_HANDLES
        if not old and not legacy:
            raise HTTPException(404, "They aren't a developer.")
        c.execute(delete(A.dev_grants).where(A.dev_grants.c.user_id == user["id"]))
        if acc["role"] == "admin":
            c.execute(update(A.accounts).where(A.accounts.c.user_id == user["id"]).values(role="user"))
        c.execute(delete(A.elevations).where(A.elevations.c.user_id == user["id"]))      # their Developer mode ends now, everywhere
        A.notify(c, user["id"], "dev_access_ended")
        A.audit(c, me, "revoke_developer", user["id"], before={"scopes": old["scopes"] if old else list(A.SCOPES)},
                note="also listed in HAPTUNE_ADMINS: remove it there too" if acc["handle"].lower() in A.ADMIN_HANDLES else "")
    return {"ok": True, "env_note": acc["handle"].lower() in A.ADMIN_HANDLES}


# ----------------------------------------------------------------------------------------- audit (the owner)
def _audit_rows(c, action: str, handle: str, limit: int, offset: int):
    al = A.audit_log
    cond = []
    if action:
        cond.append(al.c.action == action)
    if handle:
        uid = c.execute(select(A.accounts.c.user_id).where(A.accounts.c.handle == handle.lower().lstrip("@"))).scalar() or "-"
        cond.append(or_(al.c.actor == uid, al.c.target == uid))
    rows = [dict(r) for r in c.execute(select(al).where(*cond).order_by(al.c.id.desc()).limit(limit).offset(offset)).mappings().all()]
    names = _who(c, {r["actor"] for r in rows} | {r["target"] for r in rows if r["target"]})
    total = c.execute(select(func.count()).select_from(al).where(*cond)).scalar()
    return total, [{"id": r["id"], "t": _iso(r["created"]), "who": names.get(r["actor"], r["actor"][:8]), "action": r["action"],
                    "whom": names.get(r["target"], (r["target"] or "")[:8]) if r["target"] else "", "before": r["before"], "after": r["after"], "note": r["note"]} for r in rows]


@router.get("/audit")
def audit_log(action: str = "", handle: str = "", limit: int = 100, offset: int = 0, me: A.Me = Depends(A.require_scope("owner"))):
    with engine().connect() as c:
        total, items = _audit_rows(c, action, handle, max(1, min(500, limit)), max(0, offset))
        actions = [a for (a,) in c.execute(select(A.audit_log.c.action).distinct().order_by(A.audit_log.c.action)).all()]
    return {"total": total, "items": items, "actions": actions}


@router.get("/audit/export")
def audit_export(me: A.Me = Depends(A.require_scope("owner"))):
    with engine().begin() as c:
        _, items = _audit_rows(c, "", "", 100000, 0)
        A.audit(c, me, "export_audit", None)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "time", "who", "action", "whom", "before", "after", "note"])
    safe = lambda v: ("'" + v) if isinstance(v, str) and v[:1] in "=+-@" else v  # noqa: E731  (no formulas in a spreadsheet)
    for r in reversed(items):
        w.writerow([r["id"], r["t"], safe(r["who"]), r["action"], safe(r["whom"]), json.dumps(r["before"]) if r["before"] else "",
                    json.dumps(r["after"]) if r["after"] else "", safe(r["note"])])
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="melovyn-audit.csv"'})
