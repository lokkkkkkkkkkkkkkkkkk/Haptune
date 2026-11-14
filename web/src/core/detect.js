// Note detection that copes with a real room: pure code (no browser APIs), used by Play Along through ui/audio.js
// and measured offline by tools/noise-corpus.mjs on takes mixed with café, TV and traffic noise.
//
// Per frame (2048 samples, about 45 a second):
//   1. the room is learned first: one second of "silence" before each take gives a noise floor and a noise
//      spectrum (calibrate / finishCalibration);
//   2. spectral subtraction: the frame's spectrum minus the room's, with a floor (so no "musical noise"), and
//      everything below 70 Hz (rumble, traffic, air conditioning) and above 5 kHz dropped;
//   3. YIN on the cleaned frame, with a gate that follows the room instead of a fixed level;
//   4. onsets from spectral flux, so a re-struck note is a new note;
//   5. a short median over the last frames, so one bad frame does not flip the note;
//   6. octave correction against the note that is expected (the tracker often locks on to the 2nd harmonic or
//      half the frequency);
//   7. a 12-bin chroma for piano chords (the expected chord's notes are looked for in it).
// A tolerant follower (follow.js TolerantFollower) then matches notes against the score.

const TAU = 2 * Math.PI;

/** In-place radix-2 FFT (re, im: Float64Array of the same power-of-two length). inverse = true for the IFFT. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? TAU : -TAU) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** YIN fundamental frequency (de Cheveigné & Kawahara). {freq, clarity} or null. No level gate here. */
export function yinCore(buf, sr, { fmin = 60, fmax = 1600, threshold = 0.15 } = {}) {
  const n = buf.length;
  const tauMin = Math.max(2, Math.floor(sr / fmax)), tauMax = Math.min(Math.floor(sr / fmin), Math.floor(n / 2));
  const d = new Float64Array(tauMax + 2);
  const W = n - tauMax;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const x = buf[i] - buf[i + tau]; s += x * x; }
    d[tau] = s;
  }
  let running = 0;
  const cmnd = new Float64Array(tauMax + 2).fill(1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = running ? d[tau] * (tau - tauMin + 1) / running : 1;
  }
  let tau = -1;
  for (let t = tauMin + 1; t < tauMax; t++) {
    if (cmnd[t] < threshold) { while (t + 1 < tauMax && cmnd[t + 1] < cmnd[t]) t++; tau = t; break; }
  }
  if (tau < 0) {                                   // no dip under the threshold: take the deepest one if it is clear enough
    let best = tauMin + 1;
    for (let t = tauMin + 1; t < tauMax; t++) if (cmnd[t] < cmnd[best]) best = t;
    if (cmnd[best] > 0.35) return null;
    tau = best;
  }
  const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1] ?? b;
  const den = a - 2 * b + c;
  const shift = den ? Math.max(-1, Math.min(1, (a - c) / (2 * den))) : 0;
  return { freq: sr / (tau + shift), clarity: 1 - b };
}

export const rmsOf = (buf) => { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); };

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[a.length >> 1]; };

/**
 * Corrects an octave (or twelfth) error against the expected notes: a pitch 12, 19 or 24 semitones from an
 * expected note (within 0.6) is that note. Returns the corrected midi (fractional) or the input.
 */
export function correctOctave(midi, expected = []) {
  for (const e of expected) {
    for (const k of [12, -12, 24, -24, 19, -19]) if (Math.abs(midi - (e + k)) < 0.6) return midi - k;
  }
  return midi;
}

/** 12-bin pitch-class profile of a magnitude spectrum (bins 70 Hz - 5 kHz), normalised to a maximum of 1. */
export function chroma(mag, sr, n) {
  const out = new Float64Array(12);
  for (let k = 1; k < mag.length; k++) {
    const f = (k * sr) / n;
    if (f < 70 || f > 5000) continue;
    const m = 69 + 12 * Math.log2(f / 440);
    const pc = ((Math.round(m) % 12) + 12) % 12;
    out[pc] += mag[k] * mag[k];
  }
  const mx = Math.max(...out) || 1;
  for (let i = 0; i < 12; i++) out[i] /= mx;
  return out;
}

/** How well a chroma shows a chord: the mean energy of its pitch classes minus the mean of the others (−1..1). */
export function chordMatch(ch, midis) {
  const want = new Set(midis.map((m) => ((m % 12) + 12) % 12));
  let a = 0, b = 0;
  for (let i = 0; i < 12; i++) { if (want.has(i)) a += ch[i]; else b += ch[i]; }
  return a / want.size - b / (12 - want.size);
}

