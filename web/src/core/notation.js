// The studio's notation marks (Part 8): every symbol the palettes put on a note, a place in a bar, a bar or a
// part, written as MusicXML so MuseScore, Sibelius and Finale read them too, and drawn by Verovio.
//   Note marks   articulations, ornaments, tremolos, bowing and playing techniques, fingering, arpeggios
//   Two notes    slur, tie, glissando, slide, hammer-on, pull-off (from the chosen note to the next one)
//   Places       dynamics, text (expression, technique, tempo), rehearsal marks, segno / coda / D.C. / D.S. / Fine
//   Lines        hairpins, pedal, 8va / 8vb / 15ma, over one or more bars
//   Bars         barlines, repeats, 1st / 2nd endings, insert / delete / clear / copy / paste, clef and time
//   Instruments  auto fingering for strings and piano, lyrics, drum kit notes and grooves
// Plain data in and out: every function returns a new score, so undo keeps working.
import { ZERO, q } from './q.js';
import { makeNote, newId, typeFor, measureLength, timeAt, keyAt, autoBeam } from './score.js';
import { midiOf, spellMidi } from './pitch.js';
import { findNote } from './edit.js';
import { noteBefore } from './write.js';
import { KIT, drumOf } from './drums.js';

export { KIT, drumOf };

// ------------------------------------------------------------------------------------------------ note marks
// [group, element]: group is where it lives inside <notations> ('' = directly)
export const MARKS = {
  staccato: ['articulations', '<staccato/>'], staccatissimo: ['articulations', '<staccatissimo/>'], spiccato: ['articulations', '<spiccato/>'],
  tenuto: ['articulations', '<tenuto/>'], accent: ['articulations', '<accent/>'], marcato: ['articulations', '<strong-accent type="up"/>'],
  portato: ['articulations', '<detached-legato/>'], breath: ['articulations', '<breath-mark/>'], caesura: ['articulations', '<caesura/>'],
  fermata: ['', '<fermata/>'], fermataBelow: ['', '<fermata type="inverted"/>'],
  trill: ['ornaments', '<trill-mark/>'], mordent: ['ornaments', '<mordent/>'], prall: ['ornaments', '<inverted-mordent/>'],
  turn: ['ornaments', '<turn/>'], turnInv: ['ornaments', '<inverted-turn/>'],
  trem1: ['ornaments', '<tremolo type="single">1</tremolo>'], trem2: ['ornaments', '<tremolo type="single">2</tremolo>'], trem3: ['ornaments', '<tremolo type="single">3</tremolo>'],
  upBow: ['technical', '<up-bow/>'], downBow: ['technical', '<down-bow/>'], harmonic: ['technical', '<harmonic/>'], open: ['technical', '<open-string/>'],
  stopped: ['technical', '<stopped/>'], snapPizz: ['technical', '<snap-pizzicato/>'], thumb: ['technical', '<thumb-position/>'],
  doubleTongue: ['technical', '<double-tongue/>'], tripleTongue: ['technical', '<triple-tongue/>'], heel: ['technical', '<heel/>'], toe: ['technical', '<toe/>'],
  arpeggio: ['', '<arpeggiate/>'], arpUp: ['', '<arpeggiate direction="up"/>'], arpDown: ['', '<arpeggiate direction="down"/>'],
};
// marks that replace each other
const EXCLUSIVE = [['trem1', 'trem2', 'trem3'], ['upBow', 'downBow'], ['fermata', 'fermataBelow'], ['arpeggio', 'arpUp', 'arpDown'], ['staccato', 'staccatissimo', 'spiccato']];
const CHORD_WIDE = new Set(['arpeggio', 'arpUp', 'arpDown']);

const tagOf = (el) => el.match(/^<([a-z-]+)/)[1];
const attrsOf = (el) => (el.match(/^<[a-z-]+([^>]*?)\/?>/)?.[1] || '').trim();
/** Splits <notations> content into top-level elements. */
function splitTop(xml) {
  const out = [];
  let i = 0;
  while (i < xml.length) {
    const m = xml.slice(i).match(/^<([a-zA-Z-]+)([^>]*?)(\/?)>/);
    if (!m) { i++; continue; }
    if (m[3] === '/') { out.push(m[0]); i += m[0].length; continue; }
    // find the matching close tag (no nesting of the same tag inside notations groups)
    const close = `</${m[1]}>`;
    const j = xml.indexOf(close, i);
    if (j < 0) { out.push(xml.slice(i)); break; }
    out.push(xml.slice(i, j + close.length));
    i = j + close.length;
  }
  return out;
}
function groupItems(el) {
  const inner = el.replace(/^<[a-z-]+[^>]*>/, '').replace(/<\/[a-z-]+>$/, '');
  return splitTop(inner);
}
const innerOf = (n) => (n?.notationsXml || '').replace(/^<notations>/, '').replace(/<\/notations>$/, '');
const sameEl = (a, b) => tagOf(a) === tagOf(b) && (attrsOf(a) === attrsOf(b) || ['tremolo', 'fingering', 'string', 'fret', 'pluck'].includes(tagOf(a))) && (tagOf(a) !== 'tremolo' || a === b);

