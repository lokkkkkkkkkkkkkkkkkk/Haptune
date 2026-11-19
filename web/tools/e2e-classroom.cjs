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
    env: { ...process.env, DATABASE_URL: `sqlite:///${db}`, HAPTUNE_SIGNIN_REQUIRED: '1', HAPTUNE_CORS_ORIGINS: '.*', HAPTUNE_OWNER_EMAILS: 'owner@e2e.test', PYTHONPATH: path.join(__dirname, '..', '..', 'engine') },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { const ok = await new Promise((res) => http.get(url + '/health', (r) => res(r.statusCode === 200)).on('error', () => res(false))); if (ok) return { proc, url, db }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill(); throw new Error('the server did not start');
}

async function person(browser, base, api, { name, role, handle }) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true, permissions: ['microphone'] });
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
  await p.waitForSelector('#home-hero');
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
  const { proc, url: api, db } = await startApi();
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const problems = [];
  const step = async (name, fn) => { try { await fn(); } catch (e) { problems.push(`${name}: ${e.message.split('\n')[0]}`); for (const [k, x] of [['t', T], ['s', S]]) await x?.p.screenshot({ path: path.join(SHOTS, `fail-${k}-${name.slice(0, 12).replace(/\W/g, '')}.png`) }).catch(() => {}); } };
  let T, S, code = '', requestId = '';
  try {
    T = await person(browser, base, api, { name: 'Ms Tan', role: 'teacher', handle: 'ms_tan' });
    S = await person(browser, base, api, { name: 'Ben', role: 'student', handle: 'ben_violin' });
    const t = T.p, s = S.p;
    // Escape, then wait until the sheet is really gone (on a slow machine a click right after can hit its backdrop)
    const esc = async (pg) => { for (let i = 0; i < 3 && await pg.locator('.sheet-bg').count(); i++) { await pg.keyboard.press('Escape'); await pg.waitForSelector('.sheet-bg', { state: 'detached', timeout: 3000 }).catch(() => {}); } };
    const tab = async (pg, id) => { await esc(pg); await pg.locator(`#tab-${id}:visible`).click(); };
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
    await step('Home: the Learn band and the class shelf (student), takes to review (teacher)', async () => {
      for (const [pg, who] of [[s, 'student'], [t, 'teacher']]) {
        await tab(pg, 'summaryTab'); await pg.evaluate(() => window.__haptune.popToRoot('summary'));
        await pg.waitForSelector('#home-band');
        if (who === 'teacher') await pg.waitForFunction(() => /to review/i.test(document.querySelector('#band-learn')?.innerText || ''), null, { timeout: 15000 });
        else await pg.waitForSelector('#shelf-class .shelf-item', { timeout: 15000 });
        const band = await pg.locator('#band-learn').innerText();
        if (who === 'teacher' && !/1 takes? to review/i.test(band)) throw new Error(`the teacher's band does not count the take to review: ${band}`);
        if (who === 'student' && !(await pg.locator('#shelf-class .shelf-item').count())) throw new Error('the student has no "Pieces your class is playing" shelf');
        await pg.screenshot({ path: path.join(SHOTS, `home-${who}.png`), fullPage: false });
        await pg.evaluate(() => document.querySelector('#home').scrollTo(0, 99999)); await pg.waitForTimeout(300);
        await pg.screenshot({ path: path.join(SHOTS, `home-${who}-lower.png`) });
        await pg.evaluate(() => document.querySelector('#home').scrollTo(0, 0));
      }
      await s.locator('#band-learn').click(); await s.waitForSelector('#class-tabs:visible', { timeout: 10000 });
      await tab(t, 'hub'); await t.waitForSelector('#class-tabs:visible');
    });
    await step('teacher sees it in Grades, grades it and downloads the CSV', async () => {
      await t.locator('#class-tabs button').filter({ hasText: /Progress/ }).click(); await t.waitForSelector('#cr-grades td button');
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
    await step('Learn: a theory question turned in, a private comment, the path, the teacher glance, roster, parents and their page, Drive', async () => {
      const api2 = async (pg, pathname, method = 'GET', body) => pg.evaluate(async ([server, p, m, b]) => {
        const tok = JSON.parse(localStorage.getItem('haptune.academyToken'));
        const r = await fetch(server + p, { method: m, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
        return r.json();
      }, [api, pathname, method, body]);
      const cid = (await api2(t, '/academy/me')).classes[0].id;
      const due = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 19);
      const made = await api2(t, `/academy/classes/${cid}/assignments`, 'POST', { title: 'Name the key', piece_title: '', due_at: due });
      const qid = made.id || made.assignment?.id;
      await api2(t, `/academy/assignments/${qid}/meta`, 'PUT', { kind: 'theory', prompt: 'Which key is Ode to Joy in?' });
      // the student: My work, then the question
      await esc(s); await tab(s, 'hub'); await s.evaluate(() => window.__haptune.popToRoot('academy'));
      await s.waitForSelector('#my-work #work-tabs', { timeout: 15000 });
      await s.locator('#my-work .mission').filter({ hasText: 'Name the key' }).click();
      await s.waitForSelector('#turn-in .ti-prompt'); await s.fill('#ti-text', 'D major');
      await s.locator('#ti-send').click(); await s.waitForSelector('.ti-answer', { timeout: 10000 });
      await s.fill('#pt-text', 'Is it D or A?'); await s.locator('#pt-send').click(); await s.waitForSelector('.pt-msg.mine');
      await s.screenshot({ path: path.join(SHOTS, 'learn-turned-in.png') });
      await s.locator('.navbar .back:visible').first().click();
      await s.locator('#work-tabs button').filter({ hasText: /Done/ }).click();
      if (!(await s.locator('#my-work .mission').filter({ hasText: 'Name the key' }).count())) throw new Error('the turned-in question is not under Done');
      await s.screenshot({ path: path.join(SHOTS, 'learn-my-work.png') });
      // the class page: Progress shows the path
      await s.locator('.class-card3').first().click(); await s.waitForSelector('#class-tabs:visible');
      await s.locator('#class-tabs button').filter({ hasText: /Progress/ }).click(); await s.waitForSelector('#class-path .path-step.done');
      await s.screenshot({ path: path.join(SHOTS, 'learn-path.png') });
      // the teacher: glance, the private comment, roster, parents, Drive
      await esc(t); await tab(t, 'hub'); await t.evaluate(() => window.__haptune.popToRoot('academy'));
      await t.waitForSelector('#teacher-glance .glance', { timeout: 15000 });
      const th = await api2(t, `/academy/assignments/${qid}/private?student=${(await api2(s, '/academy/me')).user.id}`);
      if (!th.items?.length) throw new Error('the teacher cannot see the private comment');
      await t.locator('.class-card3').first().click(); await t.waitForSelector('#class-tabs:visible');
      await t.locator('#class-tabs button').filter({ hasText: /Classwork/ }).click(); await t.waitForSelector('#class-drive');
      t.once('dialog', (d) => d.accept('https://drive.google.com/drive/folders/e2eFolder'));
      await t.locator('#drive-set').click(); await t.waitForSelector('#drive-open', { timeout: 10000 });
      await t.locator('#class-tabs button').filter({ hasText: /People/ }).click(); await t.waitForSelector('#people-tools');
      await t.locator('#roster-open').click(); await t.fill('#roster-text', 'Aisha Rahman, aisha@school.test\nWei Lim, wei@school.test');
      await t.locator('#roster-send').click(); await t.waitForSelector('#roster-done');
      await t.screenshot({ path: path.join(SHOTS, 'learn-roster.png') }); await esc(t);
      await t.locator('#cr-people .row').filter({ hasText: 'Ben' }).locator('.link-btn').filter({ hasText: /Parents/ }).click();
      await t.fill('#g-email', 'ben.mum@family.test'); await t.locator('#g-add').click(); await t.waitForSelector('.sheet .row3');
      await esc(t);
      await t.locator('#send-summaries').click(); await t.waitForTimeout(800);
      const g = (await api2(s, '/academy/me/guardians')).items[0];
      if (!g) throw new Error('the parent was not added');
      // the parent opens the link: no account
      const pctx = await browser.newContext({ ...devices['iPhone 13'] });
      await pctx.addInitScript((server) => { localStorage.setItem('haptune.settings', JSON.stringify({ server })); localStorage.setItem('haptune.welcomed', 'true'); }, api);
      const pg = await pctx.newPage();
      await pg.goto(base + '/app/' + g.link.slice(g.link.indexOf('#')), { waitUntil: 'networkidle' });
      await pg.waitForSelector('#guardian-page .class-hero', { timeout: 20000 });
      if (!/Ben/.test(await pg.locator('#guardian-page').innerText())) throw new Error('the parent page does not show the student');
      await pg.screenshot({ path: path.join(SHOTS, 'learn-parent-page.png') });
      await pctx.close();
      await tab(t, 'hub'); await t.locator('.class-card3').first().click(); await t.waitForSelector('#class-tabs:visible');
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
      await s.waitForSelector('#post-next #nx-copyLink');                            // ...and what next
      await s.screenshot({ path: path.join(SHOTS, 'stage-request-posted.png') });
      requestId = await s.evaluate(() => { const st = window.__haptune.getState().stacks.community; return st[st.length - 1]?.props?.id; });
      await esc(s);
      await tab(s, 'stage'); await tab(s, 'stage'); await s.waitForSelector('#stage-purpose');
      await s.locator('#stage-how-ok').click({ timeout: 3000 }).catch(() => {});
      await s.locator('#community-seg .chip').filter({ hasText: /^Requests$/ }).click(); await s.waitForSelector('.rq-steps', { timeout: 20000 });
      await s.locator('#stage-plus').click(); await s.waitForSelector('#stage-new');
      if (await s.locator('#stage-new .row').count() < 4) throw new Error('the + sheet should offer the post types');
      await esc(s);
      await s.screenshot({ path: path.join(SHOTS, 'stage-requests.png') });
    });
    await step('Golden path: one search finds the class and the person; links open the assignment, a Stage post and a piece in Play Along', async () => {
      const go = async (pg, hash) => { await esc(pg); await pg.evaluate((h) => { location.hash = h; }, hash); await pg.waitForTimeout(600); };
      // one search: classes and people with type chips
      await esc(s); await tab(s, 'summaryTab'); await s.evaluate(() => window.__haptune.popToRoot('summary'));
      await s.locator('#hero-find').click(); await s.waitForSelector('#find-q');
      await s.fill('#find-q', 'violin'); await s.waitForSelector('#ft-classes', { timeout: 15000 });
      await s.locator('#ft-classes').click(); await s.waitForSelector('#find-classes-first');
      if (await s.locator('#find-free').count()) throw new Error('the Classes chip still shows pieces');
      await s.screenshot({ path: path.join(SHOTS, 'golden-search-classes.png') });
      await s.locator('#find-classes-first').click(); await s.waitForSelector('#class-tabs:visible', { timeout: 10000 });
      await tab(s, 'summaryTab'); await s.waitForSelector('#find-q:visible');
      await s.fill('#find-q', 'ms tan'); await s.waitForSelector('#find-people-first', { timeout: 15000 });
      // the assignment link a teacher shares
      const asg = await s.evaluate(async (server) => {
        const tok = JSON.parse(localStorage.getItem('haptune.academyToken'));
        const H = { headers: { Authorization: `Bearer ${tok}` } };
        const me = await (await fetch(server + '/academy/me', H)).json();
        const cid = me.classes?.[0]?.id;
        const cl = cid && await (await fetch(`${server}/academy/classes/${cid}`, H)).json();
        const a = cl?.assignments?.[0];
        return a ? { id: a.id, cid } : null;
      }, api);
      if (!asg) throw new Error('no assignment to link to');
      await go(s, `#class/${asg.cid}/assignment/${asg.id}`);
      await s.waitForSelector('#asg-view:visible', { timeout: 15000 });
      if (!/Ode to Joy/.test(await s.locator('#asg-view:visible').innerText())) throw new Error('the assignment link opened the wrong assignment');
      // a Stage post link, opened by someone else
      if (!requestId) throw new Error('no request id from the Stage step');
      await go(t, `#stage/post/${requestId}`);
      await t.waitForSelector('.rq-steps', { timeout: 15000 });
      if (!/Yesterday/.test(await t.locator('.post-view').innerText())) throw new Error('the post link opened the wrong post');
      // a free-library piece, straight into Play Along, on a device that never had it
      const entry = await t.evaluate(async () => (await (await fetch('catalog/index.json')).json()).items.find((r) => /mutopia/.test(r[0]))?.[0]);
      await go(t, `#piece/${entry}/practise`);
      await t.waitForSelector('.mode-cards, .sheet .mode-card', { timeout: 60000 });
      await t.screenshot({ path: path.join(SHOTS, 'golden-piece-practise.png') });
      await esc(t); await t.locator('.navbar .back:visible, .back-btn:visible').first().click().catch(() => {});
      await esc(t); await tab(t, 'hub');
    });
    await step('Friends: a request accepted, messages both ways, a beat-my-score challenge opened in Play Along', async () => {
      const go = async (pg, hash) => { await esc(pg); await pg.evaluate((h) => { location.hash = h; }, hash); await pg.waitForTimeout(500); };
      await go(s, '#u/ms_tan'); await s.waitForSelector('#friend-add', { timeout: 15000 });
      await s.locator('#friend-add').click(); await s.waitForSelector('#friend-state');
      await esc(t); await tab(t, 'stage'); await t.evaluate(() => window.__haptune.push('friends', {}, 'community'));
      await t.waitForSelector('#accept-ben_violin', { timeout: 15000 }); await t.locator('#accept-ben_violin').click();
      await t.waitForSelector('#friend-list');
      await t.screenshot({ path: path.join(SHOTS, 'friends-list.png') });
      await go(t, '#u/ben_violin'); await t.waitForSelector('#friend-message'); await t.locator('#friend-message').click();
      await t.waitForSelector('#chat-text'); await t.fill('#chat-text', 'Great job today!'); await t.locator('#chat-send').click();
      await t.waitForSelector('.chat-list .pt-msg.mine');
      await esc(s); await tab(s, 'stage'); await s.locator('#stage-messages').click(); await s.waitForSelector('#messages .row');
      await s.locator('#messages .row').first().click(); await s.waitForSelector('.chat-list .pt-msg');
      if (!/Great job today/.test(await s.locator('.chat-list').innerText())) throw new Error('the message did not arrive');
      await s.fill('#chat-text', 'Thank you!'); await s.locator('#chat-send').click(); await s.waitForSelector('.chat-list .pt-msg.mine');
      await s.screenshot({ path: path.join(SHOTS, 'friends-chat.png') });
      // Ms Tan challenges Ben on a free-library piece; Ben opens it from Stage > Challenges straight into Play Along
      const entry = await t.evaluate(async () => (await (await fetch('catalog/index.json')).json()).items.find((r) => /^ryans-/.test(r[0]))?.[0]);
      const duel = await t.evaluate(async ([server, cat]) => {
        const tok = JSON.parse(localStorage.getItem('haptune.academyToken'));
        const r = await fetch(server + '/c/duels', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'ben_violin', piece_title: 'A reel', catalog_id: cat, score: 0.8 }) });
        return r.json();
      }, [api, entry]);
      if (!duel.id) throw new Error('the challenge was not made: ' + JSON.stringify(duel));
      await s.locator('.navbar .back:visible').first().click(); await s.locator('.navbar .back:visible').first().click().catch(() => {});
      await tab(s, 'stage'); await s.evaluate(() => window.__haptune.popToRoot('community'));
      await s.locator('#community-seg .chip').filter({ hasText: /^Challenges$/ }).click(); await s.waitForSelector(`#duel-row-${duel.id}`, { timeout: 15000 });
      await s.screenshot({ path: path.join(SHOTS, 'stage-challenges.png') });
      await s.locator(`#duel-row-${duel.id}`).click(); await s.waitForSelector('#duel-play');
      await s.locator('#duel-play').click(); await s.waitForSelector('.mode-cards, .sheet .mode-card', { timeout: 60000 });
      await esc(s); await s.evaluate(() => { for (const k of ['library', 'community']) window.__haptune.popToRoot(k); });
      await tab(s, 'hub');
    });
    await step('Sign-in ways: the username is listed and cannot be removed; Google permissions explain themselves', async () => {
      await esc(t); await t.evaluate(() => window.__haptune.openSheet('connections'));
      await t.waitForSelector('#signin-methods #signin-password', { timeout: 15000 });
      const txt = await t.locator('#signin-password').innerText();
      if (!/@ms_tan/.test(txt)) throw new Error('the username sign-in is not listed: ' + txt);
      if (await t.locator('#signin-methods button').filter({ hasText: /Remove/ }).count()) throw new Error('the only way to sign in can be removed');
      if (await t.locator('#apple-btn').count()) throw new Error('Apple shows although it is not set up');
      await t.screenshot({ path: path.join(SHOTS, 'signin-ways.png') });
      // signed in without Google: Google features say to sign in with Google first (no dead "Connect" buttons)
      if (!(await t.locator('#conn-need-google').count()) && !/aren.t set up|not switched on/i.test(await t.locator('.sheet').innerText())) throw new Error('Connections should ask for Google sign-in first (or say Google is not set up)');
      if (await t.locator('.sheet button').filter({ hasText: /^Connect$/ }).count()) throw new Error('a "Connect" button shows without Google');
      await esc(t);
    });
    await step('Account: who is signed in, Switch account and Sign out; "Why can\'t I open Developer mode?" answers', async () => {
      await esc(s); await s.evaluate(() => window.__haptune.openSheet('account'));
      await s.waitForSelector('#acct-who', { timeout: 15000 });
      const who = await s.locator('#acct-who').innerText();
      if (!/@ben_violin/.test(who)) throw new Error('the account card does not say who is signed in: ' + who);
      for (const id of ['#acc-switch', '#acc-signout']) if (!(await s.locator(id).count())) throw new Error(`${id} is missing`);
      if (await s.locator('#acc-signin').count()) throw new Error('a signed-in account is offered "Sign in" again');
      await s.locator('#acc-devwhy').click(); await s.waitForSelector('#dev-why');
      const why = await s.locator('#dev-why').innerText();
      if (!/without Google/i.test(why)) throw new Error('the Developer mode answer is wrong: ' + why);
      await s.screenshot({ path: path.join(SHOTS, 'account-signed-in.png') });
      await esc(s);
    });
    await step('Hapi: ask from the sparkle button, get an answer with buttons, tap one', async () => {
      // the model is mocked here (no API key in tests); the server side is tested in server/test_aichat.py
      let sent = null;
      await s.route('**/ai/chat', async (route) => {
        sent = JSON.parse(route.request().postData());
        await route.fulfill({ json: { text: 'Check your microphone first, then play it slowly.', actions: [{ type: 'open_screen', label: 'Sound check', screen: 'soundCheck' }, { type: 'open_screen', label: 'Stage', screen: 'stage' }] } });
      });
      await tab(s, 'summaryTab'); await s.waitForSelector('#ai-fab');
      await s.locator('#ai-fab').click();
      await s.waitForSelector('#ai-chat .chip'); await s.locator('#ai-chat .chip').first().click();
      await s.waitForSelector('#ai-act-0');
      await s.screenshot({ path: path.join(SHOTS, 'ai-chat.png') });
      if (!sent || sent.messages.at(-1).role !== 'user' || !Array.isArray(sent.context.library) || !sent.lang) throw new Error('bad request: ' + JSON.stringify(sent));
      await s.locator('#ai-act-0').click(); await s.waitForSelector('#ai-act-0', { state: 'detached' });
      await s.waitForSelector('#sound-check #sc-run', { timeout: 10000 });
      await s.unroute('**/ai/chat');
      await tab(s, 'stage'); await s.waitForSelector('#stage-plus');                         // the tab bar still works after
      if (await s.evaluate(() => innerWidth) > 400) throw new Error('the page got wider than the phone');
    });
    await step('A crash stays on its screen: back still works', async () => {
      await s.evaluate(() => globalThis.__haptune.push('__crash'));
      await s.waitForSelector('#crash-__crash');
      await s.locator('#crash-__crash .btn.secondary').click(); await s.waitForSelector('#crash-__crash', { state: 'detached' });
      await tab(s, 'stage'); await s.waitForSelector('#stage-plus');
    });
    await step('Free library: a Mutopia guitar piece (MIDI) and an OpenScore quartet open and draw', async () => {
      for (const q of ['Andantino No. 2 Sor', 'Quartettsatz']) {
        if (await s.locator('#tab-library:visible').count()) await tab(s, 'library');
        await s.evaluate(() => globalThis.__haptune.push('catalog', {}, 'library'));
        await s.waitForSelector('#cat-search:visible'); await s.fill('#cat-search:visible', q);
        await s.locator('.row:visible').filter({ hasText: q.split(' ')[0] }).first().click();
        await s.waitForSelector('.vrv-page svg', { timeout: 60000 });
        if (q.startsWith('Andantino')) await s.screenshot({ path: path.join(SHOTS, 'library-mutopia.png') });
        await s.locator('.navbar .back:visible').first().click();        // the piece hides the tab bar
        await s.waitForSelector('.vrv-page svg', { state: 'hidden' });
      }
      await tab(s, 'library'); await s.evaluate(() => globalThis.__haptune.push('catalog', {}, 'library'));
      await s.locator('#cat-sources:visible summary').click();
      if ((await s.locator('#cat-sources:visible li').count()) < 5) throw new Error('the list of collections is short');
    });
    await step('Owner: Developer mode with 2-step verification, grant one scope, the developer sees only that, revoke', async () => {
      const crypto = require('crypto');
      const totp = (secret, offset = 0) => {
        const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let bits = ''; for (const ch of secret.replace(/\s/g, '')) bits += alpha.indexOf(ch).toString(2).padStart(5, '0');
        const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
        const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
        const h = crypto.createHmac('sha1', key).update(ctr).digest(); const o = h[h.length - 1] & 15;
        return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
      };
      // Ms Tan's account becomes the owner: Google-verified email listed in HAPTUNE_OWNER_EMAILS (set on the server)
      require('child_process').execFileSync(process.env.PYTHON || 'python3', ['-c',
        `import sqlite3;c=sqlite3.connect(${JSON.stringify(db)});c.execute("update accounts set google_sub='g-owner', email='owner@e2e.test' where handle='ms_tan'");c.commit()`]);
      const tokOf = (pg) => pg.evaluate(() => JSON.parse(localStorage.getItem('haptune.academyToken')));
      const apiGet = async (pg, p2) => pg.evaluate(async ([server, tk, pth]) => { const r = await fetch(server + pth, { headers: { Authorization: `Bearer ${tk}` } }); return { status: r.status, body: await r.json().catch(() => null) }; }, [api, await tokOf(pg), p2]);
      const devModeOn = async (pg) => {
        await pg.reload({ waitUntil: 'networkidle' });
        await pg.evaluate(() => globalThis.__haptune.go('me')); await pg.waitForSelector('#me-devmode', { state: 'attached', timeout: 15000 });
        await pg.locator('label[for=me-devmode]').first().click();
        await pg.locator('#dm-setup').click(); await pg.locator('#ts-begin').click();
        const secret = (await pg.locator('#ts-secret').innerText()).replace(/\s/g, '');
        await pg.fill('#ts-code', totp(secret)); await pg.locator('#ts-enable').click();
        await pg.waitForSelector('#ts-recovery'); await pg.locator('.sheet .sheet-head .r').click();
        await pg.waitForSelector('#dm-code'); await pg.fill('#dm-code', totp(secret, 1));
        const t0 = Date.now(); await pg.locator('#dm-on').click();
        await pg.waitForSelector('#dashboard');
        return Date.now() - t0;
      };
      // the owner switches on Developer mode: the dashboard opens
      await devModeOn(t);
      const t1 = Date.now(); await t.waitForSelector('#dash-overview #st-dau'); const loadMs = Date.now() - t1;
      console.log(`  dashboard overview shown ${loadMs} ms after Developer mode`);
      if (loadMs > 1500) throw new Error(`the dashboard took ${loadMs} ms`);
      await t.screenshot({ path: path.join(SHOTS, 'dash-overview.png') });
      // Brand: the owner sees the name, the icon previews, and what to set up for saving
      await t.locator('#dash-tab-brand').click(); await t.waitForSelector('#brand-panel #brand-preview');
      if (await t.inputValue('#brand-name') !== 'Melovyn') throw new Error('the brand name is not shown');
      if (!(await t.locator('#brand-setup').count())) throw new Error('without GitHub settings the Brand page should say what to set');
      if (!(await t.locator('#brand-save').isDisabled())) throw new Error('Save should wait for the GitHub settings');
      await t.screenshot({ path: path.join(SHOTS, 'dash-brand.png') });
      // Users > Ben > give developer access with one scope
      await t.locator('#dash-tab-users').click(); await t.waitForSelector('#u-ben_violin');
      await t.screenshot({ path: path.join(SHOTS, 'dash-users.png') });
      await t.locator('#u-ben_violin').click(); await t.waitForSelector('#admin-user #au-timeline');
      await t.locator('#au-access').click(); await t.waitForSelector('#grant-form');
      if (await t.inputValue('#grant-handle') !== 'ben_violin') throw new Error('the grant form is not filled in');
      await t.fill('#grant-reason', 'Helps with the numbers'); await t.locator('#grant-go').click();
      await t.waitForSelector('#acc-ben_violin');
      // Ben: Developer mode shows only the read-analytics tabs
      await devModeOn(s);
      await s.waitForSelector('#dash-tab-overview');
      for (const k of ['users', 'access', 'audit', 'features', 'payments', 'brand']) if (await s.locator(`#dash-tab-${k}`).count()) throw new Error(`the developer sees ${k}`);
      if ((await apiGet(s, '/c/admin/users')).status !== 403) throw new Error('scope not enforced');
      await s.screenshot({ path: path.join(SHOTS, 'dash-developer.png') });
      // the owner revokes: Ben's next call is refused
      await t.locator('#revoke-ben_violin').click(); await t.waitForSelector('#acc-ben_violin', { state: 'detached' });
      if ((await apiGet(s, '/c/admin/analytics/overview')).status !== 403) throw new Error('revoked access still works');
      await s.reload({ waitUntil: 'networkidle' }); await s.evaluate(() => globalThis.__haptune.go('me')); await s.waitForTimeout(800);
      if (await s.locator('#me-devmode').count()) throw new Error('the switch is still there');
      // every step is in the audit log
      const audit = (await apiGet(t, '/c/admin/audit?limit=200')).body.items.map((x) => x.action);
      for (const a of ['2fa_on', 'dev_mode_on', 'viewed_user', 'grant_developer', 'revoke_developer']) if (!audit.includes(a)) throw new Error(`no audit entry for ${a}: ${audit}`);
      // back to a normal account
      await t.evaluate(() => { globalThis.__haptune.popToRoot('me'); globalThis.__haptune.go('me'); }); await t.waitForSelector('#me-devmode', { state: 'attached' });
      await t.locator('label[for=me-devmode]:visible').first().click(); await t.waitForFunction(() => !globalThis.__haptune.getState().me?.staff?.dev_mode);
    });
    let soundId = '';
    await step('Sounds: record, add backing, mix, export WAV (60 s, 4 tracks), post to Stage', async () => {
      await tab(s, 'stage'); await tab(s, 'stage'); await s.locator('#stage-plus').click(); await s.locator('#stn-sound').click();
      await s.waitForSelector('#sd-rec');
      // 60 seconds: 32 bars of 4/4 at 128
      await s.locator('#sd-settings').click(); await s.waitForSelector('.sheet input[type=range]');
      await s.locator('.sheet input[type=range]').first().evaluate((el) => { el.value = '128'; el.dispatchEvent(new Event('change', { bubbles: true })); });
      await s.locator('.sheet .chip').filter({ hasText: /^32$/ }).click(); await esc(s);
      await s.locator('#sd-rec').click(); await s.waitForTimeout(3500); await s.locator('#sd-rec').click();      // record with the microphone
      await s.waitForSelector('.sd-track', { timeout: 15000 });
      for (let i = 0; i < 2; i++) { await s.locator('#sd-add').click(); await s.locator('#sd-add-backing').click(); await s.locator('#sd-add-quick').click(); await s.waitForTimeout(300); }
      await s.locator('#sd-add').click(); await s.locator('#sd-add-inst').click(); await s.waitForTimeout(300);
      if ((await s.locator('.sd-track').count()) !== 4) throw new Error(`expected 4 tracks, got ${await s.locator('.sd-track').count()}`);
      await s.screenshot({ path: path.join(SHOTS, 'sound-mixer.png') });
      await s.locator('#sd-export').click(); await s.waitForSelector('#sd-exp-wav');
      const [dl] = await Promise.all([s.waitForEvent('download', { timeout: 60000 }), s.locator('#sd-exp-wav').click()]);
      const wav = fs.readFileSync(await dl.path());
      if (wav.subarray(0, 4).toString() !== 'RIFF') throw new Error('the mixdown is not a WAV');
      const secs = (wav.length - 44) / 4 / 44100;
      const ms = await s.evaluate(() => globalThis.__lastMixdownMs);
      console.log(`  mixdown: ${secs.toFixed(1)} s of audio, 4 tracks, rendered in ${ms} ms`);
      if (secs < 59) throw new Error(`the mixdown is ${secs} s`);
      if (ms > 10000) throw new Error(`the mixdown took ${ms} ms (target under 10 s)`);
      await esc(s);
      await s.locator('#sd-keys-done').click(); await s.locator('#sd-post').click(); await s.waitForSelector('#sd-rights');
      await s.fill('#sd-post-title', 'Morning riff'); await s.locator('#sd-rights .chip').first().click();
      await s.locator('#sd-post-send').click(); await s.waitForSelector('#sound-next #nx-copyLink', { timeout: 60000 });   // the new Sound, with what next
      await s.screenshot({ path: path.join(SHOTS, 'sound-posted.png') });
      soundId = await s.evaluate(async (server) => (await (await fetch(server + '/c/sounds')).json()).items[0]?.id, api);
      if (!soundId) throw new Error('the Sound is not on Stage');
    });
    await step('Sounds: another person layers a track on it', async () => {
      await tab(t, 'stage'); await tab(t, 'stage');
      await t.locator('#community-seg .chip').filter({ hasText: /Sounds/ }).click(); await t.waitForSelector('.sound-card');
      await t.screenshot({ path: path.join(SHOTS, 'stage-sounds.png') });
      await t.locator('.sound-card .btn').filter({ hasText: /Layer/ }).first().click(); await t.waitForSelector('.sd-track', { timeout: 30000 });
      await t.locator('#sd-add').click(); await t.locator('#sd-add-inst').click(); await t.waitForTimeout(300);
      await t.locator('#sd-keys-done').click(); await t.locator('#sd-post').click(); await t.waitForSelector('#sd-rights'); await t.locator('#sd-rights .chip').first().click();
      await t.locator('#sd-post-send').click(); await t.waitForSelector('#sound-next', { timeout: 60000 });
      const v = await t.evaluate(async ([server, id]) => (await (await fetch(`${server}/c/sounds/${id}`)).json()).versions, [api, soundId]);
      if (!v || v.layers.length !== 1) throw new Error('no layer: ' + JSON.stringify(v));
    });
    await step('Sounds: a comment at a moment, a repost, and the Friends feed', async () => {
      await esc(t); await t.evaluate((id) => { location.hash = `#sound/${id}`; }, soundId); await t.waitForSelector('#moments:visible', { timeout: 15000 });
      await t.locator('#moment-text:visible').fill('Lovely start');
      await t.locator('#moment-send:visible').click(); await t.waitForSelector('#moments:visible .moment');
      await t.locator(`#repost-s-${soundId}:visible`).click(); await t.waitForTimeout(600);
      await t.screenshot({ path: path.join(SHOTS, 'sound-moments.png') });
      await esc(s); await tab(s, 'stage'); await s.evaluate(() => window.__haptune.popToRoot('community'));
      await s.locator('#community-seg .chip').filter({ hasText: /^Friends$/ }).click(); await s.waitForSelector('#friends-feed .ff-item', { timeout: 15000 });
      if (!/reposted/i.test(await s.locator('#friends-feed').innerText())) throw new Error('the repost is not in the Friends feed');
      await s.screenshot({ path: path.join(SHOTS, 'stage-friends-feed.png') });
    });
  } catch (e) { problems.push(e.message); }
  for (const x of [T, S]) if (x) problems.push(...x.errors);
  await browser.close(); web.close(); proc.kill();
  console.log(problems.length ? `classroom: ${problems.length} problem(s)\n  ${problems.join('\n  ')}` : 'classroom: no errors');
  process.exit(problems.length ? 1 : 0);
})();
