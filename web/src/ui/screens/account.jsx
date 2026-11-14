import { useState, useRef, useEffect } from 'preact/hooks';
import { useApp, updateSettings, closeSheet, openSheet, toast, makeBackup, restoreBackup, eraseAll, clearExamples, push } from '../state.js';
import { t, LANGS, instrumentName, INSTRUMENTS } from '../../core/i18n.js';
import { Icon, List, Row, Toggle, Segmented, Stepper, Button, Section, Chip } from '../components.jsx';
import { Mascot } from '../mascot.jsx';
import { hasServer } from '../api.js';
import { C, attempt, ensureAccount } from '../account.js';
import { isNative, platform } from '../native.js';
import { Person, Coins } from './social.jsx';
import { SheetFrame } from './common.jsx';
import { saveFile } from '../files.js';

export function AccountSheet() {
  const s = useApp();
  const st = s.settings;
  const me = s.me;
  const fileRef = useRef(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (hasServer()) ensureAccount(); }, []);
  const backup = async () => {
    const json = await makeBackup();
    try {
      const ok = await saveFile(`Melovyn backup ${new Date().toISOString().slice(0, 10)}.json`, new TextEncoder().encode(json));
      if (ok) toast(t('backup') + ' ✓');
    } catch { toast(t('saveFailed'), 'err'); }
  };
  const restore = async (e) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    try { const n = await restoreBackup(await f.text()); toast(t('restored', { n })); } catch (err) { toast(err.message, 'err'); }
  };
  const go = (view, props = {}) => { closeSheet(); push(view, props); };
  const tier = me?.tier || 'free';
  return (
    <SheetFrame title={t('account')} left={false} right={t('done')} onRight={closeSheet}>
      {hasServer() && (
        <button type="button" class="me-card" onClick={() => (me?.handle ? go('profile', { handle: me.handle }) : go('editProfile'))}>
          <Person user={me || { name: st.name || 'Musician', avatar: { color: 'purple' } }} size={58} />
          <span class="me-main"><strong>{me?.name || st.name || t('yourName')}</strong><span>{me ? `@${me.handle}` : t('connecting')}</span>
            <span class="me-tags"><span class={`pill ${tier === 'free' ? 'gray' : tier === 'pro' ? 'orange' : 'purple'}`}>{t(`plan_${tier}`)}</span>{me && <Coins n={me.credits} size="sm" />}</span></span>
          <Icon name="chevronR" size={15} />
        </button>
      )}
      {hasServer() && (
        <Section>
          <List>
            <Row icon="pencil" color="purple" title={t('editProfile')} onClick={() => go('editProfile')} />
            <Row icon="crown" color="orange" title={tier === 'free' ? t('seePlans') : t('yourPlan')} subtitle={tier === 'free' ? t('plansRowSub') : t('plansRowSubPaid')} onClick={() => openSheet('plans')} />
            <Row icon="star" color="yellow" title={t('credits')} detail={me?.credits ?? ''} onClick={() => go('wallet')} />
            <Row icon="bell" color="blue" title={t('notifications')} detail={me?.unread || ''} onClick={() => go('notifications')} />
          </List>
        </Section>
      )}
      {hasServer() && (
        <Section title={t('signInTitle')} footer={me?.has_password ? t('signedInEverywhere', { n: me?.devices || 1 }) : t('signInHelp')}>
          <List>
            {!me?.has_password && <Row icon="key" color="green" title={t('setPassword')} subtitle={t('setPasswordSub')} onClick={() => openSheet('setPassword')} />}
            <Row icon="person" color="blue" title={t('signInOther')} onClick={() => openSheet('signIn')} />
            {me?.has_password && <Row icon="logout" color="gray" title={t('signOut')} onClick={async () => { await C.logout(); toast(t('signedOut')); ensureAccount(); }} />}
          </List>
        </Section>
      )}
      <Section title={t('profile')}>
        <List>
          <Row title={t('yourName')} right={<input type="text" id="acc-name" value={st.name} placeholder={t('yourName')} onInput={(e) => updateSettings({ name: e.currentTarget.value })} aria-label={t('yourName')} />} />
          <Row title={t('instrument')} right={<select id="acc-inst" value={st.instrument} onChange={(e) => updateSettings({ instrument: e.currentTarget.value })}>{INSTRUMENTS.map((k) => <option key={k} value={k}>{instrumentName(k)}</option>)}</select>} />
          <Row title={t('voiceType')} right={<select id="acc-voice" value={st.voice} onChange={(e) => updateSettings({ voice: e.currentTarget.value, voiceRange: null })}>{['soprano', 'mezzo', 'alto', 'tenor', 'baritone', 'bass'].map((v) => <option key={v} value={v}>{t(v === 'bass' ? 'bassVoice' : v)}</option>)}</select>} />
        </List>
      </Section>
      <Section title={t('language')}>
        <List><Row title={t('language')} right={<select id="acc-lang" value={st.lang} onChange={(e) => updateSettings({ lang: e.currentTarget.value })}>{LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>} /></List>
      </Section>
      <Section title={t('appearance')}>
        <Segmented id="acc-theme" value={st.theme} onChange={(v) => updateSettings({ theme: v })} options={[{ value: 'system', label: t('system') }, { value: 'light', label: t('light') }, { value: 'dark', label: t('dark') }]} />
      </Section>
      <Section title={t('soundSync')} footer={t('soundSyncHelp')}>
        <div class="sync-row">
          <input type="range" id="acc-sync" min="-100" max="400" step="10" value={st.syncMs || 0} onInput={(e) => updateSettings({ syncMs: Number(e.currentTarget.value) })} aria-label={t('soundSync')} />
          <span class="num">{st.syncMs > 0 ? '+' : ''}{st.syncMs || 0} ms</span>
        </div>
        <div class="chips">{[[0, 'syncSpeaker'], [180, 'syncBluetooth'], [250, 'syncAirpods']].map(([v, k]) => <Chip key={k} on={(st.syncMs || 0) === v} onClick={() => updateSettings({ syncMs: v })}>{t(k)}</Chip>)}</div>
      </Section>
      <Section title={t('dailyGoal')}>
        <Stepper label={t('dailyGoal')} value={`${st.dailyGoal} ${t('min')}`} onDec={() => updateSettings({ dailyGoal: Math.max(5, st.dailyGoal - 5) })} onInc={() => updateSettings({ dailyGoal: Math.min(120, st.dailyGoal + 5) })} />
      </Section>
      <Section footer={t('wifiOnlyHelp')}>
        <List><Row icon="wifi" color="blue" title={t('wifiOnly')} right={<Toggle id="acc-wifi" checked={st.wifiOnly} onChange={(v) => updateSettings({ wifiOnly: v })} label={t('wifiOnly')} />} /></List>
      </Section>
      <Section title={t('helpAndFeedback')}>
        <List>
          <Row icon="quiz" color="teal" title={t('help')} subtitle={t('helpSub')} onClick={() => go('help')} />
          <Row icon="send" color="blue" title={t('sendFeedback')} subtitle={t('sendFeedbackSub')} onClick={() => openSheet('feedback')} />
          <Row icon="users" color="green" title={t('guidelines')} onClick={() => openSheet('guidelines')} />
        </List>
      </Section>
      {!isNative() && (
        <Section title={t('installTitle')} footer={t('installHelp')}>
          <List><Row icon="download" color="green" title={t('installTitle')} subtitle="Safari → Share → Add to Home Screen" /></List>
        </Section>
      )}
      <Section footer={t('backupHelp')}>
        <input ref={fileRef} type="file" class="hidden-input" accept=".json,application/json" onChange={restore} id="restore-input" aria-label={t('restore')} />
        <List>
          <Row icon="cloud" color="cyan" title={t('backup')} onClick={backup} />
          <Row icon="download" color="blue" title={t('restore')} onClick={() => fileRef.current?.click()} />
          {s.examples && <Row icon="trash" color="orange" title={t('removeExamples')} onClick={clearExamples} />}
        </List>
      </Section>
      {hasServer() && (
        <Section title={t('developer')}>
          <List>
            {tier === 'dev' ? <Row icon="bolt" color="purple" title={t('devPanel')} subtitle={t('devPanelSub')} onClick={() => go('admin')} />
              : <Row icon="key" color="gray" title={t('devUnlock')} subtitle={t('devUnlockSub')} onClick={() => openSheet('devCode')} />}
          </List>
        </Section>
      )}
      <Section>
        <List>
          {!confirm ? <Row title={t('resetAll')} danger onClick={() => setConfirm(true)} />
            : <Row title={t('confirmErase')} danger right={<span style={{ display: 'flex', gap: 8 }}><Button small kind="secondary" onClick={() => setConfirm(false)}>{t('cancel')}</Button><Button small color="red" onClick={eraseAll}>{t('erase')}</Button></span>} />}
          {hasServer() && me && <Row title={t('deleteAccount')} danger onClick={() => openSheet('deleteAccount')} />}
        </List>
      </Section>
      <Section title={t('about')}>
        <List><Row title="Melovyn" detail={`${globalThis.HAPTUNE_CONFIG?.version || ''} (${platform()})`} onClick={() => openSheet('about')} /></List>
      </Section>
    </SheetFrame>
  );
}

