// Builds from the same source:
//   dist/artifact/haptune.html : one self-contained page (libraries from CDNs) for the Claude preview
//   dist/pages/                : the website (haptune.name.my): the landing page at /, legal pages,
//   dist/pages/app/            : and the app itself, an installable PWA (offline, libraries vendored)
//   dist/native/               : the Android app's files (Capacitor copies them into web/android)
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const out = (...p) => path.join(root, 'dist', ...p);
fs.rmSync(out(), { recursive: true, force: true });
fs.mkdirSync(out('artifact'), { recursive: true });
fs.mkdirSync(out('pages', 'app', 'vendor'), { recursive: true });
fs.mkdirSync(out('pages', 'app', 'icons'), { recursive: true });
fs.mkdirSync(out('pages', 'icons'), { recursive: true });
const app = (...p) => out('pages', 'app', ...p);

const result = await build({
  entryPoints: [path.join(root, 'src/main.jsx')], bundle: true, format: 'iife', minify: process.env.HAPTUNE_MINIFY !== '0', write: false,
  jsx: 'automatic', jsxImportSource: 'preact', target: ['es2020', 'safari15'], legalComments: 'none',
  loader: { '.css': 'text' },
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
// styles.css: layout and every component; theme.css: the Haptune 2 look on top of it
const css = fs.readFileSync(path.join(root, 'src/ui/styles.css'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'src/ui/theme.css'), 'utf8');
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
// The server address is built in (GitHub variable HAPTUNE_SERVER_URL -> HAPTUNE_SERVER), so people never type it.
const SERVER = (process.env.HAPTUNE_SERVER || '').trim().replace(/\/+$/, '');
if (SERVER && !/^https?:\/\/[^\s"'<>]+$/.test(SERVER)) throw new Error(`HAPTUNE_SERVER is not a web address: ${SERVER}`);
// Each build gets its own cache name, so an update reaches phones that have the app saved offline.
const BUILD = createHash('sha256').update(result.outputFiles[0].text).update(css).update(SERVER).digest('hex').slice(0, 10);
// Where the app is published and sold. Each can be set with a repository variable; the defaults are the real ones.
const SITE = (process.env.HAPTUNE_SITE_URL || 'https://haptune.name.my').trim().replace(/\/+$/, '');
const PLAY = (process.env.HAPTUNE_PLAY_URL || '').trim();           // the Google Play page, once the app is published
const CONFIG = (extra) => JSON.stringify({ version: VERSION, build: BUILD, server: SERVER, site: SITE, play: PLAY, ...extra });

// ---- artifact page (the publish skeleton adds doctype/head/body) ----
const artifact = `<title>Haptune</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="Music practice coach: exact imports, key change, chords, AI improviser and a teaching academy.">
<style>${css}</style>
<div id="haptune"></div>
<script>window.HAPTUNE_CONFIG=${CONFIG({ pwa: false })};</script>
<script>${js}</script>
`;
fs.writeFileSync(out('artifact', 'haptune.html'), artifact);

// ---- PWA (GitHub Pages) and the native app (Capacitor: Android now, iOS later) ----
const page = (config, { pwa }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Haptune</title>
<meta name="description" content="Get the sheet music for any song and practise it with an app that listens. Search a song, drop a PDF, or ask the Stage community.">
<meta name="theme-color" content="#F5F5FA" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0E0D15" media="(prefers-color-scheme: dark)">
${pwa ? `<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Haptune">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
` : ''}<link rel="icon" href="icons/icon-192.png">
<style>:root{padding-top:var(--sa-top);box-sizing:border-box;height:100%}${css}</style>
</head>
<body>
<div id="haptune"></div>
<script>window.HAPTUNE_CONFIG=${CONFIG(config)};</script>
<script src="app.js?v=${BUILD}"></script>
</body>
</html>
`;
const ASSETS = { verovio: 'vendor/verovio-toolkit-wasm.js', pdfjs: 'vendor/pdf.min.js', pdfWorker: 'vendor/pdf.worker.min.js', piano: 'piano/' };
const html = page({ pwa: true, ...ASSETS }, { pwa: true });
fs.writeFileSync(app('index.html'), html);
fs.writeFileSync(app('app.js'), result.outputFiles[0].text);
fs.copyFileSync(path.join(root, 'node_modules/verovio/dist/verovio-toolkit-wasm.js'), app('vendor', 'verovio-toolkit-wasm.js'));
fs.copyFileSync(path.join(root, 'node_modules/pdfjs-dist/build/pdf.min.js'), app('vendor', 'pdf.min.js'));
fs.copyFileSync(path.join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.js'), app('vendor', 'pdf.worker.min.js'));
for (const f of fs.readdirSync(path.join(root, 'assets/icons'))) {
  fs.copyFileSync(path.join(root, 'assets/icons', f), app('icons', f));
  fs.copyFileSync(path.join(root, 'assets/icons', f), out('pages', 'icons', f));
}
// Salamander Grand Piano V3 (Alexander Holm, CC BY 3.0), one sample every 3 semitones, trimmed (about 0.8 MB)
fs.mkdirSync(app('piano'), { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'assets/piano'))) fs.copyFileSync(path.join(root, 'assets/piano', f), app('piano', f));
// the free library: an index searched in the app, and the pieces themselves, fetched when one is opened
if (fs.existsSync(path.join(root, 'assets/catalog'))) fs.cpSync(path.join(root, 'assets/catalog'), app('catalog'), { recursive: true });
// how to pay by DuitNow QR (the picture is optional: without it the app shows the bank account only)
if (fs.existsSync(path.join(root, 'assets/pay'))) fs.cpSync(path.join(root, 'assets/pay'), app('pay'), { recursive: true });
fs.writeFileSync(app('manifest.webmanifest'), JSON.stringify({
  name: 'Haptune', short_name: 'Haptune', description: 'Sheet music for any song, and practice that listens', start_url: './', scope: './', display: 'standalone',
  background_color: '#F5F5FA', theme_color: '#6A4DFF', orientation: 'any', categories: ['music', 'education'],
  icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
}, null, 2));
const cacheList = ['./', 'index.html', `app.js?v=${BUILD}`, 'manifest.webmanifest', 'vendor/verovio-toolkit-wasm.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'icons/apple-touch-icon.png', 'icons/icon-192.png'];
fs.writeFileSync(app('sw.js'), `// Offline cache for Haptune (cache-first for the app shell, network-first for index.html)
const CACHE = 'haptune-app-${BUILD}';
const FILES = ${JSON.stringify(cacheList)};
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('index.html', copy)); return r; }).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })));
});
`);

// ---- the website: landing page and legal pages at the top of the site ----
const fill = (text) => text.replaceAll('{{BUILD}}', BUILD).replaceAll('{{VERSION}}', VERSION).replaceAll('{{SITE}}', SITE).replaceAll('{{PLAY}}', PLAY)
  .replaceAll('{{YEAR}}', String(new Date().getFullYear()));
for (const f of fs.readdirSync(path.join(root, 'site'))) {
  const src = path.join(root, 'site', f);
  if (fs.statSync(src).isDirectory()) { fs.cpSync(src, out('pages', f), { recursive: true }); continue; }
  if (/\.(html|txt|xml|webmanifest)$/.test(f)) fs.writeFileSync(out('pages', f), fill(fs.readFileSync(src, 'utf8')));
  else fs.copyFileSync(src, out('pages', f));
}
// the privacy policy, terms and refund policy (Google Play, the App Store and Stripe link to them)
for (const f of fs.readdirSync(path.join(root, 'assets/legal'))) fs.writeFileSync(out('pages', f), fill(fs.readFileSync(path.join(root, 'assets/legal', f), 'utf8')));
fs.writeFileSync(out('pages', '.nojekyll'), '');
// ---- native app: the same files without the service worker (the app is installed, not cached) ----
// Store keys are public by design (RevenueCat "public SDK key"); purchases are checked on the server.
const REVENUECAT = (process.env.HAPTUNE_REVENUECAT_ANDROID || '').trim();
fs.cpSync(app(), out('native'), { recursive: true, filter: (src) => !/(sw\.js|manifest\.webmanifest)$/.test(src) });
fs.writeFileSync(out('native', 'index.html'), page({ pwa: false, native: true, revenuecat: REVENUECAT, ...ASSETS }, { pwa: false }));
console.log('server', SERVER || '(none)', '| build', BUILD, '| artifact', (artifact.length / 1024).toFixed(0), 'KB; app.js', (result.outputFiles[0].text.length / 1024).toFixed(0), 'KB');
