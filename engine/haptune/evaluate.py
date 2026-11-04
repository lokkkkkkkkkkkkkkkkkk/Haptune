"""Score-informed evaluation of a practice take.

Pipeline:  audio -> performed notes (transcribe.py) -> event alignment with the
score (dynamic programming, two passes) -> per-note verdicts (correct / wrong /
missed / extra, timing, intonation) -> scores, bar heat-map, trouble spots and
a practice plan.

Design rule: a false "you played it wrong" is worse than a missed mistake, so
uncertain cases are reported as `uncertain` and never counted against the player.
"""
from __future__ import annotations

import math
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field

import numpy as np

from . import dsp
from .instruments import InstrumentProfile, get_profile
from .score import Event, Note, Score, midi_name
from .transcribe import DetectedNote, analyse_poly, transcribe_mono, transcribe_poly, transcribe_rhythm


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------
@dataclass
class NoteResult:
    note_id: str
    measure: int
    beat: float
    expected: int | None
    status: str                    # correct | wrong | missed | uncertain
    played: int | None = None
    played_midi: float | None = None
    time: float | None = None      # performed onset (s)
    expected_time: float | None = None
    timing_ms: float | None = None
    timing: str | None = None      # ok | early | late | very_early | very_late
    cents: float | None = None
    intonation: str | None = None  # ok | slightly_sharp | sharp | slightly_flat | flat


@dataclass
class ExtraNote:
    time: float
    played: int | None
    measure: int


@dataclass
class MeasureSummary:
    index: int
    label: str
    notes: int
    wrong: int = 0
    missed: int = 0
    extra: int = 0
    timing_issues: int = 0
    intonation_issues: int = 0
    score: float = 100.0
    tempo_qpm: float | None = None


@dataclass
class Evaluation:
    instrument: str
    title: str
    duration_sec: float
    notes: list
    extras: list
    measures: list
    scores: dict
    tempo: dict
    tuning_offset_cents: float | None
    trouble_spots: list
    tips: list
    practice_plan: list
    detected: list = field(default_factory=list, repr=False)

    def to_json(self) -> dict:
        d = asdict(self)
        d["detected"] = [{"on": round(n.onset, 3), "off": round(n.offset, 3),
                          "midi": None if n.midi is None else round(n.midi, 3)} for n in self.detected]
        return d


# ---------------------------------------------------------------------------
# Alignment
# ---------------------------------------------------------------------------
@dataclass
class PerfEvent:
    index: int
    onset: float
    notes: list

    @property
    def pitches(self) -> list[int]:
        return sorted({n.pitch for n in self.notes if n.pitch is not None})


def group_events(notes: list[DetectedNote], spread_s: float) -> list[PerfEvent]:
    out: list[PerfEvent] = []
    for n in sorted(notes, key=lambda n: n.onset):
        if out and n.onset - out[-1].notes[0].onset <= spread_s:
            out[-1].notes.append(n)
        else:
            out.append(PerfEvent(len(out), n.onset, [n]))
    return out


def _pitch_cost(a: list[int], b: list[int], rhythm: bool) -> float:
    if rhythm:
        return 0.0
    if not a or not b:
        return 0.9
    if len(a) == 1 and len(b) == 1:
        x, y = a[0], b[0]
        if x == y:
            return 0.0
        d = abs(x - y)
        if d % 12 == 0:
            return 0.35
        return 0.6 if d <= 2 else 0.8
    A, B = set(a), set(b)
    inter = len(A & B)
    octave = sum(1 for x in A - B if any((x - y) % 12 == 0 for y in B - A))
    eff = inter + 0.5 * octave
    return 0.9 * (1.0 - eff / max(len(A), len(B)))


