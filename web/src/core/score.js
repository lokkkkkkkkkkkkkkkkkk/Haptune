// The score model shared by every importer, view, player and exporter.
//
// Score  { title, composer, lyricist, measures: Measure[], parts: Part[], meta }
// Measure (shared by all parts) { number, implicit, start: Q, dur: Q, time?, tempo?, left, right, jumps }
// Part   { id, name, abbr, instrument, program, transpose: {d,c}|null, staves, measures: PartMeasure[] }
// PartMeasure { key?, clefs: Clef[], harmonies: Harmony[], notes: Note[], directions: Direction[] }
// Note   { id, off: Q, dur: Q, rest, pitch|null, voice, staff, chord, type, dots, tm, tie:{start,stop},
//          grace, cue, lyrics, beams, stem, notationsXml }
// Every time value is an exact fraction of a quarter note (Q).
import { Q, q, ZERO, ONE, lcm } from './q.js';
import { midiOf, transposePitch, transposeKey, transposeInterval, iv, keyAlter, STEPS } from './pitch.js';
import { transposeChord } from './chords.js';

export const NOTE_TYPES = [
  ['maxima', q(32)], ['long', q(16)], ['breve', q(8)], ['whole', q(4)], ['half', q(2)], ['quarter', ONE],
  ['eighth', q(1, 2)], ['16th', q(1, 4)], ['32nd', q(1, 8)], ['64th', q(1, 16)], ['128th', q(1, 32)], ['256th', q(1, 64)],
];
const TYPE_LEN = Object.fromEntries(NOTE_TYPES.map(([t, v]) => [t, v]));

export function typeLength(type, dots = 0) {
  let v = TYPE_LEN[type] || ONE;
  let add = v;
  for (let i = 0; i < dots; i++) { add = add.div(2); v = v.add(add); }
  return v;
}

/** {type, dots} for a plain (non-tuplet) duration, or null if it needs a tie or tuplet. */
export function typeFor(dur) {
  for (const [t, v] of NOTE_TYPES) {
    if (dur.eq(v)) return { type: t, dots: 0 };
    if (dur.eq(v.mul(q(3, 2)))) return { type: t, dots: 1 };
    if (dur.eq(v.mul(q(7, 4)))) return { type: t, dots: 2 };
  }
  return null;
}

export function measureLength(time) {
  if (!time) return q(4);
  return q(time.beats * 4, time.beatType);
}

export function isCompound(time) {
  return time && time.beatType === 8 && time.beats % 3 === 0;
}

export function beatLength(time) {
  if (!time) return ONE;
  if (isCompound(time)) return q(3, 2);
  return q(4, time.beatType);
}

let idCounter = 0;
export function newId(prefix = 'n') { idCounter += 1; return `${prefix}${idCounter.toString(36)}`; }

export function emptyScore(title = 'Untitled') {
  return { title, composer: '', lyricist: '', measures: [], parts: [], meta: {} };
}

export function makeNote(fields) {
  return {
    id: fields.id || newId(), off: fields.off || ZERO, dur: fields.dur || ONE, rest: !!fields.rest,
    pitch: fields.pitch || null, voice: fields.voice || '1', staff: fields.staff || 1, chord: !!fields.chord,
    type: fields.type || null, dots: fields.dots || 0, tm: fields.tm || null,
    tie: { start: !!fields.tie?.start, stop: !!fields.tie?.stop }, grace: fields.grace || null, cue: !!fields.cue,
    lyrics: fields.lyrics || [], beams: fields.beams || null, stem: fields.stem || null, notationsXml: fields.notationsXml || '',
    measureRest: !!fields.measureRest, unpitched: fields.unpitched || null, tuplet: fields.tuplet || null,
    accidental: fields.accidental || null,
  };
}

// ---- reading helpers ----

/** Key (written) in force for a part at a measure. */
export function keyAt(part, mi) {
  for (let i = mi; i >= 0; i--) if (part.measures[i]?.key) return part.measures[i].key;
  return { fifths: 0, mode: 'major' };
}

export function timeAt(score, mi) {
  for (let i = mi; i >= 0; i--) if (score.measures[i]?.time) return score.measures[i].time;
  return { beats: 4, beatType: 4 };
}

export function tempoAt(score, mi) {
  for (let i = mi; i >= 0; i--) if (score.measures[i]?.tempo) return score.measures[i].tempo;
  return 100;
}

