// The person's Melovyn account (shared by the community, Academy classes and plans) and the community API.
// A device gets an account the first time it goes online; nobody fills in a form to start.
import { call, hasServer, accountToken, ApiError } from './api.js';
import { local } from './storage.js';
import { getState, setState, openSheet, toast } from './state.js';
import { t } from '../core/i18n.js';

let loading = null;

/** Makes sure this device has an account; resolves to `me` (or null when offline / no server). */
export function ensureAccount({ fresh = false } = {}) {
  if (!hasServer()) return Promise.resolve(null);
  if (loading && !fresh) return loading;
  loading = (async () => {
    try {
      if (!accountToken()) {
        const r = await call('/c/auth/guest', { method: 'POST', json: { name: getState().settings.name || '' }, timeout: 30000 });
        local.set('academyToken', r.token);
        setMe(r.me);
        return r.me;
      }
      const me = await call('/c/me', { timeout: 30000 });
      setMe(me);
      return me;
    } catch (e) {
      if (e.status === 401) { local.set('academyToken', ''); loading = null; return ensureAccount(); }
      loading = null;
      return getState().me;
    }
  })();
  return loading;
}

export function setMe(me) {
  if (!me) return;
  local.set('me', me);
  const plus = ['plus', 'pro', 'dev'].includes(me.tier);
  setState({ me, plus });
}

export const refreshMe = () => ensureAccount({ fresh: true });
export const myTier = () => getState().me?.tier || 'free';
export const isDev = () => getState().me?.tier === 'dev';
/** Signed in with Google or a username and password (online features others see need it). */
export const isRegistered = () => !!getState().me?.registered;
export const hasPlan = (min = 'plus') => ({ free: 0, plus: 1, pro: 2, dev: 3 }[myTier()] || 0) >= ({ plus: 1, pro: 2 }[min] || 1);

/** Shows the plans when a feature needs one; returns true when it did. Use in catch blocks. */
export function planError(e) {
  if (e instanceof ApiError && e.signin) { openSheet('hubRole', { need: true }); return true; }
  if (e instanceof ApiError && e.plan) { openSheet('plans', { reason: e.plan }); return true; }
  if (e instanceof ApiError && e.detail?.code === 'credits') { toast(t('notEnoughCredits'), 'err'); return true; }
  return false;
}

/** Runs an API call and shows its error (or the plans) instead of throwing. */
export async function attempt(fn, { quiet = false } = {}) {
  try { return await fn(); } catch (e) {
    if (!planError(e) && !quiet) toast(e.message || String(e), 'err');
    return null;
  }
}

