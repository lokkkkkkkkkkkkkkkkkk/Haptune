// MusicXML (.musicxml / .xml) reader and writer. Reading keeps every note, rest, tie, tuplet, voice,
// staff, lyric, chord symbol, clef, key, time, tempo, repeat, ending and jump exactly; markings the app
// does not need to understand (slurs, articulations, dynamics, fingering...) are carried through verbatim.
import { Q, q, ZERO } from './q.js';
import { parseChord, formatChord, QUALITIES } from './chords.js';
import { makeNote, newId, measureLength, computeAccidentals, divisionsFor, keyAt, recomputeStarts, autoBeam, timeAt, markTuplets } from './score.js';
import { nameOf } from './pitch.js';

// ---------- DOM helpers (browser DOM or @xmldom/xmldom) ----------
function kids(el) { const out = []; for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c); return out; }
function child(el, name) { for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c.nodeName === name) return c; return null; }
function named(el, name) { return kids(el).filter((c) => c.nodeName === name); }
function text(el, name) { const c = name ? child(el, name) : el; return c ? (c.textContent || '').trim() : null; }
function num(el, name, def = null) { const t = text(el, name); return t === null || t === '' || Number.isNaN(Number(t)) ? def : Number(t); }

const INSTRUMENT_NAMES = [
  [/violin|fiddle|violino/i, 'violin'], [/viola/i, 'viola'], [/cello|violoncello/i, 'cello'], [/contrabass|double bass|string bass/i, 'doublebass'],
  [/piano|pianoforte|keyboard|klavier/i, 'piano'], [/organ/i, 'organ'], [/harpsichord|cembalo/i, 'piano'],
  [/soprano|alto|tenor|bass|voice|vocal|voix|stimme|singer|melody|canto|melodie/i, 'voice'],
  [/flute|flauto|piccolo/i, 'flute'], [/recorder/i, 'recorder'], [/oboe/i, 'oboe'], [/clarinet/i, 'clarinet'], [/bassoon/i, 'bassoon'],
  [/sax/i, 'sax'], [/trumpet|cornet/i, 'trumpet'], [/trombone/i, 'trombone'], [/horn/i, 'horn'], [/tuba/i, 'tuba'],
  [/ukulele/i, 'ukulele'], [/bass guitar|electric bass/i, 'bassguitar'], [/guitar/i, 'guitar'], [/harp/i, 'harp'],
  [/erhu/i, 'erhu'], [/dizi/i, 'dizi'], [/guzheng/i, 'guzheng'], [/drum|percussion|kit/i, 'drums'],
];
export function instrumentFromName(name, program) {
  for (const [re, key] of INSTRUMENT_NAMES) if (re.test(name || '')) return key;
  if (program !== null && program !== undefined) {
    if (program < 8) return 'piano';
    if (program >= 40 && program <= 41) return program === 40 ? 'violin' : 'viola';
    if (program === 42) return 'cello';
    if (program >= 24 && program <= 31) return 'guitar';
    if (program >= 32 && program <= 39) return 'bassguitar';
    if (program >= 56 && program <= 63) return 'trumpet';
    if (program >= 64 && program <= 67) return 'sax';
    if (program >= 72 && program <= 79) return 'flute';
    if (program >= 52 && program <= 54) return 'voice';
  }
  return 'piano';
}

export const PROGRAMS = {
  piano: 0, organ: 19, violin: 40, viola: 41, cello: 42, doublebass: 43, voice: 52, flute: 73, recorder: 74, oboe: 68, clarinet: 71,
  bassoon: 70, sax: 65, trumpet: 56, trombone: 57, horn: 60, tuba: 58, guitar: 24, bassguitar: 33, ukulele: 24, harp: 46, erhu: 110,
  dizi: 72, guzheng: 107, drums: 0,
};

const KIND_TO_QUALITY = {};
for (const [k, v] of Object.entries(QUALITIES)) if (!v.degrees && !KIND_TO_QUALITY[v.kind]) KIND_TO_QUALITY[v.kind] = k;
Object.assign(KIND_TO_QUALITY, { major: 'maj', minor: 'min', dominant: '7', 'dominant-seventh': '7', 'major-minor': 'mMaj7', none: null, other: 'maj', pedal: '5', Neapolitan: 'maj', Italian: '7', French: '7b5', German: '7', Tristan: 'm7b5' });

