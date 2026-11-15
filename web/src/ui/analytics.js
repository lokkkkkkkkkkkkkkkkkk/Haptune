// Usage statistics for the owner's dashboard, and feature flags. No third-party SDK: events are batched here
// and sent to our own server (POST /c/events) every 30 s and when the page is hidden. Only event names, the
// screen, a short label (a piece title, an error message) and a number (seconds, a score) are sent; never
// recordings, sheet contents or what people type. Switch off: Settings > Share usage statistics.
import { getState } from './state.js';
import { serverURL, hasServer, deviceId, accountToken } from './api.js';
import { local } from './storage.js';

const FLUSH_MS = 30000;
let queue = [];
let timer = 0;
let started = false;
let session = { start: 0, visibleSince: 0, visible: 0 };
let screen = { name: '', since: 0 };

export const trackingOn = () => hasServer() && getState().settings?.analytics !== false;

export function platform() {
  const cap = globalThis.Capacitor;
  if (cap?.isNativePlatform?.()) return cap.getPlatform?.() === 'ios' ? 'ios' : 'android';
  const standalone = globalThis.matchMedia?.('(display-mode: standalone)').matches || globalThis.navigator?.standalone;
  return standalone ? 'homescreen' : 'web';
}

/** Records an event: track('piece_open', { label: title }) or track('screen_time', { screen, value: seconds }). */
export function track(name, { screen: sc = '', label = '', value = null, props = null } = {}) {
  if (!trackingOn()) return;
  queue.push({ name, t: Date.now(), screen: String(sc || '').slice(0, 40), label: String(label || '').slice(0, 200), value: Number.isFinite(value) ? value : null, props });
  if (queue.length >= 100) flush();
}

export function flush({ leaving = false } = {}) {
  if (!queue.length || !hasServer()) return;
  const batch = queue.splice(0, 200);
  const tok = accountToken();
  const body = JSON.stringify({ events: batch, device: deviceId(), token: tok || '', platform: platform(), lang: navigator.language || '' });
  const url = `${serverURL()}/c/events`;
  try {
    // text/plain: no CORS preflight, so it also goes out while the page is closing
    if (leaving && navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) return;
    fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true }).catch(() => { queue = [...batch, ...queue].slice(-400); });
  } catch { /* offline: dropped */ }
}

/** The screen on show (called by the app when the tab or the top screen changes): screen_view + time on the last one. */
export function screenShown(name) {
  if (!name || name === screen.name) return;
  const now = Date.now();
  if (screen.name && screen.since) track('screen_time', { screen: screen.name, value: Math.round((now - screen.since) / 1000) });
  screen = { name, since: now };
  track('screen_view', { screen: name });
}

function visible(on) {
  const now = Date.now();
  if (on) { session.visibleSince = now; return; }
  if (session.visibleSince) session.visible += now - session.visibleSince;
  session.visibleSince = 0;
  if (screen.name && screen.since) { track('screen_time', { screen: screen.name, value: Math.round((now - screen.since) / 1000) }); screen.since = 0; }
  track('session_end', { value: Math.round(session.visible / 1000) });
  session = { start: now, visibleSince: 0, visible: 0 };
  flush({ leaving: true });
}

export function startTracking() {
  if (started) return;
  started = true;
  session = { start: Date.now(), visibleSince: Date.now(), visible: 0 };
  track('session_start');
  timer = setInterval(() => flush(), FLUSH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') visible(false);
    else { track('session_start'); visible(true); if (screen.name) screen.since = Date.now(); }
  });
  addEventListener('pagehide', () => { if (document.visibilityState !== 'hidden') visible(false); });
}

// ---------------------------------------------------------------- feature flags
// 'on' | 'beta' | 'off' | 'staff' (off for everyone else, shown to you in Developer mode). Unknown: on.
let flags = local.get('flags', {});
export async function loadFlags() {
  if (!hasServer()) return flags;
  try {
    const tok = accountToken();
    const res = await fetch(`${serverURL()}/c/flags`, { headers: { 'X-Haptune-Device': deviceId(), ...(tok ? { Authorization: `Bearer ${tok}` } : {}) } });
    if (res.ok) { flags = (await res.json()).flags || {}; local.set('flags', flags); }
  } catch { /* offline: the last flags we had */ }
  return flags;
}
export const flag = (key) => (flags[key] ?? 'on') !== 'off';
export const flagState = (key) => flags[key] ?? 'on';
export const _setFlagsForTest = (f) => { flags = f; };
