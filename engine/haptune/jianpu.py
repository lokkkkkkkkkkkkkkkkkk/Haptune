"""Jianpu (简谱, numbered notation) text import.

Widely used for erhu, guzheng, dizi, pipa, choirs and pop songbooks across
Malaysia, Taiwan and China. Learners can type it in a minute, no PDF needed.

Format
------
    title: 茉莉花
    key: 1=F          (the note that "1" sounds; C D E F G A B with # or b, e.g. 1=bB, 1=F#)
    time: 2/4
    tempo: 72         (quarter-note beats per minute)
    octave: 4         (octave of the middle "1", default 4 => 1=C means C4)
    ---
    3 3 5 6 | 1' 1' 6 5 | 5 5 6 - | 5 - - - ||

Tokens (separated by spaces or bar lines):
    1..7    scale degrees, 0 = rest
    #5 b7   sharpened / flattened degree
    1' 1''  octave(s) up (also 1^),   1, 1,,  octave(s) down
    5_ 5__  eighth / sixteenth (each _ halves the duration)
    5.      dotted (x1.5);  5_. = dotted eighth
    -       holds the previous note one more beat
    |  ||   bar lines;  |: and :| repeat signs
    ~       tie to the next note (same pitch), e.g. 5~ 5
    Lines starting with # are comments.
"""
from __future__ import annotations

import re

from .score import STEP_SEMITONE, Measure, Note, Part, Score

MAJOR = [0, 2, 4, 5, 7, 9, 11]
_TOKEN = re.compile(r"^([#b]?)([0-7])((?:'|\^|,)*)([_]*)(\.?)(~?)$")


def parse_jianpu(text: str, instrument: str = "") -> Score:
    header, body = {}, []
    in_body = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line == "---":
            in_body = True
            continue
        m = re.match(r"^([A-Za-z]+)\s*[:：]\s*(.+)$", line)
        if m and not in_body:
            header[m.group(1).lower()] = m.group(2).strip()
        else:
            in_body = True
            body.append(line)
    key = header.get("key", "1=C").replace(" ", "")
    km = re.match(r"^1=([#b]?)([A-Ga-g])([#b]?)$", key)
    if not km:
        raise ValueError(f"bad key '{key}', expected e.g. 1=C, 1=F#, 1=bB")
    acc = (km.group(1) or km.group(3))
    tonic_pc = STEP_SEMITONE[km.group(2).upper()] + (1 if acc == "#" else -1 if acc == "b" else 0)
    octave = int(header.get("octave", "4"))
    tonic = 12 * (octave + 1) + tonic_pc
    num, den = (int(x) for x in header.get("time", "4/4").split("/"))
    qpm = float(re.findall(r"[\d.]+", header.get("tempo", "80"))[0])
    measure_len = num * 4.0 / den

    # notes may be glued together the way people type them ("3_5_6_"), so scan instead of split
    tokens = re.findall(r"\|\||\|:|:\||\||-|[#b]?[0-7](?:'|\^|,|’|·)*_*\.?~?", " ".join(body))
    notes: list[Note] = []
    measures_src: list[list[tuple]] = [[]]      # per printed measure: (onset_in_measure, dur, pitch|None, tie)
    repeat_marks: list[tuple] = []              # (measure_index, 'start'|'end')
    t = 0.0
    for tok in tokens:
        if tok in ("|", "||"):
            measures_src.append([])
            t = 0.0
            continue
        if tok == "|:":
            if measures_src[-1]:
                measures_src.append([])
                t = 0.0
            repeat_marks.append((len(measures_src) - 1, "start"))
            continue
        if tok == ":|":
            repeat_marks.append((len(measures_src) - 1, "end"))
            measures_src.append([])
            t = 0.0
            continue
        if tok == "-":
            if measures_src[-1]:
                on, d, p, tie = measures_src[-1][-1]
                measures_src[-1][-1] = (on, d + 1.0, p, tie)
            else:                                       # dash continuing across a bar line
                for ms in reversed(measures_src[:-1]):
                    if ms:
                        measures_src[-1].append((0.0, 1.0, ms[-1][2], False))
                        ms[-1] = (*ms[-1][:3], True)
                        break
            t += 1.0
            continue
        m = _TOKEN.match(tok.replace("’", "'").replace("·", "'"))
        if not m:
            raise ValueError(f"cannot read jianpu token '{tok}'")
        accd, deg, octs, unders, dot, tie = m.groups()
        dur = 1.0 / (2 ** len(unders))
        if dot:
            dur *= 1.5
        if deg == "0":
            pitch = None
        else:
            pitch = tonic + MAJOR[int(deg) - 1] + (1 if accd == "#" else -1 if accd == "b" else 0)
            pitch += 12 * (octs.count("'") + octs.count("^")) - 12 * octs.count(",")
        measures_src[-1].append((t, dur, pitch, bool(tie)))
        t += dur
    measures_src = [m for m in measures_src if m] or [[]]

    # repeats (simple |: ... :| sections)
    order: list[int] = []
    start = 0
    ends = {i for i, kind in repeat_marks if kind == "end"}
    starts = {i for i, kind in repeat_marks if kind == "start"}
    i = 0
    repeated = set()
    while i < len(measures_src):
        if i in starts:
            start = i
        order.append(i)
        if i in ends and i not in repeated:
            repeated.add(i)
            i = start
            continue
        i += 1

    score_notes: list[Note] = []
    measures: list[Measure] = []
    pos = 0.0
    k = 0
    pending_tie: Note | None = None
    for mi, src in enumerate(order):
        content = measures_src[src]
        filled = max((on + d for on, d, _, _ in content), default=0.0)
        # a short first bar is a pickup (anacrusis); every other bar is at least a full bar
        length = filled if (mi == 0 and 0 < filled < measure_len) else max(measure_len, filled)
        measures.append(Measure(mi, str(src + 1), pos, length, (num, den), 0, "major", src))
        for on, d, p, tie in content:
            if p is None:
                pending_tie = None
                continue
            if pending_tie is not None and pending_tie.pitch == p:
                pending_tie.duration += d
                pending_tie = pending_tie if tie else None
                continue
            k += 1
            n = Note(id=f"J-{mi}-{k}", part="J", measure=mi, onset=pos + on, duration=d, pitch=p, written=p,
                     src_index=k)
            score_notes.append(n)
            pending_tie = n if tie else None
        pos += length
    fifths = {0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5}.get(tonic_pc % 12, 0)
    for m in measures:
        m.key_fifths = fifths
    return Score(title=header.get("title", ""), composer=header.get("composer", ""),
                 parts=[Part("J", header.get("instrument", instrument) or "Melody",
                             header.get("instrument", instrument) or "")],
                 notes=score_notes, measures=measures, tempos=[(0.0, qpm)],
                 source={"format": "jianpu", "key": key})
