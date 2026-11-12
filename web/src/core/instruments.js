// Every common instrument: the clef it reads, how its written notes relate to what sounds (transposing
// instruments), the range it can play, and the app's sound for it. Used to show any part "for my instrument".
import { ZERO } from './q.js';
import { extractPart, transposeBy, concertKey } from './score.js';
import { midiOf, transposePitch, iv } from './pitch.js';

const G = { sign: 'G', line: 2 }, F = { sign: 'F', line: 4 }, C3 = { sign: 'C', line: 3 };
// tr: interval from the written note to the sounding note ({d: letter steps, c: semitones}); range: sounding MIDI
export const INSTRUMENT_DEFS = {
  piano: { clef: G, range: [21, 108], sound: 'piano', family: 'keys', staves: 2 },
  keyboard: { clef: G, range: [36, 96], sound: 'piano', family: 'keys', staves: 2 },
  organ: { clef: G, range: [36, 96], sound: 'organ', family: 'keys', staves: 2 },
  harp: { clef: G, range: [24, 103], sound: 'piano', family: 'keys', staves: 2 },
  violin: { clef: G, range: [55, 100], sound: 'strings', family: 'strings' },
  viola: { clef: C3, range: [48, 88], sound: 'strings', family: 'strings' },
  cello: { clef: F, range: [36, 76], sound: 'strings', family: 'strings' },
  doublebass: { clef: F, tr: iv(-7, -12), range: [28, 60], sound: 'bass', family: 'strings' },
  guitar: { clef: G, tr: iv(-7, -12), range: [40, 84], sound: 'guitar', family: 'plucked' },
  ukulele: { clef: G, range: [60, 81], sound: 'guitar', family: 'plucked' },
  bassguitar: { clef: F, tr: iv(-7, -12), range: [28, 60], sound: 'bass', family: 'plucked' },
  mandolin: { clef: G, range: [55, 93], sound: 'guitar', family: 'plucked' },
  voice: { clef: G, range: [55, 81], sound: 'voice', family: 'voice' },
  soprano: { clef: G, range: [60, 84], sound: 'voice', family: 'voice' },
  alto: { clef: G, range: [53, 77], sound: 'voice', family: 'voice' },
  tenor: { clef: G, tr: iv(-7, -12), range: [48, 72], sound: 'voice', family: 'voice' },
  bass: { clef: F, range: [40, 64], sound: 'voice', family: 'voice' },
  flute: { clef: G, range: [60, 96], sound: 'flute', family: 'wind' },
  piccolo: { clef: G, tr: iv(7, 12), range: [74, 108], sound: 'flute', family: 'wind' },
  recorder: { clef: G, range: [72, 98], sound: 'flute', family: 'wind' },
  oboe: { clef: G, range: [58, 91], sound: 'clarinet', family: 'wind' },
  clarinet: { clef: G, tr: iv(-1, -2), range: [50, 91], sound: 'clarinet', family: 'wind', pitch: 'B♭' },
  bassoon: { clef: F, range: [34, 72], sound: 'clarinet', family: 'wind' },
  sopranosax: { clef: G, tr: iv(-1, -2), range: [56, 88], sound: 'clarinet', family: 'wind', pitch: 'B♭' },
  sax: { clef: G, tr: iv(-5, -9), range: [49, 81], sound: 'clarinet', family: 'wind', pitch: 'E♭' },           // alto
  tenorsax: { clef: G, tr: iv(-8, -14), range: [44, 76], sound: 'clarinet', family: 'wind', pitch: 'B♭' },
  trumpet: { clef: G, tr: iv(-1, -2), range: [52, 82], sound: 'brass', family: 'brass', pitch: 'B♭' },
  horn: { clef: G, tr: iv(-4, -7), range: [41, 77], sound: 'brass', family: 'brass', pitch: 'F' },
  trombone: { clef: F, range: [40, 72], sound: 'brass', family: 'brass' },
  tuba: { clef: F, range: [28, 58], sound: 'brass', family: 'brass' },
  erhu: { clef: G, range: [62, 93], sound: 'strings', family: 'chinese' },
  dizi: { clef: G, range: [69, 98], sound: 'flute', family: 'chinese' },
  guzheng: { clef: G, range: [38, 86], sound: 'guitar', family: 'chinese' },
  pipa: { clef: G, range: [45, 88], sound: 'guitar', family: 'chinese' },
  harmonica: { clef: G, range: [60, 96], sound: 'clarinet', family: 'wind' },
  xylophone: { clef: G, range: [65, 108], sound: 'epiano', family: 'keys' },
};
export const FAMILIES = ['keys', 'strings', 'plucked', 'voice', 'wind', 'brass', 'chinese'];
export const soundOf = (id) => INSTRUMENT_DEFS[id]?.sound || 'piano';
const add = (a, b) => iv(a.d + b.d, a.c + b.c);
const neg = (a) => iv(-a.d, -a.c);
const NONE = iv(0, 0);

/**
 * One part (or one hand) of a score written for another instrument: the right clef, written at the pitch
 * that instrument reads (B flat clarinet, E flat alto sax, F horn...), and moved by whole octaves so that as
 * much as possible sits inside the instrument's range. The music itself is not changed.
 * Returns {score, octaves, outOfRange, total}.
 */
export function arrangeFor(score, pi, staff, instrument) {
  const def = INSTRUMENT_DEFS[instrument];
  const one = extractPart(score, pi, staff);
  const part = one.parts[0];
  if (!def || !part) return { score: one, octaves: 0, outOfRange: 0, total: 0 };
  const src = part.transpose || NONE;
  const sounding = [];
  for (const pm of part.measures) for (const n of pm.notes) if (n.pitch && !n.rest) sounding.push(midiOf(transposePitch(n.pitch, src)));
  const outside = (k) => sounding.reduce((s, m) => s + (m + 12 * k < def.range[0] || m + 12 * k > def.range[1] ? 1 : 0), 0);
  let octaves = 0, best = outside(0);
  for (const k of [1, -1, 2, -2, 3, -3]) { const o = outside(k); if (o < best) { best = o; octaves = k; } }
  const tr = def.tr || NONE;
  // written for the new instrument = sounding (old written + old transposition), moved by octaves, minus the new transposition
  const interval = add(add(src, iv(7 * octaves, 12 * octaves)), neg(tr));
  const moved = interval.d || interval.c ? transposeBy(one, interval) : one;
  const p2 = moved.parts[0];
  const out = {
    ...moved,
    parts: [{
      ...p2, instrument, transpose: def.tr || null, staves: staff ? 1 : p2.staves,
      measures: p2.measures.map((pm, mi) => ((staff || p2.staves === 1)
        ? { ...pm, clefs: mi === 0 ? [{ staff: 1, sign: def.clef.sign, line: def.clef.line, oct: 0, off: ZERO }] : [] }
        : pm)),
    }],
  };
  void concertKey;
  return { score: out, octaves, outOfRange: best, total: sounding.length };
}
