"""Hapi everywhere: one AI chat for the whole app (POST /ai/chat).

The app sends the conversation and what is on screen (the screen, the open piece, the titles in the library, the
last practice report). The model can look things up with read-only tools that run here:
  my_practice   the signed-in person's recent takes, classes and what is due
  search_stage  public Stage posts and Sounds
  find_teachers open classes and verified tutors
and can offer next steps with suggest_actions. Actions are never carried out here: the app shows them as buttons
and the person taps one. Every action is checked against a fixed list (and piece ids against the library the app
sent), so the model cannot make the app do anything else.

Costs: it counts as one "Hapi the tutor" answer (accounts.charge_ai), with the same daily limits per device and
address and the same whole-server cap. Free accounts get it when HAPTUNE_PLANS_JSON gives "free" a tutor allowance.
"""
from __future__ import annotations

import json
import os
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, or_, select

import accounts

router = APIRouter(prefix="/ai", tags=["ai"])
CHAT_PER_DAY = int(os.environ.get("HAPTUNE_CHAT_PER_DAY", "60"))
MAX_CONTEXT = 12_000
LANG_NAMES = {"en": "English", "ms": "Bahasa Melayu", "zh-Hans": "Simplified Chinese", "zh-Hant": "Traditional Chinese"}

SCREENS = ("home", "library", "create", "learn", "stage", "me", "soundCheck", "tuner", "metronome", "newSong",
           "newSound", "chordEditor", "classes", "tutors", "academy", "plans", "help")
ACTIONS = ("open_piece", "play_along", "open_screen", "transpose", "set_speed", "new_song", "open_post", "open_sound")

SYSTEM = """You are Hapi, the helper inside Melovyn, a music practice and teaching app (web, Android, iPhone Home Screen).
Melovyn's goal: everyone can get their sheets and practise directly and smoothly. Help with that, briefly.

What is where in the app:
- Practice (Home): the library of sheets; open one to read it, change key or speed, loop bars, metronome, tuner.
  Play Along listens through the microphone, follows the sheet, flags wrong notes and gives a report afterwards.
  Sound check tests the microphone and speakers when audio is noisy or quiet.
- Create: new songs (lead sheet, melody, full score, improvisation, rhythm, exercises), the chord-sheet editor
  (type lyrics, get chords, change any chord per beat), and Sounds (a multitrack mixer: record, backing, export).
- Learn: classes like Google Classroom (stream, classwork, people, grades), teachers set Play Along assignments;
  open classes and verified tutors to find a teacher; the Academy courses.
- Stage: the community. Share a sound, ask a question, post a score, or request a sheet someone can write.
- Me: account, plans, settings, Google connections (Calendar, Meet, Drive).

How to answer:
- Plain text, short paragraphs or a few short lines. No Markdown (no **bold**, headings or tables).
- Answer in the language you are told to use.
- Use the tools when the answer depends on this person's data or on what is on Stage; don't guess it.
- When a next step in the app would help, call suggest_actions with one to four actions, then say in one line
  what the buttons do. Only use piece ids from the library you were given.
- Music theory, technique and practice advice: answer directly and practically.
- Never write out the lyrics or the notes of copyrighted songs. For a popular song, suggest a Stage request or
  importing a sheet they own. Public-domain music is fine.
- If something is not about music, practising or the app, steer back to music in one friendly line."""

TOOLS = [
    {"name": "my_practice", "description": "The signed-in person's recent Play Along takes shared with classes (piece, accuracy, when), their classes, and assignments due soon with whether they are done.",
     "input_schema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "search_stage", "description": "Search public Stage posts (shared scores, requests, questions) and Sounds by words in the title, song or artist.",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string", "maxLength": 80}}, "required": ["query"], "additionalProperties": False}},
    {"name": "find_teachers", "description": "Open classes anyone can join and verified tutors, optionally for one instrument.",
     "input_schema": {"type": "object", "properties": {"instrument": {"type": "string", "maxLength": 30}}, "additionalProperties": False}},
    {"name": "suggest_actions", "description": "Show the person one to four buttons for next steps in the app. Nothing happens until they tap one.",
     "input_schema": {"type": "object", "required": ["actions"], "additionalProperties": False, "properties": {"actions": {
         "type": "array", "minItems": 1, "maxItems": 4, "items": {"type": "object", "required": ["type", "label"], "additionalProperties": False, "properties": {
             "type": {"type": "string", "enum": list(ACTIONS)},
             "label": {"type": "string", "maxLength": 40, "description": "Button text, a few words, in the reply's language"},
             "piece_id": {"type": "string", "description": "open_piece / play_along: an id from the library"},
             "screen": {"type": "string", "enum": list(SCREENS), "description": "open_screen"},
             "semitones": {"type": "integer", "minimum": -12, "maximum": 12, "description": "transpose the open piece"},
             "percent": {"type": "integer", "minimum": 30, "maximum": 150, "description": "set_speed of the open piece"},
             "title": {"type": "string", "maxLength": 80, "description": "new_song"},
             "style": {"type": "string", "maxLength": 20, "description": "new_song: pop, ballad, waltz, swing, bossa, hymn"},
             "id": {"type": "string", "maxLength": 20, "description": "open_post / open_sound: an id from search_stage"}}}}}}},
]


