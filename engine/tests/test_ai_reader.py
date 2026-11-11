"""AI sheet-music reader: notation parser, accidentals, MusicXML writer, page layout, and the whole
pipeline with a fake model (no API key needed)."""
import os
from fractions import Fraction

import pytest

from haptune.ai.claude import Claude
from haptune.ai.layout import analyse_page, load_pages
from haptune.ai.mxl import Bar, BarStaff, PartInfo, ReadDoc, harmony_xml, write_musicxml
from haptune.ai.notation import parse_voice, resolve_alters, voice_length
from haptune.ai.reader import Hints, Reader, parse_time
from haptune.score import load_musicxml

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "..", "samples")


def test_parse_voice_tokens_and_lengths():
    evs, errs = parse_voice("C5/4!mf!slur-start 3( D5/8 E5/8 F#5/8 ) g( A5/16 ) G5/4.~!fermata r/8")
    assert not errs
    kinds = [e.kind for e in evs]
    assert kinds == ["note", "note", "note", "note", "note", "note", "rest"]
    assert evs[0].dynamics == ["mf"] and "slur-start" in evs[0].marks
    assert evs[1].tuplet == (3, 2) and evs[1].tuplet_pos == "start" and evs[3].tuplet_pos == "stop"
    assert evs[4].grace and evs[4].dur == 0
    assert evs[5].tie and evs[5].dots == 1 and "fermata" in evs[5].marks
    assert voice_length(evs) == Fraction(1) + Fraction(1) + Fraction(3, 2) + Fraction(1, 2)


def test_parse_voice_reports_errors_without_raising():
    evs, errs = parse_voice("C5/4 X9/4 D5 3( E5/8")
    assert len(evs) == 2 and len(errs) == 3


def test_parse_accidental_written_before_the_letter():
    evs, errs = parse_voice("bC5/16 #F4+nB4/8!stacc bbB3/4 bb4/8")
    assert not errs
    assert [(p.step, p.acc, p.octave) for e in evs for p in e.pitches] == \
        [("C", "b", 5), ("F", "#", 4), ("B", "n", 4), ("B", "bb", 3), ("B", "b", 4)]
    assert "staccato" in evs[1].marks


def test_parse_marks_text_and_lyrics():
    evs, errs = parse_voice('C4+E4+G4/2!chord="C"!words="dolce cantabile"!ly="Twin-"!tempo="Allegro"!bpm=120 R')
    assert not errs
    e = evs[0]
    assert e.chord == "C" and e.words == ["dolce cantabile"] and e.lyrics == {1: "Twin-"}
    assert e.tempo_text == "Allegro" and e.bpm == 120 and len(e.pitches) == 3
    assert evs[1].kind == "mrest" and voice_length(evs[1:]) is None


def test_accidentals_follow_key_and_carry_through_the_bar():
    evs, _ = parse_voice("F5/8 Fn5/8 F5/8 C5/8 F4/4")         # G major: F is F#; natural carries for F5 only
    resolve_alters([evs], 1)
    assert [p.midi for e in evs for p in e.pitches] == [78, 77, 77, 72, 66]


def test_tie_keeps_spelling_into_the_next_bar():
    bar1, _ = parse_voice("C#5/2~")                           # C major, printed sharp, tied over the barline
    resolve_alters([bar1], 0)
    bar2, _ = parse_voice("C5/4 C5/4")
    resolve_alters([bar2], 0, {0: bar1[-1]})
    assert bar2[0].pitches[0].midi == 73 and bar2[0].pitches[0].tie_stop
    assert bar2[1].pitches[0].midi == 72                      # the sharp does not carry past the tied note


def test_harmony_symbols():
    assert "<kind text=\"m7\">minor-seventh</kind>" in harmony_xml("F#m7")
    assert "<bass-step>B</bass-step>" in harmony_xml("G/B")
    assert harmony_xml("dolce") == ""


def test_parse_time():
    assert parse_time("3/4") == (3, 4) and parse_time("C") == (4, 4) and parse_time("C|") == (2, 2)
    assert parse_time("") is None and parse_time("7/5") is None