/** Does the note carry this mark? */
export function hasMark(n, id) {
  const m = MARKS[id];
  if (!m || !n) return false;
  const top = splitTop(innerOf(n));
  if (!m[0]) return top.some((e) => e === m[1] || (tagOf(e) === tagOf(m[1]) && attrsOf(e) === attrsOf(m[1])));
  const g = top.find((e) => tagOf(e) === m[0]);
  return !!g && groupItems(g).some((e) => e === m[1] || (tagOf(e) === tagOf(m[1]) && attrsOf(e) === attrsOf(m[1]) && tagOf(e) !== 'tremolo'));
}

/** Rebuilds a note's <notations> with `fn(items by group)`. groups: {'' : [...], articulations: [...], ...} */
function editNotations(n, fn) {
  const top = splitTop(innerOf(n));
  const groups = { '': [], articulations: [], ornaments: [], technical: [] };
  for (const e of top) {
    const t = tagOf(e);
    if (groups[t] && t !== '') groups[t].push(...groupItems(e)); else groups[''].push(e);
  }
  fn(groups);
  let xml = groups[''].join('');
  for (const g of ['articulations', 'ornaments', 'technical']) if (groups[g].length) xml += `<${g}>${groups[g].join('')}</${g}>`;
  // stored as the inside of <notations> (as the MusicXML reader keeps it); the writer adds the wrapper
  return { ...n, notationsXml: xml };
}

function mapNotes(score, test, fn) {
  let changed = false;
  const parts = score.parts.map((p) => ({ ...p, measures: p.measures.map((m) => {
    if (!m.notes.some(test)) return m;
    return { ...m, notes: m.notes.map((n) => { if (!test(n)) return n; changed = true; return fn(n); }) };
  }) }));
  return changed ? { ...score, parts } : score;
}
/** The note and, for chord-wide marks, the other notes of its chord. */
function chordMates(score, id) {
  const loc = findNote(score, id);
  if (!loc) return new Set();
  const n = loc.note;
  return new Set(loc.pm.notes.filter((x) => x.off.eq(n.off) && (x.staff || 1) === (n.staff || 1) && String(x.voice) === String(n.voice) && !x.rest).map((x) => x.id));
}

/** Adds or removes a mark on a note (chord-wide marks go on every note of the chord). */
export function toggleMark(score, id, markId) {
  const m = MARKS[markId];
  if (!m) return score;
  const loc = findNote(score, id);
  if (!loc || loc.note.rest) return score;
  const on = hasMark(loc.note, markId);
  const ids = CHORD_WIDE.has(markId) ? chordMates(score, id) : new Set([id]);
  const rivals = (EXCLUSIVE.find((x) => x.includes(markId)) || [markId]).map((k) => MARKS[k]);
  return mapNotes(score, (n) => ids.has(n.id), (n) => editNotations(n, (g) => {
    const list = g[m[0]];
    for (const r of rivals) {
      const at = list.findIndex((e) => e === r[1] || (tagOf(e) === tagOf(r[1]) && attrsOf(e) === attrsOf(r[1]) && tagOf(e) !== 'tremolo'));
      if (at >= 0) list.splice(at, 1);
    }
    if (!on) list.push(m[1]);
  }));
}

/** Fingering (1–5, 0, p i m a, or any short text) above or below a note; '' removes it. */
export function setFingering(score, id, value, placement = 'above') {
  const v = String(value ?? '').trim();
  return mapNotes(score, (n) => n.id === id && !n.rest, (n) => editNotations(n, (g) => {
    g.technical = g.technical.filter((e) => tagOf(e) !== 'fingering');
    if (v) g.technical.unshift(`<fingering placement="${placement}">${esc(v)}</fingering>`);
  }));
}
export const fingeringOf = (n) => (innerOf(n).match(/<fingering[^>]*>([^<]*)<\/fingering>/) || [])[1] || '';

/** A string number for a note (written as <string>, shown by MuseScore; the studio also shows it as text). */
export function setStringNo(score, id, k) {
  return mapNotes(score, (n) => n.id === id && !n.rest, (n) => editNotations(n, (g) => {
    g.technical = g.technical.filter((e) => tagOf(e) !== 'string');
    if (k) g.technical.push(`<string>${k}</string>`);
  }));
}

// -------------------------------------------------------------------------------------- marks between notes
/** The next note (not a rest, not a chord note) after `id` in the same part, staff and voice, over bar lines. */
export function nextNote(score, id, { rests = false } = {}) {
  const loc = findNote(score, id);
  if (!loc) return null;
  const n = loc.note, part = score.parts[loc.pi];
  for (let mi = loc.mi; mi < part.measures.length; mi++) {
    const list = part.measures[mi].notes.filter((x) => (x.staff || 1) === (n.staff || 1) && String(x.voice) === String(n.voice) && !x.chord && !x.grace && (rests || !x.rest))
      .sort((a, b) => a.off.cmp(b.off));
    const hit = list.find((x) => mi > loc.mi || x.off.gt(n.off));
    if (hit) return { note: hit, mi };
  }
  return null;
}

