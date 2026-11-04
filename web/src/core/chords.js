// Chord symbols: parse what people actually write on chord sheets, transpose with correct spelling,
// name the notes, give the Roman numeral and function in a key, and find guitar/ukulele/piano shapes.
import { iv, mod, pc, stepIndex, transposeName, nameOf, tonicOf, STEPS, parseName, midiOf } from './pitch.js';

// Spelled chord intervals [diatonic, semitones] from the root.
const R = [0, 0], m3 = [2, 3], M3 = [2, 4], d5 = [4, 6], P5 = [4, 7], A5 = [4, 8], M6 = [5, 9], d7 = [6, 9],
  m7 = [6, 10], M7 = [6, 11], M2 = [1, 2], P4 = [3, 5], b9 = [8, 13], M9 = [8, 14], s9 = [8, 15], P11 = [10, 17], s11 = [10, 18], M13 = [12, 21];

export const QUALITIES = {
  maj: { iv: [R, M3, P5], sym: '', kind: 'major' },
  min: { iv: [R, m3, P5], sym: 'm', kind: 'minor' },
  dim: { iv: [R, m3, d5], sym: 'dim', kind: 'diminished' },
  aug: { iv: [R, M3, A5], sym: 'aug', kind: 'augmented' },
  5: { iv: [R, P5], sym: '5', kind: 'power' },
  sus2: { iv: [R, M2, P5], sym: 'sus2', kind: 'suspended-second' },
  sus4: { iv: [R, P4, P5], sym: 'sus4', kind: 'suspended-fourth' },
  6: { iv: [R, M3, P5, M6], sym: '6', kind: 'major-sixth' },
  m6: { iv: [R, m3, P5, M6], sym: 'm6', kind: 'minor-sixth' },
  7: { iv: [R, M3, P5, m7], sym: '7', kind: 'dominant' },
  maj7: { iv: [R, M3, P5, M7], sym: 'maj7', kind: 'major-seventh' },
  m7: { iv: [R, m3, P5, m7], sym: 'm7', kind: 'minor-seventh' },
  mMaj7: { iv: [R, m3, P5, M7], sym: 'm(maj7)', kind: 'major-minor' },
  m7b5: { iv: [R, m3, d5, m7], sym: 'm7♭5', kind: 'half-diminished' },
  dim7: { iv: [R, m3, d5, d7], sym: 'dim7', kind: 'diminished-seventh' },
  aug7: { iv: [R, M3, A5, m7], sym: '7♯5', kind: 'augmented-seventh' },
  '7sus4': { iv: [R, P4, P5, m7], sym: '7sus4', kind: 'suspended-fourth', degrees: [[7, -1]] },
  '7b5': { iv: [R, M3, d5, m7], sym: '7♭5', kind: 'dominant', degrees: [[5, -1, 'alter']] },
  add9: { iv: [R, M3, P5, M9], sym: 'add9', kind: 'major', degrees: [[9, 0]] },
  madd9: { iv: [R, m3, P5, M9], sym: 'm(add9)', kind: 'minor', degrees: [[9, 0]] },
  69: { iv: [R, M3, P5, M6, M9], sym: '6/9', kind: 'major-sixth', degrees: [[9, 0]] },
  9: { iv: [R, M3, P5, m7, M9], sym: '9', kind: 'dominant-ninth' },
  maj9: { iv: [R, M3, P5, M7, M9], sym: 'maj9', kind: 'major-ninth' },
  m9: { iv: [R, m3, P5, m7, M9], sym: 'm9', kind: 'minor-ninth' },
  '7b9': { iv: [R, M3, P5, m7, b9], sym: '7♭9', kind: 'dominant', degrees: [[9, -1]] },
  '7#9': { iv: [R, M3, P5, m7, s9], sym: '7♯9', kind: 'dominant', degrees: [[9, 1]] },
  11: { iv: [R, P5, m7, M9, P11], sym: '11', kind: 'dominant-11th' },
  m11: { iv: [R, m3, P5, m7, M9, P11], sym: 'm11', kind: 'minor-11th' },
  '7#11': { iv: [R, M3, P5, m7, s11], sym: '7♯11', kind: 'dominant', degrees: [[11, 1]] },
  13: { iv: [R, M3, P5, m7, M9, M13], sym: '13', kind: 'dominant-13th' },
  maj13: { iv: [R, M3, P5, M7, M9, M13], sym: 'maj13', kind: 'major-13th' },
  m13: { iv: [R, m3, P5, m7, M9, M13], sym: 'm13', kind: 'minor-13th' },
};