/** Concert (sounding) key of the score: first part without transposition, else part 0 corrected. */
export function concertKey(score) {
  const part = score.parts.find((p) => !p.transpose) || score.parts[0];
  if (!part) return { fifths: 0, mode: 'major' };
  const k = keyAt(part, 0);
  return part.transpose ? transposeKey(k, part.transpose) : k;
}

export function totalLength(score) {
  const last = score.measures[score.measures.length - 1];
  return last ? last.start.add(last.dur) : ZERO;
}

export function recomputeStarts(score) {
  let t = ZERO;
  for (const m of score.measures) { m.start = t; t = t.add(m.dur); }
}

export function* allNotes(score) {
  for (let pi = 0; pi < score.parts.length; pi++) {
    const part = score.parts[pi];
    for (let mi = 0; mi < part.measures.length; mi++) {
      for (const n of part.measures[mi].notes) yield { part, pi, mi, note: n };
    }
  }
}

export function pitchRange(score, partIndex = null) {
  let lo = Infinity, hi = -Infinity;
  for (const { pi, note, part } of allNotes(score)) {
    if (partIndex !== null && pi !== partIndex) continue;
    if (note.rest || !note.pitch || note.cue) continue;
    let p = note.pitch;
    if (part.transpose) p = transposePitch(p, part.transpose);
    const m = midiOf(p);
    lo = Math.min(lo, m); hi = Math.max(hi, m);
  }
  return lo === Infinity ? null : { lo, hi };
}

export function countNotes(score) {
  let notes = 0, rests = 0, chords = 0, lyrics = 0;
  for (const { note } of allNotes(score)) {
    if (note.rest) rests++; else notes++;
    if (note.lyrics?.length) lyrics++;
  }
  for (const p of score.parts) for (const pm of p.measures) chords += pm.harmonies.length;
  return { notes, rests, chords, lyrics, measures: score.measures.length, parts: score.parts.length };
}

/** All chord symbols in time order: [{t: Q, mi, off, chord, text}] from the first part that has any. */
export function chordTrack(score) {
  for (const part of score.parts) {
    const out = [];
    part.measures.forEach((pm, mi) => {
      for (const h of pm.harmonies) out.push({ t: score.measures[mi].start.add(h.off), mi, off: h.off, chord: h.chord, text: h.text });
    });
    if (out.length) return out.sort((a, b) => a.t.cmp(b.t));
  }
  return [];
}

// ---- transposition ----

/**
 * A new score moved by `semitones` (concert pitch), with the key signature, every note, chord symbol
 * and part key spelled by one interval so the result is exact and reversible.
 */
export function transposeScore(score, semitones, prefer) {
  if (!semitones) return score;
  const interval = transposeInterval(concertKey(score), semitones, prefer);
  return transposeBy(score, interval);
}

export function transposeBy(score, interval) {
  const out = { ...score, parts: score.parts.map((part) => ({
    ...part,
    measures: part.measures.map((pm) => ({
      ...pm,
      key: pm.key ? transposeKey(pm.key, interval) : pm.key,
      harmonies: pm.harmonies.map((h) => ({ ...h, chord: transposeChord(h.chord, interval), text: null })),
      notes: pm.notes.map((n) => (n.pitch ? { ...n, pitch: transposePitch(n.pitch, interval), accidental: null } : n)),
      // fret numbers no longer match after a key change
      directions: pm.directions,
    })),
  })) };
  out.meta = { ...score.meta, transposed: (score.meta?.transposed || 0) + interval.c };
  return out;
}

// ---- playback order (repeats, endings, D.C., D.S., Fine, Coda) ----

function endingNumbers(e) {
  return String(e.number || '1').split(/[,\s]+/).filter(Boolean).map(Number);
}