export const LINKS = {
  slur: ['', (t) => `<slur type="${t}" number="1"/>`, /<slur [^>]*type="(start|stop)"[^>]*\/>/g],
  gliss: ['', (t) => `<glissando type="${t}" line-type="wavy"/>`, /<glissando [^>]*\/>/g],
  slide: ['', (t) => `<slide type="${t}" line-type="solid"/>`, /<slide [^>]*\/>/g],
  hammer: ['technical', (t) => (t === 'start' ? '<hammer-on type="start">H</hammer-on>' : '<hammer-on type="stop"/>'), /<hammer-on[^>]*(\/>|>[^<]*<\/hammer-on>)/g],
  pull: ['technical', (t) => (t === 'start' ? '<pull-off type="start">P</pull-off>' : '<pull-off type="stop"/>'), /<pull-off[^>]*(\/>|>[^<]*<\/pull-off>)/g],
};
const linkTag = { slur: 'slur', gliss: 'glissando', slide: 'slide', hammer: 'hammer-on', pull: 'pull-off' };
/** Does a link (slur, gliss...) start on this note? */
export const linkStarts = (n, kind) => new RegExp(`<${linkTag[kind]}[^>]*type="start"`).test(innerOf(n));

/** Starts (or removes) a slur / glissando / slide / hammer-on / pull-off from the note to the next one. */
export function toggleLink(score, id, kind) {
  const L = LINKS[kind];
  const loc = findNote(score, id);
  if (!L || !loc || loc.note.rest) return score;
  const next = nextNote(score, id);
  if (!next) return score;
  const tag = linkTag[kind];
  const remove = linkStarts(loc.note, kind);
  const edit = (type) => (n) => editNotations(n, (g) => {
    g[L[0]] = g[L[0]].filter((e) => !(tagOf(e) === tag && new RegExp(`type="${type}"`).test(e)));
    if (!remove) g[L[0]].push(L[1](type));
  });
  let out = mapNotes(score, (n) => n.id === id, edit('start'));
  out = mapNotes(out, (n) => n.id === next.note.id, edit('stop'));
  // hammer-ons and pull-offs are shown with a slur, as guitarists write them
  if (kind === 'hammer' || kind === 'pull') {
    const slurred = linkStarts(findNote(out, id).note, 'slur');
    if (remove === slurred) out = toggleLink(out, id, 'slur');
  }
  return out;
}

/** Ties the note to the next one when it has the same pitch (or unties it). */
export function toggleTie(score, id) {
  const loc = findNote(score, id);
  const next = loc && nextNote(score, id);
  if (!loc || !next || !loc.note.pitch || !next.note.pitch || midiOf(loc.note.pitch) !== midiOf(next.note.pitch)) return score;
  const on = !loc.note.tie?.start;
  let out = mapNotes(score, (n) => n.id === id, (n) => ({ ...n, tie: { ...n.tie, start: on }, notationsXml: on ? n.notationsXml : (n.notationsXml || '').replace(/<tied type="start"\/>/, '') }));
  out = mapNotes(out, (n) => n.id === next.note.id, (n) => ({ ...n, tie: { ...n.tie, stop: on }, notationsXml: on ? n.notationsXml : (n.notationsXml || '').replace(/<tied type="stop"\/>/, '') }));
  return out;
}

// -------------------------------------------------------------------------------------- places in a bar
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function withPM(score, pi, mi, fn) {
  return { ...score, parts: score.parts.map((p, i) => (i !== pi ? p : { ...p, measures: p.measures.map((m, j) => (j !== mi ? m : fn(m))) })) };
}
function putDirection(score, pi, mi, off, staff, xml, { replace = null, extra = {} } = {}) {
  return withPM(score, pi, mi, (m) => {
    const keep = (m.directions || []).filter((d) => !(replace && d.off.eq(off) && (d.staff || 1) === staff && replace(d)));
    return { ...m, directions: [...keep, { off, staff, xml, ...extra }].sort((a, b) => a.off.cmp(b.off)) };
  });
}

export const DYNAMICS_ALL = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sf', 'sfz', 'sffz', 'sfp', 'fp', 'fz', 'rfz'];
/** A dynamic under the staff (replacing one at the same place). */
export function putDynamic(score, pi, mi, off, staff, dyn) {
  if (!DYNAMICS_ALL.includes(dyn)) return score;
  const xml = `<direction placement="below"><direction-type><dynamics><${dyn}/></dynamics></direction-type><staff>${staff}</staff></direction>`;
  return putDirection(score, pi, mi, off, staff, xml, { replace: (d) => d.dyn || /<dynamics>/.test(d.xml), extra: { dyn } });
}

/** Text at a place: expression (italic, below), technique (above), tempo (bold, above). Same text again removes it. */
export function toggleText(score, pi, mi, off, staff, text, style = 'expression') {
  const t = String(text || '').trim();
  if (!t) return score;
  const pm = score.parts[pi]?.measures[mi];
  const has = (pm?.directions || []).find((d) => d.off.eq(off) && (d.staff || 1) === staff && d.text === t);
  if (has) return withPM(score, pi, mi, (m) => ({ ...m, directions: m.directions.filter((d) => d !== has) }));
  const fmt = style === 'tempo' ? ' font-weight="bold"' : style === 'expression' ? ' font-style="italic"' : '';
  const place = style === 'expression' ? 'below' : 'above';
  const xml = `<direction placement="${place}"><direction-type><words${fmt}>${esc(t)}</words></direction-type><staff>${staff}</staff></direction>`;
  return putDirection(score, pi, mi, off, staff, xml, { extra: { text: t } });
}

