// Signing in, the easy way (Part 2 E):
//   One Tap   on the website, someone who isn't signed in sees Google's small "Continue as …" card once
//             (FedCM in Chrome), at most every few days; never in the app or after they said no.
//   Apple     Sign in with Apple: Apple's popup on the web (when the Services ID is set: CFG().apple), the
//             native sheet on iPhone when the app has the plugin.
//   Android   Google's native sign-in when the app has the GoogleAuth plugin; otherwise the website pairing.
// The server checks every token (server/accounts.py for Google, server/signin.py for Apple).
import { C, isRegistered } from './account.js';
import { loadGoogle } from './screens/hub.jsx';
import { isNative } from './native.js';
import { local } from './storage.js';
import { toast } from './state.js';
import { t } from '../core/i18n.js';
import { track } from './analytics.js';

const CFG = () => globalThis.HAPTUNE_CONFIG || {};
const plugin = (name) => globalThis.Capacitor?.Plugins?.[name] || null;
const ONE_TAP_GAP = 3 * 86400e3;

/** Google One Tap on the website, for someone not signed in. */
export async function startOneTap(onDone) {
  if (isNative() || !CFG().google || isRegistered()) return false;
  const last = local.get('oneTapAt', 0);
  if (local.get('oneTapNo', false) || Date.now() - last < ONE_TAP_GAP) return false;
  try {
    const g = await loadGoogle();
    local.set('oneTapAt', Date.now());
    g.accounts.id.initialize({
      client_id: CFG().google, auto_select: false, cancel_on_tap_outside: true, itp_support: true, use_fedcm_for_prompt: true, context: 'signin',
      callback: async (resp) => {
        try { const me = await C.googleSignIn(resp.credential); track('sign_in', { label: 'one_tap' }); toast(t('signedInAs', { name: me?.name ? ` · ${me.name}` : '' })); onDone?.(me); } catch (e) { toast(e.message || String(e), 'err'); }
      },
    });
    g.accounts.id.prompt();
    return true;
  } catch { return false; }
}

/** Never show One Tap again (the person said no, or signed in another way). */
export function stopOneTap() { local.set('oneTapNo', true); try { globalThis.google?.accounts?.id?.cancel(); } catch { /* not loaded */ } }

let appleLoading = null;
function loadApple() {
  if (globalThis.AppleID?.auth) return Promise.resolve(globalThis.AppleID);
  if (appleLoading) return appleLoading;
  appleLoading = new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
    sc.async = true;
    sc.onload = () => (globalThis.AppleID?.auth ? resolve(globalThis.AppleID) : reject(new Error('Sign in with Apple did not load')));
    sc.onerror = () => { appleLoading = null; reject(new Error('Sign in with Apple could not be reached')); };
    document.head.appendChild(sc);
  });
  return appleLoading;
}

export const appleAvailable = () => !!(CFG().apple || plugin('SignInWithApple'));

/** Sign in with Apple; resolves with the account, or null when the person closed it. */
export async function appleSignIn() {
  const native = plugin('SignInWithApple');
  if (isNative() && native) {
    const r = await native.authorize({ clientId: CFG().appleBundle || 'my.melovyn.app', redirectURI: `${CFG().site || location.origin}/app/`, scopes: 'email name' });
    const name = [r.response?.givenName, r.response?.familyName].filter(Boolean).join(' ');
    return C.appleSignIn(r.response.identityToken, name);
  }
  if (!CFG().apple) throw new Error(t('appleNotSetUp'));
  const A = await loadApple();
  A.auth.init({ clientId: CFG().apple, scope: 'name email', redirectURI: `${location.origin}${location.pathname}`, usePopup: true });
  try {
    const r = await A.auth.signIn();
    const name = [r.user?.name?.firstName, r.user?.name?.lastName].filter(Boolean).join(' ');
    track('sign_in', { label: 'apple' });
    return C.appleSignIn(r.authorization.id_token, name);
  } catch (e) {
    if (e?.error === 'popup_closed_by_user' || e?.error === 'user_cancelled_authorize') return null;
    throw new Error(e?.error || e?.message || 'Apple did not sign you in');
  }
}

/** Android / iPhone app: Google's own sign-in sheet (Capgo SocialLogin plugin, or the older GoogleAuth plugin). */
// The Web client ID: public by design; the server checks the token's audience against it.
const WEB_CLIENT_ID = '441801851459-894b05t66ggvv4f8185ootkpkl9jnn9o.apps.googleusercontent.com';
const googleClientId = () => CFG().google || WEB_CLIENT_ID;
export const nativeGoogleAvailable = () => isNative() && !!(plugin('SocialLogin') || plugin('GoogleAuth'));
let socialReady = null;
export async function nativeGoogleSignIn({ fresh = false } = {}) {
  const social = plugin('SocialLogin');
  let tok = null;
  if (social) {
    // Only the sign-in itself (an ID token: name, email, picture). Asking for scopes, or letting the plugin run
    // Google's extra "authorize" step after signing in, needs a changed MainActivity to get the answer back; without
    // it the plugin refuses, or Google's consent screen can stay open, white (Part 9).
    socialReady ||= social.initialize({ google: { webClientId: googleClientId(), mode: 'online', skipAuthOnlyAuthorizationAfterSignIn: true } })
      .catch((e) => { socialReady = null; throw e; });
    await socialReady;
    if (fresh) { try { await social.logout({ provider: 'google' }); } catch { /* nobody to forget */ } }   // show the account chooser
    try {
      const r = await social.login({ provider: 'google', options: { style: 'standard', filterByAuthorizedAccounts: false } });
      tok = r?.result?.idToken || null;
    } catch (e) {
      if (/cancel/i.test(e?.message || e?.code || '')) return null;
      throw Object.assign(new Error(e?.message || String(e)), { native: true });
    }
  } else {
    const g = plugin('GoogleAuth');
    if (!g) throw new Error(t('connOnWebsite'));
    try { await g.initialize?.({ clientId: googleClientId(), scopes: ['profile', 'email'], grantOfflineAccess: false }); } catch { /* already */ }
    const r = await g.signIn();
    tok = r?.authentication?.idToken || r?.idToken;
  }
  if (!tok) return null;
  track('sign_in', { label: 'google_native' });
  return C.googleSignIn(tok, { fresh });
}

/** Signing out: Google forgets which account it picked last, so the next sign-in shows the chooser. */
export async function forgetGoogle() {
  try { globalThis.google?.accounts?.id?.disableAutoSelect?.(); } catch { /* Google not loaded */ }
  const social = plugin('SocialLogin');
  if (social && socialReady) { try { await social.logout({ provider: 'google' }); } catch { /* not signed in there */ } }
}
