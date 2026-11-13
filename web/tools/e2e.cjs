// Click-through test of the built site and app at phone, tablet and computer sizes.
//   npm run build && node tools/e2e.cjs            (all three sizes)
//   node tools/e2e.cjs phone                        (one size; also: tablet, desktop)
// It serves dist/pages itself, walks through what people do most (find a song, open it, listen, 簡譜, another
// instrument, edit a note, export, library, Stage, Learn, Me, plans) and fails on any error in the page,
// a step that doesn't work, or anything sticking out sideways. It also freezes the sound system on purpose
// and checks that playback recovers. Screenshots go to web/shots/.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

const ROOT = path.join(__dirname, '..', 'dist', 'pages');
const SHOTS = process.env.SHOTS || path.join(__dirname, '..', 'shots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.mxl': 'application/octet-stream', '.css': 'text/css' };
const SIZES = {
  phone: devices['iPhone 13'],
  tablet: devices['iPad (gen 7) landscape'],
  desktop: { viewport: { width: 1366, height: 860 } },
};

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function run(mode, base, browser) {
  const ctx = await browser.newContext({ ...SIZES[mode], acceptDownloads: true });
  // lets the test freeze one AudioContext's clock, the way iOS does after an interruption
  await ctx.addInitScript(() => {
    const frozen = new WeakMap();
    const d = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'currentTime');
    Object.defineProperty(BaseAudioContext.prototype, 'currentTime', { get() { return frozen.has(this) ? frozen.get(this) : d.get.call(this); } });
    const Real = window.AudioContext;
    window.__ctxs = [];
    window.AudioContext = function (...a) { const c = new Real(...a); window.__ctxs.push(c); return c; };
    window.AudioContext.prototype = Real.prototype;
    window.__freeze = () => { const c = window.__ctxs[window.__ctxs.length - 1]; frozen.set(c, d.get.call(c)); };
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  p.on('pageerror', (e) => errors.push('page: ' + e.message));
  const shot = (n) => p.screenshot({ path: path.join(SHOTS, `${mode}-${n}.png`) });
  const step = async (name, fn) => { try { await fn(); } catch (e) { errors.push(`${name}: ${e.message.split('\n')[0]}`); } };
  // the places: a sidebar on wide screens, a tab bar on phones; Me is the sidebar's account button or the picture
  const LABEL = { home: 'practice', learn: 'hub', stage: 'stage', library: 'library', write: 'write' };
  const tab = async (id) => {
    const wide = await p.evaluate(() => innerWidth >= 900);
    if (id === 'me') return wide ? p.locator('#top-me').click() : p.locator('.avatar:visible').first().click();
    return p.locator(`${wide ? '#side' : '#tab'}-${LABEL[id] || id}:visible`).click();
  };
  const back = () => p.locator('.navbar .back:visible, .back-btn:visible').first().click();
  const overflow = async (where) => {
    const bad = await p.evaluate(() => {
      const out = [];
      document.querySelectorAll('.tab-pane:not([hidden]) .view:not([hidden]) *, .sheet *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > innerWidth + 1 && !el.closest('.shelf, .roll, .chips, .segmented, .score-box, .kbd-wrap, .helpers-strip, .bar-strip, .hscroll, .jp-box'))
          out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} → ${Math.round(r.right)}`);
      });
      return out.slice(0, 4);
    });
    if (bad.length) errors.push(`sticks out sideways in ${where}: ${bad.join(' | ')}`);
  };

  await step('website', async () => {
    await p.goto(base + '/', { waitUntil: 'networkidle' });
    await p.waitForSelector('#try-q');
    await shot('00-website');
    const side = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (side > 1) throw new Error(`the website is ${side}px too wide`);
    for (const f of ['privacy.html', 'terms.html', 'refunds.html']) { const r = await p.request.get(`${base}/${f}`); if (!r.ok()) throw new Error(`${f} is missing`); }
    await p.fill('#try-q', 'ode to joy'); await p.keyboard.press('Enter');
    await p.waitForSelector('.welcome', { timeout: 20000 });
  });
  await step('first-run guide', async () => {
    for (let i = 0; i < 3; i++) { await p.locator('.welcome .btn.brand:visible').click(); await p.waitForTimeout(250); }
    await p.locator('.welcome .btn.brand:visible').click(); await p.waitForTimeout(500);
    if ((await p.inputValue('#home-search')) !== 'ode to joy') throw new Error('the song typed on the website did not arrive in the app');
    await shot('01-search'); await overflow('search');
  });
  await step('open the song and listen', async () => {
    await p.locator('.sr-item').filter({ hasText: /Ode to Joy/ }).first().click();
    await p.waitForSelector('.vrv-page svg', { timeout: 60000 });
    await shot('02-song'); await overflow('song');
    await p.locator('#play-btn').click(); await p.waitForTimeout(1800);
    const a = await p.evaluate(() => ({ ...window.__haptuneAudio(), cursor: !document.querySelector('.vrv-cursor')?.hidden }));
    if (a.state !== 'running' || !a.scheduled || !a.cursor) throw new Error('not playing: ' + JSON.stringify(a));
  });
  await step('sound system freezes and recovers', async () => {
    const before = await p.locator('.bar-pos strong').innerText();
    await p.evaluate(() => window.__freeze());
    await p.waitForTimeout(5200);
    const a = await p.evaluate(() => window.__haptuneAudio());
    const after = await p.locator('.bar-pos strong').innerText();
    if (a.rebuilds < 1 || a.state !== 'running' || before === after) throw new Error(`did not recover: ${JSON.stringify({ rebuilds: a.rebuilds, state: a.state, before, after })}`);
    await p.locator('#play-btn').click();
  });
  await step('簡譜 and another instrument', async () => {
    await p.locator('#piece-views button').filter({ hasText: '簡譜' }).click(); await p.waitForSelector('.jp-svg .jn');
    await shot('03-jianpu'); await overflow('簡譜');
    await p.locator('#piece-views button').first().click();
    await p.locator('#tool-inst').click(); await p.locator('.sheet .chip').filter({ hasText: 'Clarinet' }).click();
    await p.waitForSelector('#arr-note'); await p.waitForTimeout(600);
    await p.locator('#tool-inst').click(); await p.locator('#inst-as-written').click();
  });
  await step('key change', async () => {
    await p.locator('#tool-key').click(); await p.waitForSelector('.keybar');
    const k0 = await p.locator('.keybar .stepper-value, .keybar strong').first().innerText().catch(() => '');
    await p.locator('.keybar button').last().click(); await p.waitForTimeout(300);
    await p.keyboard.press('Escape'); await p.waitForTimeout(800);
    const chip = await p.locator('.meta-chips button.meta').first().innerText();
    if (/\bD\b/.test(chip) && !/E/.test(chip)) throw new Error(`key did not change (${k0} -> ${chip})`);
  });
  await step('edit a note', async () => {
    await p.locator('#edit-notes').click(); await p.waitForSelector('.ed-score svg', { timeout: 30000 }); await p.waitForTimeout(400);
    await p.locator('.ed-score g.note').first().click({ force: true }); await p.waitForTimeout(200);
    const before = await p.locator('#ed-info').innerText();
    await p.locator('#ed-up').click(); await p.waitForTimeout(700);
    if (before === await p.locator('#ed-info').innerText()) throw new Error('the note did not move');
    await p.locator('#ed-split').click(); await p.waitForTimeout(700);
    await shot('04-editor'); await overflow('editor');
    await p.locator('#ed-undo').click(); await p.locator('#ed-undo').click(); await p.waitForTimeout(600);
    await back(); await p.waitForSelector('.vrv-page svg');
  });
  if (mode === 'desktop') {
    await step('export', async () => {
      for (const kind of ['sheetpdf', 'musicxml', 'midi']) {
        await p.locator('.navbar .nav-actions button').last().click(); await p.waitForSelector(`#exp-${kind}`);
        const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), p.locator(`#exp-${kind}`).click()]);
        const file = path.join(SHOTS, `export-${kind}`); await dl.saveAs(file);
        const head = fs.readFileSync(file).subarray(0, 5).toString('latin1');
        if (!{ sheetpdf: /^%PDF-/, musicxml: /^<\?xml/, midi: /^MThd/ }[kind].test(head)) throw new Error(`${kind} is not the right kind of file`);
        await p.keyboard.press('Escape'); await p.waitForTimeout(250);
      }
    });
  }
  await step('library and the free library', async () => {
    await back(); await tab('library'); await p.waitForTimeout(300);
    await shot('05-library'); await overflow('library');
    await p.locator('#lib-free').click(); await p.waitForSelector('#cat-search');
    await p.fill('#cat-search', 'washerwoman'); await p.waitForTimeout(500);
    await p.locator('.list .row:visible').first().click(); await p.waitForSelector('.vrv-page svg', { timeout: 60000 });
    await back(); await back();
  });
  await step('type 簡譜', async () => {
    await tab('home'); await p.fill('#home-search', ''); await p.locator('#way-type').click();
    await p.locator('.sheet .chip').filter({ hasText: '簡譜' }).click(); await p.waitForTimeout(250);
    await p.locator('.sheet .btn.full').click(); await p.waitForTimeout(500);
    await p.locator('.sheet .btn').filter({ hasText: /Continue|Open/ }).first().click();
    await p.waitForSelector('.vrv-page svg', { timeout: 60000 });
    if (!/茉莉花/.test(await p.locator('.piece-head h1').innerText())) throw new Error('the typed 簡譜 did not open');
    await back();
  });
  await step('write a song', async () => {
    await tab('write'); await p.waitForTimeout(300); await shot('06-write'); await overflow('Write');
    await p.locator('#write-new').click(); await p.waitForSelector('#new-song-make');
    await p.fill('#new-song-title', 'My first song'); await p.locator('#new-song-make').click();
    await p.waitForSelector('.st-score svg', { timeout: 60000 }); await p.waitForTimeout(400);
    const before = await p.locator('.st-score g.note').count();
    for (const k of [0, 2, 4, 5]) { await p.locator('.st-kbd .wkey').nth(k).click(); await p.waitForTimeout(120); }
    await p.waitForFunction((n) => document.querySelectorAll('.st-score g.note').length >= n + 4, before, { timeout: 20000 });
    await p.locator('#st-back').click(); await p.waitForTimeout(300);
    await shot('06b-studio'); await overflow('studio');
    await back(); await p.waitForTimeout(300);
    if (!(await p.locator('#write .song-tile').filter({ hasText: 'My first song' }).count())) throw new Error('the new song is not in My songs');
  });
  await step('Stage, Learn, Me, plans', async () => {
    await tab('stage'); await p.waitForTimeout(300); await shot('07-stage'); await overflow('Stage');
    await tab('learn'); await p.waitForTimeout(300); await shot('07b-learn'); await overflow('Learn');
    await tab('home'); await p.locator('#act-tools').click(); await p.waitForTimeout(300); await overflow('tools'); await back();
    await tab('me'); await p.waitForTimeout(300); await shot('08-me'); await overflow('Me');
    await p.locator('#me-upsell').click(); await p.waitForSelector('#plan-pro'); await shot('09-plans'); await overflow('plans');
    await p.keyboard.press('Escape');
    await p.locator('#me-settings').click(); await p.waitForTimeout(300); await overflow('settings'); await p.keyboard.press('Escape');
  });
  await ctx.close();
  return errors;
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'app', 'index.html'))) { console.error('Build first: npm run build'); process.exit(2); }
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  let failed = 0;
  for (const mode of process.argv[2] ? [process.argv[2]] : Object.keys(SIZES)) {
    const errors = await run(mode, base, browser);
    console.log(`${mode}: ${errors.length ? `${errors.length} problem(s)\n  ` + errors.join('\n  ') : 'no errors'}`);
    failed += errors.length;
  }
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})();
