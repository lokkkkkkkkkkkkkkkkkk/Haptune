// A small PDF writer: one JPEG picture per page. Enough to save a score as a real PDF file on every phone
// and computer (the browser's Print dialog is not available inside the Android app or on many phones).

const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const pdfText = (s) => {
  // PDF text strings: UTF-16BE with a byte order mark, written as hex, so any language works in the title
  let hex = 'FEFF';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
    for (const u of units) hex += u.toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
};

/** Width and height in pixels of a JPEG file (from its frame header). */
export function jpegSize(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const m = bytes[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8], comps: bytes[i + 9] };
    }
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return null;
}

/**
 * pages: [{jpeg: Uint8Array, w, h}] (pixel size; read from the JPEG when left out).
 * size: [width, height] of the paper in points (A4 by default). Each picture fills its page, keeping its shape.
 * Returns the PDF file as a Uint8Array.
 */
export function writePdf(pages, { title = '', size = [595.28, 841.89], margin = 0 } = {}) {
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => { const b = typeof data === 'string' ? enc(data) : data; chunks.push(b); length += b.length; };
  const obj = (n, body, stream = null) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) { push('stream\n'); push(stream); push('\nendstream\n'); }
    push('endobj\n');
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  const pageObj = (i) => 4 + i * 3, imgObj = (i) => 5 + i * 3, conObj = (i) => 6 + i * 3;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`);
  obj(3, `<< /Title ${pdfText(title)} /Creator ${pdfText('Haptune')} /Producer ${pdfText('Haptune')} >>`);
  const [W, H] = size;
  pages.forEach((pg, i) => {
    const dim = pg.w && pg.h ? { w: pg.w, h: pg.h, comps: 3 } : jpegSize(pg.jpeg);
    if (!dim) throw new Error('Not a JPEG picture');
    const scale = Math.min((W - 2 * margin) / dim.w, (H - 2 * margin) / dim.h);
    const w = dim.w * scale, h = dim.h * scale;
    const x = (W - w) / 2, y = H - margin - h;                 // top of the page, centred
    const content = enc(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`);
    obj(pageObj(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${imgObj(i)} 0 R >> >> /Contents ${conObj(i)} 0 R >>`);
    obj(imgObj(i), `<< /Type /XObject /Subtype /Image /Width ${dim.w} /Height ${dim.h} /ColorSpace ${(dim.comps || 3) === 1 ? '/DeviceGray' : '/DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>`, pg.jpeg);
    obj(conObj(i), `<< /Length ${content.length} >>`, content);
  });
  const xref = length;
  const count = 4 + n * 3;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let k = 1; k < count; k++) table += `${String(offsets[k]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
