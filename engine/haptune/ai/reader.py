"""Sheet music PDF / photo -> MusicXML, read by a vision model and checked bar by bar.

    pages ──► staves & systems found (layout.py) ──► every line read in parallel, zoomed in
          ──► each bar parsed and checked (lengths, staves, ranges) ──► suspect bars re-read closer
          ──► key signatures & accidentals applied ──► MusicXML (mxl.py) + a list of bars to double-check

The overview (title, instruments, key, metre) is read at the same time as the lines, so a one-page piece
takes about as long as its slowest line.
"""
from __future__ import annotations

import re
import threading
import time as _time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Callable

from .claude import AIError, Claude, image_block, text_block
from .layout import Page, analyse_page, clean_photo, count_pages, encode_png, load_pages
from .mxl import INSTRUMENTS, Bar, BarStaff, PartInfo, ReadDoc, write_musicxml
from .notation import CLEFS, Ev, measure_length, parse_voice, resolve_alters, voice_length
from .prompts import (LOCATE_PROMPT, LOCATE_SCHEMA, OVERVIEW_PROMPT, OVERVIEW_SCHEMA, READER_SYSTEM, REREAD_PROMPT_TMPL,
                      REREAD_SCHEMA, SYSTEM_PROMPT_TMPL, SYSTEM_SCHEMA)

Progress = Callable[[str, float, str], None]
OCTAVE_SHIFT = {"treble8vb": -1, "bass8vb": -1, "treble8va": 1}
# rough written ranges per clef (MIDI); far outside means a misread line/space or clef
# (checked on the notes as written, before octave clefs are applied)
CLEF_RANGE = {"treble": (48, 96), "bass": (24, 72), "alto": (36, 84), "tenor": (36, 81), "treble8vb": (48, 96),
              "treble8va": (48, 96), "bass8vb": (24, 72), "soprano": (45, 93), "mezzo": (42, 90), "percussion": (0, 127)}


@dataclass
class Hints:
    title: str = ""
    instrument: str = ""          # instrument key the user picked (piano, violin...), "" = let the reader decide
    description: str = ""         # free text, e.g. "violin and piano", "choir SATB"
    handwritten: bool | None = None
    pages: list[int] | None = None   # 1-based pages to read; None = all


@dataclass
class _Job:
    page: int
    system: int | None
    box: tuple[int, int, int, int]
    staves: int
    space: float
    scale: float = 1.0
    result: dict | None = None
    error: str | None = None
    kind: str = "system"           # system (one line of music) | region (an area that may hold music) | page (whole page)
    expect: int = 0                # bars counted from the barlines of the line (0 = not known)
    barlines: list[int] = field(default_factory=list)
    line: int = 0                  # 1-based line number on its page, as shown to people
    short: bool = False            # fewer bars came back than the line holds
    tries: int = 0


@dataclass
class _RawBar:
    job: _Job
    k: int                         # index of the bar within its line
    data: dict
    staff_count: int
    clefs: list[str]
    key: int


class _CacheGate:
    """Lets the first of several parallel requests with the same instructions go ahead and holds the others
    until its answer starts arriving (or it fails). A prompt-cache entry can be read only once the request
    writing it has started answering, so without this every parallel request pays to write the cache."""

    def __init__(self, timeout: float = 30.0):
        self._first = threading.Event()
        self._lock = threading.Lock()
        self._claimed = False
        self.timeout = timeout

    def enter(self) -> threading.Event | None:
        """The first caller gets the event to set once its answer starts; the others wait for it, get None."""
        with self._lock:
            if not self._claimed:
                self._claimed = True
                return self._first
        self._first.wait(self.timeout)
        return None


@dataclass
class ReadResult:
    musicxml: str
    doc: ReadDoc
    flags: list[dict]
    report: dict = field(default_factory=dict)


def parse_time(s: str | None) -> tuple[int, int] | None:
    t = (s or "").strip().upper().replace(" ", "")
    if t in ("C", "COMMON", "4/4C"):
        return (4, 4)
    if t in ("C|", "¢", "CUT", "ALLABREVE", "2/2C|"):
        return (2, 2)
    m = re.match(r"^(\d{1,2})/(\d{1,2})$", t)
    if m and int(m.group(2)) in (1, 2, 4, 8, 16, 32) and 0 < int(m.group(1)) <= 32:
        return (int(m.group(1)), int(m.group(2)))
    return None


