// Chord songs on a bar grid: the model behind the chord-sheet editor in Create (lyrics + chords, in the spirit of
// MuseScore's chord symbols and ChordPro editors). A song has sections (Verse, Chorus, ...), a section has bars,
// a bar has a number of beats (from the section's time signature) and chords standing on beats, plus the lyrics
// sung in that bar. Plain JSON, so a song is stored as it is; chords are kept as names ("G", "D/F#", "Csus4")
// and parsed when needed. Every function returns a new song and never changes the one it was given.
import { parseChord, formatChord, transposeChord, romanNumeral, diatonicChords, capoOptions } from './chords.js';
import { transposeInterval, transposeKey, keyName } from './pitch.js';
import { parseChordSheet, toChordPro, toChordsOverLyrics } from './chordsheet.js';
import { estimateKeyFromChords } from './analysis.js';
import { spellMidi } from './pitch.js';
import { comp, voicing, RHYTHMS } from './rhythm.js';
import { parseMusicXML } from './musicxml.js';

export const SECTION_KINDS = ['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'instrumental', 'outro'];

const clone = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const sid = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A chord name as the editor stores it (ASCII, e.g. "Bb", "F#m7", "G/B"), or null if it is not a chord. */
export function chordName(text) {
  const c = typeof text === 'string' ? parseChord(text.trim()) : text;
  if (!c || c.nc) return null;
  return formatChord(c, { ascii: true });
}

export function beatsOf(song, s) {
  const t = song.sections[s]?.time || song.time;
  return Math.max(1, Math.min(12, t?.beats || 4));
}

export function newSong({ title = '', artist = '', key = { fifths: 0, mode: 'major' }, tempo = 80, time = { beats: 4, beatType: 4 }, style = 'pop', bars = 4 } = {}) {
  return { v: 1, title, artist, key, tempo, time, capo: 0, style, sections: [{ id: sid(), label: 'Verse 1', kind: 'verse', time: null, style: null, bars: Array.from({ length: bars }, () => ({ chords: [], lyrics: '' })) }] };
}

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);
/** Rough syllable count, to guess how many bars an unchorded lyric line takes. */
function syllables(text) {
  return words(text).reduce((n, w) => n + Math.max(1, (w.toLowerCase().match(/[aeiouyà-ÿ]+/g) || []).length || ([...w].filter((ch) => /[㐀-鿿]/.test(ch)).length) || 1), 0);
}
function splitWords(text, parts) {
  const w = words(text);
  if (parts <= 1) return [w.join(' ')];
  const out = [];
  for (let i = 0; i < parts; i++) out.push(w.slice(Math.round((i * w.length) / parts), Math.round(((i + 1) * w.length) / parts)).join(' '));
  return out;
}

/**
 * A parsed chord sheet (chordsheet.js) on a bar grid. Each chord starts a new bar (how chord sheets are almost
 * always written); lyrics before the first chord of a line go with the bar before. A lyric line without chords
 * gets bars by its length (about six syllables a bar), left empty for autoChords() or the user.
 */
export function songFromSheet(sheet, { time } = {}) {
  const tm = time || parseTime(sheet.time) || { beats: 4, beatType: 4 };
  const song = { v: 1, title: sheet.title || '', artist: sheet.artist || '', key: sheet.key || { fifths: 0, mode: 'major' }, tempo: sheet.tempo || 80, time: tm, capo: sheet.capo || 0, style: tm.beats === 3 ? 'waltz' : tm.beatType === 8 ? 'six8' : 'pop', sections: [] };
  let verseN = 0;
  for (const sec of sheet.sections) {
    if (sec.kind === 'tab') continue;
    const kind = sec.kind === 'other' ? 'verse' : sec.kind;
    const label = sec.label || (kind === 'verse' ? `Verse ${++verseN}` : kind[0].toUpperCase() + kind.slice(1));
    const bars = [];
    for (const line of sec.lines) {
      if (line.type === 'chords') { for (const g of line.segs) if (g.chord && !g.chord.nc) bars.push({ chords: [{ beat: 0, name: chordName(g.chord) }], lyrics: '' }); continue; }
      if (line.type !== 'lyrics') continue;
      const hasChord = line.segs.some((g) => g.chord && !g.chord.nc);
      if (!hasChord) {
        const text = line.segs.map((g) => g.text).join('');
        const n = Math.max(1, Math.min(4, Math.round(syllables(text) / 6)));
        for (const part of splitWords(text, n)) bars.push({ chords: [], lyrics: part });
        continue;
      }
      let pending = '';                 // words sung before the section's first chord (a pickup) join that bar
      for (const g of line.segs) {
        if (g.chord && !g.chord.nc) { bars.push({ chords: [{ beat: 0, name: chordName(g.chord) }], lyrics: (pending + g.text).trim() }); pending = ''; }
        else if (g.text.trim()) {
          if (bars.length) bars[bars.length - 1].lyrics = `${bars[bars.length - 1].lyrics} ${g.text.trim()}`.trim();
          else pending += g.text;
        }
      }
      if (pending.trim()) bars.push({ chords: [], lyrics: pending.trim() });
    }
    if (bars.length) song.sections.push({ id: sid(), label, kind, time: null, style: null, bars });
  }
  if (!song.sections.length) song.sections.push(newSong().sections[0]);
  return song;
}

