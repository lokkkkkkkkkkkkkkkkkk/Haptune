"""Score model, MusicXML parser (checked against music21), repeats, jianpu, exercises."""
import collections
import random

import pytest

from haptune.exercises import scale
from haptune.jianpu import parse_jianpu
from haptune.score import Score, load_musicxml, midi_name, score_from_notes


def _m21_notes(path):
    import music21 as m21
    s = m21.converter.parse(path).toSoundingPitch()
    out = collections.Counter()
    for part in s.parts:
        for mi, meas in enumerate(part.getElementsByClass("Measure")):
            for el in meas.recurse().notes:
                if el.duration.isGrace or isinstance(el, m21.harmony.Harmony):
                    continue
                if el.tie is not None and el.tie.type in ("stop", "continue"):
                    continue
                off = round(round(float(el.getOffsetInHierarchy(meas)) * 96) / 96, 3)
                for p in (el.pitches if el.isChord else [el.pitch]):
                    out[(mi, off, p.midi)] += 1
    return out


@pytest.mark.parametrize("seed", [1])
def test_musicxml_parser_matches_music21(seed):
    from music21 import corpus
    paths = [str(p) for p in corpus.getPaths() if str(p).endswith((".mxl", ".xml", ".musicxml"))
             and "demos" not in str(p)]
    random.Random(seed).shuffle(paths)
    tot = inter = 0
    for p in paths[:40]:
        mine = load_musicxml(p, expand_repeats=False)
        a = collections.Counter()
        for n in mine.notes:
            if n.grace or n.pitch is None:
                continue
            m = mine.measures[n.measure]
            a[(n.measure, round(round((n.onset - m.start) * 96) / 96, 3), n.pitch)] += 1
        b = _m21_notes(p)
        inter += sum((a & b).values())
        tot += sum(a.values()) + sum(b.values())
    assert 2 * inter / tot > 0.998


def test_json_roundtrip():
    sc = score_from_notes([(0, 1, 60), (1, 1, 62), (2, 2, 64)], qpm=90, title="t")
    sc2 = Score.from_json(sc.to_json())
    assert [(n.onset, n.pitch) for n in sc2.notes] == [(n.onset, n.pitch) for n in sc.notes]
    assert sc2.beat_to_sec(2.0) == pytest.approx(sc.beat_to_sec(2.0))


def test_repeats_and_endings(tmp_path):
    xml = """<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
<part id="P1">
<measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
 <barline location="left"><repeat direction="forward"/></barline>
 <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration></note></measure>
<measure number="2"><barline location="left"><ending number="1" type="start"/></barline>
 <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration></note>
 <barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>
<measure number="3"><barline location="left"><ending number="2" type="start"/></barline>
 <note><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration></note>
 <barline location="right"><ending number="2" type="discontinue"/></barline></measure>
<measure number="4"><note><pitch><step>F</step><octave>5</octave></pitch><duration>2</duration></note></measure>
</part></score-partwise>"""
    p = tmp_path / "r.musicxml"
    p.write_text(xml)
    sc = load_musicxml(str(p))
    assert [midi_name(n.pitch) for n in sc.notes] == ["C5", "D5", "C5", "E5", "F5"]
    assert [m.label for m in sc.measures] == ["1", "2", "1", "3", "4"]


def test_transposing_instrument(tmp_path):
    xml = """<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"><part-name>Clarinet in B-flat</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions>
<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes>
<note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration></note></measure></part></score-partwise>"""
    p = tmp_path / "c.musicxml"
    p.write_text(xml)
    sc = load_musicxml(str(p))
    n = sc.notes[0]
    assert n.written == 74 and n.pitch == 72          # reads D5, sounds C5
    assert sc.parts[0].instrument == "clarinet"


def test_jianpu():
    sc = parse_jianpu("key: 1=F\ntime: 2/4\ntempo: 72\n---\n3 3_5_ | 6_1'_1'_6_ | 5 - |")
    assert [midi_name(n.pitch) for n in sc.notes] == ["A4", "A4", "C5", "D5", "F5", "F5", "D5", "C5"]
    assert sc.notes[-1].duration == 2.0
    assert len(sc.measures) == 3


def test_scales():
    sc = scale("D", "major", 2, "violin")
    names = [midi_name(n.pitch) for n in sc.notes]
    assert names[:8] == ["D4", "E4", "F#4", "G4", "A4", "B4", "C#5", "D5"]
    assert names[-1] == "D4"
    mm = scale("A", "melodic_minor", 1, "cello")
    up = [midi_name(n.pitch) for n in mm.notes][:8]
    assert up[5:7] == ["F#3", "G#3"]