/** Measure indices in performance order. */
export function playOrder(score, { repeats = true } = {}) {
  const ms = score.measures;
  const n = ms.length;
  if (!repeats) return ms.map((_, i) => i);
  const order = [];
  let i = 0, repeatStart = 0, pass = 1;
  const passes = new Map();
  let jumped = false, dcDone = false, dsDone = false;
  const segno = ms.findIndex((m) => m.jumps?.segno);
  const coda = ms.findIndex((m, k) => m.jumps?.coda && k > 0);
  let guard = 0;
  while (i < n && guard++ < 20000) {
    const m = ms[i];
    if (m.left?.repeat === 'forward' && !jumped) {
      if (repeatStart !== i) { repeatStart = i; pass = passes.get(`p${i}`) || 1; }
    }
    const ending = m.left?.ending && m.left.ending.type === 'start' ? m.left.ending : null;
    if (ending && !jumped && !endingNumbers(ending).includes(pass)) {
      // skip to the end of this ending
      let j = i;
      while (j < n && !(ms[j].right?.ending && ['stop', 'discontinue'].includes(ms[j].right.ending.type))) j++;
      i = j + 1;
      continue;
    }
    if (ending && jumped && endingNumbers(ending).length && !endingNumbers(ending).includes(Math.max(...endingNumbers(ending)))) {
      // after D.C./D.S. take the last ending
    }
    order.push(i);
    if (jumped && m.jumps?.fine) break;
    if (jumped && m.jumps?.tocoda && coda > i) { i = coda; continue; }
    if (m.right?.repeat === 'backward' && !jumped) {
      const times = m.right.times || 2;
      const count = passes.get(i) || 1;
      if (count < times) {
        passes.set(i, count + 1);
        pass = count + 1;
        passes.set(`p${repeatStart}`, pass);
        i = repeatStart;
        continue;
      }
      passes.set(i, 1);
      pass = 1;
      passes.set(`p${repeatStart}`, 1);
      repeatStart = i + 1;
    }
    if (m.jumps?.dacapo && !dcDone) { dcDone = true; jumped = true; i = 0; pass = 1; continue; }
    if (m.jumps?.dalsegno && !dsDone && segno >= 0) { dsDone = true; jumped = true; i = segno; pass = 1; continue; }
    i++;
  }
  return order;
}

/**
 * Sounding events for playback: [{t, dur (Q, playback quarters), midi, vel, pi, staff, voice, ids:[noteIds], mi, off}]
 * plus measure spans in playback time and the tempo map. Ties are merged; grace notes are short.
 */
export function performance(score, { repeats = true, partFilter = null } = {}) {
  const order = playOrder(score, { repeats });
  const events = [];
  const spans = [];
  const tempos = [];
  let t = ZERO;
  let lastTempo = null;
  const openTies = new Map(); // key -> event
  for (const mi of order) {
    const m = score.measures[mi];
    spans.push({ mi, t, dur: m.dur });
    const tempo = m.tempo || (lastTempo === null ? tempoAt(score, mi) : null);
    if (tempo && tempo !== lastTempo) { tempos.push({ t, bpm: tempo }); lastTempo = tempo; }
    score.parts.forEach((part, pi) => {
      if (partFilter && !partFilter(part, pi)) return;
      const pm = part.measures[mi];
      if (!pm) return;
      for (const n of pm.notes) {
        if (n.rest || n.cue || (!n.pitch && !n.unpitched)) continue;
        let p = n.pitch;
        if (p && part.transpose) p = transposePitch(p, part.transpose);
        const midi = p ? midiOf(p) : 38;
        const start = t.add(n.off);
        const key = `${pi}:${n.staff}:${n.voice}:${midi}`;
        if (n.tie.stop && openTies.has(key)) {
          const ev = openTies.get(key);
          if (ev.t.add(ev.dur).eq(start)) {
            ev.dur = ev.dur.add(n.dur);
            ev.ids.push(n.id);
            if (!n.tie.start) openTies.delete(key);
            continue;
          }
        }
        const dur = n.grace ? q(1, 8) : n.dur;
        const ev = { t: n.grace ? start.sub(q(1, 16)) : start, dur, midi, vel: n.vel || 80, pi, staff: n.staff, voice: n.voice, ids: [n.id], mi, off: n.off, unpitched: !n.pitch };
        if (ev.t.lt(0)) ev.t = ZERO;
        events.push(ev);
        if (n.tie.start) openTies.set(key, ev); else openTies.delete(key);
      }
    });
    t = t.add(m.dur);
  }
  if (!tempos.length) tempos.push({ t: ZERO, bpm: 100 });
  events.sort((a, b) => a.t.cmp(b.t) || a.midi - b.midi);
  return { events, spans, tempos, length: t, order };
}

