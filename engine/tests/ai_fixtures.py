"""Test helpers for the AI reader: score -> the reader's bar notation (the answers a perfect model would
give), a rendered PDF of the score with known line breaks, and a fake model client."""
from __future__ import annotations

import json
import re
import threading
from fractions import Fraction
from types import SimpleNamespace

DEN = {"whole": 1, "half": 2, "quarter": 4, "eighth": 8, "16th": 16, "32nd": 32, "64th": 64}
SHARPS, FLATS = "FCGDAEB", "BEADGCF"


def _key_alter(fifths: int, step: str) -> int:
    if fifths > 0 and step in SHARPS[:fifths]:
        return 1
    if fifths < 0 and step in FLATS[:-fifths]:
        return -1
    return 0


def score_to_bars(path: str) -> tuple[list[list[list[str]]], dict]:
    """[bar][part][voice] strings as printed (accidentals only where the page would print them)."""
    import music21 as m21
    s = m21.converter.parse(path)
    parts = list(s.parts)
    measures = [list(p.getElementsByClass("Measure")) for p in parts]
    ks = s.recurse().getElementsByClass("KeySignature")
    fifths = ks[0].sharps if ks else 0
    ts = s.recurse().getElementsByClass("TimeSignature")[0]
    bars = []
    for mi in range(len(measures[0])):
        row = []
        for pi in range(len(parts)):
            m = measures[pi][mi]
            voices = list(m.voices) or [m]
            carry: dict = {}
            strs = []
            for v in voices:
                toks = []
                elems = list(v.notesAndRests)
                full = len(elems) == 1 and elems[0].isRest and elems[0].duration.quarterLength == m.barDuration.quarterLength
                if full:
                    strs.append("R")
                    continue
                for el in elems:
                    d = f"/{DEN[el.duration.type]}" + "." * el.duration.dots
                    if el.isRest:
                        toks.append("r" + d)
                        continue
                    pitches = el.pitches
                    names = []
                    for p in pitches:
                        alter = int(p.alter)
                        step, octv = p.step, p.octave
                        expected = carry.get((step, octv), _key_alter(fifths, step))
                        acc = ""
                        if alter != expected:
                            acc = {1: "#", 2: "##", -1: "b", -2: "bb", 0: "n"}[alter]
                            carry[(step, octv)] = alter
                        names.append(f"{step}{acc}{octv}")
                    tie = "~" if el.tie is not None and el.tie.type in ("start", "continue") else ""
                    toks.append("+".join(names) + d + tie)
                strs.append(" ".join(toks))
            row.append(strs)
        bars.append(row)
    meta = {"fifths": fifths, "time": ts.ratioString, "parts": [p.partName or f"Part {i + 1}" for i, p in enumerate(parts)]}
    return bars, meta


def render_pdf(path: str, bars_per_line: int = 4, page_width: int = 2100) -> bytes:
    """Engraves the score with Verovio with a line break every `bars_per_line` bars and returns a PDF."""
    import cairosvg
    import verovio
    xml = open(path, encoding="utf-8").read()
    count = [0]

    def add_break(mm):
        num = int(re.search(r'number="(\d+)"', mm.group(0)).group(1))
        if num > 1 and (num - 1) % bars_per_line == 0:
            return mm.group(0) + '<print new-system="yes"/>'
        return mm.group(0)
    xml = re.sub(r"<measure\s[^>]*>", add_break, xml)          # not <measure-numbering>, <measure-style>...
    tk = verovio.toolkit()
    tk.setOptions({"pageWidth": page_width, "pageHeight": 2970, "scale": 40, "breaks": "encoded",
                   "adjustPageHeight": False, "footer": "none"})
    tk.loadData(xml)
    pages = [tk.renderToSVG(i + 1) for i in range(tk.getPageCount())]
    if len(pages) == 1:
        return cairosvg.svg2pdf(bytestring=pages[0].encode())
    import pymupdf
    out = pymupdf.open()
    for svg in pages:
        out.insert_pdf(pymupdf.open(stream=cairosvg.svg2pdf(bytestring=svg.encode()), filetype="pdf"))
    return out.tobytes()