function harmonyChord(h, serialize) {
  const rootEl = child(h, 'root');
  if (!rootEl) return null; // functional harmony (<numeral>) is not a chord symbol we can play
  const root = { step: text(rootEl, 'root-step') || 'C', alter: num(rootEl, 'root-alter', 0) };
  const kindEl = child(h, 'kind');
  const kind = kindEl ? text(kindEl) : 'major';
  const kindText = kindEl?.getAttribute('text');
  let bass = null;
  const bassEl = child(h, 'bass');
  if (bassEl) bass = { step: text(bassEl, 'bass-step') || 'C', alter: num(bassEl, 'bass-alter', 0) };
  if (kind === 'none') return { nc: true, text: 'N.C.' };
  const rootName = nameOf(root, { ascii: true });
  const bassName = bass ? '/' + nameOf(bass, { ascii: true }) : '';
  // 1) trust the printed text when it parses
  if (kindText !== null && kindText !== undefined) {
    const viaText = parseChord(rootName + kindText.replace(/\s/g, '') + bassName);
    if (viaText) return viaText;
  }
  // 2) kind + degrees
  let quality = KIND_TO_QUALITY[kind] ?? 'maj';
  const degrees = named(h, 'degree').map((d) => ({ v: num(d, 'degree-value'), a: num(d, 'degree-alter', 0), t: text(d, 'degree-type') }));
  for (const d of degrees) {
    if (d.t === 'add' && d.v === 9 && quality === 'maj') quality = 'add9';
    else if (d.t === 'add' && d.v === 9 && quality === 'min') quality = 'madd9';
    else if (d.t === 'add' && d.v === 7 && quality === 'sus4') quality = '7sus4';
    else if (d.t === 'alter' && d.v === 5 && d.a === -1 && quality === '7') quality = '7b5';
    else if (d.t === 'alter' && d.v === 5 && d.a === 1 && quality === '7') quality = 'aug7';
    else if ((d.t === 'add' || d.t === 'alter') && d.v === 9 && d.a === -1 && ['7', '9'].includes(quality)) quality = '7b9';
    else if ((d.t === 'add' || d.t === 'alter') && d.v === 9 && d.a === 1 && ['7', '9'].includes(quality)) quality = '7#9';
    else if (d.t === 'add' && d.v === 9 && quality === '6') quality = '69';
  }
  void serialize;
  const out = { root, quality: quality || 'maj' };
  if (bass) out.bass = bass;
  return out;
}

function parseDirectionSound(soundEl, measureMeta, off) {
  if (!soundEl) return;
  const tempo = soundEl.getAttribute('tempo');
  if (tempo && !Number.isNaN(Number(tempo)) && Number(tempo) > 0) {
    if (off.isZero() || !measureMeta.tempo) measureMeta.tempo = Number(tempo);
  }
  const j = measureMeta.jumps;
  if (soundEl.getAttribute('dacapo') === 'yes') j.dacapo = true;
  if (soundEl.getAttribute('dalsegno')) j.dalsegno = soundEl.getAttribute('dalsegno');
  if (soundEl.getAttribute('segno')) j.segno = soundEl.getAttribute('segno');
  if (soundEl.getAttribute('coda')) j.coda = soundEl.getAttribute('coda');
  if (soundEl.getAttribute('tocoda')) j.tocoda = soundEl.getAttribute('tocoda');
  if (soundEl.getAttribute('fine')) j.fine = true;
}

const UNIT_QUARTERS = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25 };

/**
 * Parses MusicXML text into a Score. `dom` = {DOMParser, XMLSerializer} (browser globals by default).
 */