/** Seconds for a playback time (quarters) given a tempo map and a speed factor. */
export function secondsAt(tempos, tq, speed = 1) {
  let s = 0;
  let prevT = 0, prevBpm = tempos[0]?.bpm || 100;
  const target = typeof tq === 'number' ? tq : tq.num();
  for (const tp of tempos) {
    const tt = tp.t.num();
    if (tt >= target) break;
    s += (tt - prevT) * 60 / (prevBpm * speed);
    prevT = tt; prevBpm = tp.bpm;
  }
  s += (target - prevT) * 60 / (prevBpm * speed);
  return s;
}

/** Inverse of secondsAt. */
export function quartersAt(tempos, sec, speed = 1) {
  let s = 0;
  let prevT = 0, prevBpm = tempos[0]?.bpm || 100;
  for (const tp of tempos) {
    const tt = tp.t.num();
    const seg = (tt - prevT) * 60 / (prevBpm * speed);
    if (s + seg > sec) break;
    s += seg;
    prevT = tt; prevBpm = tp.bpm;
  }
  return prevT + (sec - s) * prevBpm * speed / 60;
}

// ---- writing durations as notes ----

const PLAIN = [q(4), q(3), q(2), q(3, 2), ONE, q(3, 4), q(1, 2), q(3, 8), q(1, 4), q(3, 16), q(1, 8), q(1, 16), q(1, 32)];
const TRIPLET = [q(4, 3), q(2, 3), q(1, 3), q(1, 6), q(1, 12)];

/**
 * Splits [off, off+dur) inside one measure into notatable pieces that follow the beat:
 * [{off, dur, type, dots, tm}] (consecutive pieces are tied by the caller).
 */
export function spellDuration(off, dur, time) {
  const beat = beatLength(time);
  const bar = measureLength(time);
  const half = time && time.beats === 4 && time.beatType === 4 ? q(2) : null;
  const pieces = [];
  let cur = off, rem = dur;
  let guard = 0;
  while (rem.gt(0) && guard++ < 64) {
    let chosen = null;
    const thirds = cur.d % 3 === 0 || rem.d % 3 === 0;
    if (thirds) {
      for (const v of TRIPLET) {
        if (v.gt(rem)) continue;
        const inBeat = cur.sub(beatStart(cur)).add(v).le(beat);
        if (inBeat) { chosen = { v, tm: { actual: 3, normal: 2 } }; break; }
      }
    }
    if (!chosen) {
      for (const v of PLAIN) {
        if (v.gt(rem)) continue;
        if (fits(cur, v, rem)) { chosen = { v, tm: null }; break; }
      }
    }
    if (!chosen) {
      // smallest step to the next 1/64 grid point, as a last resort
      chosen = { v: rem, tm: null };
    }
    const base = chosen.tm ? chosen.v.mul(q(3, 2)) : chosen.v;
    const tf = typeFor(base) || { type: 'quarter', dots: 0 };
    pieces.push({ off: cur, dur: chosen.v, type: tf.type, dots: tf.dots, tm: chosen.tm });
    cur = cur.add(chosen.v);
    rem = rem.sub(chosen.v);
  }
  return pieces;

  function beatStart(x) { return beat.mul(Math.floor(x.div(beat).num() + 1e-9)); }
  function fits(c, v, remaining) {
    if (c.add(v).gt(bar)) return false;
    const intoBeat = c.sub(beatStart(c));
    if (intoBeat.add(v).le(beat)) {
      // inside one beat: start on the 16th grid (or the note's own grid if it is shorter)
      const unit = typeFor(v)?.dots ? v.mul(q(2, 3)) : v;
      const grid = unit.lt(q(1, 4)) ? unit : q(1, 4);
      return intoBeat.div(grid).d === 1;
    }
    // a dotted quarter on the beat in simple time (♩. ♪) may run into the next beat
    if (!isCompound(time) && beat.eq(1) && intoBeat.isZero() && v.eq(q(3, 2)) && v.eq(remaining)) return true;
    // longer than a beat: start on a beat, last whole beats, and not cross the middle of a 4/4 bar
    if (!intoBeat.isZero()) return false;
    if (v.div(beat).d !== 1) return false;
    if (half && c.gt(0) && c.lt(half) && c.add(v).gt(half)) return false;
    return true;
  }
}