/** Pasted text (ChordPro, chords over lyrics, or plain lyrics) as a song, with chords suggested for bare lyrics. */
export function songFromText(text, { title = '', auto = true } = {}) {
  const sheet = parseChordSheet(text, { title });
  let song = songFromSheet(sheet);
  if (auto) song = autoChords(song);
  return song;
}

function parseTime(t) {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(t || '').trim());
  return m ? { beats: +m[1], beatType: +m[2] } : null;
}

// ---------------------------------------------------------------- reading
export function songChords(song) {
  const out = [];
  for (const s of song.sections) for (const b of s.bars) for (const c of b.chords) { const p = parseChord(c.name); if (p && !p.nc) out.push(p); }
  return out;
}
export function chordAt(song, { s, b, beat }) { return song.sections[s]?.bars[b]?.chords.find((c) => c.beat === beat) || null; }
/** The chord sounding at a place: the last one at or before it (looking back into earlier bars). */
export function soundingAt(song, { s, b, beat = 0 }) {
  for (let si = s, bi = b, bt = beat; si >= 0; si--) {
    const sec = song.sections[si];
    for (; bi >= 0; bi--, bt = 99) {
      const cs = sec.bars[bi].chords.filter((c) => c.beat <= bt).sort((x, y) => y.beat - x.beat);
      if (cs.length) return cs[0].name;
    }
    if (si > 0) bi = song.sections[si - 1].bars.length - 1;
  }
  return null;
}
export function barCount(song) { return song.sections.reduce((n, s) => n + s.bars.length, 0); }

// ---------------------------------------------------------------- editing
function edit(song, fn) { const out = clone(song); fn(out); return out; }
function sortChords(bar) { bar.chords.sort((a, b) => a.beat - b.beat); }

/** Puts a chord on a beat (replacing what was there), or removes it with name = null. Throws on a bad name. */
export function setChord(song, { s, b, beat = 0 }, name) {
  const nm = name == null || name === '' ? null : chordName(name);
  if (name && !nm) throw new Error(`"${name}" is not a chord`);
  return edit(song, (out) => {
    const bar = out.sections[s].bars[b];
    const bt = Math.max(0, Math.min(beatsOf(out, s) - 1, beat | 0));
    bar.chords = bar.chords.filter((c) => c.beat !== bt);
    if (nm) bar.chords.push({ beat: bt, name: nm });
    sortChords(bar);
  });
}

/** Drags a chord to another beat (in the same or another bar). What stood at the target is replaced. */
export function moveChord(song, from, to) {
  const c = chordAt(song, from);
  if (!c) return song;
  if (from.s === to.s && from.b === to.b && from.beat === to.beat) return song;
  return setChord(setChord(song, from, null), to, c.name);
}

/** Splits a bar in two at a beat: chords from that beat on move to a new bar after it; lyrics are shared by words. */
export function splitBar(song, s, b, atBeat) {
  return edit(song, (out) => {
    const n = beatsOf(out, s);
    const at = Math.max(1, Math.min(n - 1, atBeat ?? Math.ceil(n / 2)));
    const bar = out.sections[s].bars[b];
    const [l1, l2] = splitWords(bar.lyrics, 2);
    const second = { chords: bar.chords.filter((c) => c.beat >= at).map((c) => ({ beat: c.beat - at, name: c.name })), lyrics: l2 || '' };
    bar.chords = bar.chords.filter((c) => c.beat < at);
    bar.lyrics = l1 || '';
    out.sections[s].bars.splice(b + 1, 0, second);
  });
}

