// Click-through of the community with two people (two browser profiles) against a local server:
// Aina asks for a song, Bala wants it too, Chen makes the score and sends it, Aina accepts it with 5 stars.
// Also opens plans, help, feedback, wallet, leaderboard and the developer unlock. Screenshots go to SHOTS.
// Run: server on :8000 (HAPTUNE_ADMIN_CODE=dev-code-123456), `HAPTUNE_SERVER=http://localhost:8000 npm run build`,
// serve dist/pages on :8765, then: node tools/community-smoke.cjs
const { chromium } = require('playwright');
const path = require('path');
const SHOTS = process.env.SHOTS || path.join(__dirname, '..', 'shots') + '/';
const URL0 = process.env.APP || 'http://localhost:8765/';
const errors = [];

async function person(browser, name, { lang = 'en', instrument = 'violin' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 880 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(([n, l, i]) => {
    if (!localStorage.getItem('haptune.settings')) localStorage.setItem('haptune.settings', JSON.stringify({ name: n, lang: l, instrument: i }));
    localStorage.setItem('haptune.welcomed', 'true');
  }, [name, lang, instrument]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name} page: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  await p.goto(URL0, { waitUntil: 'networkidle' });
  await p.waitForSelector('.tabbar button');
  return p;
}
const V = (p, sel) => p.locator(`${sel}:visible`);
const shot = (p, n) => p.screenshot({ path: `${SHOTS}c-${n}.png` });
const tab = async (p, i) => { await V(p, '.tabbar button').nth(i).click(); await p.waitForTimeout(500); };
const step = async (name, fn) => { try { await fn(); } catch (e) { errors.push(`${name}: ${e.message.split('\n')[0]}`); } };

(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  const b = await chromium.launch();
  const aina = await person(b, 'Aina');
  const bala = await person(b, 'Bala', { lang: 'ms' });
  const chen = await person(b, 'Chen', { lang: 'zh-Hans', instrument: 'piano' });
  let postUrl = '';
  await step('community home', async () => {
    await tab(aina, 2);
    await aina.waitForSelector('.ask-hero', { timeout: 20000 });
    await aina.waitForTimeout(1200);
    await shot(aina, '01-home');
  });
  await step('ask for a song', async () => {
    await V(aina, '.ask-hero .btn').first().click();
    await aina.waitForSelector('#c-song');
    await aina.fill('#c-song', 'Minuet in G');
    await aina.fill('#c-artist', 'Petzold');
    await aina.fill('#c-link', 'https://www.youtube.com/watch?v=abcdefghijk');
    await aina.fill('#c-body', 'Easy violin version please, first 16 bars.');
    await V(aina, '.chip').filter({ hasText: 'Public domain' }).click();
    await V(aina, '.chip').filter({ hasText: '25' }).first().click();
    await shot(aina, '02-compose');
    await V(aina, '.sheet .btn').filter({ hasText: 'Post request' }).click();
    await aina.waitForSelector('.post-view', { timeout: 15000 });
    await aina.waitForTimeout(600);
    await shot(aina, '03-post');
  });
  await step('Bala wants it too', async () => {
    await tab(bala, 2);
    await V(bala, '#community-seg button').nth(1).click();
    await bala.waitForTimeout(1200);
    await shot(bala, '04-requests-ms');
    await V(bala, '.post-card').first().click();
    await bala.waitForSelector('.request-box');
    await V(bala, '.request-box .btn').first().click();          // Saya pun mahu
    await bala.waitForTimeout(800);
  });
  await step('Chen makes the score', async () => {
    // Chen needs a score in the library: the songbook "Ode to Joy" stands in for it
    await tab(chen, 2);
    await V(chen, '#community-seg button').nth(1).click();
    await chen.waitForTimeout(1200);
    await V(chen, '.post-card').first().click();
    await chen.waitForSelector('.request-box');
    await V(chen, '.request-box .btn.c-green').first().click();       // 我来做
    await chen.waitForTimeout(800);
    await V(chen, '.request-box .btn').filter({ hasText: '提交乐谱' }).click();
    await chen.waitForSelector('.sheet .row');
    await V(chen, '.sheet .row').first().click();
    await chen.fill('textarea[aria-label]', '做好了，前 16 小节。');
    await shot(chen, '05-submit-zh');
    await V(chen, '.sheet .btn').last().click();
    await chen.waitForTimeout(1500);
    await shot(chen, '06-after-submit');
  });
  await step('Aina accepts with five stars', async () => {
    await V(aina, '.navbar .back').click();
    await aina.waitForTimeout(400);
    await V(aina, '.post-card').first().click();
    await aina.waitForSelector('.reply.k-submission', { timeout: 15000 });
    await shot(aina, '07-submission');
    await V(aina, '.reply .btn').filter({ hasText: 'Accept score' }).click();
    await aina.waitForSelector('.stars-input');
    await shot(aina, '08-accept');
    await V(aina, '.sheet .btn').filter({ hasText: 'Accept' }).last().click();
    await aina.waitForSelector('.reply.accepted', { timeout: 15000 });
    await aina.waitForTimeout(500);
    await shot(aina, '09-accepted');
  });
  await step('Chen sees the reward', async () => {
    await chen.reload({ waitUntil: 'networkidle' });
    await tab(chen, 2);
    await chen.waitForTimeout(1500);
    await V(chen, '.head-btn.bell').click();
    await chen.waitForSelector('.note-row', { timeout: 15000 });
    await shot(chen, '10-notifications-zh');
    const txt = await chen.locator('.note-row').first().textContent();
    if (!/积分/.test(txt)) errors.push(`reward notification missing: ${txt}`);
    await V(chen, '.navbar .back').click();
    await V(chen, '.head-btn').first().click();
    await chen.waitForSelector('.wallet-hero');
    await chen.waitForTimeout(800);
    await shot(chen, '11-wallet-zh');
  });
  await step('leaderboard and profile', async () => {
    await V(aina, '.navbar .back').click();
    await V(aina, '#community-seg button').first().click();
    await aina.waitForTimeout(1500);
    await shot(aina, '12-home-after');
    await aina.locator('.helper').first().click();
    await aina.waitForSelector('.profile-head');
    await aina.waitForTimeout(600);
    await shot(aina, '13-profile');
  });
  const toRoot = async (p) => { for (let i = 0; i < 4 && await V(p, '.navbar .back').count(); i++) { await V(p, '.navbar .back').first().click(); await p.waitForTimeout(250); } };
  await step('plans, help, feedback, dev unlock', async () => {
    await toRoot(aina);
    await V(aina, '.avatar').first().click();
    await aina.waitForSelector('.me-card');
    await shot(aina, '14-account');
    await V(aina, '.row').filter({ hasText: 'See plans' }).click();
    await aina.waitForSelector('.plan-card');
    await aina.waitForTimeout(500);
    await shot(aina, '15-plans');
    await aina.keyboard.press('Escape');
    await aina.waitForTimeout(300);
    await V(aina, '.avatar').first().click();
    await V(aina, '.row').filter({ hasText: 'Developer access' }).click();
    await aina.fill('#dev-code', 'dev-code-123456');
    await V(aina, '.sheet-head .r').click();
    await aina.waitForTimeout(800);
    await V(aina, '.avatar').first().click();
    await V(aina, '.row').filter({ hasText: 'Developer panel' }).click();
    await aina.waitForSelector('.stat-grid');
    await aina.waitForTimeout(500);
    await shot(aina, '16-dev-panel');
  });
  await step('help and feedback', async () => {
    await toRoot(aina);
    await V(aina, '.avatar').first().click();
    await V(aina, '.row').filter({ hasText: 'Help' }).first().click();
    await aina.waitForSelector('.faq');
    await shot(aina, '17-help');
    await V(aina, '.row').filter({ hasText: 'Report a problem' }).click();
    await aina.fill('#fb-msg', 'Test: after jumping bars the cursor stopped.');
    await V(aina, '.sheet .btn').last().click();
    await aina.waitForSelector('.sheet .empty', { timeout: 10000 });
    await shot(aina, '18-feedback-sent');
  });
  const overflow = await aina.evaluate(() => [...document.querySelectorAll('.view:not([hidden]) *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && !el.closest('.hscroll,.chips,.helpers-strip,.segmented,.seg-scroll')).slice(0, 4).map((el) => el.className));
  if (overflow.length) errors.push(`overflow: ${overflow.join(' | ')}`);
  await b.close();
  console.log(errors.length ? errors.join('\n') : 'no errors');
})();
