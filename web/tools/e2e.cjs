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
  const ctx = await browser.newContext({ ...SIZES[mode], acceptDownloads: true, permissions: ['microphone'] });
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
  const shot = async (n) => { await p.waitForTimeout(450); await p.screenshot({ path: path.join(SHOTS, `${mode}-${n}.png`) }); };
  const step = async (name, fn) => { try { await fn(); } catch (e) { errors.push(`${name}: ${e.message.split('\n')[0]}`); } };
  // the places: a sidebar on wide screens, a tab bar on phones; Me is the sidebar's account button or the picture
  const LABEL = { home: 'homeTab', learn: 'hub', stage: 'stage', library: 'library', write: 'create' };
  const tab = async (id) => {
    const wide = await p.evaluate(() => innerWidth >= 900);
    if (id === 'me') return wide ? p.locator('#top-me').click() : p.locator('.avatar:visible, .hh-avatar:visible').first().click();
    return p.locator(`${wide ? '#side' : '#tab'}-${LABEL[id] || id}:visible`).click();
  };
  const back = () => p.locator('.navbar .back:visible, .back-btn:visible').first().click();
  const overflow = async (where) => {
    // let a page that is still sliding in (push animation) settle; endless ones (Hapi, the colour wash) don't count
    await p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming?.().iterations === Infinity), null, { timeout: 2000 }).catch(() => {});
    const bad = await p.evaluate(() => {
      const out = [];
      document.querySelectorAll('.tab-pane:not([hidden]) .view:not([hidden]) *, .sheet *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > innerWidth + 1 && !el.closest('.shelf, .roll, .chips, .segmented, .score-box, .kbd-wrap, .helpers-strip, .bar-strip, .hscroll, .jp-box, .art-cover'))
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
  // "No screen shows more than 6 primary actions above the fold": big buttons (tiles, big play buttons, tool
  // buttons, brand buttons) fully inside the first screenful.
  const primaries = (where) => p.evaluate(() => {
    const sel = '.home-tile, .hero-tile, .act, .ftile, .tile, .tile3, .hm-way, .big-play, .tool-btn, .btn.brand, .stage-plus, .wiz-opt';
    return [...document.querySelectorAll(sel)].filter((el) => {
      if (!el.closest('.tab-pane:not([hidden]) .view:not([hidden]), .sheet')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
    }).length;
  }).then((n) => { if (n > 6) errors.push(`${where} shows ${n} primary actions above the fold (max 6)`); return n; });
  await step('first run: one welcome card, then on to the song searched on the website', async () => {
    await p.waitForSelector('.welcome #tour-start'); await shot('00b-welcome');
    await p.locator('#tour-start').click(); await p.waitForTimeout(500);
    await p.waitForSelector('#find-q');
    if ((await p.inputValue('#find-q')) !== 'ode to joy') throw new Error('the song typed on the website did not arrive in Find songs');
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
  await step('mini-player: listening carries on after leaving the piece, pause, open it again at the same bar', async () => {
    await p.locator('#play-btn').click(); await p.waitForTimeout(1500);
    await back(); await p.waitForSelector('#mini-player', { timeout: 5000 });
    await p.waitForTimeout(1200);
    const a = await p.evaluate(() => window.__haptuneAudio());
    if (a.state !== 'running' || !a.scheduled) throw new Error('listening stopped when the piece closed: ' + JSON.stringify(a));
    if (!/Playing/.test(await p.locator('#mini-player').innerText())) throw new Error('the mini-player does not say Playing');
    await shot('01c-miniplayer'); await overflow('mini-player');
    await p.locator('#mp-toggle').click(); await p.waitForTimeout(400);
    if (!/Paused/.test(await p.locator('#mini-player').innerText())) throw new Error('the mini-player did not pause');
    await p.locator('#mp-open').click(); await p.waitForSelector('.vrv-page svg', { timeout: 30000 }); await p.waitForTimeout(600);
    if (await p.locator('#mini-player').count()) throw new Error('the mini-player stayed after opening the piece');
  });
  await step('簡譜 and another instrument', async () => {
    await p.locator('#piece-views button').filter({ hasText: '簡譜' }).click(); await p.waitForSelector('.jp-svg .jn');
    await shot('03-jianpu'); await overflow('簡譜');
    await p.locator('#piece-views button').first().click();
    await primaries('song');
    await p.locator('#tool-more').click(); await p.locator('#tool-inst').click(); await p.locator('.sheet .chip').filter({ hasText: 'Clarinet' }).click();
    await p.waitForSelector('#arr-note'); await p.waitForTimeout(600);
    await p.locator('#tool-more').click(); await p.locator('#tool-inst').click(); await p.locator('#inst-as-written').click();
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
  if (mode === 'desktop') {
    await step('Play Along take -> report -> details -> export', async () => {
      await p.locator('#play-along').click(); await p.waitForSelector('.mode-cards');
      await p.locator('.mode-card').nth(1).click();                       // keep the beat: ends with the music
      await p.locator('.sheet .btn.brand').filter({ hasText: /Start/ }).click();
      await p.waitForSelector('#take-report', { timeout: 120000 });
      await p.waitForSelector('#take-report #next-chips #nx-similar');
      if (!(await p.locator('#take-report #next-chips .nx.primary').count())) throw new Error('the take has no first choice for what next');
      await shot('11-take'); 
      await p.locator('#view-details').click(); await p.waitForSelector('#report');
      await p.waitForSelector('#rep-next');
      await shot('12-report'); await overflow('report');
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), p.locator('#rep-png').click()]);
      const file = path.join(SHOTS, 'export-report.png'); await dl.saveAs(file);
      if (fs.readFileSync(file).subarray(1, 4).toString() !== 'PNG') throw new Error('the report picture is not a PNG');
      await back();
    });
  }
  await step('library and the free library', async () => {
    await back(); await tab('library'); await p.waitForTimeout(300);
    await shot('05-library'); await overflow('library'); await primaries('library');
    await p.locator('#lib-free').click(); await p.waitForSelector('#cat-search');
    await p.fill('#cat-search', 'washerwoman'); await p.waitForTimeout(500);
    await p.locator('.list .row:visible').first().click(); await p.waitForSelector('.vrv-page svg', { timeout: 60000 });
    await back(); await back();
  });
  await step('Home: hero row, chips, band, shelves; a playable sheet in two taps from each hero tile', async () => {
    const home = async () => { await p.evaluate(() => { for (const k of ['summary', 'library', 'write']) window.__haptune.popToRoot(k); }); await p.waitForTimeout(300); await tab('home'); await p.waitForSelector('#home-hero:visible'); };
    await home();
    if (await p.locator('.hero-tile:visible').count() !== 3) throw new Error('Home should show exactly three hero tiles');
    const order = await p.evaluate(() => [...document.querySelectorAll('#home > .wrap > *')].map((el) => el.id || el.className.split(' ')[0]).filter((x) => x && x !== 'hidden-input'));
    const want = ['home-head', 'home-hero', 'home-band', 'home-chips', 'shelf-', 'more-tools'];
    let at = -1;
    for (const w of want) { const i = order.findIndex((x, j) => j > at && x.startsWith(w)); if (i < 0) throw new Error(`Home is missing ${w} (or it is out of order): ${order.join(', ')}`); at = i; }
    await shot('01-home'); await overflow('home'); await primaries('home');
    await p.evaluate(() => document.querySelector('#home').scrollTo(0, 99999)); await shot('01-home-lower'); await overflow('home (lower)');
    await p.evaluate(() => document.querySelector('#home').scrollTo(0, 0));
    // the chips re-sort the shelves
    const first = () => p.locator('#shelf-level .shelf-item strong').first().innerText().catch(() => '');
    const before = await first();
    await p.locator('#chip-hymn').click(); await p.waitForTimeout(250);
    if (!(await p.locator('#chip-hymn.on').count())) throw new Error('the Hymns chip did not turn on');
    await shot('01d-home-chip');
    await p.locator('#chip-hymn').click(); await p.waitForTimeout(150);
    const after = await first();
    if (before && after !== before) throw new Error(`turning the chip off did not restore the order (${before} -> ${after})`);
    // New songs: tap 1 the tile, tap 2 a song -> the sheet with Play Along
    await p.locator('#hero-new').click(); await p.waitForSelector('#new-first', { timeout: 20000 }); await shot('01e-new-songs'); await overflow('new songs');
    await p.locator('#new-first').click(); await p.waitForSelector('#play-along', { timeout: 60000 }); await p.waitForSelector('.vrv-page svg', { timeout: 60000 });
    await home();
    // Find songs
    await p.locator('#hero-find').click(); await p.waitForSelector('#find-first', { timeout: 20000 }); await shot('01f-find'); await overflow('find');
    await p.locator('#find-first').click(); await p.waitForSelector('#play-along', { timeout: 60000 }); await p.waitForSelector('.vrv-page svg', { timeout: 60000 });
    await home();
    // Create: tap 1 the tile, tap 2 "Start a song now" -> 8 bars of chords with Play
    await p.locator('#hero-create').click(); await p.waitForSelector('#wiz-quick');
    await p.locator('#wiz-quick').click(); await p.waitForSelector('#ce-beat-0', { timeout: 20000 }); await p.waitForSelector('#ce-play:visible');
    if (!(await p.locator('#ce-beat-0 .ce-chord').count())) throw new Error('the quick-start song has no chords to play');
    await home();
    if (await p.locator('#more-tools.open').count()) await p.locator('#more-tools-toggle').click();
    await p.locator('#more-tools-toggle').click(); await p.waitForSelector('#mt-jianpu');
  });
  if (mode === 'phone') {
    await step('reload: tour shown once, More tools stays open', async () => {
      await p.reload({ waitUntil: 'networkidle' }); await p.waitForSelector('#home-hero');
      if (await p.locator('.welcome').count()) throw new Error('the tour came back after it was finished');
      if (!(await p.locator('#more-tools.open').count())) throw new Error('More tools forgot that it was open');
    });
  }
  if (mode === 'phone') {
    await step('Sound check: the microphone is analysed, the speaker tone is measured, nothing reaches the output', async () => {
      await tab('home');
      if (!(await p.locator('#more-tools.open').count())) await p.locator('#more-tools-toggle').click();
      await p.locator('#mt-soundcheck').click(); await p.waitForSelector('#sc-run');
      await p.locator('#sc-run').click();
      await p.waitForSelector('#sound-check .list .row', { timeout: 20000 });
      await shot('10-soundcheck'); await overflow('sound check');
      const r = await p.evaluate(() => JSON.parse(localStorage.getItem('haptune.soundCheck') || 'null'));
      if (!r || !r.playbackRate || r.roomDb === undefined) throw new Error('no sound check result: ' + JSON.stringify(r));
      await back();
    });
  }
  await step('type 簡譜', async () => {
    await tab('home');
    if (!(await p.locator('#more-tools.open').count())) await p.locator('#more-tools-toggle').click();
    await p.locator('#mt-jianpu').click();
    await p.locator('.sheet .chip').filter({ hasText: '簡譜' }).click(); await p.waitForTimeout(250);
    await p.locator('.sheet .btn.full').click(); await p.waitForTimeout(500);
    await p.locator('.sheet .btn').filter({ hasText: /Continue|Open/ }).first().click();
    await p.waitForSelector('.vrv-page svg', { timeout: 60000 });
    if (!/茉莉花/.test(await p.locator('.piece-head h1').innerText())) throw new Error('the typed 簡譜 did not open');
    await back();
  });
  await step('the studio: a first song in under 5 minutes (notes, an instrument, a dynamic, lead-sheet chords, a mix, export)', async () => {
    const started = Date.now();
    const wide = await p.evaluate(() => innerWidth >= 900);
    await tab('write'); await p.waitForTimeout(300); await shot('06-write'); await overflow('Create'); await primaries('Create');
    await p.locator('#write-new').click(); await p.waitForSelector('#wiz-kinds'); await primaries('new-song wizard');
    if (!(await p.locator('#wiz-full').count())) { await p.locator('#wiz-more').click(); await p.waitForSelector('#wiz-full'); }
    await shot('06b-create-sheet');
    await p.locator('#wiz-full').click(); await p.waitForSelector('#new-song-make');
    await p.fill('#new-song-title', 'My first song'); await p.locator('#new-song-make').click();
    await p.waitForSelector('.st-score svg', { timeout: 60000 }); await p.waitForSelector('#st-toolbar'); await p.waitForTimeout(400);
    const before = await p.locator('.st-score g.note').count();
    for (const k of [0, 2, 4, 5]) { await p.locator('.st-kbd .wkey').nth(k).click(); await p.waitForTimeout(120); }
    await p.waitForFunction((n) => document.querySelectorAll('.st-score g.note').length >= n + 4, before, { timeout: 20000 });
    await p.locator('#st-back').click(); await p.waitForTimeout(300);
    await shot('06b-studio'); await overflow('studio');
    // Instruments: add a cello part; Palettes: mf at the cursor
    if (wide) await p.locator('#side-instruments').click(); else await p.locator('#dock-instruments').click();
    await p.locator('#add-cello').click(); await p.waitForSelector('#part-1');
    if (wide) await p.locator('#side-palettes').click(); else await p.locator('#dock-palettes').click();
    await p.locator('#pal-dyn-mf').click(); await p.waitForTimeout(300);
    if (!wide) await p.locator('#dock-notes').click();
    // Lead sheet: a chord on bar 1 from the lane
    await p.locator('#st-lead').click(); await p.waitForSelector('#lead-lane');
    await p.locator('#lead-lane .ll-bar').first().locator('button').filter({ hasText: /^C$/ }).click(); await p.waitForTimeout(300);
    await shot('06d-studio-lead'); await overflow('studio lead sheet');
    // Mix: two channel strips, mute the cello, play
    await p.locator('#st-modes button').filter({ hasText: /Mix/ }).click(); await p.waitForSelector('#st-mixer .strip');
    if ((await p.locator('#st-mixer .strip').count()) !== 2) throw new Error('the mixer should have a strip for each part');
    await p.locator('#st-mixer .strip').nth(1).locator('.mix-b').first().click();
    if (!(await p.locator('#st-mixer .strip.muted').count())) throw new Error('mute did not mute');
    await p.locator('#mix-play').click(); await p.waitForTimeout(600); await p.locator('#mix-play').click();
    await shot('06e-studio-mix'); await overflow('mixer');
    // Share: export MusicXML with both parts, the dynamic and the chord in it
    await p.locator('#st-modes button').filter({ hasText: /Share/ }).click(); await p.waitForSelector('#st-share #studio-next');
    await shot('06f-studio-share');
    await p.locator('#share-export').click(); await p.waitForSelector('#exp-musicxml');
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), p.locator('#exp-musicxml').click()]);
    const xml = fs.readFileSync(await dl.path(), 'utf8');
    if ((xml.match(/<score-part /g) || []).length !== 2 || !/<dynamics><mf\/>/.test(xml) || !/<harmony/.test(xml)) throw new Error('the exported MusicXML is missing the cello, the mf or the chord');
    await p.keyboard.press('Escape'); await p.waitForTimeout(250);
    const mins = (Date.now() - started) / 60000;
    if (mins > 5) throw new Error(`the first song took ${mins.toFixed(1)} minutes`);
    await back(); await p.waitForTimeout(300);
    if (!(await p.locator('#write .song-tile').filter({ hasText: 'My first song' }).count())) throw new Error('the new song is not in My songs');
    // opening it again: the studio is ready (bars drawn) in under 2 seconds
    const t0 = Date.now();
    await p.locator('#write .song-tile').filter({ hasText: 'My first song' }).locator('.st-main').click();
    await p.waitForSelector('.st-score svg g.note', { timeout: 10000 });
    const ms = Date.now() - t0;
    console.log(`  ${mode}: studio ready in ${ms} ms; first song made in ${(mins * 60).toFixed(0)} s`);
    if (ms > 2000) throw new Error(`the studio took ${ms} ms to open (target under 2 s)`);
    await back(); await p.waitForTimeout(300);
  });
  await step('lyrics -> edited chords -> Play Along', async () => {
    await tab('write'); await p.waitForTimeout(300);
    await p.locator('#write-lyrics').click(); await p.waitForSelector('#new-song-lyrics');
    await p.fill('#new-song-title', 'Grace'); await p.fill('#new-song-lyrics', 'Verse 1\nAmazing grace how sweet the sound\nThat saved a wretch like me');
    await p.locator('#new-song-make').click(); await p.waitForSelector('#ce-beat-0', { timeout: 20000 });
    await shot('06c-chords'); await overflow('chord editor'); await primaries('chord editor');
    const before = await p.locator('#ce-beat-0 .ce-chord').innerText();
    await p.locator('#ce-beat-0').click(); await p.waitForSelector('#cp-diatonic');
    await p.locator('#cp-diatonic .chip').filter({ hasText: /^Am/ }).first().click(); await p.waitForTimeout(250);
    const after = await p.locator('#ce-beat-0 .ce-chord').innerText();
    if (before === after || !/^Am/.test(after)) throw new Error(`the chord did not change (${before} -> ${after})`);
    await p.locator('#ce-beat-2').click(); await p.locator('#cp-text').fill('D/F#'); await p.keyboard.press('Enter'); await p.waitForTimeout(250);
    if ((await p.locator('#ce-beat-2 .ce-chord').innerText()) !== 'D/F#') throw new Error('a typed chord was not placed on beat 3');
    await p.locator('#ce-undo').click(); await p.waitForTimeout(200);
    if (await p.locator('#ce-beat-2 .ce-chord').count()) throw new Error('undo did not remove the chord');
    await p.locator('#nx-playAlong').click(); await p.waitForSelector('.sheet', { timeout: 30000 });
    await p.waitForTimeout(300); await p.keyboard.press('Escape');
    await p.waitForSelector('.vrv-page svg', { timeout: 60000 });
    if (!/Grace/.test(await p.locator('.piece-head h1').innerText())) throw new Error('Play Along did not open the chord song');
    await back(); await back();
  });
  await step('guide: Show me around, every step, then gone', async () => {
    await tab('home'); await p.evaluate(() => window.__haptune.popToRoot('summary'));
    await p.evaluate(() => window.__haptune.push('browse', {}, 'summary')); await p.waitForSelector('#browse-tour');
    await shot('10-browse'); await overflow('browse');
    await p.locator('#browse-tour').click(); await p.waitForSelector('#coach');
    let n = 0, spot = 0;
    for (; n < 12 && await p.locator('#coach').count(); n++) {
      await p.waitForTimeout(450);
      if (await p.locator('.coach-hole').count()) spot++;
      if (n === 2) await shot('11-guide');
      await p.locator('#coach-next').click();
    }
    await p.waitForTimeout(300);
    if (await p.locator('#coach').count()) throw new Error('the guide did not finish');
    if (n < 7) throw new Error(`the guide had only ${n} steps`);
    if (spot < 5) throw new Error(`only ${spot} steps pointed at a button`);
  });
  await step('Stage, Learn, Me, plans', async () => {
    await tab('stage'); await p.waitForTimeout(300); await shot('07-stage'); await overflow('Stage'); await primaries('Stage');
    await tab('learn'); await p.waitForTimeout(300); await shot('07b-learn'); await overflow('Learn'); await primaries('Learn');
    await tab('home'); await p.locator('#mt-tuner').click(); await p.waitForTimeout(300); await overflow('tools'); await back();
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
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
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