// Suffixes people type, normalised (lower-case except where case matters: M7 vs m7).
const ALIASES = [
  [['', 'maj', 'M', 'major', 'Maj'], 'maj'],
  [['m', 'min', 'mi', '-', 'minor'], 'min'],
  [['dim', '°', 'o', 'º'], 'dim'],
  [['aug', '+', '+5', '#5', '(#5)', '♯5'], 'aug'],
  [['5', '(no3)'], '5'],
  [['sus2', '2'], 'sus2'],
  [['sus4', 'sus'], 'sus4'],
  [['6', 'maj6', 'M6', 'add6'], '6'],
  [['m6', 'min6', '-6', 'mi6'], 'm6'],
  [['7', 'dom7', 'dom'], '7'],
  [['maj7', 'M7', 'Δ', 'Δ7', 'ma7', 'j7', 'Maj7', 'major7', '^7', '^'], 'maj7'],
  [['m7', 'min7', '-7', 'mi7'], 'm7'],
  [['mMaj7', 'm(maj7)', 'mmaj7', 'mM7', '-maj7', 'min(maj7)', 'minmaj7', 'm(M7)', '-Δ7', 'mΔ7'], 'mMaj7'],
  [['m7b5', 'm7(b5)', 'ø', 'ø7', '-7b5', 'mi7b5', 'min7b5', 'm7♭5', 'm7-5', 'Ø', 'Ø7'], 'm7b5'],
  [['dim7', '°7', 'o7', 'º7'], 'dim7'],
  [['aug7', '7#5', '+7', '7+5', '7(#5)', '7+', '7♯5'], 'aug7'],
  [['7sus4', '7sus', 'sus7', '7(sus4)'], '7sus4'],
  [['7b5', '7(b5)', '7-5', '7♭5'], '7b5'],
  [['add9', 'add2', '(add9)', '(add2)', 'add 9'], 'add9'],
  [['madd9', 'm(add9)', '-add9', 'm(add2)', 'madd2', 'min(add9)'], 'madd9'],
  [['6/9', '69', '6add9', '6(add9)'], '69'],
  [['9', 'dom9'], '9'],
  [['maj9', 'M9', 'Δ9', 'ma9'], 'maj9'],
  [['m9', 'min9', '-9', 'mi9'], 'm9'],
  [['7b9', '7(b9)', '7-9', '7♭9'], '7b9'],
  [['7#9', '7(#9)', '7+9', '7♯9'], '7#9'],
  [['11', '9sus4', '9sus'], '11'],
  [['m11', 'min11', '-11'], 'm11'],
  [['7#11', '7(#11)', '7♯11'], '7#11'],
  [['13'], '13'],
  [['maj13', 'M13', 'Δ13'], 'maj13'],
  [['m13', 'min13', '-13'], 'm13'],
];
const SUFFIX = new Map();
for (const [names, q] of ALIASES) for (const n of names) SUFFIX.set(n, q);

const CHORD_RE = /^([A-G])(##|bb|#|b|♯|♭)?([^/]*?)(?:\/([A-G](?:##|bb|#|b|♯|♭)?))?$/;

/** Parses "F#m7/C#", "Bbmaj7", "Asus4", "G/B". Returns null if it is not a chord. */
export function parseChord(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/\s+/g, '');
  if (!s || s.length > 16) return null;
  if (/^(N\.?C\.?|n\.?c\.?|NC)$/.test(s)) return { nc: true, text: 'N.C.' };
  const m = CHORD_RE.exec(s);
  if (!m) return null;
  const root = parseName(m[1] + (m[2] || ''));
  let suffix = m[3] || '';
  let quality = SUFFIX.get(suffix) ?? SUFFIX.get(suffix.replace(/[()]/g, ''));
  if (quality === undefined) {
    // case-insensitive second chance (but keep M7/m7 distinct by trying exact first)
    const lower = suffix.toLowerCase();
    for (const [k, v] of SUFFIX) if (k.toLowerCase() === lower && !/^M/.test(k)) { quality = v; break; }
  }
  if (quality === undefined) return null;
  const chord = { root: { step: root.step, alter: root.alter }, quality };
  if (m[4]) {
    const b = parseName(m[4]);
    if (!b) return null;
    chord.bass = { step: b.step, alter: b.alter };
  }
  return chord;
}

