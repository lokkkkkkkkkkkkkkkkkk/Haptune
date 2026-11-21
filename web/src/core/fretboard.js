// Chord diagrams ("finger chord pictures") for guitar and ukulele: where each finger goes for a chord symbol.
// Open shapes come first (what a beginner learns), then movable shapes: E- and A-shape barre chords on guitar,
// and any shape slid up the neck on ukulele. Each shape is checked: every string that sounds plays a note of
// the chord. A diagram is {strings, frets: [low → high, -1 = not played, 0 = open], fingers, barre, base}.
import { parseChord, chordPcs, rootPc, formatChord } from './chords.js';

export const TUNINGS = {
  guitar: { names: ['E', 'A', 'D', 'G', 'B', 'E'], midi: [40, 45, 50, 55, 59, 64] },
  ukulele: { names: ['G', 'C', 'E', 'A'], midi: [67, 60, 64, 69] },
};
/** Which diagram set an instrument uses (none for the rest). */
export const fretsFor = (instrument) => (['guitar', 'mandolin', 'pipa'].includes(instrument) ? 'guitar' : instrument === 'ukulele' ? 'ukulele' : null);

// [frets, fingers] low string first; -1 = muted
const G_OPEN = {
  'C:maj': ['x32010', '032010'], 'A:maj': ['x02220', '001230'], 'G:maj': ['320003', '210003'], 'E:maj': ['022100', '023100'], 'D:maj': ['xx0232', '000132'],
  'A:min': ['x02210', '002310'], 'E:min': ['022000', '023000'], 'D:min': ['xx0231', '000231'],
  'C:7': ['x32310', '032410'], 'A:7': ['x02020', '002030'], 'G:7': ['320001', '320001'], 'E:7': ['020100', '020100'], 'D:7': ['xx0212', '000213'], 'B:7': ['x21202', '021304'],
  'A:m7': ['x02010', '002010'], 'E:m7': ['022030', '023040'], 'D:m7': ['xx0211', '000211'],
  'C:maj7': ['x32000', '032000'], 'F:maj7': ['xx3210', '003210'], 'A:maj7': ['x02120', '002130'], 'D:maj7': ['xx0222', '000111'], 'G:maj7': ['320002', '320001'], 'E:maj7': ['021100', '031200'],
  'A:sus2': ['x02200', '001200'], 'A:sus4': ['x02230', '001240'], 'D:sus2': ['xx0230', '000130'], 'D:sus4': ['xx0233', '000134'], 'E:sus4': ['022200', '023400'],
  'C:add9': ['x32030', '021030'], 'G:6': ['320000', '210000'], 'C:6': ['x32210', '042310'], 'E:5': ['022xxx', '011000'], 'A:5': ['x022xx', '001100'],
  'F:maj': ['133211', '134211'], 'B:min': ['x24432', '013421'], 'A#:maj': ['x13331', '012341'], 'F:min': ['133111', '134111'],
};
const U_OPEN = {
  'C:maj': ['0003', '0003'], 'G:maj': ['0232', '0132'], 'A:min': ['2000', '2000'], 'F:maj': ['2010', '2010'], 'D:maj': ['2220', '1230'], 'E:min': ['0432', '0321'],
  'A:maj': ['2100', '2100'], 'E:7': ['1202', '1203'], 'D:min': ['2210', '2310'], 'A:7': ['0100', '0100'], 'G:7': ['0212', '0213'], 'C:7': ['0001', '0001'],
  'D:7': ['2223', '1112'], 'A#:maj': ['3211', '3211'], 'E:m7': ['0202', '0102'], 'A:m7': ['0000', '0000'], 'C:maj7': ['0002', '0001'], 'B:min': ['4222', '3111'],
  'B:7': ['2322', '1211'], 'G:min': ['0231', '0231'], 'C:min': ['0333', '0123'], 'F:min': ['1013', '1024'], 'E:maj': ['1402', '1403'], 'D:m7': ['2213', '2314'],
  'C:sus4': ['0013', '0013'], 'G:sus4': ['0233', '0123'], 'D:sus4': ['0230', '0130'], 'A:sus4': ['2200', '1200'], 'F:maj7': ['2413', '2413'], 'G:maj7': ['0222', '0111'],
};
const PCS = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const NAME = Object.fromEntries(Object.entries(PCS).map(([k, v]) => [v, k]));
const parseShape = ([f, g]) => ({ frets: [...f].map((c) => (c === 'x' ? -1 : Number(c))), fingers: [...g].map(Number) });
const SIMPLER = { 9: '7', 13: '7', 11: '7', maj9: 'maj7', m9: 'm7', m11: 'm7', '7b9': '7', '7#9': '7', '7#11': '7', add9: 'maj', madd9: 'min', 69: '6', m6: 'min', mMaj7: 'min', '7sus4': 'sus4', '7b5': '7', aug7: 'aug' };

// guitar movable shapes: root on the 6th string (E shape) or the 5th (A shape); fret offsets from the root fret
const E_SHAPES = { maj: ['022100', '134211'], min: ['022000', '134111'], 7: ['020100', '131211'], m7: ['020000', '131111'], sus4: ['022200', '134411'], 5: ['022xxx', '134000'] };
const A_SHAPES = { maj: ['x02220', '012341'], min: ['x02210', '013421'], 7: ['x02020', '013141'], m7: ['x02010', '013121'], maj7: ['x02120', '013241'],
  sus4: ['x02230', '012341'], sus2: ['x02200', '013411'], dim: ['x0121x', '012430'], m7b5: ['x0101x', '013240'], dim7: ['x0101x', '012130'], 6: ['x02222', '013333'], aug: ['x0322x', '014230'] };

