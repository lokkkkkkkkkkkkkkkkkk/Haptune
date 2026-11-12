// The developer's panel (only for the account unlocked with HAPTUNE_ADMIN_CODE): how the app is doing,
// reports to look at, the feedback inbox, and giving a plan or credits to someone (testers, teachers).
import { useState, useEffect } from 'preact/hooks';
import { toast } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, Button, Section, Card, Segmented, Chip, Empty } from '../components.jsx';
import { NavBar } from './common.jsx';
import { C, attempt } from '../account.js';
import { PersonLine, timeAgo } from './social.jsx';

export function AdminView({ active }) {
  const [tab, setTab] = useState('overview');
  return (
    <div class="scroll">
      <NavBar title={t('devPanel')} backLabel={t('back')} color="purple" />
      <div class="wrap">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'overview', label: t('overview') }, { value: 'payments', label: t('payments') }, { value: 'tutors', label: t('tutorsTab') }, { value: 'reports', label: t('reports') }, { value: 'feedback', label: t('feedback') }, { value: 'tools', label: t('tools') }]} />
        {tab === 'overview' && <Overview active={active} />}
        {tab === 'payments' && <Payments active={active} />}
        {tab === 'tutors' && <TutorsAdmin active={active} />}
        {tab === 'reports' && <Reports active={active} />}
        {tab === 'feedback' && <Inbox active={active} />}
        {tab === 'tools' && <Tools />}
      </div>
    </div>
  );
}

function Overview({ active }) {
  const [o, setO] = useState(null);
  useEffect(() => { if (active) C.admin.overview().then(setO).catch((e) => toast(e.message, 'err')); }, [active]);
  if (!o) return <div class="loading"><div class="spinner" /></div>;
  const tiles = [
    ['members', o.members], ['activeToday', o.active_today], ['plan_plus', o.plus], ['plan_pro', o.pro], ['postsToday', o.posts_today],
    ['openRequests', o.open_requests], ['reports', o.open_reports], ['newFeedback', o.new_feedback], ['creditsMintedWeek', o.credits_minted_week],
  ];
  return (
    <>
      <div class="stat-grid">{tiles.map(([k, v]) => <div key={k}><strong class="num">{v}</strong><span>{t(k)}</span></div>)}</div>
      <Section title={t('aiThisMonth')} footer={t('aiCostNote')}>
        <div class="stat-grid">{['read_pages', 'find', 'tutor'].map((k) => <div key={k}><strong class="num">{o.ai_this_month[k]}</strong><span>{t(`use_${k}`)}</span></div>)}</div>
      </Section>
    </>
  );
}

/** DuitNow / bank transfers people say they made: check the bank for the code and amount, then approve. */
function Payments({ active }) {
  const [items, setItems] = useState(null);
  const [notes, setNotes] = useState({});
  const load = () => C.admin.payments().then((r) => setItems(r.items)).catch((e) => toast(e.message, 'err'));
  useEffect(() => { if (active) load(); }, [active]);
  const act = async (id, action) => { if (await attempt(() => C.admin.decidePayment(id, action, notes[id] || ''))) { toast(t('done')); load(); } };
  if (!items) return <div class="loading"><div class="spinner" /></div>;
  if (!items.length) return <Empty icon="check" title={t('noPayments')} sub={t('noPaymentsSub')} />;
  return items.map((p) => (
    <Card key={p.id}>
      <div class="report-line" style={{ alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong class="num">RM {p.amount} · {p.code}</strong>
          <div class="sub">{p.product === 'teacher' ? t('teacherFee') : `${t(`plan_${p.product}`)} · ${t(p.period)}`} · {p.method} · {timeAgo(p.created)}</div>
          <div class="sub">{t('payPayer')}: <b>{p.payer}</b> · @{p.user?.handle} ({p.user?.name})</div>
          {p.note && <div class="note-text">“{p.note}”</div>}
        </div>
      </div>
      {p.receipt && <img src={p.receipt} alt={t('payReceipt')} style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 12, objectFit: 'contain', background: '#fff' }} />}
      <input class="field" type="text" placeholder={t('payAdminNote')} value={notes[p.id] || ''} onInput={(e) => setNotes((n) => ({ ...n, [p.id]: e.currentTarget.value }))} aria-label={t('payAdminNote')} />
      <div class="btn-row">
        <Button small color="green" icon="check" onClick={() => act(p.id, 'approve')}>{t('approve')}</Button>
        <Button small kind="secondary" color="red" onClick={() => act(p.id, 'reject')}>{t('reject')}</Button>
      </div>
    </Card>
  ));
}

/** Teaching profiles that are paid for and waiting to be looked at before they are listed. */
function TutorsAdmin({ active }) {
  const [items, setItems] = useState(null);
  const [notes, setNotes] = useState({});
  const load = () => C.admin.tutors().then((r) => setItems(r.items)).catch((e) => toast(e.message, 'err'));
  useEffect(() => { if (active) load(); }, [active]);
  const act = async (h, action) => { if (await attempt(() => C.admin.decideTutor(h, action, notes[h] || ''))) { toast(t('done')); load(); } };
  if (!items) return <div class="loading"><div class="spinner" /></div>;
  if (!items.length) return <Empty icon="check" title={t('noTutorsWaiting')} />;
  return items.map((x) => (
    <Card key={x.user.id}>
      <PersonLine user={x.user} sub={x.paid ? x.paid_ref : '—'} />
      <strong>{x.headline}</strong>
      <p class="sub">{x.instruments.join(', ')} · {x.city} · {x.rate} · {x.times}</p>
      <p class="r-body" style={{ whiteSpace: 'pre-wrap' }}>{x.bio}</p>
      <input class="field" type="text" placeholder={t('payAdminNote')} value={notes[x.user.handle] || ''} onInput={(e) => setNotes((n) => ({ ...n, [x.user.handle]: e.currentTarget.value }))} aria-label={t('payAdminNote')} />
      <div class="btn-row">
        <Button small color="green" icon="shield" onClick={() => act(x.user.handle, 'verify')}>{t('verify')}</Button>
        <Button small kind="secondary" color="red" onClick={() => act(x.user.handle, 'reject')}>{t('reject')}</Button>
      </div>
    </Card>
  ));
}