/** True if a token looks like a chord (used to tell chord lines from lyric lines). */
export function isChordToken(tok) {
  const t = tok.replace(/^[([|]+|[)\]|*.,]+$/g, '');
  if (!t) return false;
  if (/^(N\.?C\.?|\|+|-+|\/+|x\d+|\(x\d+\)|%)$/i.test(t)) return true;
  return !!parseChord(t);
}

export function formatChord(c, { ascii = false } = {}) {
  if (!c) return '';
  if (c.nc) return 'N.C.';
  let sym = QUALITIES[c.quality]?.sym ?? '';
  if (ascii) sym = sym.replace(/♭/g, 'b').replace(/♯/g, '#');
  let s = nameOf(c.root, { ascii }) + sym;
  if (c.bass) s += '/' + nameOf(c.bass, { ascii });
  return s;
}

export function transposeChord(c, interval) {
  if (!c || c.nc) return c;
  const out = { ...c, root: transposeName(c.root, interval) };
  if (c.bass) out.bass = transposeName(c.bass, interval);
  return out;
}

/** Spelled chord tones (names without octave), root first. */
export function chordNotes(c) {
  if (!c || c.nc) return [];
  return QUALITIES[c.quality].iv.map(([d, s]) => transposeName(c.root, iv(d, s)));
}

export function chordPcs(c) { return chordNotes(c).map((n) => pc(n.step, n.alter)); }

export function rootPc(c) { return pc(c.root.step, c.root.alter); }
export function bassPc(c) { return c.bass ? pc(c.bass.step, c.bass.alter) : rootPc(c); }

/** Role of a pitch class against a chord: 'R','3','5','7','9','11','13' or null. */
export function chordToneLabel(c, pitchClass) {
  if (!c || c.nc) return null;
  const labels = { 0: 'R', 1: '9', 2: '3', 3: '11', 4: '5', 5: '6', 6: '7', 8: '9', 10: '11', 12: '13' };
  for (const [d, s] of QUALITIES[c.quality].iv) {
    if (mod(rootPc(c) + s, 12) === pitchClass) {
      if (d === 5) return '6';
      return labels[d] ?? String(d + 1);
    }
  }
  return null;
}

// ---- Roman numerals ----

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

function hasMinorThird(q) { return ['min', 'dim', 'm6', 'm7', 'mMaj7', 'm7b5', 'dim7', 'madd9', 'm9', 'm11', 'm13'].includes(q); }

function numeralSuffix(q) {
  return {
    dim: '°', aug: '+', m7b5: 'ø7', dim7: '°7', 7: '7', maj7: 'maj7', m7: '7', mMaj7: '(maj7)', 6: '6', m6: '6', aug7: '+7',
    9: '9', maj9: 'maj9', m9: '9', 11: '11', m11: '11', 13: '13', sus2: 'sus2', sus4: 'sus4', '7sus4': '7sus4', add9: 'add9', madd9: 'add9',
    69: '6/9', '7b9': '7♭9', '7#9': '7♯9', '7b5': '7♭5', '7#11': '7♯11', 5: '5', maj13: 'maj13', m13: '13',
  }[q] ?? '';
}

/**
 * Roman numeral and harmonic function of a chord in a key.
 * func: 'T' tonic, 'S' subdominant, 'D' dominant, 'V' secondary dominant, 'B' borrowed/chromatic.
 */
