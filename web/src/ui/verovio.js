// Draws MusicXML as SVG with the Verovio engraver.
//
// The engraver runs in a background worker, so laying out a long score never freezes the screen (on a phone
// a 200-bar piano piece takes a few seconds; the app used to be stuck for that long). The score comes back
// as several short pages instead of one very tall drawing, which browsers scroll and repaint much faster.
// Where workers are not allowed (a few previews), it falls back to drawing on the main thread as before.
const CFG = () => globalThis.HAPTUNE_CONFIG || {};
const SRC = () => {
  const u = CFG().verovio || 'https://cdn.jsdelivr.net/npm/verovio@6.3.0/dist/verovio-toolkit-wasm.js';
  try { return new URL(u, globalThis.location?.href).href; } catch { return u; }
};

// ---------------- the workers ----------------
// Two lanes, each its own worker: "score" draws whole pieces, "edit" draws the few bars of the note editor.
// A long piece being drawn can then never hold up the editor (that was why taps and edits felt dead).
// Each lane sends one job at a time and keeps only the newest waiting job per caller, so a burst of edits
// draws once, with the last change. Pages come back one by one, so the first page shows straight away.
const WORKER_SRC = `
let tk = null, ready = null;
function start(url) {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    try { importScripts(url); } catch (e) { reject(e); return; }
    const v = self.verovio;
    if (!v || !v.module) { reject(new Error('Notation engine missing')); return; }
    const done = () => { try { tk = new v.toolkit(); resolve(); } catch (e) { reject(e); } };
    if (v.module.calledRun) done();
    else { v.module.onRuntimeInitialized = done; v.module.onAbort = () => reject(new Error('Notation engine stopped')); }
  });
  return ready;
}
self.onmessage = async (ev) => {
  const { id, url, xml, options } = ev.data;
  try {
    await start(url);
    if (!xml) { self.postMessage({ id, done: true, n: 0 }); return; }
    tk.setOptions(options);
    if (!tk.loadData(xml)) throw new Error('The notation engine could not read this score.');
    const n = tk.getPageCount();
    for (let p = 1; p <= n; p++) self.postMessage({ id, i: p - 1, n, page: tk.renderToSVG(p, false) });
    self.postMessage({ id, done: true, n });
  } catch (e) { self.postMessage({ id, error: String((e && e.message) || e) }); }
};`;

let workerOff = false, seq = 0, warmed = false;
const lanes = {};

function lane(name) {
  if (lanes[name]) return lanes[name];
  const L = { name, worker: null, busy: null, waiting: [] };
  lanes[name] = L;
  return L;
}
function workerOf(L) {
  if (workerOff || typeof Worker === 'undefined' || typeof Blob === 'undefined') return null;
  if (L.worker) return L.worker;
  try {
    L.worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
    L.worker.onmessage = (ev) => {
      const job = L.busy;
      if (!job || job.id !== ev.data.id) return;
      if (ev.data.error) { finish(L, job); job.reject(new Error(ev.data.error)); return; }
      if (ev.data.page !== undefined) { job.pages[ev.data.i] = ev.data.page; try { job.onPage?.(ev.data.page, ev.data.i, ev.data.n); } catch { /* the caller's problem */ } return; }
      if (ev.data.done) { warmed = true; finish(L, job); job.resolve(job.pages); }
    };
    L.worker.onerror = () => failWorkers();
  } catch { workerOff = true; L.worker = null; }
  return L.worker;
}
function finish(L, job) {
  clearTimeout(job.timer);
  L.busy = null;
  next(L);
}
function next(L) {
  if (L.busy || !L.waiting.length) return;
  const job = L.waiting.shift();
  const w = workerOf(L);
  if (!w) { job.reject(Object.assign(new Error('worker'), { worker: true })); next(L); return; }
  L.busy = job;
  // a worker that never answers (blocked WebAssembly, a broken download) must not leave the screen waiting
  job.timer = setTimeout(() => { if (L.busy === job) failWorkers(); }, warmed ? 45000 : 60000);
  w.postMessage({ id: job.id, url: SRC(), xml: job.xml, options: job.options });
}
function failWorkers() {
  workerOff = true;
  for (const L of Object.values(lanes)) {
    try { L.worker?.terminate(); } catch { /* gone */ }
    L.worker = null;
    const all = [L.busy, ...L.waiting].filter(Boolean);
    L.busy = null; L.waiting = [];
    for (const job of all) { clearTimeout(job.timer); job.reject(Object.assign(new Error('worker'), { worker: true })); }
  }
}
function inWorker(xml, options, { laneName = 'score', key = null, onPage = null } = {}) {
  if (workerOff || typeof Worker === 'undefined') return Promise.reject(Object.assign(new Error('worker'), { worker: true }));
  const L = lane(laneName);
  return new Promise((resolve, reject) => {
    const job = { id: ++seq, xml, options, key, onPage, pages: [], resolve, reject };
    if (key) {
      // only the newest drawing for the same place is worth making
      L.waiting = L.waiting.filter((j) => { if (j.key === key) { j.reject(Object.assign(new Error('superseded'), { superseded: true })); return false; } return true; });
    }
    L.waiting.push(job);
    next(L);
  });
}