export class Detector {
  /**
   * @param sr         sample rate of the frames
   * @param size       frame length (power of two)
   * @param overSub    how much of the room's spectrum to take away (1 = exactly, more = more aggressive)
   * @param floor      what is left of a bin at least (as a share of its original magnitude)
   * @param medianN    frames in the pitch median
   */
  constructor({ sr = 44100, size = 2048, overSub = 1.6, floor = 0.06, medianN = 5, fmin = 60, fmax = 1600 } = {}) {
    Object.assign(this, { sr, size, overSub, floor, medianN, fmin, fmax });
    this.win = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((TAU * i) / (size - 1)));
    this.noiseMag = null;            // the room, per bin
    this.noiseRms = 0;
    this.cal = null;                 // collecting the room
    this.recent = [];                // last raw midi estimates (null for no pitch)
    this.prevMag = null;
    this.fluxAvg = 0;
    this.expect = [];                // midis expected now (set by the follower): octave correction and chords
    this.lo = Math.ceil((70 * size) / sr);
    this.hi = Math.min(size / 2, Math.floor((5000 * size) / sr));
  }

  // ---- the room ----
  startCalibration() { this.cal = { mag: new Float64Array(this.size / 2 + 1), rms: [], n: 0 }; }
  get calibrating() { return !!this.cal; }
  calibrate(frame) {
    if (!this.cal) this.startCalibration();
    const { mag } = this.spectrum(frame);
    for (let k = 0; k < mag.length; k++) this.cal.mag[k] += mag[k];
    this.cal.rms.push(rmsOf(frame));
    this.cal.n++;
  }
  finishCalibration() {
    const c = this.cal;
    this.cal = null;
    if (!c || !c.n) return { noiseRms: this.noiseRms };
    this.noiseMag = c.mag.map((x) => x / c.n);
    // the room's level: a high percentile (passing sounds count), not the quietest moment
    const sorted = [...c.rms].sort((a, b) => a - b);
    this.noiseRms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8))] || 0;
    return { noiseRms: this.noiseRms, db: this.noiseRms ? Math.round(20 * Math.log10(this.noiseRms)) : -120 };
  }

  spectrum(frame) {
    const n = this.size;
    const re = new Float64Array(n), im = new Float64Array(n);
    const off = Math.max(0, frame.length - n);
    for (let i = 0; i < n; i++) re[i] = (frame[off + i] || 0) * this.win[i];
    fft(re, im);
    const mag = new Float64Array(n / 2 + 1);
    for (let k = 0; k <= n / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    return { re, im, mag };
  }

  /** The frame with the room taken out (and rumble below 70 Hz): spectral subtraction, then back to samples. */
  clean(frame) {
    const n = this.size;
    const { re, im, mag } = this.spectrum(frame);
    const outMag = new Float64Array(mag.length);
    for (let k = 0; k <= n / 2; k++) {
      let g = 0;
      if (k >= this.lo && k <= this.hi) {
        const nm = this.noiseMag ? this.noiseMag[k] * this.overSub : 0;
        const m = mag[k];
        g = m > 0 ? Math.max(this.floor, (m - nm) / m) : 0;
      }
      re[k] *= g; im[k] *= g; outMag[k] = mag[k] * g;
      if (k && k < n / 2) { re[n - k] = re[k]; im[n - k] = -im[k]; }
    }
    fft(re, im, true);
    // undo the window in the middle of the frame, where it is large enough to divide by
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = this.win[i] > 0.15 ? re[i] / this.win[i] : 0;
    const a = Math.floor(n * 0.08), b = Math.ceil(n * 0.92);
    return { samples: out.subarray(a, b), mag: outMag };
  }

  /**
   * One frame -> {midi, freq, clarity, rms, onset, conf, chord?} or null (no clear pitch). `rms` is the raw level
   * (what the follower uses to hear re-attacks).
   */
  process(frame) {
    const raw = rmsOf(frame.length > this.size ? frame.subarray(frame.length - this.size) : frame);
    // the gate follows the room: a little above its level, never below a sensible minimum
    const gate = Math.max(0.0035, this.noiseRms * 1.25);
    const { samples, mag } = this.clean(frame);
    // onsets: how much the cleaned spectrum grew since the last frame
    let flux = 0;
    if (this.prevMag) for (let k = this.lo; k <= this.hi; k++) { const d = mag[k] - this.prevMag[k]; if (d > 0) flux += d; }
    this.prevMag = mag;
    const onset = flux > this.fluxAvg * 2.2 && flux > 0.5;
    this.fluxAvg = this.fluxAvg * 0.85 + flux * 0.15;
    if (raw < gate) { this.recent.push(null); this.trim(); return null; }
    const clean = rmsOf(samples);
    const y = clean > 1e-5 ? yinCore(samples, this.sr, { fmin: this.fmin, fmax: this.fmax }) : null;
    let midi = y && y.clarity > 0.6 ? 69 + 12 * Math.log2(y.freq / 440) : null;
    if (midi !== null && this.expect.length) midi = correctOctave(midi, this.expect);
    this.recent.push(midi);
    this.trim();
    let chord = null;
    if (this.expect.length > 1) {
      const ch = chroma(mag, this.sr, this.size);
      chord = chordMatch(ch, this.expect);
    }
    // the median of the last frames that had a pitch (one wrong frame cannot flip the note)
    const have = this.recent.filter((x) => x !== null);
    if (midi === null) {
      if (chord !== null && chord > 0.35) return { midi: this.expect[this.expect.length - 1], freq: 0, clarity: 0, rms: raw, onset, conf: chord, chord };
      return null;
    }
    const med = have.length >= 3 ? median(have.slice(-this.medianN)) : midi;
    // after an onset the newest frame wins (a new note must not wait for the median to catch up)
    const use = onset || Math.abs(midi - med) < 0.5 ? midi : med;
    const conf = Math.min(1, (y.clarity - 0.6) / 0.35) * Math.min(1, raw / (gate * 3));
    return { midi: use, freq: 440 * 2 ** ((use - 69) / 12), clarity: y.clarity, rms: raw, onset, conf, chord };
  }

  trim() { while (this.recent.length > this.medianN) this.recent.shift(); }
}

/** The old detector (fixed level gate, no room model), kept to compare against in tools/noise-corpus.mjs. */
export function legacyDetect(frame, sr) {
  const n = frame.length;
  let r = 0;
  for (let i = 0; i < n; i++) r += frame[i] * frame[i];
  r = Math.sqrt(r / n);
  if (r < 0.008) return null;
  const y = yinCore(frame, sr);
  if (!y || y.clarity <= 0.78) return null;
  return { midi: 69 + 12 * Math.log2(y.freq / 440), rms: r };
}
