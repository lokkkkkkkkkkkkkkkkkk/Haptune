"""Score model and loaders.

The whole engine works on one canonical, flattened representation of a piece
(`Score`): every sounding note with its onset/duration in quarter-note beats
in *performance order* (repeats unrolled, ties merged) and its *sounding*
MIDI pitch. The same structure is serialised to JSON
("haptune.score/1") and decoded by the Swift app, so the phone, the
Watch and the server all agree on note ids, bar numbers and timing.

Loaders: MusicXML (.musicxml/.xml/.mxl), MIDI (.mid), JSON, jianpu text
(see jianpu.py) and PDF/images through OMR (see omr.py).
"""
from __future__ import annotations

import bisect
import io
import json
import os
import re
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field, replace
from fractions import Fraction
from typing import Iterable

SCHEMA = "haptune.score/1"
STEP_SEMITONE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
NOTE_NAMES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def midi_name(m: int | None, flats: bool = False) -> str:
    if m is None:
        return "rest"
    names = NOTE_NAMES_FLAT if flats else NOTE_NAMES_SHARP
    return f"{names[m % 12]}{m // 12 - 1}"


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------
@dataclass
class Note:
    id: str
    part: str
    measure: int            # 0-based index into Score.measures (performance order)
    onset: float            # quarter-note beats from the start of the performance
    duration: float         # quarter-note beats
    pitch: int | None       # sounding MIDI pitch (None = unpitched / percussion)
    written: int | None = None   # written MIDI pitch (what the player reads)
    voice: str = "1"
    staff: int = 1
    grace: bool = False
    src_index: int = 0      # order of the note in the source file (for highlighting)

    def to_json(self) -> dict:
        return {"id": self.id, "part": self.part, "m": self.measure, "on": round(self.onset, 6),
                "dur": round(self.duration, 6), "p": self.pitch, "w": self.written,
                "v": self.voice, "st": self.staff, "g": self.grace, "src": self.src_index}

    @staticmethod
    def from_json(d: dict) -> "Note":
        return Note(id=d["id"], part=d["part"], measure=d["m"], onset=d["on"], duration=d["dur"],
                    pitch=d.get("p"), written=d.get("w"), voice=str(d.get("v", "1")),
                    staff=int(d.get("st", 1)), grace=bool(d.get("g", False)),
                    src_index=int(d.get("src", 0)))


@dataclass
class Measure:
    index: int              # performance-order index
    label: str              # printed bar number ("1", "2", "12a" ...)
    start: float            # beats
    duration: float         # beats
    time_sig: tuple = (4, 4)
    key_fifths: int = 0
    key_mode: str = "major"
    src: int = 0            # index of the source (printed) measure

    def to_json(self) -> dict:
        return {"i": self.index, "label": self.label, "start": round(self.start, 6),
                "dur": round(self.duration, 6), "time": list(self.time_sig),
                "key": [self.key_fifths, self.key_mode], "src": self.src}

    @staticmethod
    def from_json(d: dict) -> "Measure":
        return Measure(index=d["i"], label=str(d["label"]), start=d["start"], duration=d["dur"],
                       time_sig=tuple(d.get("time", (4, 4))), key_fifths=d.get("key", [0])[0],
                       key_mode=d.get("key", [0, "major"])[1], src=d.get("src", d["i"]))


@dataclass
class Part:
    id: str
    name: str = ""
    instrument: str = ""     # instrument profile key (guess) – user can override
    transpose: int = 0       # written -> sounding semitones
    midi_program: int | None = None


@dataclass
class Event:
    """Notes that start together (a chord, or a single note)."""
    index: int
    onset: float
    notes: list

    @property
    def pitches(self) -> list[int]:
        return sorted({n.pitch for n in self.notes if n.pitch is not None})

    @property
    def measure(self) -> int:
        return self.notes[0].measure

    @property
    def duration(self) -> float:
        return max(n.duration for n in self.notes)


