// Building blocks shared by the community screens: people, post cards, stars, reports, time labels.
import { useState, useEffect } from 'preact/hooks';
import { push, closeSheet, openSheet, toast, getState } from '../state.js';
import { t, getLang, instrumentName } from '../../core/i18n.js';
import { Icon, Chip, Button, List, Row } from '../components.jsx';
import { SheetFrame } from './common.jsx';
import { Mascot } from '../mascot.jsx';
import { C, attempt } from '../account.js';

export const TYPE = {
  request: { icon: 'flag', color: 'pink', label: 'typeRequest' },
  question: { icon: 'quiz', color: 'blue', label: 'typeQuestion' },
  share: { icon: 'staff', color: 'green', label: 'typeShare' },
  show: { icon: 'trophy', color: 'orange', label: 'typeShow' },
  moment: { icon: 'chat', color: 'teal', label: 'typeMoment' },
};

export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(1, (Date.now() - Date.parse(iso)) / 1000);
  const lang = getLang();
  const u = s < 60 ? [s, 's'] : s < 3600 ? [s / 60, 'm'] : s < 86400 ? [s / 3600, 'h'] : s < 86400 * 30 ? [s / 86400, 'd'] : null;
  if (!u) {
    try { return new Date(iso).toLocaleDateString(lang, { day: 'numeric', month: 'short' }); } catch { return iso.slice(0, 10); }
  }
  const n = Math.floor(u[0]);
  if (lang.startsWith('zh')) return `${n}${{ s: '秒', m: '分钟', h: '小时', d: '天' }[u[1]]}前`;
  if (lang === 'ms') return `${n} ${{ s: 'saat', m: 'min', h: 'jam', d: 'hari' }[u[1]]} lalu`;
  return `${n}${u[1]} ago`;
}

/** Hours (or days) left until iso. */
export function timeLeft(iso) {
  const h = Math.max(0, (Date.parse(iso) - Date.now()) / 3600000);
  return h >= 48 ? t('daysLeft', { n: Math.round(h / 24) }) : t('hoursLeft', { n: Math.max(1, Math.round(h)) });
}