export function parseMusicXML(xmlText, dom = globalThis) {
  const doc = new dom.DOMParser().parseFromString(xmlText, 'application/xml');
  const serializer = new dom.XMLSerializer();
  const serialize = (el) => serializer.serializeToString(el).replace(/\s+xmlns(:\w+)?="[^"]*"/g, '');
  let root = doc.documentElement;
  if (!root || root.nodeName === 'parsererror' || doc.getElementsByTagName('parsererror').length) {
    throw new Error('This file is not valid MusicXML (the XML could not be read).');
  }
  if (root.nodeName === 'score-timewise') root = timewiseToPartwise(root, doc);
  if (root.nodeName !== 'score-partwise') throw new Error('This XML file is not a MusicXML score.');

  const score = { title: '', composer: '', lyricist: '', arranger: '', rights: '', measures: [], parts: [], meta: { source: 'musicxml' } };
  const work = child(root, 'work');
  score.title = (work && text(work, 'work-title')) || text(root, 'movement-title') || '';
  if (!score.title) {
    // MuseScore and others put the title in a credit
    for (const cr of named(root, 'credit')) {
      const type = text(cr, 'credit-type');
      const words = child(cr, 'credit-words');
      if (words && (type === 'title' || (!type && !score.title && Number(words.getAttribute('font-size') || 0) >= 18))) { score.title = text(words); break; }
    }
  }
  const ident = child(root, 'identification');
  if (ident) {
    for (const c of named(ident, 'creator')) {
      const t = c.getAttribute('type');
      if (t === 'composer') score.composer = text(c);
      else if (t === 'lyricist' || t === 'poet') score.lyricist = text(c);
      else if (t === 'arranger') score.arranger = text(c);
    }
    score.rights = text(ident, 'rights') || '';
  }

  const partList = child(root, 'part-list');
  const partInfo = new Map();
  if (partList) {
    for (const sp of named(partList, 'score-part')) {
      const id = sp.getAttribute('id');
      const name = text(sp, 'part-name') || '';
      const abbr = text(sp, 'part-abbreviation') || '';
      const inst = child(sp, 'score-instrument');
      const instName = inst ? text(inst, 'instrument-name') : '';
      const midi = child(sp, 'midi-instrument');
      const program = midi && num(midi, 'midi-program') !== null ? num(midi, 'midi-program') - 1 : null;
      const channel = midi ? num(midi, 'midi-channel') : null;
      partInfo.set(id, { name: name === 'MusicXML Part' ? '' : name, abbr, instName, program, channel });
    }
  }

  const sharedMeta = [];
  const partEls = named(root, 'part');
  partEls.forEach((partEl, pi) => {
    const id = partEl.getAttribute('id') || `P${pi + 1}`;
    const info = partInfo.get(id) || { name: '', abbr: '', instName: '', program: null, channel: null };
    const part = {
      id, name: info.name || info.instName || `Part ${pi + 1}`, abbr: info.abbr, instrument: instrumentFromName(`${info.name} ${info.instName}`, info.program),
      program: info.program, transpose: null, staves: 1, measures: [], percussion: info.channel === 10,
    };
    let divisions = 1;
    named(partEl, 'measure').forEach((mEl, mi) => {
      const meta = sharedMeta[mi] || (sharedMeta[mi] = {
        number: mEl.getAttribute('number') || String(mi + 1), implicit: mEl.getAttribute('implicit') === 'yes',
        dur: ZERO, time: null, tempo: null, left: {}, right: {}, jumps: {},
      });
      const pm = { key: null, clefs: [], harmonies: [], notes: [], directions: [], extraAttrs: [] };
      let cursor = ZERO, maxCursor = ZERO, lastOnset = ZERO;
      const dq = (d) => q(Math.round(d), divisions);
      for (const el of kids(mEl)) {
        switch (el.nodeName) {
          case 'attributes': {
            const dv = num(el, 'divisions');
            if (dv) divisions = dv;
            const keyEl = child(el, 'key');
            if (keyEl && text(keyEl, 'fifths') !== null) {
              const mode = text(keyEl, 'mode') || 'major';
              pm.key = { fifths: num(keyEl, 'fifths', 0), mode: ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'ionian', 'locrian'].includes(mode) ? mode : 'major' };
            }
            const timeEl = child(el, 'time');
            if (timeEl && pi === 0) {
              const beatsTxt = text(timeEl, 'beats');
              const bt = num(timeEl, 'beat-type');
              if (beatsTxt && bt) {
                const beats = beatsTxt.split('+').reduce((s, x) => s + Number(x), 0);
                meta.time = { beats, beatType: bt, symbol: timeEl.getAttribute('symbol') || null, text: beatsTxt.includes('+') ? beatsTxt : null };
              } else if (child(timeEl, 'senza-misura')) meta.time = { beats: 4, beatType: 4, senza: true };
            }
            const st = num(el, 'staves');
            if (st) part.staves = st;
            for (const c of named(el, 'clef')) {
              pm.clefs.push({ staff: Number(c.getAttribute('number') || 1), sign: text(c, 'sign') || 'G', line: num(c, 'line', null), oct: num(c, 'clef-octave-change', 0), off: cursor });
            }
            const tr = child(el, 'transpose');
            if (tr) {
              const c = num(tr, 'chromatic', 0) + 12 * num(tr, 'octave-change', 0);
              const d = num(tr, 'diatonic', null);
              part.transpose = { c, d: d !== null ? d + 7 * num(tr, 'octave-change', 0) : Math.round(c * 7 / 12) };
              if (!part.transpose.c && !part.transpose.d) part.transpose = null;
            }
            // anything else (measure-style, staff-details...) is kept
            for (const x of kids(el)) if (['measure-style', 'staff-details'].includes(x.nodeName)) pm.extraAttrs.push(serialize(x));
            break;
          }
          case 'note': {
            const n = parseNote(el, dq, serialize);
            const prev = pm.notes[pm.notes.length - 1];
            if (n.chord && prev) {
              // a chord note belongs to the previous note's voice and staff, whatever its own tags say
              n.voice = prev.voice;
              if (!child(el, 'staff')) n.staff = prev.staff;
            }
            if (n.chord) n.off = lastOnset;
            else {
              n.off = cursor;
              lastOnset = cursor;
              if (!n.grace) cursor = cursor.add(n.dur);
            }
            if (n.measureRest && n.dur.isZero()) n.dur = meta.time ? measureLength(meta.time) : q(4);
            pm.notes.push(n);
            break;
          }
          case 'backup': cursor = cursor.sub(dq(num(el, 'duration', 0))); if (cursor.lt(0)) cursor = ZERO; break;
          case 'forward': cursor = cursor.add(dq(num(el, 'duration', 0))); break;
          case 'direction': {
            const offEl = child(el, 'offset');
            const off = offEl ? cursor.add(dq(Number(text(offEl)))) : cursor;
            if (offEl) el.removeChild(offEl);
            const sound = child(el, 'sound');
            if (pi === 0 || sound) parseDirectionSound(sound, meta, off);
            const dirType = named(el, 'direction-type');
            let dyn = null;
            for (const dt of dirType) {
              if (child(dt, 'segno') && !meta.jumps.segno) meta.jumps.segnoMark = true;
              if (child(dt, 'coda')) meta.jumps.codaMark = true;
              const met = child(dt, 'metronome');
              if (met && !meta.tempo && text(met, 'per-minute')) {
                const unit = UNIT_QUARTERS[text(met, 'beat-unit')] || 1;
                const dotted = !!child(met, 'beat-unit-dot');
                const pm2 = parseFloat(text(met, 'per-minute'));
                if (pm2 > 0) meta.tempo = Math.round(pm2 * unit * (dotted ? 1.5 : 1));
              }
              const dy = child(dt, 'dynamics');
              if (dy && kids(dy)[0]) dyn = kids(dy)[0].nodeName;
              const words = child(dt, 'words');
              if (words && pi === 0 && !sound) {
                const w = text(words);
                if (/^(D\.\s?C\.|Da Capo)/i.test(w)) meta.jumps.dacapoWords = true;
                if (/^(D\.\s?S\.|Dal Segno)/i.test(w)) meta.jumps.dalsegnoWords = true;
                if (/^Fine\.?$/i.test(w)) meta.jumps.fineWords = true;
                if (/^To Coda/i.test(w)) meta.jumps.tocodaWords = true;
              }
            }
            const staff = num(el, 'staff', 1);
            pm.directions.push({ off, staff, xml: serialize(el), dyn });
            break;
          }
          case 'harmony': {
            const offEl = child(el, 'offset');
            const off = offEl ? cursor.add(dq(Number(text(offEl)))) : cursor;
            const chord = harmonyChord(el, serialize);
            if (chord) {
              const kindEl = child(el, 'kind');
              const t = chord.nc ? 'N.C.' : formatChord(chord);
              pm.harmonies.push({ off, chord, text: t, printed: kindEl?.getAttribute('text') ?? null });
            }
            break;
          }
          case 'barline': {
            const loc = el.getAttribute('location') || 'right';
            const side = loc === 'left' ? meta.left : meta.right;
            if (pi === 0 && loc !== 'middle') {
              const style = text(el, 'bar-style');
              if (style) side.style = style;
              const rep = child(el, 'repeat');
              if (rep) { side.repeat = rep.getAttribute('direction'); if (rep.getAttribute('times')) side.times = Number(rep.getAttribute('times')); }
              const end = child(el, 'ending');
              if (end) side.ending = { number: end.getAttribute('number') || '1', type: end.getAttribute('type') || 'start', text: text(end) || null };
              if (child(el, 'segno')) meta.jumps.segnoMark = true;
              if (child(el, 'coda')) meta.jumps.codaMark = true;
            }
            break;
          }
          case 'sound': if (pi === 0) parseDirectionSound(el, meta, cursor); break;
          default: break;
        }
        if (cursor.gt(maxCursor)) maxCursor = cursor;
      }
      let len = maxCursor;
      pm.notes.forEach((n) => { if (n.off.add(n.dur).gt(len)) len = n.off.add(n.dur); });
      (meta.lens || (meta.lens = []))[pi] = len;
      part.measures.push(pm);
    });
    score.parts.push(part);
  });

  // finish shared measure data: a bar is as long as its time signature unless every part is shorter
  // (pickups, bars split by a repeat); a part that overfills a bar does not stretch the others.
  let time = { beats: 4, beatType: 4 };
  sharedMeta.forEach((m, i) => {
    if (m.time) time = m.time;
    const nominal = time.senza ? null : measureLength(time);
    let dur = ZERO;
    for (const len of m.lens || []) {
      if (!len) continue;
      const capped = nominal && len.gt(nominal) ? nominal : len;
      if (capped.gt(dur)) dur = capped;
    }
    m.dur = dur.isZero() ? (nominal || q(4)) : dur;
    delete m.lens;
    // turn marks into jump targets when the file has no <sound> attributes
    if (m.jumps.segnoMark && !m.jumps.segno) m.jumps.segno = 'segno';
    if (m.jumps.codaMark && !m.jumps.coda && !m.jumps.tocoda && i > 0) m.jumps.coda = 'coda';
    if (m.jumps.dacapoWords && !m.jumps.dacapo) m.jumps.dacapo = true;
    if (m.jumps.dalsegnoWords && !m.jumps.dalsegno) m.jumps.dalsegno = 'segno';
    if (m.jumps.fineWords && !m.jumps.fine) m.jumps.fine = true;
    if (m.jumps.tocodaWords && !m.jumps.tocoda) m.jumps.tocoda = 'coda';
    for (const k of ['segnoMark', 'codaMark', 'dacapoWords', 'dalsegnoWords', 'fineWords', 'tocodaWords']) delete m.jumps[k];
    if (i === 0 && m.dur.lt(measureLength(time)) && sharedMeta.length > 1) m.implicit = true;
  });
  score.measures = sharedMeta.map((m) => ({ ...m, start: ZERO }));
  // pad parts that are shorter than the score
  for (const part of score.parts) {
    while (part.measures.length < score.measures.length) part.measures.push({ key: null, clefs: [], harmonies: [], notes: [], directions: [], extraAttrs: [] });
    if (!part.measures[0].key) part.measures[0].key = { fifths: 0, mode: 'major' };
    if (!part.measures[0].clefs.length) part.measures[0].clefs.push({ staff: 1, sign: 'G', line: 2, oct: 0, off: ZERO });
  }
  if (!score.measures[0]?.time && score.measures[0]) score.measures[0].time = { beats: 4, beatType: 4 };
  recomputeStarts(score);
  return score;
}

