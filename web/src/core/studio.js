// The studio's score operations (Part 2 F, MuseScore 4 style): instruments (add, change, remove a part),
// palettes (key signature, tempo, dynamics, articulations), lead-sheet chords for whole bars, and the mix
// (volume, pan, mute, solo, sound for each part) turned into what plays. Plain data in and out.
import { INSTRUMENT_DEFS, soundOf } from './instruments.js';
import { ZERO } from './q.js';
import { performance as perfOf, secondsAt } from './score.js';
import { formatChord } from './chords.js';

const LOW = new Set(['cello', 'doublebass', 'bass', 'bassguitar', 'bassoon', 'trombone', 'tuba', 'tenor']);
const clefFor = (instrument) => {
  const c = INSTRUMENT_DEFS[instrument]?.clef;
  if (LOW.has(instrument)) return { sign: 'F', line: 4 };
  return c ? { sign: c.sign, line: c.line } : { sign: 'G', line: 2 };
};
const stavesFor = (instrument) => INSTRUMENT_DEFS[instrument]?.staves || 1;

let seq = 0;
const nid = (pi, mi, staff) => `s${Date.now().toString(36)}${(seq++).toString(36)}p${pi}m${mi}s${staff}`;

function restBar(dur, staff, pi, mi) {
  return { id: nid(pi, mi, staff), off: ZERO, dur, rest: true, pitch: null, voice: staff === 2 ? '5' : '1', staff, chord: false, type: null, dots: 0, tm: null,
    tie: { start: false, stop: false }, grace: null, cue: false, lyrics: [], beams: null, stem: null, notationsXml: '', measureRest: true, unpitched: null, tuplet: null, accidental: null };
}

/** A new part for an instrument, all rests, in the score's key. */
export function addPart(score, instrument) {
  const pi = score.parts.length;
  if (pi >= 8) return score;
  const staves = stavesFor(instrument);
  const first = score.parts[0];
  const measures = score.measures.map((m, mi) => {
    const src = first.measures[mi] || {};
    const notes = [restBar(m.dur, 1, pi, mi)];
    if (staves === 2) notes.push(restBar(m.dur, 2, pi, mi));
    return {
      ...(src.key ? { key: { ...src.key } } : {}),
      clefs: mi === 0 ? (staves === 2 ? [{ staff: 1, sign: 'G', line: 2, oct: 0, off: ZERO }, { staff: 2, sign: 'F', line: 4, oct: 0, off: ZERO }] : [{ staff: 1, ...clefFor(instrument), oct: 0, off: ZERO }]) : [],
      harmonies: [], notes, directions: [], extraAttrs: [],
    };
  });
  const id = `P${pi + 1}${Math.random().toString(36).slice(2, 5)}`;
  return { ...score, parts: [...score.parts, { id, name: instrument, abbr: '', instrument, program: null, transpose: null, staves, measures, percussion: !!INSTRUMENT_DEFS[instrument]?.percussion }] };
}

/** Removes a part (the last one stays). */
export function removePart(score, pi) {
  if (score.parts.length <= 1 || !score.parts[pi]) return score;
  return { ...score, parts: score.parts.filter((_, i) => i !== pi) };
}

/** Another instrument for a part (its name, sound and, for one-staff parts, its clef). */
export function setPartInstrument(score, pi, instrument) {
  const p = score.parts[pi];
  if (!p) return score;
  const measures = p.staves === 1 ? p.measures.map((m, mi) => (mi === 0 ? { ...m, clefs: [{ staff: 1, ...clefFor(instrument), oct: 0, off: ZERO }] } : m)) : p.measures;
  return { ...score, parts: score.parts.map((x, i) => (i === pi ? { ...x, name: instrument, instrument, measures, percussion: !!INSTRUMENT_DEFS[instrument]?.percussion } : x)) };
}

/** A key signature from a bar on (the notes keep their pitches, as in MuseScore's key palette). */
export function setKeySig(score, fifths, mi = 0) {
  const k = { fifths: Math.max(-7, Math.min(7, fifths)), mode: 'major' };
  return { ...score, parts: score.parts.map((p) => ({ ...p, measures: p.measures.map((m, i) => (i === mi ? { ...m, key: k } : i > mi && m.key ? { ...m, key: k } : m)) })) };
}

