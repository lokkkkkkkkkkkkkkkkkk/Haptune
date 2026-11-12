// App state, persistence and library actions.
import { useEffect, useReducer } from 'preact/hooks';
import { db, local } from './storage.js';
import { parseMusicXML, writeMusicXML, describeScore } from '../core/musicxml.js';
import { parseABC } from '../core/abc.js';
import { parseChordSheet, toChordPro } from '../core/chordsheet.js';
import { SONGS, songTitle } from '../data/songs.js';
import { concertKey } from '../core/score.js';
import { keyName } from '../core/pitch.js';
import { setLang, detectLang } from '../core/i18n.js';
import { levelFor } from '../core/academy.js';
import { estimateKey, difficulty } from '../core/analysis.js';

const listeners = new Set();
let state = {
  ready: false,
  settings: {
    name: '', instrument: 'violin', voice: 'tenor', voiceRange: null, lang: detectLang(), theme: 'system', dailyGoal: 20, wifiOnly: true,
    server: '', showRoles: true, chordView: 'guitar', syncMs: 0,
  },
  plus: false,          // a paid plan (Plus, Pro) or the developer, from the account on the server
  me: null,             // the Haptune account (community, classes, plan), see account.js
  communitySeg: 'home',
  pieces: [],
  history: [],
  progress: { xp: 0, lessons: {}, badges: [], days: [], minutes: {}, quizzes: 0, challengeWins: 0 },
  examples: false,
  tab: 'summary',
  stacks: { summary: [], library: [], community: [], academy: [], me: [] },
  sheet: null,
  toast: null,
};

export const getState = () => state;
export function setState(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
export function useApp() {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => { listeners.add(force); return () => listeners.delete(force); }, []);
  return state;
}

// ---------- navigation ----------
const TAB_IDS = ['summary', 'library', 'community', 'academy', 'me'];
/** Goes to a tab; anything else (improvise, tools...) is a screen opened on top of the current tab. */
export function go(tab) { if (TAB_IDS.includes(tab)) setState({ tab }); else push(tab); }
/** Learn: courses, classes, tutors. */
export function goLearn() { setState({ tab: 'academy' }); }
/** Hooks the app shell fills in (keeps this file free of network code). */
export const hooks = { practice: null };
export function push(view, props = {}, tab = state.tab) {
  if (!state.stacks[tab]) tab = state.tab;
  setState((s) => ({ tab, stacks: { ...s.stacks, [tab]: [...s.stacks[tab], { view, props, key: Math.random().toString(36).slice(2) }] } }));
}
export function pop(tab = state.tab) { setState((s) => ({ stacks: { ...s.stacks, [tab]: s.stacks[tab].slice(0, -1) } })); }
export function popToRoot(tab = state.tab) { setState((s) => ({ stacks: { ...s.stacks, [tab]: [] } })); }
export function openSheet(type, props = {}) { setState({ sheet: { type, props } }); }
export function closeSheet() { setState({ sheet: null }); }
let toastTimer = null;
export function toast(text, kind = 'ok') {
  setState({ toast: { text, kind, id: Date.now() } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: null }), 2600);
}

// ---------- settings ----------
export function updateSettings(patch) {
  const settings = { ...state.settings, ...patch };
  if (patch.lang) setLang(patch.lang);
  local.set('settings', settings);
  setState({ settings });
  applyTheme(settings.theme);
}
export function applyTheme(theme) {
  try {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
  } catch { /* no DOM */ }
}
export function setPlus(on) { setState({ plus: on }); }

// ---------- library ----------
const pieceCache = new Map();
const today = () => new Date().toISOString().slice(0, 10);

function metaOf(rec) {
  const { xml, chordpro, pdf, pdfText, ...meta } = rec;
  void xml; void chordpro; void pdf; void pdfText;
  return meta;
}

export async function loadAll() {
  const settings = { ...state.settings, ...local.get('settings', {}) };
  if (settings.name === 'Alex' && !local.get('nameFixed', false)) settings.name = '';   // the old placeholder, not a real name
  local.set('nameFixed', true);
  setLang(settings.lang);
  applyTheme(settings.theme);
  const progress = { ...state.progress, ...local.get('progress', {}) };
  const me = local.get('me', null);
  const plus = ['plus', 'pro', 'dev'].includes(me?.tier);
  const firstRun = !local.get('started', false);
  let pieces = await db.all('pieces');
  let history = await db.all('history');
  if (firstRun && !pieces.length) {
    for (const id of ['twinkle', 'odetojoy', 'amazinggrace', 'canon']) await addSongbookSong(id, { silent: true });
    await addExampleSheet();
    await seedExamples();
    pieces = await db.all('pieces');
    history = await db.all('history');
    local.set('started', true);
  }
  setState({ ready: true, settings, progress, plus, me, pieces: pieces.map(metaOf).sort((a, b) => (b.opened || b.created) - (a.opened || a.created)), history: history.sort((a, b) => a.date - b.date), examples: history.some((h) => h.example) });
}

