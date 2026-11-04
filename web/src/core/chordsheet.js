// Chord sheets: ChordPro and the "chords above lyrics" text that chord websites and PDFs use.
// Parsing is exact (every chord stays on the syllable it was written over) and transposition
// re-spells every chord for the new key.
import { parseChord, formatChord, isChordToken, transposeChord, romanNumeral, capoOptions } from './chords.js';
import { transposeInterval, transposeKey, keyName, parseName, keyOfTonic } from './pitch.js';
import { estimateKeyFromChords } from './analysis.js';

const SECTION_RE = /^\s*[[(]?\s*((?:pre[- ]?)?chorus|verse|intro|outro|bridge|interlude|instrumental|solo|tag|coda|refrain|hook|ending|break|reff?|post[- ]?chorus|pre[- ]?hook|副歌|主歌|前奏|间奏|間奏|尾奏|桥段|橋段|结尾|結尾|korus|rangkap|pengenalan|penutup)\b[^\])]*[\])]?\s*:?\s*$/i;
const META_RE = /^\s*(key|capo|tempo|bpm|time|tuning|artist|title|by|composer|lyricist|调|調|kunci)\s*[:=：]\s*(.+?)\s*$/i;
const TAB_RE = /^\s*[eBGDAEbgdae]\s*[|:][-0-9hpbrsx/\\|~.()^*]{4,}/;

function kindOf(label) {
  const l = label.toLowerCase();
  if (/chorus|refrain|hook|副歌|korus|reff?/.test(l)) return 'chorus';
  if (/verse|主歌|rangkap/.test(l)) return 'verse';
  if (/bridge|桥段|橋段/.test(l)) return 'bridge';
  if (/intro|前奏|pengenalan/.test(l)) return 'intro';
  if (/outro|ending|coda|尾奏|结尾|結尾|penutup/.test(l)) return 'outro';
  if (/instrumental|solo|interlude|break|间奏|間奏/.test(l)) return 'instrumental';
  return 'other';
}

function tokensOf(line) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line))) out.push({ text: m[0], col: m.index });
  return out;
}

/** True when every token of the line is a chord or a bar/repeat mark (and at least one is a chord). */
export function isChordLine(line) {
  const toks = tokensOf(line);
  if (!toks.length) return false;
  let chords = 0;
  for (const t of toks) {
    const bare = t.text.replace(/^[([|]+|[)\]|*.,:]+$/g, '');
    if (!bare) continue;
    if (/^(\|+|-+|\/+|x\d+|\(x\d+\)|%|N\.?C\.?|\.\.\.)$/i.test(t.text)) continue;
    if (!isChordToken(t.text)) return false;
    if (parseChord(bare) && !parseChord(bare).nc) chords++;
  }
  if (!chords) return false;
  // a lone "A" or "Am" line could be a lyric; accept only when it is short or spaced like chords
  if (toks.length === 1 && line.trim().length > 6) return false;
  return true;
}

function chordsFromLine(line) {
  return tokensOf(line).map((t) => {
    const bare = t.text.replace(/^[([|]+|[)\]|*.,:]+$/g, '');
    const c = parseChord(bare);
    return c ? { col: t.col + (t.text.indexOf(bare) > 0 ? t.text.indexOf(bare) : 0), chord: c, raw: bare } : null;
  }).filter(Boolean);
}

/** Merges a chord line into the lyric line below it: segments [{chord, text}]. */
function mergeChordsLyrics(chordLine, lyric) {
  const chords = chordsFromLine(chordLine);
  const segs = [];
  let pos = 0;
  const lyr = lyric.replace(/\t/g, '    ');
  if (chords.length && chords[0].col > 0) {
    segs.push({ chord: null, text: lyr.slice(0, chords[0].col) });
    pos = chords[0].col;
  }
  chords.forEach((c, i) => {
    const end = i + 1 < chords.length ? chords[i + 1].col : Math.max(lyr.length, c.col);
    let text = lyr.slice(Math.min(c.col, lyr.length), Math.min(end, lyr.length));
    if (c.col > lyr.length) text = '';
    segs.push({ chord: c.chord, text });
    pos = end;
  });
  if (pos < lyr.length) {
    if (segs.length) segs[segs.length - 1].text += lyr.slice(pos);
    else segs.push({ chord: null, text: lyr.slice(pos) });
  }
  return segs;
}