const q = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '' && v !== false) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export const C = {
  // account
  me: () => call('/c/me'),
  update: (body) => call('/c/me', { method: 'PATCH', json: body }).then((me) => { setMe(me); return me; }),
  setPassword: (handle, password) => call('/c/auth/password', { method: 'POST', json: { handle, password } }),
  login: async (handle, password) => {
    const r = await call('/c/auth/login', { method: 'POST', json: { handle, password, device: navigator.userAgent.slice(0, 60) }, token: '' });
    local.set('academyToken', r.token); local.set('academyUser', null); setMe(r.me);
    return r.me;
  },
  recover: async (handle, code, password) => {
    const r = await call('/c/auth/recover', { method: 'POST', json: { handle, code, password }, token: '' });
    local.set('academyToken', r.token); setMe(r.me);
    return r;
  },
  /** Sign in with Google: `credential` is the ID token Google's button gives the page. */
  google: async (credential) => {
    const r = await call('/c/auth/google', { method: 'POST', json: { credential, device: navigator.userAgent.slice(0, 60) } });
    local.set('academyToken', r.token); local.set('academyUser', null); setMe(r.me);
    return r.me;
  },
  pairStart: () => call('/c/auth/pair', { method: 'POST', token: '' }),
  pairPoll: (code) => call(`/c/auth/pair/${code}`, { token: '' }),
  pairApprove: (code) => call(`/c/auth/pair/${code}/approve`, { method: 'POST' }),
  pairDone: (r) => { local.set('academyToken', r.token); local.set('academyUser', null); setMe(r.me); return r.me; },
  logout: async () => {
    try { await call('/c/auth/logout', { method: 'POST' }); } catch { /* offline: forget it here anyway */ }
    local.set('academyToken', ''); local.set('me', null); local.set('academyUser', null);
    setState({ me: null, plus: false });
    loading = null;
  },
  deleteAccount: async () => {
    await call('/c/me', { method: 'DELETE' });
    local.set('academyToken', ''); local.set('me', null); local.set('academyUser', null);
    setState({ me: null, plus: false });
    loading = null;
  },
  dev: (code) => call('/c/me/dev', { method: 'POST', json: { code } }).then((me) => { setMe(me); return me; }),
  plans: () => call('/c/plans'),
  billingSync: () => call('/c/billing/sync', { method: 'POST' }).then((me) => { setMe(me); return me; }),
  billing: {
    options: () => call('/c/billing/options'),
    checkout: (product, period, currency) => call('/c/billing/stripe/checkout', { method: 'POST', json: { product, period, currency } }),
    sync: (session) => call('/c/billing/stripe/sync', { method: 'POST', json: { session } }).then((me) => { setMe(me); return me; }),
    portal: () => call('/c/billing/stripe/portal', { method: 'POST' }),
    manualStart: (product, period, method = 'duitnow') => call('/c/billing/manual', { method: 'POST', json: { product, period, method } }),
    manualPaid: (id, body) => call(`/c/billing/manual/${id}/paid`, { method: 'POST', json: body }),
  },
  tutors: {
    list: (params) => call(`/c/tutors${q(params)}`),
    get: (handle) => call(`/c/tutors/${encodeURIComponent(handle)}`),
    me: () => call('/c/tutor/me'),
    save: (body) => call('/c/tutor/me', { method: 'PUT', json: body }),
    ask: (body) => call('/c/lessons', { method: 'POST', json: body }),
    lessons: () => call('/c/lessons'),
    act: (id, body) => call(`/c/lessons/${id}`, { method: 'POST', json: body }),
  },
  wallet: () => call('/c/wallet'),
  plusWeek: () => call('/c/credits/plus-week', { method: 'POST' }).then((me) => { setMe(me); return me; }),
  practice: (minutes) => call('/c/practice', { method: 'POST', json: { minutes } }),
  notifications: () => call('/c/notifications'),
  readNotifications: (ids) => call('/c/notifications/read', { method: 'POST', json: { ids: ids || null } }),
  feedback: (body) => call('/c/feedback', { method: 'POST', json: body }),
  // Stage
  pulse: (practising = false) => call(`/c/pulse${q({ practising })}`, { timeout: 20000 }),
  search: (text) => call(`/c/search${q({ q: text })}`, { timeout: 20000 }),
  stage: () => call('/c/stage', { timeout: 30000 }),
  daily: () => call('/c/daily'),
  enterDaily: (body) => call('/c/daily/entry', { method: 'POST', json: body }),
  nudge: (handle) => call('/c/daily/nudge', { method: 'POST', json: { handle } }),
  emoji: (target, kind) => call('/c/emoji', { method: 'POST', json: { target, kind } }),
  emojiCounts: (targets) => call(`/c/emoji${q({ targets: targets.join(',') })}`),
  rewards: () => call('/c/rewards'),
  redeem: (item) => call('/c/rewards/redeem', { method: 'POST', json: { item } }).then((me) => { setMe(me); return me; }),
  home: () => call('/c/home'),
  posts: (params) => call(`/c/posts${q(params)}`),
  post: (id) => call(`/c/posts/${id}`),
  create: (body) => call('/c/posts', { method: 'POST', json: body, timeout: 90000 }),
  edit: (id, body) => call(`/c/posts/${id}`, { method: 'PATCH', json: body }),
  remove: (id) => call(`/c/posts/${id}`, { method: 'DELETE' }),
  want: (id, add = 0) => call(`/c/posts/${id}/want`, { method: 'POST', json: { add } }),
  unwant: (id) => call(`/c/posts/${id}/want`, { method: 'DELETE' }),
  claim: (id) => call(`/c/posts/${id}/claim`, { method: 'POST' }),
  unclaim: (id) => call(`/c/posts/${id}/claim`, { method: 'DELETE' }),
  spotlight: (id) => call(`/c/posts/${id}/spotlight`, { method: 'POST' }),
  publish: (id) => call(`/c/posts/${id}/publish`, { method: 'POST' }),
  reply: (id, body) => call(`/c/posts/${id}/replies`, { method: 'POST', json: body, timeout: 90000 }),
  accept: (rid, rating, thanks = '') => call(`/c/replies/${rid}/accept`, { method: 'POST', json: { rating, thanks } }),
  helpful: (rid) => call(`/c/replies/${rid}/helpful`, { method: 'POST' }),
  changes: (rid, note) => call(`/c/replies/${rid}/changes`, { method: 'POST', json: { note } }),
  removeReply: (rid) => call(`/c/replies/${rid}`, { method: 'DELETE' }),
  react: (target, kind = 'like') => call('/c/react', { method: 'POST', json: { target, kind } }),
  fileText: async (fid) => (await call(`/c/files/${fid}`, { raw: true })).text(),
  fileBlobURL: async (fid) => URL.createObjectURL(await (await call(`/c/files/${fid}`, { raw: true })).blob()),
  profile: (handle) => call(`/c/users/${encodeURIComponent(handle)}`),
  follow: (handle, on = true) => call(`/c/users/${encodeURIComponent(handle)}/follow`, { method: on ? 'POST' : 'DELETE' }),
  block: (handle, on = true) => call(`/c/users/${encodeURIComponent(handle)}/block`, { method: on ? 'POST' : 'DELETE' }),
  blocks: () => call('/c/blocks'),
  leaderboard: (board, period) => call(`/c/leaderboard${q({ board, period })}`),
  challenge: () => call('/c/challenge'),
  enterChallenge: (body) => call('/c/challenge/entry', { method: 'POST', json: body }),
  report: (target, reason, note = '') => call('/c/report', { method: 'POST', json: { target, reason, note } }),
  // developer
  admin: {
    overview: () => call('/c/admin/overview'),
    reports: () => call('/c/admin/reports'),
    handle: (id, action) => call(`/c/admin/reports/${id}`, { method: 'POST', json: { action } }),
    feedback: (status = 'new') => call(`/c/admin/feedback${q({ status })}`),
    feedbackUpdate: (id, status, note = '') => call(`/c/admin/feedback/${id}`, { method: 'POST', json: { status, note } }),
    tutors: (status = 'pending') => call(`/c/admin/tutors${q({ status })}`),
    decideTutor: (handle, action, note = '') => call(`/c/admin/tutors/${encodeURIComponent(handle)}`, { method: 'POST', json: { action, note } }),
    payments: (status = 'pending') => call(`/c/admin/payments${q({ status })}`),
    decidePayment: (id, action, note = '') => call(`/c/admin/payments/${id}`, { method: 'POST', json: { action, note } }),
    grant: (handle, tier, days) => call('/c/admin/grant', { method: 'POST', json: { handle, tier, days } }),
    credits: (handle, delta, note) => call('/c/admin/credits', { method: 'POST', json: { handle, delta, note } }),
    role: (handle, role) => call(`/c/admin/users/${encodeURIComponent(handle)}/role`, { method: 'POST', json: { role } }),
  },
};

/** Reads a File as base64 (attachments); photos are shrunk to about 1600 px so they stay small. */
export async function fileToAttachment(file) {
  let blob = file;
  if (/^image\//.test(file.type) && file.size > 600 * 1024) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.82));
    } catch { /* keep the original */ }
  }
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { name: file.name || 'photo.jpg', mime: blob.type || file.type || 'image/jpeg', data: btoa(bin), size: buf.length };
}