function Reports({ active }) {
  const [items, setItems] = useState(null);
  const load = () => C.admin.reports().then((r) => setItems(r.items)).catch((e) => toast(e.message, 'err'));
  useEffect(() => { if (active) load(); }, [active]);
  const act = async (id, action) => { if (await attempt(() => C.admin.handle(id, action))) { toast(t('done')); load(); } };
  if (!items) return <div class="loading"><div class="spinner" /></div>;
  if (!items.length) return <Empty icon="check" title={t('noReports')} />;
  return items.map((r) => (
    <Card key={r.id}>
      <p class="sub"><span class="pill orange">{t(`why_${r.reason}`)}</span> {r.target} · {timeAgo(r.at)}</p>
      {r.preview && <p class="r-body">{r.preview}</p>}
      {r.note && <p class="note-text">“{r.note}”</p>}
      <PersonLine user={r.user} sub={t('reportedUser')} />
      <PersonLine user={r.reporter} sub={t('reporter')} />
      <div class="btn-row">
        <Button small color="red" onClick={() => act(r.id, 'hide')}>{t('hide')}</Button>
        <Button small kind="secondary" onClick={() => act(r.id, 'restore')}>{t('restore2')}</Button>
        <Button small kind="secondary" onClick={() => act(r.id, 'dismiss')}>{t('dismiss')}</Button>
        <Button small kind="plain" onClick={() => act(r.id, 'ban')}>{t('ban')}</Button>
      </div>
    </Card>
  ));
}

function Inbox({ active }) {
  const [status, setStatus] = useState('new');
  const [items, setItems] = useState(null);
  const load = () => C.admin.feedback(status).then((r) => setItems(r.items)).catch((e) => toast(e.message, 'err'));
  useEffect(() => { if (active) load(); }, [active, status]);
  const mark = async (id, st) => { if (await attempt(() => C.admin.feedbackUpdate(id, st))) load(); };
  return (
    <>
      <div class="chips">{['new', 'seen', 'done', 'all'].map((s) => <Chip key={s} on={status === s} onClick={() => setStatus(s)}>{t(`fbs_${s}`)}</Chip>)}</div>
      {!items ? <div class="loading"><div class="spinner" /></div> : !items.length ? <Empty icon="check" title={t('inboxEmpty')} /> : items.map((f) => (
        <Card key={f.id}>
          <p class="sub"><span class="pill blue">{t(`fb_${f.category}`)}</span> {timeAgo(f.at)}{f.contact ? ` · ${f.contact}` : ''}</p>
          <p class="r-body">{f.message}</p>
          {f.user && <PersonLine user={f.user} />}
          {f.diagnostics && <details class="diag"><summary>{t('technicalDetails')}</summary><pre>{JSON.stringify(f.diagnostics, null, 1)}</pre></details>}
          <div class="btn-row">
            {f.status !== 'seen' && <Button small kind="secondary" onClick={() => mark(f.id, 'seen')}>{t('fbs_seen')}</Button>}
            {f.status !== 'done' && <Button small color="green" onClick={() => mark(f.id, 'done')}>{t('fbs_done')}</Button>}
          </div>
        </Card>
      ))}
    </>
  );
}

function Tools() {
  const [handle, setHandle] = useState('');
  const [tier, setTier] = useState('plus');
  const [days, setDays] = useState(30);
  const [delta, setDelta] = useState(100);
  const [note, setNote] = useState('');
  const grant = async () => { const r = await attempt(() => C.admin.grant(handle.trim(), tier, Number(days) || 0)); if (r) toast(t('grantedPlan', { handle: r.handle, plan: t(`plan_${r.tier}`) })); };
  const credit = async () => { const r = await attempt(() => C.admin.credits(handle.trim(), Number(delta) || 0, note)); if (r) toast(t('creditsNow', { n: r.credits })); };
  return (
    <>
      <label class="field-label" for="adm-handle">{t('username')}</label>
      <input class="field" id="adm-handle" value={handle} onInput={(e) => setHandle(e.currentTarget.value)} placeholder="@someone" autocapitalize="off" />
      <Section title={t('givePlan')} footer={t('givePlanNote')}>
        <div class="chips">{['free', 'plus', 'pro'].map((x) => <Chip key={x} on={tier === x} onClick={() => setTier(x)}>{t(`plan_${x}`)}</Chip>)}</div>
        <label class="field-label" for="adm-days">{t('days')}</label>
        <input class="field" id="adm-days" type="number" min="0" max="3650" value={days} onInput={(e) => setDays(e.currentTarget.value)} />
        <Button disabled={!handle.trim()} onClick={grant} icon="crown">{t('givePlan')}</Button>
      </Section>
      <Section title={t('giveCredits')}>
        <input class="field" type="number" value={delta} onInput={(e) => setDelta(e.currentTarget.value)} aria-label={t('credits')} />
        <input class="field" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('why')} aria-label={t('why')} />
        <Button disabled={!handle.trim()} onClick={credit} icon="star">{t('giveCredits')}</Button>
      </Section>
      <p class="note-text"><Icon name="info" size={13} /> {t('devNote')}</p>
    </>
  );
}
