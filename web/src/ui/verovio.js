// Loads the Verovio engraver on demand and renders MusicXML to SVG sized for the screen.
const CFG = () => globalThis.HAPTUNE_CONFIG || {};
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
    s.src = CFG().verovio || 'https://cdn.jsdelivr.net/npm/verovio@6.3.0/dist/verovio-toolkit-wasm.js';
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

export const isVerovioReady = () => !!toolkit;

/** Renders MusicXML into one tall SVG page (or several for long pieces). Returns {pages: [svg], ms}. */
export async function renderMusicXML(xml, { width = 380, scale = 38, lyricSize = 4.5 } = {}) {
  const tk = await loadVerovio();
  const t0 = performance.now();
  const pageWidth = Math.max(500, Math.round(width * 100 / scale));
  tk.setOptions({
    pageWidth, pageHeight: 60000, scale, adjustPageHeight: true, breaks: 'auto', footer: 'none', header: 'auto',
    svgViewBox: true, svgBoundingBoxes: false, lyricSize, pageMarginLeft: 30, pageMarginRight: 30, pageMarginTop: 30, pageMarginBottom: 30,
    spacingSystem: 14, spacingStaff: 10, harmDist: 1.2, mnumInterval: 0, condense: 'auto', justifyVertically: false, xmlIdSeed: 1,
  });
  if (!tk.loadData(xml)) throw new Error('The notation engine could not read this score.');
  const pages = [];
  const n = tk.getPageCount();
  for (let p = 1; p <= n; p++) pages.push(tk.renderToSVG(p, false));
  return { pages, ms: Math.round(performance.now() - t0) };
}
