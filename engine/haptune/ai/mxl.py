"""The recognised score as a small document model, and a MusicXML 4.0 writer for it.

The writer produces plain, conservative MusicXML that Verovio, MuseScore, music21, the engine's own parser
(`haptune.score.load_musicxml`) and the web app's parser all read: one <part> per instrument, <staves> for
piano-style parts, voices with <backup>, ties, tuplets, beams, dynamics, hairpins, tempo, words, chord
symbols, lyrics, repeats and endings.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from fractions import Fraction
from xml.sax.saxutils import escape

from .notation import Ev, measure_length, voice_length

CLEF_XML = {
    "treble": ("G", 2, 0), "bass": ("F", 4, 0), "alto": ("C", 3, 0), "tenor": ("C", 4, 0), "soprano": ("C", 1, 0),
    "mezzo": ("C", 2, 0), "treble8vb": ("G", 2, -1), "treble8va": ("G", 2, 1), "bass8vb": ("F", 4, -1),
    "percussion": ("percussion", 0, 0),
}
# General MIDI programs (1-based, as MusicXML writes them) and display names for the instrument keys the apps use.
INSTRUMENTS = {
    "piano": (1, "Piano"), "keyboard": (5, "Keyboard"), "organ": (20, "Organ"), "harp": (47, "Harp"),
    "violin": (41, "Violin"), "viola": (42, "Viola"), "cello": (43, "Cello"), "doublebass": (44, "Double Bass"),
    "guitar": (25, "Guitar"), "bassguitar": (34, "Bass Guitar"), "ukulele": (25, "Ukulele"),
    "voice": (53, "Voice"), "flute": (74, "Flute"), "recorder": (75, "Recorder"), "clarinet": (72, "Clarinet"),
    "oboe": (69, "Oboe"), "bassoon": (71, "Bassoon"), "sax": (66, "Alto Sax"), "trumpet": (57, "Trumpet"),
    "trombone": (58, "Trombone"), "horn": (61, "Horn"), "tuba": (59, "Tuba"), "erhu": (111, "Erhu"),
    "dizi": (78, "Dizi"), "guzheng": (108, "Guzheng"), "percussion": (1, "Percussion"), "other": (1, "Instrument"),
}
TYPE_BEAMS = {"eighth": 1, "16th": 2, "32nd": 3, "64th": 4, "128th": 5}
DYN_SOUND = {"pppp": 15, "ppp": 24, "pp": 36, "p": 54, "mp": 69, "mf": 83, "f": 100, "ff": 115, "fff": 128,
             "ffff": 140, "sf": 110, "sfz": 115, "sffz": 125, "fz": 110, "fp": 100, "sfp": 110, "rf": 105, "rfz": 110,
             "sfpp": 110}


@dataclass
class PartInfo:
    id: str
    name: str
    instrument: str = "piano"
    staves: int = 1
    clefs: list[str] = field(default_factory=lambda: ["treble"])


@dataclass
class BarStaff:
    voices: list[list[Ev]] = field(default_factory=list)


@dataclass
class Bar:
    number: int
    parts: list[list[BarStaff]]                       # [part][staff]
    time: tuple[int, int] | None = None               # printed time signature (change) at this bar
    key: int | None = None                            # key signature (change) at this bar, in fifths
    mode: str | None = None
    clefs: dict[tuple[int, int], str] = field(default_factory=dict)   # (part, staff) -> clef from this bar on
    repeat_start: bool = False
    repeat_end: bool = False
    ending: str | None = None
    barline: str | None = None                        # double | final
    flags: list[str] = field(default_factory=list)    # why this bar may need a human check
    uncertain: bool = False
    page: int = 0
    system: int = 0
    box: tuple[float, float, float, float] | None = None   # x0, y0, x1, y1 on the page, 0..1


@dataclass
class ReadDoc:
    title: str = ""
    subtitle: str = ""
    composer: str = ""
    arranger: str = ""
    lyricist: str = ""
    tempo_text: str = ""
    tempo_bpm: float | None = None
    key: int = 0
    mode: str = "major"
    time: tuple[int, int] = (4, 4)
    parts: list[PartInfo] = field(default_factory=list)
    bars: list[Bar] = field(default_factory=list)


def _fmt_dur(d: Fraction, div: int) -> int:
    v = d * div
    if v.denominator != 1:
        raise ValueError(f"duration {d} does not fit divisions {div}")
    return int(v)


def _divisions(doc: ReadDoc) -> int:
    div = 1
    for bar in doc.bars:
        for staves in bar.parts:
            for st in staves:
                for voice in st.voices:
                    for e in voice:
                        if e.dur:
                            div = div * e.dur.denominator // math.gcd(div, e.dur.denominator)
    times = [doc.time] + [b.time for b in doc.bars if b.time]
    for t in times:
        ml = measure_length(t)
        div = div * ml.denominator // math.gcd(div, ml.denominator)
    return max(1, div)


CHORD_KINDS = [
    (r"(maj7|ma7|M7|Δ7|Δ|major7)", "major-seventh"), (r"(maj9|M9)", "major-ninth"), (r"(m7b5|ø7|ø|min7b5|-7b5)", "half-diminished"),
    (r"(dim7|°7|o7)", "diminished-seventh"), (r"(dim|°|o)", "diminished"), (r"(m9|min9|-9)", "minor-ninth"),
    (r"(m7|min7|-7)", "minor-seventh"), (r"(m6|min6|-6)", "minor-sixth"), (r"(mMaj7|mM7|m\(maj7\))", "major-minor"),
    (r"(m|min|-)", "minor"), (r"(aug7|\+7|7#5|7\+5)", "augmented-seventh"), (r"(aug|\+)", "augmented"),
    (r"(7sus4|7sus)", "dominant"), (r"(sus2)", "suspended-second"), (r"(sus4|sus)", "suspended-fourth"),
    (r"(13)", "dominant-13th"), (r"(11)", "dominant-11th"), (r"(9)", "dominant-ninth"), (r"(7)", "dominant"),
    (r"(6)", "major-sixth"), (r"(5)", "power"), (r"(add9|add2|2)", "major"), (r"", "major"),
]


def harmony_xml(text: str, staff: int | None = None) -> str:
    """A chord symbol such as 'F#m7/C#' as a MusicXML <harmony>, or '' if it is not a chord symbol."""
    t = (text or "").strip().replace("♯", "#").replace("♭", "b")
    m = re.match(r"^([A-G])([#b]?)(.*?)(?:/([A-G])([#b]?))?$", t)
    if not m:
        return ""
    root, ralt, suffix, bass, balt = m.groups()
    kind = "major"
    for pat, k in CHORD_KINDS:
        if re.fullmatch(pat, suffix or ""):
            kind = k
            break
    else:
        kind = "minor" if re.match(r"^(m(?!aj)|min|-)", suffix or "") else "major"
    x = "<harmony><root><root-step>%s</root-step>%s</root>" % (root, f"<root-alter>{1 if ralt == '#' else -1}</root-alter>" if ralt else "")
    x += f'<kind text="{escape(suffix or "")}">{kind}</kind>'
    if bass:
        x += "<bass><bass-step>%s</bass-step>%s</bass>" % (bass, f"<bass-alter>{1 if balt == '#' else -1}</bass-alter>" if balt else "")
    if staff:
        x += f"<staff>{staff}</staff>"
    return x + "</harmony>"


def _beat_group(time: tuple[int, int]) -> Fraction:
    beats, beat_type = time
    if beat_type == 8 and beats % 3 == 0 and beats >= 6:
        return Fraction(3, 2)                                  # compound: dotted quarter
    if (beats, beat_type) == (3, 8):
        return Fraction(3, 2)
    return Fraction(4, beat_type) if beat_type >= 4 else Fraction(1)


def _beams(voice: list[Ev], starts: list[Fraction], group: Fraction) -> dict[int, list[str]]:
    """Beam values per event index: {i: ['begin', 'continue', ...] for levels 1..n}."""
    out: dict[int, list[str]] = {}
    runs: list[list[int]] = []
    cur: list[int] = []
    cur_group = None
    for i, e in enumerate(voice):
        beamable = e.kind == "note" and not e.grace and e.type in TYPE_BEAMS
        g = math.floor(starts[i] / group) if group else 0
        if beamable and (not cur or g == cur_group):
            cur.append(i)
            cur_group = g
            continue
        if len(cur) > 1:
            runs.append(cur)
        cur = [i] if beamable else []
        cur_group = g if beamable else None
    if len(cur) > 1:
        runs.append(cur)
    for run in runs:
        levels = max(TYPE_BEAMS[voice[i].type] for i in run)
        for idx in run:
            out[idx] = []
        for lvl in range(1, levels + 1):
            members = [i for i in run if TYPE_BEAMS[voice[i].type] >= lvl]
            if lvl == 1:
                for k, i in enumerate(run):
                    out[i].append("begin" if k == 0 else "end" if k == len(run) - 1 else "continue")
                continue
            # consecutive stretches at this level
            pos = {i: k for k, i in enumerate(run)}
            stretch: list[int] = []
            stretches = []
            for i in run:
                if i in members and (not stretch or pos[i] == pos[stretch[-1]] + 1):
                    stretch.append(i)
                else:
                    if stretch:
                        stretches.append(stretch)
                    stretch = [i] if i in members else []
            if stretch:
                stretches.append(stretch)
            for s in stretches:
                if len(s) == 1:
                    out[s[0]].append("backward hook" if pos[s[0]] == len(run) - 1 else "forward hook")
                else:
                    for k, i in enumerate(s):
                        out[i].append("begin" if k == 0 else "end" if k == len(s) - 1 else "continue")
    return out


def _clef_xml(clef: str, number: int | None) -> str:
    sign, line, octv = CLEF_XML.get(clef, CLEF_XML["treble"])
    attr = f' number="{number}"' if number else ""
    x = f"<clef{attr}><sign>{sign}</sign>"
    if sign != "percussion":
        x += f"<line>{line}</line>"
    if octv:
        x += f"<clef-octave-change>{octv}</clef-octave-change>"
    return x + "</clef>"


def _direction(inner: str, placement: str, staff: int | None, sound: str = "") -> str:
    st = f"<staff>{staff}</staff>" if staff else ""
    return f'<direction placement="{placement}">{inner}{st}{sound}</direction>'


class _LyricState:
    def __init__(self):
        self.open: dict[tuple, bool] = {}

    def syllabic(self, key: tuple, text: str) -> tuple[str, str]:
        cont = text.endswith("-")
        word = text[:-1] if cont else text
        was_open = self.open.get(key, False)
        if was_open:
            syl = "middle" if cont else "end"
        else:
            syl = "begin" if cont else "single"
        self.open[key] = cont
        return syl, word


def write_musicxml(doc: ReadDoc) -> str:
    div = _divisions(doc)
    lyr = _LyricState()
    out: list[str] = ['<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
                      '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
                      '"http://www.musicxml.org/dtds/partwise.dtd">',
                      '<score-partwise version="4.0">']
    if doc.title:
        out.append(f"<work><work-title>{escape(doc.title)}</work-title></work>")
    ident = []
    for role, name in (("composer", doc.composer), ("arranger", doc.arranger), ("lyricist", doc.lyricist)):
        if name:
            ident.append(f'<creator type="{role}">{escape(name)}</creator>')
    ident.append("<encoding><software>Haptune AI reader</software></encoding>")
    out.append("<identification>" + "".join(ident) + "</identification>")
    if doc.title:
        out.append(f'<credit page="1"><credit-type>title</credit-type><credit-words justify="center" valign="top" font-size="22">{escape(doc.title)}</credit-words></credit>')
    if doc.composer:
        out.append(f'<credit page="1"><credit-type>composer</credit-type><credit-words justify="right" valign="top">{escape(doc.composer)}</credit-words></credit>')
    out.append("<part-list>")
    for idx, p in enumerate(doc.parts):
        prog, default_name = INSTRUMENTS.get(p.instrument, INSTRUMENTS["other"])
        name = p.name or default_name
        channel = 10 if p.instrument == "percussion" else [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16][idx % 15]
        out.append(f'<score-part id="{p.id}"><part-name>{escape(name)}</part-name>'
                   f'<score-instrument id="{p.id}-I1"><instrument-name>{escape(name)}</instrument-name></score-instrument>'
                   f'<midi-instrument id="{p.id}-I1"><midi-channel>{channel}</midi-channel>'
                   f"<midi-program>{prog}</midi-program></midi-instrument></score-part>")
    out.append("</part-list>")

    # where endings start and stop (contiguous runs of bars with the same ending number)
    ending_marks: dict[int, tuple[str | None, str | None]] = {}
    for i, bar in enumerate(doc.bars):
        if not bar.ending:
            continue
        prev = doc.bars[i - 1].ending if i else None
        nxt = doc.bars[i + 1].ending if i + 1 < len(doc.bars) else None
        start = bar.ending if prev != bar.ending else None
        stop = None
        if nxt != bar.ending:
            stop = "stop" if bar.repeat_end else "discontinue"
        ending_marks[i] = (start, stop)

    for pi, part in enumerate(doc.parts):
        out.append(f'<part id="{part.id}">')
        time = doc.time
        key = doc.key
        clefs = list(part.clefs) + ["treble"] * max(0, part.staves - len(part.clefs))
        last_ev: dict[tuple[int, int], Ev | None] = {}
        for bi, bar in enumerate(doc.bars):
            if bar.time:
                time = bar.time
            bar_len = measure_length(time)
            staves = bar.parts[pi] if pi < len(bar.parts) else []
            # actual length of this bar (a pickup or a final short bar is allowed)
            lens = [voice_length(v) for st in staves for v in st.voices if v]
            real = [x for x in lens if x is not None]
            content_len = max(real) if real else bar_len
            implicit = bi == 0 and real and content_len < bar_len
            this_len = content_len if implicit else max(bar_len, content_len)
            number = 0 if implicit else bar.number
            out.append(f'<measure number="{number}"' + (' implicit="yes"' if implicit else "") + ">")
            if pi == 0 and bi > 0 and bar.page and bar.page != doc.bars[bi - 1].page:
                out.append('<print new-page="yes"/>')
            # left barline
            em = ending_marks.get(bi, (None, None))
            if bar.repeat_start or em[0]:
                lb = '<barline location="left">'
                if bar.repeat_start:
                    lb += "<bar-style>heavy-light</bar-style>"
                if em[0]:
                    lb += f'<ending number="{escape(em[0])}" type="start">{escape(em[0])}.</ending>'
                if bar.repeat_start:
                    lb += '<repeat direction="forward"/>'
                out.append(lb + "</barline>")
            attrs = []
            if bi == 0:
                attrs.append(f"<divisions>{div}</divisions>")
            if bi == 0 or (bar.key is not None and bar.key != key):
                key = bar.key if bar.key is not None else key
                mode = bar.mode or doc.mode or "major"
                attrs.append(f"<key><fifths>{key}</fifths><mode>{mode}</mode></key>")
            if bi == 0 or bar.time:
                attrs.append(f"<time><beats>{time[0]}</beats><beat-type>{time[1]}</beat-type></time>")
            if bi == 0 and part.staves > 1:
                attrs.append(f"<staves>{part.staves}</staves>")
            if bi == 0:
                for si in range(part.staves):
                    attrs.append(_clef_xml(clefs[si], si + 1 if part.staves > 1 else None))
            else:
                for si in range(part.staves):
                    c = bar.clefs.get((pi, si))
                    if c and c != clefs[si]:
                        clefs[si] = c
                        attrs.append(_clef_xml(c, si + 1 if part.staves > 1 else None))
            if attrs:
                out.append("<attributes>" + "".join(attrs) + "</attributes>")
            if bi == 0 and pi == 0 and (doc.tempo_text or doc.tempo_bpm):
                inner = ""
                if doc.tempo_text:
                    inner += f'<direction-type><words font-weight="bold">{escape(doc.tempo_text)}</words></direction-type>'
                if doc.tempo_bpm:
                    inner += f'<direction-type><metronome parentheses="no"><beat-unit>quarter</beat-unit><per-minute>{round(doc.tempo_bpm)}</per-minute></metronome></direction-type>'
                snd = f'<sound tempo="{round(doc.tempo_bpm, 2)}"/>' if doc.tempo_bpm else ""
                out.append(_direction(inner, "above", 1 if part.staves > 1 else None, snd))

            cursor = Fraction(0)
            first_voice = True
            vnum = 0
            for si in range(part.staves):
                st = staves[si] if si < len(staves) else BarStaff(voices=[[Ev(kind="mrest", source="R")]])
                voices = [v for v in st.voices if v] or [[Ev(kind="mrest", source="R")]]
                multi = sum(1 for v in voices if any(e.kind == "note" for e in v)) > 1
                for vi, voice in enumerate(voices):
                    vnum = si * 4 + vi + 1
                    if not first_voice and cursor:
                        out.append(f"<backup><duration>{_fmt_dur(cursor, div)}</duration></backup>")
                    first_voice = False
                    cursor = Fraction(0)
                    starts = []
                    t = Fraction(0)
                    for e in voice:
                        starts.append(t)
                        if e.is_timed:
                            t += e.dur
                    beams = _beams(voice, starts, _beat_group(time))
                    for ei, e in enumerate(voice):
                        staff_no = si + 1 if part.staves > 1 else None
                        if e.kind == "clef":
                            if e.clef and e.clef != clefs[si]:
                                clefs[si] = e.clef
                                out.append("<attributes>" + _clef_xml(e.clef, staff_no) + "</attributes>")
                            continue
                        out.extend(_event_directions(e, staff_no))
                        if e.chord:
                            hx = harmony_xml(e.chord, staff_no)
                            if hx:
                                out.append(hx)
                        out.append(_note_xml(e, div, vnum, staff_no, this_len, beams.get(ei),
                                             "up" if multi and vi == 0 else "down" if multi else None, lyr, (pi, si, vi)))
                        if e.is_timed:
                            cursor += e.dur
                        elif e.kind == "mrest":
                            cursor += this_len
                        last_ev[(si, vi)] = e
                    if cursor < this_len and (len(voices) > 1 or part.staves > 1):
                        out.append(f"<forward><duration>{_fmt_dur(this_len - cursor, div)}</duration><voice>{vnum}</voice>"
                                   + (f"<staff>{si + 1}</staff>" if part.staves > 1 else "") + "</forward>")
                        cursor = this_len
            # right barline
            if bar.repeat_end or em[1] or bar.barline or bi == len(doc.bars) - 1:
                style = "light-heavy" if (bar.repeat_end or bar.barline == "final" or bi == len(doc.bars) - 1) else "light-light"
                rb = f'<barline location="right"><bar-style>{style}</bar-style>'
                if em[1]:
                    num = doc.bars[bi].ending
                    rb += f'<ending number="{escape(num)}" type="{em[1]}"/>'
                if bar.repeat_end:
                    rb += '<repeat direction="backward"/>'
                out.append(rb + "</barline>")
            out.append("</measure>")
        out.append("</part>")
    out.append("</score-partwise>")
    return "\n".join(out)


def _event_directions(e: Ev, staff: int | None) -> list[str]:
    out = []
    if e.tempo_text or e.bpm:
        inner = ""
        if e.tempo_text:
            inner += f'<direction-type><words font-weight="bold">{escape(e.tempo_text)}</words></direction-type>'
        if e.bpm:
            inner += f'<direction-type><metronome parentheses="no"><beat-unit>quarter</beat-unit><per-minute>{round(e.bpm)}</per-minute></metronome></direction-type>'
        out.append(_direction(inner, "above", staff, f'<sound tempo="{round(e.bpm, 2)}"/>' if e.bpm else ""))
    for d in e.dynamics:
        snd = f'<sound dynamics="{DYN_SOUND.get(d, 80)}"/>'
        out.append(_direction(f"<direction-type><dynamics><{d}/></dynamics></direction-type>", "below", staff, snd))
    for w in e.words:
        out.append(_direction(f'<direction-type><words font-style="italic">{escape(w)}</words></direction-type>', "above", staff))
    for mk in e.marks:
        if mk == "cresc-start":
            out.append(_direction('<direction-type><wedge type="crescendo" number="1"/></direction-type>', "below", staff))
        elif mk == "dim-start":
            out.append(_direction('<direction-type><wedge type="diminuendo" number="1"/></direction-type>', "below", staff))
        elif mk == "wedge-end":
            out.append(_direction('<direction-type><wedge type="stop" number="1"/></direction-type>', "below", staff))
    if e.pedal:
        typ = {"start": "start", "down": "start", "end": "stop", "stop": "stop", "up": "stop", "change": "change"}.get(e.pedal, "start")
        out.append(_direction(f'<direction-type><pedal type="{typ}" line="yes"/></direction-type>', "below", staff))
    return out


def _note_xml(e: Ev, div: int, voice: int, staff: int | None, bar_len: Fraction, beams: list[str] | None,
              stem: str | None, lyr: _LyricState, lkey: tuple) -> str:
    st = f"<staff>{staff}</staff>" if staff else ""
    if e.kind == "mrest":
        return (f'<note><rest measure="yes"/><duration>{_fmt_dur(bar_len, div)}</duration><voice>{voice}</voice>'
                f"{st}</note>")
    tm = ""
    if e.tuplet:
        tm = f"<time-modification><actual-notes>{e.tuplet[0]}</actual-notes><normal-notes>{e.tuplet[1]}</normal-notes></time-modification>"
    dots = "<dot/>" * e.dots
    dur = "" if e.grace else f"<duration>{_fmt_dur(e.dur, div)}</duration>"
    grace = '<grace slash="yes"/>' if e.grace and e.type in ("eighth", "16th") and len(e.pitches) <= 1 else "<grace/>" if e.grace else ""
    if e.kind == "rest":
        nots = _notations(e, first=True, pitch=None)
        return f"<note><rest/>{dur}<voice>{voice}</voice><type>{e.type}</type>{dots}{tm}{st}{nots}</note>"
    parts = []
    for k, p in enumerate(e.pitches):
        chord = "<chord/>" if k else ""
        alter = f"<alter>{p.alter}</alter>" if p.alter else ""
        ties = ""
        if p.tie_stop:
            ties += '<tie type="stop"/>'
        if e.tie:
            ties += '<tie type="start"/>'
        acc = ""
        if p.acc is not None:
            acc = "<accidental>%s</accidental>" % {"#": "sharp", "##": "double-sharp", "b": "flat", "bb": "flat-flat", "n": "natural"}[p.acc]
        stem_x = f"<stem>{stem}</stem>" if stem else ""
        beam_x = "".join(f'<beam number="{i + 1}">{v}</beam>' for i, v in enumerate(beams or [])) if k == 0 else ""
        nots = _notations(e, first=k == 0, pitch=p)
        lyrics = ""
        if k == 0 and e.lyrics:
            for n, text in sorted(e.lyrics.items()):
                syl, word = lyr.syllabic(lkey + (n,), text)
                lyrics += f'<lyric number="{n}"><syllabic>{syl}</syllabic><text>{escape(word)}</text></lyric>'
        parts.append(f"<note>{grace}{chord}<pitch><step>{p.step}</step>{alter}<octave>{p.octave}</octave></pitch>{dur}{ties}"
                     f"<voice>{voice}</voice><type>{e.type}</type>{dots}{acc}{tm}{stem_x}{st}{beam_x}{nots}{lyrics}</note>")
    return "".join(parts)


def _notations(e: Ev, first: bool, pitch) -> str:
    items = []
    if pitch is not None:
        if pitch.tie_stop:
            items.append('<tied type="stop"/>')
        if e.tie:
            items.append('<tied type="start"/>')
    if first:
        if e.tuplet_pos:
            items.append(f'<tuplet type="{e.tuplet_pos}" bracket="yes"/>' if e.tuplet_pos == "start" else '<tuplet type="stop"/>')
        if "slur-start" in e.marks:
            items.append('<slur type="start" number="1"/>')
        if "slur-end" in e.marks:
            items.append('<slur type="stop" number="1"/>')
        arts = [m for m in e.marks if m in ("staccato", "accent", "tenuto", "strong-accent", "staccatissimo")]
        if arts:
            items.append("<articulations>" + "".join(f"<{a}/>" for a in arts) + "</articulations>")
        orn = [m for m in e.marks if m in ("trill-mark", "mordent", "turn")]
        if orn:
            items.append("<ornaments>" + "".join(f"<{o}/>" for o in orn) + "</ornaments>")
        tech = [m for m in e.marks if m in ("up-bow", "down-bow")]
        if e.fingering:
            tech.append(("fingering", e.fingering))
        if tech:
            items.append("<technical>" + "".join(f"<{t}/>" if isinstance(t, str) else f"<fingering>{escape(t[1])}</fingering>" for t in tech) + "</technical>")
        if "fermata" in e.marks:
            items.append('<fermata type="upright"/>')
    if "arpeggiate" in e.marks and pitch is not None:
        items.append("<arpeggiate/>")
    return f"<notations>{''.join(items)}</notations>" if items else ""
