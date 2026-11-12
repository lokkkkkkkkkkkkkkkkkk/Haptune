// The free library: public-domain and openly licensed music, searched on the device and downloaded only
// when a piece is opened, so the app itself stays small.
//
// catalog/index.json (built by tools/build-catalog.mjs) is a list of rows:
//   [id, title, composer, genre, instrument, file, licence, level]
// `file` is a path inside catalog/ (ABC, MusicXML or compressed MusicXML). The built-in songbook is part of
// the same list, so search has one place to look.
import { SONGS, songTitle } from '../data/songs.js';
import { parseABC } from '../core/abc.js';
import { parseMusicXML } from '../core/musicxml.js';
import { mxlToXml, decodeText } from '../core/zip.js';
import { readMIDI } from '../core/midi.js';
import { addScore, addSongbookSong, getState } from './state.js';
import { getLang } from '../core/i18n.js';

const CFG = () => globalThis.HAPTUNE_CONFIG || {};
let rows = null, loading = null;

export const GENRES = ['classical', 'piano', 'folk', 'song', 'hymn', 'kids', 'christmas', 'jazz', 'chinese', 'celtic', 'choral', 'dance', 'chamber'];

function builtIn() {
  const lang = getLang();
  return SONGS.map((s) => ({
    id: `song:${s.id}`, songId: s.id, title: songTitle(s, lang), alt: Object.values(s.titles || {}).join(' '),
    composer: /C:(.*)/.exec(s.abc)?.[1]?.trim() || '', genre: s.tags.includes('christmas') ? 'christmas' : s.tags.includes('kids') ? 'kids' : s.tags.includes('chinese') ? 'chinese' : s.tags.includes('classical') ? 'classical' : 'folk',
    instrument: 'voice', level: s.level + 1, licence: 'Public domain',
  }));
}

/** Loads the catalogue once. Works offline with the built-in songbook when the index can't be fetched. */
export function loadCatalog() {
  if (rows) return Promise.resolve(rows);
  if (loading) return loading;
  loading = (async () => {
    const base = builtIn();
    try {
      if (CFG().pwa === false && !CFG().native) throw new Error('preview');      // the one-file preview has no catalogue files
      const res = await fetch('catalog/index.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('no catalogue');
      const data = await res.json();
      const more = (data.items || []).map(([id, title, composer, genre, instrument, file, licence, level]) => ({ id, title, composer, genre, instrument, file, licence, level: level || 0 }));
      rows = [...base, ...more];
    } catch { rows = base; }
    for (const r of rows) r.key = norm(`${r.title} ${r.alt || ''} ${r.composer}`);
    return rows;
  })();
  return loading;
}

/** Lower case, accents removed, punctuation to spaces: "Für Elise" matches "fur elise". */
export function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Pieces matching every word of the query, best first (title starts with it > title has it > composer). */
export function searchCatalog(list, query, { limit = 12, genre = '' } = {}) {
  const words = norm(query).split(' ').filter(Boolean);
  const out = [];
  for (const r of list) {
    if (genre && r.genre !== genre) continue;
    if (!words.length) { out.push([0, r]); continue; }
    if (!words.every((w) => r.key.includes(w))) continue;
    const title = norm(r.title);
    const q = words.join(' ');
    out.push([title === q ? 0 : title.startsWith(q) ? 1 : title.includes(q) ? 2 : 3, r]);
  }
  out.sort((a, b) => a[0] - b[0] || (b[1].level ? 0 : -1) - (a[1].level ? 0 : -1) || a[1].title.localeCompare(b[1].title));
  return out.slice(0, limit).map((x) => x[1]);
}

/** Adds a catalogue piece to the library (downloading it if needed). Resolves to the library record. */
export async function addCatalogPiece(entry) {
  if (entry.songId) return addSongbookSong(entry.songId, { silent: true });
  const have = getState().pieces.find((p) => p.catalogId === entry.id);
  if (have) return have;
  const res = await fetch(`catalog/${entry.file}`);
  if (!res.ok) throw new Error('This piece could not be downloaded. Check your connection.');
  const bytes = await res.arrayBuffer();
  const f = entry.file.toLowerCase();
  let score;
  if (f.endsWith('.mxl')) score = parseMusicXML(await mxlToXml(bytes));
  else if (f.endsWith('.abc')) score = parseABC(decodeText(bytes), { instrument: entry.instrument || 'voice' });
  else if (/\.midi?$/.test(f)) score = readMIDI(bytes, { title: entry.title }).score;
  else score = parseMusicXML(decodeText(bytes));
  score.title = entry.title;
  if (entry.composer && !score.composer) score.composer = entry.composer;
  return addScore(score, { source: 'catalog', fmt: f.split('.').pop(), title: entry.title, extra: { catalogId: entry.id, license: entry.licence, tags: [entry.genre], level: entry.level || undefined } });
}