class Turn(BaseModel):
    role: str = Field(..., pattern="^(user|assistant)$")
    text: str = Field(..., min_length=1, max_length=2000)


class ChatIn(BaseModel):
    messages: list[Turn] = Field(..., min_length=1, max_length=20)
    context: dict = Field(default_factory=dict)
    lang: str = Field("en", max_length=10)

    @field_validator("messages")
    @classmethod
    def ends_with_user(cls, v):
        if v[-1].role != "user":
            raise ValueError("the last message must be the person's")
        return v

    @field_validator("context")
    @classmethod
    def small(cls, v):
        if len(json.dumps(v, ensure_ascii=False)) > MAX_CONTEXT:
            raise ValueError("context too big")
        return v


# ----------------------------------------------------------------------------------------- tools
def _when(ts: float) -> str:
    d = (time.time() - ts) / 86400
    return "today" if d < 1 else f"{int(d)} days ago" if d >= 0 else f"in {int(-d) + 1} days"


def tool_my_practice(me) -> dict:
    if me is None:
        return {"signed_in": False, "note": "Not signed in: practice history lives on this device only."}
    from academy import assignments, classes, engine, members, submissions, takes
    now = time.time()
    with engine().connect() as c:
        tk = c.execute(select(takes.c.piece_title, takes.c.accuracy, takes.c.created).where(takes.c.user_id == me.id)
                       .order_by(takes.c.created.desc()).limit(10)).mappings().all()
        cls = c.execute(select(classes.c.id, classes.c.name, members.c.role).join(members, members.c.class_id == classes.c.id)
                        .where(members.c.user_id == me.id, classes.c.archived.is_(False))).mappings().all()
        ids = [x["id"] for x in cls] or ["-"]
        due = c.execute(select(assignments.c.id, assignments.c.title, assignments.c.piece_title, assignments.c.goal, assignments.c.due_at)
                        .where(assignments.c.class_id.in_(ids), assignments.c.opens_at <= now, assignments.c.due_at >= now - 86400,
                               assignments.c.due_at <= now + 14 * 86400).order_by(assignments.c.due_at).limit(10)).mappings().all()
        done = set(c.execute(select(submissions.c.assignment_id).where(submissions.c.user_id == me.id,
                                                                       submissions.c.assignment_id.in_([a["id"] for a in due] or ["-"]))).scalars().all())
    return {"signed_in": True,
            "recent_takes": [{"piece": t["piece_title"], "accuracy": round(t["accuracy"]), "when": _when(t["created"])} for t in tk],
            "classes": [{"name": x["name"], "role": x["role"]} for x in cls],
            "due": [{"title": a["title"], "piece": a["piece_title"], "goal": a["goal"], "due": _when(a["due_at"]), "done": a["id"] in done} for a in due]}


def tool_search_stage(query: str) -> dict:
    from academy import engine
    from community import posts
    from sounds import sounds
    q = f"%{query.strip()[:80]}%"
    with engine().connect() as c:
        ps = c.execute(select(posts.c.id, posts.c.type, posts.c.title, posts.c.song, posts.c.artist, posts.c.status)
                       .where(posts.c.hidden.is_(False), posts.c.visibility == "public", posts.c.type.in_(["share", "request", "question"]),
                              or_(posts.c.title.ilike(q), posts.c.song.ilike(q), posts.c.artist.ilike(q)))
                       .order_by(posts.c.bumped.desc()).limit(8)).mappings().all()
        ss = c.execute(select(sounds.c.id, sounds.c.title, sounds.c.seconds).where(sounds.c.hidden.is_(False), sounds.c.title.ilike(q))
                       .order_by(sounds.c.created.desc()).limit(5)).mappings().all()
    return {"posts": [dict(p) for p in ps], "sounds": [{"id": s["id"], "title": s["title"], "seconds": round(s["seconds"])} for s in ss]}


