"""Audio -> performed notes (no score needed).

* mono  : YIN pitch track + onset/energy cues  (violin, voice, flute, sax, erhu ...)
* poly  : harmonic-template NMF on a log-frequency spectrogram + onsets (piano, guitar ...)
* rhythm: onsets only (percussion, clapping)

The evaluator aligns these notes to the score; `master_score.py` quantises
them into a new score ("extract the sheet music from a recording").
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import dsp
from .instruments import InstrumentProfile

POLY_TEMPLATE_SLOPE = 1.1   # partial amplitudes ~ 1/h^1.1 (piano, guitar)


@dataclass
class DetectedNote:
    onset: float                # seconds
    offset: float               # seconds
    midi: float | None          # fractional MIDI (None for rhythm-only)
    confidence: float = 1.0
    energy: float = 0.0
    pitch_curve: list = field(default_factory=list, repr=False)  # (t, midi) samples for reports

    @property
    def pitch(self) -> int | None:
        return None if self.midi is None else int(round(self.midi))

    @property
    def cents(self) -> float:
        return 0.0 if self.midi is None else (self.midi - round(self.midi)) * 100.0

    @property
    def duration(self) -> float:
        return self.offset - self.onset


# ---------------------------------------------------------------------------
# Monophonic
# ---------------------------------------------------------------------------
def transcribe_mono(y: np.ndarray, profile: InstrumentProfile, sr: int = dsp.SR, a4: float = 440.0,
                    track: dsp.PitchTrack | None = None) -> list[DetectedNote]:
    hop = dsp.HOP
    hop_s = hop / sr
    tr = track or dsp.yin(y, sr=sr, hop=hop, fmin=profile.fmin, fmax=profile.fmax, a4=a4)
    if tr.times.size == 0:
        return []
    midi = dsp.smooth_midi(tr.midi, 5)
    onset_times, odf = dsp.detect_onsets(y, sr, hop, min_gap_sec=max(0.04, profile.min_note_ms / 2000))
    t0 = float(tr.times[0])
    onset_frames = set(int(round((t - t0) / hop_s)) for t in onset_times)
    rms = tr.rms
    rms_s = np.convolve(rms, np.ones(3) / 3, mode="same")
    split_frames = _articulation_splits(rms_s, onset_frames, hop_s, profile.onset_style == "percussive")

    min_frames = max(2, int(profile.min_note_ms / 1000 / hop_s))
    switch_frames = 3            # a new pitch must persist ~35 ms before we believe it
    notes: list[tuple[int, int, int]] = []   # (start, end, nominal semitone)
    cur_start, cur_pitch, pending, pending_count = None, None, None, 0
    n = midi.size

    def close(end_frame):
        nonlocal cur_start, cur_pitch
        if cur_start is not None and end_frame - cur_start >= min_frames:
            notes.append((cur_start, end_frame, cur_pitch))
        cur_start, cur_pitch = None, None

    for i in range(n):
        m = midi[i]
        if np.isnan(m):
            if cur_start is not None:
                look = midi[i:i + 3]                 # tolerate 2-frame dropouts inside a note
                if np.all(np.isnan(look)):
                    close(i)
            pending, pending_count = None, 0
            continue
        semi = int(round(m))
        if cur_start is None:
            cur_start, cur_pitch = i, semi
            continue
        if abs(m - cur_pitch) > 0.62:
            if pending == semi:
                pending_count += 1
            else:
                pending, pending_count = semi, 1
            if pending_count >= switch_frames:
                close(i - switch_frames + 1)
                cur_start, cur_pitch = i - switch_frames + 1, semi
                pending, pending_count = None, 0
            continue
        pending, pending_count = None, 0
        # re-articulation of the same pitch (bow change, tongued / sung repeated note)
        if i in split_frames and i - cur_start >= min_frames:
            close(i)
            cur_start, cur_pitch = i, semi
    close(n)

    out: list[DetectedNote] = []
    for (s, e, p) in notes:
        seg = midi[s:e]
        seg_t = tr.times[s:e]
        valid = ~np.isnan(seg)
        if valid.sum() == 0:
            continue
        # judge pitch on the settled part (skip the scoop / bow attack)
        skip = min(int(0.06 / hop_s), max(0, valid.sum() // 4))
        core = seg[valid][skip:] if valid.sum() - skip >= 2 else seg[valid]
        pm = float(np.median(core))
        onset = float(tr.times[s])
        # pitch detection lags the attack a little: snap to a nearby spectral onset
        near = [t for t in onset_times if -0.06 <= t - onset <= 0.03]
        if near:
            onset = float(min(near, key=lambda t: abs(t - onset)))
        conf = float(np.mean(tr.confidence[s:e]))
        energy = float(np.mean(rms[s:e]))
        step = max(1, len(seg) // 24)
        curve = [(round(float(seg_t[k]), 3), round(float(seg[k]), 3)) for k in range(0, len(seg), step)
                 if not np.isnan(seg[k])]
        out.append(DetectedNote(onset, float(tr.times[min(e, n - 1)]) + hop_s, pm, conf, energy, curve))
    # merge accidental splits: same pitch, tiny gap, no onset between
    merged: list[DetectedNote] = []
    for nt in out:
        if merged and nt.pitch == merged[-1].pitch and nt.onset - merged[-1].offset < 0.03:
            has_onset = any(merged[-1].offset - 0.02 <= t <= nt.onset + 0.02 for t in onset_times)
            if not has_onset:
                merged[-1].offset = nt.offset
                merged[-1].pitch_curve += nt.pitch_curve
                continue
        merged.append(nt)
    return merged


def _articulation_splits(rms_s: np.ndarray, onset_frames: set, hop_s: float, percussive: bool) -> set:
    """Frames where a new note starts on the same pitch: an energy dip followed by a rise,
    or (percussive instruments) any clear spectral onset."""
    splits: set[int] = set()
    w = max(2, int(0.15 / hop_s))
    n = rms_s.size
    for i in range(1, n - 1):
        if not (rms_s[i] <= rms_s[i - 1] and rms_s[i] < rms_s[i + 1]):
            continue
        before = rms_s[max(0, i - w):i].max(initial=0)
        after_seg = rms_s[i + 1:min(n, i + w)]
        after = after_seg.max(initial=0)
        if before <= 0 or after <= 0:
            continue
        if rms_s[i] < 0.55 * min(before, after) and after > 0.08 * rms_s.max():
            k = i + 1                                    # rise point = new note start
            while k < n - 1 and rms_s[k] < 0.5 * after:
                k += 1
            near = [f for f in onset_frames if abs(f - k) <= 3]
            splits.add(min(near, key=lambda f: abs(f - k)) if near else k)
    if percussive:
        splits |= set(onset_frames)
    return splits


# ---------------------------------------------------------------------------
# Polyphonic
# ---------------------------------------------------------------------------
@dataclass
class PolyAnalysis:
    times: np.ndarray
    pitches: np.ndarray          # MIDI numbers of the activation columns
    activations: np.ndarray      # (frames, pitches)
    onset_times: np.ndarray
    odf: np.ndarray
    spec: np.ndarray | None = None       # log-frequency magnitude spectrogram (frames, bins)
    centers: np.ndarray | None = None    # MIDI value of each spectrogram bin


def analyse_poly(y: np.ndarray, profile: InstrumentProfile, sr: int = dsp.SR) -> PolyAnalysis:
    V, centers = dsp.logfreq_spectrogram(y, sr, dsp.HOP, 4096)
    lo, hi = max(profile.low, 21), min(profile.high, 108)
    # a few "garbage" templates below the range plus broadband noise templates soak up
    # attack noise and reverb so they do not show up as phantom low notes
    pitches_all = np.arange(lo - 6, hi + 4)
    B = 2.5e-4 if profile.family == "keyboard" else 2e-5
    W = dsp.harmonic_templates(pitches_all, centers, n_harm=12, inharmonicity=B, slope=POLY_TEMPLATE_SLOPE)
    noise = np.stack([np.exp(-0.5 * ((centers - c) / 18.0) ** 2) for c in (40.0, 70.0, 100.0)])
    noise /= np.linalg.norm(noise, axis=1, keepdims=True)
    Wfull = np.vstack([W, noise])
    Vc = V ** 0.8
    fm = dsp.fundamental_mask(V, centers, pitches_all, ratio=0.06)
    mask = np.hstack([fm, np.ones((V.shape[0], noise.shape[0]), dtype=bool)])
    H = dsp.nmf_activations(Vc, Wfull, n_iter=60, sparsity=0.02 * float(np.mean(Vc)), mask=mask)
    keep = (pitches_all >= lo) & (pitches_all <= hi)
    H = H[:, :len(pitches_all)][:, keep]
    onset_times, odf = dsp.detect_onsets(y, sr, dsp.HOP, min_gap_sec=0.045, delta=0.05)
    return PolyAnalysis(dsp.frame_times(H.shape[0], sr), pitches_all[keep], H, onset_times, odf, V, centers)


def transcribe_poly(y: np.ndarray, profile: InstrumentProfile, sr: int = dsp.SR,
                    analysis: PolyAnalysis | None = None, rel_threshold: float = 0.25) -> list[DetectedNote]:
    pa = analysis or analyse_poly(y, profile, sr)
    H, pitches = pa.activations, pa.pitches
    hop_s = dsp.HOP / sr
    nF = H.shape[0]
    global_ref = np.percentile(H.max(axis=1), 95) + 1e-12
    notes: list[DetectedNote] = []
    active_until: dict[int, int] = {}
    onset_frames = [int(round(t / hop_s)) for t in pa.onset_times]
    for k, f in enumerate(onset_frames):
        nxt = onset_frames[k + 1] if k + 1 < len(onset_frames) else nF
        # frames are centred and 186 ms long: look ~110 ms before and up to ~110 ms after
        pre = H[max(0, f - 11):max(1, f - 7)].mean(axis=0) if f > 7 else np.zeros(H.shape[1])
        win_end = min(nF, f + 10, max(f + 4, nxt + 2))
        post = H[f:win_end].max(axis=0)
        jump = post - pre
        onset_ref = max(post.max(), 1e-12)
        sounding = np.array([active_until.get(int(p), -1) > f for p in pitches])
        need_jump = np.where(sounding, 0.4, 0.22)      # re-strike of a ringing note must be clear
        cand = np.flatnonzero((post > rel_threshold * onset_ref) & (jump > need_jump * post) &
                              (post > 0.04 * global_ref))
        # harmonics of strong lower notes are explained by their template; drop leftovers that
        # are much weaker than a note an octave / twelfth below
        keep = []
        cand_set = set(int(c) for c in cand)
        for c in cand:
            p = pitches[c]
            suppressed = False
            # weak leftovers of a strong lower note's harmonics
            for iv in (12, 19, 24, 28):
                below = np.flatnonzero(pitches == p - iv)
                if below.size and int(below[0]) in cand_set and post[c] < 0.45 * post[below[0]]:
                    suppressed = True
            # smeared energy next to a strong note (template width, attack noise), including a
            # neighbour that is still ringing from an earlier onset
            for iv in (-2, -1, 1, 2):
                nb = np.flatnonzero(pitches == p + iv)
                if not nb.size:
                    continue
                k = nb[0]
                ringing = active_until.get(int(pitches[k]), -1) > f
                if post[c] < 0.5 * post[k] and (jump[k] > 0 or ringing):
                    suppressed = True
            # the new note must carry a real share of what changed at this onset
            if jump[c] < 0.2 * jump.max():
                suppressed = True
            if not suppressed:
                keep.append(c)
        if len(keep) > profile.max_polyphony:
            keep = sorted(keep, key=lambda c: -post[c])[:profile.max_polyphony]
        for c in keep:
            peak = post[c]
            end = f + 1
            while end < nF and H[end, c] > 0.25 * peak and (end < nxt or H[end, c] > 0.5 * peak):
                end += 1
            notes.append(DetectedNote(onset=float(pa.times[f]), offset=float(pa.times[min(end, nF - 1)]),
                                      midi=float(pitches[c]), confidence=float(min(1.0, peak / onset_ref)),
                                      energy=float(peak)))
            active_until[int(pitches[c])] = end
    notes.sort(key=lambda n: (n.onset, n.midi))
    return notes


# ---------------------------------------------------------------------------
# Rhythm only
# ---------------------------------------------------------------------------
def transcribe_rhythm(y: np.ndarray, sr: int = dsp.SR) -> list[DetectedNote]:
    onsets, odf = dsp.detect_onsets(y, sr, dsp.HOP, min_gap_sec=0.06, delta=0.08)
    return [DetectedNote(float(t), float(t) + 0.1, None) for t in onsets]


def transcribe(y: np.ndarray, profile: InstrumentProfile, sr: int = dsp.SR, a4: float = 440.0) -> list[DetectedNote]:
    if profile.mode == "poly":
        return transcribe_poly(y, profile, sr)
    if profile.mode == "rhythm":
        return transcribe_rhythm(y, sr)
    return transcribe_mono(y, profile, sr, a4)
