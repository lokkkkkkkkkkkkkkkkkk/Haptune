// Builds two outputs from the same source:
//   dist/artifact/haptune.html : one self-contained page (libraries from CDNs) for the Claude preview
//   dist/pages/                : installable PWA for GitHub Pages (offline, libraries vendored)
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const out = (...p) => path.join(root, 'dist', ...p);
fs.rmSync(out(), { recursive: true, force: true });
fs.mkdirSync(out('artifact'), { recursive: true });
fs.mkdirSync(out('pages', 'vendor'), { recursive: true });
fs.mkdirSync(out('pages', 'icons'), { recursive: true });

const result = await build({
  entryPoints: [path.join(root, 'src/main.jsx')], bundle: true, format: 'iife', minify: true, write: false,
  jsx: 'automatic', jsxImportSource: 'preact', target: ['es2020', 'safari15'], legalComments: 'none',
  loader: { '.css': 'text' },
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(root, 'src/ui/styles.css'), 'utf8');
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

// ---- artifact page (the publish skeleton adds doctype/head/body) ----
const artifact = `<title>Haptune</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="Music practice coach: exact imports, key change, chords, AI improviser and a teaching academy.">
<style>${css}</style>
<div id="haptune"></div>
<script>window.HAPTUNE_CONFIG={pwa:false,version:${JSON.stringify(VERSION)}};</script>
<script>${js}</script>
`;
fs.writeFileSync(out('artifact', 'haptune.html'), artifact);

// ---- PWA ----
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Haptune</title>
<meta name="description" content="Music practice coach: exact imports, key change, chords, AI improviser and a teaching academy.">
<meta name="theme-color" content="#F2F2F7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Haptune">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="icon" href="icons/icon-192.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);box-sizing:border-box;height:100%}${css}</style>
</head>
<body>
<div id="haptune"></div>
<script>window.HAPTUNE_CONFIG={pwa:true,version:${JSON.stringify(VERSION)},verovio:'vendor/verovio-toolkit-wasm.js',pdfjs:'vendor/pdf.min.js',pdfWorker:'vendor/pdf.worker.min.js'};</script>
<script src="app.js?v=${VERSION}"></script>
</body>
</html>
`;
fs.writeFileSync(out('pages', 'index.html'), html);
fs.writeFileSync(out('pages', 'app.js'), result.outputFiles[0].text);
fs.copyFileSync(path.join(root, 'node_modules/verovio/dist/verovio-toolkit-wasm.js'), out('pages', 'vendor', 'verovio-toolkit-wasm.js'));
fs.copyFileSync(path.join(root, 'node_modules/pdfjs-dist/build/pdf.min.js'), out('pages', 'vendor', 'pdf.min.js'));
fs.copyFileSync(path.join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.js'), out('pages', 'vendor', 'pdf.worker.min.js'));
for (const f of fs.readdirSync(path.join(root, 'assets/icons'))) fs.copyFileSync(path.join(root, 'assets/icons', f), out('pages', 'icons', f));
fs.writeFileSync(out('pages', 'manifest.webmanifest'), JSON.stringify({
  name: 'Haptune', short_name: 'Haptune', description: 'Music practice coach', start_url: './', scope: './', display: 'standalone',
  background_color: '#F2F2F7', theme_color: '#F2F2F7', orientation: 'any',
  icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
}, null, 2));
const cacheList = ['./', 'index.html', `app.js?v=${VERSION}`, 'manifest.webmanifest', 'vendor/verovio-toolkit-wasm.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'icons/apple-touch-icon.png', 'icons/icon-192.png'];
fs.writeFileSync(out('pages', 'sw.js'), `// Offline cache for Haptune (cache-first for the app shell, network-first for index.html)
const CACHE = 'haptune-${VERSION}';
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
fs.writeFileSync(out('pages', '.nojekyll'), '');
console.log('artifact', (artifact.length / 1024).toFixed(0), 'KB; app.js', (result.outputFiles[0].text.length / 1024).toFixed(0), 'KB');
