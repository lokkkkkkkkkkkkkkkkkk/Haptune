// Before / after screenshots for a pull request: Home, a Learn class page, the Stage feed and the Create
// studio, on a phone and a computer, with the same data in each build.
//   node tools/compare-shots.cjs <dist/pages> <server dir> <out dir> <label>
// It starts the server on a fresh database, makes a teacher and a student, a class with an announcement and an
// assignment, two Stage posts, then opens each screen in the build given and saves <label>-<screen>-<size>.png.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium, devices } = require('playwright');

const [ROOT, SERVER, OUT, LABEL] = process.argv.slice(2).map((x, i) => (i < 3 ? path.resolve(x) : x));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const SIZES = { phone: devices['iPhone 13'], pc: { viewport: { width: 1366, height: 860 } } };

function serve() {
  const s = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

async function startApi() {
  const port = 21000 + Math.floor(Math.random() * 2000);
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'melovyn-shots-')), 'a.db');
  const proc = spawn(process.env.PYTHON || 'python3', ['-m', 'uvicorn', 'app:app', '--port', String(port), '--log-level', 'warning'], {
    cwd: SERVER, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, DATABASE_URL: `sqlite:///${db}`, HAPTUNE_SIGNIN_REQUIRED: '1', HAPTUNE_CORS_ORIGINS: '.*', PYTHONPATH: path.join(SERVER, '..', 'engine') },
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((r) => http.get(url + '/health', (x) => r(x.statusCode === 200)).on('error', () => r(false)));
    if (ok) return { proc, url };
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill(); throw new Error('the server did not start');
}

async function api(url, pathName, { token, method = 'GET', body } = {}) {
  const r = await fetch(url + pathName, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
}

async function person(url, name, handle) {
  const g = await api(url, '/c/auth/guest', { method: 'POST', body: { name } });
  await api(url, '/c/auth/password', { token: g.token, method: 'POST', body: { handle, password: 'longenough123' } });
  return g.token;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const web = await serve();
  const base = `http://127.0.0.1:${web.address().port}`;
  const { proc, url } = await startApi();
  try {
    const teacher = await person(url, 'Ms Tan', 'ms_tan');
    const student = await person(url, 'Ben', 'ben_violin');
    const made = await api(url, '/academy/classes', { token: teacher, method: 'POST', body: { name: 'Violin 1', description: 'Thursday group' } });
    const cls = made.class || made;
    await api(url, '/academy/join', { token: student, method: 'POST', body: { code: cls.join_code } });
    await api(url, `/academy/classes/${cls.id}/stream`, { token: teacher, method: 'POST', body: { text: 'Welcome! First lesson on Friday. Bring your rosin.' } });
    const due = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 19);
    await api(url, `/academy/classes/${cls.id}/assignments`, { token: teacher, method: 'POST', body: { title: 'Ode to Joy, bars 1–8', piece_title: 'Ode to Joy', due_at: due } });
    await api(url, '/c/posts', { token: teacher, method: 'POST', body: { type: 'request', title: 'Yesterday', song: 'Yesterday', artist: 'The Beatles', instruments: ['violin'] } });
    await api(url, '/c/posts', { token: student, method: 'POST', body: { type: 'question', title: 'How do I keep my bow straight?', body: 'It slides towards the fingerboard.' } });
    const browser = await chromium.launch();
    for (const [size, dev] of Object.entries(SIZES)) {
      const ctx = await browser.newContext({ ...dev });
      await ctx.addInitScript(([server, tok]) => {
        localStorage.setItem('haptune.settings', JSON.stringify({ server, name: 'Ben', instrument: 'violin' }));
        localStorage.setItem('haptune.welcomed', 'true');
        localStorage.setItem('haptune.stageExplained', 'true');
        localStorage.setItem('haptune.hubRoleLocal', JSON.stringify('student'));
        localStorage.setItem('haptune.academyToken', JSON.stringify(tok));
      }, [url, student]);
      const p = await ctx.newPage();
      await p.goto(base + '/app/', { waitUntil: 'networkidle' });
      await p.waitForTimeout(3500);
      const shot = async (name) => { await p.waitForTimeout(1800); await p.screenshot({ path: path.join(OUT, `${LABEL}-${name}-${size}.png`) }); };
      await shot('home');
      await p.evaluate((cid) => { window.__haptune.go('academy'); window.__haptune.push('classView', { id: cid }, 'academy'); }, cls.id);
      await shot('learn-class');
      const prog = p.locator('#class-tabs button').filter({ hasText: /^Progress$/ });
      if (await prog.count()) { await prog.click(); await shot('learn-progress'); }
      await p.evaluate(() => window.__haptune.go('community'));
      await shot('stage');
      await p.evaluate(() => {
        const pc = window.__haptune.getState().pieces.find((x) => x.kind === 'score' && /ode/i.test(x.title)) || window.__haptune.getState().pieces.find((x) => x.kind === 'score');
        window.__haptune.go('write'); window.__haptune.push('studio', { id: pc.id }, 'write');
      });
      await p.waitForSelector('.st-score svg', { timeout: 30000 }).catch(() => {});
      await shot('create-studio');
      await ctx.close();
    }
    await browser.close();
    console.log(`${LABEL}: screenshots in ${OUT}`);
  } finally {
    proc.kill(); web.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
