"""Scales, arpeggios and other technical exercises generated as scores.

Graded-exam syllabuses (ABRSM, Trinity, and others) ask for scales and arpeggios
in given keys, ranges and speeds; the app turns any of them into a practice
score that the follower checks note by note.
"""
from __future__ import annotations

from .instruments import get_profile
from .score import Score, score_from_notes

PATTERNS = {
    "major": [0, 2, 4, 5, 7, 9, 11],
    "natural_minor": [0, 2, 3, 5, 7, 8, 10],
    "harmonic_minor": [0, 2, 3, 5, 7, 8, 11],
    "melodic_minor": [0, 2, 3, 5, 7, 9, 11],        # ascending form; descends as natural minor
    "major_pentatonic": [0, 2, 4, 7, 9],
    "minor_pentatonic": [0, 3, 5, 7, 10],
    "blues": [0, 3, 5, 6, 7, 10],
    "chromatic": list(range(12)),
    "major_arpeggio": [0, 4, 7],
    "minor_arpeggio": [0, 3, 7],
    "dominant7_arpeggio": [0, 4, 7, 10],
    "diminished7_arpeggio": [0, 3, 6, 9],
}
TONICS = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7,
          "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}
KEY_FIFTHS = {0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5}


def scale(tonic: str = "C", kind: str = "major", octaves: int = 1, instrument: str = "piano",
          start_octave: int | None = None, qpm: float = 80, notes_per_beat: int = 2,
          descend: bool = True) -> Score:
    """Up (and back down) through `octaves` octaves, starting from the lowest playable tonic."""
    if kind not in PATTERNS:
        raise KeyError(f"unknown exercise '{kind}'. Known: {', '.join(PATTERNS)}")
    prof = get_profile(instrument)
    pc = TONICS[tonic]
    if start_octave is None:
        base = next(m for m in range(prof.low, prof.high + 1) if m % 12 == pc)
        while base + 12 * octaves > prof.high and base - 12 >= prof.low:
            base -= 12
        if prof.key.startswith(("violin", "viola", "cello")) and base < prof.low:
            base += 12
    else:
        base = 12 * (start_octave + 1) + pc
    pat = PATTERNS[kind]
    up = [base + 12 * o + iv for o in range(octaves) for iv in pat] + [base + 12 * octaves]
    if descend:
        if kind == "melodic_minor":
            nat = PATTERNS["natural_minor"]
            down = [base + 12 * o + iv for o in range(octaves) for iv in nat][::-1]
        else:
            down = up[:-1][::-1]
        seq = up + down
    else:
        seq = up
    d = 1.0 / notes_per_beat
    notes = [(i * d, d, p) for i, p in enumerate(seq)]
    notes[-1] = (notes[-1][0], max(1.0, d), notes[-1][2])
    out_of_range = [p for p in seq if not (prof.low <= p <= prof.high)]
    sc = score_from_notes(notes, qpm=qpm, key_fifths=KEY_FIFTHS.get(pc, 0) if "major" in kind or "arpeggio" in kind
                          else KEY_FIFTHS.get((pc + 3) % 12, 0),
                          title=f"{tonic} {kind.replace('_', ' ')} ({octaves} octave{'s' if octaves > 1 else ''})",
                          instrument=prof.key)
    sc.source = {"format": "exercise", "kind": kind, "tonic": tonic, "octaves": octaves,
                 "out_of_range": out_of_range}
    return sc