function parseNote(el, dq, serialize) {
  const n = makeNote({ id: el.getAttribute('id') || newId() });
  const grace = child(el, 'grace');
  if (grace) n.grace = { slash: grace.getAttribute('slash') === 'yes' };
  n.cue = !!child(el, 'cue');
  n.chord = !!child(el, 'chord');
  const pitch = child(el, 'pitch');
  const rest = child(el, 'rest');
  const unp = child(el, 'unpitched');
  if (pitch) n.pitch = { step: text(pitch, 'step'), alter: Number(text(pitch, 'alter') || 0), octave: num(pitch, 'octave', 4) };
  else if (unp) n.unpitched = { step: text(unp, 'display-step') || 'E', octave: num(unp, 'display-octave', 4) };
  else if (rest) {
    n.rest = true;
    n.measureRest = rest.getAttribute('measure') === 'yes';
    if (text(rest, 'display-step')) n.restPos = { step: text(rest, 'display-step'), octave: num(rest, 'display-octave', 4) };
  }
  if (!n.pitch && !n.unpitched && !rest) n.rest = true;
  // fractional alters (quarter tones) are kept as numbers
  n.dur = grace ? ZERO : dq(num(el, 'duration', 0));
  for (const t of named(el, 'tie')) {
    if (t.getAttribute('type') === 'start') n.tie.start = true;
    if (t.getAttribute('type') === 'stop') n.tie.stop = true;
  }
  n.voice = text(el, 'voice') || '1';
  n.type = text(el, 'type') || null;
  n.dots = named(el, 'dot').length;
  const acc = child(el, 'accidental');
  if (acc) n.accidentalOrig = { value: text(acc), cautionary: acc.getAttribute('cautionary') === 'yes' || acc.getAttribute('parentheses') === 'yes' || acc.getAttribute('editorial') === 'yes' };
  const tm = child(el, 'time-modification');
  if (tm) n.tm = { actual: num(tm, 'actual-notes', 3), normal: num(tm, 'normal-notes', 2), normalType: text(tm, 'normal-type'), normalDots: named(tm, 'normal-dot').length };
  n.stem = text(el, 'stem');
  n.staff = num(el, 'staff', 1);
  const beams = named(el, 'beam');
  if (beams.length) n.beams = beams.map((b) => ({ n: Number(b.getAttribute('number') || 1), v: text(b) }));
  const nh = child(el, 'notehead');
  if (nh) n.noteheadXml = serialize(nh);
  const notations = named(el, 'notations');
  if (notations.length) {
    n.notationsXml = notations.map((x) => kids(x).map(serialize).join('')).join('');
    const artic = [];
    for (const nt of notations) {
      const a = child(nt, 'articulations');
      if (a) for (const k of kids(a)) artic.push(k.nodeName);
      if (child(nt, 'fermata')) artic.push('fermata');
      for (const tp of named(nt, 'tuplet')) {
        n.tuplet = n.tuplet || {};
        if (tp.getAttribute('type') === 'start') n.tuplet.start = true;
        if (tp.getAttribute('type') === 'stop') n.tuplet.stop = true;
      }
    }
    if (artic.length) n.artic = artic;
  }
  const dyn = el.getAttribute('dynamics');
  if (dyn && !Number.isNaN(Number(dyn))) n.vel = Math.max(1, Math.min(127, Math.round(Number(dyn) * 0.9)));
  for (const ly of named(el, 'lyric')) {
    const texts = named(ly, 'text').map((t) => t.textContent);
    if (!texts.length) continue;
    n.lyrics.push({
      n: ly.getAttribute('number') || '1', syl: text(ly, 'syllabic') || 'single', text: texts.join('‿'), ext: !!child(ly, 'extend'),
    });
  }
  return n;
}

