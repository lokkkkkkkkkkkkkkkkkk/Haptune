// Click-through smoke test of the built PWA. Usage: node tools/smoke.cjs [light|dark|ipad|desktop]
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
  const b = await chromium.launch();
  const ctx = await b.newContext(DEVICE);
  const p = await ctx.newPage();
  const errors = [];
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  p.on('pageerror', (e) => errors.push('page: ' + e.message));
  const V = (sel) => p.locator(sel + ':visible');
  const shot = (name) => p.screenshot({ path: `${SHOTS}${mode}-${name}.png` });
  const step = async (name, fn) => { try { await fn(); } catch (e) { errors.push(`${name}: ${e.message.split('\n')[0]}`); } };
  const nav = mode === 'light' || mode === 'dark' ? '.tabbar button' : '.sidebar > button';
  const tab = async (i) => { await V(nav).nth(i).click(); await p.waitForTimeout(450); };

  await p.goto('http://localhost:8765/', { waitUntil: 'networkidle' });
  await p.waitForSelector('.large-title', { timeout: 15000 });
  await shot('01-summary');
  // horizontal overflow check on every root
  const overflow = async (where) => {
    const bad = await p.evaluate(() => {
      const out = [];
      document.querySelectorAll('.tab-pane:not([hidden]) .view:not([hidden]) *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > innerWidth + 1 && !el.closest('.hscroll, .roll, .chord-strip, .score-box, .kbd-wrap, .chips')) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} → ${Math.round(r.right)}`);
      });
      return out.slice(0, 5);
    });
    if (bad.length) errors.push(`overflow in ${where}: ${bad.join(' | ')}`);
  };
  await overflow('summary');
  await step('library', async () => { await tab(1); await shot('02-library'); await overflow('library'); });
  await step('chord sheet', async () => {
    await V('.list .row').filter({ hasText: '(chords)' }).first().click();
    await p.waitForTimeout(700);
    await shot('03a-chordsheet');
    await overflow('chord sheet');
    await tab(1); // tapping the active tab pops back to the list
  });
  await step('piece', async () => {
    await V('.list .row').filter({ hasText: 'Twinkle' }).first().click();
    await p.waitForSelector('.score-box svg', { timeout: 30000 });
    await p.waitForTimeout(800);
    await shot('03-piece');
    await overflow('piece');
    await V('.stepper button').nth(1).click();
    await V('.stepper button').nth(1).click();
    await p.waitForTimeout(1500);
    await shot('04-piece-up2');
    const seg = V('#piece-views button');
    const n = await seg.count();
    for (let i = 1; i < n; i++) { await seg.nth(i).click(); await p.waitForTimeout(500); await shot(`05-view${i}`); await overflow('piece view ' + i); }
    await V('#play-btn').click();
    await p.waitForTimeout(1500);
    await V('#play-btn').click();
  });
  await step('improvise', async () => {
    await tab(2);
    await shot('06-improvise');
    await V('button.btn.gradient').first().click();
    await p.waitForSelector('.improv-score svg', { timeout: 30000 });
    await p.waitForTimeout(600);
    await V('.improv-score').first().scrollIntoViewIfNeeded();
    await shot('07-improv-result');
    await overflow('improvise');
  });
  await step('academy', async () => {
    await tab(3);
    await shot('08-academy');
    await overflow('academy');
    await V('.course-tile').first().click();
    await p.waitForTimeout(450);
    await shot('09-course');
    await V('.list .row').first().click();
    await p.waitForTimeout(450);
    await shot('10-lesson');
    // step through the lesson cards until a quiz option appears
    for (let i = 0; i < 6 && !(await V('.sheet .q-opt').count()); i++) { await V('.sheet .btn.primary').first().click(); await p.waitForTimeout(300); }
    await shot('11-quiz');
    if (await V('.sheet .q-opt').count()) { await V('.sheet .q-opt').first().click(); await p.waitForTimeout(300); await shot('12-quiz-answered'); }
    await V('.sheet-head .l').first().click();
    await p.waitForTimeout(300);
  });
  await step('tools', async () => {
    await tab(4);
    await shot('13-tools');
    await overflow('tools');
    await V('.tiles .tile').first().click();
    await p.waitForTimeout(500);
    await shot('14-tool');
  });
  await step('account', async () => {
    await tab(4);
    await V('.avatar').first().click();
    await p.waitForTimeout(450);
    await shot('15-account');
  });
  console.log(errors.length ? errors.join('\n') : 'no errors');
  await b.close();
})();
