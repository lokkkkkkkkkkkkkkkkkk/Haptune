// Improvise on a piece's own melody without losing it: notes on strong beats and at phrase ends are
// anchors that never move, and the variation only decorates the notes between them.
//   light    : only adds notes around the original ones (every original note keeps its pitch and place)
//   balanced : also changes some weak-beat notes and rhythms
//   free     : more decoration, arpeggio fills and the odd octave leap; the anchors still lead the way
import { q, ZERO } from './q.js';
import { typeFor, timeAt, keyAt, measureLength, isCompound, autoBeam, makeNote } from './score.js';
import { midiOf, spellMidi } from './pitch.js';
import { rng } from './improv.js';
import { chordNotes } from './chords.js';

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SHARPS = 'FCGDAEB', FLATS = 'BEADGCF';
const keyAlter = (fifths, step) => (fifths > 0 && SHARPS.slice(0, fifths).includes(step) ? 1 : fifths < 0 && FLATS.slice(0, -fifths).includes(step) ? -1 : 0);

/** One scale step up (+1) or down (-1) in the key. */
export function scaleStep(p, dir, fifths) {
  let i = LETTERS.indexOf(p.step) + dir;
  let octave = p.octave;
  if (i > 6) { i = 0; octave++; }
  if (i < 0) { i = 6; octave--; }
  const step = LETTERS[i];
  return { step, alter: keyAlter(fifths, step), octave };
}
const letterIndex = (p) => p.octave * 7 + LETTERS.indexOf(p.step);
const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** A spelled chord tone placed at a given MIDI note. */
const toneAt = (tone, midi) => ({ step: tone.step, alter: tone.alter || 0, octave: Math.round((midi - STEP_PC[tone.step] - (tone.alter || 0)) / 12) - 1 });

/** Chord symbols in time order, from the first part that has any. */
function chordTrack(score) {
  for (const p of score.parts) {
    const out = [];
    p.measures.forEach((pm, mi) => (pm.harmonies || []).forEach((h) => { if (h.chord && !h.chord.nc) out.push({ mi, off: h.off, chord: h.chord }); }));
    if (out.length) return out.sort((a, b) => a.mi - b.mi || a.off.cmp(b.off));
  }
  return [];
}
const harmonyAt = (track, mi, off) => {
  let c = null;
  for (const h of track) { if (h.mi < mi || (h.mi === mi && h.off.le(off))) c = h.chord; else break; }
  return c;
};

/** Strong beats where notes are kept: the downbeat, plus the middle of 4/4, 2/2, 6/8 and 12/8. */
export function strongOffsets(time) {
  if (!time) return [ZERO];
  if (isCompound(time)) {
    if (time.beats === 6) return [ZERO, q(3, 2)];
    if (time.beats === 12) return [ZERO, q(3)];
    return [ZERO];
  }
  if ((time.beats === 4 && time.beatType === 4) || (time.beats === 2 && time.beatType === 2)) return [ZERO, q(2)];
  return [ZERO];
}

