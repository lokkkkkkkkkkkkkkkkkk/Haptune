// Account > Connections (what is linked to Google, with a remove button for each) and the teacher verification
// request (Me > Teach, and wherever a feature needs a verified teacher).
import { useEffect, useState } from 'preact/hooks';
import { useApp, closeSheet, toast } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, List, Row, Button } from '../components.jsx';
import { SheetFrame } from './common.jsx';
import { C, ensureAccount } from '../account.js';
import { connectGoogle, toBase64, isDeclined } from '../google.js';
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

export function ConnectionsSheet() {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { if (hasServer()) C.gconn.list().then(setInfo).catch((e) => setErr(e.message)); }, []);
  const act = async (f, on) => {
    setBusy(f); setErr(''); setNote('');
    try { setInfo(on ? await connectGoogle(f) : await C.gconn.revoke(f)); } catch (e) { if (isDeclined(e)) setNote(e.message); else setErr(e.message || String(e)); }
    setBusy('');
  };
  const any = info?.features?.some((f) => f.linked);
  return (
    <SheetFrame title={t('connectionsT')}>
      <SignInMethods />
      <h3 class="cr-topic-name">{t('connGoogleT')}</h3>
      <p class="note-text">{t('connHelp')}</p>
      {!info ? (err ? <p class="t-red">{err}</p> : <div class="loading"><div class="spinner" /></div>) : (
        <>
          {!info.available && <p class="note-text">{t('connNotSetUp')}</p>}
          {info.email && <p class="tiny muted">Google · {info.email}</p>}
          <List>
            {info.features.map((f) => (
              <Row key={f.id} id={`conn-${f.id}`} icon={ICON[f.id][0]} color={ICON[f.id][1]} title={t(`conn_${f.id}`)} subtitle={t(`conn_${f.id}Sub`)} chevron={false}
                right={f.linked
                  ? <Button small kind="secondary" disabled={busy === f.id} onClick={() => act(f.id, false)}>{t('disconnect')}</Button>
                  : <Button small disabled={!info.available || busy === f.id} onClick={() => act(f.id, true)}>{t('connect')}</Button>} />
            ))}
          </List>
          {any && <Button kind="plain" full icon="trash" onClick={() => act('all', false)} id="conn-all">{t('disconnectAll')}</Button>}
          {note && <p class="note-text" id="conn-declined">{note}</p>}
          {err && <p class="t-red tiny">{err}</p>}
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