def _dp_align(S: list[Event], P: list[PerfEvent], time_cost, rhythm: bool, band) -> list[tuple]:
    """Edit-distance alignment. time_cost(i, j) -> extra cost; band(i) -> (j_lo, j_hi)."""
    n, m = len(S), len(P)
    INF = 1e18
    DEL, INS = 1.0, 1.0
    D = np.full((n + 1, m + 1), INF)
    bt = np.zeros((n + 1, m + 1), dtype=np.int8)     # 1 diag, 2 up (delete), 3 left (insert)
    D[0, 0] = 0.0
    for j in range(1, m + 1):
        D[0, j] = D[0, j - 1] + INS
        bt[0, j] = 3
    s_p = [e.pitches for e in S]
    p_p = [e.pitches for e in P]
    for i in range(1, n + 1):
        lo, hi = band(i - 1)
        lo, hi = max(0, lo), min(m, hi)
        if lo == 0:
            D[i, 0] = D[i - 1, 0] + DEL
            bt[i, 0] = 2
        for j in range(max(1, lo), hi + 1):
            c_sub = D[i - 1, j - 1] + _pitch_cost(s_p[i - 1], p_p[j - 1], rhythm) + time_cost(i - 1, j - 1)
            c_del = D[i - 1, j] + DEL
            c_ins = D[i, j - 1] + INS
            if c_sub <= c_del and c_sub <= c_ins:
                D[i, j], bt[i, j] = c_sub, 1
            elif c_del <= c_ins:
                D[i, j], bt[i, j] = c_del, 2
            else:
                D[i, j], bt[i, j] = c_ins, 3
    # trailing performed events after the last score event are free (user kept noodling)
    i, j = n, int(np.argmin(D[n, :] + (m - np.arange(m + 1)) * 0.3))
    pairs = [(None, jj) for jj in range(m - 1, j - 1, -1)]
    while i > 0 or j > 0:
        b = bt[i, j]
        if i > 0 and j > 0 and b == 1:
            pairs.append((i - 1, j - 1)); i -= 1; j -= 1
        elif i > 0 and (b == 2 or j == 0):
            pairs.append((i - 1, None)); i -= 1
        else:
            pairs.append((None, j - 1)); j -= 1
    pairs.reverse()
    return pairs


class TempoModel:
    """Robust local mapping score-beat -> performance-seconds from matched events."""

    def __init__(self, beats: np.ndarray, times: np.ndarray, window_beats: float = 4.0):
        order = np.argsort(beats)
        self.b = np.asarray(beats, float)[order]
        self.t = np.asarray(times, float)[order]
        self.w = window_beats
        self.ok = np.ones(self.b.size, dtype=bool)
        if self.b.size >= 4:                      # one round of outlier rejection
            res = self.t - np.array([self._fit(x, exclude=k) for k, x in enumerate(self.b)])
            mad = np.median(np.abs(res - np.median(res))) + 1e-3
            self.ok = np.abs(res) < max(0.25, 6 * mad)

    def _fit(self, beat: float, exclude: int | None = None) -> float:
        b, t = self.b, self.t
        if b.size == 0:
            return float("nan")
        if b.size == 1:
            return float(t[0] + (beat - b[0]) * 0.6)
        mask = getattr(self, "ok", np.ones(b.size, bool)).copy()
        if exclude is not None:
            mask[exclude] = False
        d = np.abs(b - beat)
        w = self.w
        sel = mask & (d <= w)
        while sel.sum() < 4 and w < 64:
            w *= 1.6
            sel = mask & (d <= w)
        if sel.sum() < 2:
            sel = mask
        if sel.sum() < 2:
            return float(np.interp(beat, b, t))
        x, y = b[sel], t[sel]
        wt = (1 - (np.minimum(d[sel] / (w * 1.01), 1.0)) ** 3) ** 3 + 1e-3
        A = np.vstack([np.ones_like(x), x - beat]).T
        Aw = A * wt[:, None]
        coef, *_ = np.linalg.lstsq(Aw.T @ A, Aw.T @ y, rcond=None)
        return float(coef[0])

    def predict(self, beat: float) -> float:
        return self._fit(beat)

    def predict_loo(self, beat: float) -> float:
        k = int(np.argmin(np.abs(self.b - beat))) if self.b.size else None
        if k is not None and abs(self.b[k] - beat) < 1e-6:
            return self._fit(beat, exclude=k)
        return self._fit(beat)

    def sec_per_beat(self, beat: float) -> float:
        return max(1e-3, (self.predict(beat + 0.5) - self.predict(beat - 0.5)))


