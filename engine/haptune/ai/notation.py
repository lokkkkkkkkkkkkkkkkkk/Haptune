"""The compact bar notation the vision model writes, and a strict parser for it.

One voice of one bar is a string of space-separated tokens. Pitches are written *as printed*: the note's
letter, the accidental printed in front of it (if any) and the octave (middle C = C4). Key signatures and
accidentals that carry through the bar are applied afterwards by `resolve_alters`, the same way a musician
reads, so the model never has to work out "is this F sharp because of the key signature?".

    C5/4                quarter note C5
    F#4/8.              dotted eighth, printed sharp (accidentals: #  ##  b  bb  n)
    C4+E4+G4/2          chord, half notes
    r/8   R             eighth rest; R = whole-bar rest
    G4/2~ G4/8          tie to the next note of the same pitch
    3( C5/8 D5/8 E5/8 ) triplet (3 notes in the time of 2); also 5:4( ... ), 6( ... ), 2( ... )
    g( D5/16 ) C5/4     grace note(s) before the next note
    clef=bass           clef change on this staff from here on

Marks follow a note or rest with no spaces, each starting with "!":
    !stacc !accent !tenuto !marcato !staccatissimo !fermata !trill !mordent !turn !arpeggio
    !upbow !downbow !slur-start !slur-end !p !mf (any dynamic) !cresc-start !cresc-end !dim-start !dim-end
    !words="dolce" !tempo="Allegro" !bpm=120 !chord="G7" !ly="Twin-" !ly2="..." !ped=start|end !fing=3
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from fractions import Fraction

ACCIDENTALS = {"#": 1, "##": 2, "b": -1, "bb": -2, "n": 0}
DEN_TYPE = {1: "whole", 2: "half", 4: "quarter", 8: "eighth", 16: "16th", 32: "32nd", 64: "64th", 128: "128th"}
DYNAMICS = {"pppp", "ppp", "pp", "p", "mp", "mf", "f", "ff", "fff", "ffff", "sf", "sfz", "sffz", "sfp", "fp", "fz",
            "rf", "rfz", "sfpp"}
SIMPLE_MARKS = {
    "stacc": "staccato", "staccato": "staccato", "st": "staccato",
    "accent": "accent", "acc": "accent",
    "tenuto": "tenuto", "ten": "tenuto",
    "marcato": "strong-accent", "marc": "strong-accent",
    "staccatissimo": "staccatissimo", "stiss": "staccatissimo",
    "fermata": "fermata", "fer": "fermata",
    "trill": "trill-mark", "tr": "trill-mark",
    "mordent": "mordent", "mor": "mordent",
    "turn": "turn",
    "arpeggio": "arpeggiate", "arp": "arpeggiate",
    "upbow": "up-bow", "up-bow": "up-bow",
    "downbow": "down-bow", "down-bow": "down-bow",
    "slur-start": "slur-start", "slur(": "slur-start",
    "slur-end": "slur-end", "slur-stop": "slur-end", "slur)": "slur-end",
    "cresc-start": "cresc-start", "cresc(": "cresc-start", "crescendo-start": "cresc-start",
    "cresc-end": "wedge-end", "cresc-stop": "wedge-end", "cresc)": "wedge-end",
    "dim-start": "dim-start", "dim(": "dim-start", "decresc-start": "dim-start", "diminuendo-start": "dim-start",
    "dim-end": "wedge-end", "dim-stop": "wedge-end", "dim)": "wedge-end", "decresc-end": "wedge-end",
}
CLEFS = {"treble", "bass", "alto", "tenor", "treble8vb", "treble8va", "bass8vb", "percussion", "soprano", "mezzo"}

_PITCH = r"[A-G](?:##|bb|#|b|n)?-?\d"
_EVENT = re.compile(
    rf"^(?P<pitches>R|r|{_PITCH}(?:\+{_PITCH})*)"
    r"(?:/(?P<den>1|2|4|8|16|32|64|128)(?P<dots>\.{0,3}))?"
    r"(?P<tie>~)?"
    r"(?P<ann>!.*)?$"
)
_ONE_PITCH = re.compile(r"^(?P<step>[A-G])(?P<acc>##|bb|#|b|n)?(?P<oct>-?\d)$")
_TUPLET_OPEN = re.compile(r"^(?P<a>\d+)(?::(?P<n>\d+))?\($")


@dataclass
class Pitch:
    step: str
    octave: int
    acc: str | None = None          # accidental printed in front of the note, if any
    alter: int = 0                  # resolved: key signature + accidentals carried through the bar
    tie_stop: bool = False

    @property
    def midi(self) -> int:
        return 12 * (self.octave + 1) + {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[self.step] + self.alter


@dataclass
class Ev:
    kind: str                                        # note | rest | mrest | clef
    pitches: list[Pitch] = field(default_factory=list)
    dur: Fraction = Fraction(0)                      # quarter notes, tuplets applied; 0 for grace notes
    type: str = "quarter"
    dots: int = 0
    tie: bool = False                                # tie starts here
    grace: bool = False
    tuplet: tuple[int, int] | None = None
    tuplet_pos: str | None = None                    # start | stop | None
    marks: list[str] = field(default_factory=list)   # MusicXML-ish names: staccato, fermata, slur-start...
    dynamics: list[str] = field(default_factory=list)
    words: list[str] = field(default_factory=list)
    tempo_text: str | None = None
    bpm: float | None = None
    chord: str | None = None
    lyrics: dict[int, str] = field(default_factory=dict)
    pedal: str | None = None
    fingering: str | None = None
    clef: str | None = None
    source: str = ""                                 # the token as written, for error messages

    @property
    def is_timed(self) -> bool:
        return self.kind in ("note", "rest") and not self.grace


def tokenize(text: str) -> list[str]:
    """Splits on spaces outside quotes, and separates group brackets the model glued to a note."""
    raw, cur, inq = [], [], False
    for ch in text.strip():
        if ch == '"':
            inq = not inq
            cur.append(ch)
        elif ch.isspace() and not inq:
            if cur:
                raw.append("".join(cur))
                cur = []
        else:
            cur.append(ch)
    if cur:
        raw.append("".join(cur))
    out: list[str] = []
    for tok in raw:
        m = re.match(r"^(\d+(?::\d+)?\(|g\()(.+)$", tok)          # "3(C5/8" -> "3(", "C5/8"
        if m:
            out.append(m.group(1))
            tok = m.group(2)
        closers = 0
        while tok.endswith(")") and tok != ")" and not re.search(r"!(slur|cresc|dim)\)$", tok):
            tok, closers = tok[:-1], closers + 1                   # "E5/8)" -> "E5/8", ")"
        out.append(tok)
        out.extend([")"] * closers)
    return [t for t in out if t]


def _parse_marks(s: str, ev: Ev, errors: list[str]) -> None:
    i = 0
    while i < len(s):
        if s[i] != "!":
            errors.append(f"unexpected '{s[i:]}' in {ev.source}")
            return
        m = re.match(r"[A-Za-z0-9\-()<>]+", s[i + 1:])
        if not m:
            errors.append(f"empty mark in {ev.source}")
            return
        name = m.group(0).lower()
        j = i + 1 + len(m.group(0))
        val = None
        if j < len(s) and s[j] == "=":
            j += 1
            if j < len(s) and s[j] == '"':
                k = s.find('"', j + 1)
                if k < 0:
                    errors.append(f"unclosed quote in {ev.source}")
                    return
                val, j = s[j + 1:k], k + 1
            else:
                m2 = re.match(r"[^!]*", s[j:])
                val = m2.group(0)
                j += len(val)
        i = j
        if name in SIMPLE_MARKS:
            ev.marks.append(SIMPLE_MARKS[name])
        elif name in DYNAMICS:
            ev.dynamics.append(name)
        elif name in ("dyn", "dynamic") and val:
            if val.lower() in DYNAMICS:
                ev.dynamics.append(val.lower())
            else:
                ev.words.append(val)
        elif name in ("words", "text", "expr"):
            if val:
                ev.words.append(val)
        elif name == "tempo":
            ev.tempo_text = val or ev.tempo_text
        elif name in ("bpm", "metronome"):
            try:
                ev.bpm = float(re.sub(r"[^\d.]", "", val or ""))
            except ValueError:
                errors.append(f"bad bpm in {ev.source}")
        elif name in ("chord", "harmony"):
            ev.chord = val
        elif re.fullmatch(r"(ly|lyric|lyrics)(\d?)", name):
            n = re.fullmatch(r"(ly|lyric|lyrics)(\d?)", name).group(2)
            if val is not None:
                ev.lyrics[int(n or 1)] = val
        elif name in ("ped", "pedal"):
            ev.pedal = (val or "start").lower()
        elif name in ("fing", "finger", "fingering"):
            ev.fingering = val
        else:
            pass                                    # unknown marks are ignored, never fatal


def _base_len(den: int, dots: int) -> Fraction:
    base = Fraction(4, den)
    return base * (2 - Fraction(1, 2 ** dots))


def parse_voice(text: str) -> tuple[list[Ev], list[str]]:
    """Parses one voice of one bar. Returns (events, errors); never raises."""
    events: list[Ev] = []
    errors: list[str] = []
    stack: list[dict] = []
    for tok in tokenize(text or ""):
        if tok == ")":
            if not stack:
                errors.append("')' without an opening group")
                continue
            grp = stack.pop()
            if grp["kind"] == "tuplet":
                timed = [e for e in events[grp["first"]:] if e.is_timed]
                if len(timed) > 1:                       # a bracket needs a first and a last note
                    timed[0].tuplet_pos = "start"
                    timed[-1].tuplet_pos = "stop"
            continue
        m = _TUPLET_OPEN.match(tok)
        if m:
            a = int(m.group("a"))
            n = int(m.group("n")) if m.group("n") else {2: 3, 3: 2, 4: 3, 5: 4, 6: 4, 7: 4, 9: 8, 10: 8, 11: 8, 12: 8}.get(a, max(1, a - 1))
            stack.append({"kind": "tuplet", "a": a, "n": n, "first": len(events)})
            continue
        if tok == "g(":
            stack.append({"kind": "grace", "first": len(events)})
            continue
        if tok.lower().startswith("clef="):
            c = tok.split("=", 1)[1].strip('"').lower()
            if c in CLEFS:
                events.append(Ev(kind="clef", clef=c, source=tok))
            else:
                errors.append(f"unknown clef '{c}'")
            continue
        m = _EVENT.match(tok)
        if not m and tok[:1].islower() and tok[:1] in "abcdefg":
            m = _EVENT.match(tok[:1].upper() + tok[1:])
        if not m:
            errors.append(f"can't read '{tok}'")
            continue
        ev = Ev(kind="note", source=tok)
        ps = m.group("pitches")
        den = m.group("den")
        dots = len(m.group("dots") or "")
        if ps == "R":
            ev.kind = "mrest"
            ev.type = "whole"
        else:
            if den is None:
                errors.append(f"'{tok}' has no length (add /4, /8 ...)")
                continue
            ev.type = DEN_TYPE[int(den)]
            ev.dots = dots
            ev.dur = _base_len(int(den), dots)
            if ps == "r":
                ev.kind = "rest"
            else:
                for p in ps.split("+"):
                    pm = _ONE_PITCH.match(p)
                    ev.pitches.append(Pitch(step=pm.group("step"), octave=int(pm.group("oct")), acc=pm.group("acc")))
        ev.tie = bool(m.group("tie")) and ev.kind == "note"
        if m.group("ann"):
            _parse_marks(m.group("ann"), ev, errors)
        for grp in stack:
            if grp["kind"] == "grace":
                ev.grace = True
                ev.dur = Fraction(0)
            elif grp["kind"] == "tuplet" and ev.kind in ("note", "rest"):
                ev.tuplet = (grp["a"], grp["n"])
                ev.dur = ev.dur * Fraction(grp["n"], grp["a"])
        events.append(ev)
    if stack:
        errors.append("a '(' group was not closed")
    return events, errors


def voice_length(events: list[Ev]) -> Fraction | None:
    """Sum of the timed events in quarter notes; None for a whole-bar rest."""
    if any(e.kind == "mrest" for e in events):
        return None
    return sum((e.dur for e in events if e.is_timed), Fraction(0))


def measure_length(time: tuple[int, int]) -> Fraction:
    beats, beat_type = time
    return Fraction(beats * 4, beat_type)


SHARP_ORDER = "FCGDAEB"
FLAT_ORDER = "BEADGCF"


def key_alters(fifths: int) -> dict[str, int]:
    if fifths > 0:
        return {s: 1 for s in SHARP_ORDER[:min(7, fifths)]}
    if fifths < 0:
        return {s: -1 for s in FLAT_ORDER[:min(7, -fifths)]}
    return {}


def onsets(events: list[Ev]) -> list[Fraction]:
    """Start time of each event in the bar (grace notes take the time of the note they lead into)."""
    out, t = [], Fraction(0)
    pending: list[int] = []
    for i, e in enumerate(events):
        if e.grace:
            pending.append(i)
            out.append(t)
            continue
        out.append(t)
        for k in pending:
            out[k] = t
        pending = []
        if e.is_timed:
            t += e.dur
    return out


def resolve_alters(voices: list[list[Ev]], fifths: int, tied_in: dict[int, Ev | None] | None = None) -> None:
    """Applies the key signature and accidentals that carry through the bar to every note of one staff.

    `voices` are the voices of ONE staff in ONE bar (accidentals carry across voices of a staff).
    `tied_in[v]` is the last event of voice v in the previous bar: a note tied from it keeps its spelling.
    """
    ka = key_alters(fifths)
    carry: dict[tuple[str, int], int] = {}
    # 1. find where each tie comes from (walk every voice in order; the first note may be in the previous bar)
    tie_src: dict[int, Pitch] = {}                  # id(pitch) -> the pitch it is tied from
    for vi, evs in enumerate(voices):
        prev = (tied_in or {}).get(vi)
        for e in evs:
            if e.kind == "clef":
                continue
            if e.kind == "note" and prev is not None and prev.kind == "note" and prev.tie:
                for p in e.pitches:
                    src = next((q for q in prev.pitches if q.step == p.step and q.octave == p.octave), None)
                    if src is not None:
                        p.tie_stop = True
                        tie_src[id(p)] = src
            if not e.grace:
                prev = e
    # 2. resolve in time order across the voices of the staff
    items = []
    for vi, evs in enumerate(voices):
        for i, (e, t) in enumerate(zip(evs, onsets(evs))):
            if e.kind == "note":
                items.append((t, 0 if e.grace else 1, vi, i, e))
    items.sort(key=lambda x: (x[0], x[1], x[2], x[3]))
    for _, _, _, _, e in items:
        for p in e.pitches:
            key = (p.step, p.octave)
            if p.acc is not None:
                p.alter = ACCIDENTALS[p.acc]
                carry[key] = p.alter
            elif id(p) in tie_src:
                p.alter = tie_src[id(p)].alter       # a tied-over note keeps its spelling, without carrying it on
            elif key in carry:
                p.alter = carry[key]
            else:
                p.alter = ka.get(p.step, 0)
