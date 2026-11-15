// Hapi everywhere: one chat for the whole app (the sparkle button on every main screen). It knows what is on
// screen (the open piece, the library's titles, the last few takes) and answers in the app's language. The
// server may look things up (your practice, Stage, teachers) and suggest next steps; those come back as buttons
// and only run when you tap one. The conversation lasts for this session.
import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, push, go, openSheet, closeSheet, hooks, getState } from '../state.js';
import { t, getLang } from '../../core/i18n.js';
import { Icon, Button, Chip } from '../components.jsx';
import { SheetFrame } from './common.jsx';
import { call, hasServer } from '../api.js';
import { planError } from '../account.js';

let convo = [];                     // [{role: 'user'|'assistant', text, actions?}]
const MAX_TURNS = 20;

/** What the app shows right now, for the model. Small on purpose (the server caps it). */
export function chatContext(s = getState()) {
  const stack = s.stacks[s.tab] || [];
  const top = stack[stack.length - 1];
  const byId = new Map(s.pieces.map((p) => [p.id, p]));
  const open = top?.view === 'piece' ? byId.get(top.props?.id) : null;
  const day = 86400000;
  return {
    screen: top?.view || s.tab,
    instrument: s.settings.instrument || '',
    signed_in: !!s.me?.registered,
    piece: open ? { id: open.id, title: (open.title || '').slice(0, 80), key: open.keyText || '', tempo: open.tempo || null, best: open.best ?? null } : null,
    library: s.pieces.slice(0, 50).map((p) => ({ id: p.id, title: (p.title || '').slice(0, 60), ...(p.best != null ? { best: p.best } : {}) })),
    recent_takes: s.history.filter((h) => h.accuracy !== undefined).slice(-5).reverse()
      .map((h) => ({ piece: (byId.get(h.pieceId)?.title || h.title || '').slice(0, 60), accuracy: Math.round(h.accuracy * 100), days_ago: Math.floor((Date.now() - h.date) / day) })),
  };
}

const SCREEN_GO = {
  home: () => go('summary'), library: () => go('library'), create: () => go('write'), learn: () => go('academy'), stage: () => go('community'),
  me: () => go('me'), soundCheck: () => push('soundCheck'), tuner: () => push('tool', { tool: 'tuner' }), metronome: () => push('tool', { tool: 'metronome' }),
  newSong: () => openSheet('newSong'), newSound: () => { go('write'); push('sound', {}, 'write'); }, chordEditor: () => { go('write'); push('chordEditor', {}, 'write'); },
  classes: () => go('academy'), tutors: () => { go('academy'); push('tutors', {}, 'academy'); }, academy: () => { go('academy'); push('courses', {}, 'academy'); },
  plans: () => openSheet('plans'), help: () => { go('me'); push('help', {}, 'me'); },
};

/** Carries out a button the person tapped. Returns false if it can't (the piece is gone, no piece is open). */
export function runAction(a) {
  const s = getState();
  const later = (fn) => { closeSheet(); setTimeout(() => { if (globalThis.scrollY) globalThis.scrollTo(0, 0); fn(); }, 0); };
  switch (a.type) {
    case 'open_piece': case 'play_along':
      if (!s.pieces.some((p) => p.id === a.piece_id)) return false;
      later(() => { go('library'); push('piece', { id: a.piece_id, ...(a.type === 'play_along' ? { start: 'practice' } : {}) }, 'library'); });
      return true;
    case 'open_screen': if (!SCREEN_GO[a.screen]) return false; later(SCREEN_GO[a.screen]); return true;
    case 'transpose': if (!hooks.piece) return false; later(() => hooks.piece?.transpose(a.semitones)); return true;
    case 'set_speed': if (!hooks.piece) return false; later(() => hooks.piece?.setSpeed(a.percent / 100)); return true;
    case 'new_song': later(() => openSheet('newSong')); return true;
    case 'open_post': later(() => { go('community'); push('post', { id: a.id }, 'community'); }); return true;
    case 'open_sound': later(() => go('community')); return true;
    default: return false;
  }
}