export const TEMPO_MARKS = [['Largo', 50], ['Adagio', 66], ['Andante', 76], ['Moderato', 96], ['Allegretto', 108], ['Allegro', 126], ['Vivace', 152], ['Presto', 176]];
/** A tempo mark (word and metronome) at the start of a bar; playback follows it. */
export function putTempo(score, mi, word, bpm) {
  const xml = `<direction placement="above"><direction-type><words font-weight="bold">${esc(word)}</words></direction-type><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>`;
  const out = putDirection(score, 0, mi, ZERO, 1, xml, { replace: (d) => /<metronome|tempo=/.test(d.xml) });
  return { ...out, measures: out.measures.map((m, i) => (i === mi ? { ...m, tempo: bpm } : m)) };
}

/** Rehearsal mark A, B, C... at the start of a bar (the next free letter). */
export function putRehearsal(score, mi) {
  const used = new Set();
  for (const pm of score.parts[0].measures) for (const d of pm.directions || []) { const m = d.xml.match(/<rehearsal[^>]*>([^<]*)</); if (m) used.add(m[1]); }
  const here = (score.parts[0].measures[mi]?.directions || []).find((d) => /<rehearsal/.test(d.xml));
  if (here) return withPM(score, 0, mi, (m) => ({ ...m, directions: m.directions.filter((d) => d !== here) }));
  let L = 'A';
  for (let i = 0; i < 26 && used.has(L); i++) L = String.fromCharCode(66 + i);
  return putDirection(score, 0, mi, ZERO, 1, `<direction placement="above"><direction-type><rehearsal>${L}</rehearsal></direction-type></direction>`);
}

// Segno, Coda and the jumps: shown, and followed when the piece plays
export const JUMPS = {
  segno: ['<direction placement="above"><direction-type><segno/></direction-type><sound segno="s1"/></direction>', { segno: 's1' }],
  coda: ['<direction placement="above"><direction-type><coda/></direction-type><sound coda="c1"/></direction>', { coda: 'c1' }],
  fine: ['<direction placement="above"><direction-type><words font-style="italic">Fine</words></direction-type><sound fine="yes"/></direction>', { fine: true, fineWords: true }],
  dc: ['<direction placement="above"><direction-type><words font-style="italic">D.C.</words></direction-type><sound dacapo="yes"/></direction>', { dacapo: true }],
  dcFine: ['<direction placement="above"><direction-type><words font-style="italic">D.C. al Fine</words></direction-type><sound dacapo="yes"/></direction>', { dacapo: true }],
  ds: ['<direction placement="above"><direction-type><words font-style="italic">D.S.</words></direction-type><sound dalsegno="s1"/></direction>', { dalsegno: 's1' }],
  dsCoda: ['<direction placement="above"><direction-type><words font-style="italic">D.S. al Coda</words></direction-type><sound dalsegno="s1"/></direction>', { dalsegno: 's1' }],
  toCoda: ['<direction placement="above"><direction-type><words font-style="italic">To Coda</words></direction-type><sound tocoda="c1"/></direction>', { tocoda: 'c1' }],
};
/** Segno, Coda, Fine, D.C., D.S., To Coda on a bar (again removes it). Endings sit at the end of the bar. */
export function toggleJump(score, mi, kind) {
  const J = JUMPS[kind];
  if (!J) return score;
  const atEnd = ['fine', 'dc', 'dcFine', 'ds', 'dsCoda', 'toCoda'].includes(kind);
  const off = atEnd ? score.measures[mi].dur : ZERO;
  const pm = score.parts[0].measures[mi];
  const has = (pm.directions || []).find((d) => d.jump === kind);
  let out = has ? withPM(score, 0, mi, (m) => ({ ...m, directions: m.directions.filter((d) => d !== has) }))
    : putDirection(score, 0, mi, off, 1, J[0], { extra: { jump: kind } });
  out = { ...out, measures: out.measures.map((m, i) => {
    if (i !== mi) return m;
    const j = { ...(m.jumps || {}) };
    for (const [k, v] of Object.entries(J[1])) { if (has) delete j[k]; else j[k] = v; }
    return { ...m, jumps: j };
  }) };
  return out;
}

