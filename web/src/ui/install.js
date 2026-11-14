// "Install Melovyn" on computers and Android browsers: the browser offers it (beforeinstallprompt) and we
// keep the offer until the person asks for it. iPhone and iPad have no such offer; there the app explains
// Share > Add to Home Screen instead.
import { openSheet } from './state.js';

let offer = null;
const listeners = new Set();
const tell = () => listeners.forEach((fn) => fn(canInstall()));

if (typeof addEventListener === 'function') {
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); offer = e; tell(); });
  addEventListener('appinstalled', () => { offer = null; tell(); });
}

export const isStandalone = () => !!(globalThis.matchMedia?.('(display-mode: standalone)').matches || globalThis.navigator?.standalone);
export const isIOS = () => { const n = globalThis.navigator; return !!n && (/iPad|iPhone|iPod/.test(n.userAgent || '') || (n.platform === 'MacIntel' && n.maxTouchPoints > 1)); };
/** True when there is something useful to offer: the browser's own install, or the iPhone instructions. */
export const canInstall = () => !isStandalone() && (!!offer || isIOS());
export function onInstallChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export async function promptInstall() {
  if (offer) {
    const o = offer; offer = null; tell();
    try { await o.prompt(); } catch { /* the browser already showed it */ }
    return;
  }
  openSheet('installHelp');
}