function fit(frets, pcsSet, tuning) {
  return frets.every((f, i) => f < 0 || pcsSet.has((tuning[i] + f) % 12)) && frets.some((f) => f >= 0);
}
function finish(frets, fingers, strings) {
  const played = frets.filter((f) => f > 0);
  const lo = played.length ? Math.min(...played) : 1, hi = played.length ? Math.max(...played) : 1;
  const base = hi > 4 ? lo : 1;
  // a barre: finger 1 on the lowest fret over two or more strings
  const ones = frets.map((f, i) => (fingers[i] === 1 && f === lo && f > 0 ? i : -1)).filter((i) => i >= 0);
  const barre = ones.length >= 2 ? { fret: lo, from: ones[0], to: ones[ones.length - 1] } : null;
  return { strings, frets, fingers, barre, base };
}

/** The diagram for a chord ("Am", "F#7", or a parsed chord) on 'guitar' or 'ukulele'; null if none fits. */
export function diagramFor(chordIn, set = 'guitar') {
  const c = typeof chordIn === 'string' ? parseChord(chordIn) : chordIn;
  if (!c || c.nc) return null;
  const tuning = TUNINGS[set]?.midi;
  if (!tuning) return null;
  const want = new Set(chordPcs(c));
  const root = rootPc(c);
  const qual = c.quality;
  const lib = set === 'guitar' ? G_OPEN : U_OPEN;
  const tryQ = [qual, SIMPLER[qual]].filter(Boolean);
  for (const qq of tryQ) {
    const hit = lib[`${NAME[root]}:${qq}`];
    if (hit) { const s = parseShape(hit); const ok = qq === qual ? want : new Set(chordPcs({ ...c, quality: qq })); if (fit(s.frets, ok, tuning)) return finish(s.frets, s.fingers, tuning.length); }
  }
  const cands = [];
  for (const qq of tryQ) {
    const ok = qq === qual ? want : new Set(chordPcs({ ...c, quality: qq }));
    if (set === 'guitar') {
      for (const [shapes, open] of [[E_SHAPES, 40], [A_SHAPES, 45]]) {
        if (!shapes[qq]) continue;
        const r = (root - (open % 12) + 12) % 12 || 12;
        const s = parseShape(shapes[qq]);
        const frets = s.frets.map((f) => (f < 0 ? -1 : f + r));
        if (fit(frets, ok, tuning)) cands.push({ r, frets, fingers: s.fingers });
      }
    }
    // slide any known shape of this quality up the neck (on guitar only when no barre shape fits)
    if (!cands.length) for (const [k, v] of Object.entries(lib)) {
      const [rn, kq] = k.split(':');
      if (kq !== qq) continue;
      const shift = (root - PCS[rn] + 12) % 12;
      if (!shift) continue;
      const s = parseShape(v);
      const frets = s.frets.map((f) => (f < 0 ? -1 : f + shift));
      if (Math.max(...frets) > 14) continue;
      const fingers = s.frets.map((f, i) => (f < 0 ? 0 : f === 0 ? 1 : Math.min(4, s.fingers[i] + 1)));
      if (fit(frets, ok, tuning)) cands.push({ r: Math.min(...frets.filter((f) => f >= 0)) + 0.5, frets, fingers });
    }
    if (cands.length) break;
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.r - b.r);
  return finish(cands[0].frets, cands[0].fingers, tuning.length);
}

/** MusicXML <frame> for a diagram (MuseScore and Finale show it as a chord box). */
export function frameXml(d) {
  if (!d) return '';
  let x = `<frame><frame-strings>${d.strings}</frame-strings><frame-frets>${Math.max(4, Math.max(...d.frets) - d.base + 1)}</frame-frets>`;
  if (d.base > 1) x += `<first-fret>${d.base}</first-fret>`;
  d.frets.forEach((f, i) => {
    if (f < 0) return;
    const s = d.strings - i; // MusicXML counts strings from the highest
    let fn = `<frame-note><string>${s}</string><fret>${f}</fret>`;
    if (d.fingers[i]) fn += `<fingering>${d.fingers[i]}</fingering>`;
    if (d.barre && f === d.barre.fret && i === d.barre.from) fn += '<barre type="start"/>';
    else if (d.barre && f === d.barre.fret && i === d.barre.to) fn += '<barre type="stop"/>';
    x += fn + '</frame-note>';
  });
  return x + '</frame>';
}

/** Common chords to offer for a key (fifths), with sevenths and sus chords, as symbols. */
export function chordChoices(fifths = 0, set = 'guitar') {
  const scale = { 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', '-1': 'F', '-2': 'Bb', '-3': 'Eb', '-4': 'Ab' }[fifths] || 'C';
  const c = parseChord(scale);
  if (!c) return [];
  const r = rootPc(c);
  const nm = (pc, flat) => (flat ? ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'])[pc];
  const flat = fifths < 0;
  const deg = (s) => nm((r + s) % 12, flat);
  const list = [deg(0), `${deg(2)}m`, `${deg(4)}m`, deg(5), deg(7), `${deg(9)}m`, `${deg(7)}7`, `${deg(9)}m7`, `${deg(2)}m7`, `${deg(0)}maj7`, `${deg(5)}maj7`, `${deg(4)}7`, `${deg(2)}7`, `${deg(7)}sus4`, `${deg(0)}sus2`, `${deg(11)}dim`];
  return [...new Set(list)].filter((x) => diagramFor(x, set)).map((x) => formatChord(parseChord(x)));
}