// -------------------------------------------------------------------------------------- lines over bars
export const SPANS = {
  cresc: ['below', '<wedge type="crescendo"/>', '<wedge type="stop"/>'],
  dim: ['below', '<wedge type="diminuendo"/>', '<wedge type="stop"/>'],
  pedal: ['below', '<pedal type="start" line="yes"/>', '<pedal type="stop" line="yes"/>'],
  ped: ['below', '<pedal type="start" line="no"/>', '<pedal type="stop" line="no"/>'],
  '8va': ['above', '<octave-shift type="down" size="8"/>', '<octave-shift type="stop" size="8"/>'],
  '8vb': ['below', '<octave-shift type="up" size="8"/>', '<octave-shift type="stop" size="8"/>'],
  '15ma': ['above', '<octave-shift type="down" size="15"/>', '<octave-shift type="stop" size="15"/>'],
  crescText: ['below', '<words font-style="italic">cresc.</words>', '<dashes type="stop"/>'],
  rit: ['above', '<words font-style="italic">rit.</words>', null],
  letRing: ['above', '<words font-style="italic">let ring</words>', null],
  pm: ['above', '<words>P.M.</words>', null],
};
/** A line from the place to the end of the bar, or over `bars` bars (hairpin, pedal, ottava...). */
export function putSpan(score, pi, mi, off, staff, kind, bars = 1) {
  const S = SPANS[kind];
  if (!S) return score;
  const last = Math.min(score.measures.length - 1, mi + Math.max(1, bars) - 1);
  const d = (x) => `<direction placement="${S[0]}"><direction-type>${x}</direction-type><staff>${staff}</staff></direction>`;
  let out = putDirection(score, pi, mi, off, staff, d(S[1]), { extra: { span: kind } });
  if (S[2] && !/<dashes/.test(S[2])) out = putDirection(out, pi, last, out.measures[last].dur, staff, d(S[2]), { extra: { span: `${kind}-end` } });
  return out;
}
/** Removes the lines, text and dynamics that start at a place. */
export function clearPlace(score, pi, mi, off, staff) {
  return withPM(score, pi, mi, (m) => ({ ...m, directions: (m.directions || []).filter((d) => !(d.off.eq(off) && (d.staff || 1) === staff && !/<metronome|tempo=/.test(d.xml))) }));
}

