// Stage with friends (Part 2 D; server/friends.py): friends and requests, messages between friends, challenges
// (beat my score, a class challenge), comments at a moment of a Sound, reposts and the Friends feed.
import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, push, openSheet, closeSheet, toast, getState } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, Button, Empty, Segmented } from '../components.jsx';
import { NavBar, SheetFrame } from './common.jsx';
import { C, attempt } from '../account.js';
import { academyMe } from '../api.js';
import { Person, PostCard, timeAgo } from './social.jsx';
import { whenSignedIn } from './hub.jsx';
import { tick } from '../native.js';
import { loadCatalog, addCatalogPiece } from '../catalog.js';

const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- the friend button on a profile
export function FriendButton({ u, onChange }) {
  const [st, setSt] = useState(u.friend || 'none');
  const set = (on) => whenSignedIn(async () => { const r = await attempt(() => C.friend(u.handle, on)); if (r) { setSt(r.state); onChange?.(r.state); tick(); } });
  if (u.is_me) return null;
  if (st === 'friends') {
    return <div class="row-gap" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
      <Button kind="brand" icon="chat" onClick={() => push('chat', { handle: u.handle })} id="friend-message">{t('message')}</Button>
      <Button kind="secondary" icon="check" onClick={() => { if (confirm(t('unfriendQ', { name: u.name }))) set(false); }} id="friend-state">{t('friendsBtn')}</Button>
    </div>;
  }
  if (st === 'incoming') return <Button kind="brand" icon="users" onClick={() => set(true)} id="friend-accept">{t('acceptFriend')}</Button>;
  if (st === 'requested') return <Button kind="secondary" icon="clock" onClick={() => set(false)} id="friend-state">{t('friendRequested')}</Button>;
  return <Button kind="secondary" icon="users" onClick={() => set(true)} id="friend-add">{t('addFriend')}</Button>;
}

