// Help: questions and answers, sending feedback or a problem report (with optional technical details), the
// community guidelines, and About (credits for the music engine, sounds and fonts).
import { useState } from 'preact/hooks';
import { deviceAudioLog } from '../audio.js';
import { useApp, closeSheet, openSheet, toast, getState, push } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, Button, Section, Card, Chip, Toggle, List, Row } from '../components.jsx';
import { NavBar, SheetFrame } from './common.jsx';
import { Mascot } from '../mascot.jsx';
import { C, ensureAccount } from '../account.js';
import { hasServer } from '../api.js';
import { platform } from '../native.js';

const TOPICS = [
  { id: 'start', icon: 'sparkles', color: 'purple', qs: ['faq_add', 'faq_formats', 'faq_scanTips', 'faq_searchTips'] },
  { id: 'playing', icon: 'play', color: 'pink', qs: ['faq_cursor', 'faq_bluetooth', 'faq_playAlong', 'faq_mic', 'faq_parts'] },
  { id: 'community', icon: 'users', color: 'blue', qs: ['faq_request', 'faq_rewards', 'faq_claim', 'faq_copyright', 'faq_report'] },
  { id: 'making', icon: 'staff', color: 'green', qs: ['faq_make', 'faq_makeApps', 'faq_makeCheck'] },
  { id: 'credits', icon: 'star', color: 'yellow', qs: ['faq_creditsWhat', 'faq_creditsEarn', 'faq_creditsCash'] },
  { id: 'plans', icon: 'crown', color: 'orange', qs: ['faq_free', 'faq_plus', 'faq_cancel', 'faq_pc'] },
  { id: 'account', icon: 'person', color: 'teal', qs: ['faq_devices', 'faq_forgot', 'faq_delete', 'faq_privacy'] },
];

export function HelpView({ topic = '' }) {
  const [open, setOpen] = useState(topic ? `${topic}:0` : '');
  const [q, setQ] = useState('');
  const match = (k) => !q.trim() || `${t(k)} ${t(`${k}_a`)}`.toLowerCase().includes(q.trim().toLowerCase());
  return (
    <div class="scroll">
      <NavBar title={t('help')} backLabel={t('back')} color="teal" />
      <div class="wrap">
        <div class="with-mascot"><Mascot mood="happy" size={60} /><div class="bubble left">{t('helpIntro')}</div></div>
        <label class="search" for="help-search"><Icon name="search" size={18} /><input id="help-search" type="search" placeholder={t('searchHelp')} value={q} onInput={(e) => setQ(e.currentTarget.value)} /></label>
        {TOPICS.map((tp) => {
          const qs = tp.qs.filter(match);
          if (!qs.length) return null;
          return (
            <Section key={tp.id} title={<span class="help-topic"><Icon name={tp.icon} size={17} />{t(`topic_${tp.id}`)}</span>}>
              <div class="faq">
                {qs.map((k, i) => {
                  const id = `${tp.id}:${i}`;
                  const on = open === id || !!q.trim();
                  return (
                    <div key={k} class={`faq-item${on ? ' on' : ''}`}>
                      <button type="button" class="faq-q" onClick={() => setOpen(open === id ? '' : id)} aria-expanded={on}>{t(k)}<Icon name={on ? 'chevronU' : 'chevronD'} size={16} /></button>
                      {on && <p class="faq-a">{t(`${k}_a`)}</p>}
                    </div>
                  );
                })}
              </div>
            </Section>
          );
        })}
        <Section title={t('stillStuck')}>
          <List>
            <Row icon="send" color="blue" title={t('sendFeedback')} subtitle={t('sendFeedbackSub')} onClick={() => openSheet('feedback')} />
            <Row icon="quiz" color="purple" title={t('askCommunity')} subtitle={t('askCommunitySub')} onClick={() => openSheet('compose', { type: 'question' })} />
            <Row icon="users" color="green" title={t('guidelines')} onClick={() => openSheet('guidelines')} />
            <Row icon="info" color="gray" title={t('about')} onClick={() => openSheet('about')} />
          </List>
        </Section>
      </div>
    </div>
  );
}

// the last few errors, so a problem report can say what went wrong
const errors = [];
export function captureErrors() {
  const keep = (m) => { errors.push(`${new Date().toISOString().slice(11, 19)} ${String(m).slice(0, 300)}`); if (errors.length > 12) errors.shift(); };
  addEventListener('error', (e) => keep(e.message || e.error));
  addEventListener('unhandledrejection', (e) => keep(e.reason?.message || e.reason));
}

