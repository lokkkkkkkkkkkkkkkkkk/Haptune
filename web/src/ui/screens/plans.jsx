// Haptune plans. Free has everything that costs nothing to run; Plus and Pro add the features that use paid AI
// (reading music from photos/PDFs, finding songs online, the Hapi tutor) with monthly allowances, plus perks.
// Purchases happen in the store (Google Play) through RevenueCat; the server then knows the plan, so it also
// applies when you sign in on a PC.
import { useState, useEffect } from 'preact/hooks';
import { useApp, closeSheet, toast, push, getState } from '../state.js';
import { t, getLang } from '../../core/i18n.js';
import { Icon, Button, Segmented, Card } from '../components.jsx';
import { SheetFrame } from './common.jsx';
import { Mascot } from '../mascot.jsx';
import { C, attempt, ensureAccount, setMe } from '../account.js';
import { canBuy, storePlans, storeBuy, storeRestore, isNative } from '../native.js';
import { hasServer } from '../api.js';

const FEATURES = {
  free: ['pf_practice', 'pf_sound', 'pf_import', 'pf_basicScan', 'pf_community', 'pf_classes', 'pf_tools'],
  plus: ['pp_scan', 'pp_find', 'pp_tutor', 'pp_styles', 'pp_requests', 'pp_spotlight', 'pp_credits'],
  pro: ['pr_scan', 'pr_find', 'pr_tutor', 'pr_requests', 'pr_spotlight', 'pr_credits', 'pr_teacher'],
};
// Until the server answers. The server's numbers follow the cost of the AI models it uses (accounts.py), so they
// grow when a cheaper model is switched on; these are its numbers for the default models.
const DEFAULT_PLANS = {
  free: { read_pages: 0, find: 0, tutor: 0, open_requests: 3, monthly_credits: 0, spotlights: 0 },
  plus: { read_pages: 2, find: 1, tutor: 360, open_requests: 10, monthly_credits: 100, spotlights: 1 },
  pro: { read_pages: 7, find: 3, tutor: 1080, open_requests: 30, monthly_credits: 300, spotlights: 4 },
};
const FALLBACK = {
  plus: { monthly: { usd: '3.99', myr: '14.90' }, yearly: { usd: '24.99', myr: '99.90' } },
  pro: { monthly: { usd: '7.99', myr: '29.90' }, yearly: { usd: '59.99', myr: '229.90' } },
};

function localPrice(prices, tier, period) {
  const p = (prices || FALLBACK)[tier]?.[period];
  if (!p) return '';
  const myr = getLang() === 'ms' || /MY$/i.test(navigator.language || '') || getLang().startsWith('zh-Hans') && /MY/.test(navigator.languages?.join(',') || '');
  return myr ? `RM ${p.myr}` : `US$${p.usd}`;
}