def align(score: Score, perf_notes: list[DetectedNote], profile: InstrumentProfile):
    S = score.events()
    P = group_events(perf_notes, profile.chord_spread_ms / 1000.0)
    rhythm = profile.mode == "rhythm"
    if not S or not P:
        return S, P, [(i, None) for i in range(len(S))] + [(None, j) for j in range(len(P))], None
    # pass 1: relative position as a soft time prior (whole-piece take at a roughly steady tempo)
    s_t = np.array([score.beat_to_sec(e.onset) for e in S])
    p_t = np.array([e.onset for e in P])
    su = (s_t - s_t[0]) / max(s_t[-1] - s_t[0], 1e-6)
    pu = (p_t - p_t[0]) / max(p_t[-1] - p_t[0], 1e-6)
    pu_sorted = pu

    def band1(i):
        lo = int(np.searchsorted(pu_sorted, su[i] - 0.3))
        hi = int(np.searchsorted(pu_sorted, su[i] + 0.3)) + 1
        return lo, hi

    pairs = _dp_align(S, P, lambda i, j: 2.0 * abs(su[i] - pu[j]), rhythm, band1)
    good = [(i, j) for i, j in pairs if i is not None and j is not None
            and _pitch_cost(S[i].pitches, P[j].pitches, rhythm) < 0.5]
    if len(good) >= 3:
        tm = TempoModel(np.array([S[i].onset for i, _ in good]), np.array([P[j].onset for _, j in good]))
        pred = np.array([tm.predict(e.onset) for e in S])
        spb = np.array([tm.sec_per_beat(e.onset) for e in S])
        tau = np.maximum(0.25, 0.75 * spb)

        def band2(i):
            lo = int(np.searchsorted(p_t, pred[i] - 4.0))
            hi = int(np.searchsorted(p_t, pred[i] + 4.0)) + 1
            return lo, hi

        pairs = _dp_align(S, P, lambda i, j: 0.8 * min(1.0, abs(p_t[j] - pred[i]) / tau[i]), rhythm, band2)
    good = [(i, j) for i, j in pairs if i is not None and j is not None
            and _pitch_cost(S[i].pitches, P[j].pitches, rhythm) < 0.5]
    tm = TempoModel(np.array([S[i].onset for i, _ in good]), np.array([P[j].onset for _, j in good])) if good else None
    return S, P, pairs, tm


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------
def _intonation_label(cents: float, prof: InstrumentProfile) -> str:
    a = abs(cents)
    if a <= prof.cents_ok:
        return "ok"
    side = "sharp" if cents > 0 else "flat"
    return f"slightly_{side}" if a <= prof.cents_warn else side


