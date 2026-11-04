import fs from 'node:fs'; import zlib from 'node:zlib';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parseMusicXML } from '../src/core/musicxml.js';
import { mxlToXml, decodeText } from '../src/core/zip.js';
import { writeMIDI, readMIDI } from '../src/core/midi.js';
import { performance } from '../src/core/score.js';
class QuietParser extends DOMParser { constructor() { super({ onError: () => {} }); } }
const ref = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).slice(0, Number(process.argv[3] || 100));
let files = 0, exact = 0, evTotal = 0, evMatch = 0; const bad = [];
for (const e of ref) {
  const buf = fs.readFileSync(e.path);
  const xml = e.path.endsWith('.mxl') ? await mxlToXml(buf, async (b) => new Uint8Array(zlib.inflateRawSync(b))) : decodeText(buf);
  const s = parseMusicXML(xml, { DOMParser: QuietParser, XMLSerializer });
  const key = (ev) => `${ev.t}|${ev.dur}|${ev.midi}`;
  const a = performance(s, { repeats: false }).events.filter((x) => !x.unpitched).map(key).sort();
  let back;
  try { back = readMIDI(writeMIDI(s, { repeats: false })).score; } catch (err) { bad.push([e.path, err.message]); continue; }
  const b = performance(back, { repeats: false }).events.map(key).sort();
  files++;
  const m = new Map(); for (const x of a) m.set(x, (m.get(x) || 0) + 1);
  let hit = 0; for (const x of b) { const c = m.get(x) || 0; if (c) { m.set(x, c - 1); hit++; } }
  evTotal += a.length; evMatch += hit;
  if (hit === a.length && a.length === b.length) exact++; else if (bad.length < 8) bad.push([e.path.split('corpus/')[1], `${hit}/${a.length} (back ${b.length})`]);
}
console.log(`MIDI round trip: ${exact}/${files} files exact, ${evMatch}/${evTotal} notes (${(100 * evMatch / evTotal).toFixed(2)}%)`);
for (const x of bad) console.log(' -', x.join(': '));
