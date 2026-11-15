// Stages the OpenScore String Quartets (CC0, github.com/OpenScore/StringQuartets) for tools/import-catalog.mjs.
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/OpenScore/StringQuartets
//   (cd StringQuartets && git sparse-checkout set --no-cone '*.mxl')
//   node tools/stage-openscore-sq.mjs StringQuartets /tmp/stage-sq && node tools/import-catalog.mjs /tmp/stage-sq
// Each file is one work or movement; its title comes from the score. Practised as the first violin part.
import fs from 'node:fs';
import path from 'node:path';

const [src, stage] = process.argv.slice(2);
if (!src || !stage) { console.error('usage: node tools/stage-openscore-sq.mjs <StringQuartets checkout> <stage dir>'); process.exit(2); }
fs.mkdirSync(stage, { recursive: true });
const items = [];
(function walk(d) {
  for (const f of fs.readdirSync(d).sort()) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    const m = /^sq(\d+)\.mxl$/.exec(f);
    if (!m) continue;
    const rel = path.relative(path.join(src, 'scores'), p).split(path.sep);        // Composer / Work / sq<id>.mxl
    const composer = rel[0].replace(/_/g, ' ').replace(/^(.*?), (.*)$/, '$2 $1').replace(/\s*\(.*\)/, '').trim();
    const work = (rel[1] || '').replace(/_/g, ' ').trim();
    fs.copyFileSync(p, path.join(stage, f));
    items.push({ file: f, title: '', work, composer, genre: 'chamber', instrument: 'violin', licence: 'CC0 · OpenScore String Quartets', source: `https://musescore.com/score/${m[1]}` });
  }
})(path.join(src, 'scores'));
// several movements of one work: number them after the work's name when the score has no title of its own
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({
  key: 'osq', name: 'OpenScore String Quartets', url: 'https://github.com/OpenScore/StringQuartets', note: 'CC0 (public domain dedication).', items,
}));
console.log(items.length, 'scores staged');