// -------------------------------------------------------------------------------------- bars
const restNote = (dur, staff, voice) => makeNote({ id: newId('r'), off: ZERO, dur, rest: true, measureRest: true, voice, staff, type: typeFor(dur)?.type || 'whole' });
function renumber(score) {
  let start = ZERO;
  return { ...score, measures: score.measures.map((m, i) => { const x = { ...m, number: String(i + 1), start }; start = start.add(m.dur); return x; }) };
}
/** Barline at the end of a bar: 'normal' | 'double' | 'final' | 'repeatEnd'; 'repeatStart' sits at its start. */
export function setBarline(score, mi, kind) {
  return { ...score, measures: score.measures.map((m, i) => {
    if (i !== mi) return m;
    if (kind === 'repeatStart') return { ...m, left: m.left?.repeat ? { ...m.left, repeat: null, style: null } : { ...m.left, repeat: 'forward', style: 'heavy-light' } };
    const right = { ...(m.right || {}), repeat: null, style: null };
    if (kind === 'double') right.style = 'light-light';
    if (kind === 'final') right.style = 'light-heavy';
    if (kind === 'repeatEnd') { right.repeat = 'backward'; right.style = 'light-heavy'; }
    return { ...m, right };
  }) };
}
/** 1st or 2nd ending over a bar (again removes it). */
export function toggleEnding(score, mi, number) {
  return { ...score, measures: score.measures.map((m, i) => {
    if (i !== mi) return m;
    const on = m.left?.ending?.number === String(number);
    return { ...m, left: { ...(m.left || {}), ending: on ? null : { number: String(number), type: 'start', text: `${number}.` } },
      right: { ...(m.right || {}), ending: on ? null : { number: String(number), type: number === 1 ? 'stop' : 'discontinue', text: null } } };
  }) };
}
/** A new empty bar before bar `mi` (or after the last one with mi = length). */
export function insertBar(score, mi) {
  const at = Math.max(0, Math.min(score.measures.length, mi));
  const ref = score.measures[Math.min(at, score.measures.length - 1)];
  const time = timeAt(score, Math.min(at, score.measures.length - 1));
  const dur = measureLength(time);
  const meta = { number: '', implicit: false, start: ZERO, dur, time: null, tempo: null, left: {}, right: {}, jumps: {} };
  const out = {
    ...score,
    measures: [...score.measures.slice(0, at), meta, ...score.measures.slice(at)],
    parts: score.parts.map((p) => {
      const notes = [];
      for (let st = 1; st <= (p.staves || 1); st++) notes.push(restNote(dur, st, st === 2 ? '5' : '1'));
      const pm = { key: null, clefs: [], harmonies: [], notes, directions: [], extraAttrs: [] };
      const ms = [...p.measures.slice(0, at), pm, ...p.measures.slice(at)];
      // the first bar keeps the key, clef and time when a bar goes in before it
      if (at === 0 && ms[1]) { ms[0] = { ...ms[0], key: ms[1].key, clefs: ms[1].clefs }; ms[1] = { ...ms[1], key: null, clefs: [] }; }
      return { ...p, measures: ms };
    }),
  };
  if (at === 0) { out.measures[0] = { ...out.measures[0], time: ref.time, tempo: ref.tempo }; out.measures[1] = { ...out.measures[1], time: null }; }
  return renumber(out);
}
/** Removes a bar (the score keeps at least one). */
export function deleteBar(score, mi) {
  if (score.measures.length <= 1 || !score.measures[mi]) return score;
  const out = {
    ...score,
    measures: score.measures.filter((_, i) => i !== mi),
    parts: score.parts.map((p) => {
      const ms = p.measures.filter((_, i) => i !== mi);
      if (mi === 0 && ms[0]) ms[0] = { ...ms[0], key: ms[0].key || p.measures[0].key, clefs: ms[0].clefs?.length ? ms[0].clefs : p.measures[0].clefs };
      return { ...p, measures: ms };
    }),
  };
  if (mi === 0) out.measures[0] = { ...out.measures[0], time: out.measures[0].time || score.measures[0].time, tempo: out.measures[0].tempo || score.measures[0].tempo };
  return renumber(out);
}
/** Clears a bar of one part back to rests (marks, lines and text in it go too). */
export function clearBar(score, pi, mi) {
  const dur = score.measures[mi].dur;
  return withPM(score, pi, mi, (m) => {
    const staves = [...new Set(m.notes.map((n) => n.staff || 1))];
    return { ...m, notes: (staves.length ? staves : [1]).map((st) => restNote(dur, st, m.notes.find((n) => (n.staff || 1) === st)?.voice || (st === 2 ? '5' : '1'))), directions: [], harmonies: pi === 0 ? [] : m.harmonies };
  });
}
/** What a bar holds, to paste elsewhere. */
export function copyBar(score, pi, mi) {
  const m = score.parts[pi]?.measures[mi];
  return m ? { dur: score.measures[mi].dur, notes: m.notes, directions: m.directions || [], harmonies: m.harmonies || [] } : null;
}
/** Pastes a copied bar (same length only), with new note ids. */
export function pasteBar(score, pi, mi, clip) {
  if (!clip || !score.measures[mi] || !clip.dur.eq(score.measures[mi].dur)) return null;
  return withPM(score, pi, mi, (m) => ({ ...m, notes: clip.notes.map((n) => ({ ...n, id: newId(n.rest ? 'r' : 'n') })), directions: clip.directions.map((d) => ({ ...d })), harmonies: pi === 0 ? clip.harmonies.map((h) => ({ ...h })) : m.harmonies }));
}
/** A new time signature from bar `mi` to the end; only bars that hold nothing yet can change. */
export function setTimeFrom(score, mi, [beats, beatType]) {
  const empty = (i) => score.parts.every((p) => p.measures[i]?.notes.every((n) => n.rest));
  for (let i = mi; i < score.measures.length; i++) if (!empty(i)) return null;
  const dur = q(beats * 4, beatType);
  const out = {
    ...score,
    measures: score.measures.map((m, i) => (i < mi ? m : { ...m, dur, time: i === mi ? { beats, beatType } : null })),
    parts: score.parts.map((p) => ({ ...p, measures: p.measures.map((pm, i) => (i < mi ? pm : { ...pm, notes: [...new Set(pm.notes.map((n) => n.staff || 1))].map((st) => restNote(dur, st, pm.notes.find((n) => (n.staff || 1) === st)?.voice || '1')) })) })),
  };
  return renumber(out);
}
export const CLEFS = { treble: { sign: 'G', line: 2 }, bass: { sign: 'F', line: 4 }, alto: { sign: 'C', line: 3 }, tenor: { sign: 'C', line: 4 }, treble8vb: { sign: 'G', line: 2, oct: -1 }, percussion: { sign: 'percussion', line: null } };
/** A clef from the start of a bar on, for one staff. */
export function setClef(score, pi, mi, staff, kind) {
  const c = CLEFS[kind];
  if (!c) return score;
  return withPM(score, pi, mi, (m) => ({ ...m, clefs: [...(m.clefs || []).filter((x) => x.staff !== staff || (x.off && !x.off.isZero())), { staff, sign: c.sign, line: c.line, oct: c.oct || 0, off: ZERO }] }));
}

// -------------------------------------------------------------------------------------- auto fingering
const OPEN = { violin: [55, 62, 69, 76], viola: [48, 55, 62, 69], cello: [36, 43, 50, 57], doublebass: [28, 33, 38, 43], erhu: [62, 69] };
const VIOLIN_F = [0, 1, 1, 2, 2, 3, 3, 4];           // semitones above the open string → finger, first position
const CELLO_F = [0, 1, 1, 2, 3, 4];
export const autoFingerable = (instrument) => !!OPEN[instrument] || ['piano', 'keyboard', 'organ'].includes(instrument);
/**
 * Suggested fingering for a whole part: strings in first position (open strings where they can be), piano by
 * hand position (a thumb under when the line runs out of fingers). Notes it can't place are left alone.
 * Returns {score, count}.
 */
