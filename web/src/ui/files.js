// Getting files out of the app: MusicXML, MIDI, PDF, text and zip.
//
// A plain "download" link does nothing inside the Android app and is unreliable in an iPhone home-screen
// app, so each place gets the way that really works there:
//   Android / iOS app (Capacitor)  write the file, then the system share sheet (Save to Files, Drive, WhatsApp...)
//   phones and tablets in a browser  the share sheet when the browser offers it, otherwise a download
//   computers                        a normal download
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { renderMusicXML, pageSize } from './verovio.js';
import { writePdf } from '../core/pdf.js';

export const MIME = {
  zip: 'application/zip', json: 'application/json', txt: 'text/plain', pdf: 'application/pdf', mid: 'audio/midi',
  musicxml: 'application/vnd.recordare.musicxml+xml', mxl: 'application/vnd.recordare.musicxml', png: 'image/png', jpg: 'image/jpeg',
};
const extOf = (name) => name.split('.').pop().toLowerCase();
const toBytes = (data) => (typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data));

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Why a save did not happen: 'cancelled' (the person closed the sheet), 'gesture' (the browser wants a fresh
 *  tap: show a Save button and call saveFile again from it), or 'failed'. */
export class SaveError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}

/**
 * Hands a file to the person. Resolves true when it went out, false when they cancelled.
 * Throws SaveError('gesture') when the browser needs a new tap first, SaveError('failed') otherwise.
 */
export async function saveFile(name, data) {
  const bytes = toBytes(data);
  const type = MIME[extOf(name)] || 'application/octet-stream';
  const blob = new Blob([bytes], { type });

  // the Claude preview has its own download prompt
  let dl = null;
  try { dl = await globalThis.claude?.use?.('downloads'); } catch { dl = null; }
  if (dl) {
    try { await dl.save({ filename: name, data: blob }); return true; } catch (e) {
      if (e?.code === 'declined') return false;
      throw new SaveError('failed', e?.message);
    }
  }

  if (Capacitor.isNativePlatform()) {
    try {
      const safe = name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Melovyn';
      const { uri } = await Filesystem.writeFile({ path: `export/${safe}`, data: base64(bytes), directory: Directory.Cache, recursive: true });
      await Share.share({ title: safe, files: [uri], dialogTitle: safe });
      return true;
    } catch (e) {
      if (/cancel/i.test(e?.message || '')) return false;
      throw new SaveError('failed', e?.message);
    }
  }

  const touch = globalThis.matchMedia?.('(pointer: coarse)').matches;
  if (touch && navigator.share) {
    try {
      const file = new File([blob], name, { type });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return true;
      }
    } catch (e) {
      if (e?.name === 'AbortError') return false;                 // the person closed the share sheet
      if (e?.name === 'NotAllowedError') throw new SaveError('gesture');
      // anything else: fall through to a download
    }
  }
  if (globalThis.HAPTUNE_CONFIG?.pwa === false && !globalThis.HAPTUNE_CONFIG?.native) throw new SaveError('failed');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
  return true;
}

function svgToJpeg(svg, widthPx) {
  return new Promise((resolve, reject) => {
    const size = pageSize(svg) || { w: 2100, h: 2970 };
    const w = Math.round(widthPx), h = Math.round(widthPx * size.h / size.w);
    // a stand-alone SVG picture needs its own size and colours (in the app they come from the page's styles)
    const sized = svg.replace(/<svg\b([^>]*)>/, (m, attrs) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, '')} width="${w}" height="${h}" color="#000" fill="#000">`);
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, 0, 0, w, h);
        cv.toBlob(async (b) => {
          if (!b) { reject(new Error('picture')); return; }
          resolve({ jpeg: new Uint8Array(await b.arrayBuffer()), w, h });
          cv.width = cv.height = 0;                                 // give the memory back straight away (iPhone)
        }, 'image/jpeg', 0.9);
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('picture'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized);
  });
}

/**
 * The engraved score as a PDF file (A4 pages), drawn on the device. `onProgress(done, total)` while it works.
 * Returns a Uint8Array.
 */
export async function scorePdf(xml, { title = '', onProgress = () => {} } = {}) {
  const { pages } = await renderMusicXML(xml, { width: 794, scale: 40, paper: 1.4142 });
  const out = [];
  // 1654 px across = 200 dots per inch on A4: crisp on paper, about 250 KB a page
  for (let i = 0; i < pages.length; i++) { out.push(await svgToJpeg(pages[i], 1654)); onProgress(i + 1, pages.length); }
  return writePdf(out, { title });
}