function timewiseToPartwise(root, doc) {
  const out = doc.createElement('score-partwise');
  for (const el of kids(root)) if (el.nodeName !== 'measure') out.appendChild(el.cloneNode(true));
  const parts = new Map();
  for (const m of named(root, 'measure')) {
    for (const p of named(m, 'part')) {
      const id = p.getAttribute('id');
      if (!parts.has(id)) { const pe = doc.createElement('part'); pe.setAttribute('id', id); parts.set(id, pe); }
      const me = doc.createElement('measure');
      for (const a of ['number', 'implicit', 'width']) if (m.getAttribute(a)) me.setAttribute(a, m.getAttribute(a));
      for (const c of kids(p)) me.appendChild(c.cloneNode(true));
      parts.get(id).appendChild(me);
    }
  }
  for (const pe of parts.values()) out.appendChild(pe);
  return out;
}

// ---------- writer ----------

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function chordXml(h, divisions, cursor) {
  const c = h.chord;
  const offset = h.off.sub(cursor);
  const offXml = offset.isZero() ? '' : `<offset>${offset.mul(divisions).num()}</offset>`;
  if (!c || c.nc) return `<harmony print-frame="no"><root><root-step>C</root-step></root><kind text="N.C.">none</kind>${offXml}</harmony>`;
  const Qd = QUALITIES[c.quality];
  const sym = h.printed !== null && h.printed !== undefined ? h.printed : Qd.sym.replace(/♭/g, 'b').replace(/♯/g, '#');
  let x = `<harmony print-frame="no"><root><root-step>${c.root.step}</root-step>${c.root.alter ? `<root-alter>${c.root.alter}</root-alter>` : ''}</root>`;
  x += `<kind text="${esc(sym)}">${Qd.kind}</kind>`;
  if (c.bass) x += `<bass><bass-step>${c.bass.step}</bass-step>${c.bass.alter ? `<bass-alter>${c.bass.alter}</bass-alter>` : ''}</bass>`;
  for (const [v, a, t] of Qd.degrees || []) x += `<degree><degree-value>${v}</degree-value><degree-alter>${a}</degree-alter><degree-type>${t || 'add'}</degree-type></degree>`;
  return x + offXml + '</harmony>';
}