def _doc(voices_by_bar, key=1, time=(3, 4)):
    doc = ReadDoc(title="T", key=key, time=time, parts=[PartInfo(id="P1", name="Piano", instrument="piano", staves=2, clefs=["treble", "bass"])])
    prev = {}
    for i, (rh, lh) in enumerate(voices_by_bar):
        staves = []
        for si, voices in enumerate((rh, lh)):
            parsed = [parse_voice(v)[0] for v in voices]
            resolve_alters(parsed, key, {vi: prev.get((si, vi)) for vi in range(len(parsed))})
            for vi, v in enumerate(parsed):
                prev[(si, vi)] = v[-1]
            staves.append(BarStaff(voices=parsed))
        doc.bars.append(Bar(number=i + 1, parts=[staves]))
    return doc


def test_writer_two_voices_dynamics_and_engine_roundtrip():
    doc = _doc([
        (["D5/4!p!cresc-start G4/8 A4/8 B4/8 C5/8!cresc-end"], ["G3+B3/2 A3/4"]),
        (["D5/2.!f", "G4/4 F4/4 G4/4"], ["B3/2.!ped=start"]),          # two voices on the treble staff
    ])
    xml = write_musicxml(doc)
    assert "<staves>2</staves>" in xml and "<backup>" in xml and "<dynamics><p/></dynamics>" in xml
    assert 'wedge type="crescendo"' in xml and "<stem>up</stem>" in xml and "<pedal" in xml
    sc = load_musicxml(xml.encode())
    assert sorted(n.pitch for n in sc.notes if n.measure == 0) == [55, 57, 59, 67, 69, 71, 72, 74]
    assert sorted(n.pitch for n in sc.notes if n.measure == 1) == [59, 66, 67, 67, 74]   # F in G major is F#4


def test_writer_writes_the_tempo_once():
    doc = _doc([(['D5/4!tempo="Allegro" G4/8 A4/8 B4/8 C5/8'], ["G3+B3/2 A3/4"])])
    doc.tempo_text = "Allegro"                                   # the page overview found it too
    assert write_musicxml(doc).count("Allegro") == 1
    doc = _doc([(["D5/4 G4/8 A4/8 B4/8 C5/8"], ["G3+B3/2 A3/4"])])
    doc.tempo_text, doc.tempo_bpm = "Allegro", 132
    xml = write_musicxml(doc)
    assert xml.count("Allegro") == 1 and "<per-minute>132</per-minute>" in xml


def test_cache_gate_lets_one_request_start_first():
    import threading
    import time
    from haptune.ai.reader import _CacheGate
    gate, log = _CacheGate(timeout=5), []

    def worker():
        ev = gate.enter()
        log.append((ev is not None, time.monotonic()))
        if ev is not None:
            time.sleep(0.2)
            ev.set()                                             # its answer started: the cache is written
    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    first = [t for is_first, t in log if is_first]
    assert len(first) == 1
    assert all(t >= first[0] + 0.15 for is_first, t in log if not is_first)


def test_writer_pickup_bar_is_implicit():
    doc = _doc([(["D5/4"], ["r/4"]), (["G4/2."], ["G3/2."])])
    xml = write_musicxml(doc)
    assert '<measure number="0" implicit="yes">' in xml


@pytest.fixture(scope="module")
def minuet():
    from ai_fixtures import render_pdf, score_to_bars
    path = os.path.join(SAMPLES, "minuet_piano.musicxml")
    bars, meta = score_to_bars(path)
    return path, bars, meta, render_pdf(path, bars_per_line=4)


def test_layout_finds_every_line(minuet):
    _, bars, meta, pdf = minuet
    pages = [analyse_page(img, i) for i, img in enumerate(load_pages(pdf, "m.pdf"))]
    systems = [s for p in pages for s in p.systems]
    assert len(systems) == len(bars) // 4
    assert all(len(s.staves) == len(meta["parts"]) for s in systems)


def _draw_system(a, top, x0=208, x1=1150, staves=3, brace=True, barline=True):
    """Draws `staves` staves (space 20 px) starting at row `top`; the lower two are a braced grand staff."""
    tops = [top + i * 200 for i in range(staves)]
    for t in tops:
        for k in range(5):
            a[t + 20 * k:t + 20 * k + 2, x0:x1] = 0
    if barline:
        a[tops[0]:tops[-1] + 82, x0:x0 + 2] = 0                 # system barline at the start of the lines
    if brace:
        a[tops[-2]:tops[-1] + 82, x0 - 20:x0 - 12] = 0          # brace left of it, touching the staff lines
    return a


