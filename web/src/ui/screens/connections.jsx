// Account > Connections (what is linked to Google, with a remove button for each) and the teacher verification
// request (Me > Teach, and wherever a feature needs a verified teacher).
import { useEffect, useState } from 'preact/hooks';
import { useApp, closeSheet, toast } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, List, Row, Button } from '../components.jsx';
import { SheetFrame } from './common.jsx';
import { C, ensureAccount } from '../account.js';
import { connectGoogle, askGoogle, toBase64, isDeclined } from '../google.js';
import { GoogleButton } from './hub.jsx';
import { Mascot } from '../mascot.jsx';
import { hasServer } from '../api.js';

const ICON = { calendar: ['calendar', 'blue'], drive: ['cloud', 'green'], contacts: ['users', 'orange'] };

const SIGNIN_ICON = { google: ['globe', 'blue'], apple: ['phone', 'gray'], password: ['key', 'violet'] };

/** The ways this account signs in; one can be removed only while another remains. */
function SignInMethods() {
  const [m, setM] = useState(null);
  const [err, setErr] = useState('');
  const load = () => C.signinMethods().then(setM).catch((e) => setErr(e.message));
  useEffect(() => { if (hasServer()) load(); }, []);
  const remove = async (id) => {
    if (!confirm(t('removeSigninQ', { m: t(`signin_${id}`) }))) return;
    try { setM(await C.removeSignin(id)); ensureAccount({ fresh: true }); } catch (e) { setErr(e.detail?.message || e.message); }
  };
  if (!m) return err ? <p class="t-red tiny">{err}</p> : null;
  return (
    <section id="signin-methods">
      <h3 class="cr-topic-name">{t('signinWays')}</h3>
      <List>
        {m.methods.map((x) => (
          <Row key={x.id} id={`signin-${x.id}`} icon={SIGNIN_ICON[x.id][0]} color={SIGNIN_ICON[x.id][1]} title={t(`signin_${x.id}`)} chevron={false}
            subtitle={x.linked ? (x.email || (x.handle ? `@${x.handle}` : t('linkedT'))) : t('notLinkedT')}
            right={x.can_remove ? <Button small kind="secondary" onClick={() => remove(x.id)}>{t('remove')}</Button>
              : x.linked ? <span class="pill-ok"><Icon name="check" size={13} stroke={2.6} />{t('linkedT')}</span> : null} />
        ))}
      </List>
      <p class="tiny muted">{t('signinWaysSub')}</p>
      {err && <p class="t-red tiny">{err}</p>}
    </section>
  );
}

const FEATURES = ['calendar', 'drive', 'contacts'];

/** The three Google features with a tick or a dash: what Haptune may use. */
function GoogleFeatureList({ info, manage, busy, onRemove }) {
  return (
    <List>
      {info.features.map((f) => (
        <Row key={f.id} id={`conn-${f.id}`} icon={ICON[f.id][0]} color={ICON[f.id][1]} title={t(`conn_${f.id}`)} subtitle={t(`conn_${f.id}Sub`)} chevron={false}
          right={manage && f.linked ? <Button small kind="secondary" disabled={busy === f.id} onClick={() => onRemove(f.id)}>{t('remove')}</Button>
            : f.linked ? <span class="pill-ok"><Icon name="check" size={13} stroke={2.6} />{t('onT')}</span> : <span class="pill-off">{t('offT')}</span>} />
      ))}
    </List>
  );
}