export function romanNumeral(c, key) {
  if (!c || c.nc) return { text: '', func: null };
  const tonic = tonicOf(key);
  const minor = (key.mode || 'major') === 'minor' || key.mode === 'aeolian';
  const scale = minor ? MINOR_SCALE : MAJOR_SCALE;
  const deg = mod(stepIndex(c.root.step) - stepIndex(tonic.step), 7);
  const rootSemis = mod(rootPc(c) - pc(tonic.step, tonic.alter), 12);
  let acc = rootSemis - scale[deg];
  if (acc > 6) acc -= 12;
  if (acc < -6) acc += 12;
  // in minor, the raised 7th (leading tone) is diatonic for V and vii°
  if (minor && deg === 6 && acc === 1) acc = 0;
  const lower = hasMinorThird(c.quality);
  let base = ROMAN[deg];
  if (lower) base = base.toLowerCase();
  const accText = acc < 0 ? '♭'.repeat(-acc) : acc > 0 ? '♯'.repeat(acc) : '';
  let text = accText + base + numeralSuffix(c.quality);
  if (c.bass) {
    const bassDeg = mod(stepIndex(c.bass.step) - stepIndex(c.root.step), 7);
    const inv = { 2: '/3', 4: '/5', 6: '/7' }[bassDeg];
    text += inv || '/' + nameOf(c.bass);
  }
  // diatonic triad qualities for function
  const diatonic = isDiatonic(c, key);
  let func;
  if (diatonic) {
    func = minor
      ? ['T', 'S', 'T', 'S', 'D', 'S', 'D'][deg]
      : ['T', 'S', 'T', 'S', 'D', 'T', 'D'][deg];
  } else {
    // secondary dominant: major/dominant chord whose root is a fifth above a diatonic chord root
    const isDomLike = ['maj', '7', '9', '7b9', '7#9', '13', '7sus4'].includes(c.quality);
    const targetDeg = mod(deg - 4, 7);
    const targetSemis = mod(rootSemis - 7, 12);
    if (isDomLike && acc === 0 && targetSemis === scale[targetDeg] && targetDeg !== 0 && !(minor && targetDeg === 1)) {
      const targetMinor = minor ? [false, true, false, true, true, false, false][targetDeg] : [false, true, true, false, false, true, true][targetDeg];
      let tgt = ROMAN[targetDeg];
      if (targetMinor) tgt = tgt.toLowerCase();
      text = (c.quality === 'maj' ? 'V' : 'V' + numeralSuffix(c.quality)) + '/' + tgt;
      func = 'V';
    } else if (deg === 0 && c.quality === '7' && !minor) {
      text = 'V7/IV';
      func = 'V';
    } else {
      func = 'B';
    }
  }
  return { text, func, degree: deg + 1, acc };
}

export function isDiatonic(c, key) {
  if (!c || c.nc) return false;
  const tonic = tonicOf(key);
  const minor = (key.mode || 'major') === 'minor' || key.mode === 'aeolian';
  const t = pc(tonic.step, tonic.alter);
  const allowed = new Set((minor ? MINOR_SCALE : MAJOR_SCALE).map((s) => mod(t + s, 12)));
  if (minor) allowed.add(mod(t + 11, 12)); // harmonic minor leading tone
  return chordPcs(c).every((p) => allowed.has(p));
}

/** Diatonic seventh/triad chords of a key (for pickers and improvisation presets). */
export function diatonicChords(key, sevenths = false) {
  const tonic = tonicOf(key);
  const minor = (key.mode || 'major') === 'minor';
  const triads = minor ? ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj'] : ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'];
  const sev = minor ? ['m7', 'm7b5', 'maj7', 'm7', 'm7', 'maj7', '7'] : ['maj7', 'm7', 'm7', 'maj7', '7', 'm7', 'm7b5'];
  const scale = minor ? MINOR_SCALE : MAJOR_SCALE;
  return scale.map((s, i) => ({ root: transposeName(tonic, iv(i, s)), quality: (sevenths ? sev : triads)[i] }));
}

// ---- shapes ----

export const TUNINGS = {
  guitar: { name: 'Guitar', strings: [40, 45, 50, 55, 59, 64], labels: ['E', 'A', 'D', 'G', 'B', 'E'], reentrant: false },
  ukulele: { name: 'Ukulele', strings: [67, 60, 64, 69], labels: ['G', 'C', 'E', 'A'], reentrant: true },
  bass: { name: 'Bass', strings: [28, 33, 38, 43], labels: ['E', 'A', 'D', 'G'], reentrant: false },
};

/**
 * Playable fingerings for a chord on a fretted instrument, best first.
 * Each: {frets: [-1|0..n per string, low to high], base, barre: {fret, from, to}|null, fingers}
 */