def evaluate(score: Score, audio: np.ndarray, instrument: str | InstrumentProfile, sr: int = dsp.SR,
             a4: float = 440.0, target_qpm: float | None = None, metronome: bool = False,
             level: str = "intermediate") -> Evaluation:
    """Evaluate one take. `level` (beginner/intermediate/advanced) sets timing tolerance."""
    prof = instrument if isinstance(instrument, InstrumentProfile) else get_profile(instrument)
    poly_analysis = None
    track = None
    if prof.mode == "poly":
        poly_analysis = analyse_poly(audio, prof, sr)
        detected = transcribe_poly(audio, prof, sr, analysis=poly_analysis)
    elif prof.mode == "rhythm":
        detected = transcribe_rhythm(audio, sr)
    else:
        track = dsp.yin(audio, sr=sr, fmin=prof.fmin, fmax=prof.fmax, a4=a4)
        detected = transcribe_mono(audio, prof, sr, a4, track=track)

    S, P, pairs, tm = align(score, detected, prof)
    tol_factor = {"beginner": 1.6, "intermediate": 1.0, "advanced": 0.7}.get(level, 1.0)
    results: dict[str, NoteResult] = {}
    extras: list[ExtraNote] = []
    used_perf_notes: set[int] = set()

    if metronome and target_qpm and tm is not None:
        spb_fixed = 60.0 / target_qpm
        offs = [P[j].onset - S[i].onset * spb_fixed for i, j in pairs if i is not None and j is not None]
        t0 = float(np.median(offs)) if offs else 0.0
        expected_at = lambda b: t0 + b * spb_fixed           # noqa: E731
        spb_at = lambda b: spb_fixed                        # noqa: E731
    elif tm is not None:
        expected_at = tm.predict_loo
        spb_at = tm.sec_per_beat
    else:
        expected_at = lambda b: None                        # noqa: E731
        spb_at = lambda b: 60.0 / score.first_tempo         # noqa: E731

    for si, pj in pairs:
        if si is None:
            ev = P[pj]
            b = score.sec_to_beat(ev.onset)
            if tm is not None and tm.b.size >= 2:
                b = float(np.interp(ev.onset, tm.t, tm.b))
            for n in ev.notes:
                extras.append(ExtraNote(round(n.onset, 3), n.pitch, score.measure_at(b)))
            continue
        sev = S[si]
        if pj is None:
            for n in sev.notes:
                results[n.id] = NoteResult(n.id, n.measure, round(n.onset, 4), n.pitch, "missed")
            continue
        pev = P[pj]
        exp_notes = list(sev.notes)
        perf = list(pev.notes)
        # 1) exact pitch matches
        remaining_exp = []
        for n in exp_notes:
            hit = next((p for p in perf if (p.pitch == n.pitch or prof.mode == "rhythm")), None)
            if hit is not None:
                perf.remove(hit)
                results[n.id] = NoteResult(n.id, n.measure, round(n.onset, 4), n.pitch, "correct",
                                           hit.pitch, hit.midi, round(hit.onset, 4))
            else:
                remaining_exp.append(n)
        # 2) leftovers: wrong notes (closest pitch) / octave confusions / missed
        for n in remaining_exp:
            if perf:
                hit = min(perf, key=lambda p: abs((p.pitch or 0) - (n.pitch or 0)))
                d = abs((hit.pitch or 0) - (n.pitch or 0))
                perf.remove(hit)
                status = "uncertain" if d % 12 == 0 else "wrong"
                results[n.id] = NoteResult(n.id, n.measure, round(n.onset, 4), n.pitch, status,
                                           hit.pitch, hit.midi, round(hit.onset, 4))
            else:
                results[n.id] = NoteResult(n.id, n.measure, round(n.onset, 4), n.pitch, "missed",
                                           time=round(pev.onset, 4))
        for p in perf:
            extras.append(ExtraNote(round(p.onset, 3), p.pitch, sev.measure))

    # 2b) drop "extra" notes that are really artefacts: reverb tails, re-triggers of a neighbour,
    #     very quiet blips. Only confident extras are reported.
    if detected:
        energies = np.array([d.energy for d in detected if d.energy > 0])
        med_e = float(np.median(energies)) if energies.size else 0.0
        det_by_time = {round(d.onset, 3): d for d in detected}
        played_pitches = sorted(((r.time, r.played) for r in results.values()
                                 if r.time is not None and r.played is not None))
        kept = []
        for e in extras:
            d = det_by_time.get(round(e.time, 3))
            if d is not None:
                quiet = med_e > 0 and d.energy < 0.3 * med_e
                short = d.duration < (0.12 if prof.mode != "poly" else 0.06)
                near_same = any(abs(t - e.time) < 0.35 and p == e.played for t, p in played_pitches)
                weak_poly = prof.mode == "poly" and d.confidence < 0.35
                # mono: a split of the note that is still sounding (same pitch or its octave, started
                # shortly before) is a reverb / vibrato artefact, not a new note
                split = False
                if prof.mode == "mono" and e.played is not None:
                    prev = [(t, p) for t, p in played_pitches if t < e.time]
                    if prev:
                        t_prev, p_prev = prev[-1]
                        split = (e.time - t_prev < 0.9 and (e.played - p_prev) % 12 == 0)
                if quiet or weak_poly or split or (short and near_same):
                    continue
            kept.append(e)
        extras = kept

    # 3) rescue pass: is there evidence for "missed" notes that transcription skipped?
    _rescue(score, results, prof, poly_analysis, track, expected_at, a4)

    # timing + intonation per note
    for n in score.playable_notes():
        r = results.get(n.id)
        if r is None:
            continue
        exp_t = expected_at(n.onset)
        if exp_t is not None and not (isinstance(exp_t, float) and math.isnan(exp_t)):
            r.expected_time = round(float(exp_t), 4)
        if r.status in ("correct", "wrong") and r.time is not None and r.expected_time is not None:
            dev = r.time - r.expected_time
            spb = spb_at(n.onset)
            tol = max(0.05, 0.11 * spb) * tol_factor
            r.timing_ms = round(dev * 1000, 1)
            a = abs(dev)
            r.timing = "ok" if a <= tol else (("early" if dev < 0 else "late") if a <= 2.2 * tol
                                             else ("very_early" if dev < 0 else "very_late"))
        if prof.intonation and r.status == "correct" and r.played_midi is not None and n.pitch is not None:
            dur_s = score.beat_to_sec(n.onset + n.duration) - score.beat_to_sec(n.onset)
            if dur_s >= 0.12:
                r.cents = round((r.played_midi - n.pitch) * 100.0, 1)
                r.intonation = _intonation_label(r.cents, prof)

    # notes the chosen instrument cannot play (wrong instrument picked, or an un-transposed part)
    # are never held against the player
    for n in score.playable_notes():
        r = results.get(n.id)
        if r and n.pitch is not None and prof.mode != "rhythm" and not (prof.low <= n.pitch <= prof.high):
            if r.status in ("missed", "wrong"):
                r.status = "uncertain"
    note_list = [results[n.id] for n in score.playable_notes() if n.id in results]
    return _summarise(score, prof, note_list, extras, detected, tm, target_qpm, audio, sr)