/** Joins a bar with the next one: the first bar's chords move into the first half, the next bar's into the second. */
export function mergeBars(song, s, b) {
  const sec = song.sections[s];
  if (!sec || b + 1 >= sec.bars.length) return song;
  return edit(song, (out) => {
    const n = beatsOf(out, s);
    const half = Math.ceil(n / 2);
    const [x, y] = out.sections[s].bars.slice(b, b + 2);
    const squeeze = (cs, base, room) => {
      const m = new Map();
      for (const c of cs) m.set(base + Math.min(room - 1, Math.floor((c.beat * room) / n)), c.name);   // later chords win a shared beat
      return [...m].map(([beat, name]) => ({ beat, name }));
    };
    const merged = { chords: [...squeeze(x.chords, 0, half), ...squeeze(y.chords, half, n - half)], lyrics: `${x.lyrics} ${y.lyrics}`.trim() };
    sortChords(merged);
    out.sections[s].bars.splice(b, 2, merged);
  });
}

export function insertBar(song, s, b, { chord = null } = {}) {
  return edit(song, (out) => { out.sections[s].bars.splice(b, 0, { chords: chord ? [{ beat: 0, name: chordName(chord) }] : [], lyrics: '' }); });
}
export function deleteBar(song, s, b) {
  if (song.sections[s].bars.length <= 1) return song;
  return edit(song, (out) => { out.sections[s].bars.splice(b, 1); });
}
export function setLyrics(song, s, b, text) { return edit(song, (out) => { out.sections[s].bars[b].lyrics = String(text || ''); }); }

/** Beats per bar for one section (a 6/8 bridge in a 4/4 song). Chords past the new last beat move onto it. */
export function setSectionTime(song, s, beats, beatType) {
  return edit(song, (out) => {
    const sec = out.sections[s];
    const bt = beatType || (sec.time || out.time).beatType;
    sec.time = beats === out.time.beats && bt === out.time.beatType ? null : { beats, beatType: bt };
    for (const bar of sec.bars) {
      const m = new Map();
      for (const c of bar.chords) m.set(Math.min(beats - 1, c.beat), c.name);
      bar.chords = [...m].map(([beat, name]) => ({ beat, name }));
      sortChords(bar);
    }
  });
}
export function setSongTime(song, beats, beatType) {
  let out = edit(song, (o) => { o.time = { beats, beatType }; });
  out.sections.forEach((sec, i) => { if (!sec.time) out = setSectionTime(out, i, beats, beatType); });
  return out;
}

export function addSection(song, kind = 'verse', { after = song.sections.length - 1, bars = 4, label } = {}) {
  return edit(song, (out) => {
    const n = out.sections.filter((x) => x.kind === kind).length + 1;
    const lab = label || (kind === 'verse' ? `Verse ${n}` : kind === 'prechorus' ? 'Pre-chorus' : kind[0].toUpperCase() + kind.slice(1));
    out.sections.splice(after + 1, 0, { id: sid(), label: lab, kind, time: null, style: null, bars: Array.from({ length: bars }, () => ({ chords: [], lyrics: '' })) });
  });
}
export function duplicateSection(song, s) {
  return edit(song, (out) => { const c = clone(out.sections[s]); c.id = sid(); out.sections.splice(s + 1, 0, c); });
}
export function deleteSection(song, s) {
  if (song.sections.length <= 1) return song;
  return edit(song, (out) => { out.sections.splice(s, 1); });
}
export function moveSection(song, s, d) {
  const to = s + d;
  if (to < 0 || to >= song.sections.length) return song;
  return edit(song, (out) => { const [x] = out.sections.splice(s, 1); out.sections.splice(to, 0, x); });
}
export function setSection(song, s, patch) { return edit(song, (out) => { Object.assign(out.sections[s], patch); }); }
export function setSong(song, patch) { return edit(song, (out) => { Object.assign(out, patch); }); }

