// ABC notation reader (the folk-tune text format) for single-melody tunes with chord symbols and lyrics.
// Supports: header fields, notes and octaves, accidentals (bar-scoped), lengths, broken rhythm, ties, rests,
// chords in [], triplets, chord symbols in quotes, bar lines, repeats, first/second endings, inline [K:] [M:] [L:],
// and aligned w: lyrics. Durations are exact fractions.
import { q, Q, ZERO } from './q.js';
import { keyAlter, parseName, keyOfTonic } from './pitch.js';
import { parseChord, formatChord } from './chords.js';
import { notesFromSpans, recomputeStarts, measureLength } from './score.js';

const MODES = { '': 'major', maj: 'major', major: 'major', ion: 'ionian', m: 'minor', min: 'minor', minor: 'minor', aeo: 'aeolian', mix: 'mixolydian', dor: 'dorian', phr: 'phrygian', lyd: 'lydian', loc: 'locrian' };

function parseKey(s) {
  const m = /^\s*([A-G])([#b]?)\s*([A-Za-z]*)/.exec(s || 'C');
  if (!m) return { fifths: 0, mode: 'major' };
  if (/^none$/i.test(s.trim())) return { fifths: 0, mode: 'major' };
  const tonic = parseName(m[1] + m[2]);
  const modeWord = m[3].toLowerCase().slice(0, 3);
  const mode = MODES[modeWord] ?? (m[3].toLowerCase() === 'm' ? 'minor' : 'major');
  return keyOfTonic(tonic, mode === 'ionian' ? 'major' : mode === 'aeolian' ? 'minor' : mode);
}

function parseMeter(s) {
  const t = (s || '4/4').trim();
  if (t === 'C') return { beats: 4, beatType: 4, symbol: 'common' };
  if (t === 'C|') return { beats: 2, beatType: 2, symbol: 'cut' };
  const m = /^(\d+(?:\+\d+)*)\/(\d+)/.exec(t);
  if (!m) return { beats: 4, beatType: 4 };
  return { beats: m[1].split('+').reduce((a, b) => a + Number(b), 0), beatType: Number(m[2]) };
}

function parseFrac(s) { const m = /^(\d+)\/(\d+)$/.exec((s || '').trim()); return m ? q(Number(m[1]), Number(m[2])) : null; }

function parseTempo(s) {
  if (!s) return null;
  const m = /(\d+)\/(\d+)\s*=\s*(\d+)/.exec(s);
  if (m) return Math.round(Number(m[3]) * (4 * Number(m[1]) / Number(m[2])));
  const n = /(\d+)/.exec(s);
  return n ? Number(n[1]) : null;
}

/** Reads the first tune of an ABC file into a Score. */
export function parseABC(text, { instrument = 'voice' } = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const head = { title: '', subtitle: '', composer: '', lyricist: '', meter: { beats: 4, beatType: 4 }, unit: null, tempo: null, key: { fifths: 0, mode: 'major' } };
  let i = 0, inHeader = true, sawX = false;
  const body = [];
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*%/.test(l)) continue;
    const f = /^([A-Za-z]):\s*(.*)$/.exec(l);
    if (inHeader) {
      if (!f) { if (l.trim() && sawX) { inHeader = false; body.push(l); } continue; }
      const [, k, v] = f;
      if (k === 'X') { if (sawX && head.title) break; sawX = true; }
      else if (k === 'T') { if (!head.title) head.title = v.trim(); else if (!head.subtitle) head.subtitle = v.trim(); }
      else if (k === 'C') head.composer = v.trim();
      else if (k === 'A' || k === 'Z') { /* area / transcriber */ }
      else if (k === 'M') head.meter = parseMeter(v);
      else if (k === 'L') head.unit = parseFrac(v);
      else if (k === 'Q') head.tempo = parseTempo(v);
      else if (k === 'K') { head.key = parseKey(v); inHeader = false; }
      continue;
    }
    if (/^X:/.test(l)) break; // next tune
    body.push(l);
  }
  if (!sawX && !body.length) throw new Error('No ABC tune was found (it needs X:, T:, M:, L: and K: lines).');
  // default unit length: 1/16 if meter < 0.75, else 1/8
  const meterVal = head.meter.beats / head.meter.beatType;
  let unit = head.unit || (meterVal < 0.75 ? q(1, 16) : q(1, 8));
  const unitQ = () => unit.mul(4); // in quarters

  // ---- tokenise the body into events with lyrics lines ----
  const musicLines = [];
  for (const l of body) {
    if (/^\s*%/.test(l)) continue;
    const w = /^w:\s*(.*)$/.exec(l);
    if (w) { if (musicLines.length) musicLines[musicLines.length - 1].lyrics.push(w[1]); continue; }
    if (/^[A-Za-z]:/.test(l)) {
      const f = /^([A-Za-z]):\s*(.*)$/.exec(l);
      musicLines.push({ text: `[${f[1]}:${f[2]}]`, lyrics: [] });
      continue;
    }
    musicLines.push({ text: l.replace(/%.*$/, ''), lyrics: [] });
  }

  let key = head.key;
  let meter = head.meter;
  const measures = []; // {events:[], harmonies:[], left:{}, right:{}, time?, key?}
  let cur = null;
  let t = ZERO; // position inside current measure
  let barAcc = new Map(); // step+octave -> alter
  const newMeasure = () => { cur = { events: [], harmonies: [], left: {}, right: {}, time: null, key: null, lyricsIdx: [] }; t = ZERO; barAcc = new Map(); measures.push(cur); return cur; };
  newMeasure();
  cur.time = { ...meter };
  cur.key = key;
  let pendingChord = null;
  let tupletLeft = 0, tupletRatio = q(1);
  let brokenNext = null;
  const noteOrder = []; // for lyrics: events eligible for syllables
  let openEnding = null;
  let lastEvent = null;

  const accidentalOf = (step, octave, explicit) => {
    const k = `${step}${octave}`;
    if (explicit !== null) { barAcc.set(k, explicit); return explicit; }
    if (barAcc.has(k)) return barAcc.get(k);
    return keyAlter(key.fifths, step);
  };

  const lineEvents = [];
  for (const ml of musicLines) {
    const startCount = noteOrder.length;
    const s = ml.text;
    let p = 0;
    while (p < s.length) {
      const ch = s[p];
      // inline field
      if (ch === '[' && /^\[[KMLQ]:/.test(s.slice(p))) {
        const end = s.indexOf(']', p);
        const field = s.slice(p + 1, end);
        const [k, v] = [field[0], field.slice(2)];
        if (k === 'K') { key = parseKey(v); if (t.isZero()) cur.key = key; }
        else if (k === 'M') { meter = parseMeter(v); if (t.isZero()) cur.time = { ...meter }; }
        else if (k === 'L') unit = parseFrac(v) || unit;
        else if (k === 'Q') head.tempo = head.tempo || parseTempo(v);
        p = end + 1;
        continue;
      }
      if (ch === '"') {
        const end = s.indexOf('"', p + 1);
        const txt = s.slice(p + 1, end < 0 ? s.length : end);
        p = end < 0 ? s.length : end + 1;
        if (!/^[_^<>@]/.test(txt)) { const c = parseChord(txt.split(/[\s(]/)[0]); if (c) pendingChord = c; }
        continue;
      }
      if (ch === '!' || ch === '+') { const end = s.indexOf(ch, p + 1); p = end < 0 ? s.length : end + 1; continue; }
      if (ch === '{') { const end = s.indexOf('}', p); p = end < 0 ? s.length : end + 1; continue; }
      if ('.~HLMOPSTuv'.includes(ch) && /[A-Ga-gz^_=[]/.test(s[p + 1] || '')) { p++; continue; }
      // bar lines and repeats
      const bar = /^(\[\||:\|\|?:?|\|\|?:?|\|\]|::|\|\s*\[?([12])|\[([12])|:\|\s*\[?([12]))/.exec(s.slice(p));
      if (bar && (ch === '|' || ch === ':' || (ch === '[' && /^\[[12|]/.test(s.slice(p))))) {
        const tok = bar[0];
        const endingNum = bar[2] || bar[3] || bar[4];
        const endsRepeat = tok.startsWith(':');
        const startsRepeat = /\|:|::|:\|:/.test(tok) || tok.endsWith(':') && tok !== ':';
        const isFinal = tok.includes('|]') || tok === '||';
        const hasContent = cur.events.length || !t.isZero();
        if (hasContent) {
          if (endsRepeat) cur.right.repeat = 'backward';
          if (isFinal) cur.right.style = tok.includes('|]') ? 'light-heavy' : 'light-light';
          if (openEnding && (endsRepeat || isFinal || endingNum)) { cur.right.ending = { number: openEnding, type: endsRepeat || openEnding === '1' ? 'stop' : 'discontinue' }; openEnding = null; }
          cur.dur = t;
          newMeasure();
        } else if (endsRepeat && measures.length > 1) {
          const prev = measures[measures.length - 2];
          prev.right.repeat = 'backward';
        }
        if (startsRepeat) cur.left.repeat = 'forward';
        if (endingNum) { cur.left.ending = { number: endingNum, type: 'start' }; openEnding = endingNum; }
        p += tok.length;
        continue;
      }
      if (ch === '(' && /\d/.test(s[p + 1])) {
        const m = /^\((\d)(?::(\d))?(?::(\d))?/.exec(s.slice(p));
        const pn = Number(m[1]);
        const qn = m[2] ? Number(m[2]) : ({ 2: 3, 3: 2, 4: 3, 6: 2, 8: 3 }[pn] || (meter.beats % 3 === 0 && meter.beatType === 8 ? 3 : 2));
        tupletRatio = q(qn, pn);
        tupletLeft = m[3] ? Number(m[3]) : pn;
        p += m[0].length;
        continue;
      }
      if (ch === '-' && lastEvent) { lastEvent.tieOut = true; p++; continue; }
      if (ch === '>' || ch === '<') {
        // broken rhythm: previous note longer/shorter
        let n = 1; while (s[p + n] === ch) n++;
        const factor = n === 1 ? q(1, 2) : n === 2 ? q(3, 4) : q(7, 8);
        if (lastEvent) {
          const delta = lastEvent.dur.mul(factor);
          if (ch === '>') { lastEvent.dur = lastEvent.dur.add(delta); t = t.add(delta); brokenNext = { shorten: delta }; }
          else { lastEvent.dur = lastEvent.dur.sub(delta); t = t.sub(delta); brokenNext = { lengthen: delta }; }
        }
        p += n;
        continue;
      }
      // note, rest or chord
      const nm = /^(\[)?((?:\^\^|\^|__|_|=)?[A-Ga-g][,']*|[zxZ])/.exec(s.slice(p));
      if (nm) {
        const pitches = [];
        let len = null;
        if (nm[1]) {
          // chord [CEG]2
          const end = s.indexOf(']', p);
          const inner = s.slice(p + 1, end);
          const re = /(\^\^|\^|__|_|=)?([A-Ga-g])([,']*)(\d*\/*\d*)/g;
          let x;
          while ((x = re.exec(inner))) { pitches.push(pitchOf(x[1], x[2], x[3])); if (len === null && x[4]) len = x[4]; }
          p = end + 1;
        } else {
          const tok = nm[2];
          p += tok.length;
          if (/[zxZ]/.test(tok)) pitches.push(null);
          else {
            const x = /(\^\^|\^|__|_|=)?([A-Ga-g])([,']*)/.exec(tok);
            pitches.push(pitchOf(x[1], x[2], x[3]));
          }
        }
        const lm = /^(\d*)(\/*)(\d*)/.exec(s.slice(p));
        if (lm[0]) { len = lm[0]; p += lm[0].length; }
        let dur = unitQ().mul(lengthFactor(len));
        if (nm[2] === 'Z') dur = measureLength(meter).mul(Number(len) || 1);
        if (tupletLeft > 0) { dur = dur.mul(tupletRatio); tupletLeft--; }
        if (brokenNext) {
          if (brokenNext.shorten) dur = dur.sub(brokenNext.shorten);
          if (brokenNext.lengthen) dur = dur.add(brokenNext.lengthen);
          brokenNext = null;
        }
        const ev = { off: t, dur, pitches: pitches[0] === null ? null : pitches, tieIn: !!(lastEvent && lastEvent.tieOut && pitches[0] && sameP(lastEvent, pitches)), lyrics: null };
        if (pendingChord) { cur.harmonies.push({ off: t, chord: pendingChord, text: formatChord(pendingChord) }); pendingChord = null; }
        cur.events.push(ev);
        if (ev.pitches && !ev.tieIn) noteOrder.push({ ev, measure: cur });
        lastEvent = ev;
        t = t.add(dur);
        continue;
      }
      p++;
    }
    lineEvents.push({ from: startCount, to: noteOrder.length, lyrics: ml.lyrics });
  }
  if (cur.events.length || !t.isZero()) cur.dur = t; else measures.pop();
  if (openEnding && measures.length) measures[measures.length - 1].right.ending = { number: openEnding, type: 'discontinue' };

  function pitchOf(acc, letter, oct) {
    const step = letter.toUpperCase();
    let octave = letter === letter.toUpperCase() ? 4 : 5;
    for (const c of oct || '') octave += c === "'" ? 1 : -1;
    const explicit = acc === '^' ? 1 : acc === '^^' ? 2 : acc === '_' ? -1 : acc === '__' ? -2 : acc === '=' ? 0 : null;
    return { step, alter: accidentalOf(step, octave, explicit), octave };
  }
  function sameP(ev, pitches) {
    return ev.pitches && ev.pitches.length === pitches.length && ev.pitches.every((x, k) => x.step === pitches[k].step && x.octave === pitches[k].octave);
  }

  // ---- lyrics ----
  for (const le of lineEvents) {
    for (const [verse, wline] of le.lyrics.entries()) {
      const syls = splitLyrics(wline);
      let ni = le.from;
      for (const sy of syls) {
        if (sy.bar) { // skip to next measure
          const m0 = noteOrder[ni]?.measure;
          while (ni < le.to && noteOrder[ni].measure === m0) ni++;
          continue;
        }
        if (ni >= le.to) break;
        if (sy.skip || sy.hold) { ni++; continue; }
        const target = noteOrder[ni].ev;
        target.lyrics = target.lyrics || [];
        target.lyrics.push({ n: String(verse + 1), syl: sy.syl, text: sy.text, ext: sy.ext });
        ni++;
      }
    }
  }

  // ---- build the score ----
  const score = { title: head.title || 'Untitled', subtitle: head.subtitle, composer: head.composer, lyricist: '', measures: [], parts: [], meta: { source: 'abc' } };
  const part = { id: 'P1', name: instrument === 'voice' ? 'Voice' : 'Melody', abbr: '', instrument, program: null, transpose: null, staves: 1, measures: [] };
  let curTime = head.meter, curKey = head.key;
  let lowest = Infinity;
  measures.forEach((m) => m.events.forEach((e) => (e.pitches || []).forEach((p) => { lowest = Math.min(lowest, p.octave * 7 + 'CDEFGAB'.indexOf(p.step)); })));
  const clef = lowest < 3 * 7 + 3 ? { staff: 1, sign: 'F', line: 4, oct: 0, off: ZERO } : { staff: 1, sign: 'G', line: 2, oct: 0, off: ZERO };
  measures.forEach((m, mi) => {
    if (m.time) curTime = m.time;
    const full = measureLength(curTime);
    const dur = m.dur && m.dur.gt(0) ? m.dur : full;
    const meta = { number: String(mi + 1), implicit: mi === 0 && dur.lt(full), start: ZERO, dur, left: m.left, right: m.right, jumps: {} };
    if (mi === 0 || (m.time && (m.time.beats !== curTime.beats || m.time.beatType !== curTime.beatType)) || m.time && mi > 0) meta.time = m.time || (mi === 0 ? curTime : undefined);
    if (mi === 0) meta.tempo = head.tempo || 100;
    score.measures.push(meta);
    const keyHere = mi === 0 ? head.key : (m.key && (m.key.fifths !== curKey.fifths) ? m.key : null);
    if (m.key) curKey = m.key;
    const items = m.events.filter((e) => e.pitches).map((e) => ({ off: e.off, dur: e.dur, pitches: e.pitches, tieIn: e.tieIn, tieOut: !!e.tieOut, lyrics: e.lyrics }));
    const notes = notesFromSpans(items, curTime, { measureDur: dur });
    part.measures.push({ key: keyHere, clefs: mi === 0 ? [clef] : [], harmonies: m.harmonies, notes, directions: [], extraAttrs: [] });
  });
  if (score.measures.length) score.measures[score.measures.length - 1].right = { ...score.measures[score.measures.length - 1].right, style: score.measures[score.measures.length - 1].right.style || 'light-heavy' };
  score.parts.push(part);
  // keep the first measure's time even when the loop above skipped it
  if (score.measures[0] && !score.measures[0].time) score.measures[0].time = head.meter;
  recomputeStarts(score);
  return score;
}

function lengthFactor(len) {
  if (!len) return q(1);
  const m = /^(\d*)(\/*)(\d*)$/.exec(len);
  const num = m[1] ? Number(m[1]) : 1;
  let den = 1;
  if (m[2]) den = m[3] ? Number(m[3]) : Math.pow(2, m[2].length);
  else if (m[3]) den = 1;
  return q(num, den);
}

function splitLyrics(line) {
  const out = [];
  const re = /(\\-|[^\s\-_*|~]+(?:~[^\s\-_*|~]+)*|-|_|\*|\|)/g;
  let m;
  let prevHyphen = false;
  const items = [];
  while ((m = re.exec(line))) items.push(m[0]);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it === '|') { out.push({ bar: true }); continue; }
    if (it === '*') { out.push({ skip: true }); prevHyphen = false; continue; }
    if (it === '_') { if (out.length) { const last = [...out].reverse().find((x) => x.text); if (last) last.ext = true; } out.push({ hold: true }); continue; }
    if (it === '-') { prevHyphen = true; const last = [...out].reverse().find((x) => x.text); if (last) last.hyphenAfter = true; continue; }
    const text = it.replace(/~/g, ' ').replace(/\\-/g, '-');
    out.push({ text, hyphenBefore: prevHyphen });
    prevHyphen = false;
  }
  for (const s of out) {
    if (!s.text) continue;
    s.syl = s.hyphenBefore && s.hyphenAfter ? 'middle' : s.hyphenBefore ? 'end' : s.hyphenAfter ? 'begin' : 'single';
  }
  return out;
}

export { Q };
