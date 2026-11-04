// Times parsing of MusicXML/MXL files: node tools/time-import.mjs file...
import fs from 'node:fs';
import zlib from 'node:zlib';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parseMusicXML } from '../src/core/musicxml.js';
import { mxlToXml, decodeText } from '../src/core/zip.js';
import { countNotes } from '../src/core/score.js';
for (const f of process.argv.slice(2)) {
  const buf = new Uint8Array(fs.readFileSync(f));
  const t0 = performance.now();
  const xml = f.endsWith('.mxl') ? await mxlToXml(buf, (b) => new Uint8Array(zlib.inflateRawSync(b))) : decodeText(buf);
  const score = parseMusicXML(xml, { DOMParser, XMLSerializer });
  const ms = performance.now() - t0;
  console.log(`${(buf.length / 1024).toFixed(0)} KB, ${score.parts.length} parts, ${score.measures.length} bars, ${countNotes(score).notes} notes: ${ms.toFixed(0)} ms  ${f.split('/').slice(-2).join('/')}`);
}