export function PlansSheet({ reason = null }) {
  const s = useApp();
  const [period, setPeriod] = useState('yearly');
  const [info, setInfo] = useState(null);
  const [store, setStore] = useState(null);       // [{tier, period, price, pkg}] from Google Play
  const [busy, setBusy] = useState('');
  const me = s.me;
  const tier = me?.tier || 'free';
  useEffect(() => {
    if (!hasServer()) return;
    ensureAccount().then((m) => {
      C.plans().then(setInfo).catch(() => {});
      if (canBuy() && m) storePlans(m.id).then(setStore).catch(() => setStore([]));
    });
  }, []);
  const priceOf = (tr) => store?.find((x) => x.tier === tr && x.period === period)?.price || localPrice(info?.prices, tr, period);
  const buy = async (tr) => {
    const m = await ensureAccount();
    if (!m) { toast(t('needOnline'), 'err'); return; }
    const pkg = store?.find((x) => x.tier === tr && x.period === period)?.pkg;
    if (!pkg) { toast(t('storeNotReady'), 'err'); return; }
    setBusy(tr);
    try {
      await storeBuy(m.id, pkg);
      const r = await attempt(() => C.billingSync());
      if (r) { toast(t('welcomePlan', { plan: t(`plan_${r.tier}`) })); closeSheet(); }
    } catch (e) {
      if (!/cancel/i.test(String(e?.message || e?.code || ''))) toast(String(e?.message || e), 'err');
    }
    setBusy('');
  };
  const restore = async () => {
    const m = await ensureAccount();
    setBusy('restore');
    try { await storeRestore(m.id); const r = await attempt(() => C.billingSync()); if (r) toast(t('restored2', { plan: t(`plan_${r.tier}`) })); } catch (e) { toast(String(e?.message || e), 'err'); }
    setBusy('');
  };
  const reasonText = reason?.feature ? t(`why_plan_${reason.feature}`) : reason?.code === 'open_requests' ? t('why_plan_requests', { n: reason.limit }) : reason?.code === 'plan_limit' ? reason.message : '';
  const usage = me?.usage || {};
  const plans = [
    { id: 'free', color: 'gray', title: t('plan_free'), price: localPrice({ free: { monthly: { usd: '0', myr: '0' }, yearly: { usd: '0', myr: '0' } } }, 'free', period) },
    { id: 'plus', color: 'purple', title: t('plan_plus'), price: priceOf('plus'), popular: true },
    { id: 'pro', color: 'orange', title: t('plan_pro'), price: priceOf('pro'), sub: t('proFor') },
  ];
  return (
    <SheetFrame title={t('plans')} full>
      <div class="plans-hero">
        <Mascot mood={tier === 'free' ? 'wave' : 'cheer'} size={72} />
        <div><h2>{tier === 'free' ? t('plansTitle') : t('yourPlanIs', { plan: t(`plan_${tier}`) })}</h2>
          <p>{reasonText || t('plansSub')}</p></div>
      </div>
      {tier !== 'free' && (
        <Card class="usage-card">
          <p class="tips-title"><Icon name="sparkles" size={16} /> {t('thisMonth')}</p>
          {['read_pages', 'find', 'tutor'].map((k) => {
            const u = usage[k] || { used: 0, limit: null };
            const pct = u.limit ? Math.min(100, (u.used / u.limit) * 100) : 4;
            return <div key={k} class="usage-row"><span>{t(`use_${k}`)}</span><div class="progress"><span style={{ width: `${pct}%` }} /></div><span class="num">{u.limit === null ? `${u.used} · ∞` : `${u.used}/${u.limit}`}</span></div>;
          })}
          {me?.tier_until && <p class="note-text">{t('renewsOn', { date: new Date(me.tier_until).toLocaleDateString(getLang()) })}</p>}
        </Card>
      )}
      <Segmented value={period} onChange={setPeriod} options={[{ value: 'monthly', label: t('monthly') }, { value: 'yearly', label: `${t('yearly')} · ${t('save48')}` }]} />
      <div class="plan-cards">
        {plans.map((p) => (
          <div key={p.id} class={`plan-card c-${p.color}${tier === p.id ? ' current' : ''}${p.popular ? ' popular' : ''}`}>
            {p.popular && <span class="ribbon">{t('mostPopular')}</span>}
            <div class="pcard-head"><h3>{p.title}</h3><span class="pcard-price num">{p.price}{p.id !== 'free' && <span class="per"> / {t(period === 'yearly' ? 'yr' : 'mo')}</span>}</span></div>
            {p.sub && <p class="sub">{p.sub}</p>}
            {p.id !== 'free' && <p class="sub">{t('everythingIn', { plan: t(p.id === 'pro' ? 'plan_plus' : 'plan_free') })}</p>}
            <ul class="pfeat">{FEATURES[p.id].map((f) => <li key={f}><Icon name="check" size={15} stroke={2.6} />{t(f, info?.plans?.[p.id] || DEFAULT_PLANS[p.id])}</li>)}</ul>
            {p.id === 'free' ? (tier === 'free' && <span class="pill gray">{t('currentPlan')}</span>)
              : tier === p.id ? <span class="pill green">{t('currentPlan')}</span>
                : tier === 'dev' ? <span class="pill purple">{t('devHasAll')}</span>
                  : canBuy() ? <Button full color={p.color === 'orange' ? 'orange' : 'purple'} disabled={!!busy} onClick={() => buy(p.id)}>{busy === p.id ? t('sending') : t('getPlan', { plan: p.title })}</Button>
                    : <p class="note-text">{isNative() ? t('storeSoon') : t('buyInApp')}</p>}
          </div>
        ))}
      </div>
      {tier === 'free' && <Card class="tip-card" onClick={() => { closeSheet(); push('wallet', {}, getState().tab); }}>
        <div class="report-line"><Icon name="star" size={20} /><p class="sub">{t('plusWithCredits', { n: info?.rules?.plus_week_cost || 1500 })}</p><Icon name="chevronR" size={14} /></div>
      </Card>}
      {canBuy() && <Button kind="plain" full disabled={!!busy} onClick={restore}>{t('restorePurchases')}</Button>}
      <p class="note-text center">{t('billingNote')}</p>
      <p class="note-text center">{t('freeForever')}</p>
    </SheetFrame>
  );
}