// ---------------------------------------------------------------- key
/** The song moved by semitones; every chord and the key re-spelled for the new key. */
export function transposeSong(song, semitones) {
  if (!semitones) return song;
  const interval = transposeInterval(song.key, semitones);
  return edit(song, (out) => {
    out.key = transposeKey(song.key, interval);
    for (const sec of out.sections) for (const bar of sec.bars) for (const c of bar.chords) c.name = chordName(transposeChord(parseChord(c.name), interval));
  });
}
/** Changes the key: chords move with it. Switching between relative keys (G major / E minor) moves nothing. */
export function setSongKey(song, key) {
  let d = ((((key.fifths - song.key.fifths) * 7) % 12) + 12) % 12;
  if (d > 6) d -= 12;
  const out = transposeSong(song, d);
  return { ...out, key: { fifths: key.fifths, mode: key.mode || 'major' } };
}
/** Guess the key from the chords (when a pasted sheet had none). */
export function guessKey(song) {
  const k = estimateKeyFromChords(songChords(song));
  return { fifths: k.fifths, mode: k.mode };
}

// ---------------------------------------------------------------- help with chords
export function roman(name, key) { const c = parseChord(name); return c ? romanNumeral(c, key).text : ''; }

/** What the chord picker offers for this key: diatonic triads and sevenths, borrowed chords, and colour chords. */
export function chordPalette(key) {
  const minor = key.mode === 'minor';
  const tri = diatonicChords(key).map((c) => chordName(c));
  const sev = diatonicChords(key, true).map((c) => chordName(c));
  const tonic = tri[0];
  const relKey = { fifths: key.fifths, mode: minor ? 'major' : 'minor' };
  const par = diatonicChords({ fifths: key.fifths + (minor ? 3 : -3), mode: minor ? 'major' : 'minor' }).map((c) => chordName(c));
  // borrowed: chords of the parallel mode that are not already diatonic (bVII, bVI, iv in major; IV, V in minor)
  const borrowed = [...new Set(minor ? [chordName(diatonicChords(relKey)[4]), par[3], par[4]] : [par[6], par[5], par[3], par[2]])].filter((x) => x && !tri.includes(x));
  const root = (n) => n.replace(/(m|dim|maj7|m7|7|m7b5).*$/, '').replace(/m$/, '');
  const colour = [`${root(tonic)}sus4`, `${root(tonic)}sus2`, `${root(tonic)}add9`, `${root(tri[4])}7`, `${root(tri[3])}maj7`];
  const slash = [`${tonic}/${bassOf(key, 2)}`, `${tri[4]}/${bassOf(key, 6)}`, `${tri[3]}/${bassOf(key, 5)}`].map(chordName).filter(Boolean);
  return { diatonic: tri, sevenths: sev, borrowed, colour: colour.map(chordName).filter(Boolean), slash };
}
function bassOf(key, degree) {
  const scale = diatonicChords(key).map((c) => formatChord({ root: c.root, quality: 'maj' }, { ascii: true }));
  return scale[degree] || scale[0];
}

// Chords that usually follow a degree (1..7) in major, as degrees: the musician's "where can this go next".
const NEXT = { 1: [4, 5, 6, 2], 2: [5, 7, 4], 3: [6, 4, 2], 4: [5, 1, 2, 6], 5: [1, 6, 4], 6: [4, 2, 5, 3], 7: [1, 3, 6] };
const NEXT_MINOR = { 1: [4, 6, 7, 5], 2: [5, 7], 3: [6, 4, 7], 4: [5, 1, 7], 5: [1, 6], 6: [7, 4, 2, 3], 7: [3, 1, 6] };

/**
 * Two or three chords that would fit a bar, best first, with Roman numerals: from what comes before (the usual
 * next chords) and what comes after (leading into it), never the chord already there.
 */
