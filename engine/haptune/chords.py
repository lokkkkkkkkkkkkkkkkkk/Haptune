"""Chord recognition for accompaniment parts (keyboard, guitar).

Beat-synchronous chroma from the log-frequency spectrogram, matched against chord templates and
smoothed with a Viterbi pass (chords tend to last). Good enough for a lead sheet: one symbol per
chord change, spelled for the key.
"""
from __future__ import annotations

import numpy as np

from . import dsp

QUALITIES = {
    "": (0, 4, 7),          # major
    "m": (0, 3, 7),
    "7": (0, 4, 7, 10),
    "maj7": (0, 4, 7, 11),
    "m7": (0, 3, 7, 10),
    "sus4": (0, 5, 7),
    "dim": (0, 3, 6),
}
SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def chroma(y: np.ndarray, sr: int = dsp.SR, lo_midi: int = 36, hi_midi: int = 96) -> tuple[np.ndarray, np.ndarray]:
    """(frames x 12) chroma and frame times. Log-compressed, per-frame normalised."""
    V, centers = dsp.logfreq_spectrogram(y, sr)            # V: (frames x bands)
    C = np.zeros((V.shape[0], 12))
    for b, m in enumerate(centers):
        if lo_midi <= m <= hi_midi:
            C[:, int(round(m)) % 12] += V[:, b]
    C = np.log1p(10 * C / (C.max() + 1e-12))
    times = dsp.frame_times(V.shape[0], sr)
    return C, times


def beat_sync(C: np.ndarray, times: np.ndarray, beats: np.ndarray) -> np.ndarray:
    edges = np.concatenate([[0.0], (beats[:-1] + beats[1:]) / 2 if len(beats) > 1 else [], [times[-1] + 1]])
    out = np.zeros((len(beats), 12))
    for i in range(len(beats)):
        sel = (times >= edges[i]) & (times < edges[i + 1])
        if sel.any():
            out[i] = C[sel].mean(axis=0)
    return out


def _templates():
    labels, T = [], []
    for root in range(12):
        for q, ivs in QUALITIES.items():
            t = np.zeros(12)
            for k, iv in enumerate(ivs):
                t[(root + iv) % 12] = 1.0 if k < 3 else 0.7
            labels.append((root, q))
            T.append(t / np.linalg.norm(t))
    return labels, np.array(T)


def recognise(beat_chroma: np.ndarray, energy: np.ndarray | None = None, stay: float = 0.4,
              simple_bias: float = 0.04) -> list[tuple[int, str] | None]:
    """Most likely chord per beat (root pitch class, quality) or None (no chord / silence)."""
    labels, T = _templates()
    n = len(beat_chroma)
    if n == 0:
        return []
    X = beat_chroma / (np.linalg.norm(beat_chroma, axis=1, keepdims=True) + 1e-12)
    sim = X @ T.T                                               # cosine similarity
    # prefer plain triads unless the 7th is clearly there
    bias = np.array([simple_bias if q in ("", "m") else 0.0 for _, q in labels])
    emit = np.exp(15 * (sim + bias))
    emit /= emit.sum(axis=1, keepdims=True)
    k = len(labels)
    logA = np.full((k, k), np.log((1 - stay) / (k - 1)))
    np.fill_diagonal(logA, np.log(stay))
    logE = np.log(emit + 1e-12)
    D = np.zeros((n, k))
    B = np.zeros((n, k), dtype=int)
    D[0] = logE[0]
    for t in range(1, n):
        cand = D[t - 1][:, None] + logA
        B[t] = np.argmax(cand, axis=0)
        D[t] = cand[B[t], np.arange(k)] + logE[t]
    path = [int(np.argmax(D[-1]))]
    for t in range(n - 1, 0, -1):
        path.append(int(B[t, path[-1]]))
    path = path[::-1]
    out: list[tuple[int, str] | None] = []
    quiet = None
    if energy is not None and len(energy) == n:
        quiet = energy < (np.percentile(energy, 90) * 0.08 + 1e-12)
    for t, j in enumerate(path):
        out.append(None if (quiet is not None and quiet[t]) else labels[j])
    return out


def name(root: int, quality: str, key_fifths: int = 0) -> str:
    return (FLATS if key_fifths < 0 else SHARPS)[root % 12] + quality


def chord_spans(y: np.ndarray, beats: np.ndarray, sr: int = dsp.SR, key_fifths: int = 0,
                min_beats: int = 1) -> list[dict]:
    """[{beat (index of the beat), label, root, quality, pcs}] - one entry per chord change."""
    if len(beats) < 2:
        return []
    C, times = chroma(y, sr)
    bc = beat_sync(C, times, beats)
    rms = np.array([np.sqrt(np.mean(y[int(a * sr): max(int(a * sr) + 1, int(b * sr))] ** 2))
                    for a, b in zip(beats, np.append(beats[1:], beats[-1] + (beats[-1] - beats[-2])))])
    seq = recognise(bc, rms)
    spans: list[dict] = []
    for i, ch in enumerate(seq):
        lab = None if ch is None else name(ch[0], ch[1], key_fifths)
        if spans and spans[-1]["label"] == lab:
            continue
        spans.append({"beat": i, "label": lab, "root": None if ch is None else ch[0],
                      "quality": None if ch is None else ch[1],
                      "pcs": [] if ch is None else [(ch[0] + iv) % 12 for iv in QUALITIES[ch[1]]]})
    # drop one-beat blips between identical neighbours
    if min_beats > 1:
        cleaned = []
        for k, s in enumerate(spans):
            length = (spans[k + 1]["beat"] if k + 1 < len(spans) else len(seq)) - s["beat"]
            if length < min_beats and cleaned and k + 1 < len(spans) and spans[k + 1]["label"] == cleaned[-1]["label"]:
                continue
            if cleaned and cleaned[-1]["label"] == s["label"]:
                continue
            cleaned.append(s)
        spans = cleaned
    spans = [s for s in spans if s["label"] is not None]
    return [s for k, s in enumerate(spans) if k == 0 or s["label"] != spans[k - 1]["label"]]
