// Scale and arpeggio exercises written as exact, correctly spelled scores.
import { q, ZERO } from './q.js';
import { iv, transposePitch, keyOfTonic, midiOf, nameOf } from './pitch.js';
import { notesFromSpans, recomputeStarts } from './score.js';

export const SCALE_TYPES = {
  major: { steps: [[0, 0], [1, 2], [2, 4], [3, 5], [4, 7], [5, 9], [6, 11]], mode: 'major' },
  minor: { steps: [[0, 0], [1, 2], [2, 3], [3, 5], [4, 7], [5, 8], [6, 10]], mode: 'minor' },
  harmonicMinor: { steps: [[0, 0], [1, 2], [2, 3], [3, 5], [4, 7], [5, 8], [6, 11]], mode: 'minor' },
  majorPent: { steps: [[0, 0], [1, 2], [2, 4], [4, 7], [5, 9]], mode: 'major' },
  minorPent: { steps: [[0, 0], [2, 3], [3, 5], [4, 7], [6, 10]], mode: 'minor' },
  blues: { steps: [[0, 0], [2, 3], [3, 5], [4, 6], [4, 7], [6, 10]], mode: 'minor' },
  arpeggio: { steps: [[0, 0], [2, 4], [4, 7]], mode: 'major' },
};

const LOWEST = { violin: 55, viola: 48, cello: 36, voice: 53, flute: 60, recorder: 60, piano: 48, keyboard: 48, guitar: 40, ukulele: 60, clarinet: 50, sax: 49, trumpet: 52, erhu: 62, dizi: 67 };

/** A scale up and down (quarter notes, 4/4) ending on a whole note. */
export function scaleScore({ tonic = { step: 'C', alter: 0 }, type = 'major', octaves = 1, instrument = 'violin' }) {
  const def = SCALE_TYPES[type] || SCALE_TYPES.major;
  const lowest = LOWEST[instrument] ?? 55;
  let octave = 3;
  while (midiOf({ ...tonic, octave }) < lowest) octave++;
  while (midiOf({ ...tonic, octave }) - 12 >= lowest && octave > 4) octave--;
  const base = { ...tonic, octave };
  const up = [];
  for (let o = 0; o < octaves; o++) for (const [d, c] of def.steps) up.push(transposePitch(base, iv(d + 7 * o, c + 12 * o)));
  up.push(transposePitch(base, iv(7 * octaves, 12 * octaves)));
  const line = [...up, ...up.slice(0, -1).reverse()];
  const key = keyOfTonic(tonic, def.mode === 'minor' ? 'minor' : 'major');
  const time = { beats: 4, beatType: 4 };
  const measures = [];
  const part = { id: 'P1', name: 'Scale', abbr: '', instrument, program: null, transpose: null, staves: 1, measures: [] };
  const lo = Math.min(...line.map(midiOf));
  const clef = lo < 53 ? { staff: 1, sign: 'F', line: 4, oct: 0, off: ZERO } : { staff: 1, sign: 'G', line: 2, oct: 0, off: ZERO };
  const total = line.length;
  // quarters, last note a whole note in its own bar
  const items = line.slice(0, -1).map((p, i) => ({ t: i, p }));
  const bars = Math.ceil(items.length / 4) + 1;
  for (let b = 0; b < bars; b++) {
    const inBar = items.filter((x) => Math.floor(x.t / 4) === b).map((x) => ({ off: q(x.t % 4), dur: q(1), pitch: x.p }));
    const lastBar = b === bars - 1;
    const notes = lastBar ? notesFromSpans([{ off: ZERO, dur: q(4), pitch: line[total - 1] }], time) : notesFromSpans(inBar, time);
    measures.push({ number: String(b + 1), implicit: false, start: ZERO, dur: q(4), left: {}, right: lastBar ? { style: 'light-heavy' } : {}, jumps: {}, ...(b === 0 ? { time, tempo: 80 } : {}) });
    part.measures.push({ key: b === 0 ? key : null, clefs: b === 0 ? [clef] : [], harmonies: [], notes, directions: [], extraAttrs: [] });
  }
  const score = { title: `${nameOf(tonic)} ${type}`, composer: 'Melovyn', lyricist: '', measures, parts: [part], meta: { source: 'exercise' } };
  recomputeStarts(score);
  return score;
}
