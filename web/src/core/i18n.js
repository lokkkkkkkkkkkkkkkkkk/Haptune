// Interface text: [English, Bahasa Melayu, 简体中文, 繁體中文]. {name} placeholders are filled by t().
import { BASE, INSTR } from './i18n-base.js';
import { MORE } from './i18n-community.js';
import { V2 } from './i18n-v2.js';
import { V3 } from './i18n-v3.js';
import { V4 } from './i18n-v4.js';
import { V5 } from './i18n-v5.js';
import { V6 } from './i18n-v6.js';
import { V7 } from './i18n-v7.js';
import { V8 } from './i18n-v8.js';
import { V9 } from './i18n-v9.js';
import { V10 } from './i18n-v10.js';
import { V11 } from './i18n-v11.js';
import { V12 } from './i18n-v12.js';
import { V13 } from './i18n-v13.js';
import { V14 } from './i18n-v14.js';
import { V15 } from './i18n-v15.js';
import { V16 } from './i18n-v16.js';
export const LANGS = [
  { id: 'en', name: 'English' }, { id: 'ms', name: 'Bahasa Melayu' }, { id: 'zh-Hans', name: '简体中文' }, { id: 'zh-Hant', name: '繁體中文' },
];
const I = { en: 0, ms: 1, 'zh-Hans': 2, 'zh-Hant': 3 };

const S = { ...BASE };
Object.assign(S, MORE, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12, V13, V14, V15, V16);                // community, accounts, plans and help (i18n-community.js)

let lang = 'en';
export function setLang(l) { lang = I[l] !== undefined ? l : 'en'; }
// The web app ships English only; the other languages come as a small file the first time they are needed
// (i18n/<lang>.json, cached offline). Source tables (tests, the one-file version) already have every language.
const loaded = new Set(['en']);
export async function loadLang(l) {
  const i = I[l];
  if (!i || loaded.has(l)) return;
  if (S.done?.[i] !== undefined) { loaded.add(l); return; }
  const cfg = globalThis.HAPTUNE_CONFIG || {};
  const r = await fetch(`${cfg.i18n || 'i18n/'}${l}.json?v=${cfg.build || ''}`);
  if (!r.ok) throw new Error(`language ${l}: ${r.status}`);
  const pack = await r.json();
  for (const [k, v] of Object.entries(pack.s || {})) if (S[k]) S[k][i] = v;
  for (const [k, v] of Object.entries(pack.i || {})) if (INSTR[k]) INSTR[k][i] = v;
  loaded.add(l);
}
/** Every row (the build splits them into language files; tools/i18n-check.mjs reads them). */
export const allRows = () => ({ S, INSTR });
export function getLang() { return lang; }
/** True when the key has a translation row (used by tools/i18n-check.mjs). */
export const hasKey = (k) => Object.prototype.hasOwnProperty.call(S, k);
export function t(key, vars) {
  const row = S[key];
  let s = row ? (row[I[lang]] ?? row[0]) : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
export function instrumentName(k) { const row = INSTR[k]; return row ? (row[I[lang]] ?? row[0]) : k; }
export const INSTRUMENTS = Object.keys(INSTR);
export function detectLang() {
  const n = (globalThis.navigator?.language || 'en').toLowerCase();
  if (n.startsWith('ms') || n.startsWith('id')) return 'ms';
  if (n.startsWith('zh')) return /hant|tw|hk|mo/.test(n) ? 'zh-Hant' : 'zh-Hans';
  return 'en';
}
