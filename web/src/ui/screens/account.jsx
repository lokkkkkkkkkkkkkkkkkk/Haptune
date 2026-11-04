import { useState, useRef } from 'preact/hooks';
import { useApp, updateSettings, setPlus, closeSheet, openSheet, toast, makeBackup, restoreBackup, eraseAll, clearExamples } from '../state.js';
import { t, LANGS, instrumentName, INSTRUMENTS } from '../../core/i18n.js';
import { Icon, List, Row, Toggle, Segmented, Stepper, Button, Section, Card, Badge } from '../components.jsx';
import { SheetFrame } from './common.jsx';
import { saveFile } from './piece.jsx';

export function AccountSheet() {
  const s = useApp();
  const st = s.settings;
  const fileRef = useRef(null);
  const [confirm, setConfirm] = useState(false);
  const backup = async () => {
    const json = await makeBackup();
    const ok = await saveFile(`Haptune backup ${new Date().toISOString().slice(0, 10)}.json`, new TextEncoder().encode(json));
    if (ok) toast(t('backup') + ' ✓');
  };
  const restore = async (e) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    try { const n = await restoreBackup(await f.text()); toast(t('restored', { n })); } catch (err) { toast(err.message, 'err'); }
  };
  return (
    <SheetFrame title={t('account')} left={false} right={t('done')} onRight={closeSheet}>
      <Section title={t('profile')}>
        <List>
          <Row title={t('yourName')} right={<input type="text" id="acc-name" value={st.name} onInput={(e) => updateSettings({ name: e.currentTarget.value })} aria-label={t('yourName')} />} />
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
      <Section title={t('dailyGoal')}>
        <Stepper label={t('dailyGoal')} value={`${st.dailyGoal} ${t('min')}`} onDec={() => updateSettings({ dailyGoal: Math.max(5, st.dailyGoal - 5) })} onInc={() => updateSettings({ dailyGoal: Math.min(120, st.dailyGoal + 5) })} />
      </Section>
      <Section footer={t('wifiOnlyHelp')}>
        <List><Row icon="wifi" color="blue" title={t('wifiOnly')} right={<Toggle id="acc-wifi" checked={st.wifiOnly} onChange={(v) => updateSettings({ wifiOnly: v })} label={t('wifiOnly')} />} /></List>
      </Section>
      <Section title={t('subscription')}>
        <List>
          {s.plus ? <Row icon="crown" color="purple" title={t('plusActive')} right={<Button kind="plain" small onClick={() => setPlus(false)}>{t('off')}</Button>} />
            : <Row icon="crown" color="purple" title={t('plusTitle')} subtitle={t('tryFreeWeek')} onClick={() => openSheet('paywall')} />}
        </List>
      </Section>
      <Section title={t('installTitle')} footer={t('installHelp')}>
        <List><Row icon="download" color="green" title={t('installTitle')} subtitle="Safari → Share → Add to Home Screen" /></List>
      </Section>
      <Section footer={t('backupHelp')}>
        <input ref={fileRef} type="file" class="hidden-input" accept=".json,application/json" onChange={restore} id="restore-input" aria-label={t('restore')} />
        <List>
          <Row icon="cloud" color="cyan" title={t('backup')} onClick={backup} />
          <Row icon="download" color="blue" title={t('restore')} onClick={() => fileRef.current?.click()} />
          {s.examples && <Row icon="trash" color="orange" title={t('removeExamples')} onClick={clearExamples} />}
        </List>
      </Section>
      <Section>
        <List>
          {!confirm ? <Row title={t('resetAll')} danger onClick={() => setConfirm(true)} />
            : <Row title={t('confirmErase')} danger right={<span style={{ display: 'flex', gap: 8 }}><Button small kind="secondary" onClick={() => setConfirm(false)}>{t('cancel')}</Button><Button small color="red" onClick={eraseAll}>{t('erase')}</Button></span>} />}
        </List>
      </Section>
      <Section title={t('about')} footer={t('licences')}>
        <List><Row title="Haptune" detail="0.3.0 (web)" /></List>
      </Section>
    </SheetFrame>
  );
}

const PLANS = [
  { id: 'monthly', price: 'RM 14.90', per: '/ mo', label: 'monthly' },
  { id: 'yearly', price: 'RM 99.90', per: '/ yr', label: 'yearly', trial: true, best: true },
  { id: 'lifetime', price: 'RM 249.90', per: '', label: 'lifetime' },
];

export function PaywallSheet() {
  const [plan, setPlanSel] = useState('yearly');
  const start = () => { setPlus(true); toast(t('plusActive')); closeSheet(); };
  return (
    <SheetFrame title={t('plusTitle')} full>
      <div class="hero plus">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Icon name="crown" size={28} stroke={2.2} /><h2 style={{ fontSize: 26 }}>Haptune Plus</h2></div>
        <p>{t('plusBlurb')}</p>
      </div>
      <Card>
        {['plusFeatures1', 'plusFeatures2', 'plusFeatures3', 'plusFeatures4'].map((k, i) => (
          <div class="feature" key={k}><Badge icon={['academy', 'sparkles', 'share', 'flame'][i]} color={['orange', 'purple', 'blue', 'pink'][i]} size={30} />{t(k)}</div>
        ))}
      </Card>
      <div class="plans">
        {PLANS.map((p) => (
          <button type="button" key={p.id} class={`plan${plan === p.id ? ' on' : ''}`} onClick={() => setPlanSel(p.id)}>
            <span><span class="pt">{t(p.label)}</span>{p.best && <span class="tag">{t('bestValue')}</span>}<br /><span class="ps">{p.trial ? t('freeWeek') : ' '}</span></span>
            <span class="pp num">{p.price}<span class="ps"> {p.per}</span></span>
          </button>
        ))}
      </div>
      <Button kind="gradient" full onClick={start}>{plan === 'yearly' ? t('startTrial') : t('continue')}</Button>
      <p class="note-text" style={{ textAlign: 'center' }}>{t('demoPayment')}</p>
      <Button kind="plain" full onClick={closeSheet}>{t('notNow')}</Button>
    </SheetFrame>
  );
}
