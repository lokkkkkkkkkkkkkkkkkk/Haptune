// Asking Google for one permission at the moment a feature needs it (incremental authorisation): Calendar for
// class sessions, Drive for saving files, Contacts for inviting. The server swaps the one-time code for tokens
// (server/google_link.py), so nothing secret stays in the app.
import { C } from './account.js';
import { loadGoogle } from './screens/hub.jsx';
import { isNative, openExternal } from './native.js';
import { t } from '../core/i18n.js';

export const GOOGLE_SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  drive: 'https://www.googleapis.com/auth/drive.file',
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
};

const ALL = Object.values(GOOGLE_SCOPES).join(' ');

// ---------------------------------------------------------------- signing in
let status = null;
/** The server's Google client (so the code is always for the client the server swaps it with). */
export function googleStatus() {
  if (!status) status = C.googleStatus().catch((e) => { status = null; throw e; });
  return status;
}

/** Why Google said no, in words people can act on. */
export function googleError(code) {
  if (code === 'access_denied') return t('gErrDenied');
  if (code === 'expired') return t('gErrExpired');
  if (code === 'popup_closed' || code === 'cancelled') return '';
  return t('gErrOther', { code });
}

/** The whole page goes to Google and comes back signed in (when a popup can't open). */
export async function googleRedirect(extra = {}) {
  const ret = `${location.origin}${location.pathname}`;
  const { url } = await C.googleStart({ return_to: ret, ...extra });
  location.href = url;
}

/**
 * Sign in with Google on the website: Google's own OAuth window (the same one Calendar and Drive use), then the
 * server checks the answer. Must be called straight from a tap (browsers allow popups only then): Google's script
 * is loaded beforehand by preloadGoogle(). Resolves with the account, or null when the person closed the window.
 */
export function googleSignInPopup() {
  const g = globalThis.google;
  return googleStatus().then((st) => new Promise((resolve, reject) => {
    if (!st.configured) { reject(new Error(t('googleNotSetUp'))); return; }
    if (!g?.accounts?.oauth2) { googleRedirect().catch(reject); return; }
    const client = g.accounts.oauth2.initCodeClient({
      client_id: st.client_id, scope: 'openid email profile', ux_mode: 'popup', select_account: true, include_granted_scopes: true,
      callback: (resp) => {
        if (resp.error) { const m = googleError(resp.error); if (m) reject(Object.assign(new Error(m), { code: resp.error })); else resolve(null); return; }
        C.googleCode(resp.code).then(resolve, reject);
      },
      error_callback: (e) => {
        if (e?.type === 'popup_failed_to_open') { googleRedirect().catch(reject); return; }  // blocked: go by redirect
        resolve(null);                                                                      // closed: a choice
      },
    });
    client.requestCode();
  }));
}

/** Loads Google's script and the server's client before the button is tapped (so the tap can open the popup). */
export function preloadGoogle() {
  googleStatus().catch(() => {});
  return loadGoogle().catch(() => null);
}

/** Back from Google's page (…/app/#gsignin=…): finish signing in. Returns true when the address was ours. */
export async function finishGoogleRedirect(hash) {
  const ok = /^gsignin=(paired|[A-Za-z0-9_-]{10,80})$/.exec(hash);
  const bad = /^gsignin_error=([\w%-]{1,60})$/.exec(hash);
  if (!ok && !bad) return false;
  history.replaceState(null, '', location.pathname);
  const { toast } = await import('./state.js');
  if (bad) { const m = googleError(decodeURIComponent(bad[1])); if (m) toast(m, 'err'); return true; }
  if (ok[1] === 'paired') { toast(t('gPairedDone')); return true; }
  try {
    const me = await C.googleFinish(ok[1]);
    toast(t('signedInAs', { name: me?.name ? ` · ${me.name}` : '' }));
  } catch (e) { toast(e.detail?.message || e.message || String(e), 'err'); }
  return true;
}