def test_layout_keeps_a_voice_staff_with_its_braced_piano():
    import numpy as np
    from PIL import Image
    from haptune.ai.layout import binarize, find_systems
    a = np.full((1700, 1200), 255, dtype=np.uint8)
    _draw_system(a, 60)
    _draw_system(a, 900)
    systems = find_systems(binarize(Image.fromarray(a)))
    assert [len(s.staves) for s in systems] == [3, 3]


def test_layout_joins_a_system_whose_barline_was_missed():
    import numpy as np
    from PIL import Image
    from haptune.ai.layout import binarize, find_systems
    a = np.full((2500, 1200), 255, dtype=np.uint8)
    _draw_system(a, 60)
    _draw_system(a, 900, barline=False)                         # voice staff not joined: looks like 1 + 2
    _draw_system(a, 1740)
    systems = find_systems(binarize(Image.fromarray(a)))
    assert [len(s.staves) for s in systems] == [3, 3, 3]
    assert systems[1].box[1] < 900 < 1300 < systems[1].box[3]


def test_layout_finds_a_short_last_line():
    import numpy as np
    from PIL import Image
    from haptune.ai.layout import binarize, find_systems
    a = np.full((1500, 2400), 255, dtype=np.uint8)
    _draw_system(a, 100, x1=2300, staves=2)
    _draw_system(a, 600, x1=2300, staves=2)
    _draw_system(a, 1100, x1=700, staves=2)                    # the piece ends a fifth of the way across
    systems = find_systems(binarize(Image.fromarray(a)))
    assert [len(s.staves) for s in systems] == [2, 2, 2]
    assert systems[-1].box[2] < 1000


def test_layout_does_not_take_lines_of_text_for_a_staff():
    import numpy as np
    from PIL import Image
    from haptune.ai.layout import binarize, find_systems
    a = np.full((1500, 2400), 255, dtype=np.uint8)
    _draw_system(a, 100, x1=2300, staves=2)
    _draw_system(a, 600, x1=2300, staves=2)
    for k in range(5):                                          # five evenly spaced lines of words below
        y = 1050 + 48 * k
        for x in range(208, 1400, 45):
            a[y:y + 16, x:x + 30] = 0
    systems = find_systems(binarize(Image.fromarray(a)))
    assert [len(s.staves) for s in systems] == [2, 2]


def test_reader_end_to_end_with_a_fake_model(minuet):
    from ai_fixtures import FakeReaderClient
    path, bars, meta, pdf = minuet
    wrong = {1: [[bars[1][0][0].split(" ")[0]], bars[1][1]]}            # bar 2 read with notes missing
    fake = FakeReaderClient(bars, meta, bars_per_line=4, mistakes=wrong)
    stages = []
    result = Reader(Claude(client=fake), workers=4).read(pdf, "minuet.pdf", Hints(instrument="piano"),
                                                           progress=lambda s, f, m: stages.append((s, f)))
    assert fake.calls.count("overview") == 1 and fake.calls.count("line") == len(bars) // 4
    assert fake.calls.count("reread") == 1                              # only the wrong bar was looked at again
    assert result.flags == []                                           # and the second reading fixed it
    assert stages[-1][0] == "done" and all(a[1] <= b[1] for a, b in zip(stages, stages[1:]))
    original = load_musicxml(path)
    got = load_musicxml(result.musicxml.encode())
    assert [(n.pitch, round(n.onset, 3), round(n.duration, 3)) for n in sorted(got.notes, key=lambda n: (n.onset, n.pitch))] == \
           [(n.pitch, round(n.onset, 3), round(n.duration, 3)) for n in sorted(original.notes, key=lambda n: (n.onset, n.pitch))]
    assert result.doc.title == "Minuet in G" and result.report["bars"] == len(bars)


def test_reader_flags_bars_it_could_not_fix(minuet):
    from ai_fixtures import FakeReaderClient
    path, bars, meta, pdf = minuet
    fake = FakeReaderClient(bars, meta, bars_per_line=4, mistakes={})
    fake.bars = [row[:] for row in bars]
    fake.bars[5] = [["G4/4"], bars[5][1]]                               # wrong both times
    fake.mistakes = {5: fake.bars[5]}
    result = Reader(Claude(client=fake), workers=4).read(pdf, "minuet.pdf")
    assert [f["bar"] for f in result.flags] == [6]
    assert "needs" in result.flags[0]["reasons"][0]