export const DYNAMICS = ['pp', 'p', 'mp', 'mf', 'f', 'ff'];
/** A dynamic mark under the staff at a place in a bar (replacing one already there). */
export function addDynamic(score, pi, mi, off, dyn, staff = 1) {
  if (!DYNAMICS.includes(dyn)) return score;
  const xml = `<direction placement="below"><direction-type><dynamics><${dyn}/></dynamics></direction-type><staff>${staff}</staff></direction>`;
  return { ...score, parts: score.parts.map((p, i) => (i !== pi ? p : { ...p, measures: p.measures.map((m, j) => (j !== mi ? m : {
    ...m, directions: [...(m.directions || []).filter((d) => !(d.dyn && d.off.eq(off) && (d.staff || 1) === staff)), { off, staff, xml, dyn }],
  })) })) };
}

export const ARTICULATIONS = { staccato: '<articulations><staccato/></articulations>', accent: '<articulations><accent/></articulations>',
  tenuto: '<articulations><tenuto/></articulations>', fermata: '<fermata/>' };
/** Adds or removes an articulation on a note. */
export function toggleArticulation(score, id, kind) {
  const add = ARTICULATIONS[kind];
  if (!add) return score;
  let changed = false;
  const parts = score.parts.map((p) => ({ ...p, measures: p.measures.map((m) => ({ ...m, notes: m.notes.map((n) => {
    if (n.id !== id || n.rest) return n;
    changed = true;
    const has = (n.notationsXml || '').includes(kind === 'fermata' ? '<fermata' : `<${kind}/>`);
    const inner = (n.notationsXml || '').replace(/^<notations>|<\/notations>$/g, '');
    const next = has ? inner.replace(add, '').replace(kind === 'fermata' ? /<fermata[^>]*\/>/ : new RegExp(`<${kind}/>`), '').replace('<articulations></articulations>', '') : inner + add;
    return { ...n, notationsXml: next || '' };
  }) })) }));
  return changed ? { ...score, parts } : score;
}

// ---------------------------------------------------------------- lead sheet
export const LEAD_CHORDS = { 0: ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'G7'], 1: ['G', 'Am', 'Bm', 'C', 'D', 'Em', 'D7'], 2: ['D', 'Em', 'F#m', 'G', 'A', 'Bm', 'A7'],
  3: ['A', 'Bm', 'C#m', 'D', 'E', 'F#m', 'E7'], 4: ['E', 'F#m', 'G#m', 'A', 'B', 'C#m', 'B7'], '-1': ['F', 'Gm', 'Am', 'Bb', 'C', 'Dm', 'C7'],
  '-2': ['Bb', 'Cm', 'Dm', 'Eb', 'F', 'Gm', 'F7'], '-3': ['Eb', 'Fm', 'Gm', 'Ab', 'Bb', 'Cm', 'Bb7'], '-4': ['Ab', 'Bbm', 'Cm', 'Db', 'Eb', 'Fm', 'Eb7'], 5: ['B', 'C#m', 'D#m', 'E', 'F#', 'G#m', 'F#7'] };
export const chordsForKey = (fifths) => LEAD_CHORDS[fifths] || LEAD_CHORDS[0];
/** The chord symbol at the start of each bar (lead sheet lane). */
export const barChords = (score) => score.measures.map((_, mi) => {
  const h = score.parts[0]?.measures[mi]?.harmonies || [];
  const x = h.find((y) => (y.off?.num?.() ?? 0) === 0) || h[0];
  return x ? (x.text || (x.chord ? formatChord(x.chord) : '')) : '';
});

// ---------------------------------------------------------------- the mix
export const DEFAULT_STRIP = { vol: 0.8, pan: 0, mute: false, solo: false, sound: null };
export const stripOf = (mix, part) => ({ ...DEFAULT_STRIP, ...(mix?.[part.id] || {}) });
/** Which parts are heard: solo wins over mute. */
export function audibleParts(score, mix) {
  const strips = score.parts.map((p) => stripOf(mix, p));
  const anySolo = strips.some((s) => s.solo);
  return strips.map((s) => (anySolo ? s.solo : !s.mute));
}
/** What the transport plays for a score (or a slice of it) with a mix. */
export function mixEvents(src, mix, fullScore = src) {
  const perf = perfOf(src, { repeats: false });
  const on = audibleParts(fullScore, mix);
  const evs = [];
  for (const e of perf.events) {
    const part = src.parts[e.pi];
    const fi = fullScore.parts.findIndex((p) => p.id === part?.id);
    if (fi >= 0 && !on[fi]) continue;
    const st = stripOf(mix, part || {});
    const a = secondsAt(perf.tempos, e.t);
    evs.push({ time: a, dur: secondsAt(perf.tempos, e.t.add(e.dur)) - a, midi: e.midi, vel: Math.round(30 + 75 * st.vol), inst: st.sound || soundOf(part?.instrument), pan: st.pan, ...(e.drum ? { drum: e.drum } : {}) });
  }
  return { evs, length: secondsAt(perf.tempos, perf.length) + 0.3 };
}
