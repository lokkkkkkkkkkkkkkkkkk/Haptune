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

// ---------------- the worker ----------------
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
    if (!xml) { self.postMessage({ id, pages: [] }); return; }
    tk.setOptions(options);
    if (!tk.loadData(xml)) throw new Error('The notation engine could not read this score.');
    const n = tk.getPageCount();
    const pages = [];
    for (let p = 1; p <= n; p++) pages.push(tk.renderToSVG(p, false));
    self.postMessage({ id, pages });
  } catch (e) { self.postMessage({ id, error: String((e && e.message) || e) }); }
};`;

let worker = null, workerOff = false, seq = 0, warmed = false;
const jobs = new Map();

function getWorker() {
  if (workerOff || typeof Worker === 'undefined' || typeof Blob === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
    worker.onmessage = (ev) => {
      const job = jobs.get(ev.data.id);
      if (!job) return;
      jobs.delete(ev.data.id);
      clearTimeout(job.timer);
      if (ev.data.error) job.reject(new Error(ev.data.error)); else job.resolve(ev.data.pages);
    };
    worker.onerror = () => failWorker();
  } catch { workerOff = true; worker = null; }
  return worker;
}
function failWorker() {
  workerOff = true;
  try { worker?.terminate(); } catch { /* gone */ }
  worker = null;
  for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(Object.assign(new Error('worker'), { worker: true })); }
  jobs.clear();
}
function inWorker(xml, options) {
  const w = getWorker();
  if (!w) return Promise.reject(Object.assign(new Error('worker'), { worker: true }));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    // a worker that never answers (blocked WebAssembly, a broken download) must not leave the screen waiting
    const timer = setTimeout(() => { if (jobs.has(id)) failWorker(); }, warmed ? 45000 : 60000);
    jobs.set(id, { resolve: (p) => { warmed = true; resolve(p); }, reject, timer });
    w.postMessage({ id, url: SRC(), xml, options });
  });
}

/** Starts the engraver early (while the player reads the screen), so the first score appears sooner. */
export function warmVerovio() { if (!warmed) inWorker('', {}).catch(() => {}); }

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
 *   paper: null for the screen, or the page's height / width (1.414 = A4) for printing and PDF.
 */
export async function renderMusicXML(xml, opts = {}) {
  const t0 = performance.now();
  const options = optionsFor(opts);
  let pages;
  try {
    pages = await inWorker(xml, options);
  } catch (e) {
    if (!e.worker) throw e;                       // the score itself could not be drawn
    const tk = await loadVerovio();
    tk.setOptions(options);
    if (!tk.loadData(xml)) throw new Error('The notation engine could not read this score.');
    pages = [];
    const n = tk.getPageCount();
    for (let p = 1; p <= n; p++) pages.push(tk.renderToSVG(p, false));
  }
  return { pages, ms: Math.round(performance.now() - t0) };
}

/** Width and height of a rendered page (from its viewBox), so the page can hold its place before it is drawn. */
export function pageSize(svg) {
  const m = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*"/.exec(svg.slice(0, 600));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}