export function suggestionsFor(song, s, b, n = 3) {
  const key = song.key;
  const tri = diatonicChords(key).map((c) => chordName(c));
  const degOf = (name) => { const c = parseChord(name || ''); return c ? romanNumeral(c, key).degree : null; };
  const prevName = b > 0 || s > 0 ? soundingAt(song, b > 0 ? { s, b: b - 1, beat: 99 } : { s: s - 1, b: song.sections[s - 1].bars.length - 1, beat: 99 }) : null;
  const sec = song.sections[s];
  const nextBar = sec.bars[b + 1] || song.sections[s + 1]?.bars[0];
  const nextName = nextBar?.chords[0]?.name || null;
  const here = sec.bars[b].chords[0]?.name || null;
  const table = key.mode === 'minor' ? NEXT_MINOR : NEXT;
  const score = new Map();
  const add = (deg, w) => { if (deg >= 1 && deg <= 7) score.set(deg, (score.get(deg) || 0) + w); };
  const pd = degOf(prevName);
  if (pd) (table[pd] || []).forEach((d, i) => add(d, 3 - i * 0.6));
  const nd = degOf(nextName);
  if (nd) for (const [from, tos] of Object.entries(table)) { const i = tos.indexOf(nd); if (i >= 0) add(+from, 2 - i * 0.5); }
  // first bar of a section: home; last bar: dominant or home
  if (b === 0) add(1, 1.5);
  if (b === sec.bars.length - 1) { add(5, 1.2); add(1, 0.8); }
  [1, 4, 5, 6].forEach((d) => add(d, 0.3));
  const ranked = [...score].sort((x, y) => y[1] - x[1]).map(([d]) => tri[d - 1]).filter((x) => x && x !== here);
  return [...new Set(ranked)].slice(0, n).map((name) => ({ name, roman: roman(name, key) }));
}

const AUTO = {
  major: { verse: [1, 5, 6, 4], chorus: [4, 1, 5, 6], bridge: [6, 4, 1, 5], prechorus: [2, 4, 5, 5], intro: [1, 4, 1, 5], outro: [4, 5, 1, 1], instrumental: [1, 6, 4, 5] },
  minor: { verse: [1, 6, 3, 7], chorus: [6, 7, 1, 1], bridge: [4, 6, 7, 5], prechorus: [4, 6, 7, 7], intro: [1, 7, 6, 7], outro: [6, 7, 1, 1], instrumental: [1, 6, 7, 1] },
};
/** Fills bars that have no chord with the usual progression for the section's kind (a starting point to edit). */
export function autoChords(song, { overwrite = false } = {}) {
  const tri = diatonicChords(song.key).map((c) => chordName(c));
  const minor = song.key.mode === 'minor';
  return edit(song, (out) => {
    for (const sec of out.sections) {
      const prog = (minor ? AUTO.minor : AUTO.major)[sec.kind] || AUTO.major.verse;
      sec.bars.forEach((bar, i) => {
        if (bar.chords.length && !overwrite) return;
        let deg = prog[i % prog.length];
        if (minor && deg === 7) deg = 7;
        let name = tri[deg - 1];
        if (minor && deg === 5) name = chordName(name.replace(/m$/, ''));    // the major V in minor
        bar.chords = [{ beat: 0, name, auto: true }];
      });
    }
  });
}

export function songCapo(song) { return capoOptions(songChords(song)).slice(0, 4); }

// ---------------------------------------------------------------- out
/** The song as a chord sheet (chordsheet.js), for ChordPro and chords-over-lyrics text. */
export function songToSheet(song) {
  const sections = song.sections.map((sec) => {
    const lines = [];
    let cur = [];
    const flush = () => { if (cur.length) lines.push(cur.some((g) => g.text) ? { type: 'lyrics', segs: cur } : { type: 'chords', segs: cur }); cur = []; };
    sec.bars.forEach((bar, i) => {
      const ws = words(bar.lyrics);
      const chords = bar.chords.length ? bar.chords : [{ beat: 0, name: null }];
      chords.forEach((c, k) => {
        const share = splitWords(ws.join(' '), chords.length)[k] || '';
        cur.push({ chord: c.name ? parseChord(c.name) : null, text: share ? `${share} ` : '' });
      });
      if ((i + 1) % 4 === 0) flush();
    });
    flush();
    return { label: sec.label, kind: sec.kind === 'prechorus' ? 'verse' : sec.kind, lines };
  });
  return { title: song.title, subtitle: '', artist: song.artist, key: song.key, keyGiven: true, capo: song.capo || 0, tempo: song.tempo, time: `${song.time.beats}/${song.time.beatType}`, sections, format: 'chordpro', notes: [] };
}

export function songToChordPro(song) { return toChordPro(songToSheet(song)); }
export function songToChordsOverLyrics(song, opts) { return toChordsOverLyrics(songToSheet(song), opts); }