export function ConnectionsSheet() {
  const s = useApp();
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [manage, setManage] = useState(false);
  const load = () => C.gconn.list().then(setInfo).catch((e) => setErr(e.message));
  useEffect(() => { if (hasServer()) load(); }, [s.me?.google, s.resumedAt]);
  const allow = async () => {
    setBusy('all'); setErr(''); setNote('');
    try {
      const r = await connectGoogle('all');
      if (r?.opened) setNote(t('gAllowOnSite')); else { setInfo(r); if (r.all_linked) toast(t('gAllSet')); }
    } catch (e) { if (isDeclined(e)) setNote(e.message); else setErr(e.message || String(e)); }
    setBusy('');
  };
  const remove = async (f) => {
    setBusy(f); setErr('');
    try { setInfo(await C.gconn.revoke(f)); } catch (e) { setErr(e.message || String(e)); }
    setBusy('');
  };
  return (
    <SheetFrame title={t('connectionsT')}>
      <h3 class="cr-topic-name">{t('connGoogleT')}</h3>
      {!info ? (err ? <p class="t-red">{err}</p> : <div class="loading"><div class="spinner" /></div>) : !info.available ? (
        <p class="note-text">{t('connNotSetUp')}</p>
      ) : !info.signed_in_google ? (
        <div class="g-card" id="conn-need-google">
          <p class="note-text">{t('gNeedSignIn')}</p>
          <GoogleButton onDone={() => { ensureAccount({ fresh: true }); load(); }} />
        </div>
      ) : (
        <>
          <div class={`g-card ${info.all_linked ? 'ok' : ''}`} id="conn-google">
            <span class="g-logo" aria-hidden="true">G</span>
            <span class="g-main"><strong>{info.email}</strong><span>{info.all_linked ? t('gAllSet') : t('gSomeOff')}</span></span>
            {info.all_linked && <Icon name="check" size={20} stroke={2.8} />}
          </div>
          <GoogleFeatureList info={info} manage={manage} busy={busy} onRemove={remove} />
          {!info.all_linked && <Button full icon="check" disabled={busy === 'all'} onClick={allow} id="conn-allow-all">{t('gAllowAll')}</Button>}
          <button type="button" class="link" onClick={() => setManage(!manage)} id="conn-manage">{manage ? t('done') : t('gManage')}</button>
          {manage && info.features.some((f) => f.linked) && <Button kind="plain" full icon="trash" onClick={() => remove('all')} id="conn-all">{t('disconnectAll')}</Button>}
        </>
      )}
      {note && <p class="note-text" id="conn-declined">{note}</p>}
      {err && info && <p class="t-red tiny">{err}</p>}
      <SignInMethods />
    </SheetFrame>
  );
}

/** Right after signing in with Google: allow Calendar, Drive and Contacts with one tap (or not now). */
export function GoogleAllowSheet({ info: first }) {
  const s = useApp();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState(false);
  // the phone app: back from the browser where Google asked, check and close by itself
  useEffect(() => {
    if (!s.resumedAt || done) return;
    C.gconn.list().then((r) => { if (r.all_linked) { setDone(true); toast(t('gAllSet')); setTimeout(closeSheet, 900); } }).catch(() => {});
  }, [s.resumedAt]);
  const later = async () => {
    const { local } = await import('../storage.js');
    const seen = local.get('gAllowAsked', { n: 0, at: 0 });
    local.set('gAllowAsked', { n: seen.n + 1, at: Date.now() });
    closeSheet();
  };
  const allow = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await connectGoogle('all');
      if (r?.opened) setMsg(t('gAllowOnSite'));
      else { setDone(true); toast(t('gAllSet')); setTimeout(closeSheet, 900); }
    } catch (e) { setMsg(e.message || String(e)); }
    setBusy(false);
  };
  return (
    <SheetFrame title={t('gAllowT')}>
      <div class="sheet-mascot"><Mascot mood={done ? 'cheer' : 'wave'} size={80} /></div>
      <p class="note-text center">{t('gAllowSub', { email: first?.email || '' })}</p>
      <List>
        {FEATURES.map((f) => <Row key={f} icon={ICON[f][0]} color={ICON[f][1]} title={t(`conn_${f}`)} subtitle={t(`conn_${f}Sub`)} chevron={false} />)}
      </List>
      <p class="tiny muted center">{t('gAllowPrivacy')}</p>
      <Button full icon="check" disabled={busy || done} onClick={allow} id="g-allow">{t('gAllowAll')}</Button>
      {msg && <p class="note-text center" id="g-allow-msg">{msg}</p>}
      <button type="button" class="hw-skip" onClick={later} id="g-allow-later">{t('notNow')}</button>
    </SheetFrame>
  );
}