// ---------------------------------------------------------------- friends and requests
export function FriendsView({ active }) {
  const [f, setF] = useState(null);
  const load = () => C.friends().then(setF).catch(() => setF({ friends: [], incoming: [], outgoing: [] }));
  useEffect(() => { if (active) load(); }, [active]);
  const answer = async (h, on) => { await attempt(() => C.friend(h, on)); load(); };
  const row = (p, right) => (
    <div class="row" key={p.handle}>
      <button type="button" class="row-main as-btn" onClick={() => push('profile', { handle: p.handle })}><Person user={p} size={36} /><span><span class="row-title">{p.name}</span><span class="row-sub">@{p.handle}</span></span></button>
      {right}
    </div>
  );
  return (
    <div class="scroll" id="friends">
      <NavBar title={t('friendsT')} backLabel={t('back')} color="pink" />
      <div class="wrap">
        {!f ? <div class="skeleton-rows"><i /><i /><i /></div> : <>
          {f.incoming.length > 0 && <section class="sec3" id="friend-requests"><div class="section-head"><h2>{t('friendRequests')}</h2></div>
            <div class="list inset">{f.incoming.map((p) => row(p, <><Button small kind="brand" onClick={() => answer(p.handle, true)} id={`accept-${p.handle}`}>{t('accept')}</Button>
              <button type="button" class="link-btn" onClick={() => answer(p.handle, false)}>{t('decline')}</button></>))}</div></section>}
          <section class="sec3"><div class="section-head"><h2>{t('friendsT')} · {f.friends.length}</h2></div>
            {f.friends.length ? <div class="list inset" id="friend-list">{f.friends.map((p) => row(p, <>
              <button type="button" class="icon-btn" aria-label={t('message')} onClick={() => push('chat', { handle: p.handle })}><Icon name="chat" size={18} /></button>
            </>))}</div> : <Empty icon="users" title={t('noFriends')} sub={t('noFriendsSub')} />}</section>
          {f.outgoing.length > 0 && <section class="sec3"><div class="section-head"><h2>{t('friendWaiting')}</h2></div>
            <div class="list inset">{f.outgoing.map((p) => row(p, <button type="button" class="link-btn" onClick={() => answer(p.handle, false)}>{t('cancel')}</button>))}</div></section>}
        </>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- messages
export function MessagesView({ active }) {
  const [list, setList] = useState(null);
  useEffect(() => { if (active) C.dms().then((r) => setList(r.items)).catch(() => setList([])); }, [active]);
  return (
    <div class="scroll" id="messages">
      <NavBar title={t('messagesT')} backLabel={t('back')} color="pink" actions={<button type="button" class="nav-btn" onClick={() => push('friends')} aria-label={t('friendsT')}><Icon name="users" size={21} /></button>} />
      <div class="wrap">
        {!list ? <div class="skeleton-rows"><i /><i /></div> : list.length ? <div class="list inset">{list.map((x) => (
          <button type="button" class={`row${x.unread ? ' unread' : ''}`} key={x.with.handle} onClick={() => push('chat', { handle: x.with.handle })}>
            <Person user={x.with} size={40} />
            <span class="row-main"><span class="row-title">{x.with.name}{x.unread ? <span class="count-pill">{x.unread}</span> : null}</span>
              <span class="row-sub">{x.last.mine ? `${t('you')}: ` : ''}{x.last.text}</span></span>
            <span class="tiny muted">{timeAgo(x.last.at)}</span>
          </button>))}</div> : <Empty icon="chat" title={t('noMessages')} sub={t('noMessagesSub')}><Button kind="brand" icon="users" onClick={() => push('friends')}>{t('friendsT')}</Button></Empty>}
      </div>
    </div>
  );
}

export function ChatView({ handle, active }) {
  const [th, setTh] = useState(null);
  const [text, setText] = useState('');
  const end = useRef(null);
  const load = () => C.dm(handle).then((r) => { setTh(r); setTimeout(() => end.current?.scrollIntoView({ block: 'end' }), 30); }).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    if (!active) return undefined;
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 6000);
    return () => clearInterval(timer);
  }, [active, handle]);
  const send = async () => {
    const v = text.trim();
    if (!v) return;
    setText('');
    const r = await attempt(() => C.sendDm(handle, v));
    if (r) load(); else setText(v);
  };
  return (
    <div class="scroll chat-view" id="chat">
      <NavBar title={th?.with?.name || `@${handle}`} backLabel={t('back')} color="pink" />
      <div class="wrap chat-list">
        {th?.items.map((m) => <div key={m.id} class={`pt-msg${m.mine ? ' mine' : ''}`}><span>{m.text}</span><small>{timeAgo(m.at)}</small></div>)}
        {th && !th.items.length && <p class="tiny muted" style={{ textAlign: 'center' }}>{t('sayHello', { name: th.with.name })}</p>}
        <div ref={end} />
      </div>
      {th && (th.can_send ? <div class="chat-send pt-send">
        <input id="chat-text" maxLength={2000} value={text} placeholder={t('messagePh')} onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
        <button type="button" class="icon-btn" onClick={send} disabled={!text.trim()} aria-label={t('send')} id="chat-send"><Icon name="send" size={19} /></button>
      </div> : <p class="tiny muted chat-closed">{t('friendsOnlyMsg')}</p>)}
    </div>
  );
}

// ---------------------------------------------------------------- challenges
export function DuelPickSheet({ piece_title, catalog_id = '', score, tempo_pct = 100 }) {
  const [f, setF] = useState(null);
  const [teaching, setTeaching] = useState([]);
  useEffect(() => {
    C.friends().then(setF).catch(() => setF({ friends: [] }));
    academyMe().then((r) => setTeaching((r.classes || []).filter((c) => c.role === 'teacher'))).catch(() => {});
  }, []);
  const send = async (target) => {
    const r = await attempt(() => C.newDuel({ ...target, piece_title, catalog_id: catalog_id || '', score, tempo_pct }));
    if (r) { closeSheet(); toast(t('duelSent')); push('duel', { id: r.id }, 'community'); }
  };
  return (
    <SheetFrame title={t('challengeFriend')}>
      <p class="note-text">{t('duelPickSub', { piece: piece_title, n: Math.round(score * 100) })}</p>
      {teaching.length > 0 && <div class="list inset">{teaching.map((c) => (
        <button type="button" class="row" key={c.id} onClick={() => send({ class_id: c.id })} id={`duel-class-${c.id}`}>
          <Icon name="academy" size={20} /><span class="row-main"><span class="row-title">{c.name}</span><span class="row-sub">{t('duelClassSub')}</span></span></button>))}</div>}
      {!f ? <div class="skeleton-rows"><i /><i /></div> : f.friends.length ? <div class="list inset" id="duel-friends">{f.friends.map((p) => (
        <button type="button" class="row" key={p.handle} onClick={() => send({ handle: p.handle })} id={`duel-${p.handle}`}>
          <Person user={p} size={34} /><span class="row-main"><span class="row-title">{p.name}</span><span class="row-sub">@{p.handle}</span></span></button>))}</div>
        : <Empty icon="users" title={t('noFriends')} sub={t('noFriendsSub')} />}
    </SheetFrame>
  );
}