@dataclass
class Score:
    title: str = ""
    composer: str = ""
    parts: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    measures: list = field(default_factory=list)
    tempos: list = field(default_factory=lambda: [(0.0, 100.0)])   # (beat, quarter-notes/min)
    source: dict = field(default_factory=dict)

    # ---------------- timing -------------------------------------------------
    def _tempo_segments(self):
        tempos = sorted(self.tempos or [(0.0, 100.0)])
        if tempos[0][0] > 0:
            tempos = [(0.0, tempos[0][1])] + tempos
        segs, sec = [], 0.0
        for i, (b, q) in enumerate(tempos):
            segs.append((b, sec, q))
            if i + 1 < len(tempos):
                sec += (tempos[i + 1][0] - b) * 60.0 / q
        return segs

    def beat_to_sec(self, beat: float) -> float:
        segs = self._tempo_segments()
        idx = bisect.bisect_right([s[0] for s in segs], beat) - 1
        b0, s0, q = segs[max(idx, 0)]
        return s0 + (beat - b0) * 60.0 / q

    def sec_to_beat(self, sec: float) -> float:
        segs = self._tempo_segments()
        idx = bisect.bisect_right([s[1] for s in segs], sec) - 1
        b0, s0, q = segs[max(idx, 0)]
        return b0 + (sec - s0) * q / 60.0

    def with_tempo(self, qpm: float) -> "Score":
        """Same piece at one fixed tempo (used for practice at a chosen speed)."""
        return replace(self, tempos=[(0.0, float(qpm))])

    def scaled_tempo(self, factor: float) -> "Score":
        return replace(self, tempos=[(b, q * factor) for b, q in self.tempos])

    @property
    def length_beats(self) -> float:
        if self.measures:
            last = self.measures[-1]
            return last.start + last.duration
        return max((n.onset + n.duration for n in self.notes), default=0.0)

    @property
    def length_sec(self) -> float:
        return self.beat_to_sec(self.length_beats)

    @property
    def first_tempo(self) -> float:
        return sorted(self.tempos)[0][1] if self.tempos else 100.0

    # ---------------- selection ---------------------------------------------
    def playable_notes(self, include_grace: bool = False) -> list[Note]:
        return [n for n in self.notes if (include_grace or not n.grace)]

    def select_parts(self, part_ids: Iterable[str] | None = None, staff: int | None = None) -> "Score":
        ids = set(part_ids) if part_ids else {p.id for p in self.parts}
        notes = [n for n in self.notes if n.part in ids and (staff is None or n.staff == staff)]
        parts = [p for p in self.parts if p.id in ids]
        return replace(self, notes=notes, parts=parts)

    def slice_measures(self, first: int, last: int) -> "Score":
        """Measures first..last (0-based, inclusive), re-based to start at beat 0."""
        ms = self.measures[first:last + 1]
        if not ms:
            raise ValueError("empty measure range")
        b0 = ms[0].start
        b1 = ms[-1].start + ms[-1].duration
        notes = [replace(n, onset=n.onset - b0, measure=n.measure - first)
                 for n in self.notes if b0 - 1e-9 <= n.onset < b1 - 1e-9]
        measures = [replace(m, index=m.index - first, start=m.start - b0) for m in ms]
        tempos = []
        for b, q in sorted(self.tempos):
            if b <= b0:
                tempos = [(0.0, q)]
            elif b < b1:
                tempos.append((b - b0, q))
        return replace(self, notes=notes, measures=measures, tempos=tempos or [(0.0, self.first_tempo)])

    def events(self, tolerance_beats: float = 1e-4, include_grace: bool = False) -> list[Event]:
        notes = sorted(self.playable_notes(include_grace), key=lambda n: (n.onset, n.pitch or 0))
        events: list[Event] = []
        for n in notes:
            if events and abs(n.onset - events[-1].onset) <= tolerance_beats:
                events[-1].notes.append(n)
            else:
                events.append(Event(len(events), n.onset, [n]))
        return events

    def measure_at(self, beat: float) -> int:
        starts = [m.start for m in self.measures]
        return max(0, bisect.bisect_right(starts, beat + 1e-9) - 1)

    def key_at(self, beat: float) -> tuple[int, str]:
        if not self.measures:
            return (0, "major")
        m = self.measures[self.measure_at(beat)]
        return m.key_fifths, m.key_mode

    def pitch_range(self) -> tuple[int, int] | None:
        ps = [n.pitch for n in self.notes if n.pitch is not None]
        return (min(ps), max(ps)) if ps else None

    # ---------------- serialisation -----------------------------------------
    def to_json(self) -> dict:
        return {
            "schema": SCHEMA, "title": self.title, "composer": self.composer,
            "source": self.source,
            "parts": [asdict(p) for p in self.parts],
            "measures": [m.to_json() for m in self.measures],
            "tempos": [[round(b, 6), round(q, 4)] for b, q in self.tempos],
            "notes": [n.to_json() for n in self.notes],
        }

    def save_json(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_json(), f, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def from_json(d: dict) -> "Score":
        if d.get("schema") != SCHEMA:
            raise ValueError(f"not a {SCHEMA} document")
        return Score(title=d.get("title", ""), composer=d.get("composer", ""),
                     parts=[Part(**p) for p in d.get("parts", [])],
                     notes=[Note.from_json(n) for n in d.get("notes", [])],
                     measures=[Measure.from_json(m) for m in d.get("measures", [])],
                     tempos=[tuple(t) for t in d.get("tempos", [[0, 100]])],
                     source=d.get("source", {}))


# ---------------------------------------------------------------------------
# MusicXML
# ---------------------------------------------------------------------------
def _strip_ns(root: ET.Element) -> ET.Element:
    for el in root.iter():
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    return root


def _read_musicxml_bytes(path_or_bytes) -> bytes:
    if isinstance(path_or_bytes, (bytes, bytearray)):
        data = bytes(path_or_bytes)
    else:
        with open(path_or_bytes, "rb") as f:
            data = f.read()
    if data[:2] == b"PK":                                   # compressed .mxl
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            rootfile = None
            if "META-INF/container.xml" in z.namelist():
                c = _strip_ns(ET.fromstring(z.read("META-INF/container.xml")))
                rf = c.find(".//rootfile")
                if rf is not None:
                    rootfile = rf.get("full-path")
            if not rootfile:
                rootfile = next(n for n in z.namelist()
                                if n.lower().endswith((".xml", ".musicxml")) and not n.startswith("META-INF"))
            data = z.read(rootfile)
    return data


def _txt(el: ET.Element | None, path: str, default=None):
    if el is None:
        return default
    x = el.find(path)
    return x.text.strip() if x is not None and x.text is not None else default


@dataclass
class _SrcMeasure:
    number: str
    length: Fraction
    notes: list                 # (onset Fraction, dur Fraction, pitch|None, written|None, voice, staff, grace, tie_start, tie_stop, src_index)
    tempos: list                # (onset Fraction, qpm)
    time_sig: tuple
    key: tuple
    forward: bool = False
    backward_times: int = 0
    ending_numbers: frozenset | None = None
    ending_start: bool = False
    ending_stop: bool = False
    implicit: bool = False
    jumps: dict = field(default_factory=dict)   # dacapo/dalsegno/segno/fine/tocoda/coda


GRID = 96  # onsets/durations are snapped to 1/96 of a quarter note (fixes rounded tuplet exports)


def _snap(x: Fraction) -> Fraction:
    return Fraction(round(x * GRID), GRID)


def _parse_ending_numbers(s: str | None) -> frozenset:
    nums = set()
    for tok in re.split(r"[,\s]+", s or ""):
        if tok.isdigit():
            nums.add(int(tok))
    return frozenset(nums or {1})


def _parse_part(part_el: ET.Element, transpose_default: int, part_id: str, src_counter: list) -> list[_SrcMeasure]:
    divisions = Fraction(1)
    time_sig, key = (4, 4), (0, "major")
    transpose = transpose_default
    out: list[_SrcMeasure] = []
    for m_el in part_el.findall("measure"):
        t = Fraction(0)
        max_t = Fraction(0)
        last_onset = Fraction(0)
        notes, tempos = [], []
        forward = ending_start = ending_stop = False
        backward_times = 0
        ending_numbers = None
        for el in m_el:
            tag = el.tag
            if tag == "attributes":
                d = _txt(el, "divisions")
                if d:
                    divisions = Fraction(d)
                k = el.find("key")
                if k is not None and _txt(k, "fifths") is not None:
                    key = (int(_txt(k, "fifths")), _txt(k, "mode", "major") or "major")
                ts = el.find("time")
                if ts is not None and _txt(ts, "beats"):
                    beats = sum(int(x) for x in re.findall(r"\d+", _txt(ts, "beats")))
                    time_sig = (beats, int(_txt(ts, "beat-type", "4")))
                tr = el.find("transpose")
                if tr is not None:
                    transpose = int(float(_txt(tr, "chromatic", "0"))) + 12 * int(_txt(tr, "octave-change", "0") or 0)
            elif tag == "backup":
                t -= Fraction(_txt(el, "duration", "0")) / divisions
                t = max(t, Fraction(0))
            elif tag == "forward":
                t += Fraction(_txt(el, "duration", "0")) / divisions
                max_t = max(max_t, t)
            elif tag == "direction" or tag == "sound":
                snd = el if tag == "sound" else el.find("sound")
                offset = Fraction(_txt(el, "offset", "0")) / divisions if tag == "direction" else Fraction(0)
                qpm = None
                if snd is not None and snd.get("tempo"):
                    try:
                        qpm = float(snd.get("tempo"))
                    except ValueError:
                        qpm = None
                if qpm is None and tag == "direction":
                    mt = el.find(".//metronome")
                    if mt is not None and _txt(mt, "per-minute"):
                        unit = {"whole": 4, "half": 2, "quarter": 1, "eighth": 0.5, "16th": 0.25}.get(
                            _txt(mt, "beat-unit", "quarter"), 1)
                        if mt.find("beat-unit-dot") is not None:
                            unit *= 1.5
                        try:
                            qpm = float(re.findall(r"[\d.]+", _txt(mt, "per-minute"))[0]) * unit
                        except (IndexError, ValueError):
                            qpm = None
                if qpm and qpm > 0:
                    tempos.append((t + offset, qpm))
            elif tag == "barline":
                rep = el.find("repeat")
                if rep is not None:
                    if rep.get("direction") == "forward":
                        forward = True
                    elif rep.get("direction") == "backward":
                        backward_times = int(rep.get("times", "2") or 2)
                end = el.find("ending")
                if end is not None:
                    typ = end.get("type", "start")
                    if typ == "start":
                        ending_start = True
                        ending_numbers = _parse_ending_numbers(end.get("number"))
                    elif typ in ("stop", "discontinue"):
                        ending_stop = True
                        if ending_numbers is None:
                            ending_numbers = _parse_ending_numbers(end.get("number"))
            elif tag == "note":
                is_chord = el.find("chord") is not None
                is_grace = el.find("grace") is not None
                is_cue = el.find("cue") is not None
                dur = Fraction(_txt(el, "duration", "0") or "0") / divisions
                onset = last_onset if is_chord else t
                pitch = written = None
                p = el.find("pitch")
                if p is not None:
                    alter = float(_txt(p, "alter", "0") or 0)
                    written = 12 * (int(_txt(p, "octave", "4")) + 1) + STEP_SEMITONE[_txt(p, "step", "C")] + int(round(alter))
                    pitch = written + transpose
                is_rest = el.find("rest") is not None
                unpitched = el.find("unpitched") is not None
                ties = {x.get("type") for x in el.findall("tie")}
                ties |= {x.get("type") for x in el.findall("notations/tied")}
                if not is_rest and not is_cue and (pitch is not None or unpitched):
                    src_counter[0] += 1
                    notes.append((_snap(onset), _snap(dur) if not is_grace else Fraction(1, 16), pitch, written,
                                  _txt(el, "voice", "1") or "1", int(_txt(el, "staff", "1") or 1),
                                  is_grace, "start" in ties or "continue" in ties,
                                  "stop" in ties or "continue" in ties, src_counter[0]))
                if not is_chord and not is_grace:
                    last_onset = t
                    t += dur
                    max_t = max(max_t, t)
        nominal = Fraction(time_sig[0] * 4, time_sig[1])
        length = _snap(max_t) if max_t > 0 else nominal
        implicit = m_el.get("implicit") == "yes"
        jumps = _measure_jumps(m_el)
        out.append(_SrcMeasure(number=m_el.get("number", str(len(out) + 1)), length=length,
                               notes=notes, tempos=tempos, time_sig=time_sig, key=key,
                               forward=forward, backward_times=backward_times,
                               ending_numbers=ending_numbers, ending_start=ending_start,
                               ending_stop=ending_stop, implicit=implicit, jumps=jumps))
    return out


def _measure_jumps(m_el: ET.Element) -> dict:
    """Navigation marks of one measure: <sound> playback attributes first, printed words as fallback."""
    j: dict = {}
    for snd in m_el.iter("sound"):
        for k in ("dacapo", "dalsegno", "segno", "fine", "tocoda", "coda"):
            v = snd.get(k)
            if v and v.lower() != "no":
                j[k] = v
    for w in m_el.iter("words"):
        t = (w.text or "").strip().lower().replace(" ", "")
        if not t:
            continue
        if t.startswith(("d.c.", "dc.", "dacapo")) and "dacapo" not in j and "dalsegno" not in j:
            j["dacapo"] = "yes"
            if "alcoda" in t:
                j["al_coda"] = True
        elif t.startswith(("d.s.", "ds.", "dalsegno")) and "dalsegno" not in j and "dacapo" not in j:
            j["dalsegno"] = "segno"
            if "alcoda" in t:
                j["al_coda"] = True
        elif t in ("fine", "fine.") and "fine" not in j:
            j["fine"] = "yes"
        elif t.startswith(("tocoda", "alcoda")) and "tocoda" not in j:
            j["tocoda"] = "coda"
    for dt in m_el.iter("direction-type"):
        if dt.find("segno") is not None and "segno" not in j:
            j["segno"] = "segno"
        if dt.find("coda") is not None and "coda" not in j:
            j["coda_sign"] = True
    return j


def unroll_repeats(measures: list[_SrcMeasure], expand: bool = True) -> list[int]:
    """Performance order of source measure indices.

    Handles repeat barlines, 1st/2nd endings, D.C. / D.S. (al Fine / al Coda),
    Fine and To Coda. A backward repeat without a forward repeat returns to the
    bar after the previous repeat (or to the beginning). After a D.C./D.S. jump,
    repeats are not taken again (the usual convention).
    """
    n = len(measures)
    if not expand or n == 0:
        return list(range(n))
    ending_of: list = [None] * n
    span_end: list = [None] * n
    i = 0
    while i < n:
        if measures[i].ending_start:
            nums = measures[i].ending_numbers
            j = i
            while j < n - 1 and not measures[j].ending_stop and not measures[j + 1].ending_start:
                j += 1
            for k in range(i, j + 1):
                ending_of[k] = nums
                span_end[k] = j
            i = j + 1
        else:
            i += 1
    segno_at = {m.jumps["segno"]: idx for idx, m in enumerate(measures) if "segno" in m.jumps}
    coda_at = {m.jumps["coda"]: idx for idx, m in enumerate(measures) if "coda" in m.jumps}
    coda_signs = [idx for idx, m in enumerate(measures) if m.jumps.get("coda_sign")]

    def coda_target(name: str, after: int):
        if name in coda_at:
            return coda_at[name]
        later = [c for c in coda_signs if c > after]
        return later[-1] if later else None

    order: list[int] = []
    counts: dict[int, int] = {}
    i, section_start, pass_no, volta_active, jumped, guard = 0, 0, 1, False, False, 0
    while i < n and guard < 40 * n + 100:
        guard += 1
        m = measures[i]
        if m.forward and i != section_start and not jumped:
            section_start, pass_no = i, 1
        if ending_of[i] is None and volta_active:
            section_start, pass_no, volta_active = i, 1, False
        if ending_of[i] is not None:
            volta_active = True
            wanted = max(ending_of[i]) if jumped else pass_no   # after D.C. take the last ending
            if wanted not in ending_of[i]:
                i = span_end[i] + 1
                continue
        order.append(i)
        if jumped and "fine" in m.jumps:
            break
        if jumped and "tocoda" in m.jumps:
            tgt = coda_target(m.jumps["tocoda"], i)
            if tgt is not None and tgt > i:
                i = tgt
                continue
        if m.backward_times and not jumped:
            c = counts.get(i, 0)
            if c < m.backward_times - 1:
                counts[i] = c + 1
                pass_no += 1
                volta_active = False
                i = section_start
                continue
            counts[i] = 0
            section_start, pass_no = i + 1, 1
        if not jumped and ("dacapo" in m.jumps or "dalsegno" in m.jumps):
            jumped = True
            target = 0
            if "dalsegno" in m.jumps:
                target = segno_at.get(m.jumps["dalsegno"], next(iter(segno_at.values()), 0))
            i, section_start, pass_no, volta_active = target, target, 1, False
            continue
        i += 1
    return order


def load_musicxml(path_or_bytes, expand_repeats: bool = True) -> Score:
    root = _strip_ns(ET.fromstring(_read_musicxml_bytes(path_or_bytes)))
    if root.tag == "score-timewise":
        return _load_with_music21(path_or_bytes, expand_repeats)
    from .instruments import guess_profile

    title = _txt(root, "work/work-title") or _txt(root, "movement-title") or ""
    composer = ""
    for c in root.findall("identification/creator"):
        if c.get("type") == "composer" and c.text:
            composer = c.text.strip()
    if not title:
        for cw in root.findall("credit/credit-words"):
            if cw.text and len(cw.text.strip()) > 1:
                title = cw.text.strip()
                break
    part_info: dict[str, Part] = {}
    for sp in root.findall("part-list/score-part"):
        pid = sp.get("id")
        name = _txt(sp, "part-name", "") or ""
        prog = _txt(sp, "midi-instrument/midi-program")
        inst_name = _txt(sp, "score-instrument/instrument-name", "") or ""
        prof = guess_profile(name + " " + inst_name, int(prog) if prog and prog.isdigit() else None)
        part_info[pid] = Part(id=pid, name=name, instrument=prof.key,
                              midi_program=int(prog) if prog and prog.isdigit() else None)

    src_counter = [0]
    parsed: dict[str, list[_SrcMeasure]] = {}
    for part_el in root.findall("part"):
        pid = part_el.get("id")
        parsed[pid] = _parse_part(part_el, 0, pid, src_counter)
        if pid not in part_info:
            part_info[pid] = Part(id=pid, name=pid)
    if not parsed:
        raise ValueError("No <part> found in MusicXML")
    first = next(iter(parsed.values()))
    n_meas = max(len(v) for v in parsed.values())
    # merge barline / length info across parts (OR of repeat signs, max length)
    merged: list[_SrcMeasure] = []
    for i in range(n_meas):
        cands = [v[i] for v in parsed.values() if i < len(v)]
        base = cands[0]
        merged.append(replace(
            base, length=max(c.length for c in cands),
            forward=any(c.forward for c in cands),
            backward_times=max(c.backward_times for c in cands),
            ending_start=any(c.ending_start for c in cands),
            ending_stop=any(c.ending_stop for c in cands),
            ending_numbers=next((c.ending_numbers for c in cands if c.ending_numbers), None),
            tempos=[tp for c in cands for tp in c.tempos],
            jumps={k: v for c in reversed(cands) for k, v in c.jumps.items()}))
    order = unroll_repeats(merged, expand_repeats)

    # transpose per part from its first measure attributes (already applied in pitches);
    # record it on the Part for display
    for pid, ms in parsed.items():
        for nt in (x for m in ms for x in m.notes):
            if nt[2] is not None and nt[3] is not None:
                part_info[pid].transpose = nt[2] - nt[3]
                break

    measures: list[Measure] = []
    notes: list[Note] = []
    tempos: list[tuple] = []
    start = Fraction(0)
    open_ties: dict[tuple, Note] = {}
    for k, s in enumerate(order):
        sm = merged[s]
        measures.append(Measure(index=k, label=sm.number, start=float(start), duration=float(sm.length),
                                time_sig=sm.time_sig, key_fifths=sm.key[0], key_mode=sm.key[1], src=s))
        for (on, q) in sm.tempos:
            tempos.append((float(start + on), q))
        for pid, ms in parsed.items():
            if s >= len(ms):
                continue
            for (on, dur, pitch, written, voice, staff, grace, tie_start, tie_stop, src_idx) in sorted(
                    ms[s].notes, key=lambda x: (x[0], x[9])):
                onset = float(start + on)
                key_ = (pid, staff, pitch)
                if tie_stop and key_ in open_ties and pitch is not None:
                    prev = open_ties[key_]
                    # trust the tie even when the exporter got the first duration slightly wrong
                    if prev.onset < onset <= prev.onset + prev.duration + 1.0:
                        prev.duration = onset + float(dur) - prev.onset
                        if not tie_start:
                            del open_ties[key_]
                        continue
                note = Note(id=f"{pid}-{k}-{src_idx}", part=pid, measure=k, onset=onset,
                            duration=float(dur), pitch=pitch, written=written, voice=voice,
                            staff=staff, grace=grace, src_index=src_idx)
                notes.append(note)
                if tie_start and pitch is not None:
                    open_ties[key_] = note
        start += sm.length
    tempos = _dedupe_tempos(tempos)
    notes.sort(key=lambda n: (n.onset, n.part, n.pitch or 0))
    return Score(title=title, composer=composer, parts=list(part_info.values()), notes=notes,
                 measures=measures, tempos=tempos or [(0.0, 100.0)],
                 source={"format": "musicxml", "repeats_expanded": bool(expand_repeats),
                         "printed_measures": len(merged)})


def _dedupe_tempos(tempos: list[tuple]) -> list[tuple]:
    out: list[tuple] = []
    for b, q in sorted(tempos):
        if out and abs(out[-1][0] - b) < 1e-9:
            out[-1] = (b, q)
        elif not out or abs(out[-1][1] - q) > 1e-6:
            out.append((b, q))
    return out


def _load_with_music21(path_or_bytes, expand_repeats=True) -> Score:
    """Fallback for unusual files (score-timewise etc.): convert with music21."""
    import music21 as m21
    s = m21.converter.parse(path_or_bytes if isinstance(path_or_bytes, str) else path_or_bytes)
    xml = m21.musicxml.m21ToXml.GeneralObjectExporter(s).parse()
    return load_musicxml(xml, expand_repeats)


# ---------------------------------------------------------------------------
# MIDI
# ---------------------------------------------------------------------------
def load_midi(path: str) -> Score:
    import mido
    from .instruments import guess_profile
    mid = mido.MidiFile(path)
    tpq = mid.ticks_per_beat
    tempos: list[tuple] = []
    timesigs: list[tuple] = [(0, (4, 4))]
    keys: list[tuple] = [(0, 0)]
    parts: list[Part] = []
    notes: list[Note] = []
    counter = 0
    for ti, track in enumerate(mid.tracks):
        tick = 0
        active: dict[tuple, tuple] = {}
        program = None
        name = ""
        tnotes: list[Note] = []
        for msg in track:
            tick += msg.time
            if msg.type == "set_tempo":
                tempos.append((tick / tpq, 60_000_000 / msg.tempo))
            elif msg.type == "time_signature":
                timesigs.append((tick / tpq, (msg.numerator, msg.denominator)))
            elif msg.type == "key_signature":
                keys.append((tick / tpq, _key_name_to_fifths(msg.key)))
            elif msg.type == "track_name":
                name = msg.name
            elif msg.type == "program_change":
                program = msg.program + 1
            elif msg.type == "note_on" and msg.velocity > 0:
                active[(msg.channel, msg.note)] = (tick, msg.velocity)
            elif msg.type in ("note_off", "note_on"):
                st = active.pop((msg.channel, msg.note), None)
                if st is not None:
                    counter += 1
                    is_drum = msg.channel == 9
                    tnotes.append(Note(id=f"T{ti}-{counter}", part=f"T{ti}", measure=0,
                                       onset=st[0] / tpq, duration=max((tick - st[0]) / tpq, 1 / 32),
                                       pitch=None if is_drum else msg.note,
                                       written=None if is_drum else msg.note, src_index=counter))
        if tnotes:
            prof = guess_profile(name, program)
            parts.append(Part(id=f"T{ti}", name=name or f"Track {ti}", instrument=prof.key,
                              midi_program=program))
            notes.extend(tnotes)
    end = max((n.onset + n.duration for n in notes), default=4.0)
    measures = _measures_from_timesigs(sorted(timesigs), end, sorted(keys))
    starts = [m.start for m in measures]
    for n in notes:
        n.measure = max(0, bisect.bisect_right(starts, n.onset + 1e-9) - 1)
    notes.sort(key=lambda n: (n.onset, n.pitch or 0))
    return Score(title=os.path.splitext(os.path.basename(path))[0], parts=parts, notes=notes,
                 measures=measures, tempos=_dedupe_tempos(tempos) or [(0.0, 120.0)],
                 source={"format": "midi"})


def _key_name_to_fifths(name: str) -> int:
    order = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"]
    minor = name.endswith("m")
    root = name[:-1] if minor else name
    rel = {"Ab": "Cb", "Eb": "Gb", "Bb": "Db", "F": "Ab", "C": "Eb", "G": "Bb", "D": "F", "A": "C",
           "E": "G", "B": "D", "F#": "A", "C#": "E", "G#": "B", "D#": "F#", "A#": "C#"}
    if minor:
        root = rel.get(root, "C")
    return order.index(root) - 7 if root in order else 0


def _measures_from_timesigs(timesigs, end_beat, keys) -> list[Measure]:
    measures, beat, i = [], 0.0, 0
    ts_idx = 0
    while beat < end_beat - 1e-6 or not measures:
        while ts_idx + 1 < len(timesigs) and timesigs[ts_idx + 1][0] <= beat + 1e-6:
            ts_idx += 1
        num, den = timesigs[ts_idx][1]
        dur = num * 4.0 / den
        kf = [k for b, k in keys if b <= beat + 1e-6][-1]
        measures.append(Measure(index=i, label=str(i + 1), start=beat, duration=dur,
                                time_sig=(num, den), key_fifths=kf, src=i))
        beat += dur
        i += 1
    return measures


# ---------------------------------------------------------------------------
# Generic entry point
# ---------------------------------------------------------------------------
def load_score(path: str, **kw) -> Score:
    ext = os.path.splitext(path)[1].lower()
    if ext in (".musicxml", ".xml", ".mxl"):
        return load_musicxml(path, kw.get("expand_repeats", True))
    if ext in (".mid", ".midi"):
        return load_midi(path)
    if ext == ".json":
        with open(path, encoding="utf-8") as f:
            return Score.from_json(json.load(f))
    if ext in (".jianpu", ".jp", ".txt"):
        from .jianpu import parse_jianpu
        with open(path, encoding="utf-8") as f:
            return parse_jianpu(f.read())
    if ext in (".pdf", ".png", ".jpg", ".jpeg"):
        from .omr import pdf_or_image_to_score
        return pdf_or_image_to_score(path, **kw)
    raise ValueError(f"Unsupported score format: {ext}")


def score_from_notes(note_list: list[tuple], qpm: float = 100.0, time_sig=(4, 4), key_fifths: int = 0,
                     title: str = "", part_id: str = "P1", instrument: str = "piano") -> Score:
    """Build a Score from (onset_beats, duration_beats, midi_pitch) tuples. Used by generators/tests."""
    end = max((on + d for on, d, _ in note_list), default=float(time_sig[0]))
    measures = _measures_from_timesigs([(0.0, time_sig)], end, [(0.0, key_fifths)])
    starts = [m.start for m in measures]
    notes = []
    for i, (on, d, p) in enumerate(sorted(note_list, key=lambda x: (x[0], x[2] or 0))):
        notes.append(Note(id=f"{part_id}-{i}", part=part_id,
                          measure=max(0, bisect.bisect_right(starts, on + 1e-9) - 1),
                          onset=float(on), duration=float(d), pitch=p, written=p, src_index=i + 1))
    return Score(title=title, parts=[Part(id=part_id, name=instrument, instrument=instrument)],
                 notes=notes, measures=measures, tempos=[(0.0, float(qpm))],
                 source={"format": "generated"})