/** The website page the phone app opens (…/app/#gconnect/TICKET/all): one tap, Google's window, done. */
export function GoogleTicketSheet({ ticket, feature = 'all' }) {
  const [who, setWho] = useState(null);
  const [state, setStateX] = useState('ready');                    // ready | busy | done | error
  const [msg, setMsg] = useState('');
  useEffect(() => { C.gconn.ticketInfo(ticket).then(setWho).catch((e) => { setStateX('error'); setMsg(e.detail?.message || e.message); }); }, [ticket]);
  const go = async () => {
    setStateX('busy'); setMsg('');
    try { await askGoogle(feature, { clientId: who.client_id, hint: who.email, ticket }); setStateX('done'); } catch (e) { setStateX('ready'); setMsg(e.message || String(e)); }
  };
  return (
    <SheetFrame title={t('gAllowT')}>
      <div class="sheet-mascot"><Mascot mood={state === 'done' ? 'cheer' : 'wave'} size={84} /></div>
      {state === 'error' ? <p class="note-text center">{msg}</p> : !who ? <div class="loading"><div class="spinner" /></div> : state === 'done' ? (
        <div class="empty" id="g-ticket-done"><h3>{t('gAllSet')}</h3><p>{t('gBackToApp')}</p></div>
      ) : (
        <>
          <p class="note-text center">{t('gTicketFor', { name: who.name || who.handle, email: who.email })}</p>
          <List>{FEATURES.map((f) => <Row key={f} icon={ICON[f][0]} color={ICON[f][1]} title={t(`conn_${f}`)} subtitle={t(`conn_${f}Sub`)} chevron={false} />)}</List>
          <Button full icon="check" disabled={state === 'busy'} onClick={go} id="g-ticket-allow">{t('gAllowAll')}</Button>
          {msg && <p class="note-text center">{msg}</p>}
        </>
      )}
    </SheetFrame>
  );
}

/** Ask to be verified as a teacher: school/organisation, role, optional document. */
export function TeacherVerifySheet() {
  const s = useApp();
  const [st, setSt] = useState(null);
  const [org, setOrg] = useState('');
  const [role, setRole] = useState('');
  const [doc, setDoc] = useState(null);       // {name, type, b64}
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { C.teacher.status().then(setSt).catch((e) => setErr(e.message)); }, []);
  const pick = async (e) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(f.type)) { setErr(t('verifyDoc')); return; }
    if (f.size > 3 * 1024 * 1024) { setErr('3 MB max'); return; }
    setDoc({ name: f.name, type: f.type, b64: toBase64(new Uint8Array(await f.arrayBuffer())) });
  };
  const send = async () => {
    setBusy(true); setErr('');
    try {
      const r = await C.teacher.request({ org: org.trim(), role_text: role.trim(), ...(doc ? { doc_b64: doc.b64, doc_type: doc.type } : {}) });
      setSt(r);
      ensureAccount({ fresh: true });
      if (r.verified) toast(t('verifiedTeacher'));
    } catch (e) { setErr(e.message || String(e)); }
    setBusy(false);
  };
  const google = !!s.me?.google;
  return (
    <SheetFrame title={t('verifyT')}>
      {!st ? (err ? <p class="t-red">{err}</p> : <div class="loading"><div class="spinner" /></div>) : st.verified ? (
        <div class="empty"><span class="verified-badge big"><Icon name="check" size={18} stroke={2.8} />{t('verifiedTeacher')}</span><p>{st.org}</p></div>
      ) : (
        <>
          <p class="note-text">{t('verifySub')} {t('verifyLimit', { n: st.max_students_unverified })}</p>
          {st.status === 'pending' && <div class="banner"><Icon name="clock" size={18} />{t('verifyPending')}</div>}
          {st.status === 'rejected' && <div class="banner"><Icon name="info" size={18} />{t('verifyRejected', { note: st.note || '' })}</div>}
          {!google && <div class="banner" id="verify-needs-google"><Icon name="info" size={18} />{t('verifyNeedsGoogle')}</div>}
          <label class="field3"><span>{t('verifyOrg')}</span><input id="verify-org" value={org} onInput={(e) => setOrg(e.currentTarget.value)} maxLength={160} /></label>
          <label class="field3"><span>{t('verifyRole')}</span><input value={role} onInput={(e) => setRole(e.currentTarget.value)} maxLength={120} /></label>
          <label class="field3"><span>{t('verifyDoc')}</span><input type="file" accept="application/pdf,image/jpeg,image/png" onChange={pick} /></label>
          {doc && <p class="tiny">{doc.name}</p>}
          {err && <p class="t-red tiny">{err}</p>}
          <Button full icon="check" disabled={busy || !google || org.trim().length < 2} onClick={send} id="verify-send">{t('verifySend')}</Button>
        </>
      )}
      <Button kind="plain" full onClick={closeSheet}>{t('close')}</Button>
    </SheetFrame>
  );
}
