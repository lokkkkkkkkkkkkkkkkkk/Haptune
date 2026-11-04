"""Lead-line extraction: pull one melodic instrument out of an accompaniment.

Neural separators give vocals / drums / bass / piano / guitar / "other". A violin, flute, erhu,
dizi or sax lands in "other" together with keyboard pads and chords. This module finds the lead
instrument's pitch contours and separates it with a harmonic comb mask that follows them, so the
lead gets its own audio stem and its own staff.

    spectral peaks -> harmonic-sum salience (10-cent grid) -> pitch contours
    -> keep contours that behave like the lead (range, vibrato, bowed/blown pitch micro-motion,
       sustained energy) -> one contour at a time -> comb mask -> lead / rest

Salience and contour tracking follow Salamon & Gomez (2012, "Melody extraction from polyphonic
music signals using pitch contour characteristics"), simplified, plus a "sustained instrument"
test so keyboard notes (perfectly steady pitch, decaying energy) stay in the accompaniment.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy.ndimage import uniform_filter1d
from scipy.signal import istft, stft

from .instruments import InstrumentProfile

CENTS_PER_BIN = 10


@dataclass
class Contour:
    start: int                      # first frame index
    bins: np.ndarray                # fractional salience bin per frame (10 cents above f_min)
    sal: np.ndarray                 # salience per frame
    features: dict = field(default_factory=dict)
    score: float = 0.0

    @property
    def end(self) -> int:
        return self.start + len(self.bins)


@dataclass
class LeadResult:
    lead: np.ndarray                # lead stem (same shape as the input)
    rest: np.ndarray                # input minus lead
    times: np.ndarray               # analysis frame times (s)
    midi: np.ndarray                # lead pitch per frame (fractional MIDI, NaN = lead silent)
    salience: np.ndarray            # lead salience per frame (0 = silent)
    contours: list                  # selected contours
    all_contours: int               # how many candidate contours were found


def _spectral_peaks(spec: np.ndarray, sr: int, n_fft: int, f_lo: float, f_hi: float, max_peaks: int = 30,
                    floor_db: float = 40.0):
    """Local maxima per frame with parabolic interpolation. Returns (frame, freq Hz, amplitude)."""
    df = sr / n_fft
    lo, hi = max(1, int(f_lo / df)), min(spec.shape[1] - 2, int(f_hi / df))
    L = 20 * np.log10(spec + 1e-9)
    mid = L[:, lo:hi]
    left, right = L[:, lo - 1:hi - 1], L[:, lo + 1:hi + 1]
    is_pk = (mid > left) & (mid >= right)
    fmax = L.max(axis=1, keepdims=True)
    is_pk &= mid > (fmax - floor_db)
    fr, kk = np.nonzero(is_pk)
    if fr.size == 0:
        return fr, np.zeros(0), np.zeros(0)
    a, b, c = left[fr, kk], mid[fr, kk], right[fr, kk]
    den = a - 2 * b + c
    p = np.where(np.abs(den) > 1e-9, 0.5 * (a - c) / den, 0.0)
    p = np.clip(p, -0.5, 0.5)
    freq = (kk + lo + p) * df
    amp_db = b - 0.25 * (a - c) * p
    # keep the strongest `max_peaks` per frame
    order = np.lexsort((-amp_db, fr))
    fr, freq, amp_db = fr[order], freq[order], amp_db[order]
    first = np.r_[0, np.flatnonzero(np.diff(fr)) + 1]
    rank = np.arange(fr.size) - np.repeat(first, np.diff(np.r_[first, fr.size]))
    keep = rank < max_peaks
    return fr[keep], freq[keep], 10 ** (amp_db[keep] / 20)


def salience(y_mono: np.ndarray, sr: int, f_min: float, f_max: float, hop: int = 256,
             n_harm: int = 10, alpha: float = 0.8, chunk: int = 1500):
    """Harmonic-summation pitch salience on a 10-cent grid. Returns (S [frames x bins], times)."""
    S, times, _ = salience_maps(y_mono, sr, f_min, f_max, hop, n_harm, alpha, chunk)
    return S, times


def salience_maps(y_mono: np.ndarray, sr: int, f_min: float, f_max: float, hop: int = 256,
                  n_harm: int = 10, alpha: float = 0.8, chunk: int = 1500):
    """(S, times, S1): S = harmonic-sum salience, S1 = the part of it coming from a spectral peak at
    the candidate pitch itself. A pitch with no energy at its own fundamental is usually a
    sub-harmonic ghost of a real note an octave higher."""
    n_win = int(round(0.093 * sr / 2)) * 2          # ~93 ms: resolves the harmonics of notes from G3 up
    n_fft = 2 * (1 << int(math.ceil(math.log2(n_win))))
    y = y_mono.astype(np.float64)
    n_frames = 1 + max(0, (len(y) - 1)) // hop
    times = np.arange(n_frames) * hop / sr
    frs, freqs, amps = [], [], []
    for f0_ in range(0, n_frames, chunk):          # chunked: a full-song spectrogram would not fit in RAM
        f1_ = min(n_frames, f0_ + chunk)
        a0 = f0_ * hop
        seg = y[max(0, a0 - n_win // 2): a0 + (f1_ - f0_) * hop + n_win]
        if a0 - n_win // 2 < 0:
            seg = np.concatenate([np.zeros(n_win // 2 - a0), seg])
        seg = np.concatenate([seg, np.zeros(max(0, (f1_ - f0_ - 1) * hop + n_win - len(seg)))])
        win = np.hanning(n_win + 2)[1:-1]
        idx = np.arange(n_win)[None, :] + hop * np.arange(f1_ - f0_)[:, None]
        spec = np.abs(np.fft.rfft(seg[idx] * win[None, :], n=n_fft, axis=1)).astype(np.float32)
        fr, freq, amp = _spectral_peaks(spec, sr, n_fft, f_min * 0.95, min(sr / 2 - 100, f_max * n_harm))
        frs.append(fr + f0_); freqs.append(freq); amps.append(amp)
    fr, freq, amp = np.concatenate(frs), np.concatenate(freqs), np.concatenate(amps)
    n_bins = int(math.ceil(1200 * math.log2(f_max / f_min) / CENTS_PER_BIN)) + 1
    S = np.zeros(len(times) * n_bins, dtype=np.float64)
    S1 = np.zeros(len(times) * n_bins, dtype=np.float64)
    for h in range(1, n_harm + 1):
        f0 = freq / h
        ok = (f0 >= f_min) & (f0 <= f_max)
        if not ok.any():
            continue
        b = 1200 * np.log2(f0[ok] / f_min) / CENTS_PER_BIN
        base = np.rint(b).astype(int)
        w0 = amp[ok] * alpha ** (h - 1)
        rows = fr[ok] * n_bins
        for d in range(-10, 11):
            bb = base + d
            dist = np.abs(bb - b)
            sel = (bb >= 0) & (bb < n_bins) & (dist < 10)
            if not sel.any():
                continue
            w = w0[sel] * np.cos(np.pi * dist[sel] / 20) ** 2
            add = np.bincount(rows[sel] + bb[sel], weights=w, minlength=S.size)
            S += add
            if h == 1:
                S1 += add
    return S.reshape(len(times), n_bins), times, S1.reshape(len(times), n_bins)


def _salience_peaks(S: np.ndarray, rel: float):
    """Per frame: bins that are local maxima, split into strong (>= rel * frame max) and weak."""
    left = np.pad(S[:, :-1], ((0, 0), (1, 0)), constant_values=0)
    right = np.pad(S[:, 1:], ((0, 0), (0, 1)), constant_values=0)
    pk = (S > left) & (S >= right) & (S > 0)
    fmax = S.max(axis=1, keepdims=True)
    strong = pk & (S >= rel * fmax)
    return pk, strong


def track_contours(S: np.ndarray, hop_s: float, rel: float = 0.35, max_jump_bins: int = 8,
                   max_gap_s: float = 0.1, min_len_s: float = 0.1) -> list:
    """Group salience peaks into continuous pitch contours (greedy, strongest peaks first)."""
    pk, strong = _salience_peaks(S, rel)
    allvals = S[pk]
    if allvals.size == 0:
        return []
    glob = allvals.mean() - 0.9 * allvals.std()
    strong &= S >= max(glob, 1e-12)
    peaks_by_frame = [np.flatnonzero(pk[t]) for t in range(S.shape[0])]
    used = [np.zeros(len(p), bool) for p in peaks_by_frame]
    st_t, st_b = np.nonzero(strong)
    order = np.argsort(-S[st_t, st_b])
    max_gap = max(1, int(round(max_gap_s / hop_s)))
    contours = []

    def take(t, b_prev, allow_weak=True):
        cand = peaks_by_frame[t]
        if cand.size == 0:
            return None
        d = np.abs(cand - b_prev)
        d = np.where(used[t], 1 << 30, d)
        k = int(np.argmin(d))
        if d[k] > max_jump_bins:
            return None
        if not allow_weak and not strong[t, cand[k]]:
            return None
        return k

    for i in order:
        t0, b0 = int(st_t[i]), int(st_b[i])
        k0 = np.searchsorted(peaks_by_frame[t0], b0)
        if k0 >= len(peaks_by_frame[t0]) or peaks_by_frame[t0][k0] != b0 or used[t0][k0]:
            continue
        used[t0][k0] = True
        seq = {t0: b0}
        for direction in (1, -1):
            t, b, gap = t0, b0, 0
            while True:
                t += direction
                if t < 0 or t >= S.shape[0]:
                    break
                k = take(t, b)
                if k is None:
                    gap += 1
                    if gap > max_gap:
                        break
                    continue
                bb = peaks_by_frame[t][k]
                if not strong[t, bb]:
                    gap += 1                    # weak peaks may bridge a short gap only
                    if gap > max_gap:
                        break
                else:
                    gap = 0
                used[t][k] = True
                seq[t] = bb
                b = bb
        frames = sorted(seq)
        # trim weak tails
        while frames and not strong[frames[-1], seq[frames[-1]]]:
            frames.pop()
        while frames and not strong[frames[0], seq[frames[0]]]:
            frames.pop(0)
        if not frames or (frames[-1] - frames[0] + 1) * hop_s < min_len_s:
            continue
        ts = np.arange(frames[0], frames[-1] + 1)
        fb = np.array(frames)
        bins = np.interp(ts, fb, [seq[f] for f in frames]).astype(float)
        # refine each frame's bin with a parabola through the salience peak
        for j, t in enumerate(ts):
            b = int(round(bins[j]))
            if 0 < b < S.shape[1] - 1:
                a_, m_, c_ = S[t, b - 1], S[t, b], S[t, b + 1]
                den = a_ - 2 * m_ + c_
                if den < 0:
                    bins[j] = b + float(np.clip(0.5 * (a_ - c_) / den, -0.5, 0.5))
        sal = S[ts, np.clip(np.rint(bins).astype(int), 0, S.shape[1] - 1)]
        contours.append(Contour(int(ts[0]), bins, sal))
    return contours


def _features(c: Contour, hop_s: float, S1: np.ndarray | None = None) -> dict:
    cents = c.bins * CENTS_PER_BIN
    n = len(cents)
    dur = n * hop_s
    # note steps vs micro-motion: detrend with a 150 ms moving average
    k = max(3, int(round(0.15 / hop_s)) | 1)
    smooth = uniform_filter1d(cents, k, mode="nearest")
    micro = float(np.std(cents - smooth))                  # vibrato + bow/breath wobble (cents)
    vib_ext, vib_per = 0.0, 0.0
    if dur >= 0.4:
        from scipy.signal import butter, sosfiltfilt
        sos = butter(2, [4.0, 8.0], btype="band", fs=1.0 / hop_s, output="sos")
        v = sosfiltfilt(sos, cents - cents.mean())
        vib_ext = float(np.sqrt(2) * np.std(v))             # vibrato depth in cents
        r = v - v.mean()
        ac = np.correlate(r, r, "full")[n - 1:]
        ac = ac / (ac[0] + 1e-12)
        lo, hi = int(0.11 / hop_s), int(0.26 / hop_s)
        if hi < n:
            vib_per = float(ac[lo:hi].max())                # regular 4-9 Hz wobble = real vibrato
    s = c.sal
    third = max(1, n // 3)
    decay = float(np.mean(s[-third:]) / (np.mean(s[:third]) + 1e-12))       # piano: << 1
    steps = np.abs(np.diff(np.rint(smooth / 100.0)))
    n_notes = int(1 + np.count_nonzero(steps))
    # re-attacks on the same pitch (a keyboard re-striking a chord tone): sudden salience jumps
    ls = 20 * np.log10(s + 1e-9)
    rises = np.flatnonzero(ls[3:] - ls[:-3] > 6.0) if n > 3 else np.array([], dtype=int)
    attacks = int(np.count_nonzero(np.diff(rises) > 4) + (1 if rises.size else 0))
    h1 = 1.0
    if S1 is not None:
        idx = np.clip(np.rint(c.bins).astype(int), 0, S1.shape[1] - 1)
        h1 = float(np.mean(S1[np.arange(c.start, c.end), idx]) / (s.mean() + 1e-12))
    return {"dur": dur, "mean_cents": float(cents.mean()), "micro": micro, "vib_ext": vib_ext, "vib_per": vib_per,
            "decay": decay, "mean_sal": float(s.mean()), "notes": n_notes, "reattack": attacks / max(dur, 1e-3),
            "h1": h1}


def _vibrato(f: dict) -> float:
    """0..1: how clearly the contour shows a regular 4-9 Hz vibrato (string/voice vibrato is 12-40
    cents deep; keyboard partials beating against each other wobble by only a few cents)."""
    return float(np.clip(f["vib_ext"] / 15.0, 0, 1) * np.clip((f["vib_per"] - 0.2) / 0.5, 0, 1))


def _lead_score(f: dict, profile: InstrumentProfile, f_min: float) -> float:
    """How much a contour looks like the sustained lead instrument (0 = not at all)."""
    midi = 69 + 12 * math.log2(f_min / 440.0) + f["mean_cents"] / 100.0
    if midi < profile.low - 1 or midi > profile.high + 2:
        return 0.0
    score = math.sqrt(max(f["mean_sal"], 0.0)) * min(1.0, f["dur"] / 0.3)
    if profile.mode == "mono":
        vib = _vibrato(f)
        sus = min(1.0, f["decay"] / 0.6)                          # bowed / blown / sung notes do not decay
        legato = min(1.0, (f["notes"] - 1) / 2.0)                 # one contour across several notes
        likeness = 0.15 + 0.55 * vib + 0.15 * sus + 0.15 * legato
        if f["dur"] > 1.0 and f["vib_ext"] < 5.0 and f["micro"] < 6.0:
            likeness *= 0.25                                      # long, dead-steady pitch: a keyboard
        if f["reattack"] > 1.0 and vib < 0.3 and f["notes"] <= 2:
            likeness *= 0.4                                       # the same note struck again and again
        score *= likeness
    return float(score)


def extract_lead(audio: np.ndarray, sr: int, profile: InstrumentProfile, hop: int | None = None,
                 analysis_sr: int = 22050, keep_threshold: float = 0.3, mask_cents: float = 45.0,
                 max_harm_hz: float = 12000.0) -> LeadResult:
    """Separate the lead line of `profile` (violin, flute, erhu, voice...) from `audio`.

    audio: (n,) or (n, channels) float, any sample rate. The result keeps the input's shape.
    """
    x = np.asarray(audio, dtype=np.float64)
    mono = x if x.ndim == 1 else x.mean(axis=1)
    # analysis at 22.05 kHz, 11.6 ms hop
    if sr != analysis_sr:
        from scipy.signal import resample_poly
        g = math.gcd(int(sr), int(analysis_sr))
        ya = resample_poly(mono, analysis_sr // g, int(sr) // g)
    else:
        ya = mono
    a_hop = 256
    hop_s = a_hop / analysis_sr
    f_min = 440.0 * 2 ** ((profile.low - 1 - 69) / 12)
    f_max = 440.0 * 2 ** ((profile.high + 1 - 69) / 12)
    S, times, S1 = salience_maps(ya, analysis_sr, f_min, f_max, hop=a_hop)
    contours = track_contours(S, hop_s)
    for c in contours:
        c.features = _features(c, hop_s, S1)
        c.score = _lead_score(c.features, profile, f_min)
    # register prior: contours with clear vibrato show where the lead instrument usually plays;
    # a keyboard pad far below (or above) that register is unlikely to be the lead
    base_midi = 69 + 12 * math.log2(f_min / 440.0)
    anchors = [c for c in contours if c.score > 0 and _vibrato(c.features) >= 0.5]
    if profile.mode == "mono" and len(anchors) >= 5:
        mids = np.array([base_midi + c.features["mean_cents"] / 100 for c in anchors])
        w = np.array([c.features["dur"] * c.features["mean_sal"] for c in anchors])
        order = np.argsort(mids)
        cum = np.cumsum(w[order]) / w.sum()
        register = float(mids[order][np.searchsorted(cum, 0.5)])
        for c in contours:
            if c.score > 0:
                d = (base_midi + c.features["mean_cents"] / 100) - register
                c.score *= math.exp(-0.5 * (d / 9.0) ** 2) if abs(d) > 5 else 1.0
    cand = [c for c in contours if c.score > 0]
    if cand:
        ref = np.percentile([c.score for c in cand], 75)
        cand = [c for c in cand if c.score >= keep_threshold * ref]
    # octave duplicates: of two overlapping contours ~1200 cents apart keep the stronger
    cand.sort(key=lambda c: -c.score)
    # harmonics and octave doublings: two simultaneous contours an octave / twelfth / two octaves apart.
    # If their pitch wobbles together they are one source (keep the lower = the fundamental);
    # otherwise keep the one that sounds like the lead (vibrato), else the stronger.
    drop = set()
    for i, a in enumerate(cand):
        for b in cand[i + 1:]:
            lo, hi = max(a.start, b.start), min(a.end, b.end)
            if hi - lo <= 0.5 * min(len(a.bins), len(b.bins)):
                continue
            d = abs(a.features["mean_cents"] - b.features["mean_cents"])
            if min(abs(d - 1200), abs(d - 1902), abs(d - 2400)) > 60:
                continue
            ra = a.bins[lo - a.start: hi - a.start]
            rb = b.bins[lo - b.start: hi - b.start]
            ra, rb = ra - uniform_filter1d(ra, 13, mode="nearest"), rb - uniform_filter1d(rb, 13, mode="nearest")
            together = False                     # (shared-vibrato test disabled: it confused sub-harmonics with fundamentals)
            if together:
                low, high = (a, b) if a.features["mean_cents"] < b.features["mean_cents"] else (b, a)
                # one source: the lower is the real note only if it has energy at its own pitch
                loser = high if low.features.get("h1", 1.0) >= 0.5 * high.features.get("h1", 1.0) else low
            else:
                va, vb = _vibrato(a.features), _vibrato(b.features)
                loser = b if va >= vb + 0.15 or (abs(va - vb) < 0.15 and a.score >= b.score) else a
            drop.add(id(loser))
    cand = [c for c in cand if id(c) not in drop]
    chosen: list[Contour] = []
    occupied = np.full(S.shape[0], -1)
    for c in cand:
        span = np.arange(c.start, c.end)
        overlap = occupied[span] >= 0
        if overlap.mean() > 0.5:
            continue
        chosen.append(c)
        free = span[~overlap]
        occupied[free] = len(chosen) - 1
    n_fr = S.shape[0]
    lead_bins = np.full(n_fr, np.nan)
    lead_sal = np.zeros(n_fr)
    for ci, c in enumerate(chosen):
        for j, t in enumerate(range(c.start, c.end)):
            if occupied[t] == ci:
                lead_bins[t] = c.bins[j]
                lead_sal[t] = c.sal[j]
    lead_hz = f_min * 2 ** (lead_bins * CENTS_PER_BIN / 1200)
    midi = 69 + 12 * np.log2(lead_hz / 440.0)

    lead = comb_separate(x, sr, times, lead_hz, mask_cents=mask_cents, max_harm_hz=max_harm_hz)
    rest = x - lead
    return LeadResult(lead.astype(np.float32), rest.astype(np.float32), times, midi, lead_sal, chosen, len(contours))


def comb_mask(f0_t: np.ndarray, freqs: np.ndarray, mask_cents: float = 45.0, max_harm_hz: float = 12000.0) -> np.ndarray:
    """Soft harmonic comb per STFT frame: 1 on the partials of f0 (Hz, 0 = silent), 0 elsewhere."""
    df = freqs[1] - freqs[0]
    ratio = 2 ** (mask_cents / 1200) - 1
    mask = np.zeros((len(freqs), len(f0_t)), dtype=np.float32)
    for j in np.flatnonzero(f0_t > 0):
        f0 = f0_t[j]
        h = np.rint(freqs / f0)
        fh = h * f0
        width = np.maximum(1.5 * df, fh * ratio + 0.5 * df)
        d = (freqs - fh) / width
        m = np.exp(-0.5 * d * d)
        m[(h < 1) | (fh > max_harm_hz)] = 0.0
        mask[:, j] = m
    return mask


def comb_separate(x: np.ndarray, sr: int, times: np.ndarray, f0_hz: np.ndarray, mask_cents: float = 45.0,
                  max_harm_hz: float = 12000.0) -> np.ndarray:
    """The part of `x` that lies on the harmonics of the pitch track `f0_hz` (NaN = silent)."""
    n_fft = 4096 if sr >= 32000 else 2048
    s_hop = n_fft // 8
    chans = [x] if x.ndim == 1 else [x[:, c] for c in range(x.shape[1])]
    n = x.shape[0]
    outs = []
    mask = None
    for ch in chans:
        _, _, Z = stft(ch.astype(np.float32), fs=sr, nperseg=n_fft, noverlap=n_fft - s_hop, boundary="zeros", padded=True)
        if mask is None:
            n_bins, n_t = Z.shape
            freqs = np.arange(n_bins) * sr / n_fft
            t_s = np.arange(n_t) * s_hop / sr
            f0_t = np.interp(t_s, times, np.nan_to_num(f0_hz, nan=0.0))
            voiced = np.interp(t_s, times, (~np.isnan(f0_hz)).astype(float)) > 0.5
            f0_t = np.where(voiced, f0_t, 0.0)
            mask = comb_mask(f0_t, freqs, mask_cents, max_harm_hz)
            mask = uniform_filter1d(mask, 3, axis=1)        # soften on/offsets so the comb does not click
        y = istft(Z * mask, fs=sr, nperseg=n_fft, noverlap=n_fft - s_hop, boundary=True)[1]
        y = y[:n] if len(y) >= n else np.pad(y, (0, n - len(y)))
        outs.append(y)
    return outs[0] if x.ndim == 1 else np.stack(outs, axis=1)
