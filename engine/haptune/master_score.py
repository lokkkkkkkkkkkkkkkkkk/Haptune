"""Recording -> sheet music ("master score").

Turns a solo recording (a teacher playing the piece, a YouTube cover of a solo
instrument, your own improvisation) into a practice score:

    transcribe notes -> track the beat -> quantise to a 16th-note / triplet grid
    -> estimate key and metre -> Score (+ MusicXML for display)

Works best on a single instrument or voice. Full band mixes need source
separation first (planned server step, e.g. Demucs), see README.
"""
from __future__ import annotations

import math

import numpy as np

from . import dsp
from .instruments import get_profile
from .score import Measure, Note, Part, Score
from .transcribe import transcribe

KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
FIFTHS_OF_PC = {0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5}


def estimate_key(pitches: list[int], weights: list[float]) -> tuple[int, str, int]:
    """Krumhansl-Schmuckler. Returns (tonic pitch class, mode, key-signature fifths)."""
    hist = np.zeros(12)
    for p, w in zip(pitches, weights):
        hist[p % 12] += w
    best = (-2.0, 0, "major")
    for tonic in range(12):
        for mode, prof in (("major", KS_MAJOR), ("minor", KS_MINOR)):
            r = np.corrcoef(hist, np.roll(prof, tonic))[0, 1]
            if r > best[0]:
                best = (r, tonic, mode)
    _, tonic, mode = best
    rel_major = tonic if mode == "major" else (tonic + 3) % 12
    return tonic, mode, FIFTHS_OF_PC[rel_major]


def estimate_tempo(odf: np.ndarray, hop_s: float, lo_bpm: float = 50, hi_bpm: float = 200,
                   prior_bpm: float = 100) -> float:
    o = odf - odf.mean()
    ac = np.correlate(o, o, mode="full")[len(o) - 1:]
    ac /= ac[0] + 1e-12
    best, best_bpm = -1e9, prior_bpm
    for bpm in np.arange(lo_bpm, hi_bpm, 0.5):
        lag = 60.0 / bpm / hop_s
        k = int(round(lag))
        if k + 1 >= len(ac):
            continue
        # sum the beat lag and its multiples, weighted by a log-normal tempo prior
        val = ac[k] + 0.5 * ac[min(len(ac) - 1, 2 * k)] + 0.25 * ac[min(len(ac) - 1, 4 * k)]
        val *= math.exp(-0.5 * (math.log2(bpm / prior_bpm) / 0.9) ** 2)
        if val > best:
            best, best_bpm = val, bpm
    return float(best_bpm)


def track_beats(odf: np.ndarray, hop_s: float, bpm: float, tightness: float = 100.0) -> np.ndarray:
    """Ellis (2007) dynamic-programming beat tracker. Returns beat times (s)."""
    period = 60.0 / bpm / hop_s
    o = odf / (np.std(odf) + 1e-12)
    n = len(o)
    score = o.copy()
    back = np.full(n, -1)
    lo, hi = int(round(period / 2)), int(round(period * 2))
    for t in range(lo, n):
        prev = np.arange(max(0, t - hi), t - lo + 1)
        if prev.size == 0:
            continue
        pen = -tightness * (np.log((t - prev) / period)) ** 2
        cand = score[prev] + pen
        k = int(np.argmax(cand))
        score[t] = o[t] + cand[k]
        back[t] = prev[k]
    end_region = max(0, n - int(period * 1.5))
    t = end_region + int(np.argmax(score[end_region:]))
    beats = [t]
    while back[t] >= 0:
        t = back[t]
        beats.append(t)
    return np.array(beats[::-1]) * hop_s


def _beat_position(t: float, beats: np.ndarray) -> float:
    """Continuous beat index for time t, extrapolating before the first / after the last beat."""
    if len(beats) < 2:
        return t / 0.6
    if t <= beats[0]:
        return (t - beats[0]) / (beats[1] - beats[0])
    if t >= beats[-1]:
        return len(beats) - 1 + (t - beats[-1]) / (beats[-1] - beats[-2])
    k = int(np.searchsorted(beats, t)) - 1
    return k + (t - beats[k]) / (beats[k + 1] - beats[k])


