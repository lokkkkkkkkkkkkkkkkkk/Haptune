// Writing a score note by note (the Write studio). A cursor stands at a place in a bar; entering a note of a
// length writes it there, over whatever was there, and moves on. Bars always stay full: what a new note
// covers is replaced, and any gap left is filled with rests. A note longer than what is left of the bar is
// cut to fit. Reaching the end adds a bar. Every function returns a new score (undo keeps the old one).
import { Q, q, ZERO } from './q.js';
import { typeFor, autoBeam, keyAt, timeAt, makeNote, newId, measureLength } from './score.js';
import { spellMidi, midiOf } from './pitch.js';
import { parseChord } from './chords.js';
import { parseMusicXML } from './musicxml.js';

/** Note lengths the palette offers, longest first, in quarter notes. */
export const LENGTHS = [
  { id: 'whole', q: q(4), glyph: '𝅝' }, { id: 'half', q: q(2), glyph: '𝅗𝅥' }, { id: 'quarter', q: q(1), glyph: '♩' },
  { id: 'eighth', q: q(1, 2), glyph: '♪' }, { id: '16th', q: q(1, 4), glyph: '𝅘𝅥𝅯' }, { id: '32nd', q: q(1, 8), glyph: '𝅘𝅥𝅰' },
];

const esc = (s) => String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const CLEF = { treble: ['G', 2], bass: ['F', 4], alto: ['C', 3] };
const LOW = new Set(['cello', 'bass', 'bassoon', 'trombone', 'tuba', 'doublebass']);

/**
 * A new, empty score: rests in every bar. instrument: a key of instruments.js; piano gets two staves.
 * key: fifths (-7..7); time: [beats, beatType]; tempo: crotchets a minute.
 */
