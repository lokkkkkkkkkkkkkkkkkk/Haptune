// Asking Google for one permission at the moment a feature needs it (incremental authorisation): Calendar for
// class sessions, Drive for saving files, Contacts for inviting. The server swaps the one-time code for tokens
// (server/google_link.py), so nothing secret stays in the app.
import { C } from './account.js';
import { loadGoogle } from './screens/hub.jsx';
import { isNative } from './native.js';
import { t } from '../core/i18n.js';

export const GOOGLE_SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  drive: 'https://www.googleapis.com/auth/drive.file',
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
};

/** Opens Google's consent popup for exactly one feature and links it. Resolves with the connections list. */
export async function connectGoogle(feature) {
  if (!GOOGLE_SCOPES[feature]) throw new Error('unknown feature');
  const info = await C.gconn.list();
  if (!info.available || !info.client_id) throw new Error(t('connNotSetUp'));
  if (isNative()) throw new Error(t('connOnWebsite'));
  const g = await loadGoogle();
  return new Promise((resolve, reject) => {
    const client = g.accounts.oauth2.initCodeClient({
      client_id: info.client_id, scope: GOOGLE_SCOPES[feature], ux_mode: 'popup', include_granted_scopes: true,
      hint: info.email || undefined,
      callback: (resp) => {
        if (resp.error || !resp.code) { reject(new Error(resp.error_description || resp.error || 'Google did not connect')); return; }
        C.gconn.connect(resp.code, feature).then(resolve, reject);
      },
      error_callback: (e) => reject(new Error(e?.message || 'Google did not connect')),
    });
    client.requestCode();
  });
}

/** Runs a Google call; when the server says the permission is missing, asks for it once and tries again. */
export async function withGoogle(feature, fn) {
  try { return await fn(); } catch (e) {
    if (e?.detail?.code !== 'google_scope_needed') throw e;
    await connectGoogle(feature);
    return fn();
  }
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
