// 簡譜 (jianpu, numbered notation): typed in as text, and drawn for any score.
//
// Text format (the same one the Melovyn engine and the iPhone app read):
//     title: 茉莉花
//     key: 1=F          the note that "1" sounds: C D E F G A B with # or b (1=bB, 1=F#)
//     time: 2/4
//     tempo: 72
//     ---
//     3 3 5 6 | 1' 1' 6 5 | 5 5 6 - | 5 - - - ||
//     w: 好 一 朵 美 丽 的 茉 莉 花        (optional: words for the line above, one syllable a note)
// Tokens: 1..7 degrees, 0 rest; #5 b7; 1' octave up, 1, octave down; 5_ eighth, 5__ sixteenth; 5. dotted;
// - holds the previous note one more beat; ~ tie; | bar line, |: :| repeats, || end. A short header line such as
// "1=C 4/4" at the top also works.
import { q, ZERO } from './q.js';
import { emptyScore, measureLength, notesFromSpans, autoBeam, keyAt, timeAt } from './score.js';
import { STEPS, STEP_PC, jianpuOf, keyOfTonic, majorTonic, nameOf } from './pitch.js';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const TOKEN = /^([#b]?)([0-7])((?:'|\^|,)*)(_*)(\.?)(~?)$/;

/** True when text looks like 簡譜 rather than chords or ABC. */
export function isJianpu(text) {
  const t = text || '';
  if (/^X:\s*\d/m.test(t) || /<score-partwise/.test(t)) return false;
  if (!/(^|\s|:)1\s*=\s*[#b]?[A-Ga-g][#b]?/m.test(t)) return false;
  const body = t.split('\n').filter((l) => !/^\s*(#|w:|[A-Za-z]+\s*[:：])/.test(l)).join(' ');
  const toks = body.split(/[\s|:]+/).filter(Boolean);
  const ok = toks.filter((x) => TOKEN.test(x) || x === '-').length;
  return toks.length >= 4 && ok / toks.length > 0.8;
}

export function parseJianpu(text, { instrument = 'voice' } = {}) {
  const header = {};
  const lines = [];           // [{music, words}]
  let inBody = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') && !/^#[0-7]/.test(line)) continue;
    if (line === '---') { inBody = true; continue; }
    const w = /^w\s*[:：]\s*(.*)$/i.exec(line);
    if (w) { if (lines.length) lines[lines.length - 1].words = w[1]; continue; }
    const m = /^([A-Za-z]+)\s*[:：]\s*(.+)$/.exec(line);
    if (m && !inBody) { header[m[1].toLowerCase()] = m[2].trim(); continue; }
    // a compact first line: "1=C 4/4" (and maybe a tempo)
    if (!inBody && /1\s*=/.test(line) && !/\|/.test(line)) {
      const k = /1\s*=\s*([#b]?[A-Ga-g][#b]?)/.exec(line); if (k) header.key = `1=${k[1]}`;
      const tm = /(\d+)\s*\/\s*(\d+)/.exec(line); if (tm) header.time = `${tm[1]}/${tm[2]}`;
      const bpm = /[♩=]\s*(\d{2,3})\b/.exec(line.replace(/1\s*=\s*\S+/, '')); if (bpm) header.tempo = bpm[1];
      continue;
    }
    inBody = true;
    lines.push({ music: line, words: '' });
  }
  const km = /^1=([#b]?)([A-Ga-g])([#b]?)$/.exec((header.key || '1=C').replace(/\s+/g, ''));
  if (!km) throw new Error(`Key "${header.key}" isn't clear. Write it like 1=C, 1=F# or 1=bB.`);
  const acc = km[1] || km[3];
  const tonic = { step: km[2].toUpperCase(), alter: acc === '#' ? 1 : acc === 'b' ? -1 : 0 };
  const key = keyOfTonic(tonic, 'major');
  const tm = /^(\d+)\s*\/\s*(\d+)$/.exec(header.time || '4/4');
  const time = { beats: tm ? Number(tm[1]) : 4, beatType: tm ? Number(tm[2]) : 4 };
  const beat = q(4, time.beatType);
  const octave0 = Number(header.octave) || 4;
  const tonicStep = STEPS.indexOf(tonic.step);
  const tonicMidi = 12 * (octave0 + 1) + STEP_PC[tonicStep] + (tonic.alter || 0);
  // degree of the major scale on the tonic, spelled with the right letter (so 4 in 1=F is B flat, not A sharp)
  const pitchOf = (degree, alter, oct) => {
    const stepAbs = tonicStep + degree - 1;
    const octave = octave0 + oct + Math.floor(stepAbs / 7);
    const natural = 12 * (octave + 1) + STEP_PC[stepAbs % 7];
    return { step: STEPS[stepAbs % 7], alter: tonicMidi + MAJOR[degree - 1] + alter + 12 * oct - natural, octave };
  };

  const score = emptyScore(header.title || '');
  score.composer = header.composer || header.by || '';
  const part = { id: 'P1', name: '', abbr: '', instrument, program: 0, transpose: null, staves: 1, measures: [] };
  score.parts.push(part);
  const bar = measureLength(time);
  let items = [], cur = ZERO, start = ZERO, last = null, pending = null;
  const flush = (right = 'regular', repeatEnd = false) => {
    if (!items.length && cur.isZero()) return;
    const dur = cur.gt(bar) ? cur : (cur.lt(bar) && !score.measures.length ? cur : bar);     // a short first bar is a pickup
    const mi = score.measures.length;
    score.measures.push({ number: String(mi + 1), implicit: dur.lt(bar), start, dur, time: mi === 0 ? time : null, tempo: mi === 0 ? (Number(header.tempo) || 90) : null,
      left: pending?.repeatStart ? { repeat: 'forward' } : null, right: repeatEnd ? { repeat: 'backward', style: 'light-heavy' } : right === 'final' ? { style: 'light-heavy' } : null, jumps: [] });
    const notes = notesFromSpans(items, time, { measureDur: dur });
    autoBeam(notes, time);
    part.measures.push({ key: mi === 0 ? key : null, clefs: mi === 0 ? [{ staff: 1, sign: 'G', line: 2, oct: 0, off: ZERO }] : [], harmonies: [], notes, directions: [], extraAttrs: [] });
    start = start.add(dur);
    items = []; cur = ZERO; last = null; pending = null;
  };
  for (const { music, words } of lines) {
    const syl = words ? words.trim().split(/\s+/) : [];
    let si = 0;
    const toks = music.replace(/\|\|/g, ' || ').replace(/\|:/g, ' |: ').replace(/:\|/g, ' :| ').replace(/(?<![|:])\|(?![|:])/g, ' | ').split(/\s+/).filter(Boolean);
    for (const tok of toks) {
      if (tok === '|') { flush(); continue; }
      if (tok === '||') { flush('final'); continue; }
      if (tok === ':|') { flush('regular', true); continue; }
      if (tok === '|:') { flush(); pending = { repeatStart: true }; continue; }
      if (tok === '-') {
        if (cur.ge(bar) && last) {                 // held over the bar line (no | typed): a tie into the next bar
          const p = last.pitch;
          last.tieOut = !!p;
          flush();
          last = { off: ZERO, dur: beat, pitch: p, tieIn: !!p };
          items.push(last);
          cur = beat;
          continue;
        }
        if (last) last.dur = last.dur.add(beat); else items.push({ off: cur, dur: beat, pitch: null });
        cur = cur.add(beat);
        continue;
      }
      const m = TOKEN.exec(tok);
      if (m && cur.ge(bar)) flush();               // the bar is full: carry on in the next one, bar line typed or not
      if (!m) throw new Error(`"${tok}" isn't 簡譜. Use 1-7, 0 for a rest, - to hold, | for bar lines.`);
      const degree = Number(m[2]);
      const oct = (m[3].match(/'|\^/g) || []).length - (m[3].match(/,/g) || []).length;
      let dur = beat;
      for (let i = 0; i < m[4].length; i++) dur = dur.div(2);
      if (m[5]) dur = dur.mul(q(3, 2));
      const pitch = degree ? pitchOf(degree, m[1] === '#' ? 1 : m[1] === 'b' ? -1 : 0, oct) : null;
      const tieIn = !!(last && last.tieOut && pitch);
      const item = { off: cur, dur, pitch, tieOut: !!m[6], tieIn };
      if (pitch && !tieIn && si < syl.length) {
        const s = syl[si++];
        if (s !== '_' && s !== '*') item.lyrics = [{ n: '1', text: s.replace(/-$/, ''), syl: s.endsWith('-') ? 'begin' : 'single' }];
      }
      items.push(item);
      last = item;
      cur = cur.add(dur);
    }
  }
  flush('final');
  if (!score.measures.length) throw new Error('No notes found. Type numbers 1-7 with | between bars.');
  const lastM = score.measures[score.measures.length - 1];
  if (!lastM.right) lastM.right = { style: 'light-heavy' };
  return score;
}

// ------------------------------------------------------------------------------------------ any score as 簡譜

/**
 * The melody of one part (or one staff of it) as 簡譜: for each bar, the notes of the main voice with their
 * degree in the key, octave dots, how they are written (underlines, dot, dashes), words and chord symbols.
 * Chords are shown by their top note (簡譜 is a melody notation).
 */
export function jianpuModel(score, pi = 0, staff = null) {
  const part = score.parts[pi] || score.parts[0];
  const bars = [];
  let key = null;
  part.measures.forEach((pm, mi) => {
    key = keyAt(part, mi) || key || { fifths: 0, mode: 'major' };
    const mine = pm.notes.filter((n) => !n.grace && !n.cue && (!staff || (n.staff || 1) === staff));
    // the voice that carries the tune: the first voice on the (top) staff that has notes
    const topStaff = staff || Math.min(...mine.map((n) => n.staff || 1), 9);
    const voices = [...new Set(mine.filter((n) => (n.staff || 1) === topStaff).map((n) => n.voice))].sort();
    const voice = voices.find((v) => mine.some((n) => n.voice === v && !n.rest && (n.staff || 1) === topStaff)) || voices[0];
    const line = mine.filter((n) => n.voice === voice && (n.staff || 1) === topStaff);
    const byOff = new Map();
    for (const n of line) {
      const k = n.off.toString();
      const cur = byOff.get(k);
      // of a chord, keep the highest note
      if (!cur || (n.pitch && (!cur.pitch || n.pitch.octave * 12 + STEPS.indexOf(n.pitch.step) * 2 > cur.pitch.octave * 12 + STEPS.indexOf(cur.pitch.step) * 2))) byOff.set(k, n);
    }
    const items = [...byOff.values()].sort((a, b) => a.off.cmp(b.off)).map((n) => {
      const base = { id: n.id, off: n.off, dur: n.dur, type: n.type, dots: n.dots || 0, tm: n.tm ? n.tm.actual : 0 };
      if (n.rest || !n.pitch) return { ...base, rest: true, whole: !!n.measureRest };
      const j = jianpuOf(n.pitch, key);
      return { ...base, degree: j.degree, acc: j.acc, oct: j.oct, tie: !!n.tie?.start, tied: !!n.tie?.stop, lyric: n.lyrics?.find((l) => l.n === '1')?.text || '' };
    });
    bars.push({ mi, number: score.measures[mi]?.number, items, dur: score.measures[mi]?.dur, harmonies: pm.harmonies || [],
      repeatStart: score.measures[mi]?.left?.repeat === 'forward', repeatEnd: score.measures[mi]?.right?.repeat === 'backward', final: mi === part.measures.length - 1 });
  });
  const k0 = keyAt(part, 0) || { fifths: 0, mode: 'major' };
  const t0 = timeAt(score, 0) || { beats: 4, beatType: 4 };
  return { bars, key: k0, keyText: `1=${nameOf(majorTonic(k0.fifths))}`, time: t0, tempo: score.measures[0]?.tempo || null };
}

/** How a written note looks in 簡譜: [underlines, dashes after, dotted]. */
function shape(it, beatQ) {
  const LINES = { eighth: 1, '16th': 2, '32nd': 3, '64th': 4 };
  const DASH = { whole: 3, half: 1, breve: 7 };
  const under = LINES[it.type] || 0;
  let dashes = DASH[it.type] || 0;
  let dot = false;
  if (it.dots) {
    if (it.type === 'half') dashes = 2;            // a dotted half is three beats: 5 - -
    else if (it.type === 'whole') dashes = 5;
    else dot = true;
  }
  if (it.rest && it.whole) dashes = Math.max(0, Math.round(it.dur.num() / beatQ) - 1);
  return { under, dashes, dot };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * Draws the model as SVG, `width` CSS pixels wide. Returns {svg, height}. Each note is a <g class="jn" id="jp-…">
 * (the id of the note in the score, so the player can light it up).
 */
export function renderJianpu(model, { width = 360, title = '' } = {}) {
  const fs = width < 420 ? 19 : 22;                // digit size
  const cell = fs * 1.05;                          // one slot (a digit or a dash)
  const tight = fs * 0.72;                         // slot of a note shorter than a beat
  const lineH = fs * 3.9;
  const margin = 12;
  const beatQ = 4 / (model.time.beatType || 4);
  // measure each bar
  const bars = model.bars.map((b) => {
    let w = 10;
    const slots = [];
    b.items.forEach((it) => {
      const sh = shape(it, beatQ);
      const wNote = (sh.under ? tight : cell) + (it.acc ? fs * 0.34 : 0) + (sh.dot ? fs * 0.3 : 0);
      slots.push({ it, sh, x: w + wNote / 2, w: wNote });
      w += wNote;
      for (let d = 0; d < sh.dashes; d++) { slots.push({ dash: true, x: w + cell / 2, w: cell }); w += cell; }
    });
    return { b, slots, w: w + 8 };
  });
  // break into lines
  const lines = [];
  let cur = [], used = 0;
  const avail = width - 2 * margin;
  for (const bar of bars) {
    if (cur.length && used + bar.w > avail) { lines.push(cur); cur = []; used = 0; }
    cur.push(bar); used += bar.w;
  }
  if (cur.length) lines.push(cur);
  const headH = fs * 1.9 + (title ? fs * 1.5 : 0);
  const height = headH + lines.length * lineH + 8;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height.toFixed(0)}" class="jp-svg" font-family="-apple-system, 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', Arial, sans-serif">`];
  if (title) out.push(`<text x="${width / 2}" y="${fs * 1.2}" text-anchor="middle" font-size="${fs * 0.95}" font-weight="700">${esc(title)}</text>`);
  out.push(`<text x="${margin}" y="${headH - fs * 0.6}" font-size="${fs * 0.72}" font-weight="700" class="jp-head">${esc(model.keyText)}  ${model.time.beats}/${model.time.beatType}${model.tempo ? `  ♩=${Math.round(model.tempo)}` : ''}</text>`);
  lines.forEach((line, li) => {
    const total = line.reduce((s, b) => s + b.w, 0);
    const stretch = li === lines.length - 1 && total < avail * 0.75 ? 1 : avail / total;      // the last line is not stretched
    const y = headH + li * lineH + fs * 1.55;                                                // baseline of the digits
    let x0 = margin;
    line.forEach((bar) => {
      const bw = bar.w * stretch;
      const g = [];
      if (bar.b.repeatStart) g.push(`<text x="${x0 + 2}" y="${y}" font-size="${fs * 0.9}">:</text>`);
      for (const h of bar.b.harmonies) {
        const frac = bar.b.dur && bar.b.dur.num() ? h.off.num() / bar.b.dur.num() : 0;
        g.push(`<text x="${(x0 + 8 + frac * (bw - 16)).toFixed(1)}" y="${(y - fs * 1.25).toFixed(1)}" font-size="${fs * 0.6}" font-weight="700" class="jp-chord">${esc(h.text || chordText(h.chord))}</text>`);
      }
      bar.slots.forEach((s, si) => {
        const x = x0 + s.x * stretch;
        if (s.dash) { g.push(`<text x="${x.toFixed(1)}" y="${y}" text-anchor="middle" font-size="${fs}" class="jp-dash">–</text>`); return; }
        const { it, sh } = s;
        const parts = [];
        const dx = it.acc ? fs * 0.17 : 0;
        if (it.acc) parts.push(`<text x="${(x - fs * 0.36).toFixed(1)}" y="${(y - fs * 0.32).toFixed(1)}" text-anchor="middle" font-size="${fs * 0.58}">${it.acc > 0 ? '♯' : '♭'}</text>`);
        parts.push(`<text x="${(x + dx).toFixed(1)}" y="${y}" text-anchor="middle" font-size="${fs}" font-weight="600">${it.rest ? 0 : it.degree}</text>`);
        if (sh.dot) parts.push(`<circle cx="${(x + dx + fs * 0.42).toFixed(1)}" cy="${(y - fs * 0.3).toFixed(1)}" r="${fs * 0.075}"/>`);
        // underlines: joined to the next note when it sits in the same beat and has them too
        const next = bar.slots[si + 1];
        const sameBeat = next && !next.dash && Math.floor(it.off.num() / beatQ + 1e-9) === Math.floor(next.it.off.num() / beatQ + 1e-9);
        for (let k = 0; k < sh.under; k++) {
          const yy = y + fs * 0.2 + k * fs * 0.17;
          const x2 = sameBeat && next.sh.under > k ? x0 + next.x * stretch - (next.w * stretch) / 2 + 1 : x + (s.w * stretch) / 2 - 2;
          parts.push(`<line x1="${(x - (s.w * stretch) / 2 + 2).toFixed(1)}" x2="${x2.toFixed(1)}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="currentColor" stroke-width="${Math.max(1.2, fs * 0.07)}"/>`);
        }
        if (!it.rest && it.oct) {
          const n = Math.abs(it.oct);
          for (let k = 0; k < n; k++) {
            const cy = it.oct > 0 ? y - fs * 0.92 - k * fs * 0.24 : y + fs * 0.34 + sh.under * fs * 0.17 + k * fs * 0.24;
            parts.push(`<circle cx="${(x + dx).toFixed(1)}" cy="${cy.toFixed(1)}" r="${fs * 0.085}"/>`);
          }
        }
        if (it.tm === 3 && (si === 0 || bar.slots[si - 1].dash || bar.slots[si - 1].it.tm !== 3 || Math.floor(bar.slots[si - 1].it.off.num() / beatQ + 1e-9) !== Math.floor(it.off.num() / beatQ + 1e-9))) {
          parts.push(`<text x="${(x + s.w * stretch).toFixed(1)}" y="${(y - fs * 1.0).toFixed(1)}" text-anchor="middle" font-size="${fs * 0.5}" font-style="italic">3</text>`);
        }
        if (it.tie && next && !next.dash) {
          const xa = x + dx, xb = x0 + next.x * stretch;
          parts.push(`<path d="M${xa.toFixed(1)} ${(y - fs * 1.0).toFixed(1)} Q${((xa + xb) / 2).toFixed(1)} ${(y - fs * 1.45).toFixed(1)} ${xb.toFixed(1)} ${(y - fs * 1.0).toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.2"/>`);
        }
        if (it.lyric) parts.push(`<text x="${(x + dx).toFixed(1)}" y="${(y + fs * 1.5).toFixed(1)}" text-anchor="middle" font-size="${fs * 0.62}" class="jp-lyric">${esc(it.lyric)}</text>`);
        g.push(`<g class="jn${it.rest ? ' rest' : ''}" id="jp-${esc(it.id)}">${parts.join('')}</g>`);
      });
      const xe = x0 + bw;
      const yTop = y - fs * 0.85, yBot = y + fs * 0.3;
      if (bar.b.repeatEnd) g.push(`<text x="${(xe - 9).toFixed(1)}" y="${y}" font-size="${fs * 0.9}">:</text>`);
      g.push(`<line x1="${xe.toFixed(1)}" x2="${xe.toFixed(1)}" y1="${yTop.toFixed(1)}" y2="${yBot.toFixed(1)}" stroke="currentColor" stroke-width="${bar.b.final ? 2.6 : 1.1}"/>`);
      if (bar.b.final) g.push(`<line x1="${(xe - 4).toFixed(1)}" x2="${(xe - 4).toFixed(1)}" y1="${yTop.toFixed(1)}" y2="${yBot.toFixed(1)}" stroke="currentColor" stroke-width="1"/>`);
      out.push(`<g class="jbar" data-mi="${bar.b.mi}"><rect class="jbar-bg" x="${x0.toFixed(1)}" y="${(y - fs * 1.7).toFixed(1)}" width="${bw.toFixed(1)}" height="${(fs * 3.5).toFixed(1)}" rx="8" fill="transparent"/>${g.join('')}</g>`);
      x0 = xe;
    });
  });
  out.push('</svg>');
  return { svg: out.join(''), height };
}

function chordText(c) {
  if (!c || c.nc) return 'N.C.';
  const acc = (a) => (a > 0 ? '♯'.repeat(a) : a < 0 ? '♭'.repeat(-a) : '');
  return `${c.root?.step || ''}${acc(c.root?.alter || 0)}${c.kindText || c.suffix || ''}`;
}