export function blankScore({ title = 'Untitled', composer = '', instrument = 'piano', key = 0, mode = 'major', time = [4, 4], tempo = 90, bars = 8 } = {}) {
  const piano = instrument === 'piano' || instrument === 'keyboard';
  const staves = piano ? 2 : 1;
  const [beats, beatType] = time;
  const divisions = 4;
  const barDiv = Math.round(beats * 4 / beatType * divisions);
  const clef = piano ? null : LOW.has(instrument) ? CLEF.bass : CLEF.treble;
  const restBar = (staff) => `<note><rest measure="yes"/><duration>${barDiv}</duration><voice>${staff === 2 ? 5 : 1}</voice><staff>${staff}</staff></note>`;
  const measures = [];
  for (let i = 0; i < Math.max(1, bars); i++) {
    let m = `<measure number="${i + 1}">`;
    if (i === 0) {
      m += `<attributes><divisions>${divisions}</divisions><key><fifths>${key}</fifths><mode>${mode}</mode></key><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>`;
      if (piano) m += '<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>';
      else m += `<clef><sign>${clef[0]}</sign><line>${clef[1]}</line></clef>`;
      m += `</attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>`;
    }
    m += restBar(1);
    if (piano) m += `<backup><duration>${barDiv}</duration></backup>${restBar(2)}`;
    measures.push(`${m}</measure>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${esc(title)}</work-title></work>`
    + `<identification>${composer ? `<creator type="composer">${esc(composer)}</creator>` : ''}</identification>`
    + `<part-list><score-part id="P1"><part-name>${esc(instrument)}</part-name></score-part></part-list><part id="P1">${measures.join('')}</part></score-partwise>`;
  const score = parseMusicXML(xml);
  score.title = title;
  score.composer = composer;
  score.parts[0].instrument = instrument;
  score.parts[0].staves = staves;
  return score;
}

/** Splits a length into note values that need no tie (largest first): 5/4 → 1 + 1/4. */
export function splitLength(d) {
  const out = [];
  let left = d;
  for (let guard = 0; guard < 16 && left.gt(ZERO); guard++) {
    let piece = null;
    for (const L of LENGTHS) {
      for (const dot of [L.q.mul(q(3, 2)), L.q]) if (dot.le(left) && typeFor(dot) && (!piece || dot.gt(piece))) piece = dot;
    }
    if (!piece) piece = left;            // tuplets and odd remainders: kept as they are
    out.push(piece);
    left = left.sub(piece);
  }
  return out;
}

const sameVoice = (n, staff, voice) => (n.staff || 1) === staff && String(n.voice) === String(voice);
/** The voice written in this staff (piano left hand: the voice it already uses, else 5). */
function voiceOf(pm, staff) {
  const v = pm.notes.find((n) => (n.staff || 1) === staff && !n.grace);
  return v ? String(v.voice) : staff === 2 ? '5' : '1';
}

function rebuildMeasure(score, pi, mi, fn) {
  const time = timeAt(score, mi);
  return {
    ...score,
    parts: score.parts.map((part, i) => (i !== pi ? part : {
      ...part,
      measures: part.measures.map((pm, j) => {
        if (j !== mi) return pm;
        const notes = fn(pm.notes.map((n) => ({ ...n }))).map((n) => ({ ...n, accidental: null, beams: null }));
        notes.sort((a, b) => (a.staff || 1) - (b.staff || 1) || String(a.voice).localeCompare(String(b.voice)) || a.off.cmp(b.off) || (a.chord ? 1 : 0) - (b.chord ? 1 : 0));
        try { autoBeam(notes, time); } catch { /* the engraver beams anyway */ }
        return { ...pm, notes };
      }),
    })),
  };
}

function restsFor(from, to, staff, voice) {
  const out = [];
  let at = from;
  for (const len of splitLength(to.sub(from))) {
    const tf = typeFor(len);
    out.push(makeNote({ id: newId('r'), off: at, dur: len, rest: true, voice, staff, type: tf?.type || 'quarter', dots: tf?.dots || 0 }));
    at = at.add(len);
  }
  return out;
}

/** Adds `n` empty bars at the end (every part). */
export function addBars(score, n = 1) {
  let out = score;
  for (let k = 0; k < n; k++) {
    const last = out.measures[out.measures.length - 1];
    const time = timeAt(out, out.measures.length - 1);
    const dur = measureLength(time);
    const start = last ? last.start.add(last.dur) : ZERO;
    const meta = { number: String(out.measures.length + 1), implicit: false, start, dur, time: null, tempo: null, left: {}, right: {}, jumps: {} };
    out = {
      ...out,
      measures: [...out.measures.map((m, i) => (i === out.measures.length - 1 && m.right?.barStyle === 'light-heavy' ? { ...m, right: {} } : m)), meta],
      parts: out.parts.map((p) => {
        const pmLast = p.measures[p.measures.length - 1];
        const staves = p.staves || 1;
        const notes = [];
        for (let st = 1; st <= staves; st++) {
          const v = pmLast ? voiceOf(pmLast, st) : st === 2 ? '5' : '1';
          notes.push(makeNote({ id: newId('r'), off: ZERO, dur, rest: true, measureRest: true, voice: v, staff: st, type: typeFor(dur)?.type || 'whole' }));
        }
        return { ...p, measures: [...p.measures, { key: null, clefs: [], harmonies: [], notes, directions: [], extraAttrs: [] }] };
      }),
    };
  }
  return out;
}

/** Removes the last bar if it holds only rests (and leaves at least one). */
export function trimEmptyEnd(score) {
  let out = score;
  while (out.measures.length > 1) {
    const mi = out.measures.length - 1;
    if (out.parts.some((p) => p.measures[mi]?.notes.some((n) => !n.rest) || p.measures[mi]?.harmonies?.length)) break;
    out = { ...out, measures: out.measures.slice(0, -1), parts: out.parts.map((p) => ({ ...p, measures: p.measures.slice(0, -1) })) };
  }
  return out;
}

/** The place after a length: the next bar when the bar is full (adding a bar at the end if needed). */
function advance(score, cur, len) {
  let { mi, off } = cur;
  off = off.add(len);
  let out = score;
  if (off.ge(out.measures[mi].dur)) {
    mi += 1; off = ZERO;
    if (mi >= out.measures.length) out = addBars(out, 1);
  }
  return { score: out, cur: { ...cur, mi, off } };
}

/**
 * Writes a note (midi) or a rest (midi = null) of length `len` at the cursor {pi, staff, mi, off}.
 * Returns {score, cur (the next place), id (the note written)}.
 */
export function writeAt(score, cur, { midi = null, len }) {
  let out = score;
  let { mi, off } = cur;
  if (mi >= out.measures.length) out = addBars(out, mi - out.measures.length + 1);
  if (off.ge(out.measures[mi].dur)) { mi += 1; off = ZERO; if (mi >= out.measures.length) out = addBars(out, 1); }
  const pi = cur.pi || 0, staff = cur.staff || 1;
  const pm0 = out.parts[pi].measures[mi];
  const voice = voiceOf(pm0, staff);
  const barLen = out.measures[mi].dur;
  const end0 = off.add(len);
  const end = end0.gt(barLen) ? barLen : end0;
  const fifths = (keyAt(out.parts[pi], mi) || { fifths: 0 }).fifths;
  const pitch = midi === null ? null : spellMidi(midi, fifths);
  const pieces = splitLength(end.sub(off));
  const ids = pieces.map(() => newId());
  out = rebuildMeasure(out, pi, mi, (notes) => {
    const others = notes.filter((n) => !sameVoice(n, staff, voice));
    const mine = notes.filter((n) => sameVoice(n, staff, voice) && !n.grace);
    const kept = [];
    for (const n of mine) {
      const s = n.off, e = n.off.add(n.dur);
      if (e.le(off) || s.ge(end)) { kept.push({ ...n, measureRest: false }); continue; }
      if (s.lt(off) && !n.tm) {
        const tf = typeFor(off.sub(s));
        if (tf) kept.push({ ...n, dur: off.sub(s), type: tf.type, dots: tf.dots, measureRest: false, tie: { start: false, stop: !!n.tie?.stop } });
      }
    }
    let at = off;
    pieces.forEach((len2, k) => {
      const tf = typeFor(len2);
      kept.push(makeNote({ id: ids[k], off: at, dur: len2, rest: midi === null, pitch, voice, staff, type: tf?.type || 'quarter', dots: tf?.dots || 0,
        tie: { start: midi !== null && k < pieces.length - 1, stop: midi !== null && k > 0 } }));
      at = at.add(len2);
    });
    // fill every gap with rests, so the bar is exactly full
    const heads = kept.filter((n) => !n.chord).sort((a, b) => a.off.cmp(b.off));
    const filled = [];
    let pos = ZERO;
    for (const n of heads) {
      if (n.off.gt(pos)) filled.push(...restsFor(pos, n.off, staff, voice));
      pos = n.off.add(n.dur).gt(pos) ? n.off.add(n.dur) : pos;
    }
    if (pos.lt(barLen)) filled.push(...restsFor(pos, barLen, staff, voice));
    return [...others, ...kept, ...filled];
  });
  const next = advance(out, { ...cur, pi, staff, mi, off }, end.sub(off));
  return { score: next.score, cur: next.cur, id: ids[0] };
}

/** The note or rest that starts at the cursor's place (or the one sounding there), in its staff. */
export function noteAt(score, cur) {
  const pm = score.parts[cur.pi || 0]?.measures[cur.mi];
  if (!pm) return null;
  const staff = cur.staff || 1;
  const list = pm.notes.filter((n) => (n.staff || 1) === staff && !n.chord && !n.grace).sort((a, b) => a.off.cmp(b.off));
  return list.find((n) => n.off.le(cur.off) && n.off.add(n.dur).gt(cur.off)) || null;
}

/** The note just before the cursor (what Backspace removes, what "add to chord" adds to). */
export function noteBefore(score, cur) {
  let { mi, off } = cur;
  const staff = cur.staff || 1;
  for (let guard = 0; guard < 4 && mi >= 0; guard++) {
    const pm = score.parts[cur.pi || 0]?.measures[mi];
    const list = (pm?.notes || []).filter((n) => (n.staff || 1) === staff && !n.chord && !n.grace && n.off.lt(off)).sort((a, b) => b.off.cmp(a.off));
    if (list.length) return { note: list[0], mi };
    mi -= 1;
    off = mi >= 0 ? score.measures[mi].dur : ZERO;
  }
  return null;
}

/** Backspace: the note before the cursor becomes a rest, and the cursor moves back to it. */
export function eraseBefore(score, cur) {
  const hit = noteBefore(score, cur);
  if (!hit) return { score, cur };
  const n = hit.note;
  const out = rebuildMeasure(score, cur.pi || 0, hit.mi, (notes) => notes
    .filter((x) => !(x.chord && x.off.eq(n.off) && sameVoice(x, n.staff || 1, n.voice)))
    .map((x) => (x.id === n.id ? { ...x, rest: true, pitch: null, tie: { start: false, stop: false }, lyrics: [], notationsXml: '' } : x)));
  return { score: out, cur: { ...cur, mi: hit.mi, off: n.off } };
}

/** Adds a pitch to the note before the cursor (making a chord). */
export function addToChord(score, cur, midi) {
  const hit = noteBefore(score, cur);
  if (!hit || hit.note.rest) return { score, id: null };
  const n = hit.note;
  const fifths = (keyAt(score.parts[cur.pi || 0], hit.mi) || { fifths: 0 }).fifths;
  const pitch = spellMidi(midi, fifths);
  const pm = score.parts[cur.pi || 0].measures[hit.mi];
  const chord = pm.notes.filter((x) => x.off.eq(n.off) && sameVoice(x, n.staff || 1, n.voice) && !x.rest);
  if (chord.some((x) => midiOf(x.pitch) === midi)) return { score, id: null };
  const id = newId();
  const out = rebuildMeasure(score, cur.pi || 0, hit.mi, (notes) => [...notes, makeNote({ ...n, id, chord: true, pitch, lyrics: [], tie: {}, notationsXml: '' })]);
  return { score: out, id };
}

/** Sets (or clears, with '') the chord symbol at the start of a bar, or at `off` in it. */
export function setChordSymbol(score, mi, text, off = ZERO) {
  const chord = text ? parseChord(text) : null;
  if (text && !chord) return null;
  return {
    ...score,
    parts: score.parts.map((p, i) => (i !== 0 ? p : {
      ...p,
      measures: p.measures.map((pm, j) => (j !== mi ? pm : {
        ...pm, harmonies: [...(pm.harmonies || []).filter((h) => !h.off.eq(off)), ...(chord ? [{ off, chord, text: null, printed: null }] : [])].sort((a, b) => a.off.cmp(b.off)),
      })),
    })),
  };
}

/** Moves the cursor by one note (d = 1 or -1), into the next or previous bar at the ends. */
export function step(score, cur, d) {
  const n = noteAt(score, cur);
  if (d > 0) {
    if (n) return advance(score, { ...cur, off: n.off }, n.dur).cur;
    return cur;
  }
  if (cur.off.gt(ZERO)) {
    const b = noteBefore(score, cur);
    return b ? { ...cur, mi: b.mi, off: b.note.off } : { ...cur, off: ZERO };
  }
  if (cur.mi === 0) return cur;
  const b = noteBefore(score, cur);
  return b ? { ...cur, mi: b.mi, off: b.note.off } : { ...cur, mi: cur.mi - 1, off: ZERO };
}

/** Renames the score (title, composer) and its tempo. */
export function setInfo(score, { title, composer, tempo } = {}) {
  const out = { ...score };
  if (title !== undefined) out.title = title;
  if (composer !== undefined) out.composer = composer;
  if (tempo) out.measures = score.measures.map((m, i) => (i === 0 ? { ...m, tempo } : m));
  return out;
}

export { Q };
