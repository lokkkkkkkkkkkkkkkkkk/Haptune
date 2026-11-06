// Click-through smoke test of the built PWA. Usage: node tools/smoke.cjs [light|dark|ipad|desktop]
// Serve dist/pages on http://localhost:8765 first (npm run build && npx http-server dist/pages -p 8765).
// Prints "no errors" when every step worked, nothing overflowed sideways and the console stayed clean.
const { chromium, devices } = require('playwright');
const SHOTS = process.env.SHOTS || require('path').join(__dirname, '..', 'shots') + '/';
const mode = process.argv[2] || 'light';
const DEVICE = {
  light: { ...devices['iPhone 13'], colorScheme: 'light' },
  dark: { ...devices['iPhone 13'], colorScheme: 'dark' },
  ipad: { ...devices['iPad (gen 7) landscape'], colorScheme: 'light' },
  desktop: { viewport: { width: 1280, height: 820 }, colorScheme: 'dark' },
}[mode];
(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext(DEVICE);
  const p = await ctx.newPage();
  const errors = [];
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  p.on('pageerror', (e) => errors.push('page: ' + e.message));
  const V = (sel) => p.locator(sel + ':visible');
  const shot = (name) => p.screenshot({ path: `${SHOTS}${mode}-${name}.png` });
  const step = async (name, fn) => { try { await fn(); } catch (e) { errors.push(`${name}: ${e.message.split('\n')[0]}`); } };
  const nav = mode === 'light' || mode === 'dark' ? '.tabbar button' : '.sidebar > button';
  const tab = async (i) => { await V(nav).nth(i).click(); await p.waitForTimeout(500); };
  const closeSheet = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(350); };
  const overflow = async (where) => {
    const bad = await p.evaluate(() => {
      const out = [];
      const roots = document.querySelectorAll('.tab-pane:not([hidden]) .view:not([hidden]), .sheet');
      roots.forEach((root) => root.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > innerWidth + 1 && !el.closest('.hscroll, .roll, .chord-strip, .score-box, .kbd-wrap, .chips, .bar-pick, .bar-strip'))
          out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} → ${Math.round(r.right)}`);
      }));
      return out.slice(0, 5);
    });
    if (bad.length) errors.push(`overflow in ${where}: ${bad.join(' | ')}`);
  };

  await p.goto('http://localhost:8765/', { waitUntil: 'networkidle' });
  await step('welcome guide', async () => {
    await p.waitForSelector('.welcome', { timeout: 15000 });
    await shot('00-welcome');
    for (let i = 0; i < 3; i++) { await V('.welcome .btn.brand').click(); await p.waitForTimeout(350); }
    await V('.welcome .btn.secondary').click();          // "Let's go"
    await p.waitForTimeout(700);
  });
  await step('home', async () => { await shot('01-home'); await overflow('home'); });
  await step('library and add', async () => {
    await tab(1);
    await shot('02-library');
    await overflow('library');
    await V('#lib-add').click();
    await p.waitForTimeout(500);
    await shot('03-add');
    await overflow('add');
    await closeSheet();
  });
  await step('song screen', async () => {
    await V('.list .row').filter({ hasText: 'Twinkle' }).first().click();
    await p.waitForSelector('.score-box svg', { timeout: 30000 });
    await p.waitForTimeout(800);
    await shot('04-song');
    await overflow('song');
    await V('#listen-btn').click();
    await p.waitForTimeout(1200);
    const playing = await p.evaluate(() => globalThis.__haptuneAudio?.());
    if (!playing || playing.state !== 'running' || playing.gain < 0.5) errors.push(`listen: audio not playing ${JSON.stringify(playing)}`);
    await V('#listen-btn').click();
    await V('#play-along').click();
    await p.waitForTimeout(500);
    await shot('05-play-along');
    await overflow('play along sheet');
    await closeSheet();
    await V('.navbar .nav-actions button').nth(1).click();   // export
    await p.waitForTimeout(500);
    await shot('06-export');
    await closeSheet();
    await tab(1);                                            // tapping the active tab goes back to the list
  });
  await step('improvise: vary a song', async () => {
    await tab(3);
    await V('.list .row').filter({ hasText: 'Ode' }).first().click();
    await p.waitForSelector('.vary-score svg', { timeout: 30000 });
    await V('.mode-cards.three .mode-card').nth(1).click();
    await p.waitForTimeout(1200);
    const changed = await V('.vary-score g.note.changed').count();
    if (!changed) errors.push('vary: no notes changed');
    await shot('07-vary');
    await overflow('vary');
  });
  await step('improvise: new solo', async () => {
    await V('.improv-modes .mode-card').nth(1).click();
    await V('button.btn.gradient').first().click();
    await p.waitForSelector('.improv-score svg', { timeout: 30000 });
    await p.waitForTimeout(600);
    await shot('08-solo');
    await overflow('solo');
  });
  await step('academy (Community > Learn)', async () => {
    await tab(2);
    await V('#community-seg button').nth(4).click();
    await p.waitForTimeout(400);
    await shot('09-academy');
    await overflow('academy');
    await V('.course-tile').first().click();
    await p.waitForTimeout(450);
    await shot('10-course');
    await V('.list .row').first().click();
    await p.waitForTimeout(450);
    for (let i = 0; i < 6 && !(await V('.sheet .q-opt').count()); i++) { await V('.sheet .btn.primary').first().click(); await p.waitForTimeout(300); }
    await shot('11-lesson');
    if (await V('.sheet .q-opt').count()) { await V('.sheet .q-opt').first().click(); await p.waitForTimeout(300); }
    await V('.sheet-head .l').first().click();
    await p.waitForTimeout(300);
    await tab(2);
  });
  await step('tools', async () => {
    await tab(4);
    await shot('12-tools');
    await overflow('tools');
    await V('.tiles .tile').first().click();
    await p.waitForTimeout(500);
    await shot('13-tool');
  });
  await step('account', async () => {
    await tab(4);                                            // back from the tool to the Tools list
    await V('.avatar').first().click();
    await p.waitForTimeout(450);
    await shot('14-account');
    await closeSheet();
  });
  console.log(errors.length ? errors.join('\n') : 'no errors');
  await b.close();
  process.exit(errors.length ? 1 : 0);
})();
