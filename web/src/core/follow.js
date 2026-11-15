// "Wait for me" practice: the score waits on each note until the player plays it.
// Pure logic (no audio): feed it pitch frames from the microphone (about 45 a second) and it says when a
// note was played right, or when a wrong note was held long enough to be a real mistake.

/** The notes the player should play, one entry per onset: all pitches (a chord counts if any of them is
 *  heard) and the top one (shown as "Play G4"). `match(event)` picks the part/staff being practised. */
export function expectedNotes(perf, match = () => true, range = null) {
  const groups = [];
  let last = null;
  for (const e of perf.events) {
    if (e.unpitched || !match(e)) continue;
    if (range && (e.mi < range.from || e.mi > range.to)) continue;
    if (last && last.t.eq(e.t)) {
      last.midis.push(e.midi);
      last.ids.push(...e.ids);
      if (e.midi > last.top) last.top = e.midi;
      continue;
    }
    last = { t: e.t, mi: e.mi, midis: [e.midi], top: e.midi, ids: [...e.ids], dur: e.dur };
    groups.push(last);
  }
  return groups;
}

export class Follower {
  /**
   * @param expected  from expectedNotes()
   * @param octaveOk  singers may sing an octave away
   * @param stable    frames a pitch must last to count (3 ≈ 70 ms)
   * @param wrong     frames a wrong pitch must last to count as a mistake (6 ≈ 130 ms)
   */
  constructor(expected, { octaveOk = false, stable = 3, wrong = 6, octaveStable = 5, lookahead = 2 } = {}) {
    this.exp = expected;
    this.lookahead = lookahead;      // a note played that is 1-2 notes ahead: the missed ones are skipped (a lost note can't derail the take)
    this.k = 0;
    this.octaveOk = octaveOk;
    this.stable = stable;
    this.wrongN = wrong;
    this.cand = null;
    this.count = 0;
    this.held = null;          // pitch of the note just accepted: it must stop or be re-struck before it counts again
    this.lastRms = 0;
    this.wrongShown = false;
    this.firstTry = expected.map(() => true);
    this.misses = expected.map(() => 0);
    this.wrongs = [];          // [{index, played}]: each mistake, for the report
    this.octaveStable = octaveStable;
    this.peak = 0;             // loudest moment of the note just counted: a dip and a rise again is a new note
    this.dip = Infinity;
    this.ignore = null;        // (midi) => true for pitches the app itself is playing right now
  }

  get done() { return this.k >= this.exp.length; }
  get current() { return this.exp[this.k] || null; }

  matches(exp, m) {
    return exp.midis.some((x) => x === m || (this.octaveOk && (x - m) % 12 === 0));
  }

  /** The microphone often hears a note an octave off (the pitch tracker locks on to a harmonic or half the
   *  frequency): that counts as the right note, after holding it a little longer. */
  octaveOf(exp, m) {
    return !this.matches(exp, m) && exp.midis.some((x) => (x - m) % 12 === 0 && Math.abs(x - m) <= 24);
  }

