// Lists interface text keys used in the app that have no translation (run: node tools/i18n-check.mjs).
// Keys built at run time, like t(`plan_${tier}`), are listed as patterns to check by eye.
import fs from 'node:fs';
import path from 'node:path';
import { hasKey, setLang } from '../src/core/i18n.js';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(f)) files.push(p); } })(root);
setLang('en');
const missing = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?<![\w.])t\('([A-Za-z0-9_]+)'/g)) {
    if (!hasKey(m[1]) && !m[1].endsWith('_')) { if (!missing.has(m[1])) missing.set(m[1], path.relative(root, f)); }
  }
}
export const missingKeys = [...missing.keys()];
if (process.argv[1] && process.argv[1].endsWith('i18n-check.mjs')) {
  for (const [k, f] of missing) console.log(k.padEnd(28), f);
  console.log(missing.size ? `${missing.size} missing` : 'all keys translated');
}