class Reader:
    def __init__(self, ai: Claude | None = None, workers: int = 6, max_rereads: int = 16, max_pages: int = 20,
                 reread_ai: Claude | None = None):
        self.ai = ai or Claude()
        # The bars that look wrong after the first reading can be read again by a stronger model: a cheap model
        # reads every line, the strong one only the few doubtful bars (see engine/tools/model_bench.py).
        self.reread_ai = reread_ai or self.ai
        self.workers = workers
        self.max_rereads = max_rereads
        self.max_pages = max_pages

    # ------------------------------------------------------------------ main entry
    def read(self, data: bytes | list[tuple[bytes, str]], filename: str = "", hints: Hints | None = None,
             progress: Progress | None = None) -> ReadResult:
        hints = hints or Hints()
        say = progress or (lambda stage, frac, msg: None)
        t0 = _time.time()
        say("pages", 0.02, "Opening your pages")
        sources = data if isinstance(data, list) else [(data, filename)]      # several photos = several pages
        images = []
        for blob, name in sources:
            images.extend(load_pages(blob, name, max_pages=self.max_pages - len(images)))
            if len(images) >= self.max_pages:
                break
        pages_in_file = sum(count_pages(blob, name) for blob, name in sources)
        if hints.pages:
            images = [images[p - 1] for p in hints.pages if 0 < p <= len(images)] or images
        if not images:
            raise AIError("No pages found in this file.")
        pages = [analyse_page(img, i) for i, img in enumerate(images)]
        for pg in pages:
            if pg.photo:                                   # photos: even lighting and clear contrast for the reader
                pg.image = clean_photo(pg.image)
        jobs = self._plan(pages, hints)
        say("reading", 0.06, f"Reading {len(jobs)} line{'s' if len(jobs) != 1 else ''} of music")

        done = [0]
        first_line = _CacheGate()

        def run_system(job: _Job):
            gate = first_line.enter()
            try:
                self._read_job(job, pages, hints, gate)
            finally:
                if gate is not None:
                    gate.set()
            done[0] += 1
            say("reading", 0.06 + 0.64 * done[0] / len(jobs), f"Read line {done[0]} of {len(jobs)}")

        def run_overview():
            pg = pages[0]
            png = encode_png(pg.image)
            hint = f" ({hints.description})" if hints.description else ""
            prompt = OVERVIEW_PROMPT.format(page=1, pages=len(pages), hint=hint)
            try:
                return self.ai.ask_json(READER_SYSTEM, [image_block(png), text_block(prompt)], OVERVIEW_SCHEMA,
                                        effort="medium", max_tokens=8000)
            except AIError:
                return None

        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            ov_future = pool.submit(run_overview)
            list(pool.map(run_system, jobs))
            overview = ov_future.result()

        if overview is not None and not overview.get("is_sheet_music", True):
            raise AIError("This doesn't look like sheet music. Try a clearer photo or a PDF of the score.")
        failed = [j for j in jobs if j.result is None and j.kind != "region"]
        if all(j.result is None for j in jobs):
            raise AIError(next((j.error for j in jobs if j.error), None) or "The music could not be read.")

        say("checking", 0.72, "Checking every bar")
        doc, raws = self._assemble(jobs, overview, hints, pages)
        flags = self._validate(doc)
        rereads = self._pick_rereads(doc, flags)
        if rereads:
            say("checking", 0.76, f"Looking closer at {len(rereads)} bar{'s' if len(rereads) != 1 else ''}")
            self._reread(doc, raws, rereads, pages, hints, say)
            flags = self._validate(doc)
        say("writing", 0.95, "Writing the score")
        self._finish(doc)
        xml = write_musicxml(doc)
        report = {
            "pages": len(pages), "lines": len(jobs), "bars": len(doc.bars),
            "parts": [{"name": p.name, "instrument": p.instrument, "staves": p.staves} for p in doc.parts],
            "title": doc.title, "composer": doc.composer, "key": doc.key, "mode": doc.mode,
            "time": f"{doc.time[0]}/{doc.time[1]}", "tempo_bpm": doc.tempo_bpm,
            "pages_in_file": pages_in_file, "pages_left_out": max(0, pages_in_file - len(pages)) if not hints.pages else 0,
            "failed_lines": [{"page": j.page + 1, "line": j.line, "error": j.error, "bars": max(1, j.expect),
                              "box": self._box_json(j.box, pages[j.page])} for j in failed],
            "short_lines": [{"page": j.page + 1, "line": j.line, "read": len(j.result.get("measures", [])), "expected": j.expect}
                            for j in jobs if j.result and j.short],
            "rereads": len(rereads), "seconds": round(_time.time() - t0, 1), "model": self.ai.model,
            "usage": self.ai.usage.to_json(),
            **({"reread_model": self.reread_ai.model, "reread_usage": self.reread_ai.usage.to_json()} if self.reread_ai is not self.ai else {}),
            "skew": [round(p.skew, 2) for p in pages],
        }
        flag_list = [self._flag_json(doc, bi, reasons) for bi, reasons in sorted(flags.items())]
        say("done", 1.0, "Done")
        return ReadResult(musicxml=xml, doc=doc, flags=flag_list, report=report)

    # ------------------------------------------------------------------ planning: what to read
    def _plan(self, pages: list[Page], hints: Hints) -> list[_Job]:
        """One job per line of music, in reading order. Nothing on a page is left out: inked areas outside the
        lines that were found are read too, and a page where no lines were found is first split into its
        lines by the model (a whole page in one answer is where bars used to go missing)."""
        jobs: list[_Job] = []
        for pg in pages:
            w, h = pg.size
            items: list[tuple[int, _Job]] = []
            for s in pg.systems:
                items.append((s.box[1], _Job(page=pg.index, system=s.index, box=s.box, staves=len(s.staves),
                                             space=float(sum(st.space for st in s.staves) / len(s.staves)),
                                             expect=int(pg.bars.get(s.index, 0)), barlines=list(pg.barlines.get(s.index, [])))))
            for box in pg.regions:
                items.append((box[1], _Job(page=pg.index, system=None, box=box, staves=0, space=0.0, kind="region")))
            if not pg.systems:
                for box, staves in self._locate(pg, hints):
                    items.append((box[1], _Job(page=pg.index, system=None, box=box, staves=staves, space=0.0)))
                if not items:
                    items.append((0, _Job(page=pg.index, system=None, box=(0, 0, w, h), staves=0, space=0.0, kind="page")))
            for n, (_, job) in enumerate(sorted(items, key=lambda it: it[0])):
                job.line = n + 1
                if job.system is None and job.kind == "system":
                    job.system = n
                jobs.append(job)
        return jobs

    def _locate(self, pg: Page, hints: Hints) -> list[tuple[tuple[int, int, int, int], int]]:
        """Asks the model where each line (system) of music is on a page whose staves could not be found by
        measuring (a curved or dark photo, handwriting). Returns [(box, staves)] top to bottom, [] if unsure."""
        w, h = pg.size
        png = encode_png(pg.image)
        from PIL import Image
        import io
        scale = Image.open(io.BytesIO(png)).height / max(1, h)
        try:
            res = self.ai.ask_json(READER_SYSTEM, [image_block(png), text_block(LOCATE_PROMPT)], LOCATE_SCHEMA,
                                   effort="low", max_tokens=4000)
        except AIError:
            return []
        rows = []
        for it in res.get("systems") or []:
            try:
                top, bottom = float(it.get("top")) / scale, float(it.get("bottom")) / scale
            except (TypeError, ValueError):
                continue
            if 0 <= top < bottom <= h * 1.02 and bottom - top >= 0.015 * h:
                rows.append((top, min(bottom, h), max(1, min(12, int(it.get("staves") or 1)))))
        rows.sort()
        out = []
        for i, (top, bottom, staves) in enumerate(rows):
            pad = 0.35 * (bottom - top) / max(1, staves) + 0.01 * h
            y0 = max(0.0, top - pad) if i == 0 else max((rows[i - 1][1] + top) / 2 - 0.004 * h, top - pad)
            y1 = min(float(h), bottom + pad) if i + 1 == len(rows) else min((bottom + rows[i + 1][0]) / 2 + 0.004 * h, bottom + pad)
            if y1 - y0 > 4:
                out.append(((0, int(y0), w, int(y1)), staves))
        return out

    # ------------------------------------------------------------------ reading one line
    retry_wait = 1.5               # seconds between tries of a line that failed (tests set 0)

    def _ask_crop(self, job: _Job, pg: Page, box: tuple[int, int, int, int], hints: Hints, gate, extra: str = "") -> dict:
        """Reads one cut-out of a page. Every bar comes back with `_px`: its left and right edge in page pixels."""
        from PIL import Image
        import io
        img = pg.image.crop(box)
        png = encode_png(img, min_space=22, space=job.space or None)
        scale = Image.open(io.BytesIO(png)).width / max(1, img.width)
        if box == job.box:
            job.scale = scale
        if job.kind == "page":
            staves_text = "a whole page; transcribe every line on it in order"
        elif job.kind == "region":
            staves_text = ("part of a page that may hold one or more lines of music; transcribe every line in it, top to "
                           "bottom, and return an empty measures list if it holds no music")
        else:
            staves_text = f"{job.staves} staves" if job.staves > 1 else "1 staff" if job.staves == 1 else "one line of music"
        ctx = self._hint_text(hints)
        if job.kind == "system":
            ctx += f" This is line {job.line} of page {job.page + 1}."
        if extra:
            ctx += " " + extra
        prompt = SYSTEM_PROMPT_TMPL.format(staves_text=staves_text, context=ctx.strip())
        res = self.ai.ask_json(READER_SYSTEM, [image_block(png), text_block(prompt)], SYSTEM_SCHEMA,
                               effort="medium", max_tokens=32000, started=gate)
        for m in res.get("measures") or []:
            x0, x1 = m.get("x0") or 0, m.get("x1") or 0
            m["_px"] = (box[0] + x0 / scale, box[0] + x1 / scale) if x1 > x0 >= 0 and scale > 0 else None
        return res

    def _read_job(self, job: _Job, pages: list[Page], hints: Hints, gate) -> None:
        """Reads a line, trying again when it fails or comes back with far fewer bars than the line holds.
        A line too long for one answer is read as two halves, split at a barline."""
        pg = pages[job.page]
        best: dict | None = None
        extra = ""
        for attempt in range(3):
            job.tries = attempt + 1
            try:
                res = self._ask_crop(job, pg, job.box, hints, gate if attempt == 0 else None, extra)
            except AIError as e:
                job.error = str(e)
                if "too long" in job.error and job.kind == "system" and len(job.barlines) >= 2:
                    halves = self._read_halves(job, pg, hints)
                    if halves:
                        best = halves
                        break
                if attempt < 2 and self.retry_wait:
                    _time.sleep(self.retry_wait * (attempt + 1))
                continue
            n = len(res.get("measures") or [])
            if best is None or n > len(best.get("measures") or []):
                best = res
            if job.kind == "system" and job.expect >= 2 and n < 0.6 * job.expect and not extra:
                extra = (f"Counting the barlines, this line holds about {job.expect} bars: transcribe every bar "
                         f"from the left edge to the right edge of the image, leaving none out.")
                continue
            break
        if best is not None:
            job.result, job.error = best, None
            n = len(best.get("measures") or [])
            job.short = bool(job.kind == "system" and job.expect >= 2 and n < 0.6 * job.expect)

    def _read_halves(self, job: _Job, pg: Page, hints: Hints) -> dict | None:
        """Reads a long line as two pieces cut at the barline nearest its middle."""
        bx0, by0, bx1, by1 = job.box
        mid = (bx0 + bx1) / 2
        cut = min(job.barlines[:-1] or job.barlines, key=lambda x: abs(x - mid))
        pad = int((job.space or 20) * 0.8)
        if not (bx0 + 4 * pad < cut < bx1 - 4 * pad):
            return None
        try:
            left = self._ask_crop(job, pg, (bx0, by0, min(bx1, cut + pad), by1), hints, None,
                                  "The image shows only the left part of the line; it ends at a barline.")
            clefs = list(left.get("clefs") or [])
            for m in left.get("measures") or []:                # a clef change in the left part carries on
                for st in m.get("staves") or []:
                    i = int(st.get("staff") or 1) - 1
                    for v in st.get("voices") or []:
                        for c in re.findall(r"clef=([a-z0-9]+)", v or ""):
                            if 0 <= i < len(clefs) and c in CLEFS:
                                clefs[i] = c
            right = self._ask_crop(job, pg, (max(bx0, cut - pad), by0, bx1, by1), hints, None,
                                   "The image shows only the right part of the line, starting at a barline, so no clef or "
                                   f"key signature is printed in it. Clefs, top to bottom: {', '.join(clefs) or 'as usual'}. "
                                   f"Key signature: {_key_text(int(left.get('key_fifths') or 0))}.")
        except AIError as e:
            job.error = str(e)
            return None
        return {**left, "measures": list(left.get("measures") or []) + list(right.get("measures") or []),
                "warnings": list(left.get("warnings") or []) + list(right.get("warnings") or [])}

    @staticmethod
    def _box_json(box, pg: Page):
        w, h = pg.size
        return [round(box[0] / w, 4), round(box[1] / h, 4), round(box[2] / w, 4), round(box[3] / h, 4)]

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _hint_text(hints: Hints) -> str:
        bits = []
        if hints.instrument:
            name = INSTRUMENTS.get(hints.instrument, (0, hints.instrument))[1]
            bits.append(f"The player says this is music for {name}.")
        if hints.description:
            bits.append(f"They describe it as: {hints.description}.")
        if hints.handwritten:
            bits.append("It is handwritten.")
        return " ".join(bits)

    def _parts_from(self, overview: dict | None, first: dict | None, hints: Hints) -> list[PartInfo]:
        parts: list[PartInfo] = []
        if overview and overview.get("parts"):
            for i, p in enumerate(overview["parts"]):
                n = max(1, min(4, int(p.get("staves") or 1)))
                clefs = [c for c in (p.get("clefs") or []) if c in CLEFS][:n]
                clefs += (["treble", "bass", "bass", "bass"][len(clefs):n] if n > 1 else ["treble"][len(clefs):1])
                inst = p.get("instrument") if p.get("instrument") in INSTRUMENTS else "other"
                parts.append(PartInfo(id=f"P{i + 1}", name=p.get("name") or INSTRUMENTS[inst][1], instrument=inst, staves=n, clefs=clefs))
        elif first:
            n = max(1, int(first.get("staff_count") or 1))
            clefs = [c for c in first.get("clefs", []) if c in CLEFS] or ["treble"] * n
            if n == 2 and clefs[:2] == ["treble", "bass"]:
                parts = [PartInfo(id="P1", name="Piano", instrument="piano", staves=2, clefs=clefs[:2])]
            else:
                parts = [PartInfo(id=f"P{i + 1}", name=f"Staff {i + 1}", instrument="other", staves=1, clefs=[clefs[i] if i < len(clefs) else "treble"]) for i in range(n)]
        else:
            parts = [PartInfo(id="P1", name="Music", instrument="other", staves=1, clefs=["treble"])]
        if hints.instrument in INSTRUMENTS and len(parts) == 1:
            parts[0].instrument = hints.instrument
            if parts[0].name in ("", "Music", "Staff 1"):
                parts[0].name = INSTRUMENTS[hints.instrument][1]
        return parts

    def _assemble(self, jobs: list[_Job], overview: dict | None, hints: Hints, pages: list[Page]):
        first = next((j.result for j in jobs if j.result), None)
        parts = self._parts_from(overview, first, hints)
        total = sum(p.staves for p in parts)
        slots = [(pi, si) for pi, p in enumerate(parts) for si in range(p.staves)]
        doc = ReadDoc(parts=parts)
        if overview:
            doc.title = (overview.get("title") or "").strip()
            doc.subtitle = (overview.get("subtitle") or "").strip()
            doc.composer = (overview.get("composer") or "").strip()
            doc.arranger = (overview.get("arranger") or "").strip()
            doc.lyricist = (overview.get("lyricist") or "").strip()
            doc.tempo_text = (overview.get("tempo_text") or "").strip()
            doc.tempo_bpm = overview.get("tempo_bpm") or None
            doc.key = int(overview.get("key_fifths") or 0)
            doc.mode = overview.get("mode") or "major"
            doc.time = parse_time(overview.get("time")) or (4, 4)
        if hints.title:
            doc.title = hints.title
        if not overview and first:
            doc.key = int(first.get("key_fifths") or 0)
            for m in first.get("measures", []):
                t = parse_time(m.get("time"))
                if t:
                    doc.time = t
                    break
        raws: list[_RawBar] = []
        key = doc.key
        cur_time = doc.time
        for job in jobs:
            if not job.result:
                if job.kind == "region":
                    continue                                  # an area that may not hold music at all
                # A line that could not be read is not dropped: it becomes empty bars, marked, so the bars after
                # it keep their place and the player sees exactly which line to check or read again.
                for k in range(max(1, job.expect)):
                    bar = Bar(number=0, parts=[[BarStaff(voices=[[Ev(kind="mrest", source="R")]]) for _ in range(p.staves)] for p in parts],
                              page=job.page, system=job.line - 1)
                    bar.flags.append(f"can't read: line {job.line} on page {job.page + 1} was not read"
                                     + (f" ({job.error})" if job.error and k == 0 else ""))
                    bar.uncertain = True
                    bar.unread = True
                    bar.box = self._bar_box(job, {}, pages)
                    doc.bars.append(bar)
                    raws.append(_RawBar(job=job, k=k, data={}, staff_count=total, clefs=[], key=key))
                continue
            res = job.result
            sys_key = res.get("key_fifths")
            sys_clefs = [c for c in res.get("clefs", []) if c in CLEFS]
            staff_count = int(res.get("staff_count") or len(sys_clefs) or total)
            for k, m in enumerate(res.get("measures", [])):
                bar = Bar(number=0, parts=[[BarStaff() for _ in range(p.staves)] for p in parts], page=job.page,
                          system=job.line - 1)
                if job.short and k == len(res.get("measures", [])) - 1:
                    bar.flags.append(f"can't read: only {len(res['measures'])} of about {job.expect} bars were read on this line")
                if k == 0 and sys_key is not None and not raws:
                    doc.key = key = int(sys_key)             # the zoomed-in first line beats the page overview
                elif k == 0 and sys_key is not None and int(sys_key) != key:
                    bar.key = int(sys_key)
                    key = bar.key
                if m.get("key_fifths") is not None and int(m["key_fifths"]) != key:
                    bar.key = int(m["key_fifths"])
                    key = bar.key
                t = parse_time(m.get("time"))
                if t and not raws:
                    doc.time = cur_time = t
                elif t and t != cur_time:
                    bar.time = cur_time = t
                if k == 0:
                    for idx, c in enumerate(sys_clefs[:total]):
                        bar.clefs[slots[idx]] = c
                bar.repeat_start = bool(m.get("repeat_start"))
                bar.repeat_end = bool(m.get("repeat_end"))
                end = (m.get("ending") or "").strip().strip(".")
                bar.ending = end or None
                bar.barline = m.get("barline") if m.get("barline") in ("double", "final") else None
                staves = sorted(m.get("staves", []), key=lambda s: s.get("staff", 0))
                if len(staves) != total:
                    bar.flags.append(f"{len(staves)} staves read, {total} expected")
                for idx, slot in enumerate(slots):
                    if idx < len(staves):
                        voices = staves[idx].get("voices") or ["R"]
                    else:
                        voices = ["R"]
                    parsed = []
                    for v in voices[:4]:
                        evs, errs = parse_voice(v)
                        if errs:
                            bar.flags.extend(errs[:3])
                        parsed.append(evs or [Ev(kind="mrest", source="R")])
                    bar.parts[slot[0]][slot[1]] = BarStaff(voices=parsed)
                if m.get("uncertain"):
                    bar.uncertain = True
                    if m.get("comment"):
                        bar.flags.append(f"reader unsure: {m['comment'][:160]}")
                    else:
                        bar.flags.append("reader unsure")
                bar.box = self._bar_box(job, m, pages)
                doc.bars.append(bar)
                raws.append(_RawBar(job=job, k=k, data=m, staff_count=staff_count, clefs=sys_clefs, key=key))
        if not any(not getattr(b, "unread", False) for b in doc.bars):
            raise AIError("No bars of music were found.")
        return doc, raws

    @staticmethod
    def _bar_box(job: _Job, m: dict, pages: list[Page]):
        w, h = pages[job.page].size
        bx0, by0, bx1, by1 = job.box
        px = m.get("_px")
        if px and job.kind == "system":
            px0, px1 = px
            if bx0 - 5 <= px0 < px1 <= bx1 + 5:
                return (round(px0 / w, 4), round(by0 / h, 4), round(px1 / w, 4), round(by1 / h, 4))
        return (round(bx0 / w, 4), round(by0 / h, 4), round(bx1 / w, 4), round(by1 / h, 4))

    def _validate(self, doc: ReadDoc) -> dict[int, list[str]]:
        """Bars that need a closer look: {bar index: reasons}. Also numbers the bars."""
        flags: dict[int, list[str]] = {}
        time = doc.time
        clefs = {(pi, si): (p.clefs[si] if si < len(p.clefs) else "treble") for pi, p in enumerate(doc.parts) for si in range(p.staves)}
        n = len(doc.bars)
        pickup = False
        for bi, bar in enumerate(doc.bars):
            if bar.time:
                time = bar.time
            need = measure_length(time)
            reasons = [r for r in bar.flags if not r.startswith(("bar has", "voice", "a note"))]
            for (pi, si), c in bar.clefs.items():
                clefs[(pi, si)] = c
            longest = Fraction(0)
            staff_lens: list[tuple[int, int, Fraction]] = []
            for pi, staves in enumerate(bar.parts):
                for si, st in enumerate(staves):
                    staff_len = None
                    for vi, v in enumerate(st.voices):
                        ln = voice_length(v)
                        if ln is None:                                   # whole-bar rest
                            staff_len = need
                            continue
                        staff_len = ln if staff_len is None else max(staff_len, ln)
                        if ln > need:
                            reasons.append(f"voice {vi + 1} on staff {si + 1} is {_beats(ln)} long; the bar holds {_beats(need)}")
                    if staff_len is not None:
                        staff_lens.append((pi, si, staff_len))
                        longest = max(longest, staff_len)
                    c = clefs.get((pi, si), "treble")
                    for v in st.voices:
                        for e in v:
                            if e.kind == "clef" and e.clef:
                                c = e.clef
                            lo, hi = CLEF_RANGE.get(c, (0, 127))
                            for p in e.pitches:
                                if not (lo - 3 <= p.midi <= hi + 3):
                                    reasons.append(f"a note ({p.step}{p.octave}) is far outside this clef's range")
                                    break
            # every staff must fill the bar; a pickup (first bar) or last bar may be shorter, but all staves alike
            target = longest if (bi == 0 or bi == n - 1) else need
            for pi, si, ln in staff_lens:
                if ln < target:
                    where = f"staff {si + 1}" + (f" of {doc.parts[pi].name}" if len(doc.parts) > 1 else "")
                    reasons.append(f"bar has {_beats(ln)} of music on {where}; {time[0]}/{time[1]} needs {_beats(target)}")
            if bi == 0 and longest and longest < need:
                pickup = True
            if reasons:
                flags[bi] = list(dict.fromkeys(reasons))
        for bi, bar in enumerate(doc.bars):
            bar.number = bi if pickup else bi + 1
        return flags

    def _pick_rereads(self, doc: ReadDoc, flags: dict[int, list[str]]) -> list[int]:
        def weight(reasons):
            w = 0
            for r in reasons:
                w += 3 if ("bar has" in r or "long;" in r or "can't read" in r) else 2 if "staves read" in r else 1
            return w
        ranked = sorted(((bi, r) for bi, r in flags.items() if not getattr(doc.bars[bi], "unread", False)),
                        key=lambda kv: -weight(kv[1]))
        limit = max(self.max_rereads, min(48, len(doc.bars) // 5))       # long pieces get more second looks
        return [bi for bi, reasons in ranked[:limit] if weight(reasons) >= 1]

    def _reread(self, doc: ReadDoc, raws: list[_RawBar], targets: list[int], pages: list[Page], hints: Hints, say: Progress):
        time_at = {}
        t = doc.time
        for bi, bar in enumerate(doc.bars):
            if bar.time:
                t = bar.time
            time_at[bi] = t
        flags_before = self._validate(doc)
        done = [0]
        first_reread = _CacheGate()

        def one(bi: int):
            gate = first_reread.enter()
            try:
                return _one(bi, gate)
            finally:
                if gate is not None:
                    gate.set()

        def _one(bi: int, gate: threading.Event | None):
            raw = raws[bi]
            job = raw.job
            pg = pages[job.page]
            bx0, by0, bx1, by1 = job.box
            px = raw.data.get("_px")
            if px and job.kind == "system":
                sp = job.space or 20
                left = px[0] - 1.2 * sp
                right = px[1] + 1.2 * sp
                box = (max(bx0, int(left)), by0, min(bx1, int(right)), by1)
                what = f"one bar (bar {doc.bars[bi].number}) cut out of line {job.line} on page {job.page + 1}; the image shows {raw.staff_count} staves"
                target = "this bar"
            else:
                box = job.box
                what = f"line {job.line} on page {job.page + 1}"
                target = f"bar {raw.k + 1} of this line (count bars from the left)"
            img = pg.image.crop(box)
            png = encode_png(img, min_space=30, space=job.space or None)
            tm = time_at[bi]
            clefs = ", ".join(raw.clefs) or "see image"
            ctx = (f"Time signature: {tm[0]}/{tm[1]}. Key signature: {_key_text(raw.key)}. Clefs top to bottom: {clefs}. "
                   + self._hint_text(hints))
            first = "\n".join(f"staff {s.get('staff')}: " + " | ".join(s.get("voices") or []) for s in raw.data.get("staves", []))
            problem = "; ".join(flags_before.get(bi, [])) or "it needs checking"
            prompt = REREAD_PROMPT_TMPL.format(what=what, context=ctx, first=first or "(nothing)", problem=problem,
                                               target=target, count_text="exactly one bar in measures")
            try:
                res = self.reread_ai.ask_json(READER_SYSTEM, [image_block(png), text_block(prompt)], REREAD_SCHEMA,
                                              effort="high", max_tokens=16000, started=gate)
            except AIError:
                res = None
            done[0] += 1
            say("checking", 0.76 + 0.18 * done[0] / max(1, len(targets)), f"Checked {done[0]} of {len(targets)} bars")
            return bi, res

        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            results = list(pool.map(one, targets))
        for bi, res in results:
            if not res or not res.get("measures"):
                continue
            m = res["measures"][0]
            bar = doc.bars[bi]
            old_parts = bar.parts
            old_flags = list(bar.flags)
            slots = [(pi, si) for pi, p in enumerate(doc.parts) for si in range(p.staves)]
            staves = sorted(m.get("staves", []), key=lambda s: s.get("staff", 0))
            new_parts = [[BarStaff() for _ in range(p.staves)] for p in doc.parts]
            new_flags = []
            for idx, slot in enumerate(slots):
                voices = (staves[idx].get("voices") if idx < len(staves) else None) or ["R"]
                parsed = []
                for v in voices[:4]:
                    evs, errs = parse_voice(v)
                    new_flags.extend(errs[:3])
                    parsed.append(evs or [Ev(kind="mrest", source="R")])
                new_parts[slot[0]][slot[1]] = BarStaff(voices=parsed)
            if len(staves) != len(slots):
                new_flags.append(f"{len(staves)} staves read, {len(slots)} expected")
            if m.get("uncertain"):
                new_flags.append("reader unsure" + (f": {m['comment'][:160]}" if m.get("comment") else ""))
            bar.parts, bar.flags = new_parts, new_flags
            after = self._validate(doc).get(bi, [])
            if len(after) > len(flags_before.get(bi, [])):
                bar.parts, bar.flags = old_parts, old_flags          # the second reading was worse: keep the first
            else:
                raws[bi].data = {**raws[bi].data, "staves": m.get("staves", [])}

    def _finish(self, doc: ReadDoc) -> None:
        """Octave clefs, key signatures and carried accidentals, ties across bars."""
        key = doc.key
        clefs = {(pi, si): (p.clefs[si] if si < len(p.clefs) else "treble") for pi, p in enumerate(doc.parts) for si in range(p.staves)}
        last: dict[tuple[int, int, int], Ev | None] = {}
        for bar in doc.bars:
            if bar.key is not None:
                key = bar.key
            for (pi, si), c in bar.clefs.items():
                clefs[(pi, si)] = c
            for pi, staves in enumerate(bar.parts):
                for si, st in enumerate(staves):
                    c = clefs[(pi, si)]
                    for v in st.voices:
                        cc = c
                        for e in v:
                            if e.kind == "clef" and e.clef:
                                cc = e.clef
                            shift = OCTAVE_SHIFT.get(cc, 0)
                            if shift:
                                for p in e.pitches:
                                    p.octave += shift
                    for e in (st.voices[0] if st.voices else []):
                        if e.kind == "clef" and e.clef:
                            clefs[(pi, si)] = e.clef
                    tied_in = {vi: last.get((pi, si, vi)) for vi in range(len(st.voices))}
                    resolve_alters(st.voices, key, tied_in)
                    for vi, v in enumerate(st.voices):
                        timed = [e for e in v if e.kind in ("note", "rest", "mrest") and not e.grace]
                        last[(pi, si, vi)] = timed[-1] if timed else None

    @staticmethod
    def _flag_json(doc: ReadDoc, bi: int, reasons: list[str]) -> dict:
        bar = doc.bars[bi]
        return {"index": bi, "bar": bar.number, "page": bar.page + 1, "line": bar.system + 1, "box": bar.box,
                "reasons": reasons, **({"unread": True} if getattr(bar, "unread", False) else {})}


def _beats(q: Fraction) -> str:
    v = float(q)
    s = f"{v:g}"
    return f"{s} quarter note{'s' if v != 1 else ''}"


def _key_text(fifths: int) -> str:
    if fifths == 0:
        return "no sharps or flats"
    return f"{abs(fifths)} {'sharp' if fifths > 0 else 'flat'}{'s' if abs(fifths) != 1 else ''}"
