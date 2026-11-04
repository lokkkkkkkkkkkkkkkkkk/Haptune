// Pitch spelling, intervals, key signatures and exact transposition.
// A pitch is {step: 'C'..'B', alter: -2..2, octave: int}; written spelling is always kept, so
// transposing never turns a D# into an Eb by accident.

export const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
export const STEP_PC = [0, 2, 4, 5, 7, 9, 11];
const STEP_FIFTHS = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, F: -1 };
/** Key signature of a mode = signature of the major key on the same tonic + offset. */
export const MODE_OFFSET = { major: 0, ionian: 0, minor: -3, aeolian: -3, dorian: -2, phrygian: -4, lydian: 1, mixolydian: -1, locrian: -5 };

export const stepIndex = (s) => STEPS.indexOf(s);
export const mod = (a, n) => ((a % n) + n) % n;

export function pc(step, alter = 0) { return mod(STEP_PC[stepIndex(step)] + alter, 12); }

export function midiOf(p) {
  return (p.octave + 1) * 12 + STEP_PC[stepIndex(p.step)] + (p.alter || 0);
}

export function freqOf(midi, a4 = 440) { return a4 * Math.pow(2, (midi - 69) / 12); }
export function midiOfFreq(f, a4 = 440) { return 69 + 12 * Math.log2(f / a4); }

/** Interval as {d: diatonic steps, c: semitones}; both signed. */
export const iv = (d, c) => ({ d, c });

export function transposePitch(p, interval) {
  const si = stepIndex(p.step) + interval.d;
  const step = STEPS[mod(si, 7)];
  const octave = p.octave + Math.floor(si / 7);
  const natural = (octave + 1) * 12 + STEP_PC[stepIndex(step)];
  const alter = midiOf(p) + interval.c - natural;
  return { step, alter, octave };
}

/** Transposes a note name {step, alter} (no octave). */
export function transposeName(n, interval) {
  const p = transposePitch({ step: n.step, alter: n.alter || 0, octave: 4 }, interval);
  return { step: p.step, alter: p.alter };
}

/** Interval from a to b (spelled pitches with octaves). */
export function intervalBetween(a, b) {
  const d = (b.octave * 7 + stepIndex(b.step)) - (a.octave * 7 + stepIndex(a.step));
  return iv(d, midiOf(b) - midiOf(a));
}

export function negate(i) { return iv(-i.d, -i.c); }

// ---- names ----

const ACC_TEXT = { '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' };
const ACC_ASCII = { '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: '##' };

export function nameOf(n, { ascii = false } = {}) {
  return n.step + (ascii ? ACC_ASCII[n.alter || 0] : ACC_TEXT[n.alter || 0]);
}

export function pitchName(p, opts) { return nameOf(p, opts) + p.octave; }

export function parseName(s) {
  const m = /^([A-Ga-g])(##|bb|x|#|b|♯|♭|𝄪|𝄫)?(-?\d+)?$/.exec(String(s).trim());
  if (!m) return null;
  const alter = { '#': 1, '♯': 1, '##': 2, x: 2, '𝄪': 2, b: -1, '♭': -1, bb: -2, '𝄫': -2 }[m[2]] || 0;
  const out = { step: m[1].toUpperCase(), alter };
  if (m[3] !== undefined) out.octave = Number(m[3]);
  return out;
}

function withOctave(n, midi) {
  for (let o = Math.floor(midi / 12) - 2; o <= Math.floor(midi / 12) + 1; o++) {
    const p = { step: n.step, alter: n.alter, octave: o };
    if (midiOf(p) === midi) return p;
  }
  return { step: n.step, alter: n.alter, octave: Math.floor(midi / 12) - 1 };
}

/** Spelling for a MIDI number in a key: the key's own notes first, then sharps (sharp keys) or flats. */
export function spellMidi(midi, fifths = 0) {
  const p = mod(midi, 12);
  for (const n of majorScale(fifths)) {
    if (pc(n.step, n.alter) === p) return withOctave(n, midi);
  }
  const sharp = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
  const flat = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];
  const [step, alter] = (fifths < 0 ? flat : sharp)[p];
  return withOctave({ step, alter }, midi);
}

// ---- keys ----

function nameFromFifths(fifths, stepOffset, pcOffset) {
  const step = STEPS[mod(4 * fifths + stepOffset, 7)];
  let a = mod(7 * fifths + pcOffset, 12) - STEP_PC[stepIndex(step)];
  if (a > 6) a -= 12;
  if (a < -6) a += 12;
  return { step, alter: a };
}

/** Major tonic of a key signature (fifths -7..7). */
export function majorTonic(fifths) { return nameFromFifths(fifths, 0, 0); }

export function fifthsOfMajorTonic(n) { return STEP_FIFTHS[n.step] + 7 * (n.alter || 0); }

/** Tonic of a key {fifths, mode}. */
export function tonicOf(key) {
  const off = MODE_OFFSET[key.mode || 'major'] ?? 0;
  return majorTonic(key.fifths - off);
}

export function keyOfTonic(tonic, mode = 'major') {
  return { fifths: fifthsOfMajorTonic(tonic) + (MODE_OFFSET[mode] ?? 0), mode };
}

export function keyName(key, { ascii = false, long = false } = {}) {
  const t = tonicOf(key);
  const mode = key.mode || 'major';
  if (long) return `${nameOf(t, { ascii })} ${mode}`;
  return nameOf(t, { ascii }) + (mode === 'major' || mode === 'ionian' ? '' : mode === 'minor' || mode === 'aeolian' ? 'm' : ' ' + mode);
}

/** Major scale names of a key signature, from the major tonic. */
export function majorScale(fifths) {
  const t = majorTonic(fifths);
  return [0, 2, 4, 5, 7, 9, 11].map((c, i) => transposeName(t, iv(i, c)));
}

/** Seven scale names of any mode from its tonic. */
export function modeScale(key) {
  const t = tonicOf(key);
  const steps = {
    major: [0, 2, 4, 5, 7, 9, 11], ionian: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], aeolian: [0, 2, 3, 5, 7, 8, 10],
    dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10], locrian: [0, 1, 3, 5, 6, 8, 10],
  }[key.mode || 'major'];
  return steps.map((c, i) => transposeName(t, iv(i, c)));
}

