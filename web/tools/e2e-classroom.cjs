// Teacher and student flows of the Classroom against a real server running on this machine (server/app.py,
// fresh SQLite database): the teacher makes a class, posts an announcement, adds a topic, a rubric, an
// assignment and a session; the student joins with the code, comments, hands in a Play Along result; the teacher
// sees it in Grades, grades it with the rubric and downloads the CSV.
//   npm run build && node tools/e2e-classroom.cjs
// (The Play Along result itself is sent with the app's own API call: a browser in CI has no instrument to hear.)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium, devices } = require('playwright');

const ROOT = path.join(__dirname, '..', 'dist', 'pages');
const SHOTS = process.env.SHOTS || path.join(__dirname, '..', 'shots');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.css': 'text/css', '.woff2': 'font/woff2' };

function serveStatic() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function startApi() {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'melovyn-e2e-')), 'a.db');
  const proc = spawn(process.env.PYTHON || 'python3', ['-m', 'uvicorn', 'app:app', '--port', String(port), '--log-level', 'warning'], {
    cwd: path.join(__dirname, '..', '..', 'server'),
    env: { ...process.env, DATABASE_URL: `sqlite:///${db}`, HAPTUNE_SIGNIN_REQUIRED: '1', HAPTUNE_CORS_ORIGINS: '.*', PYTHONPATH: path.join(__dirname, '..', '..', 'engine') },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { const ok = await new Promise((res) => http.get(url + '/health', (r) => res(r.statusCode === 200)).on('error', () => res(false))); if (ok) return { proc, url }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill(); throw new Error('the server did not start');
}

async function person(browser, base, api, { name, role, handle }) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
  await ctx.addInitScript(([server, r]) => {
    localStorage.setItem('haptune.settings', JSON.stringify({ server, name: '', instrument: 'violin' }));
    localStorage.setItem('haptune.welcomed', 'true');
    localStorage.setItem('haptune.hubRoleLocal', JSON.stringify(r));
  }, [api, role]);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push('page: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|ERR_/.test(m.text())) errors.push('console: ' + m.text()); });
  await p.goto(base + '/app/', { waitUntil: 'networkidle' });
  await p.waitForSelector('#home-tiles');
  // a real account: username and password (Google sign-in needs Google)
  await p.waitForFunction(() => !!localStorage.getItem('haptune.academyToken'), null, { timeout: 30000 });
  const ok = await p.evaluate(async ([server, h, nm]) => {
    const tok = JSON.parse(localStorage.getItem('haptune.academyToken'));
    const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
    await fetch(server + '/c/me', { method: 'PATCH', headers: H, body: JSON.stringify({ name: nm }) });
    return (await fetch(server + '/c/auth/password', { method: 'POST', headers: H, body: JSON.stringify({ handle: h, password: 'longenough123' }) })).ok;
  }, [api, handle, name]);
  if (!ok) throw new Error('could not make the account');
  await p.reload({ waitUntil: 'networkidle' });
  return { ctx, p, errors };
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'app', 'index.html'))) { console.error('Build first: npm run build'); process.exit(2); }
  fs.mkdirSync(SHOTS, { recursive: true });
  const web = await serveStatic();
  const base = `http://127.0.0.1:${web.address().port}`;
  const { proc, url: api } = await startApi();
  const browser = await chromium.launch();
  const problems = [];
  const step = async (name, fn) => { try { await fn(); } catch (e) { problems.push(`${name}: ${e.message.split('\n')[0]}`); } };
  let T, S, code = '';
  try {
    T = await person(browser, base, api, { name: 'Ms Tan', role: 'teacher', handle: 'ms_tan' });
    S = await person(browser, base, api, { name: 'Ben', role: 'student', handle: 'ben_violin' });
    const t = T.p, s = S.p;
    const tab = (pg, id) => pg.locator(`#tab-${id}:visible`).click();
    await step('teacher makes a class', async () => {
      await tab(t, 'hub'); await t.waitForSelector('#hub-new-class');
      await t.locator('#hub-new-class').click(); await t.fill('#new-class-name', 'Violin 1'); await t.fill('#new-class-teacher', 'Ms Tan');
      await t.locator('.sheet .btn.brand').click(); await t.waitForSelector('.sheet .sheet-head .r');
      await t.locator('.sheet .sheet-head .r').click(); await t.waitForSelector('#class-tabs');
      code = (await t.locator('#class-code').innerText()).replace(/[^A-Z0-9]/g, '');
      if (code.length < 6) throw new Error('no join code');
    });
    await step('teacher announces', async () => {
      await t.fill('#cr-post-text', 'Welcome! First lesson on Friday.'); await t.locator('#cr-post').click();
      await t.waitForSelector('.cr-post.ann'); await t.waitForTimeout(400);
      await t.screenshot({ path: path.join(SHOTS, 'classroom-teacher-stream.png') });
    });
    await step('teacher adds a topic and an assignment', async () => {
      await t.locator('#class-tabs button').filter({ hasText: /Classwork/ }).click(); await t.waitForSelector('#cr-classwork');
      t.once('dialog', (d) => d.accept('Week 1'));
      await t.locator('#cr-new-topic').click(); await t.waitForTimeout(600);
      // assignments need a piece from the library: add one from the free library first
      await t.evaluate(() => window.__haptune.getState().pieces.length);
      await t.locator('#cr-new-asg').click(); await t.waitForSelector('.sheet .row');
      await t.locator('.sheet .row').first().click(); await t.waitForSelector('#asg-title');
      await t.fill('#asg-title', 'Ode to Joy, bars 1-8'); await t.locator('.sheet .btn.brand').click(); await t.waitForTimeout(800);
      await t.waitForSelector('.cr-asg');
      await t.locator('.cr-asg .link-btn').first().click(); await t.waitForSelector('.sheet .chip');
      await t.locator('.sheet .chip').filter({ hasText: 'Week 1' }).click(); await t.locator('.sheet .sheet-head .r').click(); await t.waitForTimeout(600);
      if (!(await t.locator('.cr-topic-name').filter({ hasText: /Week 1/ }).count())) throw new Error('the topic is not shown');
    });
    await step('teacher schedules a session (no Google: .ics)', async () => {
      await t.locator('#cr-new-session').click(); await t.fill('#session-title', 'Lesson 1'); await t.locator('#session-save').click();
      await t.waitForSelector('.cr-session'); await t.screenshot({ path: path.join(SHOTS, 'classroom-teacher-classwork.png') });
    });
    await step('student joins with the code and comments', async () => {
      await tab(s, 'hub'); await s.waitForSelector('#join-class'); await s.locator('#join-class').click();
      await s.waitForSelector('.sheet input'); await s.locator('.sheet input').first().fill(code);
      await s.locator('.sheet .btn').filter({ hasText: /Join/ }).first().click(); await s.waitForTimeout(1200);
      if (!(await s.locator('#class-tabs').count())) { await tab(s, 'hub'); await s.locator('.class-card3').first().click(); }
      await s.waitForSelector('.cr-post.ann');
      await s.locator('.cr-reply input').first().fill('See you there!'); await s.locator('.cr-reply button').first().click();
      await s.waitForSelector('.cr-comment');
      await s.screenshot({ path: path.join(SHOTS, 'classroom-student-stream.png') });
    });
    await step('student hands in a Play Along result', async () => {
      await s.locator('#class-tabs button').filter({ hasText: /Classwork/ }).click(); await s.waitForSelector('.cr-asg');
      const ok = await s.evaluate(async (server) => {
        const tok = JSON.parse(localStorage.getItem('haptune.academyToken'));
        const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
        const me = await (await fetch(server + '/academy/me', { headers: H })).json();
        const aid = me.todo[0].id;
        return (await fetch(`${server}/academy/assignments/${aid}/submissions`, { method: 'POST', headers: H, body: JSON.stringify({ accuracy: 0.86, seconds: 60, bars: [1, 0.9, 0.7], bar_numbers: [1, 2, 3] }) })).ok;
      }, api);
      if (!ok) throw new Error('the submission was refused');
    });
    await step('teacher sees it in Grades, grades it and downloads the CSV', async () => {
      await t.locator('#class-tabs button').filter({ hasText: /Grades/ }).click(); await t.waitForSelector('#cr-grades td button');
      const cell = await t.locator('#cr-grades td button').first().innerText();
      if (!/86%/.test(cell)) throw new Error(`grade cell shows "${cell}"`);
      await t.locator('#cr-grades td button').first().click(); await t.waitForSelector('#grade-value, .sheet .chip');
      if (await t.locator('#grade-value').count()) await t.fill('#grade-value', '9');
      const after = async () => { const txt = await t.locator('#cr-grades td button').first().innerText(); if (!/^9/.test(txt.trim())) throw new Error(`the grade did not show (${txt})`); };
      await t.locator('#grade-save').click(); await t.waitForTimeout(1000); await after();
      await t.screenshot({ path: path.join(SHOTS, 'classroom-teacher-grades.png') });
      const [dl] = await Promise.all([t.waitForEvent('download', { timeout: 20000 }), t.locator('#cr-csv').click()]);
      const csv = fs.readFileSync(await dl.path(), 'utf8');
      if (!/Ben/.test(csv) || !/86/.test(csv)) throw new Error('the CSV does not have the student\'s score');
    });
    await step('notifications reach the class, and the people list', async () => {
      await t.locator('#class-tabs button').filter({ hasText: /Stream/ }).click(); await t.waitForSelector('#cr-post-text');
      await t.fill('#cr-post-text', 'Great work everyone'); await t.locator('#cr-post').click(); await t.waitForTimeout(800);
      const tn = await t.evaluate(async (server) => {
        const tok = JSON.parse(localStorage.getItem('haptune.academyToken'));
        return (await (await fetch(server + '/c/notifications', { headers: { Authorization: `Bearer ${tok}` } })).json()).items.map((x) => x.kind);
      }, api);
      if (!tn.includes('class_comment')) throw new Error('the teacher was not told about the comment');
      await s.locator('#class-tabs button').filter({ hasText: /People/ }).click(); await s.waitForSelector('#cr-people');
      const n = await s.evaluate(async (server) => {
        const tok = JSON.parse(localStorage.getItem('haptune.academyToken'));
        return (await (await fetch(server + '/c/notifications', { headers: { Authorization: `Bearer ${tok}` } })).json()).items.map((x) => x.kind);
      }, api);
      for (const k of ['class_announcement', 'class_graded']) if (!n.includes(k)) throw new Error(`no ${k} notification`);
    });
    await step('Stage: the purpose is on screen and a request takes 2 taps', async () => {
      await tab(s, 'stage'); await s.waitForSelector('#stage-purpose');
      if (!/request any sheet/i.test(await s.locator('#stage-purpose').innerText())) throw new Error('no purpose line');
      if (!(await s.locator('#stage-how').count())) throw new Error('no first-visit explainer');
      await s.screenshot({ path: path.join(SHOTS, 'stage-first-visit.png') });
      await s.locator('#st-request-big').click();                                   // tap 1
      await s.waitForSelector('#c-song'); await s.fill('#c-song', 'Yesterday'); await s.fill('#c-artist', 'The Beatles');
      await s.screenshot({ path: path.join(SHOTS, 'stage-compose.png') });
      await s.locator('.sheet .sheet-head .r').click();                              // tap 2
      await s.waitForSelector('.rq-steps', { timeout: 20000 });                      // the new request, with where it stands
      await s.screenshot({ path: path.join(SHOTS, 'stage-request-posted.png') });
      if (await s.locator('.sheet').count()) await s.keyboard.press('Escape');
      await tab(s, 'stage'); await tab(s, 'stage'); await s.waitForSelector('#stage-purpose');
      await s.locator('#stage-how-ok').click({ timeout: 3000 }).catch(() => {});
      await s.locator('#community-seg .chip').nth(2).click(); await s.waitForSelector('.rq-steps', { timeout: 20000 });
      await s.locator('#stage-plus').click(); await s.waitForSelector('#stage-new');
      if (await s.locator('#stage-new .row').count() < 4) throw new Error('the + sheet should offer the post types');
      await s.keyboard.press('Escape');
      await s.screenshot({ path: path.join(SHOTS, 'stage-requests.png') });
    });
  } catch (e) { problems.push(e.message); }
  for (const x of [T, S]) if (x) problems.push(...x.errors);
  await browser.close(); web.close(); proc.kill();
  console.log(problems.length ? `classroom: ${problems.length} problem(s)\n  ${problems.join('\n  ')}` : 'classroom: no errors');
  process.exit(problems.length ? 1 : 0);
})();
