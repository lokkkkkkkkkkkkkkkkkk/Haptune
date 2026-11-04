// Standard MIDI File reader and writer.
// Writing is exact (ticks per quarter are chosen so every note lands on a whole tick).
// Reading turns MIDI into notation: notes from notation programs land exactly on the grid; played-in
// MIDI is aligned to the nearest grid point and the import report says how much was adjusted.
import { Q, q, ZERO, lcm } from './q.js';
import { performance, measureLength, makeNote, notesFromSpans, recomputeStarts, keyAt, concertKey } from './score.js';
import { spellMidi } from './pitch.js';
import { PROGRAMS } from './musicxml.js';
import { estimateKeyFromNotes } from './analysis.js';

// ---------- writing ----------

function vlq(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}
const str = (s) => [...new TextEncoder().encode(s)];

function chunk(type, data) {
  const len = data.length;
  return [...str(type), (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...data];
}

function trackBytes(events) {
  // events: [{tick, data:[...]}], sorted
  events.sort((a, b) => a.tick - b.tick || (a.order ?? 1) - (b.order ?? 1));
  const out = [];
  let last = 0;
  for (const e of events) {
    out.push(...vlq(Math.max(0, e.tick - last)), ...e.data);
    last = e.tick;
  }
  out.push(...vlq(0), 0xff, 0x2f, 0x00);
  return out;
}

function meta(type, bytes) { return [0xff, type, ...vlq(bytes.length), ...bytes]; }

/** Writes a score as a format-1 MIDI file (repeats played out). Returns Uint8Array. */
export function writeMIDI(score, { repeats = true, transposeSemis = 0 } = {}) {
  const perf = performance(score, { repeats });
  let ppq = 480;
  const fits = (p) => perf.events.every((e) => e.t.mul(p).d === 1 && e.dur.mul(p).d === 1) && perf.spans.every((s) => s.t.mul(p).d === 1);
  if (!fits(ppq)) {
    let d = 1;
    for (const e of perf.events) { d = lcm(d, e.t.d); d = lcm(d, e.dur.d); }
    let p = 480;
    while (p % d !== 0 && p < 30000) p += 480;
    ppq = p % d === 0 ? p : 960;
  }
  const tick = (x) => Math.round(x.mul(ppq).num());
  const conductor = [];
  if (score.title) conductor.push({ tick: 0, data: meta(0x03, str(score.title)), order: 0 });
  let lastTime = null, lastKey = null;
  const key0 = concertKey(score);
  for (const sp of perf.spans) {
    const m = score.measures[sp.mi];
    const t = m.time || (lastTime === null ? { beats: 4, beatType: 4 } : null);
    if (t && (!lastTime || t.beats !== lastTime.beats || t.beatType !== lastTime.beatType)) {
      conductor.push({ tick: tick(sp.t), data: meta(0x58, [t.beats, Math.round(Math.log2(t.beatType)), 24, 8]), order: 0 });
      lastTime = t;
    }
    const part0 = score.parts.find((p) => !p.transpose) || score.parts[0];
    const k = part0?.measures[sp.mi]?.key || (lastKey === null ? key0 : null);
    if (k && (!lastKey || k.fifths !== lastKey.fifths || k.mode !== lastKey.mode)) {
      conductor.push({ tick: tick(sp.t), data: meta(0x59, [(k.fifths + 256) % 256, k.mode === 'minor' ? 1 : 0]), order: 0 });
      lastKey = k;
    }
  }
  for (const tp of perf.tempos) {
    const us = Math.round(60000000 / tp.bpm);
    conductor.push({ tick: tick(tp.t), data: meta(0x51, [(us >> 16) & 255, (us >> 8) & 255, us & 255]), order: 0 });
  }
  const tracks = [trackBytes(conductor)];
  score.parts.forEach((part, pi) => {
    const ch = part.percussion ? 9 : pi >= 9 ? (pi + 1) % 16 : pi % 16;
    const ev = [{ tick: 0, data: meta(0x03, str(part.name || `Part ${pi + 1}`)), order: 0 }];
    ev.push({ tick: 0, data: [0xc0 | ch, (part.program ?? PROGRAMS[part.instrument] ?? 0) & 127], order: 0 });
    for (const e of perf.events) {
      if (e.pi !== pi) continue;
      const on = tick(e.t), off = tick(e.t.add(e.dur));
      const note = Math.max(0, Math.min(127, e.midi + transposeSemis));
      ev.push({ tick: on, data: [0x90 | ch, note, Math.max(1, Math.min(127, e.vel || 80))], order: 2 });
      ev.push({ tick: Math.max(on + 1, off), data: [0x80 | ch, note, 0], order: 1 });
    }
    // lyrics as meta events at their notes
    part.measures.forEach((pm, mi) => {
      for (const n of pm.notes) for (const l of n.lyrics || []) {
        if (l.n !== '1') continue;
        for (const sp of perf.spans.filter((s) => s.mi === mi)) {
          const txt = l.text + (l.syl === 'begin' || l.syl === 'middle' ? '-' : ' ');
          ev.push({ tick: tick(sp.t.add(n.off)), data: meta(0x05, str(txt)), order: 1.5 });
          break;
        }
      }
    });
    tracks.push(trackBytes(ev));
  });
  const header = chunk('MThd', [0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (ppq >> 8) & 255, ppq & 255]);
  const bytes = [...header];
  for (const t of tracks) bytes.push(...chunk('MTrk', t));
  return new Uint8Array(bytes);
}

// ---------- reading ----------

/** Raw MIDI parse: {format, ppq, tracks: [{name, notes:[{on,off,midi,vel,ch}], lyrics:[{tick,text}], programs:{ch:prog}}], tempos, times, keys} */
export function readMIDIRaw(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  if (tag(0) !== 'MThd') {
    // RIFF-wrapped MIDI (.rmi)
    const idx = (() => { for (let i = 0; i < Math.min(b.length - 4, 4096); i++) if (tag(i) === 'MThd') return i; return -1; })();
    if (idx < 0) throw new Error('This file is not a MIDI file.');
    return readMIDIRaw(b.subarray(idx));
  }
  const format = dv.getUint16(8);
  const ntrk = dv.getUint16(10);
  const division = dv.getUint16(12);
  if (division & 0x8000) throw new Error('This MIDI file uses SMPTE time, which cannot be turned into notation. Export it with beats (PPQ) instead.');
  const ppq = division;
  let p = 8 + dv.getUint32(4);
  const tracks = [], tempos = [], times = [], keys = [];
  for (let t = 0; t < ntrk && p < b.length; t++) {
    while (p < b.length && tag(p) !== 'MTrk') p += 8 + dv.getUint32(p + 4);
    if (p >= b.length) break;
    const len = dv.getUint32(p + 4);
    let i = p + 8;
    const end = i + len;
    p = end;
    let tick = 0, status = 0;
    const track = { name: '', notes: [], lyrics: [], programs: {}, texts: [] };
    const open = new Map();
    const readVlq = () => { let v = 0, c; do { c = b[i++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80 && i < end); return v; };
    while (i < end) {
      tick += readVlq();
      let s = b[i];
      if (s & 0x80) { status = s; i++; } else s = status;
      const type = s & 0xf0, ch = s & 0x0f;
      if (s === 0xff) {
        const mt = b[i++];
        const ml = readVlq();
        const data = b.subarray(i, i + ml);
        i += ml;
        const txt = () => new TextDecoder().decode(data);
        if (mt === 0x51 && ml === 3) tempos.push({ tick, bpm: 60000000 / ((data[0] << 16) | (data[1] << 8) | data[2]) });
        else if (mt === 0x58) times.push({ tick, beats: data[0], beatType: Math.pow(2, data[1]) });
        else if (mt === 0x59) keys.push({ tick, fifths: data[0] > 127 ? data[0] - 256 : data[0], mode: data[1] ? 'minor' : 'major' });
        else if (mt === 0x03 && !track.name) track.name = txt().trim();
        else if (mt === 0x05) track.lyrics.push({ tick, text: txt() });
        else if (mt === 0x01) track.texts.push({ tick, text: txt() });
        else if (mt === 0x2f) break;
      } else if (s === 0xf0 || s === 0xf7) {
        const l = readVlq(); i += l;
      } else if (type === 0x90 || type === 0x80) {
        const note = b[i++], vel = b[i++];
        const k = `${ch}:${note}`;
        if (type === 0x90 && vel > 0) {
          if (!open.has(k)) open.set(k, []);
          open.get(k).push({ on: tick, vel });
        } else {
          const stack = open.get(k);
          if (stack && stack.length) {
            const o = stack.shift();
            if (tick > o.on) track.notes.push({ on: o.on, off: tick, midi: note, vel: o.vel, ch });
          }
        }
      } else if (type === 0xc0) { track.programs[ch] = b[i++]; }
      else if (type === 0xd0) i += 1;
      else if (type === 0xa0 || type === 0xb0 || type === 0xe0) i += 2;
      else i += 1;
    }
    for (const [k, stack] of open) for (const o of stack) track.notes.push({ on: o.on, off: tick, midi: Number(k.split(':')[1]), vel: o.vel, ch: Number(k.split(':')[0]) });
    tracks.push(track);
  }
  return { format, ppq, tracks, tempos, times, keys };
}

const GM_NAMES = ['Piano', 'Bright Piano', 'Electric Grand', 'Honky-tonk', 'Electric Piano', 'Electric Piano 2', 'Harpsichord', 'Clavinet'];

/** Reads a MIDI file into a Score plus an import report. */
export function readMIDI(buf, { title = '' } = {}) {
  const raw = readMIDIRaw(buf);
  const ppq = raw.ppq;
  // channels -> parts (tracks with notes; format 0 split by channel)
  const groups = [];
  let drumNotes = 0;
  raw.tracks.forEach((tr, ti) => {
    const byCh = new Map();
    for (const n of tr.notes) {
      if (n.ch === 9) { drumNotes++; continue; }
      if (!byCh.has(n.ch)) byCh.set(n.ch, []);
      byCh.get(n.ch).push(n);
    }
    for (const [ch, notes] of byCh) groups.push({ name: tr.name, ch, program: tr.programs[ch] ?? null, notes, lyrics: tr.lyrics, ti });
  });
  if (!groups.length) throw new Error(drumNotes ? 'This MIDI file only has drums, which Haptune cannot turn into sheet music yet.' : 'This MIDI file has no notes.');
  // choose the grid from the onsets: exact files sit on 1/4 or 1/3 beats
  const onsets = groups.flatMap((g) => g.notes.map((n) => n.on));
  const grids = [q(1, 4), q(1, 3), q(1, 8), q(1, 6), q(1, 12), q(1, 16), q(1, 24)];
  let grid = q(1, 12), gridErr = Infinity;
  for (const g of grids) {
    const step = g.num() * ppq;
    let err = 0;
    for (const o of onsets) err += Math.abs(o - Math.round(o / step) * step);
    const mean = err / onsets.length / ppq;
    const score = mean + g.d * 0.0004; // prefer coarser grids when they fit equally well
    if (mean < 0.004) { grid = g; gridErr = mean; break; }
    if (score < gridErr) { grid = g; gridErr = score; }
  }
  const snap = (tick) => {
    const step = grid.num() * ppq;
    return q(Math.round(tick / step), 1).mul(grid);
  };
  let moved = 0, maxMove = 0;
  const tempo0 = raw.tempos[0]?.bpm || 120;
  const track = (tick, quarters) => {
    const dt = Math.abs(tick / ppq - quarters.num());
    if (dt > 1e-9) { moved++; maxMove = Math.max(maxMove, dt * 60000 / tempo0); }
  };
  // meter and measures
  const times = raw.times.length ? raw.times.map((t) => ({ t: snap(t.tick), beats: t.beats, beatType: t.beatType })) : [{ t: ZERO, beats: 4, beatType: 4 }];
  let endQ = ZERO;
  const partsNotes = groups.map((g) => g.notes.map((n) => {
    const on = snap(n.on);
    let off = snap(n.off);
    if (!off.gt(on)) off = on.add(grid);
    track(n.on, on);
    if (off.gt(endQ)) endQ = off;
    return { on, off, midi: n.midi, vel: n.vel };
  }));
  // legato fill: notes ending just before the next onset (gated playback) reach it
  for (const list of partsNotes) {
    list.sort((a, b) => a.on.cmp(b.on) || b.midi - a.midi);
    const onsetsSorted = [...new Set(list.map((n) => n.on.toString()))].map((s) => Q.parse(s)).sort((a, b) => a.cmp(b));
    for (const n of list) {
      const next = onsetsSorted.find((o) => o.gt(n.on));
      if (next && n.off.lt(next) && next.sub(n.off).le(q(1, 4)) && next.sub(n.off).lt(n.off.sub(n.on).mul(q(1, 3)))) n.off = next;
    }
  }
  const measures = [];
  let t = ZERO, ti = 0, cur = times[0];
  let leadIn = ZERO;
  while (t.lt(endQ) || measures.length === 0) {
    while (ti + 1 < times.length && times[ti + 1].t.le(t)) { ti++; cur = times[ti]; }
    const len = measureLength(cur);
    const m = { number: String(measures.length + 1), implicit: false, start: t, dur: len, left: {}, right: {}, jumps: {} };
    if (measures.length === 0 || times.some((x) => x.t.eq(t) && x !== times[0]) || ti > 0 && times[ti].t.eq(t)) m.time = { beats: cur.beats, beatType: cur.beatType };
    measures.push(m);
    t = t.add(len);
    if (measures.length > 4000) break;
  }
  measures[measures.length - 1].right = { style: 'light-heavy' };
  void leadIn;
  // tempos at measure starts
  for (const tp of raw.tempos) {
    const at = snap(tp.tick);
    const m = measures.find((x) => x.start.le(at) && x.start.add(x.dur).gt(at));
    if (m && (!m.tempo || at.eq(m.start))) m.tempo = Math.round(tp.bpm * 10) / 10;
  }
  if (!measures[0].tempo) measures[0].tempo = Math.round(tempo0);
  // key: from the file, else estimated
  const allMidi = partsNotes.flat().map((n) => ({ midi: n.midi, dur: n.off.sub(n.on).num() }));
  const fileKey = raw.keys[0] ? { fifths: raw.keys[0].fifths, mode: raw.keys[0].mode } : null;
  const key = fileKey || estimateKeyFromNotes(allMidi);
  const score = { title: title || raw.tracks.find((x) => x.name)?.name || '', composer: '', lyricist: '', measures, parts: [], meta: { source: 'midi', keyEstimated: !fileKey } };
  groups.forEach((g, gi) => {
    const list = partsNotes[gi];
    const lo = Math.min(...list.map((n) => n.midi)), hi = Math.max(...list.map((n) => n.midi));
    const program = g.program;
    const name = g.name || (program !== null && program < 8 ? GM_NAMES[program] : `Part ${gi + 1}`);
    const twoStaves = hi - lo > 24 && lo < 55 && hi > 64 || (program !== null && program < 8 && hi - lo > 19);
    const part = { id: `P${gi + 1}`, name, abbr: '', instrument: program !== null ? programInstrument(program) : 'piano', program, transpose: null, staves: twoStaves ? 2 : 1, measures: [] };
    const clefs = twoStaves ? [{ staff: 1, sign: 'G', line: 2, oct: 0, off: ZERO }, { staff: 2, sign: 'F', line: 4, oct: 0, off: ZERO }]
      : [lo < 55 ? { staff: 1, sign: 'F', line: 4, oct: 0, off: ZERO } : { staff: 1, sign: 'G', line: 2, oct: 0, off: ZERO }];
    // voices per staff
    const staffOf = (n) => (twoStaves ? (n.midi >= 60 ? 1 : 2) : 1);
    const voices = new Map(); // `${staff}:${v}` -> [{on, off, pitches[]}]
    const chords = new Map();
    for (const n of list) {
      const k = `${staffOf(n)}|${n.on}|${n.off}`;
      if (!chords.has(k)) chords.set(k, { staff: staffOf(n), on: n.on, off: n.off, midis: [], vel: n.vel });
      chords.get(k).midis.push(n.midi);
    }
    const sortedChords = [...chords.values()].sort((a, b) => a.on.cmp(b.on) || b.midis[0] - a.midis[0]);
    const voiceEnd = new Map();
    for (const c of sortedChords) {
      let v = 1;
      while (v <= 4 && voiceEnd.get(`${c.staff}:${v}`)?.gt(c.on)) v++;
      if (v > 4) {
        // too many overlapping lines: shorten the voice 1 note so it ends here
        v = 1;
        const lst = voices.get(`${c.staff}:1`);
        if (lst?.length) lst[lst.length - 1].off = c.on;
      }
      const k = `${c.staff}:${v}`;
      if (!voices.has(k)) voices.set(k, []);
      voices.get(k).push(c);
      voiceEnd.set(k, c.off);
    }
    // lyrics by tick
    const lyricAt = new Map();
    for (const l of g.lyrics || []) lyricAt.set(snap(l.tick).toString(), l.text);
    measures.forEach((m, mi) => {
      const pm = { key: mi === 0 ? key : null, clefs: mi === 0 ? clefs : [], harmonies: [], notes: [], directions: [], extraAttrs: [] };
      const mEnd = m.start.add(m.dur);
      const time = timeIn(measures, mi);
      for (const [k, cl] of [...voices.entries()].sort()) {
        const [staff, v] = k.split(':').map(Number);
        const items = [];
        for (const c of cl) {
          if (!c.off.gt(m.start) || !c.on.lt(mEnd)) continue;
          const s = c.on.lt(m.start) ? m.start : c.on;
          const e = c.off.gt(mEnd) ? mEnd : c.off;
          const lyric = c.on.ge(m.start) ? lyricAt.get(c.on.toString()) : null;
          items.push({
            off: s.sub(m.start), dur: e.sub(s), pitches: c.midis.sort((a, b) => a - b).map((md) => spellMidi(md, key.fifths)),
            tieIn: c.on.lt(m.start), tieOut: c.off.gt(mEnd),
            lyrics: lyric ? [lyricFromText(lyric)] : null,
          });
        }
        if (!items.length && v > 1) continue;
        const notes = notesFromSpans(items, time, { voice: String(v), staff, fillRests: v === 1, measureDur: m.dur });
        pm.notes.push(...notes);
      }
      if (!pm.notes.length) pm.notes.push(makeNote({ off: ZERO, dur: m.dur, rest: true, type: 'whole', measureRest: true }));
      part.measures.push(pm);
    });
    score.parts.push(part);
  });
  recomputeStarts(score);
  const totalNotes = partsNotes.reduce((s, l) => s + l.length, 0);
  return {
    score,
    report: {
      notes: totalNotes, moved, maxMoveMs: Math.round(maxMove), grid: grid.toString(), exact: moved === 0,
      drumNotes, keyFromFile: !!fileKey, parts: score.parts.length, measures: measures.length,
    },
  };
}

function lyricFromText(t) {
  const s = t.replace(/[\r\n]/g, '').trim();
  if (s.endsWith('-')) return { n: '1', syl: 'begin', text: s.slice(0, -1) };
  return { n: '1', syl: 'single', text: s };
}

function timeIn(measures, mi) {
  for (let i = mi; i >= 0; i--) if (measures[i].time) return measures[i].time;
  return { beats: 4, beatType: 4 };
}

function programInstrument(p) {
  if (p < 8) return 'piano';
  if (p >= 16 && p <= 23) return 'organ';
  if (p >= 24 && p <= 31) return 'guitar';
  if (p >= 32 && p <= 39) return 'bassguitar';
  if (p === 40) return 'violin';
  if (p === 41) return 'viola';
  if (p === 42) return 'cello';
  if (p === 43) return 'doublebass';
  if (p >= 48 && p <= 51) return 'violin';
  if (p >= 52 && p <= 54) return 'voice';
  if (p === 56) return 'trumpet';
  if (p === 57) return 'trombone';
  if (p === 60) return 'horn';
  if (p >= 64 && p <= 67) return 'sax';
  if (p === 68) return 'oboe';
  if (p === 71) return 'clarinet';
  if (p === 70) return 'bassoon';
  if (p === 73 || p === 72) return 'flute';
  if (p === 74) return 'recorder';
  return 'piano';
}

export { keyAt };
