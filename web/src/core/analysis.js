// Musical analysis: key finding, chord suggestions for pieces without chord symbols, difficulty,
// and the best key for a singer's range.
import { q, ZERO } from './q.js';
import { mod, majorTonic, transposeInterval, transposeKey, transposeName, iv, keyName, tonicOf, pc, midiOf, transposePitch } from './pitch.js';
import { parseChord, chordPcs, rootPc, romanNumeral, diatonicChords, formatChord, isDiatonic } from './chords.js';

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a, b) {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Key signature (fifths) for a tonic pitch class and mode, choosing the simpler spelling. */
export function keyForTonicPc(tonicPc, mode = 'major') {
  const off = mode === 'minor' ? -3 : 0;
  let best = null;
  for (let f = -7; f <= 7; f++) {
    const t = mode === 'minor' ? mod(7 * f + 9, 12) : mod(7 * f, 12);
    if (t !== tonicPc) continue;
    if (best === null || Math.abs(f) < Math.abs(best)) best = f;
  }
  void off;
  return { fifths: best ?? 0, mode };
}

/** Krumhansl–Kessler key from notes [{midi, dur}] (dur in any unit). */
export function estimateKeyFromNotes(notes, { bassLast = null } = {}) {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[mod(n.midi, 12)] += Math.max(0.05, n.dur || 1);
  let best = null;
  for (let t = 0; t < 12; t++) {
    for (const mode of ['major', 'minor']) {
      const prof = mode === 'major' ? KK_MAJOR : KK_MINOR;
      const rotated = prof.map((_, i) => prof[mod(i - t, 12)]);
      let r = corr(hist, rotated);
      if (bassLast !== null && mod(bassLast, 12) === t) r += 0.08;
      if (!best || r > best.r) best = { t, mode, r };
    }
  }
  if (!best) return { fifths: 0, mode: 'major' };
  return { ...keyForTonicPc(best.t, best.mode), confidence: Math.max(0, Math.min(1, best.r)) };
}

/** Key from a list of chords (chord sheets): diatonic fit, tonic and dominant weight, first/last chord. */
export function estimateKeyFromChords(chords) {
  const list = chords.filter((c) => c && !c.nc);
  if (!list.length) return { fifths: 0, mode: 'major', confidence: 0 };
  let best = null;
  for (let f = -6; f <= 7; f++) {
    for (const mode of ['major', 'minor']) {
      const key = { fifths: f, mode };
      const tonic = tonicOf(key);
      const tpc = pc(tonic.step, tonic.alter);
      let s = 0;
      for (const c of list) {
        if (isDiatonic(c, key)) s += 1;
        else s -= 0.6;
        const r = rootPc(c);
        const minorish = ['min', 'm7', 'm6', 'm9', 'madd9'].includes(c.quality);
        if (r === tpc && (mode === 'minor') === minorish) s += 1.2;
        if (r === mod(tpc + 7, 12) && !minorish) s += 0.6;
      }
      const first = list[0], last = list[list.length - 1];
      const fm = ['min', 'm7', 'm6', 'm9'].includes(first.quality), lm = ['min', 'm7', 'm6', 'm9'].includes(last.quality);
      if (rootPc(first) === tpc && (mode === 'minor') === fm) s += 2;
      if (rootPc(last) === tpc && (mode === 'minor') === lm) s += 3;
      // prefer the simpler signature when equal
      s -= Math.abs(f) * 0.01;
      if (!best || s > best.s) best = { key, s };
    }
  }
  return { ...best.key, confidence: Math.max(0, Math.min(1, best.s / (list.length * 1.5 + 5))) };
}

/** Concert-pitch notes of a score as [{midi, dur, t}] (t, dur in quarters as numbers). */
export function scoreNotes(score) {
  const out = [];
  score.parts.forEach((part) => part.measures.forEach((pm, mi) => {
    const start = score.measures[mi].start;
    for (const n of pm.notes) {
      if (n.rest || !n.pitch || n.cue || n.grace) continue;
      const p = part.transpose ? transposePitch(n.pitch, part.transpose) : n.pitch;
      out.push({ midi: midiOf(p), dur: n.dur.num(), t: start.add(n.off).num(), mi, staff: n.staff, part });
    }
  }));
  return out;
}

export function estimateKey(score) {
  const notes = scoreNotes(score);
  if (!notes.length) return { fifths: 0, mode: 'major', confidence: 0 };
  const lastT = Math.max(...notes.map((n) => n.t));
  const bassLast = Math.min(...notes.filter((n) => n.t >= lastT - 0.01).map((n) => n.midi));
  return estimateKeyFromNotes(notes, { bassLast });
}

// ---------- chord suggestions (harmonisation) ----------

/**
 * Suggests chord symbols for a score that has none: one or two chords per bar, chosen by the notes
 * sounding in each half bar, the bass, the key and smooth progressions (Viterbi).
 * Returns [{mi, off: Q, chord}] in concert pitch.
 */
export function suggestChords(score, key) {
  const notes = scoreNotes(score);
  if (!notes.length) return [];
  const k = key || estimateKey(score);
  const tonic = tonicOf(k);
  const tpc = pc(tonic.step, tonic.alter);
  // candidates: diatonic triads and sevenths, V7, secondary dominants, borrowed iv and bVII
  const cands = [];
  const add = (c) => { const n = formatChord(c, { ascii: true }); if (!cands.some((x) => x.name === n)) cands.push({ name: n, chord: c, pcs: chordPcs(c), root: rootPc(c), diatonic: isDiatonic(c, k) }); };
  for (const c of diatonicChords(k)) add(c);
  const dia = diatonicChords(k);
  add({ root: dia[4].root, quality: '7' });
  if (k.mode === 'minor') add({ root: dia[4].root, quality: 'maj' });
  for (const d of [1, 2, 5]) add({ root: shiftName(dia[d].root, 7), quality: 'maj' });
  if (k.mode !== 'minor') { add({ root: dia[3].root, quality: 'min' }); add({ root: shiftName(tonic, 10), quality: 'maj' }); }
  // segments: half bars in 4/4 and 2/2, whole bars otherwise
  const segs = [];
  score.measures.forEach((m, mi) => {
    const time = timeAtIndex(score, mi);
    const split = m.dur.ge(q(4)) && time.beats % 2 === 0 && !(time.beatType === 8);
    const parts = split ? [ZERO, m.dur.div(2)] : [ZERO];
    parts.forEach((off, i) => {
      const end = i + 1 < parts.length ? parts[i + 1] : m.dur;
      segs.push({ mi, off, t0: m.start.add(off).num(), t1: m.start.add(end).num(), w: new Array(12).fill(0), bass: null, total: 0 });
    });
  });
  for (const n of notes) {
    const nEnd = n.t + n.dur;
    for (const s of segs) {
      if (nEnd <= s.t0 || n.t >= s.t1) continue;
      const overlap = Math.min(nEnd, s.t1) - Math.max(n.t, s.t0);
      const strong = Math.abs(n.t - s.t0) < 1e-6 ? 1.6 : 1;
      s.w[mod(n.midi, 12)] += overlap * strong;
      s.total += overlap * strong;
      if (n.t <= s.t0 + 0.26 && (s.bass === null || n.midi < s.bass)) s.bass = n.midi;
    }
  }
  const emit = (s, c) => {
    if (s.total <= 0) return 0;
    let inside = 0;
    for (const p of c.pcs) inside += s.w[p];
    const outside = s.total - inside;
    let sc = (inside - 0.75 * outside) / s.total;
    if (s.bass !== null && mod(s.bass, 12) === c.root) sc += 0.25;
    else if (s.bass !== null && c.pcs.includes(mod(s.bass, 12))) sc += 0.08;
    if (c.diatonic) sc += 0.12;
    if (c.chord.quality === '7' && s.w[mod(c.root + 10, 12)] < 0.2 * s.total) sc -= 0.2;
    return sc;
  };
  const trans = (a, b) => {
    if (a === b) return 0.18;
    const ra = cands[a].root, rb = cands[b].root;
    const fifthDown = mod(ra - rb, 12) === 7;
    let s = fifthDown ? 0.12 : 0;
    if (rb === tpc && mod(ra - tpc, 12) === 7) s += 0.1; // V -> I
    return s;
  };
  // Viterbi; empty segments keep the previous chord
  const n = segs.length, C = cands.length;
  const dp = Array.from({ length: n }, () => new Array(C).fill(-Infinity));
  const back = Array.from({ length: n }, () => new Array(C).fill(0));
  for (let c = 0; c < C; c++) dp[0][c] = emit(segs[0], cands[c]) + (cands[c].root === tpc ? 0.2 : 0);
  for (let i = 1; i < n; i++) {
    const halfBar = !segs[i].off.isZero();
    for (let c = 0; c < C; c++) {
      let best = -Infinity, arg = 0;
      for (let p = 0; p < C; p++) {
        const v = dp[i - 1][p] + trans(p, c) - (halfBar && p !== c ? 0.15 : 0);
        if (v > best) { best = v; arg = p; }
      }
      dp[i][c] = best + (segs[i].total > 0 ? emit(segs[i], cands[c]) : (c === arg ? 0.01 : -0.05));
      back[i][c] = arg;
    }
  }
  let cur = 0;
  for (let c = 1; c < C; c++) if (dp[n - 1][c] > dp[n - 1][cur]) cur = c;
  const path = new Array(n);
  for (let i = n - 1; i >= 0; i--) { path[i] = cur; cur = back[i][cur]; }
  // the last chord of a piece is nearly always the tonic when the melody allows
  const out = [];
  let prev = -1;
  segs.forEach((s, i) => {
    if (path[i] === prev) return;
    prev = path[i];
    out.push({ mi: s.mi, off: s.off, chord: cands[path[i]].chord });
  });
  return out;
}

function shiftName(n, semis) {
  const table = { 7: iv(4, 7), 10: iv(6, 10), 5: iv(3, 5), 2: iv(1, 2) };
  return transposeName(n, table[semis] || iv(0, semis));
}

function timeAtIndex(score, mi) {
  for (let i = mi; i >= 0; i--) if (score.measures[i]?.time) return score.measures[i].time;
  return { beats: 4, beatType: 4 };
}

// ---------- difficulty ----------

/** 1 (easy) .. 5 (hard), from speed, density, range, accidentals and rhythm. */
export function difficulty(score, partIndex = 0) {
  const part = score.parts[partIndex];
  if (!part) return 1;
  let notes = 0, acc = 0, short = 0, tuplets = 0, leaps = 0, lo = 127, hi = 0, prev = null, chords = 0;
  part.measures.forEach((pm) => {
    for (const n of pm.notes) {
      if (n.rest || !n.pitch) continue;
      notes++;
      if (n.chord) chords++;
      if (n.pitch.alter) acc++;
      if (n.dur.lt(q(1, 2))) short++;
      if (n.tm) tuplets++;
      const m = midiOf(n.pitch);
      lo = Math.min(lo, m); hi = Math.max(hi, m);
      if (prev !== null && Math.abs(m - prev) > 7) leaps++;
      prev = m;
    }
  });
  if (!notes) return 1;
  const tempo = score.measures[0]?.tempo || 100;
  const lengthQ = score.measures.reduce((s, m) => s + m.dur.num(), 0);
  const seconds = lengthQ * 60 / tempo;
  const density = notes / Math.max(1, seconds);
  let d = 1;
  d += Math.min(1.5, density / 3);
  d += Math.min(1, (hi - lo) / 24);
  d += Math.min(0.8, acc / notes * 3);
  d += Math.min(0.6, short / notes * 2);
  d += Math.min(0.4, tuplets / notes * 4);
  d += Math.min(0.4, leaps / notes * 3);
  d += Math.min(0.6, chords / notes * 1.5);
  return Math.max(1, Math.min(5, Math.round(d)));
}

// ---------- best key for a voice ----------

/**
 * Transpositions that put a melody range [lo, hi] inside the singer's range [vLo, vHi].
 * Returns options sorted best first: {semis, key, fits, over, under}.
 */
export function bestKeys(melody, voice, key) {
  const opts = [];
  for (let s = -7; s <= 7; s++) {
    const lo = melody.lo + s, hi = melody.hi + s;
    const under = Math.max(0, voice.lo - lo), over = Math.max(0, hi - voice.hi);
    const centre = Math.abs((lo + hi) / 2 - (voice.lo + voice.hi) / 2);
    const k = key ? keyAfter(key, s) : null;
    const accidentals = k ? Math.abs(k.fifths) : 0;
    const score = (under + over) * 10 + centre * 0.6 + Math.abs(s) * 0.15 + accidentals * 0.1;
    opts.push({ semis: s, key: k, fits: under + over === 0, over, under, score });
  }
  return opts.sort((a, b) => a.score - b.score);
}

function keyAfter(key, s) {
  return transposeKey(key, transposeInterval(key, s));
}

export const VOICE_RANGES = {
  soprano: { lo: 60, hi: 79 }, mezzo: { lo: 57, hi: 76 }, alto: { lo: 53, hi: 72 },
  tenor: { lo: 48, hi: 67 }, baritone: { lo: 45, hi: 64 }, bass: { lo: 40, hi: 60 },
};

export { keyName, romanNumeral, majorTonic, parseChord };