/** Starts the engraver early (while the player reads the screen), so the first score appears sooner. */
export function warmVerovio() { if (!warmed) { inWorker('', {}).catch(() => {}); } }
/** Starts the editor's own engraver (it is small, but downloading and starting takes a moment). */
export function warmEditor() { inWorker('', {}, { laneName: 'edit' }).catch(() => {}); }

// a few recent drawings, so going back to a piece (or between views) shows it at once
const CACHE = new Map();
function cacheKey(xml, options) {
  let h = 2166136261;
  for (let i = 0; i < xml.length; i += 1) { h ^= xml.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${xml.length}:${(h >>> 0).toString(36)}:${JSON.stringify(options)}`;
}

// ---------------- main-thread fallback ----------------
let loading = null, toolkit = null;

export function loadVerovio() {
  if (toolkit) return Promise.resolve(toolkit);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      document.removeEventListener('securitypolicyviolation', onCsp);
      if (err) { loading = null; reject(err); return; }
      try { toolkit = new globalThis.verovio.toolkit(); resolve(toolkit); } catch (e) { loading = null; reject(e); }
    };
    // A page that forbids WebAssembly never finishes starting the engine, so watch for that and time out.
    const onCsp = (e) => { if (/wasm|eval/i.test(`${e.blockedURI} ${e.violatedDirective}`)) finish(new Error('Notation engine blocked by this page')); };
    document.addEventListener('securitypolicyviolation', onCsp);
    const timer = setTimeout(() => finish(new Error('The notation engine took too long to start')), 60000);
    const whenReady = (v) => {
      if (v.module?.calledRun) finish();
      else {
        v.module.onRuntimeInitialized = () => finish();
        v.module.onAbort = () => finish(new Error('Notation engine stopped'));
      }
    };
    if (globalThis.verovio?.toolkit) { whenReady(globalThis.verovio); return; }
    const s = document.createElement('script');
    s.src = SRC();
    s.async = true;
    s.onload = () => {
      const v = globalThis.verovio;
      if (!v) finish(new Error('Notation engine missing'));
      else whenReady(v);
    };
    s.onerror = () => finish(new Error('The notation engine could not be downloaded. Check the connection and try again.'));
    document.head.appendChild(s);
  });
  return loading;
}

export const isVerovioReady = () => warmed || !!toolkit;

function optionsFor({ width = 380, scale = 38, lyricSize = 4.5, paper = null }) {
  const pageWidth = Math.max(500, Math.round(width * 100 / scale));
  // On screen: pages about two and a half screens tall, each as tall as its music. On paper: fixed A4 / Letter pages.
  const pageHeight = paper ? Math.round(pageWidth * paper) : Math.round(pageWidth * 2.6);
  return {
    pageWidth, pageHeight, scale, adjustPageHeight: !paper, breaks: 'auto', footer: 'none', header: 'auto',
    svgViewBox: true, svgBoundingBoxes: false, lyricSize, pageMarginLeft: 30, pageMarginRight: 30, pageMarginTop: 30, pageMarginBottom: 30,
    spacingSystem: 14, spacingStaff: 10, harmDist: 1.2, mnumInterval: 0, condense: 'auto', justifyVertically: false, xmlIdSeed: 1,
  };
}

/**
 * Renders MusicXML as SVG pages. Returns {pages: [svg], ms}.
 *   width: the width in CSS pixels it will be shown at; scale: Verovio's zoom (34-40 reads well);
 *   paper: null for the screen, or the page's height / width (1.414 = A4) for printing and PDF;
 *   lane: 'score' (whole pieces) or 'edit' (the note editor); key: who is drawing (a newer drawing with the same
 *   key replaces one still waiting, which then rejects with e.superseded); onPage(svg, i, n): each page as it is ready.
 */
export async function renderMusicXML(xml, opts = {}) {
  const t0 = performance.now();
  const options = optionsFor(opts);
  const ck = opts.paper ? null : cacheKey(xml, options);
  if (ck && CACHE.has(ck)) {
    const pages = CACHE.get(ck);
    CACHE.delete(ck); CACHE.set(ck, pages);
    pages.forEach((p, i) => opts.onPage?.(p, i, pages.length));
    return { pages, ms: 0, cached: true };
  }
  let pages;
  try {
    pages = await inWorker(xml, options, { laneName: opts.lane || 'score', key: opts.key || null, onPage: opts.onPage || null });
  } catch (e) {
    if (!e.worker) throw e;                       // the score itself could not be drawn (or a newer drawing replaced it)
    const tk = await loadVerovio();
    tk.setOptions(options);
    if (!tk.loadData(xml)) throw new Error('The notation engine could not read this score.');
    pages = [];
    const n = tk.getPageCount();
    for (let p = 1; p <= n; p++) { pages.push(tk.renderToSVG(p, false)); opts.onPage?.(pages[p - 1], p - 1, n); }
  }
  if (ck) {
    CACHE.set(ck, pages);
    let size = 0;
    for (const v of CACHE.values()) size += v.reduce((a, b) => a + b.length, 0);
    while (CACHE.size > 1 && (CACHE.size > 6 || size > 12e6)) { const k0 = CACHE.keys().next().value; size -= CACHE.get(k0).reduce((a, b) => a + b.length, 0); CACHE.delete(k0); }
  }
  return { pages, ms: Math.round(performance.now() - t0) };
}

/** Width and height of a rendered page (from its viewBox), so the page can hold its place before it is drawn. */
export function pageSize(svg) {
  const m = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*"/.exec(svg.slice(0, 600));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}