def tool_find_teachers(instrument: str = "") -> dict:
    from academy import classes, engine
    from tutors import tutors
    inst = instrument.strip().lower()[:30]
    with engine().connect() as c:
        cond = [classes.c.visibility == "public", classes.c.archived.is_(False)]
        if inst:
            cond.append(classes.c.instrument.ilike(f"%{inst}%"))
        cl = c.execute(select(classes.c.name, classes.c.instrument, classes.c.level).where(and_(*cond)).limit(8)).mappings().all()
        tu = [dict(t) for t in c.execute(select(tutors.c.headline, tutors.c.instruments, tutors.c.city, tutors.c.online, tutors.c.rate)
                                         .where(tutors.c.status == "verified").limit(30)).mappings().all()]
    if inst:
        tu = [t for t in tu if any(inst in str(i).lower() for i in (t["instruments"] or []))]
    return {"open_classes": [dict(x) for x in cl], "verified_tutors": tu[:8]}


def check_actions(actions: list, context: dict) -> list:
    """Keeps only actions the app knows, with valid arguments; piece ids must be in the library the app sent."""
    lib = {str(p.get("id")) for p in (context.get("library") or []) if isinstance(p, dict)}
    piece = context.get("piece") or {}
    if isinstance(piece, dict) and piece.get("id"):
        lib.add(str(piece["id"]))
    out = []
    for a in actions[:4]:
        if not isinstance(a, dict) or a.get("type") not in ACTIONS:
            continue
        label = str(a.get("label") or "").strip()[:40]
        if not label:
            continue
        k, x = a["type"], {"type": a["type"], "label": label}
        if k in ("open_piece", "play_along"):
            if str(a.get("piece_id")) not in lib:
                continue
            x["piece_id"] = str(a["piece_id"])
        elif k == "open_screen":
            if a.get("screen") not in SCREENS:
                continue
            x["screen"] = a["screen"]
        elif k == "transpose":
            if not piece or not isinstance(a.get("semitones"), int) or not -12 <= a["semitones"] <= 12:
                continue
            x["semitones"] = a["semitones"]
        elif k == "set_speed":
            if not piece or not isinstance(a.get("percent"), int) or not 30 <= a["percent"] <= 150:
                continue
            x["percent"] = a["percent"]
        elif k == "new_song":
            x["title"] = str(a.get("title") or "")[:80]
            x["style"] = str(a.get("style") or "pop")[:20]
        elif k in ("open_post", "open_sound"):
            if not str(a.get("id") or "").isalnum():
                continue
            x["id"] = str(a["id"])[:20]
        out.append(x)
    return out


# ----------------------------------------------------------------------------------------- the endpoint
def configured() -> bool:
    from haptune.ai.claude import ai_configured
    return ai_configured()


def _client():
    """The model client; tests replace this and configured()."""
    from haptune.ai.claude import Claude
    return Claude(model=accounts.feature_model("tutor"))


@router.post("/chat")
def chat(body: ChatIn, request: Request):
    from haptune.ai.claude import AIError
    import app as _app
    if not configured():
        raise HTTPException(503, "Hapi is not switched on for this server yet.")
    _app._limit(request, "chat", CHAT_PER_DAY)
    me = accounts.charge_ai(request, "tutor")
    ctx = body.context
    actions: list = []

    def run_tool(name: str, args: dict) -> str:
        if name == "my_practice":
            return json.dumps(tool_my_practice(me), ensure_ascii=False)
        if name == "search_stage":
            return json.dumps(tool_search_stage(str(args.get("query", ""))), ensure_ascii=False)
        if name == "find_teachers":
            return json.dumps(tool_find_teachers(str(args.get("instrument", ""))), ensure_ascii=False)
        if name == "suggest_actions":
            ok = check_actions(args.get("actions") or [], ctx)
            actions[:] = ok
            return f"Shown {len(ok)} button(s) to the person." if ok else "None of those actions were valid; describe the step in words instead."
        raise ValueError(f"no tool called {name}")

    system = [{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}},
              {"type": "text", "text": f"Reply in {LANG_NAMES.get(body.lang, 'English')}.\nWhat the app shows right now (JSON):\n"
                                       + json.dumps(ctx, ensure_ascii=False)}]
    try:
        text = _client().converse(system, [{"role": m.role, "content": m.text} for m in body.messages], TOOLS, run_tool)
    except AIError as e:
        accounts.refund_ai(me, "tutor")
        raise HTTPException(502, str(e))
    return {"text": _app._plain(text), "actions": actions}
