// Editing a score note by note. Every operation returns a new score (the old one is never changed, so undo
// is just keeping the previous one) and keeps each bar exactly as long as it was: a pitch moves, a note
// becomes a rest, a note is split in two or joined to the next, a chord note is added or removed.
import { ZERO } from './q.js';
import { typeFor, autoBeam, keyAt, timeAt, makeNote, newId } from './score.js';
import { midiOf, spellMidi, keyAlter, STEPS, stepIndex } from './pitch.js';

/** Where a note is: {pi, mi, ni, note, part, pm}, or null. */
export function findNote(score, id) {
  for (let pi = 0; pi < score.parts.length; pi++) {
    const part = score.parts[pi];
    for (let mi = 0; mi < part.measures.length; mi++) {
      const ni = part.measures[mi].notes.findIndex((n) => n.id === id);
      if (ni >= 0) return { pi, mi, ni, note: part.measures[mi].notes[ni], part, pm: part.measures[mi] };
    }
  }
  return null;
}

function withMeasure(score, pi, mi, fn) {
  const time = timeAt(score, mi);
  return {
    ...score,
    parts: score.parts.map((part, i) => (i !== pi ? part : {
      ...part,
      measures: part.measures.map((pm, j) => {
        if (j !== mi) return pm;
        const notes = fn(pm.notes.map((n) => ({ ...n }))).map((n) => ({ ...n, accidental: null, beams: null }));
        notes.sort((a, b) => (a.staff || 1) - (b.staff || 1) || String(a.voice).localeCompare(String(b.voice)) || a.off.cmp(b.off) || (a.chord ? 1 : 0) - (b.chord ? 1 : 0));
        try { autoBeam(notes, time); } catch { /* beams are drawn by the engraver anyway */ }
        return { ...pm, notes };
      }),
    })),
  };
}

const sameSlot = (a, b) => a.voice === b.voice && (a.staff || 1) === (b.staff || 1);
/** The notes sounding together with this one (same voice, staff and start): the whole chord. */
const chordOf = (notes, n) => notes.filter((x) => sameSlot(x, n) && x.off.eq(n.off) && !x.grace === !n.grace);

/** The tied-on notes after this one (same pitch, next in the voice), across bar lines. */
function tiedChain(score, loc) {
  const out = [];
  let { mi } = loc;
  let cur = loc.note;
  for (let guard = 0; guard < 64 && cur.tie?.start && cur.pitch; guard++) {
    const end = cur.off.add(cur.dur);
    let pm = score.parts[loc.pi].measures[mi];
    let next = pm.notes.find((x) => sameSlot(x, cur) && x.off.eq(end) && x.tie?.stop && x.pitch && midiOf(x.pitch) === midiOf(cur.pitch));
    if (!next) {
      mi += 1;
      pm = score.parts[loc.pi].measures[mi];
      next = pm?.notes.find((x) => sameSlot(x, cur) && x.off.isZero() && x.tie?.stop && x.pitch && midiOf(x.pitch) === midiOf(cur.pitch));
    }
    if (!next) break;
    out.push({ mi, id: next.id });
    cur = next;
  }
  return out;
}

/**
 * Moves a note. how: 'up' | 'down' (to the next note of the key), 'sharp' | 'flat' (a semitone),
 * 'octaveUp' | 'octaveDown'. Notes tied to it move with it.
 */
export function movePitch(score, id, how) {
  const loc = findNote(score, id);
  if (!loc || !loc.note.pitch) return score;
  const key = keyAt(loc.part, loc.mi) || { fifths: 0 };
  const p = loc.note.pitch;
  let np;
  if (how === 'up' || how === 'down') {
    const abs = p.octave * 7 + stepIndex(p.step) + (how === 'up' ? 1 : -1);
    const step = STEPS[((abs % 7) + 7) % 7];
    np = { step, alter: keyAlter(key.fifths, step), octave: Math.floor(abs / 7) };
  } else if (how === 'sharp' || how === 'flat') {
    np = spellMidi(midiOf(p) + (how === 'sharp' ? 1 : -1), key.fifths);
  } else {
    np = { ...p, octave: p.octave + (how === 'octaveUp' ? 1 : -1) };
  }
  const m = midiOf(np);
  if (m < 12 || m > 120) return score;
  let out = score;
  for (const t of [{ mi: loc.mi, id }, ...tiedChain(score, loc)]) {
    out = withMeasure(out, loc.pi, t.mi, (notes) => notes.map((n) => (n.id === t.id ? { ...n, pitch: { ...np } } : n)));
  }
  return out;
}

/** A note becomes a rest (a note inside a chord is just taken out of the chord). */
export function toRest(score, id) {
  const loc = findNote(score, id);
  if (!loc || loc.note.rest) return score;
  return withMeasure(score, loc.pi, loc.mi, (notes) => {
    const n = notes.find((x) => x.id === id);
    const chord = chordOf(notes, n);
    if (chord.length > 1) {
      const rest = notes.filter((x) => x.id !== id);
      if (!n.chord) { const heir = rest.find((x) => chord.some((c) => c.id === x.id)); heir.chord = false; heir.lyrics = n.lyrics; }
      return rest;
    }
    return notes.map((x) => (x.id === id ? { ...x, rest: true, pitch: null, tie: { start: false, stop: false }, lyrics: [], notationsXml: '' } : x));
  });
}