async function savePiece(rec) {
  await db.put('pieces', rec);
  pieceCache.delete(rec.id);
  setState((s) => ({ pieces: [metaOf(rec), ...s.pieces.filter((p) => p.id !== rec.id)] }));
  if ((state.pieces.length >= 10) && !state.progress.badges.includes('collector')) awardBadge('collector');
  return rec;
}

const newPieceId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export async function addScore(score, { source = 'import', fmt = 'musicxml', title, songId, extra = {} } = {}) {
  const xml = writeMusicXML(score);
  const key = concertKey(score);
  const info = describeScore(score);
  const rec = {
    id: newPieceId(), kind: 'score', source, fmt, songId: songId || null,
    title: title || score.title || 'Untitled', composer: score.composer || '', key, keyText: keyName(key),
    instrument: score.parts[0]?.instrument || 'piano', parts: score.parts.length, measures: score.measures.length,
    chords: info.chordSymbols, lyrics: info.lyrics > 0, difficulty: difficulty(score), tempo: score.measures[0]?.tempo || null,
    created: Date.now(), opened: null, favorite: false, best: null, xml, ...extra,
  };
  return savePiece(rec);
}

export async function addSheet(sheet, { source = 'import', fmt = 'chordpro', title, extra = {} } = {}) {
  const chordpro = toChordPro(sheet);
  const rec = {
    id: newPieceId(), kind: 'sheet', source, fmt, title: title || sheet.title || 'Chord sheet', composer: sheet.artist || '',
    key: sheet.key, keyText: sheet.key ? keyName(sheet.key) : '', created: Date.now(), opened: null, favorite: false, chordpro, ...extra,
  };
  return savePiece(rec);
}

export async function addPdf(bytes, { title, sheet = null, pages = 0 } = {}) {
  const rec = {
    id: newPieceId(), kind: 'pdf', source: 'import', fmt: 'pdf', title: title || 'PDF', composer: sheet?.artist || '',
    key: sheet?.key || null, keyText: sheet?.key ? keyName(sheet.key) : '', created: Date.now(), opened: null, favorite: false,
    pdf: bytes, chordpro: sheet ? toChordPro(sheet) : null, pages,
  };
  return savePiece(rec);
}

export async function addSongbookSong(songId, { silent = false } = {}) {
  const song = SONGS.find((s) => s.id === songId);
  if (!song) return null;
  const existing = state.pieces.find((p) => p.songId === songId);
  if (existing) return existing;
  const score = parseABC(song.abc, { instrument: 'voice' });
  score.title = songTitle(song, 'en');
  const rec = await addScore(score, { source: 'songbook', fmt: 'abc', songId, extra: { level: song.level, tags: song.tags } });
  if (!silent) toast(score.title);
  return rec;
}

async function addExampleSheet() {
  const text = `{title: Amazing Grace}\n{artist: John Newton (words), traditional melody}\n{key: G}\n\n{start_of_verse: Verse 1}\nA[G]mazing [G7]grace, how [C]sweet the [G]sound\nThat saved a wretch like [D]me\nI [G]once was [G7]lost, but [C]now am [G]found\nWas [Em]blind, but [D]now I [G]see\n{end_of_verse}\n`;
  const sheet = parseChordSheet(text);
  return addSheet(sheet, { source: 'example', fmt: 'chordpro', title: 'Amazing Grace (chords)' });
}

/** Example practice history so Summary is not empty on first launch. Marked example and removable. */
async function seedExamples() {
  const day = 86400000;
  const base = Date.now() - 6 * day;
  const scores = [0.71, 0.76, 0.74, 0.82, 0.85, 0.88, 0.91];
  for (let i = 0; i < 7; i++) {
    if (i === 2) continue;
    await db.put('history', { id: 'ex' + i, pieceId: null, title: i % 2 ? 'Ode to Joy' : 'Twinkle, Twinkle, Little Star', date: base + i * day + 18 * 3600000, seconds: (12 + (i * 7) % 15) * 60, accuracy: scores[i], inTune: scores[i] - 0.06, example: true });
  }
}

export async function clearExamples() {
  for (const h of state.history.filter((x) => x.example)) await db.del('history', h.id);
  setState((s) => ({ history: s.history.filter((h) => !h.example), examples: false }));
}

export async function getPiece(id) {
  if (pieceCache.has(id)) return pieceCache.get(id);
  const rec = await db.get('pieces', id);
  if (!rec) return null;
  const out = { rec };
  if (rec.kind === 'score' && rec.xml) out.score = parseMusicXML(rec.xml);
  if (rec.chordpro) out.sheet = parseChordSheet(rec.chordpro);
  pieceCache.set(id, out);
  return out;
}