export function autoFingering(score, pi) {
  const part = score.parts[pi];
  if (!part) return { score, count: 0 };
  const inst = part.instrument;
  let count = 0;
  const marks = new Map();
  if (OPEN[inst]) {
    const opens = OPEN[inst], table = ['cello', 'doublebass'].includes(inst) ? CELLO_F : VIOLIN_F;
    for (const pm of part.measures) for (const n of pm.notes) {
      if (n.rest || !n.pitch || n.chord || n.tie?.stop) continue;
      const m = midiOf(n.pitch);
      let best = null;
      opens.forEach((o, si) => { const d = m - o; if (d >= 0 && d < table.length && (best === null || si > best.si && d <= (table === CELLO_F ? 5 : 7))) best = { si, f: table[d] }; });
      // an open string is easier than a 4th finger: prefer the next string's open note
      if (best) { marks.set(n.id, String(best.f)); count++; }
    }
  } else if (['piano', 'keyboard', 'organ'].includes(inst)) {
    const dia = (p) => p.octave * 7 + 'CDEFGAB'.indexOf(p.step);
    for (const staff of [1, 2]) {
      const right = staff === 1;
      const line = [];
      for (const pm of part.measures) {
        const heads = pm.notes.filter((n) => (n.staff || 1) === staff && !n.rest && n.pitch && !n.tie?.stop);
        const byOff = new Map();
        for (const n of heads) { const k = n.off.num(); const cur = byOff.get(k); if (!cur || (right ? midiOf(n.pitch) > midiOf(cur.pitch) : midiOf(n.pitch) < midiOf(cur.pitch))) byOff.set(k, n); }
        line.push(...[...byOff.values()].sort((a, b) => a.off.cmp(b.off)));
      }
      let anchor = null; // the white-key step under the thumb (right hand) or the 5th finger (left hand)
      for (const n of line) {
        const d = dia(n.pitch);
        if (anchor === null) anchor = d;
        let f = right ? d - anchor + 1 : 5 - (d - anchor);
        if (f < 1 || f > 5) {
          // out of reach: move the hand so the note falls on the thumb going away from the last notes, 5th coming back
          const goingUp = d > anchor;
          if (right) anchor = goingUp ? d : d - 4; else anchor = goingUp ? d - 4 : d;
          f = right ? d - anchor + 1 : 5 - (d - anchor);
        }
        marks.set(n.id, String(f));
        count++;
      }
    }
  }
  if (!count) return { score, count: 0 };
  const placement = (n) => ((n.staff || 1) === 2 ? 'below' : 'above');
  const out = mapNotes(score, (n) => marks.has(n.id), (n) => editNotations(n, (g) => {
    g.technical = g.technical.filter((e) => tagOf(e) !== 'fingering');
    g.technical.unshift(`<fingering placement="${placement(n)}">${marks.get(n.id)}</fingering>`);
  }));
  return { score: out, count };
}
/** Removes all fingering from a part. */
export function clearFingering(score, pi) {
  const ids = new Set();
  for (const pm of score.parts[pi]?.measures || []) for (const n of pm.notes) if (/<fingering/.test(n.notationsXml || '')) ids.add(n.id);
  return mapNotes(score, (n) => ids.has(n.id), (n) => editNotations(n, (g) => { g.technical = g.technical.filter((e) => tagOf(e) !== 'fingering'); }));
}

// -------------------------------------------------------------------------------------- lyrics
/** The lyric under a note: "Hap-" starts a word, "-py" ends it; '' removes it. */
export function setLyric(score, id, text) {
  const raw = String(text ?? '').trim();
  return mapNotes(score, (n) => n.id === id && !n.rest, (n) => {
    if (!raw) return { ...n, lyrics: [] };
    const begin = /-$/.test(raw), cont = /^-/.test(raw);
    const word = raw.replace(/^-|-$/g, '');
    const syl = begin && cont ? 'middle' : begin ? 'begin' : cont ? 'end' : 'single';
    return { ...n, lyrics: [{ n: '1', syl, text: word, ext: false }] };
  });
}
export const lyricOf = (n) => { const l = n?.lyrics?.[0]; if (!l) return ''; return `${l.syl === 'middle' || l.syl === 'end' ? '-' : ''}${l.text}${l.syl === 'begin' || l.syl === 'middle' ? '-' : ''}`; };

// -------------------------------------------------------------------------------------- drums
const KIT_BY = Object.fromEntries(KIT.map((k) => [k.id, k]));
const drumNote = (k, fields) => ({ ...makeNote({ ...fields, pitch: null, unpitched: { step: k.step, octave: k.oct } }), noteheadXml: k.head ? `<notehead>${k.head}</notehead>` : '', stem: 'up' });
/** A drum note written in the bar at a place (or added to the hit already there with together = true). */
export function writeDrum(score, cur, kitId, len, together = false) {
  const k = KIT_BY[kitId];
  if (!k) return null;
  const pi = cur.pi || 0, mi = cur.mi;
  if (!score.parts[pi]?.measures[mi]) return null;
  if (together) {
    // the hit just before the cursor (in this bar or the one before) gets another instrument
    const before = noteBefore(score, cur);
    if (!before || before.note.rest) return null;
    const h = before.note, hm = before.mi;
    const hpm = score.parts[pi].measures[hm];
    if (hpm.notes.some((n) => n.off.eq(h.off) && n.unpitched?.step === k.step && n.unpitched?.octave === k.oct)) return { score, cur };
    const add = drumNote(k, { id: newId(), off: h.off, dur: h.dur, voice: h.voice, staff: 1, chord: true, type: h.type, dots: h.dots, tm: h.tm });
    return { score: withPM(score, pi, hm, (m) => ({ ...m, notes: [...m.notes, add].sort((a, b) => a.off.cmp(b.off) || (a.chord ? 1 : 0) - (b.chord ? 1 : 0)) })), cur };
  }
  return null; // single notes go through writeAt with {drum: kitId}
}
/** A drum note's fields for writeAt. */
export const drumFields = (kitId) => { const k = KIT_BY[kitId]; return k ? { unpitched: { step: k.step, octave: k.oct }, noteheadXml: k.head ? `<notehead>${k.head}</notehead>` : '' } : null; };

