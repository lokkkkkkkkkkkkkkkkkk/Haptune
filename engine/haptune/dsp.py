"""Signal processing: audio loading, YIN pitch tracking, onset detection, spectra.

Everything is plain numpy/scipy so each function maps one-to-one onto the
Swift/Accelerate port in the app (PracticeCore/DSP). Shared constants:
sample rate 22050 Hz, hop 256 samples (11.6 ms).
"""
from __future__ import annotations

import math
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass

import numpy as np
from scipy.signal import resample_poly
from scipy.ndimage import maximum_filter1d, median_filter, uniform_filter1d

SR = 22050
HOP = 256


# ---------------------------------------------------------------------------
# Audio I/O
# ---------------------------------------------------------------------------
def load_audio(path: str, sr: int = SR) -> np.ndarray:
    """Mono float32 audio at `sr`. WAV/FLAC/OGG via soundfile, anything else via ffmpeg."""
    import soundfile as sf
    try:
        data, file_sr = sf.read(path, dtype="float32", always_2d=True)
    except Exception:
        if not shutil.which("ffmpeg"):
            raise
        with tempfile.TemporaryDirectory() as td:
            wav = os.path.join(td, "decoded.wav")
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", path, "-ac", "1", "-ar", str(sr), wav],
                           check=True)
            data, file_sr = sf.read(wav, dtype="float32", always_2d=True)
    y = data.mean(axis=1)
    if file_sr != sr:
        g = math.gcd(int(file_sr), int(sr))
        y = resample_poly(y, sr // g, int(file_sr) // g).astype(np.float32)
    return y.astype(np.float32)


def save_audio(path: str, y: np.ndarray, sr: int = SR) -> None:
    import soundfile as sf
    peak = float(np.max(np.abs(y))) if len(y) else 1.0
    sf.write(path, (y / max(peak, 1e-9) * 0.9).astype(np.float32), sr)


def frame_times(n_frames: int, sr: int = SR, hop: int = HOP) -> np.ndarray:
    return np.arange(n_frames) * hop / sr


# ---------------------------------------------------------------------------
# YIN pitch tracking
# ---------------------------------------------------------------------------
@dataclass
class PitchTrack:
    times: np.ndarray       # seconds (frame start)
    f0: np.ndarray          # Hz, 0 where unvoiced
    confidence: np.ndarray  # 1 - CMND at the chosen lag (0..1)
    rms: np.ndarray         # frame RMS
    midi: np.ndarray        # fractional MIDI, nan where unvoiced
    alt_lower: np.ndarray   # CMND one octave below the pick (low value => maybe octave too high)
    voiced: np.ndarray      # bool


def yin(y: np.ndarray, sr: int = SR, hop: int = HOP, fmin: float = 60.0, fmax: float = 1500.0,
        threshold: float = 0.15, a4: float = 440.0) -> PitchTrack:
    """Frame-wise YIN (de Cheveigné & Kawahara 2002), vectorised with FFTs."""
    y = np.asarray(y, dtype=np.float64)
    tau_min = max(2, int(sr / fmax))
    tau_max = int(math.ceil(sr / fmin))
    W = int(2 ** math.ceil(math.log2(max(512, 1.25 * tau_max))))
    n_frames = max(0, 1 + (len(y) - W - tau_max) // hop) if len(y) > W + tau_max else 0
    if n_frames == 0:
        z = np.zeros(0)
        return PitchTrack(z, z, z, z, z, z, z.astype(bool))
    pad = np.concatenate([y, np.zeros(W + tau_max)])
    idx = np.arange(n_frames)[:, None] * hop
    seg = pad[idx + np.arange(W + tau_max)[None, :]]                  # (F, W+tau_max)
    frame = seg[:, :W]
    nfft = int(2 ** math.ceil(math.log2(W + tau_max + W)))
    # r_t(tau) = sum_j frame[j] * seg[j + tau]   (cross-correlation)
    A = np.fft.rfft(frame, nfft)
    B = np.fft.rfft(seg, nfft)
    corr = np.fft.irfft(np.conj(A) * B, nfft)[:, :tau_max + 1]
    sq = seg ** 2
    csum = np.concatenate([np.zeros((n_frames, 1)), np.cumsum(sq, axis=1)], axis=1)
    e0 = csum[:, W][:, None]                                           # energy of frame
    taus = np.arange(tau_max + 1)
    e_tau = csum[:, taus + W] - csum[:, taus]                          # energy of shifted window
    d = np.maximum(e0 + e_tau - 2.0 * corr, 0.0)
    d[:, 0] = 0.0
    cum = np.cumsum(d[:, 1:], axis=1)
    cmnd = np.ones_like(d)
    cmnd[:, 1:] = d[:, 1:] * taus[1:] / np.maximum(cum, 1e-12)

    rms = np.sqrt(e0[:, 0] / W)
    f0 = np.zeros(n_frames)
    conf = np.zeros(n_frames)
    alt_lower = np.ones(n_frames)
    search = cmnd[:, tau_min:tau_max]
    below = search < threshold
    for i in range(n_frames):
        row = search[i]
        cand = np.flatnonzero(below[i])
        if cand.size:
            t = cand[0]
            while t + 1 < row.size and row[t + 1] < row[t]:   # walk to the bottom of the dip
                t += 1
        else:
            t = int(np.argmin(row))
        tau = t + tau_min
        # parabolic interpolation
        if 1 <= tau < tau_max:
            a, b, c = cmnd[i, tau - 1], cmnd[i, tau], cmnd[i, tau + 1]
            den = a - 2 * b + c
            shift = 0.5 * (a - c) / den if abs(den) > 1e-12 else 0.0
            shift = float(np.clip(shift, -1, 1))
        else:
            shift = 0.0
        tau_f = tau + shift
        f0[i] = sr / tau_f
        conf[i] = 1.0 - float(cmnd[i, tau])
        t2 = int(round(2 * tau_f))
        if t2 <= tau_max:
            alt_lower[i] = float(np.min(cmnd[i, max(t2 - 1, 1):min(t2 + 2, tau_max + 1)]))
    silence = rms < max(1e-4, 0.02 * np.percentile(rms, 95) if rms.size else 0)
    voiced = (conf > 1.0 - 0.35) & ~silence & (f0 >= fmin * 0.95) & (f0 <= fmax * 1.05)
    midi = np.full(n_frames, np.nan)
    midi[voiced] = 69.0 + 12.0 * np.log2(f0[voiced] / a4)
    times = frame_times(n_frames, sr, hop) + (W / 2) / sr     # centre of the analysis window
    return PitchTrack(times, np.where(voiced, f0, 0.0), conf, rms, midi, alt_lower, voiced)


def pitch_at(y: np.ndarray, sr: int = SR, fmin: float = 40.0, fmax: float = 2000.0,
             a4: float = 440.0) -> tuple[float, float]:
    """Single-shot pitch of a short buffer (tuner). Returns (Hz, confidence)."""
    tr = yin(y, sr=sr, hop=max(64, len(y) // 8), fmin=fmin, fmax=fmax, a4=a4)
    if not tr.voiced.any():
        return 0.0, 0.0
    f = np.median(tr.f0[tr.voiced])
    return float(f), float(np.median(tr.confidence[tr.voiced]))


# ---------------------------------------------------------------------------
# Spectra and onsets
# ---------------------------------------------------------------------------
def stft_mag(y: np.ndarray, n_fft: int = 2048, hop: int = HOP) -> np.ndarray:
    """Magnitude STFT. Frame i is CENTRED at sample i*hop (time i*hop/sr). Shape (F, bins)."""
    y = np.asarray(y, dtype=np.float64)
    n_frames = max(1, 1 + (len(y) - 1) // hop)
    pad = np.concatenate([np.zeros(n_fft // 2), y, np.zeros(n_fft)])
    idx = np.arange(n_frames)[:, None] * hop + np.arange(n_fft)[None, :]
    win = np.hanning(n_fft)
    frames = pad[idx] * win
    return np.abs(np.fft.rfft(frames, axis=1))


_FB_CACHE: dict = {}


def onset_strength(mag: np.ndarray, sr: int = SR, n_fft: int = 2048, lag: int = 2,
                   max_size: int = 3) -> np.ndarray:
    """SuperFlux onset strength (Böck & Widmer 2013): log magnitude on a 1/3-semitone
    filterbank, the reference frame max-filtered across frequency so vibrato and
    slides do not look like new notes."""
    key = (sr, n_fft)
    if key not in _FB_CACHE:
        fb, _ = logfreq_filterbank(sr, n_fft, 3, 28.0, 116.0)
        _FB_CACHE[key] = fb
    fb = _FB_CACHE[key]
    S = np.log1p(100.0 * (mag @ fb.T) / (np.max(mag) + 1e-12))
    ref = maximum_filter1d(S, size=max_size, axis=1)
    flux = np.zeros(S.shape[0])
    flux[lag:] = np.sum(np.maximum(S[lag:] - ref[:-lag], 0.0), axis=1)
    return flux


def pick_peaks(odf: np.ndarray, hop_sec: float, min_gap_sec: float = 0.05, delta: float = 0.07,
               window_sec: float = 0.1, abs_floor: float = 0.0) -> np.ndarray:
    """Adaptive-threshold peak picking. Returns frame indices."""
    if odf.size == 0:
        return np.zeros(0, dtype=int)
    o = odf / (np.max(odf) + 1e-12)
    w = max(1, int(round(window_sec / hop_sec)))
    local_max = maximum_filter1d(o, size=2 * w + 1)
    local_mean = uniform_filter1d(o, size=4 * w + 1)
    cand = np.flatnonzero((o == local_max) & (o >= local_mean + delta) & (o > abs_floor))
    gap = max(1, int(round(min_gap_sec / hop_sec)))
    peaks: list[int] = []
    for c in cand:
        if peaks and c - peaks[-1] < gap:
            if o[c] > o[peaks[-1]]:
                peaks[-1] = int(c)
            continue
        peaks.append(int(c))
    return np.asarray(peaks, dtype=int)


def detect_onsets(y: np.ndarray, sr: int = SR, hop: int = HOP, min_gap_sec: float = 0.05,
                  delta: float = 0.07) -> tuple[np.ndarray, np.ndarray]:
    """Onset times (s) and the onset strength curve."""
    mag = stft_mag(y, 2048, hop)
    odf = onset_strength(mag, sr, 2048)
    pk = pick_peaks(odf, hop / sr, min_gap_sec=min_gap_sec, delta=delta)
    return pk * hop / sr + ONSET_BIAS_S, odf


ONSET_BIAS_S = 0.014   # measured: flux peaks ~14 ms before the true attack (centred 2048 frames)


# ---------------------------------------------------------------------------
# Log-frequency spectrogram and harmonic pitch templates (polyphonic analysis)
# ---------------------------------------------------------------------------
BINS_PER_SEMITONE = 3
LOGF_MIN_MIDI = 21 - 12   # one octave below A0 so A0's harmonics fit
LOGF_MAX_MIDI = 120


def logfreq_filterbank(sr: int = SR, n_fft: int = 4096, bins_per_semitone: int = BINS_PER_SEMITONE,
                       midi_lo: float = LOGF_MIN_MIDI, midi_hi: float = LOGF_MAX_MIDI) -> tuple[np.ndarray, np.ndarray]:
    """Triangular filters mapping linear STFT bins onto a log-frequency (MIDI) axis."""
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    centers = np.arange(midi_lo, midi_hi, 1.0 / bins_per_semitone)
    fb = np.zeros((centers.size, freqs.size))
    df = sr / n_fft
    with np.errstate(divide="ignore"):
        fmidi = 69 + 12 * np.log2(np.maximum(freqs, 1e-6) / 440.0)
    for i, c in enumerate(centers):
        width = 1.0 / bins_per_semitone
        w = np.maximum(0.0, 1.0 - np.abs(fmidi - c) / width)
        fc = 440.0 * 2 ** ((c - 69) / 12)
        if w.sum() < 1e-9:                       # low notes narrower than one FFT bin
            k = int(round(fc / df))
            if 0 <= k < freqs.size:
                w[k] = 1.0
        fb[i] = w / max(w.sum(), 1e-9)
    return fb, centers


def logfreq_spectrogram(y: np.ndarray, sr: int = SR, hop: int = HOP, n_fft: int = 4096) -> tuple[np.ndarray, np.ndarray]:
    mag = stft_mag(y, n_fft, hop)
    fb, centers = logfreq_filterbank(sr, n_fft)
    return mag @ fb.T, centers


def harmonic_templates(pitches: np.ndarray, centers: np.ndarray, n_harm: int = 10,
                       inharmonicity: float = 0.0, decay: float = 0.85, slope: float | None = None) -> np.ndarray:
    """Spectral template per MIDI pitch on the log-frequency axis. Shape (len(pitches), len(centers))."""
    T = np.zeros((len(pitches), centers.size))
    for i, p in enumerate(pitches):
        f0 = 440.0 * 2 ** ((p - 69) / 12)
        for h in range(1, n_harm + 1):
            fh = h * f0 * math.sqrt(1 + inharmonicity * h * h)
            mh = 69 + 12 * math.log2(fh / 440.0)
            if mh >= centers[-1]:
                break
            amp = h ** (-slope) if slope is not None else decay ** (h - 1)
            T[i] += amp * np.exp(-0.5 * ((centers - mh) / 0.35) ** 2)
        T[i] /= max(np.linalg.norm(T[i]), 1e-12)
    return T


def fundamental_mask(V: np.ndarray, centers: np.ndarray, pitches: np.ndarray, ratio: float = 0.06) -> np.ndarray:
    """(frames, pitches) bool: False where a pitch's fundamental region is (nearly) empty while its
    harmonics are loud. Such a template would only be a 'missing fundamental' phantom explaining
    the overtones of a chord (C3+E3+G3+C4 looks exactly like the harmonic series of C2)."""
    def band(m):
        sel = np.abs(centers - m) <= 0.5
        return V[:, sel].max(axis=1) if sel.any() else np.zeros(V.shape[0])
    mask = np.ones((V.shape[0], len(pitches)), dtype=bool)
    for k, p in enumerate(pitches):
        fund = band(p)
        harm = np.maximum.reduce([band(p + 12), band(p + 19), band(p + 24)])
        mask[:, k] = fund >= ratio * harm
    return mask


def nmf_activations(V: np.ndarray, W: np.ndarray, n_iter: int = 60, sparsity: float = 0.0,
                    mask: np.ndarray | None = None) -> np.ndarray:
    """Activations H >= 0 with V(frames x bins) ~ H @ W (W fixed), KL-divergence multiplicative updates.
    `mask` (frames x templates) fixes masked activations at zero."""
    eps = 1e-12
    H = np.full((V.shape[0], W.shape[0]), float(np.mean(V)) + eps)
    if mask is not None:
        H *= mask
    Wt = W.T
    wsum = W.sum(axis=1)[None, :] + sparsity
    for _ in range(n_iter):
        R = V / (H @ W + eps)
        H *= (R @ Wt) / (wsum + eps)
    return H


def harmonic_salience(mag_frame: np.ndarray, freqs: np.ndarray, midi: float, n_harm: int = 6,
                      a4: float = 440.0, tol_cents: float = 40.0) -> float:
    """Sum of weighted harmonic peak magnitudes for one candidate pitch (used by the live follower)."""
    f0 = a4 * 2 ** ((midi - 69) / 12)
    total = 0.0
    for h in range(1, n_harm + 1):
        fh = h * f0
        if fh >= freqs[-1]:
            break
        lo = fh * 2 ** (-tol_cents / 1200)
        hi = fh * 2 ** (tol_cents / 1200)
        sel = (freqs >= lo) & (freqs <= hi)
        if sel.any():
            total += (0.8 ** (h - 1)) * float(np.max(mag_frame[sel]))
    return total


def smooth_midi(midi: np.ndarray, size: int = 5) -> np.ndarray:
    """Median-smooth a fractional MIDI track, ignoring NaNs at the edges of voiced regions."""
    out = midi.copy()
    v = ~np.isnan(midi)
    if v.sum() > size:
        filled = np.where(v, midi, 0.0)
        med = median_filter(filled, size=size, mode="nearest")
        cnt = median_filter(v.astype(float), size=size, mode="nearest")
        out = np.where(v & (cnt > 0.5), med, midi)
    return out