  /** frame: {midi, rms} or null for silence. Returns {type:'ok'|'wrong', index, played?} or null. */
  push(frame, rmsIfUnclear = 0) {
    if (this.done) return null;
    if (!frame) {
      // silence ends the held note; an unclear moment (a bow change, a breath) only counts as a dip
      if (!rmsIfUnclear || rmsIfUnclear < 0.006) { this.cand = null; this.count = 0; this.held = null; this.lastRms = 0; this.peak = 0; this.dip = Infinity; }
      else if (this.held !== null) this.dip = Math.min(this.dip, rmsIfUnclear);
      return null;
    }
    const m = Math.round(frame.midi);
    const rms = frame.rms ?? 0;
    if (this.ignore && this.ignore(m)) return null;         // the app's own accompaniment, heard by the microphone
    // a new attack on the same pitch (repeated notes): the sound fell well below the note's peak, then rose again
    let reattack = false;
    if (this.held !== null && rms) {
      if (rms > this.peak) this.peak = rms;
      if (rms < this.peak * 0.55) this.dip = Math.min(this.dip, rms);
      if (this.dip < Infinity && rms > Math.max(0.01, this.dip * 1.45)) reattack = true;
      if (!reattack && this.lastRms > 0 && rms > this.lastRms * 1.6 && rms > 0.01) reattack = true;
    }
    this.lastRms = rms || this.lastRms;
    if (this.held !== null) {
      if ((m === this.held || (this.octaveOk && (m - this.held) % 12 === 0)) && !reattack) return null;   // still the note we already counted
      this.held = null;
    }
    if (m !== this.cand) { this.cand = m; this.count = 1; this.wrongShown = false; }
    else this.count++;
    const exp = this.exp[this.k];
    const exact = this.matches(exp, m);
    const octave = !exact && this.octaveOf(exp, m);
    if (exact || octave) {
      const need = exact ? (frame.conf > 0.8 ? Math.max(2, this.stable - 1) : this.stable) : this.octaveStable;
      if (this.count >= need) {
        const index = this.k++;
        this.held = m;
        this.peak = rms; this.dip = Infinity;
        this.cand = null;
        this.count = 0;
        return octave ? { type: 'ok', index, octave: true } : { type: 'ok', index };
      }
      return null;
    }
    // tolerant window: the player is already on a later note (one we missed, e.g. a frame lost to noise). Needs a
    // little longer than a normal match, then counts the skipped notes as missed and carries on from there.
    for (let j = 1; j <= this.lookahead && this.k + j < this.exp.length; j++) {
      if (this.matches(this.exp[this.k + j], m) && !this.matches(this.exp[this.k + j - 1], m) && this.count >= this.stable + 2) {
        for (let i = this.k; i < this.k + j; i++) { this.firstTry[i] = false; this.misses[i]++; }
        const index = this.k + j;
        this.k = index + 1;
        this.held = m; this.peak = rms; this.dip = Infinity; this.cand = null; this.count = 0;
        return { type: 'ok', index, skipped: j };
      }
    }
    if (this.count >= this.wrongN && !this.wrongShown) {
      this.wrongShown = true;
      this.firstTry[this.k] = false;
      this.misses[this.k]++;
      if (this.wrongs.length < 200) this.wrongs.push({ index: this.k, played: m });
      return { type: 'wrong', index: this.k, played: m };
    }
    return null;
  }

  /** Skip the current note (the player can tap to move on). */
  skip() { if (!this.done) { this.firstTry[this.k] = false; this.k++; } }

  /** {accuracy, right, total, bars: Map(mi -> {right, total})} for the notes reached so far. */
  result() {
    const bars = new Map();
    let right = 0;
    const n = Math.min(this.k, this.exp.length);
    for (let i = 0; i < n; i++) {
      const e = this.exp[i];
      const b = bars.get(e.mi) || { right: 0, total: 0 };
      b.total++;
      if (this.firstTry[i]) { b.right++; right++; }
      bars.set(e.mi, b);
    }
    // the first wrong note played for each note missed, in order: what the report lists
    const seen = new Set();
    const wrong = [];
    for (const w of this.wrongs) {
      if (w.index >= n || seen.has(w.index)) continue;
      seen.add(w.index);
      const e = this.exp[w.index];
      wrong.push({ mi: e.mi, want: e.top, wants: e.midis, played: w.played, ids: e.ids });
    }
    return { accuracy: n ? right / n : 0, right, total: n, bars, wrong };
  }
}

/** The bars that went worst (first-try accuracy below `below`), worst first: [{mi, accuracy, missed}]. */
export function trickyBars(bars, below = 0.8, max = 3) {
  return [...bars.entries()]
    .map(([mi, b]) => ({ mi, accuracy: b.total ? b.right / b.total : 1, missed: b.total - b.right }))
    .filter((x) => x.accuracy < below)
    .sort((a, b) => a.accuracy - b.accuracy || a.mi - b.mi)
    .slice(0, max);
}