/** A rest becomes a note (at `pitch`, or the last note before it in the part, or the key note). */
export function toNote(score, id, pitch = null) {
  const loc = findNote(score, id);
  if (!loc || !loc.note.rest) return score;
  let p = pitch;
  if (!p) {
    outer: for (let mi = loc.mi; mi >= 0; mi--) {
      const list = loc.part.measures[mi].notes;
      for (let i = (mi === loc.mi ? loc.ni : list.length) - 1; i >= 0; i--) if (list[i].pitch && (list[i].staff || 1) === (loc.note.staff || 1)) { p = { ...list[i].pitch }; break outer; }
    }
  }
  if (!p) p = spellMidi(loc.note.staff === 2 ? 48 : 71, (keyAt(loc.part, loc.mi) || { fifths: 0 }).fifths);
  const time = timeAt(score, loc.mi);
  return withMeasure(score, loc.pi, loc.mi, (notes) => notes.flatMap((x) => {
    if (x.id !== id) return [x];
    if (!x.measureRest || typeFor(x.dur)) return [{ ...x, rest: false, measureRest: false, pitch: p, type: typeFor(x.dur)?.type || x.type, dots: typeFor(x.dur)?.dots ?? x.dots }];
    // a whole-bar rest in a metre like 3/4 or 6/8 has no single note value: use one note per beat group
    void time;
    return [{ ...x, rest: false, measureRest: false, pitch: p }];
  }));
}

/** Splits a note (or rest, or whole chord) into two of half the length. Returns the same score if it can't. */
export function splitNote(score, id) {
  const loc = findNote(score, id);
  if (!loc || loc.note.tm || loc.note.grace) return score;
  const half = loc.note.dur.div(2);
  const tf = typeFor(half);
  if (!tf || half.lt(1 / 16)) return score;
  return withMeasure(score, loc.pi, loc.mi, (notes) => {
    const n = notes.find((x) => x.id === id);
    const group = n.rest ? [n] : chordOf(notes, n);
    const ids = new Set(group.map((x) => x.id));
    const out = [];
    for (const x of notes) {
      if (!ids.has(x.id)) { out.push(x); continue; }
      out.push({ ...x, dur: half, type: tf.type, dots: tf.dots, measureRest: false, tie: { start: false, stop: !!x.tie?.stop } });
      out.push(makeNote({ ...x, id: newId(), off: x.off.add(half), dur: half, type: tf.type, dots: tf.dots, measureRest: false, lyrics: [], tie: { start: !!x.tie?.start, stop: false }, notationsXml: '' }));
    }
    return out;
  });
}

/** Joins a note with whatever follows it in the same voice of the bar: it gets both lengths. */
export function joinNext(score, id) {
  const loc = findNote(score, id);
  if (!loc || loc.note.tm || loc.note.grace) return score;
  const n0 = loc.note;
  const end = n0.off.add(n0.dur);
  const nexts = loc.pm.notes.filter((x) => sameSlot(x, n0) && x.off.eq(end) && !x.grace);
  if (!nexts.length || nexts[0].tm) return score;
  const dur = n0.dur.add(nexts[0].dur);
  const tf = typeFor(dur);
  if (!tf) return score;
  const gone = new Set(nexts.map((x) => x.id));
  return withMeasure(score, loc.pi, loc.mi, (notes) => {
    const group = new Set((n0.rest ? [n0] : chordOf(notes, notes.find((x) => x.id === id))).map((x) => x.id));
    return notes.filter((x) => !gone.has(x.id)).map((x) => (group.has(x.id) ? { ...x, dur, type: tf.type, dots: tf.dots, tie: { start: false, stop: !!x.tie?.stop } } : x));
  });
}

/** Adds a note to make (or grow) a chord: a third above the highest note, in the key. */
export function addChordNote(score, id) {
  const loc = findNote(score, id);
  if (!loc || loc.note.rest || !loc.note.pitch) return { score, id: null };
  const key = keyAt(loc.part, loc.mi) || { fifths: 0 };
  const chord = chordOf(loc.pm.notes, loc.note);
  const top = chord.reduce((a, b) => (midiOf(b.pitch) > midiOf(a.pitch) ? b : a));
  const abs = top.pitch.octave * 7 + stepIndex(top.pitch.step) + 2;
  const step = STEPS[abs % 7];
  const nid = newId();
  const first = chord.find((x) => !x.chord) || chord[0];
  const added = makeNote({ ...first, id: nid, chord: true, pitch: { step, alter: keyAlter(key.fifths, step), octave: Math.floor(abs / 7) }, lyrics: [], tie: {}, notationsXml: '' });
  return { score: withMeasure(score, loc.pi, loc.mi, (notes) => [...notes, added]), id: nid };
}

/** Bars [from, to] as a small score of their own (for drawing a few bars at a time while editing). */
export function sliceMeasures(score, from, to) {
  const a = Math.max(0, from), b = Math.min(score.measures.length - 1, to);
  let start = ZERO;
  const measures = score.measures.slice(a, b + 1).map((m, i) => {
    const out = { ...m, start, time: i === 0 ? (m.time || timeAt(score, a)) : m.time, tempo: i === 0 ? (m.tempo || null) : m.tempo, jumps: [] };
    start = start.add(m.dur);
    return out;
  });
  const parts = score.parts.map((part) => {
    const clefs = new Map();
    for (let mi = 0; mi <= a; mi++) for (const c of part.measures[mi]?.clefs || []) if (mi < a || !c.off || c.off.isZero()) clefs.set(c.staff || 1, { ...c, off: ZERO });
    return {
      ...part,
      measures: part.measures.slice(a, b + 1).map((pm, i) => (i === 0
        ? { ...pm, key: pm.key || keyAt(part, a), clefs: [...clefs.values(), ...(pm.clefs || []).filter((c) => c.off && !c.off.isZero())] }
        : pm)),
    };
  });
  return { ...score, title: '', composer: '', lyricist: '', measures, parts, meta: { ...score.meta, slice: [a, b] } };
}
