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
  constructor(expected, { octaveOk = false, stable = 3, wrong = 6 } = {}) {
    this.exp = expected;
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
  }

  get done() { return this.k >= this.exp.length; }
  get current() { return this.exp[this.k] || null; }

  matches(exp, m) {
    return exp.midis.some((x) => x === m || (this.octaveOk && (x - m) % 12 === 0));
  }

  /** frame: {midi, rms} or null for silence. Returns {type:'ok'|'wrong', index, played?} or null. */
  push(frame) {
    if (this.done) return null;
    if (!frame) { this.cand = null; this.count = 0; this.held = null; this.lastRms = 0; return null; }
    const m = Math.round(frame.midi);
    const reattack = frame.rms !== undefined && this.lastRms > 0 && frame.rms > this.lastRms * 1.6 && frame.rms > 0.01;
    this.lastRms = frame.rms ?? this.lastRms;
    if (this.held !== null) {
      if (m === this.held && !reattack) return null;      // still the note we already counted
      this.held = null;
    }
    if (m !== this.cand) { this.cand = m; this.count = 1; this.wrongShown = false; }
    else this.count++;
    const exp = this.exp[this.k];
    if (this.matches(exp, m)) {
      if (this.count >= this.stable) {
        const index = this.k++;
        this.held = m;
        this.cand = null;
        this.count = 0;
        return { type: 'ok', index };
      }
      return null;
    }
    if (this.count >= this.wrongN && !this.wrongShown) {
      this.wrongShown = true;
      this.firstTry[this.k] = false;
      this.misses[this.k]++;
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
    return { accuracy: n ? right / n : 0, right, total: n, bars };
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