def test_a_line_that_cannot_be_read_keeps_its_place(minuet):
    """Lines used to vanish when a request failed, leaving half a piece. Now the line becomes marked, empty
    bars: the bars after it keep their numbers and the report says which page and line to look at."""
    from ai_fixtures import FakeReaderClient
    path, bars, meta, pdf = minuet
    fake = FakeReaderClient(bars, meta, bars_per_line=4, fail_lines={1})
    reader = Reader(Claude(client=fake), workers=4)
    reader.retry_wait = 0
    result = reader.read(pdf, "minuet.pdf")
    assert fake.line_asks[1] == 3                                       # tried three times before giving up
    assert result.report["bars"] == len(bars)                           # 4 placeholders stand in for the line
    assert result.report["failed_lines"] == [{"page": 1, "line": 2, "error": "the reader is down", "bars": 4,
                                              "box": result.report["failed_lines"][0]["box"]}]
    unread = [f for f in result.flags if f.get("unread")]
    assert [f["bar"] for f in unread] == [5, 6, 7, 8] and all(f["line"] == 2 for f in unread)
    got = load_musicxml(result.musicxml.encode())
    original = load_musicxml(path)
    after = [(n.pitch, round(n.onset, 3)) for n in sorted(got.notes, key=lambda n: (n.onset, n.pitch)) if n.onset >= 24]
    assert after == [(n.pitch, round(n.onset, 3)) for n in sorted(original.notes, key=lambda n: (n.onset, n.pitch)) if n.onset >= 24]


def test_a_line_that_comes_back_short_is_asked_for_again(minuet):
    from ai_fixtures import FakeReaderClient
    path, bars, meta, pdf = minuet
    fake = FakeReaderClient(bars, meta, bars_per_line=4, short_lines={2})
    result = Reader(Claude(client=fake), workers=4).read(pdf, "minuet.pdf")
    assert fake.line_asks[2] == 2                                       # the barlines said 4 bars, 1 came back
    assert result.report["bars"] == len(bars) and result.report["short_lines"] == [] and result.flags == []


def test_a_page_without_measurable_staves_is_split_into_its_lines_first():
    """A photo whose staff lines can't be measured used to be read whole in one answer (long answers lose bars).
    The model is asked where the lines are, then each is read on its own."""
    import numpy as np
    from PIL import Image
    from ai_fixtures import FakeReaderClient
    bars = [[["C4/1"]], [["D4/1"]], [["E4/1"]], [["F4/1"]]]
    meta = {"fifths": 0, "time": "4/4", "parts": ["Music"]}
    page = Image.fromarray(np.full((1200, 900), 255, dtype=np.uint8))   # nothing to measure on a blank page
    buf = __import__("io").BytesIO()
    page.save(buf, format="PNG")
    fake = FakeReaderClient(bars, meta, bars_per_line=2, instrument="violin",
                            locate=[{"top": 200, "bottom": 260, "staves": 1}, {"top": 600, "bottom": 660, "staves": 1}])
    result = Reader(Claude(client=fake), workers=2).read(buf.getvalue(), "photo.png")
    assert fake.calls.count("locate") == 1 and fake.calls.count("line") == 2
    assert result.report["lines"] == 2 and result.report["bars"] == 4


def test_barlines_count_the_bars_of_each_line(minuet):
    from haptune.ai.layout import analyse_page, load_pages
    path, bars, meta, pdf = minuet
    pg = analyse_page(load_pages(pdf, "minuet.pdf")[0])
    assert list(pg.bars.values()) == [4] * (len(bars) // 4) and pg.regions == []


def test_photo_cleanup_evens_out_a_shadow():
    import numpy as np
    from PIL import Image
    from haptune.ai.layout import clean_photo, is_photo
    a = np.full((400, 600), 200, dtype=np.float32)
    a *= np.linspace(1.0, 0.45, 600)[None, :]                           # a shadow across the page
    a[100:104, 50:550] *= 0.25                                          # a staff line, darker than the paper everywhere
    img = Image.fromarray(a.astype(np.uint8))
    assert is_photo(img)
    out = np.asarray(clean_photo(img), dtype=np.float32)
    assert out[50, 60] > 215 and out[50, 540] > 215                     # paper is white on both sides
    assert out[102, 60] < 120 and out[102, 540] < 120                   # the line is dark on both sides