export function SetPasswordSheet() {
  const s = useApp();
  const [handle, setHandle] = useState(s.me?.handle || '');
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await attempt(() => C.setPassword(handle, pw));
    setBusy(false);
    if (r) { setCode(r.recovery_code); ensureAccount({ fresh: true }); }
  };
  if (code) {
    return (
      <SheetFrame title={t('setPassword')} right={t('done')} onRight={closeSheet}>
        <div class="empty"><Mascot mood="cheer" size={80} /><h3>{t('passwordSet', { handle })}</h3><p>{t('recoveryCodeHelp')}</p></div>
        <div class="code-box num">{code}</div>
        <Button full kind="secondary" icon="copy" onClick={() => { try { navigator.clipboard.writeText(code); toast(t('copied')); } catch { /* shown above */ } }}>{t('copy')}</Button>
      </SheetFrame>
    );
  }
  return (
    <SheetFrame title={t('setPassword')} right={t('save')} onRight={save} rightDisabled={busy || pw.length < 8 || handle.length < 3}>
      <p class="note-text">{t('setPasswordSub')}</p>
      <label class="field-label" for="sp-handle">{t('username')}</label>
      <input class="field" id="sp-handle" autocapitalize="off" autocomplete="username" maxLength={20} value={handle} onInput={(e) => setHandle(e.currentTarget.value.toLowerCase().replace(/[^a-z0-9_.]/g, ''))} />
      <label class="field-label" for="sp-pw">{t('password')}</label>
      <input class="field" id="sp-pw" type="password" autocomplete="new-password" minLength={8} value={pw} onInput={(e) => setPw(e.currentTarget.value)} placeholder={t('atLeast8')} />
      <Button full disabled={busy || pw.length < 8 || handle.length < 3} onClick={save}>{t('save')}</Button>
    </SheetFrame>
  );
}