const initials = (name) => (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

/** A person's round picture: their colour and initials (or emoji), with the plan badge. */
export function Person({ user, size = 36, badge = true }) {
  if (!user) return <span class="person" style={{ width: size, height: size }} />;
  const a = user.avatar || {};
  return (
    <span class={`person c-${a.color || 'purple'}`} style={{ width: size, height: size, fontSize: size * (a.emoji ? 0.55 : 0.4) }} aria-hidden="true">
      {a.emoji || initials(user.name)}
      {badge && user.badge && <span class={`pbadge b-${user.badge}`}><Icon name={user.badge === 'dev' ? 'bolt' : 'crown'} size={Math.max(9, size * 0.28)} stroke={2.8} /></span>}
    </span>
  );
}

export function PersonLine({ user, sub, onClick }) {
  if (!user) return null;
  const open = onClick || (() => user.handle && push('profile', { handle: user.handle }));
  return (
    <button type="button" class="person-line" onClick={open}>
      <Person user={user} size={30} />
      <span class="pl-main"><strong>{user.name}</strong><span>{user.handle ? `@${user.handle}` : ''}{sub ? ` · ${sub}` : ''}</span></span>
    </button>
  );
}

/** An amount of Notes (the reward people earn on Stage). */
export function Coins({ n, size = 'md' }) {
  return <span class={`nts ${size}`}><Icon name="gift" size={size === 'xl' ? 34 : size === 'lg' ? 20 : size === 'sm' ? 13 : 15} stroke={2.3} />{n}</span>;
}

export const EMOJI = [['like', '👏'], ['love', '❤️'], ['fire', '🔥'], ['bravo', '🎉'], ['wow', '😮']];

/** Emoji reactions under a post: one each; tapping yours again takes it back. */
export function Reactions({ target }) {
  const [st, setSt] = useState({ counts: {}, mine: null });
  useEffect(() => { let alive = true; C.emojiCounts([target]).then((r) => alive && r.items[target] && setSt(r.items[target])).catch(() => {}); return () => { alive = false; }; }, [target]);
  const tap = async (kind) => {
    const r = await attempt(() => C.emoji(target, kind));
    if (r) setSt({ counts: r.counts, mine: r.mine });
  };
  return (
    <div class="reactions" role="group" aria-label={t('react')}>
      {EMOJI.map(([kind, face]) => (
        <button type="button" key={kind} class={st.mine === kind ? 'on' : ''} onClick={() => tap(kind)} aria-pressed={st.mine === kind} aria-label={kind}>
          <span aria-hidden="true">{face}</span>{st.counts[kind] ? <b class="num">{st.counts[kind]}</b> : null}
        </button>
      ))}
    </div>
  );
}

/** Where a request stands: open → someone is writing → done → practise it now. */
export function RequestSteps({ p }) {
  if (p.type !== 'request' || p.status === 'closed') return null;
  const at = p.status === 'done' ? 3 : p.claimed ? 1 : 0;
  const steps = ['rqOpen', 'rqWriting', 'rqDone', 'rqPractise'];
  return (
    <span class="rq-steps" aria-label={t(steps[Math.min(at, 3)])}>
      {steps.map((k, i) => <span key={k} class={i < at ? 'done' : i === at || (at === 3 && i === 3) ? 'now' : ''}><i />{t(k)}</span>)}
    </span>
  );
}

export function StatusPill({ p }) {
  if (p.type === 'request') {
    if (p.status === 'done') return <span class="pill green"><Icon name="check" size={13} stroke={2.8} />{t('delivered')}</span>;
    if (p.status === 'closed') return <span class="pill gray">{t('closed')}</span>;
    if (p.claimed) return <span class="pill orange"><Icon name="pencil" size={13} stroke={2.4} />{t('beingMade')}</span>;
    return <span class="pill pink">{t('open')}</span>;
  }
  if (p.type === 'question') return p.status === 'done' ? <span class="pill green"><Icon name="check" size={13} stroke={2.8} />{t('answered')}</span> : <span class="pill blue">{t('open')}</span>;
  return null;
}

export function InstrumentChips({ list = [] }) {
  if (!list.length) return null;
  return <span class="ichips">{list.slice(0, 3).map((i) => <span key={i} class="ichip">{instrumentName(i)}</span>)}</span>;
}

/** One post in a list. */
export function PostCard({ p, compact = false }) {
  const ty = TYPE[p.type] || TYPE.request;
  const open = () => push('post', { id: p.id });
  if (p.type === 'show') {
    const d = p.data || {};
    return (
      <button type="button" class="post-card show" onClick={open}>
        <Person user={p.author} size={40} />
        <span class="pc-main">
          <span class="pc-title">{t('showLine', { name: p.author?.name || '', piece: d.piece || p.title })}</span>
          <span class="pc-sub">{d.accuracy != null && <strong class="t-green">{Math.round(d.accuracy * 100)}%</strong>}{d.minutes ? ` · ${Math.round(d.minutes)} ${t('min')}` : ''} · {timeAgo(p.created)}</span>
          {p.body && !compact && <span class="pc-body">{p.body}</span>}
        </span>
        <span class="pc-claps"><Icon name="heart" size={16} fill={p.me?.liked} />{p.likes || ''}</span>
      </button>
    );
  }
  return (
    <button type="button" class={`post-card t-${p.type}${p.spotlight ? ' spot' : ''}${compact ? ' compact' : ''}`} onClick={open}>
      <span class={`pc-icon c-${ty.color}`}><Icon name={ty.icon} size={18} stroke={2.2} /></span>
      <span class="pc-main">
        <span class="pc-top">
          {p.spotlight && <span class="pill yellow"><Icon name="star" size={12} stroke={2.6} />{t('spotlight')}</span>}
          <StatusPill p={p} />
          {p.type === 'share' && p.licence && <span class="pill gray">{t(`lic_${p.licence}`)}</span>}
        </span>
        {!compact && <RequestSteps p={p} />}
        <span class="pc-title">{p.title}</span>
        {(p.song || p.artist) && p.song !== p.title && <span class="pc-sub">{[p.song, p.artist].filter(Boolean).join(' · ')}</span>}
        {!compact && p.body && <span class="pc-body">{p.body}</span>}
        <span class="pc-meta">
          <InstrumentChips list={p.instruments} />
          {p.level && <span class="ichip lvl">{t(p.level)}</span>}
          <span class="pc-by">{p.author?.name} · {timeAgo(p.created)}</span>
        </span>
      </span>
      <span class="pc-side">
        {p.type === 'request' && p.pot > 0 && <Coins n={p.pot} />}
        {p.type === 'request' && <span class="pc-stat"><Icon name="users" size={14} />{p.wants}</span>}
        {p.type === 'share' && <span class="pc-stat"><Icon name="download" size={14} />{p.saves}</span>}
        <span class="pc-stat"><Icon name="chords" size={14} />{p.replies}</span>
      </span>
    </button>
  );
}

export function StarsInput({ value, onChange }) {
  return (
    <div class="stars-input" role="radiogroup" aria-label={t('rating')}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button type="button" key={n} role="radio" aria-checked={value === n} class={n <= value ? 'on' : ''} onClick={() => onChange(n)} aria-label={`${n}`}>
          <Icon name="star" size={30} fill={n <= value} stroke={1.8} />
        </button>
      ))}
    </div>
  );
}