function noteXml(n, divisions) {
  let x = n.id ? `<note id="${esc(n.id)}">` : '<note>';
  if (n.grace) x += n.grace.slash ? '<grace slash="yes"/>' : '<grace/>';
  if (n.cue) x += '<cue/>';
  if (n.chord) x += '<chord/>';
  if (n.rest) {
    x += n.measureRest ? '<rest measure="yes"/>' : n.restPos ? `<rest><display-step>${n.restPos.step}</display-step><display-octave>${n.restPos.octave}</display-octave></rest>` : '<rest/>';
  } else if (n.pitch) {
    x += `<pitch><step>${n.pitch.step}</step>${n.pitch.alter ? `<alter>${n.pitch.alter}</alter>` : ''}<octave>${n.pitch.octave}</octave></pitch>`;
  } else if (n.unpitched) {
    x += `<unpitched><display-step>${n.unpitched.step}</display-step><display-octave>${n.unpitched.octave}</display-octave></unpitched>`;
  }
  if (!n.grace) x += `<duration>${n.dur.mul(divisions).num()}</duration>`;
  if (n.tie.stop) x += '<tie type="stop"/>';
  if (n.tie.start) x += '<tie type="start"/>';
  x += `<voice>${esc(n.voice)}</voice>`;
  if (n.type) x += `<type>${n.type}</type>`;
  for (let i = 0; i < (n.dots || 0); i++) x += '<dot/>';
  if (n.accidental) x += n.accidentalOrig?.cautionary ? `<accidental cautionary="yes">${n.accidental}</accidental>` : `<accidental>${n.accidental}</accidental>`;
  if (n.tm) {
    x += `<time-modification><actual-notes>${n.tm.actual}</actual-notes><normal-notes>${n.tm.normal}</normal-notes>`;
    if (n.tm.normalType) x += `<normal-type>${n.tm.normalType}</normal-type>` + '<normal-dot/>'.repeat(n.tm.normalDots || 0);
    x += '</time-modification>';
  }
  if (n.stem) x += `<stem>${n.stem}</stem>`;
  if (n.noteheadXml) x += n.noteheadXml;
  x += `<staff>${n.staff || 1}</staff>`;
  for (const b of n.beams || []) x += `<beam number="${b.n}">${b.v}</beam>`;
  let nt = n.notationsXml || '';
  if (n.tie.stop && !/<tied[^>]*type="stop"/.test(nt)) nt = '<tied type="stop"/>' + nt;
  if (n.tie.start && !/<tied[^>]*type="start"/.test(nt)) nt += '<tied type="start"/>';
  if (n.tuplet?.start && !/<tuplet[^>]*type="start"/.test(nt)) nt += '<tuplet type="start" bracket="yes"/>';
  if (n.tuplet?.stop && !/<tuplet[^>]*type="stop"/.test(nt)) nt += '<tuplet type="stop"/>';
  if (n.artic?.length && !nt.includes('<articulations>') && !n.notationsXml) {
    const a = n.artic.filter((k) => k !== 'fermata');
    if (a.length) nt += `<articulations>${a.map((k) => `<${k}/>`).join('')}</articulations>`;
    if (n.artic.includes('fermata')) nt += '<fermata/>';
  }
  if (nt) x += `<notations>${nt}</notations>`;
  for (const l of n.lyrics || []) {
    x += `<lyric number="${esc(l.n || '1')}"><syllabic>${l.syl || 'single'}</syllabic><text>${esc(l.text)}</text>${l.ext ? '<extend/>' : ''}</lyric>`;
  }
  return x + '</note>';
}

function clefXml(c) {
  return `<clef${c.staff > 1 || c.multi ? ` number="${c.staff}"` : ''}><sign>${c.sign}</sign>${c.line !== null && c.line !== undefined ? `<line>${c.line}</line>` : ''}${c.oct ? `<clef-octave-change>${c.oct}</clef-octave-change>` : ''}</clef>`;
}

function barlineXml(side, location) {
  if (!side || (!side.repeat && !side.ending && !side.style)) return '';
  let x = `<barline location="${location}">`;
  const style = side.style || (side.repeat === 'forward' ? 'heavy-light' : side.repeat === 'backward' ? 'light-heavy' : null);
  if (style) x += `<bar-style>${style}</bar-style>`;
  if (side.ending) x += `<ending number="${esc(side.ending.number)}" type="${side.ending.type}">${side.ending.text ? esc(side.ending.text) : ''}</ending>`;
  if (side.repeat) x += `<repeat direction="${side.repeat}"${side.times && side.times !== 2 ? ` times="${side.times}"` : ''}/>`;
  return x + '</barline>';
}