/** Notes for one voice of a measure from (off, dur, pitch|null) items: rests fill gaps, ties are added. */
export function notesFromSpans(items, time, { voice = '1', staff = 1, fillRests = true, measureDur } = {}) {
  const bar = measureDur || measureLength(time);
  const out = [];
  let cur = ZERO;
  const sorted = [...items].sort((a, b) => a.off.cmp(b.off));
  const pushRest = (from, to) => {
    if (!fillRests || !to.gt(from)) return;
    if (from.isZero() && to.eq(bar) && bar.eq(measureLength(time))) {
      out.push(makeNote({ off: from, dur: to.sub(from), rest: true, voice, staff, type: 'whole', measureRest: true }));
      return;
    }
    for (const pc of spellDuration(from, to.sub(from), time)) {
      out.push(makeNote({ off: pc.off, dur: pc.dur, rest: true, voice, staff, type: pc.type, dots: pc.dots, tm: pc.tm }));
    }
  };
  for (const it of sorted) {
    if (it.off.gt(cur)) pushRest(cur, it.off);
    const pieces = spellDuration(it.off, it.dur, time);
    pieces.forEach((pc, k) => {
      const pitches = it.pitches || (it.pitch ? [it.pitch] : [null]);
      pitches.forEach((p, j) => {
        out.push(makeNote({
          off: pc.off, dur: pc.dur, rest: !p, pitch: p, voice, staff, chord: j > 0, type: pc.type, dots: pc.dots, tm: pc.tm,
          tie: p ? { start: (it.tieOut && k === pieces.length - 1) || k < pieces.length - 1, stop: (it.tieIn && k === 0) || k > 0 } : {},
          lyrics: k === 0 && j === 0 && it.lyrics ? it.lyrics : [],
          id: k === 0 && j === 0 && it.id ? it.id : undefined,
          label: it.label,
        }));
      });
    });
    cur = it.off.add(it.dur);
  }
  if (cur.lt(bar)) pushRest(cur, bar);
  markTuplets(out);
  return out;
}

/** Adds tuplet start/stop brackets for runs of 3:2 notes within a beat. */
export function markTuplets(notes) {
  let run = [];
  let acc = ZERO;
  const flush = () => {
    if (run.length) {
      run[0].tuplet = { ...(run[0].tuplet || {}), start: true };
      run[run.length - 1].tuplet = { ...(run[run.length - 1].tuplet || {}), stop: true };
    }
    run = []; acc = ZERO;
  };
  for (const n of notes) {
    if (n.chord) continue;
    if (n.tm) {
      run.push(n);
      acc = acc.add(n.dur.mul(q(n.tm.actual, n.tm.normal)));
      // a full group spans a whole normal-note group: e.g. three triplet eighths = one quarter
      const groupLen = typeLength(n.type).mul(n.tm.normal);
      if (acc.ge(groupLen)) flush();
    } else flush();
  }
  flush();
}

/** Beams for a voice: groups eighths and shorter inside each beat. Mutates notes. */
export function autoBeam(notes, time) {
  const beat = beatLength(time);
  const groupLen = isCompound(time) ? beat : time && time.beatType === 8 ? q(3, 2) : beat;
  const byVoice = new Map();
  for (const n of notes) {
    if (n.chord || n.grace) continue;
    const k = `${n.staff}:${n.voice}`;
    if (!byVoice.has(k)) byVoice.set(k, []);
    byVoice.get(k).push(n);
  }
  for (const list of byVoice.values()) {
    let group = [];
    let groupIdx = null;
    const flush = () => {
      const beamable = group.filter((n) => !n.rest);
      if (group.length >= 2 && beamable.length >= 2 && !group[0].rest && !group[group.length - 1].rest) {
        group.forEach((n, i) => {
          const lv = beamLevels(n);
          const beams = [];
          for (let level = 1; level <= lv; level++) {
            const prevLv = i > 0 ? beamLevels(group[i - 1]) : 0;
            const nextLv = i < group.length - 1 ? beamLevels(group[i + 1]) : 0;
            let v;
            if (level === 1) v = i === 0 ? 'begin' : i === group.length - 1 ? 'end' : 'continue';
            else {
              const hasPrev = prevLv >= level, hasNext = nextLv >= level;
              v = hasPrev && hasNext ? 'continue' : hasPrev ? 'end' : hasNext ? 'begin' : (i === 0 ? 'forward hook' : 'backward hook');
            }
            beams.push({ n: level, v });
          }
          n.beams = beams;
        });
        // chord members share the beam of their first note
      }
      group = [];
    };
    for (const n of list) {
      const short = beamLevels(n) >= 1;
      const gi = Math.floor(n.off.div(groupLen).num() + 1e-9);
      if (!short || n.rest && group.length === 0) { flush(); groupIdx = null; continue; }
      if (groupIdx !== null && gi !== groupIdx) flush();
      groupIdx = gi;
      group.push(n);
      const end = n.off.add(n.dur);
      if (end.div(groupLen).d === 1) { flush(); groupIdx = null; }
    }
    flush();
  }
  // copy beams to chord members
  let lead = null;
  for (const n of notes) {
    if (!n.chord) lead = n;
    else if (lead && lead.beams) n.beams = lead.beams;
  }
}