/** Google's own consent window (website only) for one feature or for 'all' of them at once; links whatever the
 *  person allows. `ticket` links to the phone app's account instead of the one signed in here. */
export function askGoogle(feature, { clientId, hint = '', ticket = '' }) {
  return loadGoogle().then((g) => new Promise((resolve, reject) => {
    const client = g.accounts.oauth2.initCodeClient({
      client_id: clientId, scope: feature === 'all' ? ALL : GOOGLE_SCOPES[feature], ux_mode: 'popup', include_granted_scopes: true,
      hint: hint || undefined,
      callback: (resp) => {
        if (resp.error === 'access_denied' || (!resp.error && !resp.code)) { reject(declined(feature)); return; }
        if (resp.error || !resp.code) { reject(new Error(resp.error_description || resp.error || 'Google did not connect')); return; }
        C.gconn.connect(resp.code, feature, ticket).then(resolve, reject);
      },
      // the person closed Google's window or said no: not an error, a choice (the caller offers another way)
      error_callback: (e) => reject(e?.type === 'popup_closed' || e?.type === 'popup_failed_to_open' ? declined(feature) : new Error(e?.message || 'Google did not connect')),
    });
    client.requestCode();
  }));
}

/**
 * Asks Google for a feature ('calendar' | 'drive' | 'contacts') or for 'all' of them, and links it.
 * Website: Google's window right here. Phone app: Google shows that window only on a website, so the app opens
 * the Haptune website with a one-time link for this account; the person taps Allow there and comes back.
 * Resolves with the connections list (website), or {opened: true} (app: it refreshes when the person returns).
 */
export async function connectGoogle(feature) {
  if (feature !== 'all' && !GOOGLE_SCOPES[feature]) throw new Error('unknown feature');
  const info = await C.gconn.list();
  if (!info.available || !info.client_id) throw new Error(t('connNotSetUp'));
  if (isNative()) {
    const { ticket } = await C.gconn.ticket();
    const site = (globalThis.HAPTUNE_CONFIG || {}).site || 'https://haptune.name.my';
    openExternal(`${site}/app/#gconnect/${ticket}/${feature}`);
    return { ...info, opened: true };
  }
  return askGoogle(feature, { clientId: info.client_id, hint: info.email });
}

/** Saying no to a Google permission: `code: 'google_declined'`, with a friendly message for that feature. */
export function declined(feature) {
  const e = new Error(t(`declined_${feature}`));
  e.code = 'google_declined';
  e.feature = feature;
  return e;
}
export const isDeclined = (e) => e?.code === 'google_declined';

/** Runs a Google call; when the server says the permission is missing, asks for it once and tries again. */
export async function withGoogle(feature, fn) {
  try { return await fn(); } catch (e) {
    if (e?.detail?.code !== 'google_scope_needed') throw e;
    // ask for everything not yet allowed in one go, so this is the last time Google has to ask
    const r = await connectGoogle('all');
    if (r?.opened) throw Object.assign(new Error(t('gAllowOnSite')), { code: 'google_opened' });
    return fn();
  }
}

/** After signing in with Google: if some features aren't allowed yet, offer the one-tap "Allow" sheet (once a day
 *  at most, and never again after "Not now" twice). */
export async function offerGoogleAllow() {
  try {
    const info = await C.gconn.list();
    if (!info.available || !info.signed_in_google || info.all_linked) return;
    const { local } = await import('./storage.js');
    const seen = local.get('gAllowAsked', { n: 0, at: 0 });
    if (seen.n >= 2 || Date.now() - seen.at < 86400000) return;
    const { openSheet } = await import('./state.js');
    openSheet('googleAllow', { info });
  } catch { /* offline: ask another time */ }
}

/** Bytes -> base64, in chunks (large files would overflow String.fromCharCode). */
export function toBase64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Saves a file to the person's Google Drive (asking for Drive the first time). */
export async function saveToDrive(name, mime, bytes) {
  return withGoogle('drive', () => C.gconn.drive(name, mime, toBase64(bytes)));
}