function diagnostics() {
  const s = getState();
  const cfg = globalThis.HAPTUNE_CONFIG || {};
  const top = s.stacks[s.tab]?.slice(-1)[0];
  return {
    app: `${cfg.version || '?'} (${cfg.build || '?'})`, platform: platform(), ua: navigator.userAgent.slice(0, 200),
    screen: `${innerWidth}x${innerHeight}@${devicePixelRatio}`, lang: s.settings.lang, tab: s.tab, view: top?.view || 'root',
    pieces: s.pieces.length, audio: globalThis.__haptuneAudio?.() || null, sound: deviceAudioLog(), errors: [...errors],
  };
}

const CATS = ['bug', 'idea', 'question', 'billing', 'other'];

export function FeedbackSheet({ category = 'bug' }) {
  const [cat, setCat] = useState(category);
  const [msg, setMsg] = useState('');
  const [contact, setContact] = useState('');
  const [diag, setDiag] = useState(true);
  const [state, setStateL] = useState('');           // '' | sending | sent
  const send = async () => {
    if (msg.trim().length < 3) return;
    if (!hasServer()) { toast(t('needOnline'), 'err'); return; }
    setStateL('sending');
    try {
      await ensureAccount();
      await C.feedback({ category: cat, message: msg.trim(), contact: contact.trim(), diagnostics: diag ? diagnostics() : null });
      setStateL('sent');
    } catch (e) { toast(e.message, 'err'); setStateL(''); }
  };
  if (state === 'sent') {
    return (
      <SheetFrame title={t('sendFeedback')} right={t('done')} onRight={closeSheet}>
        <div class="empty"><Mascot mood="cheer" size={96} /><h3>{t('feedbackThanks')}</h3><p>{t('feedbackThanksSub')}</p></div>
      </SheetFrame>
    );
  }
  return (
    <SheetFrame title={t('sendFeedback')} right={t('send')} onRight={send} rightDisabled={msg.trim().length < 3 || state === 'sending'}>
      <div class="chips wrap">{CATS.map((c) => <Chip key={c} on={cat === c} onClick={() => setCat(c)}>{t(`fb_${c}`)}</Chip>)}</div>
      <textarea class="textarea" id="fb-msg" rows="6" maxLength={4000} value={msg} onInput={(e) => setMsg(e.currentTarget.value)} placeholder={t(cat === 'bug' ? 'fbBugExample' : 'fbIdeaExample')} aria-label={t('sendFeedback')} />
      <input class="field" id="fb-contact" maxLength={120} value={contact} onInput={(e) => setContact(e.currentTarget.value)} placeholder={t('fbContact')} aria-label={t('fbContact')} />
      <List><Row title={t('includeDetails')} subtitle={t('includeDetailsSub')} right={<Toggle id="fb-diag" checked={diag} onChange={setDiag} label={t('includeDetails')} />} /></List>
      <Button full icon="send" disabled={msg.trim().length < 3 || state === 'sending'} onClick={send}>{state === 'sending' ? t('sending') : t('send')}</Button>
    </SheetFrame>
  );
}

export function GuidelinesSheet() {
  const s = useApp();
  const agree = async () => { try { await C.update({ guidelines: true }); } catch { /* fine offline */ } closeSheet(); };
  return (
    <SheetFrame title={t('guidelines')} right={t('done')} onRight={closeSheet}>
      <div class="with-mascot"><Mascot mood="happy" size={56} /><div class="bubble left">{t('guidelinesIntro')}</div></div>
      <Card>
        <ol class="rules">{['rule1', 'rule2', 'rule3', 'rule4', 'rule5', 'rule6'].map((k) => <li key={k}><strong>{t(k)}</strong><span>{t(`${k}_d`)}</span></li>)}</ol>
      </Card>
      {s.me && !s.me.guidelines && <Button full onClick={agree}>{t('iAgree')}</Button>}
    </SheetFrame>
  );
}

export function AboutSheet() {
  const cfg = globalThis.HAPTUNE_CONFIG || {};
  return (
    <SheetFrame title={t('about')} right={t('done')} onRight={closeSheet}>
      <div class="empty"><Mascot mood="wave" size={90} /><h3>Melovyn</h3><p>{t('version')} {cfg.version} ({cfg.build}) · {t('madeBy')} sloky</p></div>
      <Section title={t('creditsThanks')}>
        <List>
          <Row title="Salamander Grand Piano V3" subtitle="Alexander Holm · CC BY 3.0" />
          <Row title="Verovio" subtitle="RISM Digital Center · LGPL-3.0" />
          <Row title="PDF.js" subtitle="Mozilla · Apache-2.0" />
          <Row title="Preact" subtitle="MIT" />
          <Row title="Capacitor" subtitle="Ionic · MIT" />
          <Row title="homr" subtitle="AGPL-3.0 (basic scan, on the server)" />
        </List>
      </Section>
      <p class="note-text center">{t('openSourceNote')}</p>
    </SheetFrame>
  );
}

export const openHelp = (topic = '') => push('help', { topic });
