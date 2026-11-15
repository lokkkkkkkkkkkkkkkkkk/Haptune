// Account security and staff switches: 2-step verification (an authenticator app), Developer mode (the owner
// and developers only, off by default, on for this device after a code), where you're signed in (sign other
// devices out), and downloading your data.
import { useEffect, useState } from 'preact/hooks';
import { useApp, openSheet, closeSheet, toast, push, go, getState } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, Button, List, Row, Toggle } from '../components.jsx';
import { SheetFrame } from './common.jsx';
import { call } from '../api.js';
import { setMe } from '../account.js';
import { saveFile } from '../files.js';
import { qrSVG } from './hub.jsx';
import { timeAgo } from './social.jsx';

const codeInput = (v, set, id = 'code-in') => (
  <input class="field code-field" id={id} inputMode="numeric" autocomplete="one-time-code" maxLength={11} placeholder="123 456" value={v}
    onInput={(e) => set(e.currentTarget.value)} aria-label={t('tsCode')} />
);

export function TwoStepSheet({ then = null }) {
  const [st, setSt] = useState(null);           // {on, recovery_left, required}
  const [setup, setSetup] = useState(null);     // {secret, uri}
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);     // recovery codes, shown once
  const [busy, setBusy] = useState(false);
  useEffect(() => { call('/c/me/2fa').then(setSt).catch((e) => toast(e.message, 'err')); }, []);
  const begin = async () => { try { setSetup(await call('/c/me/2fa/setup', { method: 'POST' })); } catch (e) { toast(e.message, 'err'); } };
  const enable = async () => {
    setBusy(true);
    try { const r = await call('/c/me/2fa/enable', { method: 'POST', json: { code } }); setCodes(r.recovery_codes); setSt({ ...st, on: true, recovery_left: 10 }); setCode(''); setMe({ ...getState().me, totp: true }); } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  const newCodes = async () => {
    setBusy(true);
    try { const r = await call('/c/me/2fa/recovery', { method: 'POST', json: { code } }); setCodes(r.recovery_codes); setCode(''); } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  const off = async () => {
    setBusy(true);
    try { await call('/c/me/2fa/disable', { method: 'POST', json: { code } }); setSt({ ...st, on: false }); setCode(''); setMe({ ...getState().me, totp: false }); toast(t('tsOffDone')); } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  if (!st) return <SheetFrame title={t('tsTitle')}><div class="loading"><div class="spinner" /></div></SheetFrame>;
  if (codes) {
    return (
      <SheetFrame title={t('tsRecovery')} right={t('done')} onRight={() => { closeSheet(); if (then) setTimeout(() => openSheet(then), 0); }}>
        <p class="note-text">{t('tsRecoveryHelp')}</p>
        <div class="recovery-grid" id="ts-recovery">{codes.map((c) => <code key={c}>{c}</code>)}</div>
        <Button kind="secondary" full icon="download" onClick={() => saveFile('melovyn-recovery-codes.txt', `Melovyn recovery codes (each works once)\n\n${codes.join('\n')}\n`)}>{t('tsSaveCodes')}</Button>
      </SheetFrame>
    );
  }
  if (st.on) {
    return (
      <SheetFrame title={t('tsTitle')}>
        <div class="ts-state on"><Icon name="check" size={20} stroke={2.6} /> {t('tsIsOn')}</div>
        <p class="tiny muted">{t('tsLeft', { n: st.recovery_left })}</p>
        {codeInput(code, setCode)}
        <Button kind="secondary" full disabled={busy || code.length < 6} onClick={newCodes}>{t('tsNewCodes')}</Button>
        {!st.required && <Button kind="plain" full disabled={busy || code.length < 6} onClick={off}>{t('tsTurnOff')}</Button>}
        {st.required && <p class="note-text">{t('tsRequired')}</p>}
      </SheetFrame>
    );
  }
  if (!setup) {
    return (
      <SheetFrame title={t('tsTitle')}>
        <p class="note-text">{t('tsWhy')}</p>
        {st.required && <p class="note-text"><Icon name="info" size={14} /> {t('tsRequired')}</p>}
        <Button kind="brand" full icon="key" onClick={begin} id="ts-begin">{t('tsSetUp')}</Button>
      </SheetFrame>
    );
  }
  return (
    <SheetFrame title={t('tsTitle')}>
      <ol class="ts-steps"><li>{t('tsStep1')}</li><li>{t('tsStep2')}</li><li>{t('tsStep3')}</li></ol>
      <div class="ts-qr" dangerouslySetInnerHTML={{ __html: qrSVG(setup.uri, { size: 200 }) }} />
      <p class="tiny muted" style={{ textAlign: 'center' }}>{t('tsOrType')}</p>
      <code class="ts-secret" id="ts-secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
      {codeInput(code, setCode, 'ts-code')}
      <Button kind="brand" full disabled={busy || code.replace(/\D/g, '').length !== 6} onClick={enable} id="ts-enable">{t('tsTurnOn')}</Button>
    </SheetFrame>
  );
}

export function DevModeSheet() {
  const s = useApp();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const staff = s.me?.staff;
  const on = async () => {
    setBusy(true);
    try { const me = await call('/c/me/devmode', { method: 'POST', json: { on: true, code } }); setMe(me); closeSheet(); toast(t('dmOnToast')); push('admin', {}, 'me'); go('me'); } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  if (!s.me?.totp) {
    return (
      <SheetFrame title={t('dmTitle')}>
        <p class="note-text">{t('dmNeeds2fa')}</p>
        <Button kind="brand" full icon="key" onClick={() => { closeSheet(); setTimeout(() => openSheet('twoStep', { then: 'devMode' }), 0); }} id="dm-setup">{t('tsSetUp')}</Button>
      </SheetFrame>
    );
  }
  return (
    <SheetFrame title={t('dmTitle')}>
      <p class="note-text">{t('dmHelp', { h: 8 })}</p>
      {staff && <p class="tiny muted">{staff.role === 'owner' ? t('dmOwner') : t('dmScopes', { s: staff.scopes.map((x) => t(`scope_${x}`)).join(', ') })}</p>}
      {codeInput(code, setCode, 'dm-code')}
      <Button kind="brand" full icon="bolt" disabled={busy || code.replace(/[\s-]/g, '').length < 6} onClick={on} id="dm-on">{t('dmTurnOn')}</Button>
    </SheetFrame>
  );
}

/** The Developer mode switch (Me, and Settings), shown only to the owner and developers. */
export function DevModeRows() {
  const s = useApp();
  const staff = s.me?.staff;
  if (!staff) return null;
  const toggle = async (v) => {
    if (v) { openSheet('devMode'); return; }
    try { setMe(await call('/c/me/devmode', { method: 'POST', json: { on: false } })); toast(t('dmOffToast')); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <List>
      <Row icon="bolt" color="purple" title={t('dmTitle')} subtitle={staff.dev_mode ? t('dmUntil', { time: new Date(staff.dev_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t('dmOffSub')}
        right={<Toggle id="me-devmode" checked={staff.dev_mode} onChange={toggle} label={t('dmTitle')} />} />
      {staff.dev_mode && <Row icon="summary" color="purple" title={t('devPanel')} subtitle={staff.role === 'owner' ? t('dmOwner') : t(`role_${staff.role}`)} onClick={() => push('admin')} id="me-dashboard" />}
    </List>
  );
}

export function SessionsSheet() {
  const [items, setItems] = useState(null);
  const load = () => call('/c/me/sessions').then((r) => setItems(r.items)).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  const end = async (id) => { try { await call(`/c/me/sessions/${id}`, { method: 'DELETE' }); toast(t('ssEnded')); load(); } catch (e) { toast(e.message, 'err'); } };
  const others = async () => { try { await call('/c/me/sessions/others', { method: 'POST' }); toast(t('ssEnded')); load(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <SheetFrame title={t('ssTitle')}>
      {!items ? <div class="loading"><div class="spinner" /></div> : <>
        <List>{items.map((x) => (
          <Row key={x.id} icon={x.current ? 'check' : 'phone'} color={x.current ? 'green' : 'gray'} title={x.id === 'device' ? t('ssFirst') : x.label}
            subtitle={[x.current ? t('ssThis') : '', x.seen ? t('admSeen', { when: timeAgo(x.seen) }) : '', x.dev_mode ? t('dmTitle') : ''].filter(Boolean).join(' · ')}
            right={x.current ? null : <Button small kind="plain" onClick={() => end(x.id)}>{t('ssSignOut')}</Button>} />))}</List>
        {items.length > 1 && <Button kind="secondary" full onClick={others} id="ss-others">{t('ssOthers')}</Button>}
      </>}
    </SheetFrame>
  );
}

export async function downloadMyData() {
  try {
    const data = await call('/c/me/export');
    await saveFile(`melovyn-my-data-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1));
  } catch (e) { toast(e.message, 'err'); }
}

/** Settings > Privacy and security: 2-step verification, devices, your data, usage statistics. */
export function SecurityRows({ registered, settings, updateSettings }) {
  const s = useApp();
  return (
    <List>
      {registered && <Row icon="key" color="green" title={t('tsTitle')} subtitle={s.me?.totp ? t('tsIsOn') : t('tsOffSub')} onClick={() => openSheet('twoStep')} id="acc-2fa" />}
      <Row icon="phone" color="blue" title={t('ssTitle')} subtitle={t('ssSub')} onClick={() => openSheet('sessions')} id="acc-sessions" />
      <Row icon="download" color="teal" title={t('myData')} subtitle={t('myDataSub')} onClick={downloadMyData} id="acc-export" />
      <Row icon="summary" color="gray" title={t('usageStats')} subtitle={t('usageStatsSub')}
        right={<Toggle id="acc-analytics" checked={settings.analytics !== false} onChange={(v) => updateSettings({ analytics: v })} label={t('usageStats')} />} />
    </List>
  );
}
