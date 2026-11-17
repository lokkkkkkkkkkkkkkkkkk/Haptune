// Colour contrast (axe-core, WCAG AA) on the main screens of the built app at phone size, in light and in dark.
//   npm run build && npm run contrast        fails when any text is below 4.5:1 (3:1 for large text)
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium, devices } = require('playwright');
const ROOT = path.join(__dirname, '..', 'dist', 'pages');
const SHOTS = process.env.SHOTS || path.join(__dirname, '..', 'shots');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
let problems = 0;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    const ctx = await b.newContext({ ...devices['iPhone 13'], colorScheme: scheme });
    await ctx.addInitScript(() => { localStorage.setItem('haptune.welcomed', 'true'); localStorage.setItem('haptune.settings', JSON.stringify({ name: 'Ana', instrument: 'violin' })); });
    const p = await ctx.newPage();
    await p.goto(base + '/app/', { waitUntil: 'networkidle' }); await p.waitForSelector('#home-hero'); await p.waitForTimeout(2500);
    const screens = [['home', null], ['find', () => window.__haptune.push('find', {})], ['library', () => window.__haptune.go('library')], ['create', () => window.__haptune.go('write')],
      ['studio', () => { const pc = window.__haptune.getState().pieces.find((x) => x.kind === 'score'); window.__haptune.go('write'); window.__haptune.push('studio', { id: pc.id }, 'write'); }]];
    for (const [name, fn] of screens) {
      if (fn) { await p.evaluate(fn); await p.waitForTimeout(1500); }
      await p.addScriptTag({ content: AXE });
      const r = await p.evaluate(async () => (await window.axe.run(document.querySelector('.tab-pane:not([hidden]) .view:not([hidden])') || document, { runOnly: ['color-contrast'] })).violations);
      const nodes = r.flatMap((v) => v.nodes.map((n) => `${n.target.join(' ')} :: ${(n.any[0]?.message || '').replace(/\s+/g, ' ').slice(0, 120)}`));
      problems += nodes.length;
      console.log(`${scheme} ${name}: ${nodes.length} contrast problem(s)`);
      for (const x of nodes.slice(0, 6)) console.log('   ', x);
      fs.mkdirSync(SHOTS, { recursive: true });
      await p.screenshot({ path: path.join(SHOTS, `${scheme}-${name}.png`) });
    }
    await ctx.close();
  }
  await b.close(); server.close();
  process.exit(problems ? 1 : 0);
});