/** Key-signature alteration of a step: +1 for F in G major, etc. */
export function keyAlter(fifths, step) {
  const sharps = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const flats = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  if (fifths > 0) return sharps.slice(0, fifths).includes(step) ? 1 : 0;
  if (fifths < 0) return flats.slice(0, -fifths).includes(step) ? -1 : 0;
  return 0;
}

/**
 * The interval for moving a piece in `key` by `semitones` (signed), spelled so that the new key
 * signature is the simplest one (Db rather than C#, B rather than Cb). `prefer` breaks the
 * F#/Gb tie ('sharps' | 'flats'); by default it follows the current key's direction.
 */
export function transposeInterval(key, semitones, prefer) {
  if (!semitones) return iv(0, 0);
  const mode = key.mode || 'major';
  const off = MODE_OFFSET[mode] ?? 0;
  const tonic = tonicOf(key);
  const targetPc = mod(pc(tonic.step, tonic.alter) + semitones, 12);
  const wantFlats = prefer ? prefer === 'flats' : key.fifths < 0;
  let best = null;
  for (const step of STEPS) {
    for (const alter of [-1, 0, 1]) {
      if (pc(step, alter) !== targetPc) continue;
      const fifths = fifthsOfMajorTonic({ step, alter }) + off;
      if (Math.abs(fifths) > 7) continue;
      const tie = (wantFlats ? fifths < 0 : fifths > 0) ? -0.1 : 0;
      const score = Math.abs(fifths) + tie;
      if (!best || score < best.score) best = { step, alter, score };
    }
  }
  const dMod = mod(stepIndex(best.step) - stepIndex(tonic.step), 7);
  // choose the octave of the letter distance that matches the size and direction of the move
  const k = Math.round((semitones * 7 / 12 - dMod) / 7);
  return iv(dMod + 7 * k, semitones);
}

export function transposeKey(key, interval) {
  if (!key) return key;
  const mode = key.mode || 'major';
  const t = transposeName(tonicOf(key), interval);
  return { ...key, fifths: fifthsOfMajorTonic(t) + (MODE_OFFSET[mode] ?? 0), mode };
}

// ---- jianpu (numbered notation, movable do) ----

/** Degree of a pitch in a key: {degree 1..7, acc (sharp/flat vs the scale), oct (dots: +1 above, -1 below)}. */
export function jianpuOf(p, key) {
  const t = tonicOf({ fifths: key.fifths, mode: 'major' });
  const d = mod(stepIndex(p.step) - stepIndex(t.step), 7);
  const scaleNote = transposeName(t, iv(d, [0, 2, 4, 5, 7, 9, 11][d]));
  const acc = (p.alter || 0) - (scaleNote.alter || 0);
  // tonic octave: the tonic at or below the C4..B4 range anchors "no dots"
  const tonicOctave = 4;
  const tonicStepAbs = tonicOctave * 7 + stepIndex(t.step);
  const pStepAbs = p.octave * 7 + stepIndex(p.step);
  const oct = Math.floor((pStepAbs - tonicStepAbs) / 7);
  return { degree: d + 1, acc, oct };
}

export const INTERVAL_SHORT = ['P1', 'm2', 'M2', 'm3', 'M3', 'P4', 'TT', 'P5', 'm6', 'M6', 'm7', 'M7', 'P8'];