class FakeStream:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):                          # the reader may read the stream event by event
        yield SimpleNamespace(type="message_start")

    def get_final_message(self):
        return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=json.dumps(self.payload))],
                               usage=SimpleNamespace(input_tokens=1000, output_tokens=200, cache_read_input_tokens=0))


class FakeReaderClient:
    """Answers like a model that reads perfectly, except for the bars in `mistakes` on the first pass."""

    def __init__(self, bars, meta, bars_per_line=4, mistakes=None, instrument="piano", fail_lines=(), short_lines=(),
                 locate=None):
        self.bars, self.meta, self.per_line = bars, meta, bars_per_line
        self.fail_lines = set(fail_lines)       # 0-based lines that can never be read (the request fails)
        self.short_lines = set(short_lines)     # 0-based lines whose first answer stops after one bar
        self.locate = locate                    # answer to "where are the lines on this page?"
        self.line_asks: dict[int, int] = {}
        self.mistakes = mistakes or {}          # bar index -> list of voice strings per part (first reading)
        self.instrument = instrument
        self.calls: list[str] = []
        self.lock = threading.Lock()
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _measure(self, bi, first_pass):
        row = self.mistakes.get(bi, self.bars[bi]) if first_pass else self.bars[bi]
        return {"number": bi + 1, "time": self.meta["time"] if bi == 0 else None, "key_fifths": None,
                "repeat_start": False, "repeat_end": False, "ending": None, "barline": "final" if bi == len(self.bars) - 1 else "regular",
                "x0": 0, "x1": 0, "staves": [{"staff": i + 1, "voices": v} for i, v in enumerate(row)],
                "uncertain": False, "comment": ""}

    def _stream(self, **kw):
        schema = kw["output_config"]["format"]["schema"]
        text = kw["messages"][0]["content"][-1]["text"]
        req = set(schema.get("required", []))
        with self.lock:
            self.calls.append("overview" if "is_sheet_music" in req else "line" if "staff_count" in req
                              else "locate" if "systems" in req else "reread")
        if "systems" in req:
            return FakeStream({"systems": self.locate or []})
        if "is_sheet_music" in req:
            n = len(self.meta["parts"])
            return FakeStream({"is_sheet_music": True, "title": "Minuet in G", "subtitle": "", "composer": "Christian Petzold",
                               "arranger": "", "lyricist": "", "tempo_text": "", "tempo_bpm": None, "key_fifths": self.meta["fifths"],
                               "mode": "major", "time": self.meta["time"], "pickup": False, "handwritten": False, "notes": "",
                               "parts": [{"name": name, "instrument": self.instrument, "staves": 1,
                                          "clefs": ["treble" if i == 0 or n == 1 else "bass"]} for i, name in enumerate(self.meta["parts"])]})
        if "staff_count" in req:
            k = int(re.search(r"This is line (\d+) of page (\d+)", text).group(1)) - 1
            with self.lock:
                asked = self.line_asks[k] = self.line_asks.get(k, 0) + 1
            if k in self.fail_lines:
                raise RuntimeError("the reader is down")
            lo, hi = k * self.per_line, min(len(self.bars), (k + 1) * self.per_line)
            if k in self.short_lines and asked == 1:
                hi = lo + 1
            n = len(self.meta["parts"])
            return FakeStream({"staff_count": n, "clefs": ["treble" if i == 0 or n == 1 else "bass" for i in range(n)],
                               "key_fifths": self.meta["fifths"], "warnings": [],
                               "measures": [self._measure(bi, True) for bi in range(lo, hi)]})
        m = re.search(r"bar (\d+) of this line", text)
        if m:                                    # whole line sent: "bar k of this line" on "line n on page p"
            line = int(re.search(r"line (\d+) on page", text).group(1))
            bi = (line - 1) * self.per_line + int(m.group(1)) - 1
        else:                                    # one bar cut out: "(bar n)"
            bi = int(re.search(r"\(bar (\d+)\)", text).group(1)) - 1
        return FakeStream({"measures": [self._measure(bi, False)]})
