// Turns files and pasted text into library pieces, timing each step for the import report.
import { parseMusicXML, describeScore } from '../core/musicxml.js';
import { mxlToXml, decodeText } from '../core/zip.js';
import { readMIDI } from '../core/midi.js';
import { parseABC } from '../core/abc.js';
import { parseChordSheet, sheetChords, linesFromTextItems } from '../core/chordsheet.js';
import { addScore, addSheet, addPdf } from './state.js';
import { t } from '../core/i18n.js';

const CFG = () => globalThis.HAPTUNE_CONFIG || {};

function loadScript(src, globalName) {
  if (globalName && globalThis[globalName]) return Promise.resolve(globalThis[globalName]);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve(globalName ? globalThis[globalName] : true);
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

let pdfLib = null;
export async function loadPdfJs() {
  if (pdfLib) return pdfLib;
  const cfg = CFG();
  // the worker script runs on the main thread (no separate worker needed)
  await loadScript(cfg.pdfWorker || 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', 'pdfjsWorker');
  pdfLib = await loadScript(cfg.pdfjs || 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', 'pdfjsLib');
  pdfLib.GlobalWorkerOptions.workerSrc = cfg.pdfWorker || 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  return pdfLib;
}

export async function openPdf(bytes) {
  const lib = await loadPdfJs();
  return lib.getDocument({ data: new Uint8Array(bytes.slice ? bytes.slice(0) : bytes), isEvalSupported: false, disableFontFace: false }).promise;
}

async function pdfText(bytes) {
  const doc = await openPdf(bytes);
  const lines = [];
  for (let i = 1; i <= Math.min(doc.numPages, 30); i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const items = tc.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || Math.hypot(it.transform[2], it.transform[3]) || 10 }));
    lines.push(...linesFromTextItems(items), '');
  }
  return { text: lines.join('\n'), pages: doc.numPages };
}

const baseName = (n) => n.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
const AUDIO = /\.(mp3|m4a|wav|aac|flac|ogg|opus|aif|aiff|caf|mp4|mov|webm|mkv|avi|3gp)$/i;
const IMAGE = /\.(png|jpe?g|heic|heif|gif|webp|tiff?|bmp)$/i;

/** Imports one file. Returns {piece, report}. Throws Error with a readable message. */
export async function importFile(file) {
  const name = file.name || 'file';
  const lower = name.toLowerCase();
  const t0 = performance.now();
  if (AUDIO.test(lower)) throw new Error(t('audioNotSupported'));
  if (IMAGE.test(lower)) throw new Error(t('importPdfNoText'));
  const bytes = await file.arrayBuffer();
  const report = { name, size: bytes.byteLength };
  let piece;
  if (/\.mxl$/.test(lower)) {
    const xml = await mxlToXml(bytes);
    const score = parseMusicXML(xml);
    Object.assign(report, describeScore(score), { exact: true, format: 'MusicXML (compressed)' });
    piece = await addScore(score, { fmt: 'mxl', title: score.title || baseName(name) });
  } else if (/\.(musicxml|xml)$/.test(lower)) {
    const score = parseMusicXML(decodeText(bytes));
    Object.assign(report, describeScore(score), { exact: true, format: 'MusicXML' });
    piece = await addScore(score, { fmt: 'musicxml', title: score.title || baseName(name) });
  } else if (/\.(mid|midi|kar|rmi|smf)$/.test(lower)) {
    const { score, report: r } = readMIDI(bytes, { title: baseName(name) });
    Object.assign(report, describeScore(score), r, { format: 'MIDI' });
    piece = await addScore(score, { fmt: 'midi', title: score.title || baseName(name) });
  } else if (/\.pdf$/.test(lower)) {
    const { text, pages } = await pdfText(bytes);
    let sheet = null;
    if (text.trim()) {
      const s = parseChordSheet(text, { title: baseName(name) });
      if (sheetChords(s).length >= 2) sheet = s;
    }
    const lyricLines = sheet ? sheet.sections.reduce((n, sec) => n + sec.lines.filter((l) => l.type === 'lyrics' && l.segs.some((g) => g.text.trim())).length, 0) : 0;
    Object.assign(report, { format: 'PDF', pages, pdfChords: sheet ? sheetChords(sheet).length : 0, pdfLyrics: lyricLines, pdfNoText: !text.trim() || !sheet });
    piece = await addPdf(bytes, { title: (sheet?.title && sheet.title !== baseName(name) ? sheet.title : baseName(name)), sheet, pages });
  } else if (/\.(abc)$/.test(lower)) {
    const score = parseABC(decodeText(bytes));
    Object.assign(report, describeScore(score), { exact: true, format: 'ABC' });
    piece = await addScore(score, { fmt: 'abc', title: score.title || baseName(name) });
  } else if (/\.(cho|chordpro|chopro|crd|pro|txt|text|tab)$/.test(lower) || file.type?.startsWith('text/')) {
    const text = decodeText(bytes);
    return importText(text, { title: baseName(name), t0, report });
  } else {
    throw new Error(t('unsupportedFile'));
  }
  report.ms = Math.max(1, Math.round(performance.now() - t0));
  return { piece, report };
}

/** Pasted or text-file content: ABC tune, MusicXML, or a chord sheet. */
export async function importText(text, { title = '', t0 = performance.now(), report = {} } = {}) {
  let piece;
  const trimmed = text.trim();
  if (/^X:\s*\d/m.test(trimmed) && /^K:/m.test(trimmed)) {
    const score = parseABC(trimmed);
    Object.assign(report, describeScore(score), { exact: true, format: 'ABC' });
    piece = await addScore(score, { fmt: 'abc', title: score.title || title });
  } else if (/^<\?xml|<score-partwise|<score-timewise/.test(trimmed)) {
    const score = parseMusicXML(trimmed);
    Object.assign(report, describeScore(score), { exact: true, format: 'MusicXML' });
    piece = await addScore(score, { fmt: 'musicxml', title: score.title || title });
  } else {
    const sheet = parseChordSheet(trimmed, { title });
    const chords = sheetChords(sheet);
    if (!chords.length) throw new Error(t('importFailed') + ': ' + t('pasteChordsSub'));
    Object.assign(report, { exact: true, format: sheet.format === 'chordpro' ? 'ChordPro' : 'Chord sheet', chordSymbols: chords.length, lines: sheet.sections.reduce((n, s) => n + s.lines.length, 0), keyEstimated: !sheet.keyGiven });
    piece = await addSheet(sheet, { fmt: sheet.format, title: sheet.title || title || 'Chord sheet' });
  }
  report.ms = Math.max(1, Math.round(performance.now() - t0));
  return { piece, report };
}

export const ACCEPT = '.musicxml,.xml,.mxl,.mid,.midi,.kar,.pdf,.abc,.cho,.chordpro,.chopro,.crd,.pro,.txt,application/pdf,audio/midi,audio/x-midi,text/plain,application/vnd.recordare.musicxml+xml,application/vnd.recordare.musicxml';
