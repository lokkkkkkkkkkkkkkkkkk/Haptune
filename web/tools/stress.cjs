// Playback stress test: imports a dense score, presses Listen, jumps bars while playing, and reports
// main-thread long tasks, frame gaps, late/dropped notes and whether the bar keeps moving, under 4x CPU
// throttling (a mid-range phone). Serve dist/pages first. Usage: node tools/stress.cjs <score file> [seconds] [port]
const { chromium } = require('playwright');
const file = process.argv[2];
const secs = Number(process.argv[3] || 8);
const port = process.argv[4] || '8765';
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 1, hasTouch: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('haptune.welcomed', 'true');
    window.__m = { long: [], gaps: [], starts: 0, late: 0, lateMs: [], nodes: 0 };
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__m.long.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true });
    } catch {}
    let last = performance.now();
    const fr = () => { const n = performance.now(); if (window.__measure) window.__m.gaps.push(n - last); last = n; requestAnimationFrame(fr); };
    requestAnimationFrame(fr);
    const S = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function (when = 0, ...rest) {
      if (window.__measure) {
        window.__m.starts++;
        const ahead = when - this.context.currentTime;
        if (when !== 0 && ahead < 0.01) { window.__m.late++; window.__m.lateMs.push(Math.round(ahead * 1000)); }
      }
      return S.call(this, when, ...rest);
    };
    for (const k of ['createOscillator', 'createBufferSource', 'createGain', 'createBiquadFilter']) {
      const f = BaseAudioContext.prototype[k];
      BaseAudioContext.prototype[k] = function (...a) { if (window.__measure) window.__m.nodes++; return f.apply(this, a); };
    }
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.tabbar button');
  await p.locator('.tabbar button:visible').nth(1).click();
  await p.waitForTimeout(400);
  await p.locator('#lib-add:visible').first().click();
  await p.waitForTimeout(400);
  await p.locator('#file-input').first().setInputFiles(file);
  await p.waitForSelector('.sheet .btn', { timeout: 30000 });
  await p.locator('.sheet .btn').last().click();
  const t0 = Date.now();
  await p.waitForSelector('.score-box svg', { timeout: 120000 });
  const renderMs = Date.now() - t0;
  const notes = await p.evaluate(() => document.querySelectorAll('.score-box g.note').length);
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await p.evaluate(() => { window.__m.long = []; window.__measure = true; });
  await p.locator('#listen-btn').click();
  await p.waitForTimeout(secs * 1000 / 2);
  // jump forward a few bars while playing, like the bug report
  const fwd = p.locator('.tbtn[aria-label="+1 bar"]');
  for (let i = 0; i < 3; i++) { await fwd.click().catch(() => {}); await p.waitForTimeout(250); }
  const barText1 = await p.locator('.bar-pos strong').first().textContent().catch(() => '');
  await p.waitForTimeout(secs * 1000 / 2);
  const barText2 = await p.locator('.bar-pos strong').first().textContent().catch(() => '');
  const audio = await p.evaluate(() => globalThis.__haptuneAudio?.());
  const m = await p.evaluate(() => window.__m);
  await p.locator('#listen-btn').click().catch(() => {});
  const gaps = m.gaps.filter((g) => g > 100);
  const longSum = m.long.reduce((a, x) => a + x, 0);
  console.log(JSON.stringify({
    file: file.split('/').pop(), renderMs, svgNotes: notes, longTasks: m.long.length, longTaskMs: longSum, maxLong: Math.max(0, ...m.long),
    frameGapsOver100ms: gaps.length, maxFrameGap: Math.round(Math.max(0, ...m.gaps)), audioStarts: m.starts, lateStarts: m.late,
    worstLateMs: Math.min(0, ...m.lateMs), nodesCreated: m.nodes, barAfterJump: barText1, barLater: barText2, audio, errors: errors.filter((e) => !e.startsWith('[Error]') && !e.startsWith('[Warning]')).slice(0, 5), verovioErrors: errors.filter((e) => e.startsWith('[Error]')).length,
  }));
  await b.close();
})();
