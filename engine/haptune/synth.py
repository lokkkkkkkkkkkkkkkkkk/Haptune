"""Test-performance synthesizer.

Renders a Score as a *human-like* performance on a chosen instrument, with
planted mistakes (wrong / missed / extra notes, rushing, dragging, sharp or
flat notes, rubato, noise). It returns the audio plus the ground truth, so
the analysis engine can be tested end to end without a microphone.

These timbres are approximations (additive / formant models), good enough to
exercise pitch tracking, onset detection, polyphonic detection and alignment.
Real recordings are harder; see README "Validation".
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

import numpy as np
from scipy.signal import lfilter

from .dsp import SR
from .score import Score


@dataclass
class Mistake:
    note_index: int            # index into score.playable_notes() order (sorted by onset, pitch)
    kind: str                  # wrong | miss | extra | sharp | flat | early | late
    amount: float = 0.0        # semitones for wrong/extra, cents for sharp/flat, ms for early/late


@dataclass
class PerformedNote:
    onset: float               # seconds
    offset: float
    midi: float                # fractional (includes cents deviation)
    score_index: int | None    # which score note it realises (None for extra notes)
    label: str                 # correct | wrong | extra | sharp | flat | early | late


@dataclass
class Performance:
    audio: np.ndarray
    sr: int
    notes: list
    truth: dict = field(default_factory=dict)   # score_index -> label for every score note


def _envelope(n: int, sr: int, attack: float, release: float, decay_t60: float | None) -> np.ndarray:
    t = np.arange(n) / sr
    env = np.ones(n)
    a = max(1, int(attack * sr))
    env[:a] = np.linspace(0, 1, a) ** 1.5
    if decay_t60:
        env *= np.exp(-6.91 * t / decay_t60)
    r = max(1, int(release * sr))
    if r < n:
        env[-r:] *= np.linspace(1, 0, r) ** 2
    return env


def _formant_gain(f: float, formants: list[tuple[float, float, float]]) -> float:
    g = 0.0
    for fc, bw, amp in formants:
        g += amp / (1.0 + ((f - fc) / (bw / 2)) ** 2)
    return 0.05 + g


VOWEL_A = [(800, 120, 1.0), (1150, 140, 0.6), (2900, 200, 0.25), (3300, 250, 0.15)]
VIOLIN_BODY = [(280, 150, 0.7), (450, 200, 0.5), (2600, 900, 0.9), (3400, 1200, 0.5)]


def render_tone(instrument: str, midi: float, dur: float, sr: int = SR, velocity: float = 0.8,
                rng: np.random.Generator | None = None, tail: float | None = None) -> np.ndarray:
    """One note. `tail` = extra seconds of ring after the note ends (piano/guitar)."""
    rng = rng or np.random.default_rng(0)
    fam = _family(instrument)
    f0 = 440.0 * 2 ** ((midi - 69) / 12)
    ring = tail if tail is not None else (0.35 if fam in ("piano", "plucked") else 0.06)
    n = int((dur + ring) * sr)
    t = np.arange(n) / sr
    out = np.zeros(n)
    nyq = sr / 2 - 200

    if fam == "piano":
        B = 3e-4 * 2 ** ((midi - 60) / 24)          # inharmonicity grows towards the top
        t60 = float(np.clip(9.0 * 2 ** (-(midi - 21) / 24), 0.6, 9.0))
        for h in range(1, 18):
            fh = h * f0 * math.sqrt(1 + B * h * h)
            if fh >= nyq:
                break
            amp = (1.0 / h ** 1.1) * (0.6 + 0.4 * velocity) ** (h / 3)
            dec = np.exp(-6.91 * t / (t60 / (1 + 0.35 * h)))
            out += amp * dec * np.sin(2 * np.pi * fh * t + rng.uniform(0, 2 * np.pi))
        out *= _envelope(n, sr, 0.004, 0.0, None)
        damp = np.ones(n)
        k = int(dur * sr)
        if k < n:
            damp[k:] = np.exp(-np.arange(n - k) / (0.05 * sr))
        out *= damp
        hn = min(n, int(0.012 * sr))
        out[:hn] += 0.15 * velocity * rng.standard_normal(hn) * np.linspace(1, 0, hn)
    elif fam == "plucked":
        p = 0.18
        t60 = float(np.clip(4.0 * 2 ** (-(midi - 40) / 24), 0.5, 4.0))
        for h in range(1, 22):
            fh = h * f0 * math.sqrt(1 + 2e-5 * h * h)
            if fh >= nyq:
                break
            amp = abs(math.sin(math.pi * h * p)) / h ** 1.3
            out += amp * np.exp(-6.91 * t / (t60 / (1 + 0.25 * h))) * np.sin(2 * np.pi * fh * t)
        out *= _envelope(n, sr, 0.002, 0.0, None)
        k = int(dur * sr)
        if k < n:
            out[k:] *= np.exp(-np.arange(n - k) / (0.08 * sr))
    elif fam == "percussion":
        k = min(n, int(0.15 * sr))
        noise = rng.standard_normal(k)
        noise = lfilter([1, -0.9], [1], noise)
        out[:k] = noise * np.exp(-np.arange(k) / (0.02 * sr))
    else:
        # sustained instruments: vibrato + timbre
        vib_rate, vib_depth, attack, noise_lvl = 5.5, 0.0, 0.035, 0.01
        if fam == "bowed":
            vib_depth, attack, noise_lvl = 18.0, 0.045, 0.015
        elif fam == "voice":
            vib_depth, attack, noise_lvl = 35.0, 0.06, 0.008
        elif fam == "flute":
            vib_depth, attack, noise_lvl = 10.0, 0.04, 0.04
        elif fam in ("reed", "brass"):
            vib_depth, attack = 4.0, 0.03
        vib_on = np.clip((t - 0.18) / 0.25, 0, 1)                  # vibrato starts after the attack
        cents = vib_depth * vib_on * np.sin(2 * np.pi * vib_rate * t + rng.uniform(0, 6.28))
        if fam == "voice":
            cents = cents - 25.0 * np.exp(-t / 0.05)                # singers scoop into the note
        inst_f = f0 * 2 ** (cents / 1200)
        phase = 2 * np.pi * np.cumsum(inst_f) / sr
        for h in range(1, 30):
            fh = h * f0
            if fh >= nyq:
                break
            if fam == "bowed":
                amp = (1.0 / h) * _formant_gain(fh, VIOLIN_BODY)
            elif fam == "voice":
                amp = (1.0 / h ** 1.2) * _formant_gain(fh, VOWEL_A)
            elif fam == "flute":
                amp = [1.0, 0.35, 0.12, 0.06, 0.03, 0.015][h - 1] if h <= 6 else 0.0
            elif fam == "reed":
                amp = (1.0 / h) if h % 2 == 1 else (0.08 / h)
            elif fam == "brass":
                amp = (1.0 / h ** 0.7) * (0.5 + 0.5 * velocity) ** (h / 2)
            else:
                amp = 1.0 / h
            if amp <= 0:
                continue
            out += amp * np.sin(h * phase + rng.uniform(0, 2 * np.pi))
        out *= _envelope(n, sr, attack, max(0.03, ring), None)
        if noise_lvl:
            nz = lfilter([1, -0.6], [1], rng.standard_normal(n))
            out += noise_lvl * np.std(out) * nz / (np.std(nz) + 1e-9) * _envelope(n, sr, 0.01, 0.03, None)
    peak = np.max(np.abs(out)) + 1e-9
    return out / peak * (0.25 + 0.75 * velocity)


def _family(instrument: str) -> str:
    i = instrument.lower()
    if i in ("piano", "keyboard"):
        return "piano"
    if i in ("guitar", "ukulele", "bass_guitar", "guzheng"):
        return "plucked"
    if i in ("violin", "viola", "cello", "double_bass", "erhu"):
        return "bowed"
    if i.startswith("voice"):
        return "voice"
    if i in ("flute", "recorder", "dizi"):
        return "flute"
    if i in ("clarinet", "alto_sax", "tenor_sax"):
        return "reed"
    if i in ("trumpet", "trombone", "french_horn"):
        return "brass"
    if i == "percussion":
        return "percussion"
    return "bowed"


def perform(score: Score, instrument: str, mistakes: list[Mistake] | None = None, qpm: float | None = None,
            rubato: float = 0.0, jitter_ms: float = 12.0, tuning_cents: float = 0.0, snr_db: float = 35.0,
            reverb: float = 0.15, seed: int = 1, sr: int = SR, lead_in: float = 0.5,
            tempo_curve=None) -> Performance:
    """Render `score` as played by a human, with planted `mistakes`.

    rubato     : depth of slow tempo wobble (0.08 = +/-8 %)
    tempo_curve: optional f(beat) -> tempo multiplier (overrides rubato), e.g. rushing in bar 5
    """
    rng = np.random.default_rng(seed)
    pyrng = random.Random(seed)
    notes = score.playable_notes()
    notes = sorted(notes, key=lambda n: (n.onset, n.pitch or 0))
    q = qpm or score.first_tempo
    by_index = {}
    for m in mistakes or []:
        by_index.setdefault(m.note_index, []).append(m)

    # beat -> seconds with a tempo multiplier curve (numerical integration)
    end_beat = score.length_beats + 2
    grid = np.linspace(0, end_beat, int(end_beat * 48) + 2)
    if tempo_curve is None:
        mult = 1.0 + rubato * np.sin(2 * np.pi * grid / 16.0 + pyrng.uniform(0, 6.28))
    else:
        mult = np.array([tempo_curve(b) for b in grid])
    sec_per_beat = 60.0 / (q * mult)
    sec_grid = np.concatenate([[0], np.cumsum(np.diff(grid) * sec_per_beat[:-1])])

    def b2s(b):
        return lead_in + float(np.interp(b, grid, sec_grid))

    performed: list[PerformedNote] = []
    truth: dict[int, str] = {}
    chord_jitter: dict[float, float] = {}
    for i, n in enumerate(notes):
        on = b2s(n.onset)
        off = b2s(n.onset + n.duration)
        # notes of one chord share most of their jitter (hands move together)
        cj = chord_jitter.setdefault(round(n.onset, 4), rng.normal(0, jitter_ms / 1000.0))
        on += cj + rng.normal(0, jitter_ms / 4000.0)
        pitch = float(n.pitch if n.pitch is not None else 60)
        label = "correct"
        cents = tuning_cents
        for m in by_index.get(i, []):
            if m.kind == "wrong":
                pitch += m.amount or 1
                label = "wrong"
            elif m.kind == "miss":
                label = "miss"
            elif m.kind in ("sharp", "flat"):
                cents += abs(m.amount) * (1 if m.kind == "sharp" else -1)
                label = m.kind
            elif m.kind in ("early", "late"):
                on += (-1 if m.kind == "early" else 1) * abs(m.amount) / 1000.0
                label = m.kind
        truth[i] = label
        if label == "miss":
            continue
        release = 0.02
        nxt = next((x for x in notes[i + 1:] if x.onset > n.onset + 1e-6), None)
        if nxt is not None and nxt.pitch == n.pitch and abs(nxt.onset - (n.onset + n.duration)) < 1e-6:
            release = 0.07          # repeated note: the player re-articulates (bow change / tongue / breath)
        performed.append(PerformedNote(on, max(off - release, on + 0.05), pitch + cents / 100.0, i, label))
        for m in by_index.get(i, []):
            if m.kind == "extra":
                gap = max(0.08, min(0.25, (off - on) * 0.5))
                performed.append(PerformedNote(on + gap, on + gap + 0.18, pitch + (m.amount or 2) + cents / 100.0,
                                               None, "extra"))

    if _family(instrument) not in ("piano", "plucked", "percussion"):
        # a monophonic instrument cannot sound two notes: an early / extra note cuts the previous one
        performed.sort(key=lambda p: p.onset)
        for a, b in zip(performed, performed[1:]):
            if a.offset > b.onset - 0.01:
                a.offset = max(a.onset + 0.03, b.onset - 0.01)
    total = max((p.offset for p in performed), default=1.0) + 1.5
    y = np.zeros(int(total * sr))
    fam = _family(instrument)
    legato = fam in ("bowed", "voice", "flute", "reed", "brass")
    for p in performed:
        dur = p.offset - p.onset
        if legato:
            dur = max(dur, 0.06)
        vel = float(np.clip(0.75 + rng.normal(0, 0.08), 0.4, 1.0))
        tone = render_tone(instrument, p.midi, dur, sr, vel, rng)
        s = int(p.onset * sr)
        e = min(len(y), s + len(tone))
        y[s:e] += tone[:e - s]
    if reverb > 0:
        from scipy.signal import fftconvolve
        ir_len = int(0.6 * sr)
        ir = rng.standard_normal(ir_len) * np.exp(-np.arange(ir_len) / (0.12 * sr))
        ir[: int(0.01 * sr)] = 0.0                      # pre-delay
        wet = fftconvolve(y, ir)[:len(y)]
        y = y + reverb * wet * (np.std(y) / (np.std(wet) + 1e-12))
    sig_pow = np.mean(y ** 2) + 1e-12
    y = y + rng.standard_normal(len(y)) * math.sqrt(sig_pow / (10 ** (snr_db / 10)))
    y = y / (np.max(np.abs(y)) + 1e-9) * 0.8
    return Performance(y.astype(np.float32), sr, performed, truth)