export function fretShapes(c, instrument = 'guitar', max = 3) {
  if (!c || c.nc) return [];
  const generated = searchShapes(c, instrument, max + 2);
  const std = standardShape(c, instrument);
  if (!std) return generated.slice(0, max);
  const stdKey = std.frets.join(',');
  return [std, ...generated.filter((g) => g.frets.join(',') !== stdKey)].slice(0, max);
}

// Shapes every teacher shows first (low string to high string; x = not played).
const GUITAR_STD = {
  C: 'x32010', D: 'xx0232', E: '022100', F: '133211', G: '320003', A: 'x02220', B: 'x24442', Bb: 'x13331',
  Cm: 'x35543', Dm: 'xx0231', Em: '022000', Fm: '133111', Gm: '355333', Am: 'x02210', Bm: 'x24432',
  'F#m': '244222', 'C#m': 'x46654', 'G#m': '466444', Bbm: 'x13321',
  C7: 'x32310', D7: 'xx0212', E7: '020100', F7: '131211', G7: '320001', A7: 'x02020', B7: 'x21202',
  Cmaj7: 'x32000', Dmaj7: 'xx0222', Emaj7: '021100', Fmaj7: 'xx3210', Gmaj7: '320002', Amaj7: 'x02120',
  Cm7: 'x35343', Dm7: 'xx0211', Em7: '022030', Fm7: '131111', Gm7: '353333', Am7: 'x02010', Bm7: 'x20202',
  Csus4: 'x33011', Dsus4: 'xx0233', Esus4: '022200', Gsus4: '330013', Asus4: 'x02230',
  Dsus2: 'xx0230', Asus2: 'x02200', Cadd9: 'x32030',
  C6: 'x32210', D6: 'xx0202', E6: '022120', G6: '320000', A6: 'x02222', Am6: 'x02212', Dm6: 'xx0201', Em6: '022020',
  E5: '022xxx', A5: 'x022xx', D5: 'xx023x', G5: '355xxx', C5: 'x355xx', F5: '133xxx',
  'D/F#': '200232', 'G/B': 'x20003', 'C/G': '332010', 'C/E': '032010', Bm7b5: 'x2323x', Ddim: 'xx0131',
  'C#': 'x46664', Eb: 'xx1343', Ab: '466544', 'F#': '244322', 'C#m7': 'x46454', 'F#m7': '242222', Bb7: 'x13131',
  'F#7': '242322', 'C#7': 'x46464', Bbmaj7: 'x13231', Ebmaj7: 'xx1333', Cdim7: 'x3424x', Cm7b5: 'x3434x', Em7b5: 'xx2333',
  Am7b5: 'x0101x', E9: '020102', A9: 'x02423', D9: 'x5455x', G9: '3x0201', C9: 'x32333',
};
const UKE_STD = {
  C: '0003', D: '2220', E: '1402', F: '2010', G: '0232', A: '2100', B: '4322', Bb: '3211', Eb: '0331',
  Cm: '0333', Dm: '2210', Em: '0432', Fm: '1013', Gm: '0231', Am: '2000', Bm: '4222', 'C#m': '1104', 'F#m': '2120',
  C7: '0001', D7: '2223', E7: '1202', F7: '2313', G7: '0212', A7: '0100', B7: '2322',
  Cmaj7: '0002', Fmaj7: '5500', Gmaj7: '0222', Am7: '0000', Dm7: '2213', Em7: '0202',
};
const ENHARMONIC = { 'A#': 'Bb', 'D#': 'Eb', 'G#': 'Ab', 'Db': 'C#', 'Gb': 'F#' };

