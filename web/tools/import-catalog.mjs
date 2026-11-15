// Adds one open collection to the free library (assets/catalog), from a staged folder:
//   <stage>/manifest.json  {key, name, url, note, items: [{file, title?, composer?, genre, instrument, licence, source?}]}
//   <stage>/<file>         MIDI, MusicXML (.xml/.musicxml/.mxl) or ABC
// Stagers: tools/stage-mutopia.py, tools/stage-openscore-sq.mjs. Run:  node tools/import-catalog.mjs <stage>
//
// Rules (the app charges for some plans, so only licences that allow that):
//   * every piece needs its own licence line, and it must be Public domain, CC0, CC BY or CC BY-SA;
//     anything NonCommercial / NoDerivs / unknown is refused;
//   * every piece is opened with the app's own readers; a piece that doesn't read, is shorter than 4 bars or
//     has fewer than 16 notes is left out;
//   * the collection's previous rows are replaced (re-running is safe), other collections are untouched;
//   * index.json lists the collections with their links and counts ("sources"), shown under About.
// Popular songs still in copyright never go in the catalogue: people get those through Stage requests or by
// importing a sheet they own.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parseABC } from '../src/core/abc.js';
import { parseMusicXML } from '../src/core/musicxml.js';
import { mxlToXml } from '../src/core/zip.js';
import { readMIDI } from '../src/core/midi.js';
import { performance } from '../src/core/score.js';
import { GENRE_IDS } from '../src/core/genres.js';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(root, 'assets', 'catalog');
class Quiet extends DOMParser { constructor() { super({ onError: () => {} }); } }
const dom = { DOMParser: Quiet, XMLSerializer };

export const OPEN_LICENCE = /^(Public domain|CC0|CC BY(-SA)?( [\d.]+)?)( ·|$)/;
export const CLOSED_LICENCE = /\b(NC|ND|non-?commercial|no-?deriv|all rights reserved)\b/i;
export const okLicence = (s) => OPEN_LICENCE.test(String(s || '')) && !CLOSED_LICENCE.test(String(s || ''));

export async function readPiece(bytes, file, instrument = 'piano') {
  const f = file.toLowerCase();
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
  if (/\.midi?$/.test(f)) return readMIDI(new Uint8Array(ab)).score;
  if (f.endsWith('.mxl')) return parseMusicXML(await mxlToXml(ab), dom);
  if (f.endsWith('.abc')) return parseABC(new TextDecoder().decode(bytes), { instrument });
  return parseMusicXML(new TextDecoder().decode(bytes), dom);
}

export function levelOf(score) {
  const n = performance(score, { repeats: false }).events.length;
  const d = n / (score.measures.length || 1) / Math.max(1, score.parts.length);
  return d < 3 ? 1 : d < 5 ? 2 : d < 8 ? 3 : 4;
}

async function main() {
  const stage = process.argv[2];
  if (!stage) { console.error('usage: node tools/import-catalog.mjs <stage dir>'); process.exit(2); }
  const man = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
  const key = String(man.key || '').replace(/[^a-z0-9-]/g, '');
  if (!key || !man.name || !man.url) throw new Error('the manifest needs key, name and url');
  const index = JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8'));
  const dir = path.join(OUT, key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const stats = { refused_licence: 0, unreadable: 0, too_short: 0, duplicate: 0, bad_genre: 0 };
  const rows = [];
  const seen = new Set();
  const titles = new Map();
  for (const it of man.items) {
    if (!okLicence(it.licence)) { stats.refused_licence++; continue; }
    if (!GENRE_IDS.includes(it.genre)) { stats.bad_genre++; continue; }
    let score;
    try { score = await readPiece(fs.readFileSync(path.join(stage, it.file)), it.file, it.instrument); } catch { stats.unreadable++; continue; }
    const notes = performance(score, { repeats: false }).events.length;
    if (score.measures.length < 4 || notes < 16) { stats.too_short++; continue; }
    const bytes = fs.readFileSync(path.join(stage, it.file));
    const hash = crypto.createHash('sha1').update(bytes).digest('hex');
    if (seen.has(hash)) { stats.duplicate++; continue; }                  // the same file twice
    seen.add(hash);
    let title = String(it.title || score.title || it.work || path.basename(it.file).replace(/\.[^.]+$/, '')).replace(/\s+/g, ' ').trim().slice(0, 130);
    const composer = String(it.composer || score.composer || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const tk = `${title}|${composer}`.toLowerCase();
    titles.set(tk, (titles.get(tk) || 0) + 1);
    if (titles.get(tk) > 1) title = `${title} (${titles.get(tk)})`;       // movements of one work
    const name = `${key}/${path.basename(it.file)}`;
    fs.copyFileSync(path.join(stage, it.file), path.join(OUT, name));
    rows.push([`${key}-${rows.length}`, title, composer, it.genre, it.instrument || 'piano', name, it.licence, levelOf(score), it.source || man.url]);
  }
  index.items = [...index.items.filter((r) => !String(r[0]).startsWith(`${key}-`)), ...rows];
  index.sources = [...(index.sources || []).filter((s) => s.key !== key), { key, name: man.name, url: man.url, note: man.note || '', count: rows.length }];
  index.made = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
  const genres = rows.reduce((m, r) => ({ ...m, [r[3]]: (m[r[3]] || 0) + 1 }), {});
  const mb = fs.readdirSync(dir).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0) / 1e6;
  console.log(`${man.name}: ${rows.length} pieces added (${mb.toFixed(1)} MB)`, genres, stats, `· catalogue now ${index.items.length} pieces`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) await main();
