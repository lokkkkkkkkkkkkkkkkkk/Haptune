// Every string the interface asks for by a fixed key exists (a missing key shows its raw name on screen).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { t, setLang } from '../src/core/i18n.js';

const files = [];
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(f)) files.push(p); } };
walk(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'ui'));

test('every t(\'key\') used in the interface has a string', () => {
  setLang('zh-Hans');            // English strings can equal their key ("min"); the Chinese ones never do
  const missing = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?<![A-Za-z0-9_.$])t\('([A-Za-z][A-Za-z0-9_]*)'(?!\s*\+)/g)) if (t(m[1]) === m[1]) missing.add(`${m[1]} (${path.basename(f)})`);
  }
  setLang('en');
  assert.deepEqual([...missing], []);
});
