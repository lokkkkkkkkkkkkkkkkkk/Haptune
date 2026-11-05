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