export async function updatePiece(id, patch) {
  const rec = await db.get('pieces', id);
  if (!rec) return;
  const next = { ...rec, ...patch };
  await db.put('pieces', next);
  pieceCache.delete(id);
  setState((s) => ({ pieces: s.pieces.map((p) => (p.id === id ? metaOf(next) : p)) }));
}

export async function deletePiece(id) {
  await db.del('pieces', id);
  pieceCache.delete(id);
  setState((s) => ({ pieces: s.pieces.filter((p) => p.id !== id) }));
}

export function markOpened(id) {
  const p = state.pieces.find((x) => x.id === id);
  if (!p) return;
  updatePiece(id, { opened: Date.now() });
}

// ---------- practice and progress ----------
function saveProgress(progress) { local.set('progress', progress); setState({ progress }); }

export function logMinutes(seconds) {
  if (seconds < 5) return;
  if (state.examples) clearExamples();             // the first real practice replaces the example week
  const d = today();
  const p = state.progress;
  const minutes = { ...p.minutes, [d]: (p.minutes[d] || 0) + seconds / 60 };
  const days = p.days.includes(d) ? p.days : [...p.days, d];
  saveProgress({ ...p, minutes, days, xp: p.xp + Math.round(seconds / 60) * 5 });
  checkStreakBadges();
  try { hooks.practice?.(seconds / 60); } catch { /* offline: the streak on this device still counts */ }
}

export async function recordTake(take) {
  const rec = { id: 'h' + Date.now().toString(36), date: Date.now(), ...take };
  await db.put('history', rec);
  setState((s) => ({ history: [...s.history, rec] }));
  logMinutes(take.seconds || 0);
  if (take.pieceId && take.accuracy !== undefined) {
    const p = state.pieces.find((x) => x.id === take.pieceId);
    const best = Math.round(take.accuracy * 100);
    if (p && (p.best === null || best > p.best)) updatePiece(take.pieceId, { best });
  }
}

export function addXP(n) {
  const p = state.progress;
  const before = levelFor(p.xp).level;
  const d = today();
  const days = p.days.includes(d) ? p.days : [...p.days, d];
  saveProgress({ ...p, xp: p.xp + n, days });
  checkStreakBadges();
  const after = levelFor(p.xp + n).level;
  return after > before ? after : null;
}

export function completeLesson(id, score, total) {
  const p = state.progress;
  const prev = p.lessons[id];
  const lessons = { ...p.lessons, [id]: { done: true, best: Math.max(prev?.best || 0, score), total, at: Date.now() } };
  saveProgress({ ...p, lessons, quizzes: p.quizzes + 1 });
  if (!p.badges.includes('first')) awardBadge('first');
  if (total && score === total && !state.progress.badges.includes('perfect')) awardBadge('perfect');
  if (id.startsWith('ear') && Object.keys(lessons).filter((k) => k.startsWith('ear')).length >= 4) awardBadge('ear');
}

export function awardBadge(id) {
  const p = state.progress;
  if (p.badges.includes(id)) return;
  saveProgress({ ...p, badges: [...p.badges, id] });
}

export function streakDays(progress = state.progress, history = state.history) {
  const days = new Set([...progress.days, ...history.map((h) => new Date(h.date).toISOString().slice(0, 10))]);
  let n = 0;
  const d = new Date();
  if (!days.has(d.toISOString().slice(0, 10))) d.setDate(d.getDate() - 1);
  while (days.has(d.toISOString().slice(0, 10))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function checkStreakBadges() {
  const s = streakDays();
  if (s >= 3) awardBadge('streak3');
  if (s >= 7) awardBadge('streak7');
}

export function minutesOn(dateStr) {
  const fromHistory = state.history.filter((h) => new Date(h.date).toISOString().slice(0, 10) === dateStr).reduce((s, h) => s + (h.seconds || 0) / 60, 0);
  const tracked = state.progress.minutes[dateStr] || 0;
  return Math.max(fromHistory, tracked);
}

// ---------- backup ----------
const toB64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;

export async function makeBackup() {
  const pieces = (await db.all('pieces')).map((p) => (p.pdf ? { ...p, pdf: toB64(p.pdf) } : p));
  const history = await db.all('history');
  return JSON.stringify({ app: 'Haptune', version: 1, created: new Date().toISOString(), settings: state.settings, progress: state.progress, pieces, history });
}

export async function restoreBackup(text) {
  const data = JSON.parse(text);
  if (data.app !== 'Haptune') throw new Error('This is not a Haptune backup.');
  for (const p of data.pieces || []) await db.put('pieces', p.pdf ? { ...p, pdf: fromB64(p.pdf) } : p);
  for (const h of data.history || []) await db.put('history', h);
  if (data.progress) saveProgress({ ...state.progress, ...data.progress });
  if (data.settings) updateSettings(data.settings);
  pieceCache.clear();
  await loadAll();
  return (data.pieces || []).length;
}

export async function eraseAll() {
  await db.clear();
  local.clear();
  pieceCache.clear();
  location.reload();
}

export { estimateKey };