function beamLevels(n) {
  return { eighth: 1, '16th': 2, '32nd': 3, '64th': 4 }[n.type] || 0;
}

/** Accidentals to print for a measure's notes given the key: mutates note.accidental. */
export function computeAccidentals(notes, key, carried = new Map()) {
  const state = new Map(); // `${staff}:${step}${octave}` -> alter
  const sorted = [...notes].filter((n) => n.pitch && !n.rest).sort((a, b) => a.off.cmp(b.off));
  for (const n of sorted) {
    const k = `${n.staff}:${n.pitch.step}${n.pitch.octave}`;
    const expected = state.has(k) ? state.get(k) : keyAlter(key?.fifths || 0, n.pitch.step);
    const alter = n.pitch.alter || 0;
    if (n.tie.stop && n.off.isZero() && carried.get(`${n.staff}:${n.pitch.step}${n.pitch.octave}`) === alter) {
      state.set(k, alter);
      n.accidental = null;
      continue;
    }
    if (alter !== expected) {
      n.accidental = { '-2': 'flat-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' }[alter];
      state.set(k, alter);
    } else n.accidental = null;
  }
  return state;
}

/** LCM of all denominators in a part (for MusicXML <divisions>). */
export function divisionsFor(part, measures) {
  let d = 1;
  part.measures.forEach((pm, mi) => {
    for (const n of pm.notes) { d = lcm(d, n.off.d); d = lcm(d, n.dur.d); }
    for (const h of pm.harmonies) d = lcm(d, h.off.d);
    for (const x of pm.directions) d = lcm(d, x.off.d);
    for (const c of pm.clefs || []) if (c.off) d = lcm(d, c.off.d);
    d = lcm(d, measures[mi].dur.d);
  });
  return d;
}

export { STEPS, iv };

/**
 * One part of a score (or one staff of a piano part: staff 1 = right hand, 2 = left hand) as its own score,
 * for showing and exporting just what a player plays. Shares notes' fractions; never mutates `score`.
 */
export function extractPart(score, pi, staff = null) {
  const part = score.parts[pi];
  if (!part) return score;
  const onStaff = (x) => (x.staff || 1) === staff;
  const one = {
    ...part,
    staves: staff ? 1 : part.staves,
    measures: part.measures.map((pm) => (!staff ? pm : {
      ...pm,
      notes: pm.notes.filter(onStaff).map((n) => ({ ...n, staff: 1 })),
      clefs: pm.clefs.filter(onStaff).map((c) => ({ ...c, staff: 1 })),
      directions: pm.directions.filter((d) => (d.staff || 1) === staff).map((d) => ({ ...d, staff: 1, xml: d.xml.replace(/<staff>\d+<\/staff>/g, '<staff>1</staff>') })),
      harmonies: staff === 1 ? pm.harmonies : [],
    })),
  };
  return { ...score, parts: [one] };
}

/** Which parts a player can pick: every instrument, and the two hands of a piano part. */
export function partChoices(score) {
  if (!score) return [];
  const out = [];
  score.parts.forEach((p, pi) => {
    const name = p.name || `Part ${pi + 1}`;
    if (p.staves > 1) {
      out.push({ id: `${pi}:1`, pi, staff: 1, hand: 'right', name });
      out.push({ id: `${pi}:2`, pi, staff: 2, hand: 'left', name });
    } else out.push({ id: `${pi}`, pi, staff: null, name });
  });
  return out.length > 1 ? out : [];
}
