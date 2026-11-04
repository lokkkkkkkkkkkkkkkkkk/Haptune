"""Score -> MusicXML (via music21) and MusicXML -> SVG (via Verovio).

Used for: recordings turned into sheet music, generated exercises, jianpu
imports (so the app can display them as staff notation), and the HTML report.
"""
from __future__ import annotations

from collections import defaultdict

from .score import Score

SPLIT_POINT = 60   # piano: notes below middle C go to the left-hand staff


def _quantise_voice(events: list[tuple[float, float, list[int]]]) -> list[tuple[float, float, list[int]]]:
    """Make one staff monophonic-in-rhythm: a chord/note lasts until the next onset at most."""
    events = sorted(events)
    out = []
    for i, (on, dur, ps) in enumerate(events):
        nxt = events[i + 1][0] if i + 1 < len(events) else on + dur
        out.append((on, max(0.125, min(dur, nxt - on)), ps))
    return out


_FLAT_NAMES = ["C", "D-", "D", "E-", "E", "F", "G-", "G", "A-", "A", "B-", "B"]
_SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _pitch(midi: int, fifths: int):
    """Spell a MIDI pitch for a key: flats in flat keys, sharps otherwise, no courtesy naturals."""
    import music21 as m21
    names = _FLAT_NAMES if fifths < 0 else _SHARP_NAMES
    p = m21.pitch.Pitch(f"{names[midi % 12]}{midi // 12 - 1}")
    if p.accidental is not None and p.accidental.name == "natural":
        p.accidental = None
    return p


def to_music21(score: Score, two_staves_for: tuple = ("piano", "keyboard"), written_pitch: bool = True):
    import music21 as m21
    s = m21.stream.Score()
    s.metadata = m21.metadata.Metadata()
    s.metadata.title = score.title or "Untitled"
    if score.composer:
        s.metadata.composer = score.composer
    ts = score.measures[0].time_sig if score.measures else (4, 4)
    fifths = score.measures[0].key_fifths if score.measures else 0
    for part in score.parts or []:
        pnotes = [n for n in score.notes if n.part == part.id and not n.grace]
        staves = {1: pnotes}
        if part.instrument in two_staves_for:
            staves = {1: [n for n in pnotes if (n.pitch or 60) >= SPLIT_POINT],
                      2: [n for n in pnotes if (n.pitch or 60) < SPLIT_POINT]}
        for staff_no, ns in staves.items():
            if not ns and staff_no == 2:
                continue
            p = m21.stream.Part()
            p.partName = part.name or part.instrument or part.id
            if staff_no == 2:
                p.partName += " (left hand)"
            p.insert(0, m21.meter.TimeSignature(f"{ts[0]}/{ts[1]}"))
            p.insert(0, m21.key.KeySignature(fifths))
            if staff_no == 2:
                p.insert(0, m21.clef.BassClef())
            elif ns and sum(1 for n in ns if (n.pitch or 60) < 57) > 0.6 * len(ns):
                p.insert(0, m21.clef.BassClef())
            p.insert(0, m21.tempo.MetronomeMark(number=round(score.first_tempo)))
            if staff_no == 1 and part.id == score.source.get("chord_part"):
                for c in score.source.get("chords") or []:
                    label = c.get("label") or ""
                    if len(label) > 1 and label[1] == "b":                 # music21 spells flats with "-"
                        label = label[0] + "-" + label[2:]
                    try:
                        p.insert(float(c["beat"]), m21.harmony.ChordSymbol(label))
                    except Exception:                                      # an unusual symbol is not worth failing over
                        pass
            groups = defaultdict(list)
            for n in ns:
                groups[round(n.onset * 48) / 48].append(n)
            evs = []
            for on, g in groups.items():
                pitches = sorted({(n.written if written_pitch and n.written is not None else n.pitch) for n in g
                                  if n.pitch is not None})
                evs.append((on, max(n.duration for n in g), pitches))
            for on, dur, ps in _quantise_voice(evs):
                ql = round(dur * 12) / 12 or 0.25
                if not ps:
                    el = m21.note.Unpitched()
                elif len(ps) == 1:
                    el = m21.note.Note(_pitch(ps[0], fifths))
                else:
                    el = m21.chord.Chord([_pitch(x, fifths) for x in ps])
                el.quarterLength = ql
                p.insert(on, el)
            p.makeRests(fillGaps=True, inPlace=True)
            p.makeMeasures(inPlace=True)
            p.makeTies(inPlace=True)
            p.makeAccidentals(inPlace=True, cautionaryNotImmediateRepeat=False)
            s.insert(0, p)
    return s


def write_musicxml(score: Score, path: str, **kw) -> str:
    s = to_music21(score, **kw)
    s.write("musicxml", fp=path)
    return path


def musicxml_to_svg_pages(xml_path_or_data: str, page_width: int = 2100, scale: int = 40) -> tuple[list[str], object]:
    """Render with Verovio. Returns (svg pages, toolkit) - keep the toolkit to map notes to SVG ids."""
    import verovio
    tk = verovio.toolkit()
    tk.setOptions({"pageWidth": page_width, "pageHeight": 2970, "scale": scale, "adjustPageHeight": True,
                   "breaks": "auto", "footer": "none", "header": "auto", "svgViewBox": True,
                   "font": "Bravura"})
    if xml_path_or_data.lstrip().startswith("<"):
        ok = tk.loadData(xml_path_or_data)
    else:
        ok = tk.loadFile(xml_path_or_data)
    if not ok:
        raise ValueError("Verovio could not load the score")
    pages = [tk.renderToSVG(i + 1) for i in range(tk.getPageCount())]
    return pages, tk
