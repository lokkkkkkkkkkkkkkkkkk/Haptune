"""Tuner: nearest note / nearest open string with cents deviation."""
from __future__ import annotations

import math

import numpy as np

from . import dsp
from .instruments import get_profile
from .score import midi_name


def tune(buffer: np.ndarray, instrument: str = "violin", a4: float = 440.0, sr: int = dsp.SR) -> dict:
    prof = get_profile(instrument)
    f, conf = dsp.pitch_at(buffer, sr=sr, fmin=prof.fmin, fmax=prof.fmax, a4=a4)
    if f <= 0:
        return {"hz": 0.0, "note": None, "cents": None, "confidence": 0.0}
    m = 69 + 12 * math.log2(f / a4)
    near = int(round(m))
    out = {"hz": round(f, 2), "note": midi_name(near), "midi": near, "cents": round((m - near) * 100, 1),
           "confidence": round(conf, 2)}
    if prof.open_strings:
        s = min(prof.open_strings, key=lambda o: abs(o - m))
        out["string"] = midi_name(s)
        out["string_cents"] = round((m - s) * 100, 1)
    return out
