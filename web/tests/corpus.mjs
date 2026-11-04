// Exactness check against music21 on the corpus (run: node tests/corpus.mjs)
import fs from 'node:fs';
import zlib from 'node:zlib';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parseMusicXML, writeMusicXML } from '../src/core/musicxml.js';
import { mxlToXml, decodeText } from '../src/core/zip.js';
import { midiOf } from '../src/core/pitch.js';

class QuietParser extends DOMParser { constructor() { super({ onError: () => {} }); } }
const dom = { DOMParser: QuietParser, XMLSerializer };
const inflateRaw = async (b) => new Uint8Array(zlib.inflateRawSync(b));
const ref = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const limit = Number(process.argv[3] || ref.length);
const REL = process.argv[2].includes('_rel');

function keys(score) {
  // music21 splits multi-staff parts into one part per staff
  const out = [];
  let base = 0;
  score.parts.forEach((part) => {
    part.measures.forEach((pm, mi) => {
      const start = score.measures[mi].start;
      for (const n of pm.notes) {
        if (n.rest || !n.pitch) continue;
        out.push(REL ? `${base + Math.min(n.staff, part.staves) - 1}|${mi}@${n.off}|${n.dur}|${midiOf(n.pitch)}` : `${base + Math.min(n.staff, part.staves) - 1}|${start.add(n.off)}|${n.dur}|${midiOf(n.pitch)}`);
      }
    });
    base += part.staves;
  });
  return out.sort();
}
function detail(score) {
  const out = [];
  score.parts.forEach((part, pi) => part.measures.forEach((pm, mi) => {
    for (const n of pm.notes) out.push([pi, mi, String(n.off), String(n.dur), n.rest, n.pitch ? midiOf(n.pitch) : -1, n.pitch ? n.pitch.step + n.pitch.alter : '', n.voice, n.staff, n.tie.start, n.tie.stop, n.type, n.dots, n.tm ? n.tm.actual + ':' + n.tm.normal : '', (n.lyrics || []).map((l) => l.text).join('/'), n.chord, !!n.grace].join('|'));
    for (const h of pm.harmonies) out.push(`H|${pi}|${mi}|${h.off}|${h.text}`);
  }));
  return out;
}
function multisetDiff(a, b) {
  const m = new Map();
  for (const x of a) m.set(x, (m.get(x) || 0) + 1);
  let missing = 0;
  for (const x of b) { const c = m.get(x) || 0; if (c > 0) m.set(x, c - 1); else missing++; }
  let extra = 0; for (const v of m.values()) extra += v;
  return { extra, missing };
}

let files = 0, refNotes = 0, matched = 0, exactFiles = 0, roundTripOk = 0, failures = [];
const t0 = Date.now();
let parseMs = 0;
for (const entry of ref.slice(0, limit)) {
  const buf = fs.readFileSync(entry.path);
  let xml;
  try { xml = entry.path.endsWith('.mxl') ? await mxlToXml(buf, inflateRaw) : decodeText(buf); } catch (e) { failures.push([entry.path, 'unzip ' + e.message]); continue; }
  let s1;
  const tp = Date.now();
  try { s1 = parseMusicXML(xml, dom); } catch (e) { failures.push([entry.path, 'parse ' + e.message]); continue; }
  parseMs += Date.now() - tp;
  files++;
  const mine = keys(s1);
  const d = multisetDiff(mine, entry.notes);
  refNotes += entry.notes.length;
  matched += entry.notes.length - d.missing;
  if (!d.extra && !d.missing) exactFiles++;
  else if (failures.length < 400) failures.push([entry.path.split('/corpus/')[1], `music21 differs: ${d.missing} missing, ${d.extra} extra of ${entry.notes.length}`]);
  // round trip through our writer
  let s2;
  try { s2 = parseMusicXML(writeMusicXML(s1), dom); } catch (e) { failures.push([entry.path, 'reparse ' + e.message]); continue; }
  const a = detail(s1).sort(), b = detail(s2).sort();
  if (a.length === b.length && a.every((x, i) => x === b[i])) roundTripOk++;
  else {
    const i = a.findIndex((x, k) => x !== b[k]);
    failures.push([entry.path.split('/corpus/')[1], `round trip differs at ${i}: ${a[i]}  vs  ${b[i]}`]);
  }
}
console.log(`files ${files}, notes vs music21: ${matched}/${refNotes} (${(100 * matched / refNotes).toFixed(3)}%), files identical to music21: ${exactFiles}, round trip identical: ${roundTripOk}/${files}, avg parse ${(parseMs / files).toFixed(1)} ms, total ${(Date.now() - t0) / 1000}s`);
for (const f of failures.slice(0, 40)) console.log(' -', f.join(': '));
