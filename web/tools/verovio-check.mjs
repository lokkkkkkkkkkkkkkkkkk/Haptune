// Checks that Haptune's MusicXML writer never makes a score harder for Verovio to draw: loads each file as
// it was and as Haptune writes it, and lists files whose rewrite produces more Verovio import errors.
// Usage: node tools/verovio-check.mjs file1.mxl file2.musicxml ...
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import createVerovioModule from 'verovio/wasm';
import { VerovioToolkit } from 'verovio/esm';
import { parseMusicXML, writeMusicXML } from '../src/core/musicxml.js';
import { mxlToXml } from '../src/core/zip.js';
globalThis.DOMParser = DOMParser; globalThis.XMLSerializer = XMLSerializer;
let count = 0, msgs = [];
for (const k of ['log', 'warn', 'error']) { const f = console[k]; console[k] = (...a) => { const s = a.join(' '); if (/^\[Error\]/.test(s)) { count++; msgs.push(s.trim()); } else if (!/^\[(Warning|Info)\]/.test(s)) f(...a); }; }
const M = await createVerovioModule();
const tk = new VerovioToolkit(M);
tk.setOptions({ breaks: 'none' });
const errs = (xml) => { count = 0; msgs = []; tk.loadData(xml); return { n: count, msgs: [...new Set(msgs)].slice(0, 2) }; };
let bad = 0, total = 0;
for (const f of process.argv.slice(2)) {
  try {
    const xml = f.endsWith('.mxl') ? await mxlToXml(readFileSync(f), async (b) => inflateRawSync(b)) : readFileSync(f, 'utf8');
    const o = errs(xml);
    const w = errs(writeMusicXML(parseMusicXML(xml, globalThis)));
    total++;
    if (w.n > o.n) { bad++; console.log('WORSE', f.split('corpus/').pop(), o.n, '->', w.n, w.msgs.join(' | ')); }
  } catch (e) { console.log('FAIL', f.split('corpus/').pop(), e.message.slice(0, 120)); }
}
console.log(`checked ${total}, worse after rewrite: ${bad}`);
