// Talks to the Haptune server. The address is built into the app (HAPTUNE_CONFIG.server, set once by the
// developer), and each device gets an anonymous id, so people never type a server address or a key.
import { local } from './storage.js';

const CFG = () => globalThis.HAPTUNE_CONFIG || {};

export function serverURL() {
  const custom = (local.get('settings', {}).server || '').trim();
  return (custom || CFG().server || '').replace(/\/+$/, '');
}
export const hasServer = () => !!serverURL();

export function deviceId() {
  let id = local.get('device', '');
  if (!id) {
    id = (globalThis.crypto?.randomUUID?.() || `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
    local.set('device', id);
  }
  return id;
}

export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

const NO_SERVER = 'Online features are not available in this version yet.';

async function call(path, { method = 'GET', json, form, token, raw = false, timeout = 120000 } = {}) {
  const base = serverURL();
  if (!base) throw new ApiError(NO_SERVER, 0);
  const headers = { 'X-Haptune-Device': deviceId() };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(base + path, { method, headers, body, signal: ctl.signal });
  } catch (e) {
    throw new ApiError(e.name === 'AbortError' ? 'The server took too long. Please try again.' : 'Could not reach Haptune online. Check your connection.', 0);
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const j = await res.json(); msg = j.detail || j.message || msg; } catch { /* not JSON */ }
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
    throw new ApiError(msg, res.status);
  }
  return raw ? res : res.json();
}

let statusCache = null;
/** {ai, model, reads_per_day, ...} or {ai:false} when there is no server. Cached for the session. */
export async function aiStatus({ fresh = false } = {}) {
  if (!hasServer()) return { ai: false, offline: true };
  if (statusCache && !fresh) return statusCache;
  try { statusCache = await call('/ai/status', { timeout: 15000 }); } catch { statusCache = { ai: false, offline: true }; }
  return statusCache;
}

/**
 * Reads sheet music (PDF or photos) with AI. `onProgress({stage, progress, message})` is called while it works.
 * Resolves to {musicxml, flags, report}.
 */
export async function readSheetMusic(files, hints = {}, onProgress = () => {}, { signal } = {}) {
  const list = Array.isArray(files) ? files : [files];
  const form = new FormData();
  list.forEach((f, i) => form.append(i === 0 ? 'file' : 'more', f, f.name || `page${i + 1}.jpg`));
  for (const [k, v] of Object.entries(hints)) if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
  const { id } = await call('/ai/read', { method: 'POST', form, timeout: 180000 });
  let wait = 900;
  for (;;) {
    if (signal?.aborted) throw new ApiError('Cancelled', 0);
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(2000, wait + 150);
    const st = await call(`/jobs/${id}`, { timeout: 20000 });
    onProgress(st);
    if (st.status === 'done') return call(`/jobs/${id}/result`, { timeout: 60000 });
    if (st.status === 'error') throw new ApiError(st.message || 'The music could not be read.', 500);
  }
}

/** Finds sheet music online for a song name or a YouTube / Spotify / Apple Music link. */
export function findMusic({ query = '', link = '', instrument = '' }) {
  return call('/ai/find', { method: 'POST', json: { query, link, instrument }, timeout: 240000 });
}

/** Downloads one found file through the server. Resolves to a File the importer understands. */
export async function fetchMusicFile(url) {
  const res = await call(`/ai/fetch?url=${encodeURIComponent(url)}`, { raw: true, timeout: 90000 });
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] || url.split('/').pop().split('?')[0] || 'download';
  return new File([blob], name, { type: blob.type });
}

/** The YouTube id in a link, or null. */
export function youtubeId(text) {
  const m = /https?:\/\/\S+/.exec(text || '');
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    const host = u.hostname.toLowerCase();
    let id = null;
    if (host.endsWith('youtu.be')) id = u.pathname.split('/')[1];
    else if (host.includes('youtube.com') || host.includes('youtube-nocookie.com')) id = u.searchParams.get('v') || (/^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname) || [])[1];
    return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
  } catch { return null; }
}
export const isLink = (text) => /https?:\/\/\S+/.test(text || '');

// ---------------- Academy classes ----------------
function academyToken() { return local.get('academyToken', ''); }

/** The device's Academy profile, made on first use (no password). */
export async function academyMe(name) {
  let token = academyToken();
  if (!token) {
    const r = await call('/academy/me', { method: 'POST', json: { name: name || '' } });
    token = r.token;
    local.set('academyToken', token);
  }
  try {
    return await call('/academy/me', { token });
  } catch (e) {
    if (e.status === 401) { local.set('academyToken', ''); return academyMe(name); }
    throw e;
  }
}
export const academy = {
  rename: (name) => call('/academy/me', { method: 'PATCH', json: { name }, token: academyToken() }),
  createClass: (name, description = '') => call('/academy/classes', { method: 'POST', json: { name, description }, token: academyToken() }),
  join: (code) => call('/academy/join', { method: 'POST', json: { code }, token: academyToken() }),
  classDetail: (id) => call(`/academy/classes/${id}`, { token: academyToken() }),
  leave: (cid, uid) => call(`/academy/classes/${cid}/members/${uid}`, { method: 'DELETE', token: academyToken() }),
  createAssignment: (cid, body) => call(`/academy/classes/${cid}/assignments`, { method: 'POST', json: body, token: academyToken() }),
  assignment: (id) => call(`/academy/assignments/${id}`, { token: academyToken() }),
  deleteAssignment: (id) => call(`/academy/assignments/${id}`, { method: 'DELETE', token: academyToken() }),
  submit: (id, body) => call(`/academy/assignments/${id}/submissions`, { method: 'POST', json: body, token: academyToken() }),
  feedback: (sid, body) => call(`/academy/submissions/${sid}/feedback`, { method: 'POST', json: body, token: academyToken() }),
  feed: (cid) => call(`/academy/classes/${cid}/feed`, { token: academyToken() }),
  leaderboard: (cid) => call(`/academy/classes/${cid}/leaderboard`, { token: academyToken() }),
  recordingURL: async (sid) => {
    const res = await call(`/academy/submissions/${sid}/recording`, { raw: true, token: academyToken() });
    return URL.createObjectURL(await res.blob());
  },
  linkCode: () => call('/academy/me/link-code', { method: 'POST', token: academyToken() }),
  claim: async (code) => {
    const r = await call('/academy/me/claim', { method: 'POST', json: { code } });
    local.set('academyToken', r.token);
    return r;
  },
};
