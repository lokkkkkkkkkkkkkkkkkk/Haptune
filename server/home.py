"""Home in one call (GET /c/homescreen; /c/home is the older Stage summary): what the Home screen's hero tiles, Learn & Stage band and shelves need.

    new      requests fulfilled lately (yours first), new Sounds from people you follow, new scores on Stage
    learn    your next assignment, next lesson (with its Meet link), class posts this week; for teachers: takes to
             review and students who haven't practised in 7 days
    stage    today's challenge, new posts from people you follow, open requests (and ones for your instrument)
    class_pieces   pieces your classes are playing (titles, for the "Pieces your class is playing" shelf)
    trending       hot scores and requests on Stage
Cheap on purpose: a handful of indexed queries, nothing per post.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import and_, func, or_, select

import accounts as A
from academy import _iso, _now, assignments, classes, engine, members, submissions, takes

router = APIRouter(prefix="/c", tags=["home"])
DAY = 86400.0


@router.get("/homescreen")
def home(me: A.Me | None = Depends(A.optional)):
    import classroom as CR
    import community as CM
    import sounds as SD
    import stage as ST
    now = _now()
    uid = me.id if me else "-"
    out: dict = {"new": {}, "learn": {}, "stage": {}, "class_pieces": [], "trending": []}
    with engine().connect() as c:
        people_ids: set = set()
        following = [r[0] for r in c.execute(select(CM.follows.c.followee).where(CM.follows.c.follower == uid)).all()]
        # ---------------------------------------------------------------- new
        fulfilled = [dict(r) for r in c.execute(select(CM.posts.c.id, CM.posts.c.title, CM.posts.c.artist, CM.posts.c.user_id, CM.posts.c.bumped)
                                               .where(CM.posts.c.type == "request", CM.posts.c.status == "done", CM.posts.c.hidden.is_(False),
                                                      CM.posts.c.bumped > now - 21 * DAY)
                                               .order_by((CM.posts.c.user_id == uid).desc(), CM.posts.c.bumped.desc()).limit(6)).mappings().all()]
        friend_sounds = [dict(r) for r in c.execute(select(SD.sounds.c.id, SD.sounds.c.title, SD.sounds.c.user_id, SD.sounds.c.seconds, SD.sounds.c.created)
                                                   .where(SD.sounds.c.hidden.is_(False), SD.sounds.c.created > now - 14 * DAY,
                                                          SD.sounds.c.user_id.in_(following or ["-"]))
                                                   .order_by(SD.sounds.c.created.desc()).limit(6)).mappings().all()]
        new_scores = [dict(r) for r in c.execute(select(CM.posts.c.id, CM.posts.c.title, CM.posts.c.artist, CM.posts.c.user_id, CM.posts.c.created)
                                                .where(CM.posts.c.type == "share", CM.posts.c.hidden.is_(False), CM.posts.c.visibility == "public",
                                                       CM.posts.c.created > now - 14 * DAY)
                                                .order_by(CM.posts.c.created.desc()).limit(6)).mappings().all()]
        people_ids |= {x["user_id"] for x in fulfilled + friend_sounds + new_scores}
        # ---------------------------------------------------------------- learn
        mine = c.execute(select(classes.c.id, classes.c.name, classes.c.color, members.c.role).join(members, members.c.class_id == classes.c.id)
                         .where(members.c.user_id == uid, classes.c.archived.is_(False))).mappings().all()
        cids = [m["id"] for m in mine] or ["-"]
        names = {m["id"]: m["name"] for m in mine}
        teach = [m["id"] for m in mine if m["role"] == "teacher"]
        learn_in = [m["id"] for m in mine if m["role"] != "teacher"]
        nxt = c.execute(select(CR.sessions_t).where(CR.sessions_t.c.class_id.in_(cids), CR.sessions_t.c.cancelled.is_(False),
                                                    CR.sessions_t.c.start > now - 30 * 60).order_by(CR.sessions_t.c.start).limit(1)).mappings().first()
        open_asg = [dict(r) for r in c.execute(select(assignments.c.id, assignments.c.class_id, assignments.c.title, assignments.c.piece_title, assignments.c.due_at)
                                              .where(assignments.c.class_id.in_(learn_in or ["-"]), assignments.c.opens_at <= now, assignments.c.due_at > now - DAY)
                                              .order_by(assignments.c.due_at)).mappings().all()]
        done = {r[0] for r in c.execute(select(submissions.c.assignment_id).where(submissions.c.user_id == uid,
                                                                                  submissions.c.assignment_id.in_([a["id"] for a in open_asg] or ["-"]))).all()}
        todo = [a for a in open_asg if a["id"] not in done]
        posts_week = c.execute(select(func.count()).select_from(CR.posts).where(CR.posts.c.class_id.in_(cids), CR.posts.c.created > now - 7 * DAY,
                                                                              CR.posts.c.author_id != uid)).scalar() or 0
        learn = {"classes": len(mine), "todo": len(todo), "class_posts_week": int(posts_week),
                 "next_assignment": ({"id": todo[0]["id"], "title": todo[0]["title"], "piece": todo[0]["piece_title"], "class": names.get(todo[0]["class_id"], ""),
                                      "due": _iso(todo[0]["due_at"])} if todo else None),
                 "next_lesson": ({"title": nxt["title"], "start": _iso(nxt["start"]), "minutes": nxt["minutes"], "meet_url": nxt["meet_url"],
                                  "class": names.get(nxt["class_id"], "")} if nxt else None)}
        if teach:
            asg_ids = [r[0] for r in c.execute(select(assignments.c.id).where(assignments.c.class_id.in_(teach))).all()] or ["-"]
            import academy as AC
            subs = [r[0] for r in c.execute(select(submissions.c.id).where(submissions.c.assignment_id.in_(asg_ids))).all()]
            reviewed = {r[0] for r in c.execute(select(AC.feedback.c.submission_id).where(AC.feedback.c.submission_id.in_(subs or ["-"]))).all()}
            to_review = len([s for s in subs if s not in reviewed]) + int(c.execute(select(func.count()).select_from(takes).where(
                takes.c.class_id.in_(teach), takes.c.created > now - 7 * DAY)).scalar() or 0)
            students = {r[0] for r in c.execute(select(members.c.user_id).where(members.c.class_id.in_(teach), members.c.role == "student")).all()}
            active = {r[0] for r in c.execute(select(A.practice_log.c.user_id).where(A.practice_log.c.user_id.in_(list(students) or ["-"]),
                                                                                     A.practice_log.c.day >= A.today_minus(7))).all()}
            active |= {r[0] for r in c.execute(select(submissions.c.user_id).where(submissions.c.user_id.in_(list(students) or ["-"]),
                                                                                   submissions.c.created > now - 7 * DAY)).all()}
            learn["teacher"] = {"to_review": to_review, "students": len(students), "inactive": len(students - active)}
        out["learn"] = learn
        out["class_pieces"] = sorted({a["piece_title"] for a in open_asg if a["piece_title"]})[:12]
        # ---------------------------------------------------------------- stage
        daily = ST._daily_brief(c, me)
        friends_new = c.execute(select(func.count()).select_from(CM.posts).where(CM.posts.c.user_id.in_(following or ["-"]), CM.posts.c.hidden.is_(False),
                                                                                CM.posts.c.created > now - 3 * DAY)).scalar() or 0
        open_req = c.execute(select(func.count()).select_from(CM.posts).where(CM.posts.c.type == "request", CM.posts.c.status == "open",
                                                                             CM.posts.c.hidden.is_(False))).scalar() or 0
        insts = (me.acc.get("instruments") or []) if me else []
        for_you = 0
        if insts:
            rows = c.execute(select(CM.posts.c.instruments).where(CM.posts.c.type == "request", CM.posts.c.status == "open", CM.posts.c.hidden.is_(False)).limit(300)).all()
            for_you = sum(1 for (ins,) in rows if set(ins or []) & set(insts))
        out["stage"] = {"daily": daily, "friends_new": int(friends_new), "open_requests": int(open_req), "requests_for_you": for_you, "following": len(following)}
        out["trending"] = ST._trending(c, me, 6)
        people = CM._people(c, list(people_ids))
    out["new"] = {
        "fulfilled": [{"id": x["id"], "title": x["title"], "artist": x["artist"], "mine": x["user_id"] == uid, "at": _iso(x["bumped"])} for x in fulfilled],
        "sounds": [{"id": x["id"], "title": x["title"], "by": (people.get(x["user_id"]) or {}).get("name", ""), "seconds": round(x["seconds"]), "at": _iso(x["created"])} for x in friend_sounds],
        "scores": [{"id": x["id"], "title": x["title"], "artist": x["artist"], "by": (people.get(x["user_id"]) or {}).get("name", ""), "at": _iso(x["created"])} for x in new_scores],
    }
    return out


@router.get("/find")
def find(q: str = "", me: A.Me | None = Depends(A.optional)):
    """Global search beyond pieces: classes (open ones and yours), people, Sounds and Stage posts."""
    import community as CM
    import sounds as SD
    from academy import users
    q = q.strip()[:80]
    if len(q) < 2:
        return {"classes": [], "people": [], "sounds": [], "posts": []}
    like = f"%{q.lower()}%"
    uid = me.id if me else "-"
    with engine().connect() as c:
        mine = {r[0] for r in c.execute(select(members.c.class_id).where(members.c.user_id == uid)).all()}
        cls = c.execute(select(classes.c.id, classes.c.name, classes.c.instrument, classes.c.visibility)
                        .where(classes.c.archived.is_(False), func.lower(classes.c.name).like(like),
                               or_(classes.c.visibility == "public", classes.c.id.in_(list(mine) or ["-"]))).limit(8)).mappings().all()
        blocked = CM._blocked_by(c, me) if me else set()
        ppl = c.execute(select(A.accounts.c.user_id, A.accounts.c.handle, users.c.name).join(users, users.c.id == A.accounts.c.user_id)
                        .where(or_(A.accounts.c.google_sub.isnot(None), A.accounts.c.pw_hash.isnot(None)), A.accounts.c.role != "banned",
                               or_(func.lower(A.accounts.c.handle).like(like), func.lower(users.c.name).like(like))).limit(8)).mappings().all()
        snd = c.execute(select(SD.sounds.c.id, SD.sounds.c.title, SD.sounds.c.seconds).where(SD.sounds.c.hidden.is_(False), func.lower(SD.sounds.c.title).like(like))
                        .order_by(SD.sounds.c.created.desc()).limit(8)).mappings().all()
        pst = c.execute(select(CM.posts.c.id, CM.posts.c.type, CM.posts.c.title, CM.posts.c.status).where(
            CM.posts.c.hidden.is_(False), CM.posts.c.visibility == "public", CM.posts.c.type.in_(["question", "show"]),
            or_(func.lower(CM.posts.c.title).like(like), func.lower(CM.posts.c.body).like(like))).order_by(CM.posts.c.bumped.desc()).limit(8)).mappings().all()
    return {"classes": [{"id": x["id"], "title": x["name"], "sub": " · ".join(filter(None, [x["instrument"], "yours" if x["id"] in mine else "open class"]))} for x in cls],
            "people": [{"handle": x["handle"], "name": x["name"]} for x in ppl if x["user_id"] not in blocked and x["user_id"] != uid],
            "sounds": [{"id": x["id"], "title": x["title"], "sub": f"{round(x['seconds'])}s"} for x in snd],
            "posts": [{"id": x["id"], "title": x["title"], "sub": x["type"]} for x in pst]}
