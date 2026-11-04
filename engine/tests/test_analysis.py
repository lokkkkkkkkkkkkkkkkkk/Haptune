"""End-to-end checks on synthesized takes with planted mistakes."""
import numpy as np
import pytest

from haptune import dsp
from haptune.demo_pieces import minuet_in_g
from haptune.evaluate import evaluate
from haptune.follower import simulate
from haptune.instruments import get_profile
from haptune.master_score import recording_to_score
from haptune.synth import Mistake, perform, render_tone
from haptune.tuner import tune


@pytest.mark.parametrize("inst,midi", [("violin", 69), ("cello", 43), ("voice_soprano", 72), ("flute", 84),
                                        ("double_bass", 33), ("guitar", 52)])
def test_yin_accuracy(inst, midi):
    prof = get_profile(inst)
    tr = dsp.yin(render_tone(inst, midi, 1.0), fmin=prof.fmin, fmax=prof.fmax)
    v = tr.voiced & (tr.times > 0.2) & (tr.times < 0.8)
    assert abs(np.median(tr.midi[v]) - midi) * 100 < 5        # within 5 cents


def _truth_vs_engine(sc, perf, ev):
    res = {r.note_id: r for r in ev.notes}
    order = sc.playable_notes()
    false_alarms = missed_errors = 0
    for i, n in enumerate(order):
        flagged = res[n.id].status in ("wrong", "missed")
        truth_err = perf.truth[i] in ("wrong", "miss")
        false_alarms += flagged and not truth_err
        missed_errors += truth_err and not flagged
    return false_alarms, missed_errors


MISTAKES = [Mistake(13, "wrong", -1), Mistake(20, "miss"), Mistake(6, "flat", 40), Mistake(35, "sharp", 35),
            Mistake(44, "wrong", 2)]


@pytest.mark.parametrize("inst,shift", [("violin", 0), ("voice_soprano", -5), ("flute", 0), ("clarinet", 0),
                                         ("cello", -24), ("erhu", 0)])
def test_mono_evaluation_catches_mistakes(inst, shift):
    sc = minuet_in_g(transpose=shift)
    perf = perform(sc, inst, mistakes=MISTAKES, rubato=0.03, seed=21)
    ev = evaluate(sc, perf.audio, inst)
    fa, miss = _truth_vs_engine(sc, perf, ev)
    assert fa == 0 and miss == 0
    res = {r.note_id: r for r in ev.notes}
    order = sc.playable_notes()
    assert "flat" in (res[order[6].id].intonation or "")
    assert "sharp" in (res[order[35].id].intonation or "")


@pytest.mark.parametrize("inst", ["piano", "guitar"])
def test_poly_evaluation(inst):
    sc = minuet_in_g(with_bass=True, transpose=0 if inst == "piano" else -12)
    perf = perform(sc, inst, mistakes=[Mistake(9, "wrong", -1), Mistake(30, "miss")], rubato=0.03, seed=21)
    ev = evaluate(sc, perf.audio, inst)
    fa, miss = _truth_vs_engine(sc, perf, ev)
    assert fa == 0 and miss <= 1


def test_clean_take_noisy_room_has_no_false_alarms():
    sc = minuet_in_g()
    perf = perform(sc, "violin", rubato=0.08, jitter_ms=25, snr_db=18, reverb=0.4, seed=4)
    ev = evaluate(sc, perf.audio, "violin")
    assert ev.scores["counts"]["wrong"] == 0 and ev.scores["counts"]["missed"] == 0


def test_rushing_is_reported():
    sc = minuet_in_g()
    perf = perform(sc, "violin", tempo_curve=lambda b: 1.2 if 36 <= b < 42 else 1.0, seed=3)
    ev = evaluate(sc, perf.audio, "violin")
    assert any("Speeding up" in t for t in ev.tips)


def test_live_follower_buzzes_on_wrong_notes():
    sc = minuet_in_g()
    perf = perform(sc, "violin", mistakes=[Mistake(13, "wrong", -1), Mistake(44, "wrong", 2)], seed=21)
    f = simulate(sc, perf.audio, "violin")
    wrong_times = [p.onset for p in perf.notes if p.label == "wrong"]
    buzz = [b for b in f.buzzed if b.type == "wrong_note"]
    assert len(buzz) == 2
    assert all(min(abs(b.time - t) for t in wrong_times) < 0.15 for b in buzz)


def test_recording_to_score():
    sc = minuet_in_g(qpm=100)
    perf = perform(sc, "flute", rubato=0.03, seed=11)
    rec = recording_to_score(perf.audio, "flute")
    assert [n.pitch for n in rec.notes] == [n.pitch for n in sc.notes]
    assert abs(rec.source["bpm"] - 100) < 6
    assert rec.source["key"] in ("G major", "E minor")


def test_tuner():
    r = tune(render_tone("violin", 69.15, 0.5), "violin")
    assert r["note"] == "A4" and 10 < r["cents"] < 20 and r["string"] == "A4"