function DuelRow({ d }) {
  const who = d.class ? d.class.name : d.sent_by_me ? d.to?.name : d.from?.name;
  return (
    <button type="button" class="duel-row" onClick={() => push('duel', { id: d.id })} id={`duel-row-${d.id}`}>
      <span class={`dr-ic ${d.over ? 'over' : ''}`}><Icon name="trophy" size={18} /></span>
      <span class="row-main"><strong>{d.piece_title}</strong>
        <span class="tiny">{d.class ? t('duelClassLine', { c: who }) : d.sent_by_me ? t('duelYouVs', { name: who }) : t('duelVsYou', { name: who })} · {t('toBeat', { n: d.score })}</span></span>
      {d.over && d.winner && <span class="pill3">{t('duelWinner', { name: d.winner.name })}</span>}
      {!d.over && d.mine == null && !d.sent_by_me && <span class="count-pill">{t('yourTurn')}</span>}
    </button>
  );
}

export function DuelsPanel({ active }) {
  const [d, setD] = useState(null);
  useEffect(() => { if (active) C.duels().then(setD).catch(() => setD({ open: [], done: [] })); }, [active]);
  if (!d) return <div class="skeleton-rows"><i /><i /></div>;
  return (
    <div id="duels">
      <div class="duel-intro"><Icon name="trophy" size={18} /><span>{t('duelsIntro')}</span><button type="button" class="link-btn" onClick={() => push('daily')}>{t('dailyRiff')}</button></div>
      {d.open.length > 0 && <section class="sec3"><div class="section-head"><h2>{t('duelsOpen')}</h2></div>{d.open.map((x) => <DuelRow key={x.id} d={x} />)}</section>}
      {d.done.length > 0 && <section class="sec3"><div class="section-head"><h2>{t('duelsDone')}</h2></div>{d.done.map((x) => <DuelRow key={x.id} d={x} />)}</section>}
      {!d.open.length && !d.done.length && <Empty icon="trophy" title={t('noDuels')} sub={t('noDuelsSub')} />}
    </div>
  );
}