const STYLE_WEIGHTS = {
  pop: { passing: 3, neighbor: 2, dotted: 2, approach: 0.5, mordent: 0.3, arpeggio: 1, octave: 0.3 },
  ballad: { passing: 3, neighbor: 2, dotted: 1, approach: 0.3, mordent: 0.5, arpeggio: 2, octave: 0.2 },
  jazz: { passing: 2, neighbor: 1, dotted: 3, approach: 3, mordent: 0.3, arpeggio: 1, octave: 0.5 },
  blues: { passing: 1, neighbor: 2, dotted: 2, approach: 3, mordent: 0.2, arpeggio: 0.5, octave: 0.3 },
  bossa: { passing: 2, neighbor: 1, dotted: 1, approach: 2, mordent: 0.2, arpeggio: 1, octave: 0.2 },
  baroque: { passing: 3, neighbor: 2, dotted: 0.5, approach: 0.3, mordent: 3, arpeggio: 1.5, octave: 0.2 },
  pentatonic: { passing: 2, neighbor: 2, dotted: 1, approach: 0.2, mordent: 0.2, arpeggio: 1, octave: 0.3 },
  rock: { passing: 1, neighbor: 2, dotted: 2, approach: 1, mordent: 0.2, arpeggio: 1, octave: 0.6 },
};
// p: chance to decorate a weak-beat note; head: chance to decorate the tail of a long strong-beat note
// (the note still starts on its beat with its own pitch, so the tune stays easy to recognise)
const AMOUNT = {
  light: { p: 0.3, head: 0.3, allow: ['passing', 'neighbor', 'dotted', 'approach', 'mordent'], swap: 0 },
  balanced: { p: 0.55, head: 0.55, allow: ['passing', 'neighbor', 'dotted', 'approach', 'mordent', 'arpeggio'], swap: 0.15 },
  free: { p: 0.85, head: 0.8, allow: ['passing', 'neighbor', 'dotted', 'approach', 'mordent', 'arpeggio', 'octave'], swap: 0.3 },
};
const HEAD_SAFE = new Set(['passing', 'neighbor', 'dotted', 'approach', 'mordent', 'arpeggio']);

function cloneScore(score) {
  return {
    ...score,
    measures: score.measures.map((m) => ({ ...m })),
    parts: score.parts.map((p) => ({ ...p, measures: p.measures.map((pm) => ({ ...pm, notes: pm.notes.map((n) => ({ ...n, tie: { ...n.tie } })) })) })),
  };
}

function piece(base, off, dur, pitch, varied) {
  const tf = typeFor(dur);
  if (!tf) return null;
  return makeNote({ off, dur, pitch, voice: base.voice, staff: base.staff, type: tf.type, dots: tf.dots, varied });
}

/**
 * @returns {{score, changed: number, added: number, kept: number, total: number, similarity: number, changedIds: Set<string>}}
 */
export function varyMelody(score, opts = {}) {
  // a light touch can land on nothing to change; try a few more ideas before saying "no change"
  let res = null;
  for (let k = 0; k < 5; k++) {
    res = varyOnce(score, { ...opts, seed: (opts.seed ?? 1) + k * 7717 });
    if (res.changed > 0) break;
  }
  return res;
}