// grooves: steps per beat, then for each step the kit pieces that sound ('' = nothing)
export const GROOVES = {
  rock: { div: 2, steps: ['hihat kick', 'hihat', 'hihat snare', 'hihat', 'hihat kick', 'hihat kick', 'hihat snare', 'hihat'] },
  pop: { div: 2, steps: ['hihat kick', 'hihat', 'hihat snare', 'hihat kick', 'hihat', 'hihat kick', 'hihat snare', 'hihat'] },
  ballad: { div: 2, steps: ['ride kick', 'ride', 'ride rim', 'ride', 'ride kick', 'ride', 'ride rim', 'ride'] },
  disco: { div: 2, steps: ['hihat kick', 'openhat', 'hihat kick snare', 'openhat', 'hihat kick', 'openhat', 'hihat kick snare', 'openhat'] },
  funk: { div: 4, steps: ['hihat kick', 'hihat', 'hihat', 'hihat kick', 'hihat snare', 'hihat', 'hihat', 'hihat', 'hihat', 'hihat', 'hihat kick', 'hihat', 'hihat snare', 'hihat', 'hihat kick', 'hihat'] },
  halftime: { div: 2, steps: ['hihat kick', 'hihat', 'hihat', 'hihat', 'hihat snare', 'hihat', 'hihat', 'hihat kick'] },
  waltz: { div: 1, steps: ['ride kick', 'ride snare', 'ride snare'] },
  fill: { div: 4, steps: ['snare', 'snare', 'snare', 'snare', 'tom1', 'tom1', 'tom1', 'tom1', 'tom2', 'tom2', 'tom2', 'tom2', 'floortom', 'floortom', 'kick floortom', 'crash kick'] },
  crash: { div: 1, steps: ['crash kick', '', '', ''] },
};
/** Fills a bar with a groove (the bar's own length; patterns repeat or are cut to fit). */
export function fillGroove(score, pi, mi, id) {
  const G = GROOVES[id];
  if (!G) return score;
  const barLen = score.measures[mi].dur;
  const step = q(1, G.div);
  const n = Math.round(barLen.num() / step.num());
  const tf = typeFor(step);
  const notes = [];
  for (let i = 0; i < n; i++) {
    const hits = (G.steps[i % G.steps.length] || '').split(' ').filter(Boolean);
    const off = step.mul(q(i));
    if (!hits.length) { notes.push(makeNote({ id: newId('r'), off, dur: step, rest: true, voice: '1', staff: 1, type: tf?.type || 'quarter' })); continue; }
    hits.forEach((h, j) => notes.push(drumNote(KIT_BY[h], { id: newId(), off, dur: step, voice: '1', staff: 1, chord: j > 0, type: tf?.type || 'quarter' })));
  }
  const time = timeAt(score, mi);
  try { autoBeam(notes, time); } catch { /* drawn anyway */ }
  return withPM(score, pi, mi, (m) => ({ ...m, notes }));
}
/** A ghost note (in brackets) or back to normal, on drum notes. */
export function toggleGhost(score, id) {
  return mapNotes(score, (n) => n.id === id && n.unpitched, (n) => {
    const ghost = /parentheses="yes"/.test(n.noteheadXml || '');
    const head = (n.noteheadXml || '').match(/>([a-z-]+)</)?.[1] || 'normal';
    return { ...n, noteheadXml: ghost ? (head === 'normal' ? '' : `<notehead>${head}</notehead>`) : `<notehead parentheses="yes">${head}</notehead>` };
  });
}

// -------------------------------------------------------------------------------------- chords and pitches
/** Puts a chord box on the chord symbol at a place (part 1 holds the chord symbols); null d removes it. */
export function withFrame(score, mi, off, d) {
  return withPM(score, 0, mi, (m) => ({ ...m, harmonies: (m.harmonies || []).map((h) => (h.off.eq(off) ? (d ? { ...h, frame: d } : { ...h, frame: undefined }) : h)) }));
}
/** The note without its sharp or flat (C♯ → C). */
export function naturalize(score, id) {
  return mapNotes(score, (n) => n.id === id && n.pitch && n.pitch.alter, (n) => ({ ...n, pitch: { ...n.pitch, alter: 0 } }));
}

// -------------------------------------------------------------------------------------- piano hands
export const handsOf = (part) => (part?.staves || 1) >= 2;
export { keyAt, spellMidi };
