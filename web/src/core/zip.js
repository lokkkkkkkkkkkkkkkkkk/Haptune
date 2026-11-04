// Minimal ZIP reader (for .mxl compressed MusicXML) and writer (for export bundles).
// `inflateRaw(bytes) -> Promise<Uint8Array>` is injected: DecompressionStream in browsers, zlib in Node.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

/** Decodes text files that may be UTF-8, UTF-16 (with or without BOM) or Latin-1. */
export function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return utf8d.decode(b.subarray(3));
  // UTF-16 without BOM: '<' followed by 0
  if (b[0] === 0x3c && b[1] === 0x00) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0x00 && b[1] === 0x3c) return new TextDecoder('utf-16be').decode(b);
  const head = String.fromCharCode(...b.subarray(0, 200));
  const enc = /encoding=["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase();
  if (enc && /^(iso-8859-1|latin1|windows-1252)$/.test(enc)) return new TextDecoder('windows-1252').decode(b);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(b);
  return text;
}

export async function browserInflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open compressed files. Export the score as uncompressed MusicXML (.musicxml) instead.');
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads a zip: returns Map(name -> async () => Uint8Array). */
export function readZip(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a valid zip/.mxl archive.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = utf8d.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    entries.set(name, { method, compSize, localOff });
  }
  const files = new Map();
  for (const [name, e] of entries) {
    files.set(name, async (inflateRaw) => {
      const lp = e.localOff;
      const nl = dv.getUint16(lp + 26, true);
      const el = dv.getUint16(lp + 28, true);
      const start = lp + 30 + nl + el;
      const data = bytes.subarray(start, start + e.compSize);
      if (e.method === 0) return data;
      if (e.method === 8) return inflateRaw(data);
      throw new Error(`Unsupported compression in ${name}`);
    });
  }
  return files;
}

/** The MusicXML text inside an .mxl file. */
export async function mxlToXml(buf, inflateRaw = browserInflateRaw) {
  const files = readZip(buf);
  let rootPath = null;
  if (files.has('META-INF/container.xml')) {
    const container = decodeText(await files.get('META-INF/container.xml')(inflateRaw));
    const m = /full-path="([^"]+)"/.exec(container);
    if (m) rootPath = m[1];
  }
  if (!rootPath || !files.has(rootPath)) {
    rootPath = [...files.keys()].find((n) => !n.startsWith('META-INF') && /\.(xml|musicxml)$/i.test(n));
  }
  if (!rootPath) throw new Error('No MusicXML score was found inside this .mxl file.');
  return decodeText(await files.get(rootPath)(inflateRaw));
}

/** Writes a zip with stored (uncompressed) entries: files = [{name, data: string|Uint8Array}]. */
export function writeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = utf8.encode(f.name);
    const data = typeof f.data === 'string' ? utf8.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30);
    chunks.push(local, data);
    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += local.length + data.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
  const total = offset + cenSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of [...chunks, ...central, end]) { out.set(c, p); p += c.length; }
  return out;
}

/** A compressed MusicXML (.mxl) file for a MusicXML string. */
export function xmlToMxl(xml, name = 'score.musicxml') {
  const container = `<?xml version="1.0" encoding="UTF-8"?>\n<container><rootfiles><rootfile full-path="${name}" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>\n`;
  return writeZip([{ name: 'mimetype', data: 'application/vnd.recordare.musicxml' }, { name: 'META-INF/container.xml', data: container }, { name, data: xml }]);
}