/** A bar-by-bar chart ("| G . . . | C . D . |"), the way a band reads a chord-only song. */
export function songToGrid(song) {
  const out = [`${song.title || 'Untitled'}${song.artist ? ` - ${song.artist}` : ''}`, `Key: ${keyName(song.key, { ascii: true })}  Time: ${song.time.beats}/${song.time.beatType}  Tempo: ${song.tempo}`];
  song.sections.forEach((sec, s) => {
    out.push('', `[${sec.label}]`);
    const n = beatsOf(song, s);
    const cells = sec.bars.map((bar) => Array.from({ length: n }, (_, bt) => bar.chords.find((c) => c.beat === bt)?.name || '.').join(' '));
    for (let i = 0; i < cells.length; i += 4) out.push(`| ${cells.slice(i, i + 4).join(' | ')} |`);
  });
  return out.join('\n') + '\n';
}

/** Where every chord falls, in beats from the start: [{t, dur, name, s, b, beat}] (for playback and scores). */
export function timeline(song) {
  const out = [];
  let t = 0;
  song.sections.forEach((sec, s) => {
    const n = beatsOf(song, s);
    const bt = (sec.time || song.time).beatType;
    const beatQ = 4 / bt;                    // quarter notes per beat
    sec.bars.forEach((bar, b) => {
      for (const c of bar.chords) out.push({ t: t + c.beat * beatQ, name: c.name, s, b, beat: c.beat });
      t += n * beatQ;
    });
  });
  out.forEach((c, i) => { c.dur = (out[i + 1]?.t ?? t) - c.t; });
  return { chords: out, length: t };
}

/** Each bar's start, length and metre in quarter notes, with the section's own style when it has one. */
export function barLayout(song) {
  const out = [];
  let t = 0;
  song.sections.forEach((sec, s) => {
    const tm = sec.time || song.time;
    const len = beatsOf(song, s) * (4 / tm.beatType);
    sec.bars.forEach((bar, b) => { out.push({ t, len, beats: beatsOf(song, s), beatType: tm.beatType, style: sec.style || null, s, b }); t += len; });
  });
  return out;
}

/** Playback events for the song in its rhythm style: the accompaniment that Play Along and Sounds use. */
export function songAccompaniment(song, { style, drums = true } = {}) {
  const { chords, length } = timeline(song);
  const events = comp(chords.map((c) => ({ t: c.t, dur: c.dur, name: c.name })), barLayout(song), { style: style || song.style || 'pop', drums });
  return { events, length, swing: RHYTHMS[style || song.style]?.swing || 0, sound: RHYTHMS[style || song.style]?.sound || 'piano' };
}

