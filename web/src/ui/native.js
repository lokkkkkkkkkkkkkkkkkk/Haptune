// The installed app (Capacitor: Android now, iOS later). In a browser every function here does nothing.
//   * the Android back button closes a sheet, goes back a screen, then to Home, then leaves the app
//   * in-app purchases go through RevenueCat, which tells the Haptune server what was bought
import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';

export const isNative = () => Capacitor.isNativePlatform();
export const platform = () => Capacitor.getPlatform();          // 'android' | 'ios' | 'web'

export function initNative({ onBack, onResume }) {
  if (!isNative()) return;
  document.documentElement.classList.add('native', `native-${platform()}`);
  App.addListener('backButton', () => { if (!onBack()) App.minimizeApp().catch(() => App.exitApp()); });
  App.addListener('resume', () => onResume?.());
}

// ---------- store purchases (RevenueCat) ----------
const Purchases = registerPlugin('Purchases');
const KEY = () => (globalThis.HAPTUNE_CONFIG || {}).revenuecat || '';
let configured = null;

/** Purchases work in the Android app once RevenueCat's key is built in (repository variable). */
export const canBuy = () => isNative() && !!KEY();

async function ready(userId) {
  if (!canBuy()) throw new Error('store');
  if (!configured) configured = Purchases.configure({ apiKey: KEY(), appUserID: userId }).catch((e) => { configured = null; throw e; });
  await configured;
}

/** The plans for sale with the store's own local prices: [{tier, period, price, pkg}]. */
export async function storePlans(userId) {
  await ready(userId);
  const off = await Purchases.getOfferings();
  const pkgs = off?.current?.availablePackages || [];
  return pkgs.map((p) => {
    const id = `${p.identifier} ${p.product?.identifier || ''}`.toLowerCase();
    return {
      tier: id.includes('pro') ? 'pro' : 'plus',
      period: /annual|year/.test(id) || p.packageType === 'ANNUAL' ? 'yearly' : 'monthly',
      price: p.product?.priceString || '',
      pkg: p,
    };
  });
}

export async function storeBuy(userId, pkg) {
  await ready(userId);
  return Purchases.purchasePackage({ aPackage: pkg });
}

export async function storeRestore(userId) {
  await ready(userId);
  return Purchases.restorePurchases();
}

/** Opens a link in the phone's browser (YouTube, the store's subscription page...). */
export function openExternal(url) {
  try { window.open(url, '_blank', 'noopener'); } catch { location.href = url; }
}