function jumpSoundXml(j) {
  if (!j) return '';
  const attrs = [];
  if (j.segno) attrs.push(`segno="${esc(j.segno)}"`);
  if (j.coda) attrs.push(`coda="${esc(j.coda)}"`);
  if (j.tocoda) attrs.push(`tocoda="${esc(j.tocoda)}"`);
  if (j.dalsegno) attrs.push(`dalsegno="${esc(j.dalsegno)}"`);
  if (j.dacapo) attrs.push('dacapo="yes"');
  if (j.fine) attrs.push('fine="yes"');
  return attrs.length ? `<sound ${attrs.join(' ')}/>` : '';
}

/** Writes a Score as MusicXML 4.0 (partwise). Accidentals and missing beams are generated. */
export function writeMusicXML(score, { software = 'Melovyn' } = {}) {
  const parts = score.parts;
  let out = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n';
  out += '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n';
  out += '<score-partwise version="4.0">\n';
  if (score.title) out += `  <work><work-title>${esc(score.title)}</work-title></work>\n`;
  out += '  <identification>';
  if (score.composer) out += `<creator type="composer">${esc(score.composer)}</creator>`;
  if (score.lyricist) out += `<creator type="lyricist">${esc(score.lyricist)}</creator>`;
  if (score.arranger) out += `<creator type="arranger">${esc(score.arranger)}</creator>`;
  if (score.rights) out += `<rights>${esc(score.rights)}</rights>`;
  out += `<encoding><software>${esc(software)}</software><encoding-date>${new Date().toISOString().slice(0, 10)}</encoding-date></encoding></identification>\n`;
  out += '  <part-list>\n';
  parts.forEach((p, i) => {
    const pid = p.id || `P${i + 1}`;
    const program = (p.program ?? PROGRAMS[p.instrument] ?? 0) + 1;
    out += `    <score-part id="${esc(pid)}"><part-name>${esc(p.name || `Part ${i + 1}`)}</part-name>`;
    if (p.abbr) out += `<part-abbreviation>${esc(p.abbr)}</part-abbreviation>`;
    out += `<score-instrument id="${esc(pid)}-I1"><instrument-name>${esc(p.name || p.instrument || 'Instrument')}</instrument-name></score-instrument>`;
    out += `<midi-instrument id="${esc(pid)}-I1"><midi-channel>${p.percussion ? 10 : (i % 15) + 1 + (i >= 9 ? 1 : 0)}</midi-channel><midi-program>${program}</midi-program></midi-instrument></score-part>\n`;
  });
  out += '  </part-list>\n';

  parts.forEach((part, pi) => {
    const pid = part.id || `P${pi + 1}`;
    out += `  <part id="${esc(pid)}">\n`;
    const divisions = divisionsFor(part, score.measures);
    let carried = new Map();
    part.measures.forEach((pm, mi) => {
      const m = score.measures[mi];
      const time = timeAt(score, mi);
      const key = keyAt(part, mi);
      out += `    <measure number="${esc(m.number || mi + 1)}"${m.implicit ? ' implicit="yes"' : ''}>`;
      out += barlineXml(m.left, 'left');
      // attributes
      const attrs = [];
      if (mi === 0) attrs.push(`<divisions>${divisions}</divisions>`);
      if (pm.key) attrs.push(`<key><fifths>${pm.key.fifths}</fifths>${pm.key.mode ? `<mode>${pm.key.mode}</mode>` : ''}</key>`);
      if (m.time) {
        const beats = m.time.text || m.time.beats;
        attrs.push(m.time.senza ? '<time><senza-misura/></time>' : `<time${m.time.symbol ? ` symbol="${m.time.symbol}"` : ''}><beats>${beats}</beats><beat-type>${m.time.beatType}</beat-type></time>`);
      }
      if (mi === 0 && part.staves > 1) attrs.push(`<staves>${part.staves}</staves>`);
      const startClefs = (pm.clefs || []).filter((c) => !c.off || c.off.isZero());
      for (const c of startClefs) attrs.push(clefXml({ ...c, multi: part.staves > 1 }));
      if (mi === 0 && part.transpose) {
        const octs = Math.trunc(part.transpose.c / 12);
        attrs.push(`<transpose><diatonic>${part.transpose.d - 7 * octs}</diatonic><chromatic>${part.transpose.c - 12 * octs}</chromatic>${octs ? `<octave-change>${octs}</octave-change>` : ''}</transpose>`);
      }
      for (const x of pm.extraAttrs || []) attrs.push(x);
      if (attrs.length) out += `<attributes>${attrs.join('')}</attributes>`;
      // tempo for scores that have no tempo direction of their own
      const hasTempoDirection = pm.directions.some((d) => /tempo=/.test(d.xml));
      if (pi === 0 && m.tempo && !hasTempoDirection && (mi === 0 || m.tempo !== score.measures[mi - 1]?.tempoShown)) {
        out += `<direction placement="above"><direction-type><metronome parentheses="no"><beat-unit>quarter</beat-unit><per-minute>${Math.round(m.tempo)}</per-minute></metronome></direction-type><sound tempo="${m.tempo}"/></direction>`;
      }
      m.tempoShown = m.tempo;
      if (pi === 0) {
        const dirXml = pm.directions.map((d) => d.xml).join('');
        const j = { ...m.jumps };
        for (const k of ['segno', 'coda', 'tocoda', 'dalsegno', 'dacapo', 'fine']) if (dirXml.includes(`${k}=`)) delete j[k];
        out += jumpSoundXml(j);
      }
      // accidentals and beams
      carried = computeAccidentals(pm.notes, key, carried);
      const groups = new Map();
      let headKey = null;
      for (const n of pm.notes) {
        // chord notes stay with the note they hang from, even across staves
        const k = n.chord && headKey ? headKey : `${n.staff}|${n.voice}`;
        if (!n.chord) headKey = k;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(n);
      }
      for (const list of groups.values()) {
        if (!list.some((n) => n.beams) && list.some((n) => ['eighth', '16th', '32nd'].includes(n.type))) autoBeam(list, time);
      }
      const keys = [...groups.keys()].sort((a, b) => {
        const [sa, va] = a.split('|'); const [sb, vb] = b.split('|');
        return Number(sa) - Number(sb) || (Number(va) || 0) - (Number(vb) || 0) || va.localeCompare(vb);
      });
      if (!keys.length) keys.push('1|1');
      let cursor = ZERO;
      const harmonies = [...pm.harmonies].sort((a, b) => a.off.cmp(b.off));
      const directions = [...pm.directions].sort((a, b) => a.off.cmp(b.off));
      const midClefs = (pm.clefs || []).filter((c) => c.off && !c.off.isZero()).sort((a, b) => a.off.cmp(b.off));
      let hi = 0, di = 0, ci = 0;
      const flushExtras = (upTo, inclusive) => {
        let s = '';
        const due = (x) => (inclusive ? x.off.le(upTo) : x.off.lt(upTo));
        // interleave by time: directions, then harmonies at the same offset
        while (di < directions.length && due(directions[di])) {
          const d = directions[di++];
          const offset = d.off.sub(cursor);
          let xml = d.xml;
          if (!offset.isZero()) {
            const at = xml.lastIndexOf('</direction-type>');
            const ins = `<offset>${offset.mul(divisions).num()}</offset>`;
            xml = at >= 0 ? xml.slice(0, at + 17) + ins + xml.slice(at + 17) : xml;
          }
          s += xml;
        }
        while (hi < harmonies.length && due(harmonies[hi])) s += chordXml(harmonies[hi++], divisions, cursor);
        while (ci < midClefs.length && due(midClefs[ci]) && midClefs[ci].off.le(cursor)) s += `<attributes>${clefXml({ ...midClefs[ci++], multi: part.staves > 1 })}</attributes>`;
        return s;
      };
      keys.forEach((k, gi) => {
        const list = groups.get(k) || [];
        if (gi > 0 && cursor.gt(0)) { out += `<backup><duration>${cursor.mul(divisions).num()}</duration></backup>`; cursor = ZERO; }
        for (const n of list) {
          if (!n.chord && n.off.gt(cursor)) {
            if (gi === 0) out += flushExtras(n.off, false);
            const gap = n.off.sub(cursor);
            if (gap.gt(0)) {
              // keep extras that fall inside the gap at their own offsets
              out += `<forward><duration>${gap.mul(divisions).num()}</duration><voice>${esc(n.voice)}</voice><staff>${n.staff}</staff></forward>`;
              cursor = n.off;
            }
          }
          if (gi === 0 && !n.chord) out += flushExtras(n.off, true);
          out += noteXml(n, divisions);
          if (!n.chord && !n.grace) cursor = n.off.add(n.dur);
        }
        if (gi === 0) out += flushExtras(m.dur.add(1), true);
      });
      out += barlineXml(m.right, 'right');
      out += '</measure>\n';
    });
    out += '  </part>\n';
  });
  out += '</score-partwise>\n';
  return out;
}

/** Short description of what a score contains, for the import report. */
export function describeScore(score) {
  const features = new Set();
  let notes = 0, chordSymbols = 0, lyrics = 0;
  for (const part of score.parts) {
    if (part.staves > 1) features.add('multiStaff');
    for (const pm of part.measures) {
      chordSymbols += pm.harmonies.length;
      const voices = new Set();
      for (const n of pm.notes) {
        if (!n.rest) notes++;
        if (n.lyrics?.length) lyrics++;
        if (n.tm) features.add('tuplets');
        if (n.tie.start) features.add('ties');
        if (n.grace) features.add('grace');
        voices.add(`${n.staff}:${n.voice}`);
      }
      if ([...voices].some((v) => !v.endsWith(':1'))) features.add('voices');
    }
  }
  for (const m of score.measures) {
    if (m.left?.repeat || m.right?.repeat) features.add('repeats');
    if (m.left?.ending || m.right?.ending) features.add('endings');
    if (m.jumps?.dacapo || m.jumps?.dalsegno) features.add('jumps');
  }
  return { notes, chordSymbols, lyrics, measures: score.measures.length, parts: score.parts.length, features: [...features] };
}

export { markTuplets };
