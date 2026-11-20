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
 * the Melovyn website with a one-time link for this account; the person taps Allow there and comes back.
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