def _rescue(score, results, prof, poly_analysis, track, expected_at, a4):
    hop_s = dsp.HOP / dsp.SR
    by_event = defaultdict(list)
    for r in results.values():
        by_event[r.beat].append(r)
    for r in list(results.values()):
        if r.status != "missed" or r.expected is None:
            continue
        t = r.time if r.time is not None else expected_at(r.beat)
        if t is None or (isinstance(t, float) and math.isnan(t)):
            continue
        if poly_analysis is not None:
            pa = poly_analysis
            col = np.flatnonzero(pa.pitches == r.expected)
            if not col.size:
                continue
            f = int(round(t / hop_s))
            post = pa.activations[max(0, f):f + 10]
            if not post.size:
                continue
            ref = post.max() + 1e-12
            val = post[:, col[0]].max()
            pre = pa.activations[max(0, f - 11):max(1, f - 7), col[0]].mean() if f > 7 else 0.0
            siblings = [x for x in by_event[r.beat] if x is not r and x.status == "correct"]
            octave_sib = any(x.expected is not None and (x.expected - r.expected) % 12 == 0 for x in siblings)
            rise = _band_rise(pa, r.expected, f)
            if (val >= 0.18 * ref and val > 1.3 * pre) or rise >= 1.8:
                # NMF can hand a note's energy to a lower note whose overtone it shares (B4 is the
                # 5th harmonic of G2); a clear energy rise at the note's own partials settles it
                r.status, r.played, r.time = "correct", r.expected, round(float(t), 4)
            elif octave_sib and val >= 0.06 * ref:
                r.status = "uncertain"           # octave doubling hidden in the lower note's overtones
        elif track is not None and track.times.size:
            sel = np.flatnonzero(np.abs(track.times - t) <= 0.12)
            if sel.size:
                m = track.midi[sel]
                close = np.abs(m - r.expected) < 0.6
                if np.sum(close) >= 2:
                    k = sel[np.flatnonzero(close)]
                    r.status, r.played = "correct", r.expected
                    r.played_midi = float(np.nanmedian(track.midi[k]))
                    r.time = round(float(track.times[k[0]]), 4)


def _band_rise(pa, pitch: int, f: int) -> float:
    """How much the spectrum at a pitch's first partials grows across an onset (after / before)."""
    if pa.spec is None or pa.centers is None:
        return 0.0
    V, c = pa.spec, pa.centers
    before = V[max(0, f - 11):max(1, f - 6)]
    after = V[f:f + 7]
    if not before.size or not after.size:
        return 0.0
    ratios = []
    for h_semis in (0, 12, 19):
        sel = np.abs(c - (pitch + h_semis)) <= 0.5
        if sel.any():
            b = float(before[:, sel].mean()) + 1e-9
            a = float(after[:, sel].max())
            ratios.append(a / b)
    if not ratios:
        return 0.0
    ratios.sort(reverse=True)
    return ratios[1] if len(ratios) >= 2 else ratios[0]      # at least two partials must rise


