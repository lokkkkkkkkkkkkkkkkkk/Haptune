// Haptune plans and how to pay for them.
// Free has everything that costs nothing to run. Plus adds the song finder and the tutor; Pro adds reading
// PDFs and photos with AI. One plan works on every device, whichever way it was paid for:
//   Android app   Google Play (through RevenueCat): Google's rules require it inside the app
//   website / PC  a card, on Stripe's checkout page; "Manage" opens Stripe's page to change card or cancel
//   Malaysia      DuitNow QR or a bank transfer, switched on once the developer has seen the payment
import { useState, useEffect, useRef } from 'preact/hooks';
import { useApp, closeSheet, openSheet, toast, push, getState } from '../state.js';
import { t, getLang } from '../../core/i18n.js';
import { Icon, Button, Segmented, Card, Section, List, Row } from '../components.jsx';
import { SheetFrame } from './common.jsx';
import { C, attempt, ensureAccount, fileToAttachment } from '../account.js';
import { canBuy, storePlans, storeBuy, storeRestore, isNative, openExternal } from '../native.js';
import { hasServer } from '../api.js';

const FEATURES = {
  free: ['pf_practice', 'pf_import2', 'pf_tools2', 'pf_library', 'pf_community', 'pf_classes'],
  plus: ['pp_find', 'pp_tutor', 'pp_styles', 'pp_requests', 'pp_spotlight', 'pp_credits'],
  pro: ['pr_scan', 'pr_parts', 'pr_find', 'pr_tutor', 'pr_requests', 'pr_credits'],
};
// Until the server answers. The server's numbers follow the cost of the AI models it uses (accounts.py).
const DEFAULT_PLANS = {
  free: { read_pages: 0, find: 0, tutor: 0, open_requests: 3, monthly_credits: 0, spotlights: 0 },
  plus: { read_pages: 0, find: 2, tutor: 700, open_requests: 10, monthly_credits: 100, spotlights: 1 },
  pro: { read_pages: 8, find: 3, tutor: 1200, open_requests: 30, monthly_credits: 300, spotlights: 4 },
};
const FALLBACK = {
  plus: { monthly: { usd: '3.99', myr: '14.90' }, yearly: { usd: '24.99', myr: '99.90' } },
  pro: { monthly: { usd: '7.99', myr: '29.90' }, yearly: { usd: '59.99', myr: '229.90' } },
};

/** Ringgit for people in Malaysia, US dollars elsewhere (the choice can be changed on the sheet). */
export function guessCurrency() {
  try { if (/Kuala_Lumpur|Kuching/.test(Intl.DateTimeFormat().resolvedOptions().timeZone)) return 'myr'; } catch { /* fall through */ }
  return getLang() === 'ms' || /-MY$/i.test(navigator.language || '') ? 'myr' : 'usd';
}
const money = (p, cur) => (p ? (cur === 'myr' ? `RM ${p.myr}` : `US$${p.usd}`) : '');