function standardShape(c, instrument) {
  const table = instrument === 'guitar' ? GUITAR_STD : instrument === 'ukulele' ? UKE_STD : null;
  if (!table) return null;
  let name = formatChord(c, { ascii: true });
  let shape = table[name];
  if (!shape) {
    const m = /^([A-G][#b]?)(.*)$/.exec(name);
    if (m && ENHARMONIC[m[1]]) shape = table[ENHARMONIC[m[1]] + m[2]];
  }
  if (!shape) return null;
  const frets = [...shape].map((ch) => (ch === 'x' ? -1 : parseInt(ch, 36)));
  const fretted = frets.filter((f) => f > 0);
  const lo = fretted.length ? Math.min(...fretted) : 0;
  let barre = null;
  const idx = frets.map((f, i) => (f === lo && lo > 0 ? i : -1)).filter((i) => i >= 0);
  if (idx.length >= 2 && frets.slice(idx[0], idx[idx.length - 1] + 1).every((f) => f >= lo || f < 0) && !frets.slice(idx[0], idx[idx.length - 1] + 1).includes(0)) {
    barre = { fret: lo, from: idx[0], to: idx[idx.length - 1] };
  }
  const fingers = barre ? fretted.length - idx.length + 1 : fretted.length;
  return { frets, base: lo > 3 && Math.max(...fretted) > 4 ? lo : 1, barre, fingers, score: -1, standard: true };
}

function searchShapes(c, instrument, max) {
  const tun = TUNINGS[instrument];
  const tones = QUALITIES[c.quality].iv.map(([, s]) => mod(rootPc(c) + s, 12));
  const root = rootPc(c), bass = bassPc(c);
  const required = new Set([root]);
  const q = QUALITIES[c.quality].iv;
  const needsNinth = ['add9', 'madd9', '9', 'maj9', 'm9', '69', '7b9', '7#9'].includes(c.quality);
  for (const [d, s] of q) if (d === 2 || d === 6 || d === 5 || (d === 8 && needsNinth) || (d === 1 && c.quality === 'sus2') || (d === 3 && c.quality.includes('sus4'))) required.add(mod(root + s, 12));
  if (c.quality === '5') required.add(mod(root + 7, 12));
  if (c.bass) required.add(bass);
  const toneSet = new Set(tones);
  if (c.bass) toneSet.add(bass);
  const n = tun.strings.length;
  const results = [];
  const seen = new Set();
  for (let base = 0; base <= 12; base++) {
    const opts = tun.strings.map((open) => {
      const o = tun.reentrant ? [] : [-1];
      if (toneSet.has(mod(open, 12))) o.push(0);
      for (let f = Math.max(1, base); f <= base + 3; f++) if (toneSet.has(mod(open + f, 12))) o.push(f);
      return o.length ? o : [-1];
    });
    const cur = new Array(n);
    const walk = (i) => {
      if (i === n) { evaluate(cur.slice(), base); return; }
      for (const f of opts[i]) { cur[i] = f; walk(i + 1); }
    };
    walk(0);
  }
  function evaluate(frets, base) {
    const played = frets.map((f, i) => (f < 0 ? null : tun.strings[i] + f));
    const sounding = played.filter((x) => x !== null);
    const minStrings = tun.reentrant ? 4 : (n === 4 ? 3 : 4);
    if (sounding.length < minStrings) return;
    // mutes: only from the low side, plus at most one inner mute (guitar)
    if (!tun.reentrant) {
      const firstPlayed = frets.findIndex((f) => f >= 0);
      const inner = frets.slice(firstPlayed).filter((f) => f < 0).length;
      if (inner > 1) return;
      const lowest = Math.min(...sounding);
      if (mod(lowest, 12) !== bass) return;
    }
    const present = new Set(sounding.map((x) => mod(x, 12)));
    for (const r of required) if (!present.has(r)) return;
    const fretted = frets.filter((f) => f > 0);
    if (fretted.length && Math.max(...fretted) - Math.min(...fretted) > 3) return;
    // fingers with a barre at the lowest fretted fret
    let fingers = fretted.length, barre = null;
    if (fretted.length) {
      const lo = Math.min(...fretted);
      const idx = frets.map((f, i) => (f === lo ? i : -1)).filter((i) => i >= 0);
      if (idx.length >= 2) {
        const from = idx[0], to = idx[idx.length - 1];
        const ok = frets.slice(from, to + 1).every((f) => f >= lo || f < 0) && frets.slice(from, to + 1).every((f) => f !== 0);
        if (ok) { fingers = fretted.length - idx.length + 1; barre = { fret: lo, from, to }; }
      }
    }
    if (fingers > 4) return;
    const key = frets.join(',');
    if (seen.has(key)) return;
    seen.add(key);
    const lowFret = fretted.length ? Math.min(...fretted) : 0;
    const opens = frets.filter((f) => f === 0).length;
    const mutes = frets.filter((f) => f < 0).length;
    const missing5 = present.has(mod(root + 7, 12)) || !q.some(([d]) => d === 4) ? 0 : 1;
    const firstPlayed = frets.findIndex((f) => f >= 0);
    const innerMutes = frets.slice(firstPlayed).filter((f) => f < 0).length;
    const stretch = fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0;
    // open strings sitting between fretted strings are awkward above first position
    const firstFretted = frets.findIndex((f) => f > 0);
    const lastFretted = frets.length - 1 - [...frets].reverse().findIndex((f) => f > 0);
    const innerOpens = firstFretted >= 0 ? frets.slice(firstFretted, lastFretted + 1).filter((f) => f === 0).length : 0;
    let score = stretch * 0.4 + lowFret * 1.1 + fingers * 0.9 + mutes * 0.7 + innerMutes * 1.5 + missing5 * 1.5 - sounding.length * 0.3 - (lowFret <= 3 ? opens * 0.6 : 0) + (lowFret >= 2 ? innerOpens * 0.9 : 0);
    if (barre) score += 1.2;
    if (tun.reentrant && mod(sounding[1] ?? 0, 12) !== root && mod(Math.min(...sounding), 12) !== root) score += 0.4;
    results.push({ frets, base: lowFret > 3 && Math.max(...fretted) > 4 ? lowFret : 1, barre, fingers, score });
  }
  results.sort((a, b) => a.score - b.score);
  return results.slice(0, max);
}

/** Piano voicing (MIDI numbers): bass in octave 3 for slash chords, close position from the root. */
export function pianoVoicing(c, rootOctave = 4) {
  if (!c || c.nc) return [];
  const rootMidi = midiOf({ ...c.root, octave: rootOctave });
  const out = QUALITIES[c.quality].iv.slice(0, 5).map(([, s]) => rootMidi + s);
  if (c.bass) out.unshift(midiOf({ ...c.bass, octave: rootOctave - 1 }));
  return out;
}

// Names guitarists use for each pitch class when thinking in shapes.
const FRIENDLY = [['C', 0], ['C', 1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['B', -1], ['B', 0]];
function friendly(pcValue) { const [step, alter] = FRIENDLY[mod(pcValue, 12)]; return { step, alter }; }

/** The chord moved by a semitone count and re-spelled the way guitar shapes are named. */
export function shiftChordFriendly(c, semis) {
  if (!c || c.nc) return c;
  const out = { ...c, root: friendly(rootPc(c) + semis) };
  if (c.bass) out.bass = friendly(bassPc(c) + semis);
  return out;
}

const EASY_SHAPES = new Set(['C', 'A', 'G', 'E', 'D', 'Am', 'Em', 'Dm', 'E7', 'A7', 'D7', 'G7', 'C7', 'B7', 'Am7', 'Em7', 'Dm7', 'Cmaj7', 'Fmaj7', 'Amaj7', 'Dmaj7', 'Emaj7', 'Gmaj7', 'Dsus4', 'Asus4', 'Esus4', 'Dsus2', 'Asus2', 'Cadd9', 'G/B', 'C/G', 'D/F#', 'C/E', 'A/C#', 'E5', 'A5', 'D5', 'G6', 'C6', 'A6', 'E6', 'D6', 'Am6', 'Dm6', 'Em6']);

/** Capo choices for a set of chords: [{capo, shapes, names, hard}] best first (fewest hard shapes, low capo). */
export function capoOptions(chords) {
  const unique = [];
  const seen = new Set();
  for (const ch of chords) {
    if (!ch || ch.nc) continue;
    const k = formatChord(ch, { ascii: true });
    if (!seen.has(k)) { seen.add(k); unique.push(ch); }
  }
  const opts = [];
  for (let capo = 0; capo <= 7; capo++) {
    const shapes = unique.map((ch) => shiftChordFriendly(ch, -capo));
    const names = shapes.map((s) => formatChord(s, { ascii: true }));
    const hard = names.filter((nm) => !EASY_SHAPES.has(nm)).length;
    opts.push({ capo, shapes, names, hard, score: hard * 2 + capo * 0.35 });
  }
  opts.sort((a, b) => a.score - b.score);
  return opts;
}

export function isEasyShape(c) { return EASY_SHAPES.has(formatChord(c, { ascii: true })); }

export { STEPS };