# ---------------------------------------------------------------------------
# Summary, tips and practice plan
# ---------------------------------------------------------------------------
_SHARP_KEYS = ["F", "C", "G", "D", "A", "E", "B"]


def _key_accidentals(fifths: int) -> dict[int, int]:
    """pitch class (natural letter) -> alteration from a key signature."""
    letters = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    acc = {}
    if fifths > 0:
        for L in _SHARP_KEYS[:fifths]:
            acc[letters[L]] = +1
    elif fifths < 0:
        for L in list(reversed(_SHARP_KEYS))[:-fifths]:
            acc[letters[L]] = -1
    return acc


VIOLIN_FAMILY = {"violin", "viola", "cello", "double_bass", "erhu"}


def _string_hint(prof: InstrumentProfile, pitch: int) -> str:
    if prof.key not in VIOLIN_FAMILY or not prof.open_strings:
        return ""
    names = {"violin": ["G", "D", "A", "E"], "viola": ["C", "G", "D", "A"], "cello": ["C", "G", "D", "A"],
             "double_bass": ["E", "A", "D", "G"], "erhu": ["inner (D)", "outer (A)"]}[prof.key]
    s = max((k for k, o in enumerate(prof.open_strings) if o <= pitch), default=0)
    semis = pitch - prof.open_strings[s]
    if prof.key == "erhu":
        return f" on the {names[s]} string"
    finger = {0: "open", 1: "low 1st finger", 2: "1st finger", 3: "low 2nd finger", 4: "2nd finger",
              5: "3rd finger", 6: "high 3rd / low 4th finger", 7: "4th finger"}.get(semis, "")
    where = f" ({names[s]} string, {finger} in 1st position)" if finger and semis <= 7 else f" ({names[s]} string)"
    return where


def _summarise(score: Score, prof: InstrumentProfile, notes: list[NoteResult], extras: list[ExtraNote],
               detected, tm, target_qpm, audio, sr) -> Evaluation:
    total = len(notes)
    counts = Counter(r.status for r in notes)
    errors = counts["wrong"] + counts["missed"]
    note_acc = max(0.0, 1.0 - (errors + 0.5 * len(extras)) / max(1, total))
    timed = [r for r in notes if r.timing is not None]
    rhythm = (sum(1 for r in timed if r.timing == "ok") + 0.5 * sum(1 for r in timed if r.timing in ("early", "late"))) / max(1, len(timed))
    judged = [r for r in notes if r.intonation is not None]
    inton = None
    if judged:
        inton = (sum(1 for r in judged if r.intonation == "ok") +
                 0.5 * sum(1 for r in judged if r.intonation.startswith("slightly"))) / len(judged)
    tuning = float(np.median([r.cents for r in judged])) if judged else None

    # tempo
    tempo = {"target_qpm": target_qpm}
    measures: list[MeasureSummary] = []
    bpm_by_measure = {}
    if tm is not None and tm.b.size >= 2:
        for m in score.measures:
            mid = m.start + m.duration / 2
            if tm.b.min() - 1 <= mid <= tm.b.max() + 1:
                bpm_by_measure[m.index] = 60.0 / tm.sec_per_beat(mid)
        vals = np.array(list(bpm_by_measure.values()))
        if vals.size:
            tempo.update({"average_qpm": round(float(np.median(vals)), 1),
                          "min_qpm": round(float(vals.min()), 1), "max_qpm": round(float(vals.max()), 1),
                          "steadiness": round(float(max(0.0, 1 - min(1.0, np.std(vals) / (np.mean(vals) * 0.15)))), 3)})
    for m in score.measures:
        ms = [r for r in notes if r.measure == m.index]
        if not ms:
            continue
        s = MeasureSummary(m.index, m.label, len(ms))
        s.wrong = sum(r.status == "wrong" for r in ms)
        s.missed = sum(r.status == "missed" for r in ms)
        s.extra = sum(e.measure == m.index for e in extras)
        s.timing_issues = sum(r.timing not in (None, "ok") for r in ms)
        s.intonation_issues = sum(r.intonation not in (None, "ok") for r in ms)
        penalty = (s.wrong + s.missed + 0.5 * s.extra) / len(ms) * 70 + \
                  s.timing_issues / len(ms) * 20 + s.intonation_issues / len(ms) * 15
        s.score = round(max(0.0, 100 - penalty), 1)
        s.tempo_qpm = round(bpm_by_measure[m.index], 1) if m.index in bpm_by_measure else None
        measures.append(s)

    weights = {"notes": 0.55, "rhythm": 0.3, "intonation": 0.15 if inton is not None else 0.0}
    tw = sum(weights.values())
    overall = (note_acc * weights["notes"] + rhythm * weights["rhythm"] + (inton or 0) * weights["intonation"]) / tw
    scores = {"overall": round(100 * overall, 1), "notes": round(100 * note_acc, 1),
              "rhythm": round(100 * rhythm, 1), "intonation": None if inton is None else round(100 * inton, 1),
              "counts": {"total": total, "correct": counts["correct"], "wrong": counts["wrong"],
                         "missed": counts["missed"], "uncertain": counts["uncertain"], "extra": len(extras)}}

    trouble = _trouble_spots(measures)
    tips = _tips(score, prof, notes, extras, tuning, tempo, measures, bpm_by_measure)
    plan = _practice_plan(score, trouble, tempo, scores, target_qpm)
    return Evaluation(prof.key, score.title, round(len(audio) / sr, 2), notes, extras, measures, scores, tempo,
                      None if tuning is None else round(tuning, 1), trouble, tips, plan, detected)


