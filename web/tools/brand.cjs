// Makes every icon and name from web/brand.json, so changing the app's name or icon is one file (or one form in
// Developer mode > Brand, which commits that file; .github/workflows/brand.yml then runs this and rebuilds).
//   node tools/brand.cjs
// Writes: the website's favicon.svg / favicon.ico, the app's icons (assets/icons), the Android launcher icons
// (all densities, round and adaptive), the Android app name (strings.xml) and capacitor.config.json's appName.
// brand.json: { "name", "shortName", "icon": path to an SVG (best) or a PNG of at least 512 px, "background" }
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const WEB = path.join(__dirname, '..');
const brand = JSON.parse(fs.readFileSync(path.join(WEB, 'brand.json'), 'utf8'));
const iconPath = path.join(WEB, brand.icon || 'assets/brand/icon.svg');
const isSvg = iconPath.endsWith('.svg');
const raw = fs.readFileSync(iconPath);
const svgText = isSvg ? raw.toString('utf8') : null;
const dataUrl = isSvg ? `data:image/svg+xml;base64,${raw.toString('base64')}` : `data:image/png;base64,${raw.toString('base64')}`;
// the picture without its background square (an SVG whose first shape is a full-size <rect>): for Android's
// adaptive icon foreground, the maskable web icon and the round icon
const fgUrl = isSvg ? `data:image/svg+xml;base64,${Buffer.from(svgText.replace(/<rect[^>]*width="512"[^>]*height="512"[^>]*\/>/, '')).toString('base64')}` : dataUrl;
const bgOnly = isSvg && /^[\s\S]*?<rect[^>]*width="512"[^>]*height="512"[^>]*\/>/.exec(svgText);
const bgUrl = bgOnly ? `data:image/svg+xml;base64,${Buffer.from(bgOnly[0] + '</svg>').toString('base64')}` : null;
const bgFill = brand.background || '#8E52DE';

// one picture: size px, `shape` square|rounded|circle, `content` full|fg, `scale` of the picture inside
function html(size, { shape = 'square', content = 'full', scale = 1, bg = true }) {
  const r = shape === 'circle' ? '50%' : shape === 'rounded' ? `${Math.round(size * 0.22)}px` : '0';
  // under a scaled picture: the background alone (the SVG's own square, or the brand colour)
  const under = content === 'fg' && bg ? (bgUrl ? `<img src="${bgUrl}" style="position:absolute;inset:0;width:100%;height:100%">` : `<div style="position:absolute;inset:0;background:${bgFill}"></div>`) : '';
  const pic = content === 'fg' ? fgUrl : dataUrl;
  const pad = (1 - scale) / 2 * 100;
  return `<html><body style="margin:0;background:transparent"><div style="position:relative;width:${size}px;height:${size}px;border-radius:${r};overflow:hidden">
${under}<img src="${pic}" style="position:absolute;left:${pad}%;top:${pad}%;width:${scale * 100}%;height:${scale * 100}%"></div></body></html>`;
}

function ico(pngs) {                       // an .ico holding PNGs (every browser since IE Vista reads these)
  const head = Buffer.alloc(6 + pngs.length * 16);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(({ size, buf }, i) => {
    const e = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.buf)]);
}

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const shot = async (size, opts) => {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(html(size, opts), { waitUntil: 'load' });
    await p.waitForFunction(() => [...document.images].every((i) => i.complete));
    return p.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };
  const write = (rel, buf) => { const f = path.join(WEB, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); };

  // the website and the installed web app
  if (isSvg) write('site/favicon.svg', svgText.replace('<svg ', '<svg width="32" height="32" ').replace(/<rect([^>]*width="512"[^>]*height="512")/, '<rect rx="112"$1'));
  write('site/favicon.ico', ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, buf: await shot(size, { shape: 'rounded' }) })))));
  write('assets/icons/apple-touch-icon.png', await shot(180, { shape: 'square' }));
  for (const s of [48, 96, 192, 512]) write(`assets/icons/icon-${s}.png`, await shot(s, { shape: 'rounded' }));
  write('assets/icons/icon-512-maskable.png', await shot(512, { shape: 'square', content: 'fg', scale: 0.78 }));

  // Android launcher icons
  const RES = 'android/app/src/main/res';
  const D = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(D)) {
    write(`${RES}/mipmap-${d}/ic_launcher.png`, await shot(Math.round(48 * k), { shape: 'rounded' }));
    write(`${RES}/mipmap-${d}/ic_launcher_round.png`, await shot(Math.round(48 * k), { shape: 'circle', content: 'fg', scale: 0.8 }));
    // adaptive icon: 108 dp layers, the picture inside the 66 dp safe circle
    write(`${RES}/mipmap-${d}/ic_launcher_foreground.png`, await shot(Math.round(108 * k), { content: 'fg', scale: 0.8, bg: false }));
    write(`${RES}/mipmap-${d}/ic_launcher_background.png`, await shot(Math.round(108 * k), { shape: 'square', content: 'fg', scale: 0 }));
  }
  await b.close();
  write(`${RES}/values/ic_launcher_background.xml`, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${bgFill}</color>\n</resources>\n`);

  // the name on the phone's home screen
  const strings = path.join(WEB, RES, 'values/strings.xml');
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, "\\'");
  fs.writeFileSync(strings, fs.readFileSync(strings, 'utf8')
    .replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${esc(brand.shortName || brand.name)}$2`)
    .replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, `$1${esc(brand.name)}$2`));
  const capPath = path.join(WEB, 'capacitor.config.json');
  const cap = JSON.parse(fs.readFileSync(capPath, 'utf8'));
  cap.appName = brand.shortName || brand.name;
  fs.writeFileSync(capPath, JSON.stringify(cap, null, 2) + '\n');
  console.log(`brand: ${brand.name} (${path.relative(WEB, iconPath)}): icons and names written`);
})();