function varyOnce(score, { amount = 'light', style = 'pop', seed = 1, part = 0, staff = 1 } = {}) {
  const A = AMOUNT[amount] || AMOUNT.light;
  const W = STYLE_WEIGHTS[style] || STYLE_WEIGHTS.pop;
  const out = cloneScore(score);
  const p = out.parts[part];
  const changedIds = new Set();
  let total = 0, kept = 0, added = 0, swapped = 0;
  if (!p) return { score: out, changed: 0, added: 0, kept: 0, total: 0, similarity: 1, changedIds };
  const lastMi = out.measures.length - 1;
  const chords = chordTrack(out);
  // the melody voice of the staff: the voice with the most notes
  const counts = new Map();
  p.measures.forEach((pm) => pm.notes.forEach((n) => { if ((n.staff || 1) === staff && !n.rest && !n.chord) counts.set(n.voice, (counts.get(n.voice) || 0) + 1); }));
  const voice = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '1';

  p.measures.forEach((pm, mi) => {
    const time = timeAt(out, mi);
    const key = keyAt(p, mi) || { fifths: 0 };
    const fifths = key.fifths || 0;
    const strong = strongOffsets(time);
    const mel = pm.notes.filter((n) => (n.staff || 1) === staff && n.voice === voice && !n.chord && !n.grace);
    const others = pm.notes.filter((n) => !mel.includes(n));
    const chordAt = new Set(pm.notes.filter((n) => n.chord).map((n) => String(n.off)));
    mel.forEach((n) => { if (!n.rest) total++; });
    const hasTuplet = mel.some((n) => n.tm);
    const phraseEnd = mi === lastMi || (mi + 1) % 2 === 0;
    const lastSounding = [...mel].reverse().find((n) => !n.rest);
    const result = [];
    mel.forEach((n, i) => {
      // one random stream per note: for the same seed, more change only adds to what less change did
      const r = rng(seed * 7919 + 13 + mi * 1013 + i * 37);
      const u = r();
      const next = mel.slice(i + 1).find((x) => !x.rest) || nextMeasureFirst(p, mi + 1, staff, voice);
      const fixed = n.rest || hasTuplet || n.tie.start || n.tie.stop || chordAt.has(String(n.off))
        || (phraseEnd && n === lastSounding) || mi === lastMi || n.lyrics?.length > 1;
      const onBeat = strong.some((s) => s.eq(n.off));
      // a strong-beat note keeps its start and pitch; only a long one may get a decoration in its second half
      const head = !fixed && onBeat && n.dur.ge(q(1)) && u < A.head;
      if (fixed || (onBeat && !head) || (!onBeat && u > A.p)) { result.push(n); if (!n.rest) kept++; return; }
      const choice = pickTechnique(r, A, W, n, next, head ? HEAD_SAFE : null);
      const repl = choice ? apply(choice, n, next, fifths, r, harmonyAt(chords, mi, n.off)) : null;
      if (!repl && head) { result.push(n); kept++; return; }
      if (!repl) {
        // balanced/free: sometimes swap a weak-beat note for its neighbour (same rhythm)
        if (A.swap && r() < A.swap && n.pitch) {
          const nb = scaleStep(n.pitch, r() < 0.5 ? 1 : -1, fifths);
          const nn = { ...n, pitch: nb, varied: true };
          result.push(nn);
          changedIds.add(nn.id);
          swapped++;
          return;
        }
        result.push(n); kept++;
        return;
      }
      repl.forEach((x, k) => {
        result.push(x);
        if (k === 0 && x.pitch && n.pitch && midiOf(x.pitch) === midiOf(n.pitch) && x.off.eq(n.off)) kept++;   // original note, shortened
        else {
          changedIds.add(x.id);
          if (k > 0) added++; else swapped++;
        }
      });
    });
    if (result.some((n, i) => n !== mel[i]) || result.length !== mel.length) {
      result.forEach((n) => { if (n.varied || changedIds.has(n.id)) n.beams = null; });
      mel.forEach((n) => { n.beams = null; });
      pm.notes = [...others, ...result].sort((a, b) => a.off.cmp(b.off));
      autoBeam(pm.notes.filter((n) => (n.staff || 1) === staff && n.voice === voice), time);
    }
  });
  const similarity = total ? Math.max(0, Math.min(1, (kept - 0.5 * swapped) / (total + 0.35 * added))) : 1;
  out.title = score.title ? `${score.title} – variation` : 'Variation';
  return { score: out, changed: changedIds.size, added, kept, total, similarity, changedIds };
}

function nextMeasureFirst(part, mi, staff, voice) {
  const pm = part.measures[mi];
  if (!pm) return null;
  return pm.notes.find((n) => (n.staff || 1) === staff && n.voice === voice && !n.chord && !n.rest && !n.grace) || null;
}

function pickTechnique(r, A, W, n, next, only = null) {
  const opts = A.allow.filter((k) => W[k] > 0 && (!only || only.has(k)));
  const weights = opts.map((k) => W[k]);
  for (let tries = 0; tries < 3; tries++) {
    const k = r.weighted(opts, weights);
    if (k === 'passing' && next?.pitch && Math.abs(letterIndex(next.pitch) - letterIndex(n.pitch)) === 2) return k;
    if (k === 'neighbor') return k;
    if (k === 'dotted' && n.dur.eq(q(1))) return k;
    if (k === 'approach' && next?.pitch && midiOf(next.pitch) !== midiOf(n.pitch)) return k;
    if (k === 'mordent' && (n.dur.eq(q(1)) || n.dur.eq(q(1, 2)))) return k;
    if (k === 'arpeggio' && n.dur.ge(q(2))) return k;
    if (k === 'octave' && next?.pitch) return k;
  }
  return null;
}