function parseInline(line) {
  // ChordPro [C]lyrics
  const segs = [];
  const re = /\[([^\]]*)\]/g;
  let last = 0, m, pending = null;
  while ((m = re.exec(line))) {
    const before = line.slice(last, m.index);
    if (pending !== null || before) segs.push({ chord: pending, text: before });
    const inner = m[1].trim();
    const c = inner.startsWith('*') ? null : parseChord(inner);
    if (c) pending = c;
    else { segs.push({ chord: null, text: `[${inner}]`, annotation: true }); pending = null; }
    last = m.index + m[0].length;
  }
  const rest = line.slice(last);
  if (pending !== null || rest || !segs.length) segs.push({ chord: pending, text: rest });
  // drop a leading empty chordless segment
  return segs.filter((s, i) => !(i === 0 && !s.chord && !s.text));
}

export function looksLikeChordPro(text) {
  return /\{\s*(title|t|soc|start_of_chorus|sov|start_of_verse|key|artist|c|comment)\s*[:}]/i.test(text) || /\[[A-G][#b]?[^\]\s]{0,8}\][^\s[]/.test(text) && !/^\s*[A-G][#b]?\S*(\s+[A-G][#b]?\S*)+\s*$/m.test(text);
}

/** Parses ChordPro or chords-above-lyrics text. */
export function parseChordSheet(text, { title = '' } = {}) {
  const src = String(text || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  const sheet = { title, subtitle: '', artist: '', key: null, keyGiven: false, capo: 0, tempo: null, time: null, sections: [], format: 'plain', notes: [] };
  let section = null;
  const newSection = (label = '', kind = 'verse') => { section = { label, kind, lines: [] }; sheet.sections.push(section); return section; };
  const ensure = () => section || newSection('', 'verse');
  const lines = src.split('\n');
  const chordPro = looksLikeChordPro(src);
  sheet.format = chordPro ? 'chordpro' : 'plain';
  let inTab = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\s+$/, '');
    const dir = /^\s*\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/i.exec(raw);
    if (dir) {
      const name = dir[1].toLowerCase(), val = (dir[2] || '').trim();
      if (['title', 't'].includes(name)) sheet.title = val;
      else if (['subtitle', 'st'].includes(name)) sheet.subtitle = val;
      else if (['artist', 'composer', 'lyricist'].includes(name)) { if (!sheet.artist || name === 'artist') sheet.artist = val; }
      else if (name === 'key') { setKey(sheet, val); }
      else if (name === 'capo') sheet.capo = parseInt(val, 10) || 0;
      else if (name === 'tempo') sheet.tempo = parseFloat(val) || null;
      else if (name === 'time') sheet.time = val;
      else if (name === 'meta') {
        const [k, ...v] = val.split(/\s+/);
        if (k === 'key') setKey(sheet, v.join(' ')); else if (k === 'artist') sheet.artist = v.join(' '); else if (k === 'title') sheet.title = v.join(' ');
      } else if (['comment', 'c', 'ci', 'cb', 'comment_italic', 'comment_box', 'highlight'].includes(name)) ensure().lines.push({ type: 'comment', text: val });
      else if (['start_of_chorus', 'soc'].includes(name)) newSection(val || 'Chorus', 'chorus');
      else if (['start_of_verse', 'sov'].includes(name)) newSection(val || '', val && kindOf(val) !== 'other' ? kindOf(val) : 'verse');
      else if (['start_of_bridge', 'sob'].includes(name)) newSection(val || 'Bridge', 'bridge');
      else if (/^start_of_/.test(name) && !['start_of_tab', 'sot', 'start_of_grid', 'sog'].includes(name)) newSection(val || name.replace('start_of_', ''), kindOf(name.replace('start_of_', '')));
      else if (['start_of_tab', 'sot'].includes(name)) { inTab = true; newSection(val || 'Tab', 'tab'); }
      else if (['end_of_tab', 'eot'].includes(name)) { inTab = false; section = null; }
      else if (/^end_of_|^eo[cvb]$/.test(name)) section = null;
      else if (name === 'chorus') ensure().lines.push({ type: 'comment', text: 'Chorus', repeat: 'chorus' });
      continue;
    }
    if (inTab || TAB_RE.test(raw)) { ensure().lines.push({ type: 'tab', text: raw }); continue; }
    if (!raw.trim()) {
      if (section && section.lines.length && !chordPro) section = null;
      continue;
    }
    const meta = META_RE.exec(raw);
    if (meta && !isChordLine(raw)) {
      const k = meta[1].toLowerCase(), v = meta[2];
      if (['key', '调', '調', 'kunci'].includes(k)) setKey(sheet, v);
      else if (k === 'capo') sheet.capo = parseInt(v, 10) || (/no capo/i.test(v) ? 0 : 0);
      else if (k === 'tempo' || k === 'bpm') sheet.tempo = parseFloat(v) || null;
      else if (k === 'time') sheet.time = v;
      else if (['artist', 'by', 'composer'].includes(k)) sheet.artist = v;
      else if (k === 'title') sheet.title = v;
      else sheet.notes.push(raw.trim());
      continue;
    }
    const sec = SECTION_RE.exec(raw);
    if (sec && !isChordLine(raw)) { newSection(raw.trim().replace(/^[[(]|[\])]:?$|:$/g, '').trim(), kindOf(sec[1])); continue; }
    if (chordPro && /\[[^\]]+\]/.test(raw)) { ensure().lines.push({ type: 'lyrics', segs: parseInline(raw) }); continue; }
    if (isChordLine(raw)) {
      const next = lines[i + 1] !== undefined ? lines[i + 1].replace(/\s+$/, '') : '';
      const nextIsLyric = next.trim() && !isChordLine(next) && !SECTION_RE.test(next) && !/^\s*\{/.test(next) && !TAB_RE.test(next) && !(META_RE.test(next));
      if (nextIsLyric) {
        ensure().lines.push({ type: 'lyrics', segs: mergeChordsLyrics(raw, next) });
        i++;
      } else {
        ensure().lines.push({ type: 'chords', segs: chordsFromLine(raw).map((c) => ({ chord: c.chord, text: '' })), bars: /\|/.test(raw) });
      }
      continue;
    }
    // title line at the very top: "Song Title - Artist" or "Song Title by Artist"
    if (!sheet.title && sheet.sections.length === 0 && i < 3 && /\s[-–—]\s|\sby\s/i.test(raw) && raw.length < 80) {
      const [a, b] = raw.split(/\s[-–—]\s|\sby\s/i);
      sheet.title = a.trim(); sheet.artist = (b || '').trim();
      continue;
    }
    ensure().lines.push({ type: 'lyrics', segs: [{ chord: null, text: raw.trimEnd() }] });
  }
  sheet.sections = sheet.sections.filter((s) => s.lines.length);
  const chords = sheetChords(sheet);
  if (!sheet.key) {
    const k = estimateKeyFromChords(chords);
    sheet.key = { fifths: k.fifths, mode: k.mode };
    sheet.keyConfidence = k.confidence;
  }
  return sheet;
}

function setKey(sheet, val) {
  const m = /^\s*([A-G][#b♯♭]?)\s*(m|min|minor|maj|major)?/i.exec(val);
  if (!m) return;
  const t = parseName(m[1]);
  const minor = m[2] && /^m(in|inor)?$/i.test(m[2]) && !/^maj/i.test(m[2]);
  const k = keyOfTonic(t, minor ? 'minor' : 'major');
  if (Math.abs(k.fifths) <= 7) { sheet.key = k; sheet.keyGiven = true; }
}

export function sheetChords(sheet) {
  const out = [];
  for (const s of sheet.sections) for (const l of s.lines) for (const seg of l.segs || []) if (seg.chord && !seg.chord.nc) out.push(seg.chord);
  return out;
}

/** The sheet moved by `semitones`, every chord re-spelled for the new key. */
export function transposeSheet(sheet, semitones) {
  if (!semitones) return sheet;
  const interval = transposeInterval(sheet.key || { fifths: 0, mode: 'major' }, semitones);
  return {
    ...sheet,
    key: sheet.key ? transposeKey(sheet.key, interval) : sheet.key,
    sections: sheet.sections.map((s) => ({
      ...s,
      lines: s.lines.map((l) => (l.segs ? { ...l, segs: l.segs.map((g) => ({ ...g, chord: g.chord ? transposeChord(g.chord, interval) : g.chord })) } : l)),
    })),
    transposed: (sheet.transposed || 0) + semitones,
  };
}

/** ChordPro text (exact; chords in ASCII). */
export function toChordPro(sheet) {
  const out = [];
  if (sheet.title) out.push(`{title: ${sheet.title}}`);
  if (sheet.subtitle) out.push(`{subtitle: ${sheet.subtitle}}`);
  if (sheet.artist) out.push(`{artist: ${sheet.artist}}`);
  if (sheet.key) out.push(`{key: ${keyName(sheet.key, { ascii: true })}}`);
  if (sheet.capo) out.push(`{capo: ${sheet.capo}}`);
  if (sheet.tempo) out.push(`{tempo: ${sheet.tempo}}`);
  if (sheet.time) out.push(`{time: ${sheet.time}}`);
  for (const s of sheet.sections) {
    out.push('');
    const env = { chorus: 'chorus', bridge: 'bridge', tab: 'tab' }[s.kind] || 'verse';
    out.push(`{start_of_${env}${s.label ? `: ${s.label}` : ''}}`);
    for (const l of s.lines) {
      if (l.type === 'comment') out.push(`{comment: ${l.text}}`);
      else if (l.type === 'tab') out.push(l.text);
      else out.push(l.segs.map((g) => (g.chord ? `[${formatChord(g.chord, { ascii: true })}]` : '') + g.text).join(l.type === 'chords' ? ' ' : ''));
    }
    out.push(`{end_of_${env}}`);
  }
  return out.join('\n').trim() + '\n';
}

/** Chords above lyrics (monospace columns), as printed on chord sites. */
export function toChordsOverLyrics(sheet, { ascii = true } = {}) {
  const out = [];
  if (sheet.title) out.push(sheet.title + (sheet.artist ? ` - ${sheet.artist}` : ''));
  if (sheet.key) out.push(`Key: ${keyName(sheet.key, { ascii })}${sheet.capo ? `   Capo: ${sheet.capo}` : ''}`);
  for (const s of sheet.sections) {
    out.push('');
    if (s.label) out.push(`[${s.label}]`);
    for (const l of s.lines) {
      if (l.type === 'comment') { out.push(`(${l.text})`); continue; }
      if (l.type === 'tab') { out.push(l.text); continue; }
      if (l.type === 'chords') { out.push(l.segs.map((g) => formatChord(g.chord, { ascii })).join('   ')); continue; }
      let chordLine = '', lyricLine = '';
      for (const g of l.segs) {
        const name = g.chord ? formatChord(g.chord, { ascii }) : '';
        const width = Math.max(g.text.length, name ? name.length + 1 : 0);
        chordLine += name.padEnd(width);
        lyricLine += g.text.padEnd(width);
      }
      if (chordLine.trim()) out.push(chordLine.trimEnd());
      out.push(lyricLine.trimEnd());
    }
  }
  return out.join('\n').trim() + '\n';
}

/** Facts for the "Song info" card: unique chords with Roman numerals and counts, capo help. */
export function sheetInfo(sheet) {
  const chords = sheetChords(sheet);
  const counts = new Map();
  for (const c of chords) {
    const k = formatChord(c, { ascii: true });
    if (!counts.has(k)) counts.set(k, { chord: c, count: 0 });
    counts.get(k).count++;
  }
  const key = sheet.key || { fifths: 0, mode: 'major' };
  const unique = [...counts.values()].map((x) => ({ ...x, roman: romanNumeral(x.chord, key) }));
  return { key, unique, total: chords.length, capo: capoOptions(chords).slice(0, 3), lines: sheet.sections.reduce((s, x) => s + x.lines.length, 0) };
}

// ---------- PDF text ----------

/**
 * Rebuilds text lines from positioned PDF text items [{str, x, y, w, h}] (y grows upward, as pdf.js gives it),
 * keeping horizontal positions as character columns so chords stay above their syllables.
 */
export function linesFromTextItems(items) {
  const clean = items.filter((it) => it.str && it.str.trim());
  if (!clean.length) return [];
  const widths = clean.map((it) => it.w / Math.max(1, it.str.length)).filter((w) => w > 0).sort((a, b) => a - b);
  const charW = widths[Math.floor(widths.length / 2)] || 5;
  const heights = clean.map((it) => it.h || 10).sort((a, b) => a - b);
  const lineH = heights[Math.floor(heights.length / 2)] || 10;
  const sorted = [...clean].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const row = rows.find((r) => Math.abs(r.y - it.y) < lineH * 0.45);
    if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  const minX = Math.min(...clean.map((it) => it.x));
  const out = [];
  let lastY = null;
  for (const r of rows.sort((a, b) => b.y - a.y)) {
    if (lastY !== null && lastY - r.y > lineH * 2.2) out.push('');
    lastY = r.y;
    let line = '';
    for (const it of r.items.sort((a, b) => a.x - b.x)) {
      const col = Math.max(0, Math.round((it.x - minX) / charW));
      if (line.length < col) line = line.padEnd(col);
      else if (line.length && !line.endsWith(' ') && col <= line.length) line += ' ';
      line += it.str;
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}
