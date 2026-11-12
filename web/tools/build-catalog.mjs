// Builds the free library (assets/catalog) from open collections. Every piece is opened with the app's own
// readers first; anything that doesn't read cleanly is left out. Run:
//   MUSIC21_CORPUS=<music21>/corpus LIEDER=<When-in-Rome>/Corpus/OpenScore-LiederCorpus node tools/build-catalog.mjs
// Sources and licences (also shown in the app under About):
//   Bach chorales            music21 corpus (public-domain music; encodings by Margaret Greentree)
//   Ryan's Mammoth Collection (1883), O'Neill's Music of Ireland (1903), Aird's Airs (1778-1801),
//   American fife tunes, Northumbrian Minstrelsy   public-domain tune books, ABC by John Chambers and others
//   OpenScore Lieder Corpus  CC0 (public domain dedication)
// The Essen folksong collection is NOT used: it is licensed for non-commercial use only.
import fs from 'node:fs';
import path from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parseABC } from '../src/core/abc.js';
import { parseMusicXML } from '../src/core/musicxml.js';
import { mxlToXml } from '../src/core/zip.js';
import { performance } from '../src/core/score.js';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(root, 'assets', 'catalog');
const M21 = process.env.MUSIC21_CORPUS, LIEDER = process.env.LIEDER;
if (!M21 || !LIEDER) { console.error('Set MUSIC21_CORPUS and LIEDER'); process.exit(1); }
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'abc'), { recursive: true });
class Quiet extends DOMParser { constructor() { super({ onError: () => {} }); } }
const dom = { DOMParser: Quiet, XMLSerializer };
const items = [];
const seen = new Set();
const stats = {};
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const levelOf = (score) => {
  const n = performance(score, { repeats: false }).events.length;
  const bars = score.measures.length || 1;
  const d = n / bars / Math.max(1, score.parts.length);
  return d < 3 ? 1 : d < 5 ? 2 : d < 8 ? 3 : 4;
};

function addAbcCollection(key, files, { genre, licence, instrument = 'violin', composer = 'Traditional', fixTitle = (t) => t }) {
  const tunes = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'latin1');
    for (const chunk of text.split(/^(?=X:\s*\d)/m)) {
      if (!/^X:/.test(chunk) || !/^K:/m.test(chunk)) continue;
      let title = clean((/^T:\s*(.+)$/m.exec(chunk) || [])[1]);
      if (!title) continue;
      title = fixTitle(title.replace(/^(.*), (The|A|An)$/i, '$2 $1'));
      const id = `${key}:${title.toLowerCase()}`;
      if (seen.has(id)) continue;
      try {
        const body = chunk.replace(/^%.*$/gm, '').trim() + '\n';
        const score = parseABC(body, { instrument });
        const n = performance(score, { repeats: false }).events.length;
        if (score.measures.length < 4 || n < 8) continue;
        seen.add(id);
        tunes.push({ title, body, level: levelOf(score), composer: clean((/^C:\s*(.+)$/m.exec(chunk) || [])[1]) || composer });
      } catch { stats[`${key} skipped`] = (stats[`${key} skipped`] || 0) + 1; }
    }
  }
  tunes.sort((a, b) => a.title.localeCompare(b.title));
  const PER = 120;
  for (let i = 0; i < tunes.length; i += PER) {
    const name = `abc/${key}-${String(i / PER + 1).padStart(2, '0')}.json`;
    const part = tunes.slice(i, i + PER);
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(part.map((x) => x.body)));
    part.forEach((x, k) => items.push([`${key}-${i + k}`, x.title, x.composer, genre, instrument, `${name}#${k}`, licence, x.level]));
  }
  stats[key] = tunes.length;
}

async function addMxl(key, list, { genre, licence, instrument }) {
  fs.mkdirSync(path.join(OUT, key), { recursive: true });
  let n = 0;
  for (const { file, title, composer } of list) {
    try {
      const b = fs.readFileSync(file);
      const xml = await mxlToXml(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
      const score = parseMusicXML(xml, dom);
      if (score.measures.length < 4 || !performance(score, { repeats: false }).events.length) continue;
      const name = `${key}/${String(n + 1).padStart(3, '0')}.mxl`;
      fs.copyFileSync(file, path.join(OUT, name));
      items.push([`${key}-${n}`, title, composer, genre, instrument, name, licence, levelOf(score)]);
      n++;
    } catch { stats[`${key} skipped`] = (stats[`${key} skipped`] || 0) + 1; }
  }
  stats[key] = n;
}

const ls = (d, re) => fs.readdirSync(d).filter((f) => re.test(f)).sort().map((f) => path.join(d, f));
addAbcCollection('ryans', ls(path.join(M21, 'ryansMammoth'), /\.abc$/), { genre: 'dance', licence: "Public domain · Ryan's Mammoth Collection (1883)" });
addAbcCollection('oneills', ls(path.join(M21, 'oneills1850'), /\.abc$/), { genre: 'celtic', licence: "Public domain · O'Neill's Music of Ireland (1903)" });
addAbcCollection('airds', ls(path.join(M21, 'airdsAirs'), /\.abc$/), { genre: 'celtic', licence: "Public domain · Aird's Airs (1778-1801)" });
addAbcCollection('folk', ls(path.join(M21, 'miscFolk'), /\.abc$/), { genre: 'folk', licence: 'Public domain · traditional', instrument: 'flute' });

const bach = ls(path.join(M21, 'bach'), /^bwv[\d.]+\.mxl$/).map((file) => {
  const m = /bwv(\d+)(?:\.(\d+))?/.exec(path.basename(file));
  return { file, title: `Chorale BWV ${m[1]}${m[2] ? ` no. ${m[2]}` : ''}`, composer: 'J. S. Bach', n: Number(m[1]) * 100 + Number(m[2] || 0) };
}).sort((a, b) => a.n - b.n);
await addMxl('bach', bach, { genre: 'choral', licence: 'Public domain · music21 corpus', instrument: 'voice' });

const lieder = [];
(function walk(d) {
  for (const f of fs.readdirSync(d).sort()) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f === 'score.mxl') {
      const parts = path.relative(LIEDER, p).split(path.sep);        // Composer / Set / Song / score.mxl
      const composer = parts[0].replace(/_/g, ' ').replace(/^(.*), (.*)$/, '$2 $1').replace(/\s*\(.*\)/, '');
      const song = parts[2].replace(/_/g, ' ').replace(/^\d+[a-z]? /, '');
      const set = parts[1] === '_' ? '' : parts[1].replace(/_/g, ' ');
      lieder.push({ file: p, title: clean(song), composer: clean(composer), set });
    }
  }
})(LIEDER);
await addMxl('lieder', lieder, { genre: 'song', licence: 'CC0 · OpenScore Lieder Corpus', instrument: 'voice' });

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ version: 1, made: new Date().toISOString().slice(0, 10), items }));
const size = (d) => fs.readdirSync(d, { recursive: true }).reduce((s, f) => { const p = path.join(d, f); return s + (fs.statSync(p).isFile() ? fs.statSync(p).size : 0); }, 0);
console.log(stats, 'total', items.length, 'pieces,', (size(OUT) / 1e6).toFixed(1), 'MB; index', (fs.statSync(path.join(OUT, 'index.json')).size / 1e3).toFixed(0), 'KB');