function apply(kind, n, next, fifths, r, chord = null) {
  const half = n.dur.div(2);
  switch (kind) {
    case 'passing': {
      const dir = letterIndex(next.pitch) > letterIndex(n.pitch) ? 1 : -1;
      return both(n, half, scaleStep(n.pitch, dir, fifths));
    }
    case 'neighbor': {
      const dir = next?.pitch && midiOf(next.pitch) < midiOf(n.pitch) ? -1 : 1;
      return both(n, half, scaleStep(n.pitch, r() < 0.7 ? dir : -dir, fifths));
    }
    case 'dotted': {                                  // quarter -> dotted eighth + sixteenth leading on
      const a = piece(n, n.off, q(3, 4), n.pitch, false);
      const dir = next?.pitch && midiOf(next.pitch) < midiOf(n.pitch) ? -1 : 1;
      const b = piece(n, n.off.add(q(3, 4)), q(1, 4), scaleStep(n.pitch, dir, fifths), true);
      return a && b ? [keepId(a, n), b] : null;
    }
    case 'approach': {                                // a half-step into the next note
      const m = midiOf(next.pitch) + (midiOf(next.pitch) > midiOf(n.pitch) ? -1 : 1);
      return both(n, half, spellMidi(m, fifths));
    }
    case 'mordent': {                                 // note, upper neighbour, note
      const s = n.dur.div(4);
      const a = piece(n, n.off, s, n.pitch, false);
      const b = piece(n, n.off.add(s), s, scaleStep(n.pitch, 1, fifths), true);
      const c = piece(n, n.off.add(s.mul(2)), n.dur.sub(s.mul(2)), n.pitch, true);
      return a && b && c ? [keepId(a, n), b, c] : null;
    }
    case 'arpeggio': {                                // long note -> chord tones going up, in eighths
      const steps = Math.min(8, Number(n.dur.div(q(1, 2)).num()));
      const tones = chordNotes(chord);
      const pcs = tones.map((x) => (((STEP_PC[x.step] + (x.alter || 0)) % 12) + 12) % 12);
      const start = midiOf(n.pitch);
      const outN = [];
      let pitch = n.pitch, m = start;
      for (let i = 0; i < steps; i++) {
        const x = piece(n, n.off.add(q(i, 2)), q(1, 2), pitch, i > 0);
        if (!x) return null;
        outN.push(i === 0 ? keepId(x, n) : x);
        if (tones.length) {                           // the song's own chord, from its chord symbols
          let k = m + 1;
          while (!pcs.includes(((k % 12) + 12) % 12)) k++;
          if (k > start + 12) k = start;
          m = k;
          pitch = k === start ? n.pitch : toneAt(tones[pcs.indexOf(((k % 12) + 12) % 12)], k);
        } else {                                      // no chords: the triad on this note, in the key
          pitch = scaleStep(scaleStep(pitch, 1, fifths), 1, fifths);
          if (midiOf(pitch) > start + 12) pitch = n.pitch;
        }
      }
      return outN;
    }
    case 'octave': {
      const up = midiOf(next.pitch) > midiOf(n.pitch);
      const moved = { ...n.pitch, octave: n.pitch.octave + (up ? 1 : -1) };
      if (Math.abs(midiOf(moved) - midiOf(next.pitch)) > 12) return null;
      return [{ ...n, pitch: moved, varied: true }];
    }
    default: return null;
  }
}

function both(n, half, second) {
  const a = piece(n, n.off, half, n.pitch, false);
  const b = piece(n, n.off.add(half), half, second, true);
  return a && b ? [keepId(a, n), b] : null;
}

/** The first part of a split keeps the original id (so lyrics, highlights and history still point at it). */
function keepId(x, n) {
  return { ...x, id: n.id, lyrics: n.lyrics || [], notationsXml: n.notationsXml || '' };
}
