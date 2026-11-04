"""Real-time score follower: microphone frames in, Watch feedback events out.

Runs causally on 11.6 ms hops with ~40-80 ms decision latency, which is the
budget for a wrist buzz to still feel connected to the note. The same state
machine is ported to Swift (PracticeCore/ScoreFollower.swift).

Modes
  follow : the cursor follows you at your own tempo (default)
  wait   : the score waits until the correct note is played (learning a new piece)
  tempo  : judged against the (silent, haptic) metronome grid
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field

import numpy as np

from . import dsp
from .haptics import FeedbackEvent, HapticGate
from .instruments import InstrumentProfile, get_profile
from .score import Score, midi_name


def _yin_single(seg: np.ndarray, W: int, tau_min: int, tau_max: int, threshold: float = 0.15):
    """YIN on one window seg (len W + tau_max). Returns (tau_float, cmnd_value)."""
    frame = seg[:W]
    nfft = int(2 ** math.ceil(math.log2(len(seg) + W)))
    corr = np.fft.irfft(np.conj(np.fft.rfft(frame, nfft)) * np.fft.rfft(seg, nfft), nfft)[:tau_max + 1]
    csum = np.concatenate([[0.0], np.cumsum(seg * seg)])
    taus = np.arange(tau_max + 1)
    d = np.maximum(csum[W] + (csum[taus + W] - csum[taus]) - 2 * corr, 0.0)
    d[0] = 0.0
    cum = np.cumsum(d[1:])
    cmnd = np.ones(tau_max + 1)
    cmnd[1:] = d[1:] * taus[1:] / np.maximum(cum, 1e-12)
    row = cmnd[tau_min:tau_max]
    cand = np.flatnonzero(row < threshold)
    if cand.size:
        t = int(cand[0])
        while t + 1 < row.size and row[t + 1] < row[t]:
            t += 1
    else:
        t = int(np.argmin(row))
    tau = t + tau_min
    if 1 <= tau < tau_max:
        a, b, c = cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]
        den = a - 2 * b + c
        shift = float(np.clip(0.5 * (a - c) / den, -1, 1)) if abs(den) > 1e-12 else 0.0
    else:
        shift = 0.0
    return tau + shift, float(cmnd[tau])


@dataclass
class _MonoState:
    semitone: int | None = None
    start: float = 0.0
    midis: list = field(default_factory=list)
    peak_rms: float = 0.0
    dipped: bool = False
    pending: int | None = None
    pending_count: int = 0
    unvoiced: int = 0
    announced: bool = False
    intonation_done: bool = False
    matched_expected: int | None = None
    note_id: str | None = None


class LiveFollower:
    def __init__(self, score: Score, instrument: str | InstrumentProfile, mode: str = "follow",
                 qpm: float | None = None, a4: float = 440.0, sensitivity: str = "normal",
                 loop: tuple[int, int] | None = None, metronome_start: float = 0.0,
                 level: str = "intermediate", sr: int = dsp.SR):
        self.prof = instrument if isinstance(instrument, InstrumentProfile) else get_profile(instrument)
        self.score = score
        self.mode = mode
        self.a4 = a4
        self.sr, self.hop = sr, dsp.HOP
        self.qpm = qpm or score.first_tempo
        self.level_tol = {"beginner": 1.6, "intermediate": 1.0, "advanced": 0.7}.get(level, 1.0)
        self.metronome_start = metronome_start
        self.loop = loop
        evs = score.events()
        if self.prof.mode != "rhythm":
            # notes this instrument cannot play are not judged (wrong instrument / part chosen)
            for e in evs:
                e.notes = [n for n in e.notes if n.pitch is None or self.prof.low <= n.pitch <= self.prof.high]
            evs = [e for e in evs if e.notes]
        if loop:
            first, last = loop
            evs = [e for e in evs if first <= e.measure <= last]
        self.events = evs
        self.cursor = 0
        self.passes = 0
        self.pass_errors = 0
        self.gate = HapticGate(sensitivity)
        self.log: list[FeedbackEvent] = []          # everything decided
        self.buzzed: list[FeedbackEvent] = []       # what actually reached the wrist
        self.results: dict[str, str] = {}
        self.matched: deque = deque(maxlen=8)       # (beat, time)
        self.devs: deque = deque(maxlen=3)
        self.recent_played: deque = deque(maxlen=6)
        self.mismatch_run = 0
        self.last_onset_time = -1.0
        # audio buffering
        p = self.prof
        self.tau_min = max(2, int(sr / p.fmax))
        self.tau_max = int(math.ceil(sr / max(p.fmin, 25.0)))
        self.W = int(2 ** math.ceil(math.log2(max(512, 1.25 * self.tau_max))))
        self.need = max(self.W + self.tau_max, 4096)
        self.buf = np.zeros(0, dtype=np.float64)
        self.consumed = 0                           # samples discarded from the left of buf
        self.pos = 0                                # absolute sample index of the next hop end
        self.rms_peak = 1e-4
        self.mono = _MonoState()
        # onset / poly state
        self.fb, self.fb_centers = dsp.logfreq_filterbank(sr, 2048, 3, 28.0, 116.0)
        self.prev_logspec = None
        self.flux_hist: deque = deque(maxlen=40)
        self.pending_poly: list = []                # (eval_at_sample, onset_time, pre_salience)
        self.freqs4096 = np.fft.rfftfreq(4096, 1.0 / sr)
        self.win4096 = np.hanning(4096)
        self.win2048 = np.hanning(2048)
        self.sal_hist: deque = deque(maxlen=40)     # recent spectra (for "before onset" salience)
        self.hop_energy: deque = deque(maxlen=64)   # (time of hop end, rms of the last hop)

    # ------------------------------------------------------------------ API
    def push(self, samples: np.ndarray) -> list[FeedbackEvent]:
        """Feed microphone samples (mono float, self.sr). Returns events to buzz now."""
        self.buf = np.concatenate([self.buf, np.asarray(samples, dtype=np.float64)])
        out: list[FeedbackEvent] = []
        end_abs = self.consumed + len(self.buf)
        while self.pos + self.hop <= end_abs:
            self.pos += self.hop
            if self.pos - self.consumed >= self.need:
                out += self._frame()
        keep = self.need + self.hop
        if len(self.buf) > 4 * keep:
            drop = len(self.buf) - keep
            self.buf = self.buf[drop:]
            self.consumed += drop
        return out

    @property
    def now(self) -> float:
        return self.pos / self.sr

    def position(self) -> dict:
        if self.cursor < len(self.events):
            e = self.events[self.cursor]
            return {"event": self.cursor, "measure": e.measure, "beat": e.onset,
                    "label": self.score.measures[e.measure].label if self.score.measures else str(e.measure)}
        return {"event": self.cursor, "measure": None, "done": True}

    # ------------------------------------------------------------ internals
    def _window(self, n: int) -> np.ndarray:
        end = self.pos - self.consumed
        return self.buf[max(0, end - n):end]

    def _frame(self) -> list[FeedbackEvent]:
        if self.prof.mode == "poly":
            return self._frame_poly()
        if self.prof.mode == "rhythm":
            return self._frame_rhythm()
        return self._frame_mono()

    def _emit(self, ev: FeedbackEvent) -> list[FeedbackEvent]:
        if self.score.measures and ev.measure is not None and ev.measure < len(self.score.measures):
            ev.measure_label = self.score.measures[ev.measure].label
        self.log.append(ev)
        if ev.type in ("wrong_note", "missed_note"):
            self.pass_errors += 1
        if self.gate.allow(ev):
            self.buzzed.append(ev)
            return [ev]
        return []

    # ---------------------------------------------------------------- mono
    def _frame_mono(self) -> list[FeedbackEvent]:
        seg = self._window(self.W + self.tau_max)
        t = (self.pos - self.tau_max - self.W / 2) / self.sr     # centre of the analysis window
        rms = float(np.sqrt(np.mean(seg[:self.W] ** 2)))
        self.rms_peak = max(self.rms_peak * 0.9995, rms)
        tau, cm = _yin_single(seg, self.W, self.tau_min, self.tau_max)
        f0 = self.sr / tau
        voiced = cm < 0.35 and rms > max(1e-4, 0.03 * self.rms_peak) and self.prof.fmin * 0.95 <= f0 <= self.prof.fmax * 1.05
        st = self.mono
        out: list[FeedbackEvent] = []
        if not voiced:
            st.unvoiced += 1
            if st.unvoiced >= 3 and st.semitone is not None:
                self.mono = _MonoState()
            return out
        st.unvoiced = 0
        m = 69 + 12 * math.log2(f0 / self.a4)
        semi = self._nearest_semitone(m)
        settle = 5 if self.prof.vibrato else 3          # singers scoop, strings start with the bow noise
        if not self._is_expected(semi):
            # an unexpected pitch must be clean, reasonably loud and last ~90 ms before we call it a
            # wrong note: slides, portamento and reverb tails between two notes are not mistakes
            settle = max(settle, int(round(0.09 * self.sr / self.hop)))
            if cm > 0.25 or rms < 0.25 * self.rms_peak:
                st.pending, st.pending_count = None, 0
                return out
        if st.semitone is None:
            if st.pending == semi:
                st.pending_count += 1
            else:
                st.pending, st.pending_count = semi, 1
                st.start = t
            if st.pending_count >= settle:
                st.semitone, st.midis, st.peak_rms = semi, [m], rms
                out += self._note_on(semi, st.start, st)
            return out
        if abs(m - st.semitone) > 0.62:
            if st.pending == semi:
                st.pending_count += 1
            else:
                st.pending, st.pending_count, st.dipped = semi, 1, False
                st.pending_start = t
            if st.pending_count >= settle:
                start = getattr(st, "pending_start", t)
                self.mono = _MonoState(semitone=semi, start=start, midis=[m], peak_rms=rms)
                out += self._note_on(semi, start, self.mono)
            return out
        st.pending, st.pending_count = None, 0
        st.midis.append(m)
        # re-articulation (same pitch): energy dip then recovery
        if rms < 0.5 * st.peak_rms and t - st.start > self.prof.min_note_ms / 1000:
            st.dipped = True
        elif st.dipped and rms > 0.75 * st.peak_rms:
            self.mono = _MonoState(semitone=semi, start=t, midis=[m], peak_rms=rms)
            return out + self._note_on(semi, t, self.mono)
        st.peak_rms = max(st.peak_rms, rms)
        # intonation verdict once the note has settled
        if (self.prof.intonation and not st.intonation_done and st.matched_expected is not None
                and t - st.start >= 0.16 and len(st.midis) >= 8):
            st.intonation_done = True
            settled = np.array(st.midis[int(0.06 * self.sr / self.hop):]) if len(st.midis) > 6 else np.array(st.midis)
            cents = (float(np.median(settled)) - st.matched_expected) * 100.0
            if abs(cents) > self.prof.cents_warn:
                out += self._emit(FeedbackEvent(
                    "sharp" if cents > 0 else "flat", round(t, 3),
                    measure=self.events[max(0, self.cursor - 1)].measure if self.events else None,
                    note_id=st.note_id, expected=st.matched_expected, played=semi, cents=round(cents, 1),
                    text=f"{cents:+.0f}c"))
        return out

    def _is_expected(self, semi: int) -> bool:
        if self.cursor >= len(self.events):
            return True
        lo = max(0, self.cursor - 1)
        return any(semi in e.pitches for e in self.events[lo:self.cursor + 3])

    def _nearest_semitone(self, m: float) -> int:
        """For instruments with free intonation a note 40 cents flat is still *that* note, just out of
        tune: snap to the expected pitch when within 0.75 semitone, otherwise round normally."""
        semi = int(round(m))
        if self.prof.intonation and self.cursor < len(self.events):
            for e in self.events[self.cursor:self.cursor + 2]:
                for p in e.pitches:
                    if abs(m - p) < 0.75:
                        return p
        return semi

    def _note_on(self, semi: int, t: float, st: _MonoState) -> list[FeedbackEvent]:
        return self._match({semi}, t, st)

    # ---------------------------------------------------------------- poly
    def _logspec(self, frame2048: np.ndarray) -> np.ndarray:
        mag = np.abs(np.fft.rfft(frame2048 * self.win2048))
        return np.log1p(100.0 * (mag @ self.fb.T) / (self.rms_peak * 2048 + 1e-9))

    def _onset(self) -> float | None:
        """Causal SuperFlux onset: returns onset time or None."""
        w = self._window(2048)
        rms = float(np.sqrt(np.mean(w[-512:] ** 2)))
        self.rms_peak = max(self.rms_peak * 0.9995, rms)
        ls = self._logspec(w)
        flux = 0.0
        if self.prev_logspec is not None:
            ref = np.maximum.reduce([np.roll(self.prev_logspec, k) for k in (-1, 0, 1)])
            flux = float(np.sum(np.maximum(ls - ref, 0.0)))
        self.prev_logspec = ls
        self.flux_hist.append(flux)
        h = self.flux_hist
        if len(h) < 4:
            return None
        a, b, c = h[-3], h[-2], h[-1]
        base = float(np.mean(list(h)[:-2])) if len(h) > 6 else 0.0
        peak = max(max(h), 1e-9)
        t = (self.pos - 2048 / 2) / self.sr - self.hop / self.sr + 0.019   # measured causal bias
        nf = getattr(self, "_noise_floor", None)
        if nf is None or rms < nf:
            nf = rms if nf is None else 0.9 * nf + 0.1 * rms
        else:
            nf *= 1.0008                                  # slowly forget (room gets louder)
        self._noise_floor = max(nf, 1e-6)
        loud = rms > 0.08 * self.rms_peak and rms > 5.0 * self._noise_floor and len(h) >= 8
        if loud and b > a and b >= c and b > base + 0.12 * peak and b > 1.0 and t - self.last_onset_time > 0.05:
            self.last_onset_time = t
            return t
        return None

    def _salience(self, spec: np.ndarray, p: int) -> float:
        return dsp.harmonic_salience(spec, self.freqs4096, p, n_harm=6, a4=self.a4)

    def _refine_onset(self, t_guess: float) -> float:
        """Attack time = first hop (around the flux peak) whose energy reaches half of the new level."""
        hist = [(t, e) for t, e in self.hop_energy if t_guess - 0.15 <= t <= t_guess + 0.15]
        if not hist:
            return t_guess
        level = max(e for _, e in hist)
        for t, e in hist:
            if e >= 0.5 * level:
                return t - self.hop / (2 * self.sr)
        return t_guess

    def _spectrum_before(self, t: float) -> np.ndarray | None:
        target = int((t - 0.03) * self.sr)          # window must END before the attack
        best = None
        for pos, spec in self.sal_hist:
            if pos <= target:
                best = spec
        return best

    def _frame_poly(self) -> list[FeedbackEvent]:
        out: list[FeedbackEvent] = []
        spec = None
        hop_seg = self._window(self.hop)
        self.hop_energy.append((self.pos / self.sr, float(np.sqrt(np.mean(hop_seg ** 2))) if hop_seg.size else 0.0))
        t_on = self._onset()
        w4 = self._window(4096)
        if len(w4) == 4096 and (t_on is not None or self.pending_poly or self.pos % (self.hop * 2) == 0):
            spec = np.abs(np.fft.rfft(w4 * self.win4096))
            self.sal_hist.append((self.pos, spec))
        if t_on is not None:
            self.pending_poly.append([self.pos + 7 * self.hop, t_on, 0])
        still = []
        for item in self.pending_poly:
            due, t0, tries = item
            if due > self.pos:
                still.append(item)
                continue
            t_att = self._refine_onset(t0)
            if self.pos / self.sr - t_att < 0.075 and tries < 4:       # let the new note fill the window
                still.append([self.pos + 2 * self.hop, t0, tries + 1])
                continue
            if abs(t_att - getattr(self, "_last_eval_onset", -1.0)) < 0.06:
                continue                                    # double trigger of the same attack
            self._last_eval_onset = t_att
            if spec is None:
                spec = np.abs(np.fft.rfft(w4 * self.win4096))
            played = self._poly_pitches(spec, self._spectrum_before(t_att))
            if played:
                out += self._match(played, round(t_att, 4), None)
        self.pending_poly = still
        return out

    def _templates(self, pitches: list[int]) -> np.ndarray:
        cache = self.__dict__.setdefault("_tpl_cache", {})
        missing = [p for p in pitches if p not in cache]
        if missing:
            if not hasattr(self, "_fb4096"):
                self._fb4096, self._c4096 = dsp.logfreq_filterbank(self.sr, 4096)
            B = 2.5e-4 if self.prof.family == "keyboard" else 2e-5
            T = dsp.harmonic_templates(np.array(missing), self._c4096, n_harm=12, inharmonicity=B, slope=1.1)
            for p, row in zip(missing, T):
                cache[p] = row
        return np.stack([cache[p] for p in pitches])

    def _poly_pitches(self, spec: np.ndarray, pre: np.ndarray | None) -> set[int]:
        """Score-informed: which expected pitches (or close wrong neighbours) are sounding now?
        A tiny NMF over {expected pitches +-2 semitones, broadband noise} explains the spectrum
        jointly, so overtones of one chord tone are not mistaken for another note."""
        look = self.events[self.cursor:self.cursor + 2]
        if not look:
            return set()
        expected = sorted({p for e in look for p in e.pitches})
        cands = sorted({q for p in expected for q in (p - 2, p - 1, p, p + 1, p + 2)
                        if self.prof.low - 2 <= q <= self.prof.high + 2})
        W = self._templates(cands)
        if not hasattr(self, "_noise4096"):
            c = self._c4096
            nz = np.stack([np.exp(-0.5 * ((c - k) / 18.0) ** 2) for k in (40.0, 70.0, 100.0)])
            self._noise4096 = nz / np.linalg.norm(nz, axis=1, keepdims=True)
        Wf = np.vstack([W, self._noise4096])
        V = np.vstack([(spec @ self._fb4096.T) ** 0.8,
                       ((pre if pre is not None else spec * 0) @ self._fb4096.T) ** 0.8])
        H = dsp.nmf_activations(V + 1e-9, Wf, n_iter=40)
        h, h_pre = H[0, :len(cands)], H[1, :len(cands)]
        top = h.max() + 1e-12
        act = dict(zip(cands, h))
        act_pre = dict(zip(cands, h_pre))
        played: set[int] = set()
        for p in expected:
            if p in act and act[p] >= 0.25 * top and act[p] > 1.15 * act_pre[p]:
                played.add(p)
        for q in cands:                         # strong, new neighbour that is not expected = wrong note
            if q in expected:
                continue
            near = [p for p in expected if abs(p - q) <= 2 and p in act]
            if near and act[q] >= 0.5 * top and act[q] > 1.5 * act_pre[q] and act[q] > 2.0 * max(act[p] for p in near):
                played.add(q)
        return played

    # -------------------------------------------------------------- rhythm
    def _frame_rhythm(self) -> list[FeedbackEvent]:
        t = self._onset()
        if t is None:
            return []
        return self._match(set(), t, None)

    # ------------------------------------------------------------ matching
    def _expected_time(self, beat: float) -> tuple[float | None, float]:
        spb = 60.0 / self.qpm
        if self.mode == "tempo":
            return self.metronome_start + beat * spb, spb
        if len(self.matched) >= 3:
            recent = list(self.matched)[-5:]
            b = np.array([x[0] for x in recent])
            tt = np.array([x[1] for x in recent])
            if np.ptp(b) > 0:
                slope, icpt = np.polyfit(b, tt, 1)
                slope = float(np.clip(slope, 0.2 * spb, 5 * spb))
                return float(icpt + slope * beat), slope
        return None, spb

    def _timing(self, beat: float, t: float, measure: int, note_id: str) -> list[FeedbackEvent]:
        exp, spb = self._expected_time(beat)
        if exp is None:
            return []
        dev = t - exp
        tol = max(0.06, 0.12 * spb) * self.level_tol
        if self.mode == "tempo":
            sign = 0 if abs(dev) <= tol else (-1 if dev < 0 else 1)
        else:
            # follow mode: compare the current speed with *your own* reference speed for this take,
            # so returning to tempo after a rushed bar is not called "dragging"
            self.__dict__.setdefault("_spb_hist", []).append(spb)
            ref = float(np.median(self._spb_hist[-40:])) if len(self._spb_hist) >= 4 else 60.0 / self.qpm
            ratio = ref / max(spb, 1e-6)
            thr = 0.12 * self.level_tol
            sign = -1 if ratio > 1 + thr else (1 if ratio < 1 - thr else 0)
        self.devs.append(sign)
        if list(self.devs).count(-1) >= 2 and sign == -1:
            self.devs.clear()
            return self._emit(FeedbackEvent("rushing", round(t, 3), measure=measure, note_id=note_id, text="rushing"))
        if list(self.devs).count(1) >= 2 and sign == 1:
            self.devs.clear()
            return self._emit(FeedbackEvent("dragging", round(t, 3), measure=measure, note_id=note_id, text="dragging"))
        return []

    def _advance_to(self, k: int, t: float) -> list[FeedbackEvent]:
        out: list[FeedbackEvent] = []
        for skipped in self.events[self.cursor:k]:
            for n in skipped.notes:
                self.results.setdefault(n.id, "missed")
            out += self._emit(FeedbackEvent("missed_note", round(t, 3), measure=skipped.measure,
                                            note_id=skipped.notes[0].id,
                                            expected=skipped.pitches[0] if skipped.pitches else None,
                                            text=midi_name(skipped.pitches[0]) if skipped.pitches else "missed"))
        self.cursor = k
        return out

    def _finish_pass_if_done(self, t: float) -> list[FeedbackEvent]:
        if self.cursor < len(self.events):
            return []
        out: list[FeedbackEvent] = []
        if self.pass_errors == 0:
            out += self._emit(FeedbackEvent("section_clean", round(t, 3), text="clean!"))
        self.passes += 1
        if self.loop:
            self.cursor, self.pass_errors = 0, 0
            self.matched.clear()
        return out

    def _match(self, played: set[int], t: float, st: _MonoState | None) -> list[FeedbackEvent]:
        out: list[FeedbackEvent] = []
        if self.cursor >= len(self.events):
            return out
        rhythm = self.prof.mode == "rhythm"
        poly = self.prof.mode == "poly"
        # tempo mode: the expected event is the one the metronome says we are at
        if self.mode == "tempo" and not rhythm:
            spb = 60.0 / self.qpm
            beat_now = (t - self.metronome_start) / spb
            k_best = min(range(self.cursor, min(len(self.events), self.cursor + 6)),
                         key=lambda k: abs(self.events[k].onset - beat_now))
            if k_best > self.cursor:
                out += self._advance_to(k_best, t)
        look = range(self.cursor, min(len(self.events), self.cursor + 3))

        def hit(k):
            e = self.events[k]
            if rhythm:
                return True
            if poly:
                need = set(e.pitches)
                return len(need & played) >= max(1, math.ceil(0.6 * len(need)))
            return bool(played & set(e.pitches))

        k_hit = next((k for k in look if hit(k)), None)
        if k_hit is not None and k_hit > self.cursor and self.mode != "wait":
            # only skip ahead if the player is plausibly past the current note
            exp_t, spb = self._expected_time(self.events[self.cursor].onset)
            if exp_t is not None and t < exp_t - 0.5 * spb:
                k_hit = None if not hit(self.cursor) else self.cursor
            elif exp_t is None and self.matched and t - self.matched[-1][1] < 0.6 * (
                    self.events[self.cursor].onset - self.matched[-1][0]) * 60.0 / self.qpm:
                k_hit = None                                # too soon to have skipped a note
        if k_hit is not None:
            if k_hit > self.cursor:
                out += self._advance_to(k_hit, t)
            e = self.events[self.cursor]
            missing = [] if (rhythm or not poly) else sorted(set(e.pitches) - played)
            wrong = [] if (rhythm or not poly) else sorted(played - set(e.pitches))
            for n in e.notes:
                if rhythm or n.pitch in played:
                    self.results[n.id] = "correct"
                else:
                    self.results[n.id] = "missed"
            if wrong:
                out += self._emit(FeedbackEvent("wrong_note", round(t, 3), measure=e.measure, note_id=e.notes[0].id,
                                                expected=missing[0] if missing else None, played=wrong[0],
                                                text=midi_name(missing[0]) if missing else midi_name(wrong[0])))
            elif missing and len(missing) >= max(1, len(e.pitches) // 2) and self.mode == "wait":
                # live chord detection misses quiet inner voices now and then, so a missing chord tone
                # only buzzes in Wait mode; the full analysis after the take still reports it
                out += self._emit(FeedbackEvent("missed_note", round(t, 3), measure=e.measure, note_id=e.notes[0].id,
                                                expected=missing[0], text=midi_name(missing[0])))
            if st is not None:
                st.matched_expected = next(iter(played & set(e.pitches)), None)
                st.note_id = e.notes[0].id
            out += self._timing(e.onset, t, e.measure, e.notes[0].id)
            self.matched.append((e.onset, t))
            self.recent_played.append(tuple(sorted(played)))
            self.mismatch_run = 0
            self.cursor += 1
            out += self._finish_pass_if_done(t)
            return out
        # ---- no match ----
        e = self.events[self.cursor]
        prev = self.events[self.cursor - 1] if self.cursor > 0 else None
        if prev is not None and self.matched:
            _, spb = self._expected_time(e.onset)
            prev_len = (e.onset - prev.onset) * spb
            since = t - self.matched[-1][1]
            same = bool(played & set(prev.pitches))
            octave = any((q - p) % 12 == 0 and q != p for q in played for p in prev.pitches)
            # still inside the previous note: a re-articulation / tracker octave slip, not a new note.
            # (repeating the previous note when the next one is due IS reported as a wrong note)
            if (same and since < 0.75 * prev_len) or (octave and since < prev_len + 0.3):
                return out
        self.mismatch_run += 1
        self.recent_played.append(tuple(sorted(played)))
        exp_p = e.pitches[0] if e.pitches else None
        pl = min(played, key=lambda q: abs(q - (exp_p or q))) if played else None
        close = exp_p is not None and pl is not None and abs(pl - exp_p) <= 2
        if self.mode == "wait" or close or self.mismatch_run == 1:
            for n in e.notes:
                self.results.setdefault(n.id, "wrong")
            out += self._emit(FeedbackEvent("wrong_note", round(t, 3), measure=e.measure, note_id=e.notes[0].id,
                                            expected=exp_p, played=pl,
                                            text=midi_name(exp_p) if exp_p is not None else "?"))
            if st is not None:
                st.matched_expected = None
            if self.mode != "wait" and close:
                self.matched.append((e.onset, t))
                self.cursor += 1
                out += self._finish_pass_if_done(t)
            return out
        if self.mismatch_run >= 3:
            self._relocate()
        return out

    def _relocate(self) -> None:
        """Player jumped (restarted a bar, skipped a line): find where the last notes fit best."""
        seq = [p for p in self.recent_played if p][-4:]
        if len(seq) < 3:
            return
        best, best_k = 0, None
        for k in range(len(self.events) - len(seq) + 1):
            score = sum(1 for j, ps in enumerate(seq) if set(ps) & set(self.events[k + j].pitches))
            if score > best:
                best, best_k = score, k
        if best_k is not None and best >= len(seq) - 1:
            self.cursor = best_k + len(seq)
            self.matched.clear()
            self.mismatch_run = 0
            self.log.append(FeedbackEvent("jump", round(self.now, 3),
                                          measure=self.events[min(best_k, len(self.events) - 1)].measure))

    # -------------------------------------------------------------- summary
    def summary(self) -> dict:
        total = sum(len(e.notes) for e in self.events)
        vals = list(self.results.values())
        return {"notes": total, "correct": vals.count("correct"), "wrong": vals.count("wrong"),
                "missed": vals.count("missed"), "passes": self.passes,
                "buzzes": len(self.buzzed), "decisions": len(self.log)}


def simulate(score: Score, audio: np.ndarray, instrument: str, mode: str = "follow", chunk: int = 512,
             **kw) -> LiveFollower:
    """Feed a recording through the live follower in real-time-sized chunks."""
    f = LiveFollower(score, instrument, mode=mode, **kw)
    for i in range(0, len(audio), chunk):
        f.push(audio[i:i + chunk])
    return f
