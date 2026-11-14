// Draws the social-media preview (site/og-image.png, 1200x630) from two phone screenshots of the app.
//   npm run build && node tools/e2e.cjs phone && node tools/og-image.cjs
// Uses shots/phone-01-home.png and shots/phone-02-song.png (falls back to any phone shots it finds).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SHOTS = process.env.SHOTS || path.join(__dirname, '..', 'shots');
const OUT = path.join(__dirname, '..', 'site', 'og-image.png');
const pick = (...names) => names.map((n) => path.join(SHOTS, n)).find((f) => fs.existsSync(f));
const left = pick('phone-01-home.png', 'phone-07b-learn.png', 'phone-01-search.png');
const right = pick('phone-02-song.png', 'phone-04-editor.png', 'phone-06-write.png');
if (!left || !right) { console.error('Run the phone e2e first so there are screenshots in', SHOTS); process.exit(1); }
const b64 = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
const icon = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icons', 'icon-192.png')).toString('base64');
const font = fs.readFileSync(path.join(__dirname, '..', 'node_modules/@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2')).toString('base64');

const html = `<html><head><style>
@font-face{font-family:J;src:url(data:font/woff2;base64,${font})}
body{margin:0;width:1200px;height:630px;font-family:J,sans-serif;color:#fff;overflow:hidden;
 background:radial-gradient(900px 500px at 10% 0%,#3b2a8f 0,transparent 60%),radial-gradient(700px 500px at 100% 100%,#6b1f3f 0,transparent 60%),#0e0d15}
.brand{position:absolute;left:70px;top:62px;display:flex;align-items:center;gap:18px;font-weight:800;font-size:40px;letter-spacing:-.5px}
.brand img{width:58px;height:58px;border-radius:14px}
h1{position:absolute;left:70px;top:150px;margin:0;font-size:62px;line-height:1.04;font-weight:800;letter-spacing:-1.5px;width:600px}
h1 em{font-style:normal;background:linear-gradient(90deg,#a99bff,#ff6fa3);-webkit-background-clip:text;color:transparent}
p{position:absolute;left:70px;top:420px;margin:0;font-size:24px;color:#c9c6d8;width:560px;line-height:1.35}
.chips{position:absolute;left:70px;bottom:52px;display:flex;gap:12px}
.chips span{border:1px solid #3a3850;background:#1c1b27;border-radius:30px;padding:10px 20px;font-size:21px;font-weight:700}
.ph{position:absolute;width:250px;height:520px;border-radius:34px;border:7px solid #1c1b27;overflow:hidden;box-shadow:0 30px 80px #0008;background:#fff}
.ph img{width:100%;display:block}
.a{left:690px;top:90px;transform:rotate(-6deg)}.b{left:910px;top:40px;transform:rotate(5deg)}
</style></head><body>
<div class="brand"><img src="data:image/png;base64,${icon}">Melovyn</div>
<h1>Get the sheet. <em>Practise it</em> with an app that listens.</h1>
<p>Marks every wrong note, even in a noisy room. Learn with your teacher, create and share on Stage.</p>
<div class="chips"><span>🎹 Practice</span><span>🎓 Learn</span><span>✏️ Create</span><span>Free</span></div>
<div class="ph a"><img src="${b64(left)}"></div><div class="ph b"><img src="${b64(right)}"></div>
</body></html>`;

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  await p.setContent(html);
  await p.waitForTimeout(200);
  await p.screenshot({ path: OUT });
  await b.close();
  console.log('wrote', OUT);
})();