def _quantise(x: float) -> float:
    """Nearest 1/4 or 1/3 of a beat, whichever fits better (triplets allowed)."""
    q4 = round(x * 4) / 4
    q3 = round(x * 3) / 3
    return q3 if abs(q3 - x) < abs(q4 - x) * 0.6 else q4


def recording_to_score(audio: np.ndarray, instrument: str, sr: int = dsp.SR, a4: float = 440.0,
                       title: str = "Transcription", bpm_hint: float | None = None,
                       beats_per_bar: int | None = None) -> Score:
    prof = get_profile(instrument)
    notes = [n for n in transcribe(audio, prof, sr, a4) if n.pitch is not None or prof.mode == "rhythm"]
    if not notes:
        raise ValueError("No notes found in the recording")
    onsets, odf = dsp.detect_onsets(audio, sr, dsp.HOP)
    hop_s = dsp.HOP / sr
    bpm = bpm_hint or estimate_tempo(odf, hop_s)
    beats = track_beats(odf, hop_s, bpm)
    if len(beats) >= 4:
        bpm = 60.0 / float(np.median(np.diff(beats)))
    pos = np.array([_beat_position(n.onset, beats) for n in notes])
    # the tracker may lock onto the off-beats: shift by the circular mean phase of the note onsets
    ang = 2 * np.pi * (pos % 1.0)
    w = np.array([max(n.energy, 1e-3) for n in notes])
    phase = math.atan2(float(np.sum(w * np.sin(ang))), float(np.sum(w * np.cos(ang)))) / (2 * np.pi)
    if abs(phase) > 0.12:
        pos = pos - phase
    shift = math.floor(pos[0] + 0.25)              # first note starts bar 1 (or is a pickup)
    raw = [(pos[k] - shift, _beat_position(n.offset, beats) - (phase if abs(phase) > 0.12 else 0) - shift, n)
           for k, n in enumerate(notes)]
    q = []
    for on, off, n in raw:
        qo = _quantise(on)
        qd = max(0.25, _quantise(off - on) if off - on > 0.2 else 0.25)
        q.append((qo, qd, n))
    # metre: compare accents on candidate bar lengths
    if beats_per_bar is None:
        strength = {}
        for bpb in (2, 3, 4):
            acc = np.zeros(bpb)
            for qo, _, n in q:
                if abs(qo - round(qo)) < 1e-6:
                    acc[int(round(qo)) % bpb] += (n.energy or 1.0) * (1 + (n.duration if n.duration else 0))
            strength[bpb] = acc[0] / (acc.mean() + 1e-12)
        beats_per_bar = 3 if strength[3] > 1.3 * max(strength[2], strength[4]) else 4
    tonic, mode, fifths = estimate_key([n.pitch for _, _, n in q if n.pitch is not None],
                                       [d for _, d, n in q if n.pitch is not None])
    # remove duplicates created by quantisation (same onset + pitch)
    seen, out_notes = set(), []
    for qo, qd, n in sorted(q, key=lambda x: (x[0], x[2].pitch or 0)):
        key = (round(qo, 3), n.pitch)
        if key in seen:
            continue
        seen.add(key)
        out_notes.append((qo, qd, n))
    end = max(qo + qd for qo, qd, _ in out_notes)
    n_bars = int(math.ceil(end / beats_per_bar))
    measures = [Measure(i, str(i + 1), i * beats_per_bar, beats_per_bar, (beats_per_bar, 4), fifths, mode, i)
                for i in range(n_bars)]
    snotes = []
    for i, (qo, qd, n) in enumerate(out_notes):
        m = min(n_bars - 1, max(0, int(qo // beats_per_bar)))
        snotes.append(Note(id=f"T-{i}", part="P1", measure=m, onset=float(qo), duration=float(qd),
                           pitch=n.pitch, written=None if n.pitch is None else n.pitch - prof.transpose,
                           src_index=i + 1))
    names = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
    return Score(title=title, parts=[Part("P1", prof.name, prof.key, prof.transpose)], notes=snotes,
                 measures=measures, tempos=[(0.0, round(bpm, 1))],
                 source={"format": "transcription", "bpm": round(bpm, 1),
                         "key": f"{names[tonic]} {mode}", "beats_per_bar": beats_per_bar,
                         "note": "Automatic transcription - check rhythms and key before practising."})