export function PlansSheet({ reason = null }) {
  const s = useApp();
  const [period, setPeriod] = useState('yearly');
  const [cur, setCur] = useState(guessCurrency());
  const [info, setInfo] = useState(null);
  const [opt, setOpt] = useState(null);           // ways to pay on this server
  const [store, setStore] = useState(null);       // [{tier, period, price, pkg}] from Google Play
  const [busy, setBusy] = useState('');
  const me = s.me;
  const tier = me?.tier || 'free';
  const play = canBuy();
  useEffect(() => {
    if (!hasServer()) return;
    ensureAccount().then((m) => {
      C.plans().then(setInfo).catch(() => {});
      C.billing.options().then(setOpt).catch(() => setOpt({ stripe: false, manual: null, mine: [] }));
      if (play && m) storePlans(m.id).then(setStore).catch(() => setStore([]));
    });
  }, []);
  const prices = info?.prices || FALLBACK;
  const priceOf = (tr) => (play && store?.find((x) => x.tier === tr && x.period === period)?.price) || money(prices[tr]?.[period], cur);
  const buyPlay = async (tr) => {
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
  const buyCard = async (tr) => {
    setBusy(tr);
    const r = await attempt(() => C.billing.checkout(tr, period, cur));
    if (r?.url) location.href = r.url; else setBusy('');
  };
  const manage = async () => { setBusy('manage'); const r = await attempt(() => C.billing.portal()); setBusy(''); if (r?.url) location.href = r.url; };
  const restore = async () => {
    const m = await ensureAccount();
    setBusy('restore');
    try { await storeRestore(m.id); const r = await attempt(() => C.billingSync()); if (r) toast(t('restored2', { plan: t(`plan_${r.tier}`) })); } catch (e) { toast(String(e?.message || e), 'err'); }
    setBusy('');
  };
  const need = reason?.need;
  const reasonText = reason?.feature ? t(`why_plan_${reason.feature}`) : reason?.code === 'open_requests' ? t('why_plan_requests', { n: reason.limit }) : reason?.code === 'plan_limit' ? reason.message : '';
  const usage = me?.usage || {};
  const plans = [
    { id: 'free', title: t('plan_free'), price: cur === 'myr' ? 'RM 0' : 'US$0' },
    { id: 'plus', title: t('plan_plus'), price: priceOf('plus') },
    { id: 'pro', title: t('plan_pro'), price: priceOf('pro'), best: true, sub: t('proFor2') },
  ];
  const pending = opt?.mine?.find((p) => p.status === 'pending');
  const rejected = opt?.mine?.find((p) => p.status === 'rejected');
  const webPay = !isNative() && opt;
  const cta = (p) => {
    if (p.id === 'free') return tier === 'free' ? <span class="plan-chip">{t('currentPlan')}</span> : null;
    if (tier === p.id) return <span class="plan-chip plus"><Icon name="check" size={12} stroke={3} />{t('currentPlan')}</span>;
    if (tier === 'dev') return <span class="plan-chip dev">{t('devHasAll')}</span>;
    if (tier === 'pro' && p.id === 'plus') return null;
    if (play) return <Button full kind={p.best ? 'brand' : 'dark'} disabled={!!busy} onClick={() => buyPlay(p.id)} id={`buy-${p.id}`}>{busy === p.id ? t('sending') : t('getPlan', { plan: p.title })}</Button>;
    if (isNative()) return <p class="note-text">{t('storeSoon')}</p>;
    if (!webPay) return <div class="spinner small" />;
    return (
      <div class="pay-btns">
        {opt.stripe && <Button full kind={p.best ? 'brand' : 'dark'} icon="card" disabled={!!busy} onClick={() => buyCard(p.id)} id={`card-${p.id}`}>{busy === p.id ? t('openingCheckout') : t('payByCard')}</Button>}
        {opt.manual && cur === 'myr' && <Button full kind="secondary" icon="pin" disabled={!!busy} onClick={() => openSheet('manualPay', { product: p.id, period })} id={`duitnow-${p.id}`}>{t('payDuitNow')}</Button>}
        {!opt.stripe && !(opt.manual && cur === 'myr') && <p class="note-text">{t('payNotReady')}</p>}
      </div>
    );
  };
  return (
    <SheetFrame title={t('plans')} full>
      <div class="plans-top">
        <h2>{tier === 'free' ? (need === 'pro' ? t('plansTitlePro') : t('plansTitle2')) : t('yourPlanIs', { plan: t(`plan_${tier}`) })}</h2>
        <p>{reasonText || t('plansSub2')}</p>
      </div>
      {pending && <div class="banner good" id="pay-pending"><Icon name="clock" size={20} stroke={2.2} /><div><strong>{t('payWaiting')}</strong><div class="sub">{t('payWaitingSub', { code: pending.code })}</div></div></div>}
      {rejected && !pending && <div class="banner warn"><Icon name="info" size={20} stroke={2.2} /><div><strong>{t('payRejected')}</strong><div class="sub">{rejected.admin_note}</div>
        <button type="button" class="link" onClick={() => openSheet('manualPay', { product: rejected.product, period: rejected.period })}>{t('tryAgain')}</button></div></div>}
      {tier !== 'free' && (
        <Card class="usage-card">
          <p class="tips-title"><Icon name="sparkles" size={16} /> {t('thisMonth')}</p>
          {['read_pages', 'find', 'tutor'].map((k) => {
            const u = usage[k] || { used: 0, limit: null };
            if (u.limit === 0) return null;
            const pct = u.limit ? Math.min(100, (u.used / u.limit) * 100) : 4;
            return <div key={k} class="usage-row"><span>{t(`use_${k}`)}</span><div class="progress"><span style={{ width: `${pct}%` }} /></div><span class="num">{u.limit === null ? `${u.used} · ∞` : `${u.used}/${u.limit}`}</span></div>;
          })}
          {me?.tier_until && <p class="note-text">{t(me.tier_source === 'stripe' || me.tier_source === 'store' ? 'renewsOnDate' : 'endsOnDate', { d: new Date(me.tier_until).toLocaleDateString(getLang()) })}</p>}
          {opt?.manage && <Button small kind="secondary" icon="card" disabled={busy === 'manage'} onClick={manage} id="manage-sub">{t('manageSub')}</Button>}
        </Card>
      )}
      <div class="plans-pick">
        <Segmented value={period} onChange={setPeriod} options={[{ value: 'monthly', label: t('monthly') }, { value: 'yearly', label: `${t('yearly')} · ${t('save35')}` }]} />
        {!play && <Segmented small value={cur} onChange={setCur} options={[{ value: 'myr', label: 'RM' }, { value: 'usd', label: 'US$' }]} />}
      </div>
      <div class="plan-cards">
        {plans.map((p) => (
          <div key={p.id} id={`plan-${p.id}`} class={`plan-card${tier === p.id ? ' current' : ''}${p.best ? ' best' : ''}${need === p.id ? ' need' : ''}`}>
            {p.best && <span class="ribbon">{t('mostComplete')}</span>}
            <div class="pcard-head"><h3>{p.title}</h3><span class="pcard-price num">{p.price}{p.id !== 'free' && <span class="per"> / {t(period === 'yearly' ? 'yr' : 'mo')}</span>}</span></div>
            {p.sub && <p class="sub">{p.sub}</p>}
            {p.id !== 'free' && <p class="sub" style={{ fontWeight: 700 }}>{t('everythingIn', { plan: t(p.id === 'pro' ? 'plan_plus' : 'plan_free') })}</p>}
            <ul class="pfeat">{FEATURES[p.id].map((f) => <li key={f}><Icon name="check" size={15} stroke={2.8} />{t(f, info?.plans?.[p.id] || DEFAULT_PLANS[p.id])}</li>)}</ul>
            {cta(p)}
          </div>
        ))}
      </div>
      {tier === 'free' && <button type="button" class="sr-cta" onClick={() => { closeSheet(); push('wallet', {}, getState().tab); }}>
        <span class="hm-art sm"><Icon name="gift" size={21} stroke={2.1} /></span><div><strong>{t('passWithNotes')}</strong><span>{t('passWithNotesSub')}</span></div><Icon name="chevronR" size={16} stroke={2.4} />
      </button>}
      {play && <Button kind="plain" full disabled={!!busy} onClick={restore}>{t('restorePurchases')}</Button>}
      <p class="note-text center">{t(play ? 'billingNote' : 'billingNoteWeb')}</p>
      <p class="note-text center">
        <button type="button" class="link" onClick={() => openExternal(`${globalThis.HAPTUNE_CONFIG?.site || ''}/terms.html`)}>{t('terms')}</button> · <button type="button" class="link" onClick={() => openExternal(`${globalThis.HAPTUNE_CONFIG?.site || ''}/refunds.html`)}>{t('refundPolicy')}</button> · <button type="button" class="link" onClick={() => openExternal(`${globalThis.HAPTUNE_CONFIG?.site || ''}/privacy.html`)}>{t('privacy')}</button>
      </p>
    </SheetFrame>
  );
}

function CopyRow({ label, value, id }) {
  const copy = async () => { try { await navigator.clipboard.writeText(value); toast(t('copied')); } catch { /* select by hand */ } };
  return <Row title={label} right={<button type="button" class="copy-val" onClick={copy} id={id}><strong class="num">{value}</strong><Icon name="copy" size={16} /></button>} />;
}

/** DuitNow QR or bank transfer (Malaysia): pay in your bank app quoting the code, then tell us. */
export function ManualPaySheet({ product = 'plus', period = 'monthly', onDone = null }) {
  const [p, setP] = useState(null);
  const [qr, setQr] = useState(true);
  const [payer, setPayer] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const fileRef = useRef(null);
  useEffect(() => { attempt(() => C.billing.manualStart(product, period)).then((r) => r && setP(r)); }, []);
  const pick = async (e) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    const a = await fileToAttachment(f);
    setReceipt(`data:${a.mime};base64,${a.data}`);
  };
  const send = async () => {
    setBusy(true);
    const r = await attempt(() => C.billing.manualPaid(p.id, { payer, receipt }));
    setBusy(false);
    if (r) { setSent(true); onDone?.(); }
  };
  const title = product === 'teacher' ? t('teacherFee') : `Haptune ${t(`plan_${product}`)} · ${t(period)}`;
  if (!p) return <SheetFrame title={t('payDuitNow')}><div class="loading"><div class="spinner" /></div></SheetFrame>;
  if (sent) {
    return (
      <SheetFrame title={t('payDuitNow')} right={t('done')} onRight={closeSheet}>
        <div class="empty"><span class="hm-art" style={{ background: 'color-mix(in srgb, var(--green) 14%, transparent)', color: 'var(--green)' }}><Icon name="check" size={30} stroke={2.6} /></span>
          <h3>{t('payThanks')}</h3><p>{t('payThanksSub')}</p></div>
      </SheetFrame>
    );
  }
  return (
    <SheetFrame title={t('payDuitNow')}>
      <div class="pay-amount"><span>{title}</span><strong class="num">RM {p.amount}</strong></div>
      <Section title={t('payStep1')}>
        {qr && <div class="pay-qr"><img src="pay/duitnow-qr.png" alt="DuitNow QR" onError={() => setQr(false)} /><span>{t('payScan')}</span></div>}
        <List>
          <Row title={t('payBank')} detail={p.bank} />
          <CopyRow label={t('payAccount')} value={p.account} id="copy-account" />
          {p.name && <Row title={t('payName')} detail={p.name} />}
          <CopyRow label={t('payAmount')} value={p.amount} />
          <CopyRow label={t('payReference')} value={p.code} id="copy-code" />
        </List>
        <p class="note-text">{t('payReferenceNote')}</p>
      </Section>
      <Section title={t('payStep2')}>
        <input class="field" type="text" id="payer" placeholder={t('payPayer')} value={payer} maxLength={80} onInput={(e) => setPayer(e.currentTarget.value)} aria-label={t('payPayer')} />
        <input ref={fileRef} type="file" class="hidden-input" accept="image/*" onChange={pick} aria-label={t('payReceipt')} />
        <Button kind="secondary" icon={receipt ? 'check' : 'camera'} onClick={() => fileRef.current?.click()}>{receipt ? t('payReceiptAdded') : t('payReceipt')}</Button>
      </Section>
      <Button kind="brand" full disabled={busy || payer.trim().length < 2} onClick={send} id="pay-sent">{busy ? t('sending') : t('payIPaid')}</Button>
      <p class="note-text center">{t('payHow')}</p>
    </SheetFrame>
  );
}
