const { chromium } = require('playwright');
const path = require('path');
const svg = (size, rounded) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5E5CE6"/><stop offset=".5" stop-color="#BF5AF2"/><stop offset="1" stop-color="#FF375F"/></linearGradient></defs>
<rect width="100" height="100" rx="${rounded ? 22 : 0}" fill="url(#g)"/>
<g fill="none" stroke="#fff" stroke-linecap="round">
<path d="M45 26v38" stroke-width="5.5"/>
<path d="M45 26c6 4 12 6 16 13" stroke-width="5.5"/>
<path d="M66 50a13 13 0 0 1 0 16" stroke-width="4" opacity=".9"/>
<path d="M73 44a22 22 0 0 1 0 28" stroke-width="4" opacity=".65"/>
</g>
<ellipse cx="36" cy="66" rx="11.5" ry="8.5" transform="rotate(-22 36 66)" fill="#fff"/>
</svg>`;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const out = path.join(__dirname, '..', 'assets', 'icons');
  for (const [name, size, rounded, pad] of [['apple-touch-icon.png', 180, false, 0], ['icon-192.png', 192, true, 0], ['icon-512.png', 512, true, 0], ['icon-512-maskable.png', 512, false, 0]]) {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<html><body style="margin:0;background:transparent">${svg(size, rounded)}</body></html>`);
    await p.screenshot({ path: path.join(out, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
  await b.close();
})();