def _trouble_spots(measures: list[MeasureSummary]) -> list[dict]:
    bad = [m for m in measures if m.score < 85]
    spots, cur = [], []
    for m in bad:
        if cur and m.index == cur[-1].index + 1:
            cur.append(m)
        else:
            if cur:
                spots.append(cur)
            cur = [m]
    if cur:
        spots.append(cur)
    out = []
    for sp in spots:
        issues = Counter()
        for m in sp:
            issues["wrong notes"] += m.wrong
            issues["missed notes"] += m.missed
            issues["extra notes"] += m.extra
            issues["timing"] += m.timing_issues
            issues["intonation"] += m.intonation_issues
        out.append({"from_measure": sp[0].index, "to_measure": sp[-1].index,
                    "label": sp[0].label if len(sp) == 1 else f"{sp[0].label}-{sp[-1].label}",
                    "score": round(float(np.mean([m.score for m in sp])), 1),
                    "main_issue": issues.most_common(1)[0][0] if issues else "",
                    "issues": {k: v for k, v in issues.items() if v}})
    out.sort(key=lambda x: x["score"])
    return out[:5]


def _tips(score, prof, notes, extras, tuning, tempo, measures, bpm_by_measure) -> list[str]:
    tips: list[str] = []
    label = {m.index: m.label for m in score.measures}
    # wrong-note patterns: key-signature slips, forgotten accidentals, other wrong notes
    conf = Counter()
    other_wrong = defaultdict(list)
    for r in notes:
        if r.status != "wrong" or r.expected is None or r.played is None:
            continue
        fifths, _ = score.key_at(r.beat)
        flats = fifths < 0
        key_acc = _key_accidentals(fifths)               # natural pc -> +1/-1
        altered = {(pc + a) % 12: pc for pc, a in key_acc.items()}
        scale_pcs = {(pc + key_acc.get(pc, 0)) % 12 for pc in (0, 2, 4, 5, 7, 9, 11)}
        e_pc, p_pc = r.expected % 12, r.played % 12
        if abs(r.expected - r.played) == 1 and e_pc in altered and altered[e_pc] == p_pc:
            conf[("key", midi_name(r.expected, flats)[:-1], midi_name(r.played, flats)[:-1])] += 1
        elif abs(r.expected - r.played) == 1 and e_pc not in scale_pcs and p_pc in scale_pcs:
            conf[("acc", midi_name(r.expected, flats), midi_name(r.played, flats))] += 1
        else:
            other_wrong[label[r.measure]].append(f"{midi_name(r.expected, flats)} (you played {midi_name(r.played, flats)})")
    for (kind, exp, played), c in conf.most_common(3):
        if kind == "key":
            tips.append(f"Key signature: you played {played} instead of {exp} {c} time(s). "
                        f"Circle the {exp}s in the key signature before you start.")
        else:
            tips.append(f"Accidental missed: {exp} was played as {played} {c} time(s). "
                        f"An accidental lasts until the end of the bar.")
    if other_wrong:
        items = [f"bar {b}: {', '.join(v[:2])}" for b, v in list(other_wrong.items())[:4]]
        tips.append("Wrong notes - " + "; ".join(items) + ". Play these bars slowly in Wait mode "
                    "(the score waits for the right note).")
    # timing trend
    devs = [r.timing_ms for r in notes if r.timing_ms is not None]
    if devs:
        early = sum(1 for r in notes if r.timing in ("early", "very_early"))
        late = sum(1 for r in notes if r.timing in ("late", "very_late"))
        if early > max(3, 2 * late):
            tips.append("You tend to rush (notes come early). Practise with the Watch's silent haptic metronome "
                        "and feel each beat on your wrist.")
        elif late > max(3, 2 * early):
            tips.append("You tend to drag (notes come late). Look one bar ahead and keep the pulse steady.")
    if bpm_by_measure:
        vals = np.array(list(bpm_by_measure.values()))
        med = float(np.median(vals))
        fast = [k for k, v in bpm_by_measure.items() if v > med * 1.12]
        slow = [k for k, v in bpm_by_measure.items() if v < med * 0.88]
        if fast:
            tips.append(f"Speeding up in bar(s) {', '.join(label[k] for k in sorted(fast)[:5])} "
                        f"(about {100 * (max(bpm_by_measure[k] for k in fast) / med - 1):.0f}% faster than your average).")
        if slow:
            tips.append(f"Slowing down in bar(s) {', '.join(label[k] for k in sorted(slow)[:5])}: "
                        f"these are usually the hardest spots, practise them slowly on their own.")
    # intonation
    if tuning is not None and abs(tuning) >= 8:
        tips.append(f"Overall you are {abs(tuning):.0f} cents {'sharp' if tuning > 0 else 'flat'}: "
                    f"check your tuning (A4 reference) before blaming your fingers.")
    if prof.intonation:
        by_pitch = defaultdict(list)
        for r in notes:
            if r.cents is not None:
                by_pitch[r.expected].append(r.cents - (tuning or 0))
        worst = sorted(((p, float(np.median(v)), len(v)) for p, v in by_pitch.items() if len(v) >= 2),
                       key=lambda x: -abs(x[1]))
        for p, c, k in worst[:2]:
            if abs(c) >= prof.cents_ok:
                tips.append(f"{midi_name(p)} is consistently {abs(c):.0f} cents {'sharp' if c > 0 else 'flat'}"
                            f"{_string_hint(prof, p)} ({k} notes).")
    if extras and len(extras) > 0.08 * max(1, len(notes)):
        tips.append(f"{len(extras)} extra notes: slow down so each note is deliberate, and keep your "
                    f"{'fingers close to the keys' if prof.family == 'keyboard' else 'finger movements small'}.")
    if not tips:
        tips.append("Clean take! Next step: raise the tempo by 5-10% or play it from memory.")
    return tips


def _practice_plan(score, trouble, tempo, scores, target_qpm) -> list[dict]:
    plan = []
    played_qpm = tempo.get("average_qpm") or score.first_tempo
    goal = target_qpm or score.first_tempo
    for t in trouble[:3]:
        start = max(0, t["from_measure"] - 1)
        end = min(len(score.measures) - 1, t["to_measure"] + 1)
        slow = round(min(played_qpm, goal) * (0.7 if t["score"] < 60 else 0.8))
        plan.append({
            "loop_measures": [start, end],
            "loop_label": f"bars {score.measures[start].label}-{score.measures[end].label}",
            "why": t["main_issue"],
            "steps": [
                {"tempo_qpm": slow, "goal": "3 clean passes in a row (Wait mode: the score waits for you)"},
                {"tempo_qpm": round((slow + goal) / 2), "goal": "3 clean passes with the haptic metronome"},
                {"tempo_qpm": round(goal), "goal": "2 clean passes at full tempo, then play from 2 bars earlier"},
            ]})
    if not plan:
        plan.append({"loop_measures": [0, len(score.measures) - 1], "loop_label": "whole piece",
                     "why": "polish", "steps": [{"tempo_qpm": round(goal * 1.05), "goal": "play it 5% faster"}]})
    return plan