const STARTERS = {
  piece: ['aiStartTricky', 'aiStartSlower', 'aiStartExplain'],
  practice: ['aiStartTricky', 'aiStartSlower', 'aiStartExplain'],
  community: ['aiStartStage', 'aiStartFind', 'aiStartWhat'],
  academy: ['aiStartTeacher', 'aiStartDue', 'aiStartWhat'],
  write: ['aiStartChords', 'aiStartSound', 'aiStartWhat'],
  default: ['aiStartToday', 'aiStartNoise', 'aiStartWhat'],
};

export function AIChatSheet() {
  const s = useApp();
  const [msgs, setMsgs] = useState(convo);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const end = useRef(null);
  const ctx = useRef(chatContext(s));            // what was on screen when the chat opened
  useEffect(() => {
    convo = msgs;
    // scroll the sheet only: scrollIntoView would also scroll the page under it and leave the tab bar out of place
    const box = end.current?.closest('.sheet-body');
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  }, [msgs, busy]);

  const send = async (q = text) => {
    q = q.trim();
    if (!q || busy) return;
    const next = [...msgs, { role: 'user', text: q.slice(0, 2000) }].slice(-MAX_TURNS);
    setMsgs(next); setText(''); setErr(''); setBusy(true);
    try {
      const r = await call('/ai/chat', { method: 'POST', timeout: 90000,
        json: { messages: next.map(({ role, text: x }) => ({ role, text: x })), context: ctx.current, lang: getLang() } });
      setMsgs([...next, { role: 'assistant', text: r.text, actions: r.actions || [] }]);
    } catch (e) {
      if (!planError(e)) setErr(e.message || String(e));
      setMsgs(msgs);                               // the question goes back in the box to try again
      setText(q);
    }
    setBusy(false);
  };
  const where = ctx.current.piece ? 'piece' : STARTERS[ctx.current.screen] ? ctx.current.screen : STARTERS[s.tab] ? s.tab : 'default';
  if (!hasServer()) return <SheetFrame title={t('aiChat')}><p class="note-text">{t('aiOffline')}</p></SheetFrame>;
  return (
    <SheetFrame title={t('aiChat')} full right={msgs.length ? t('aiNew') : null} onRight={() => { setMsgs([]); setErr(''); }}>
      <div class="ai-chat" id="ai-chat">
        {!msgs.length && <div class="ai-hello">
          <span class="ai-mark"><Icon name="sparkles" size={26} stroke={2.2} /></span>
          <p>{ctx.current.piece ? t('aiHelloPiece', { title: ctx.current.piece.title }) : t('aiHello')}</p>
          <div class="chips wrap">{STARTERS[where].map((k) => <Chip key={k} onClick={() => send(t(k))}>{t(k)}</Chip>)}</div>
        </div>}
        {msgs.map((m, i) => (
          <div key={i} class={`ai-msg ${m.role}`}>
            <p>{m.text}</p>
            {m.actions?.length > 0 && <div class="ai-acts">{m.actions.map((a, k) => (
              <Button key={k} small kind={k === 0 ? 'brand' : 'secondary'} onClick={() => { if (!runAction(a)) setErr(t('aiActGone')); }} id={`ai-act-${k}`}>{a.label}</Button>))}</div>}
          </div>
        ))}
        {busy && <div class="ai-msg assistant typing" aria-label={t('thinking')}><i /><i /><i /></div>}
        {err && <p class="note-text err" role="alert">{err}</p>}
        <div ref={end} />
      </div>
      <form class="ai-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea id="ai-q" rows={1} maxLength={2000} value={text} placeholder={t('aiAsk')} onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button type="submit" class="ai-send" disabled={busy || !text.trim()} aria-label={t('send')} id="ai-send"><Icon name="arrowUp" size={20} stroke={2.6} /></button>
      </form>
      <p class="tiny muted ai-foot">{t('aiFoot')}</p>
    </SheetFrame>
  );
}

/** The sparkle button: on every main screen, above the tab bar. */
export function AIFab() {
  return <button type="button" class="ai-fab" id="ai-fab" onClick={() => openSheet('aiChat')} aria-label={t('aiChat')}><Icon name="sparkles" size={22} stroke={2.3} /></button>;
}