const DUR = [[8, 'whole', 0], [6, 'half', 1], [4, 'half', 0], [3, 'quarter', 1], [2, 'quarter', 0], [1, 'eighth', 0]];
const xmlEsc = (x) => String(x || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
/**
 * The song as MusicXML: one piano staff with the chords as block chords (so Play Along can follow them), chord
 * symbols, section names as rehearsal marks, each bar's lyrics, and time changes between sections.
 */
export function songToMusicXML(song) {
  const DIV = 2;                                           // divisions per quarter: an eighth is 1
  const fifths = song.key.fifths;
  const measures = [];
  let num = 0, prevTime = null;
  song.sections.forEach((sec, s) => {
    const tm = sec.time || song.time;
    const n = beatsOf(song, s);
    const beatDiv = Math.round(DIV * 4 / tm.beatType);
    const barDiv = n * beatDiv;
    sec.bars.forEach((bar, b) => {
      num++;
      let m = `<measure number="${num}">`;
      const timeKey = `${n}/${tm.beatType}`;
      if (num === 1 || timeKey !== prevTime) {
        m += `<attributes>${num === 1 ? `<divisions>${DIV}</divisions><key><fifths>${fifths}</fifths><mode>${song.key.mode || 'major'}</mode></key>` : ''}<time><beats>${n}</beats><beat-type>${tm.beatType}</beat-type></time>${num === 1 ? '<clef><sign>G</sign><line>2</line></clef>' : ''}</attributes>`;
        prevTime = timeKey;
      }
      if (num === 1) m += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${song.tempo || 80}</per-minute></metronome></direction-type><sound tempo="${song.tempo || 80}"/></direction>`;
      if (b === 0) m += `<direction placement="above"><direction-type><rehearsal>${xmlEsc(sec.label)}</rehearsal></direction-type></direction>`;
      // spans in this bar: from each chord (or the chord still sounding from before) to the next
      const starts = [...bar.chords];
      if (!starts.length || starts[0].beat > 0) { const carry = soundingAt(song, { s, b, beat: 0 }); starts.unshift({ beat: 0, name: carry, carry: true }); }
      let lyricDone = false;
      starts.forEach((c, i) => {
        const from = c.beat * beatDiv, to = (starts[i + 1]?.beat ?? n) * beatDiv;
        if (!c.carry && c.name) {
          const ch = parseChord(c.name);
          const kindMap = { maj: 'major', min: 'minor', 7: 'dominant', maj7: 'major-seventh', m7: 'minor-seventh', dim: 'diminished', aug: 'augmented', sus4: 'suspended-fourth', sus2: 'suspended-second', m7b5: 'half-diminished', dim7: 'diminished-seventh', 6: 'major-sixth', m6: 'minor-sixth', 9: 'dominant-ninth', add9: 'major', maj9: 'major-ninth', m9: 'minor-ninth' };
          const alt = (a) => (a ? `<root-alter>${a}</root-alter>` : '');
          m += `<harmony print-frame="no"><root><root-step>${ch.root.step}</root-step>${alt(ch.root.alter)}</root><kind text="${xmlEsc(c.name.split('/')[0].slice(1 + (ch.root.alter ? 1 : 0)))}">${kindMap[ch.quality] || 'major'}</kind>${ch.bass ? `<bass><bass-step>${ch.bass.step}</bass-step>${ch.bass.alter ? `<bass-alter>${ch.bass.alter}</bass-alter>` : ''}</bass>` : ''}${from ? `<offset>${from}</offset>` : ''}</harmony>`;
        }
        const pitches = c.name ? voicing(c.name, { low: 55 }) : [];
        let left = to - from, first = true;
        while (left > 0) {
          const [d, type, dot] = DUR.find(([x]) => x <= left);
          const tieStart = left - d > 0, tieStop = !first;
          if (!pitches.length) m += `<note><rest/><duration>${d}</duration><voice>1</voice><type>${type}</type>${dot ? '<dot/>' : ''}</note>`;
          pitches.forEach((midi, k) => {
            const p = spellMidi(midi, fifths);
            m += `<note>${k ? '<chord/>' : ''}<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}<octave>${p.octave}</octave></pitch><duration>${d}</duration>${tieStop ? '<tie type="stop"/>' : ''}${tieStart ? '<tie type="start"/>' : ''}<voice>1</voice><type>${type}</type>${dot ? '<dot/>' : ''}`
              + `${tieStart || tieStop ? `<notations>${tieStop ? '<tied type="stop"/>' : ''}${tieStart ? '<tied type="start"/>' : ''}</notations>` : ''}`
              + `${!k && !lyricDone && bar.lyrics ? `<lyric number="1"><syllabic>single</syllabic><text>${xmlEsc(bar.lyrics)}</text></lyric>` : ''}</note>`;
            if (!k && bar.lyrics) lyricDone = true;
          });
          left -= d; first = false;
        }
      });
      void barDiv;
      measures.push(`${m}</measure>`);
    });
  });
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${xmlEsc(song.title || 'Untitled')}</work-title></work>`
    + `<identification>${song.artist ? `<creator type="composer">${xmlEsc(song.artist)}</creator>` : ''}<encoding><software>Melovyn</software></encoding></identification>`
    + `<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${measures.join('')}</part></score-partwise>`;
}

/** The song as a score (score.js model) for the song screen, Play Along and the other exports. */
export function songToScore(song, dom) {
  const score = parseMusicXML(songToMusicXML(song), dom);
  score.title = song.title || 'Untitled';
  score.composer = song.artist || '';
  score.parts[0].instrument = 'piano';
  score.meta = { ...(score.meta || {}), source: 'chords', style: song.style };
  return score;
}

/** Undo history: { past, now, future }. */
export const history = {
  start: (now) => ({ past: [], now, future: [] }),
  push: (h, next) => (next === h.now ? h : { past: [...h.past.slice(-99), h.now], now: next, future: [] }),
  undo: (h) => (h.past.length ? { past: h.past.slice(0, -1), now: h.past[h.past.length - 1], future: [h.now, ...h.future] } : h),
  redo: (h) => (h.future.length ? { past: [...h.past, h.now], now: h.future[0], future: h.future.slice(1) } : h),
};
