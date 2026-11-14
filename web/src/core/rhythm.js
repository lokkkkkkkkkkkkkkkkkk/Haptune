// Rhythm and comping patterns for chord songs: how the accompaniment plays each chord, per style and time
// signature. Used by the chord-sheet editor (playback, Play Along backing) and by Sounds ("Add backing").
// A pattern is a string of slots, one per eighth note (per eighth in 6/8 too):
//   B bass root   b bass fifth   C block chord   D strum down   U strum up (lighter)   A next arpeggio note   . rest
// Drums use their own string: k kick, s snare, h hi-hat, r rim, p ride (two instruments in a slot: "kh").
import { parseChord, chordPcs, rootPc, bassPc } from './chords.js';

export const RHYTHMS = {
  pop: { name: 'Pop strum', times: { '4/4': { comp: 'BDDUBUDU', drums: ['kh', 'h', 'sh', 'h', 'kh', 'kh', 'sh', 'h'] }, '3/4': { comp: 'BDDUDU', drums: ['kh', 'h', 'sh', 'h', 'sh', 'h'] } }, sound: 'guitar' },
  ballad: { name: 'Ballad', times: { '4/4': { comp: 'BAAAbAAA' }, '3/4': { comp: 'BAAAAA' } }, sound: 'piano' },
  waltz: { name: 'Waltz 3/4', times: { '3/4': { comp: 'B.C.C.', drums: ['k', '', 'h', '', 'h', ''] }, '4/4': { comp: 'B.C.b.C.' } }, sound: 'piano' },
  six8: { name: '6/8', times: { '6/8': { comp: 'BAAbAA', drums: ['kh', 'h', 'h', 'sh', 'h', 'h'] }, '4/4': { comp: 'BAAbAAAA' } }, sound: 'piano' },
  swing: { name: 'Swing', times: { '4/4': { comp: 'B.C.b..C', drums: ['p', 'p', 'pk', 'p', 'p', 'p', 'pk', 'p'] }, '3/4': { comp: 'B.C.C.' } }, sound: 'epiano', swing: 0.66 },
  bossa: { name: 'Bossa nova', times: { '4/4': { comp: 'B.CbB.Cb', drums: ['kh', 'h', 'rh', 'kh', 'kh', 'rh', 'h', 'kh'] } }, sound: 'guitar' },
  hymn: { name: 'Hymn (block chords)', times: { '4/4': { comp: 'C.C.C.C.' }, '3/4': { comp: 'C.C.C.' }, '6/8': { comp: 'C..C..' } }, sound: 'organ', voices: 4 },
};
export const RHYTHM_IDS = Object.keys(RHYTHMS);
const DRUM = { k: 'kick', s: 'snare', h: 'hat', r: 'rim', p: 'ride' };

const mod = (a, n) => ((a % n) + n) % n;
/** Close voicing of a chord from `low` upward (3 or 4 notes). */
export function voicing(name, { low = 52, voices = 3 } = {}) {
  const c = typeof name === 'string' ? parseChord(name) : name;
  if (!c || c.nc) return [];
  const pcs = [...new Set(chordPcs(c))];
  const notes = pcs.slice(0, Math.max(3, voices)).map((p) => low + mod(p - low, 12)).sort((a, b) => a - b);
  if (voices === 4 && notes.length === 3) notes.push(notes[0] + 12);        // hymn: double the root
  return notes;
}
export function bassNote(name, which = 0) {
  const c = typeof name === 'string' ? parseChord(name) : name;
  if (!c || c.nc) return null;
  const root = which === 0 ? bassPc(c) : mod(rootPc(c) + 7, 12);
  let m = 36 + mod(root - 36, 12);
  if (m > 47) m -= 12;
  return m;
}

/** The pattern for a style in a time signature (falling back to a plain chord on each beat). */
export function patternFor(style, beats, beatType) {
  const r = RHYTHMS[style] || RHYTHMS.pop;
  const key = `${beats}/${beatType}`;
  const slots = beatType === 8 ? beats : beats * 2;
  const p = r.times[key];
  if (p && p.comp.length === slots) return { comp: p.comp, drums: p.drums || null, slotQ: 0.5 };
  // any other metre: bass on 1, chord on every other beat
  const comp = Array.from({ length: slots }, (_, i) => (i === 0 ? 'B' : i % 2 === 0 ? 'C' : '.')).join('');
  return { comp, drums: null, slotQ: 0.5 };
}

/**
 * Accompaniment events for chord spans [{t, dur, name}] (times in quarter notes) in a style:
 * [{t, dur, midi, vel, inst: 'keys'|'bass'|'drums', drum?}] sorted by time. `bars` gives each bar's start, beats
 * and beat type, so 3/4 and 6/8 sections are played in their own metre.
 */
export function comp(spans, bars, { style = 'pop', drums = true } = {}) {
  const r = RHYTHMS[style] || RHYTHMS.pop;
  const out = [];
  const chordAt = (t) => { let c = null; for (const s of spans) { if (s.t <= t + 1e-9) c = s; else break; } return c && t < c.t + c.dur - 1e-9 ? c : null; };
  for (const bar of bars) {
    const { comp: pat, drums: dpat, slotQ } = patternFor(bar.style || style, bar.beats, bar.beatType);
    let arp = 0;
    for (let i = 0; i < pat.length; i++) {
      const t = bar.t + i * slotQ;
      const sp = chordAt(t);
      const ch = pat[i];
      if (sp && sp.name && ch !== '.') {
        const v = voicing(sp.name, { voices: r.voices || 3, low: r.voices === 4 ? 55 : 52 });
        const until = Math.min(sp.t + sp.dur, bar.t + bar.len);
        // hold to the next sounding slot of the pattern (or the chord change)
        let k = i + 1; while (k < pat.length && pat[k] === '.') k++;
        const hold = Math.max(slotQ, Math.min(until, bar.t + k * slotQ) - t);
        if (ch === 'B' || ch === 'b') { const m = bassNote(sp.name, ch === 'B' ? 0 : 1); if (m != null) out.push({ t, dur: hold, midi: m, vel: 76, inst: 'bass' }); }
        else if (ch === 'C') { v.forEach((m) => out.push({ t, dur: hold, midi: m, vel: r.voices === 4 ? 64 : 58, inst: 'keys' })); if (r.voices === 4) { const bn = bassNote(sp.name); if (bn != null) out.push({ t, dur: hold, midi: bn, vel: 64, inst: 'bass' }); } }
        else if (ch === 'D' || ch === 'U') {
          const notes = ch === 'D' ? v : [...v].reverse();
          notes.forEach((m, j) => out.push({ t: t + j * 0.02, dur: hold, midi: m, vel: ch === 'D' ? 62 : 46, inst: 'keys' }));
        } else if (ch === 'A') { const arpNotes = [...v, v[1] + 12]; out.push({ t, dur: hold, midi: arpNotes[arp++ % arpNotes.length], vel: 52, inst: 'keys' }); }
      }
      if (drums && dpat && dpat[i] && sp) for (const d of dpat[i]) out.push({ t, dur: slotQ, midi: 0, vel: d === 'k' ? 84 : d === 's' ? 76 : 44, inst: 'drums', drum: DRUM[d] });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Swing: off-beat eighths land later (ratio 0.66 = triplet feel). Times in quarter notes. */
export function swingTime(tq, ratio = 0) {
  if (!ratio) return tq;
  const beat = Math.floor(tq + 1e-9);
  const f = tq - beat;
  return f < 0.5 ? beat + (f / 0.5) * ratio : beat + ratio + ((f - 0.5) / 0.5) * (1 - ratio);
}