const REASONS = ['spam', 'rude', 'copyright', 'unsafe', 'wrong', 'other'];

/** Report a post, reply or person (target "p:<id>" | "r:<id>" | "u:<handle>"). */
export function ReportSheet({ target, name }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const send = async () => {
    const r = await attempt(() => C.report(target, reason, note));
    if (r) setSent(true);
  };
  const handle = target.startsWith('u:') ? target.slice(2) : null;
  return (
    <SheetFrame title={t('report')} right={sent ? t('done') : t('send')} onRight={sent ? closeSheet : send} rightDisabled={!sent && !reason}>
      {sent ? (
        <div class="empty"><Mascot mood="happy" size={90} /><h3>{t('reportThanks')}</h3><p>{t('reportThanksSub')}</p>
          {handle && <Button kind="secondary" icon="close" onClick={async () => { await attempt(() => C.block(handle, true)); toast(t('blocked')); closeSheet(); }}>{t('blockPerson', { name: name || handle })}</Button>}
        </div>
      ) : <>
        <p class="note-text">{t('reportWhy')}</p>
        <div class="chips wrap">{REASONS.map((r) => <Chip key={r} on={reason === r} onClick={() => setReason(r)}>{t(`why_${r}`)}</Chip>)}</div>
        <textarea class="textarea" rows="3" maxLength={500} placeholder={t('reportNote')} value={note} onInput={(e) => setNote(e.currentTarget.value)} aria-label={t('reportNote')} />
        <p class="note-text">{t('reportPrivate')}</p>
      </>}
    </SheetFrame>
  );
}

/** Small "…" menu for a post or person: report, block, copy link. */
export function MoreSheet({ items }) {
  return (
    <SheetFrame title="">
      <List>{items.filter(Boolean).map((it) => <Row key={it.label} icon={it.icon} color={it.color || 'gray'} title={it.label} danger={it.danger} onClick={() => { closeSheet(); setTimeout(it.onClick, 60); }} />)}</List>
    </SheetFrame>
  );
}

export const openReport = (target, name) => openSheet('reportPost', { target, name });
export const myId = () => getState().me?.id;