export function SignInSheet() {
  const [mode, setMode] = useState('login');
  const [handle, setHandle] = useState('');
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [newCode, setNewCode] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      if (mode === 'login') { await C.login(handle, pw); toast(t('signedIn')); closeSheet(); }
      else { const r = await C.recover(handle, code, pw); setNewCode(r.recovery_code); }
    } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  if (newCode) {
    return (
      <SheetFrame title={t('signInOther')} right={t('done')} onRight={closeSheet}>
        <div class="empty"><Mascot mood="cheer" size={80} /><h3>{t('signedIn')}</h3><p>{t('newRecoveryCode')}</p></div>
        <div class="code-box num">{newCode}</div>
      </SheetFrame>
    );
  }
  return (
    <SheetFrame title={t('signInOther')} right={mode === 'login' ? t('signIn') : t('reset')} onRight={go} rightDisabled={busy || !handle || pw.length < (mode === 'login' ? 1 : 8)}>
      <p class="note-text">{t('signInOtherHelp')}</p>
      <label class="field-label" for="si-handle">{t('username')}</label>
      <input class="field" id="si-handle" autocapitalize="off" autocomplete="username" value={handle} onInput={(e) => setHandle(e.currentTarget.value)} />
      {mode === 'recover' && <>
        <label class="field-label" for="si-code">{t('recoveryCode')}</label>
        <input class="field num" id="si-code" autocapitalize="characters" value={code} onInput={(e) => setCode(e.currentTarget.value)} placeholder="ABCD-1234-…" />
      </>}
      <label class="field-label" for="si-pw">{mode === 'login' ? t('password') : t('newPassword')}</label>
      <input class="field" id="si-pw" type="password" autocomplete={mode === 'login' ? 'current-password' : 'new-password'} value={pw} onInput={(e) => setPw(e.currentTarget.value)} />
      <Button full disabled={busy} onClick={go}>{mode === 'login' ? t('signIn') : t('reset')}</Button>
      <button type="button" class="link" onClick={() => setMode(mode === 'login' ? 'recover' : 'login')}>{mode === 'login' ? t('forgotPassword') : t('backToSignIn')}</button>
      <p class="note-text">{t('signInWarning')}</p>
    </SheetFrame>
  );
}

export function DeleteAccountSheet() {
  const [text, setText] = useState('');
  const word = t('deleteWord');
  const go = async () => {
    try { await C.deleteAccount(); toast(t('accountDeleted')); closeSheet(); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <SheetFrame title={t('deleteAccount')}>
      <div class="with-mascot"><Mascot mood="sad" size={56} /><div class="bubble left">{t('deleteAccountHelp')}</div></div>
      <label class="field-label" for="del-confirm">{t('typeToConfirm', { word })}</label>
      <input class="field" id="del-confirm" value={text} onInput={(e) => setText(e.currentTarget.value)} />
      <Button full color="red" disabled={text.trim().toLowerCase() !== word.toLowerCase()} onClick={go}>{t('deleteAccount')}</Button>
    </SheetFrame>
  );
}

export function DevCodeSheet() {
  const [code, setCode] = useState('');
  const go = async () => {
    const r = await attempt(() => C.dev(code.trim()));
    if (r) { toast(t('devUnlocked')); closeSheet(); }
  };
  return (
    <SheetFrame title={t('devUnlock')} right={t('unlock')} onRight={go} rightDisabled={code.trim().length < 8}>
      <p class="note-text">{t('devUnlockHelp')}</p>
      <input class="field" id="dev-code" type="password" value={code} onInput={(e) => setCode(e.currentTarget.value)} autocomplete="off" aria-label={t('devUnlock')} />
    </SheetFrame>
  );
}

export { PlansSheet as PaywallSheet } from './plans.jsx';
