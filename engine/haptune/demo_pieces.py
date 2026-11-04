"""Public-domain demo pieces used by the demo command and the tests."""
from __future__ import annotations

from .score import Score, score_from_notes

# Minuet in G major, BWV Anh. 114 (Christian Petzold) - melody, bars 1-16. A beginner staple
# for piano and violin (Suzuki Book 1, many graded-exam lists).
_MINUET = [
    [(74, 1), (67, .5), (69, .5), (71, .5), (72, .5)],
    [(74, 1), (67, 1), (67, 1)],
    [(76, 1), (72, .5), (74, .5), (76, .5), (78, .5)],
    [(79, 1), (67, 1), (67, 1)],
    [(72, 1), (74, .5), (72, .5), (71, .5), (69, .5)],
    [(71, 1), (72, .5), (71, .5), (69, .5), (67, .5)],
    [(66, 1), (67, .5), (69, .5), (71, .5), (67, .5)],
    [(69, 3)],
    [(74, 1), (67, .5), (69, .5), (71, .5), (72, .5)],
    [(74, 1), (67, 1), (67, 1)],
    [(76, 1), (72, .5), (74, .5), (76, .5), (78, .5)],
    [(79, 1), (67, 1), (67, 1)],
    [(72, 1), (74, .5), (72, .5), (71, .5), (69, .5)],
    [(71, 1), (72, .5), (71, .5), (69, .5), (67, .5)],
    [(69, 1), (71, .5), (69, .5), (67, .5), (66, .5)],
    [(67, 3)],
]
# simplified left-hand accompaniment (root / fifth per bar) for the piano demo
_MINUET_BASS = [55, 59, 60, 59, 57, 55, 62, 50, 55, 59, 60, 59, 57, 55, 50, 43]


def minuet_in_g(with_bass: bool = False, qpm: float = 96, transpose: int = 0) -> Score:
    notes = []
    on = 0.0
    for b, bar in enumerate(_MINUET):
        start = on
        for p, d in bar:
            notes.append((on, d, p + transpose))
            on += d
        if with_bass:
            notes.append((start, 2.0 if b not in (7, 15) else 3.0, _MINUET_BASS[b] - 12 + transpose))
            if b not in (7, 15):
                notes.append((start + 2.0, 1.0, _MINUET_BASS[b] - 12 + 7 + transpose))
    sc = score_from_notes(notes, qpm=qpm, time_sig=(3, 4), key_fifths=1, title="Minuet in G (BWV Anh. 114)",
                          instrument="piano" if with_bass else "violin")
    sc.composer = "Christian Petzold"
    sc.parts[0].name = "Piano" if with_bass else "Violin"
    return sc


ODE_TO_JOY_JIANPU = """title: 欢乐颂 Ode to Joy
key: 1=D
time: 4/4
tempo: 100
instrument: erhu
---
3 3 4 5 | 5 4 3 2 | 1 1 2 3 | 3. 2_ 2 - |
3 3 4 5 | 5 4 3 2 | 1 1 2 3 | 2. 1_ 1 - ||
"""