export function DuelView({ id, active }) {
  const [d, setD] = useState(null);
  useEffect(() => { if (active) C.duel(id).then(setD).catch((e) => toast(e.message, 'err')); }, [active, id]);
  const play = async () => {
    if (!d) return;
    // the piece by its free-library id (works on any device), or one with that title in your library
    let p = getState().pieces.find((x) => (d.catalog_id && x.catalogId === d.catalog_id) || x.title === d.piece_title);
    if (!p && d.catalog_id) {
      const entry = (await loadCatalog().catch(() => [])).find((r) => r.id === d.catalog_id);
      if (entry) p = await addCatalogPiece(entry).catch(() => null);
    }
    if (p) push('piece', { id: p.id, start: 'playAlong', duel: d.id }, 'library');
    else push('find', { q: d.piece_title }, 'summary');
  };
  return (
    <div class="scroll" id="duel-view">
      <NavBar title={t('challengeT')} backLabel={t('back')} color="pink" />
      <div class="wrap" style={{ paddingTop: 12 }}>
        {!d ? <div class="skeleton-rows"><i /><i /></div> : <>
          <div class="hero class-hero c-pink"><h2>{d.piece_title}</h2>
            <p>{d.class ? t('duelClassLine', { c: d.class.name }) : d.sent_by_me ? t('duelYouVs', { name: d.to?.name }) : t('duelVsYou', { name: d.from.name })}</p>
            <div class="facts"><span><small>{t('toBeatT')}</small>{d.score}%</span><span><small>{t('speed')}</small>{d.tempo_pct}%</span>{d.mine != null && <span><small>{t('yours')}</small>{d.mine}%</span>}</div></div>
          {!d.over && !d.sent_by_me && <Button kind="brand" full icon="mic" onClick={play} id="duel-play">{d.mine != null ? t('tryToBeat') : t('playItNow')}</Button>}
          {d.over && d.winner && <p class="note-text" id="duel-result"><Icon name="trophy" size={16} /> {t('duelWinner', { name: d.winner.name })}</p>}
          <section class="sec3"><div class="section-head"><h2>{t('leaderboard')}</h2></div>
            <div class="list inset">{d.board.map((b, i) => <div class="row" key={b.who.handle + i}><span class="rank-n">{i + 1}</span><Person user={b.who} size={30} />
              <span class="row-main"><span class="row-title">{b.who.name}</span><span class="row-sub">{b.tempo_pct}%{b.starter ? ` · ${t('starter')}` : ''}</span></span><strong>{b.score}%</strong></div>)}</div></section>
        </>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- moments on a Sound
export function MomentsPanel({ sid }) {
  const [items, setItems] = useState(null);
  const [text, setText] = useState('');
  const load = () => C.moments(sid).then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { load(); }, [sid]);
  const audio = () => document.querySelector('#sound-page audio');
  const add = () => whenSignedIn(async () => {
    const at = audio()?.currentTime || 0;
    if (!text.trim()) return;
    const r = await attempt(() => C.addMoment(sid, at, text.trim()));
    if (r) { setText(''); load(); }
  });
  const seek = (at) => { const a = audio(); if (a) { a.currentTime = at; a.play().catch(() => {}); } };
  return (
    <section class="moments" id="moments">
      <div class="pt-k"><Icon name="chat" size={14} stroke={2.4} />{t('momentsT')}</div>
      {(items || []).map((m) => (
        <div class="moment" key={m.id}>
          <button type="button" class="m-at" onClick={() => seek(m.at)}>{fmtT(m.at)}</button>
          <span class="m-text"><strong>{m.who.name}</strong> {m.text}</span>
          {m.mine && <button type="button" class="icon-btn" aria-label={t('delete')} onClick={async () => { await attempt(() => C.delMoment(m.id)); load(); }}><Icon name="trash" size={15} /></button>}
        </div>))}
      <div class="pt-send">
        <input id="moment-text" maxLength={280} value={text} placeholder={t('soundMomentPh')} onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button type="button" class="icon-btn" onClick={add} disabled={!text.trim()} aria-label={t('send')} id="moment-send"><Icon name="send" size={18} /></button>
      </div>
      <p class="tiny muted">{t('momentHint')}</p>
    </section>
  );
}

// ---------------------------------------------------------------- reposts and the Friends feed
export function RepostButton({ target, on = false, n = 0 }) {
  const [st, setSt] = useState({ on, n });
  const go = () => whenSignedIn(async () => { const r = await attempt(() => C.repost(target, !st.on)); if (r) { setSt({ on: r.reposted, n: r.count }); if (r.reposted) toast(t('reposted')); } });
  return <Button small kind={st.on ? 'brand' : 'secondary'} icon="loop" onClick={go} id={`repost-${target.replace(':', '-')}`}>{st.on ? t('repostedBtn') : t('repost')}{st.n ? ` · ${st.n}` : ''}</Button>;
}

export function FriendsFeed({ active }) {
  const [f, setF] = useState(null);
  useEffect(() => { if (active) C.friendsFeed().then((r) => setF(r.items)).catch(() => setF([])); }, [active]);
  return (
    <div id="friends-feed">
      <div class="duel-intro"><Icon name="users" size={18} /><span>{t('friendsFeedIntro')}</span>
        <button type="button" class="link-btn" onClick={() => push('friends')} id="open-friends">{t('friendsT')}</button>
        <button type="button" class="link-btn" onClick={() => push('messages')} id="open-messages">{t('messagesT')}</button></div>
      {!f ? <div class="skeleton-rows"><i /><i /><i /></div> : f.length ? f.map((x, i) => (
        <div class="ff-item" key={i}>
          {x.by && <span class="tiny muted ff-by"><Icon name="loop" size={12} /> {t('repostedBy', { name: x.by.name })}</span>}
          {x.kind === 'post' ? <PostCard p={x.post} /> : (
            <button type="button" class="sr-item" onClick={() => push('soundPage', { id: x.sound.id })}>
              <span class="hm-art sm"><Icon name="wave" size={20} /></span>
              <span class="t"><strong>{x.sound.title}</strong><span>{x.sound.by.name} · {Math.round(x.sound.seconds)}s</span></span>
              <span class="act">{t('listen')}</span>
            </button>)}
        </div>)) : <Empty icon="users" title={t('friendsFeedEmpty')} sub={t('friendsFeedEmptySub')}><Button kind="brand" icon="users" onClick={() => push('friends')}>{t('friendsT')}</Button></Empty>}
    </div>
  );
}
