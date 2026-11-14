// One post: a request (and the scores people made for it), a question (and its answers), a shared score or
// a practice win. Everything you can do with it is here.
import { useState, useEffect } from 'preact/hooks';
import { useApp, push, pop, openSheet, closeSheet, toast, getPiece, addScore, getState } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, Button, Card, Section, List, Row, Chip } from '../components.jsx';
import { NavBar, SheetFrame } from './common.jsx';
import { Mascot, Confetti } from '../mascot.jsx';
import { parseMusicXML, writeMusicXML } from '../../core/musicxml.js';
import { C, attempt, ensureAccount } from '../account.js';
import { youtubeId } from '../api.js';
import { openExternal } from '../native.js';
import { Reactions, TYPE, PersonLine, Person, Coins, StatusPill, InstrumentChips, StarsInput, timeAgo, timeLeft, openReport } from './social.jsx';

const live = { reload: null };            // the open post refreshes itself after a sheet changes it
export const reloadPost = () => live.reload?.();

export function PostView({ id, active }) {
  const s = useApp();
  const [p, setP] = useState(null);
  const [err, setErr] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [party, setParty] = useState(false);
  const load = async () => {
    try { setP(await C.post(id)); setErr(''); } catch (e) { setErr(e.message); }
  };
  useEffect(() => { if (active) { live.reload = load; load(); } }, [active, id]);
  if (err && !p) return <div class="scroll"><NavBar title="" backLabel={t('community')} /><div class="wrap"><p class="sub">{err}</p></div></div>;
  if (!p) return <div class="scroll"><NavBar title="" backLabel={t('community')} /><div class="loading"><Mascot mood="think" size={80} /></div></div>;
  const ty = TYPE[p.type];
  const me = s.me;
  const isAuthor = p.me.is_author;
  const run = async (fn, ok) => {
    setBusy(true);
    const r = await attempt(fn);
    setBusy(false);
    if (r) { if (r.id === p.id && r.type) setP(r); else load(); if (ok) toast(ok); }
    return r;
  };
  const send = async () => {
    if (!text.trim()) return;
    if (!(await ensureAccount())) { toast(t('needOnline'), 'err'); return; }
    const kind = p.type === 'question' && p.status === 'open' && !isAuthor ? 'answer' : 'comment';
    const r = await run(() => C.reply(p.id, { kind, body: text.trim() }));
    if (r) setText('');
  };
  const more = () => openSheet('more', { items: [
    { icon: 'link', label: t('copyLink'), onClick: () => copyLink(p) },
    !isAuthor && { icon: 'flag', color: 'orange', label: t('report'), onClick: () => openReport(`p:${p.id}`) },
    p.author?.handle && !isAuthor && { icon: 'close', color: 'red', label: t('blockPerson', { name: p.author.name }), onClick: async () => { await attempt(() => C.block(p.author.handle, true)); toast(t('blocked')); pop(); } },
    (isAuthor || me?.is_admin) && { icon: 'trash', color: 'red', danger: true, label: t('deletePost'), onClick: async () => { if (await attempt(() => C.remove(p.id))) { toast(t('deleted')); pop(); } } },
  ] });
  const yt = youtubeId(p.link);
  return (
    <div class="scroll">
      {party && <Confetti />}
      <NavBar title={t(ty.label)} backLabel={t('community')} color={ty.color} actions={<button type="button" class="nav-btn" onClick={more} aria-label={t('more')}><Icon name="more" size={22} /></button>} />
      <div class="wrap post-view">
        <div class="pv-head">
          <div class="pc-top"><span class={`pill ${ty.color}`}><Icon name={ty.icon} size={13} stroke={2.6} />{t(ty.label)}</span><StatusPill p={p} />
            {p.spotlight && <span class="pill yellow"><Icon name="star" size={12} stroke={2.6} />{t('spotlight')}</span>}
            {p.type === 'share' && p.licence && <span class="pill gray">{t(`lic_${p.licence}`)}</span>}</div>
          <h1>{p.title}</h1>
          {(p.song || p.artist) && p.song !== p.title && <p class="pv-song">{[p.song, p.artist].filter(Boolean).join(' · ')}</p>}
          <div class="pc-meta"><InstrumentChips list={p.instruments} />{p.level && <span class="ichip lvl">{t(p.level)}</span>}</div>
          <PersonLine user={p.author} sub={timeAgo(p.created)} />
        </div>

        {p.type === 'show' && <ShowStats p={p} />}
        {p.body && <p class="pv-body">{p.body}</p>}

        {p.link && (
          <button type="button" class="link-card" onClick={() => openExternal(p.link)}>
            {yt ? <img src={`https://i.ytimg.com/vi/${yt}/mqdefault.jpg`} alt="" loading="lazy" onError={(e) => e.currentTarget.classList.add('broken')} /> : <Icon name="link" size={22} />}
            <span><strong>{yt ? t('listenOnYoutube') : t('openLink')}</strong><span>{p.link.replace(/^https?:\/\//, '').slice(0, 60)}</span></span>
            <Icon name="chevronR" size={14} />
          </button>
        )}
        {p.attachments?.length > 0 && <Attachments list={p.attachments} />}

        {p.type === 'request' && <RequestBox p={p} busy={busy} run={run} />}
        {p.type === 'question' && p.pot > 0 && <Card><div class="report-line"><Coins n={p.pot} /><p class="sub">{t('bountyNote')}</p></div></Card>}
        {p.type === 'share' && <ShareBox p={p} run={run} />}
        <Reactions target={`p:${p.id}`} />

        <Section title={p.type === 'request' ? t('scoresAndComments', { n: p.replies_list.length }) : p.type === 'question' ? t('answersN', { n: p.replies_list.length }) : t('commentsN', { n: p.replies_list.length })}>
          {p.replies_list.length === 0 && <p class="note-text">{t(p.type === 'request' ? 'noScoresYet' : p.type === 'question' ? 'noAnswersYet' : 'noCommentsYet')}</p>}
          <div class="replies">{p.replies_list.map((r) => <Reply key={r.id} r={r} p={p} run={run} onAccepted={() => { setParty(true); setTimeout(() => setParty(false), 2200); }} />)}</div>
        </Section>

        {p.status !== 'closed' && (
          <div class="composer">
            <textarea class="textarea" rows="2" maxLength={2000} value={text} onInput={(e) => setText(e.currentTarget.value)} id="reply-text"
              placeholder={t(p.type === 'question' && !isAuthor && p.status === 'open' ? 'writeAnswer' : 'writeComment')} aria-label={t('writeComment')} />
            <Button icon="send" disabled={busy || !text.trim()} onClick={send}>{t('send')}</Button>
          </div>
        )}
        <p class="note-text center">{t('beKind')} <button type="button" class="link" onClick={() => openSheet('guidelines')}>{t('guidelines')}</button></p>
      </div>
    </div>
  );
}

function copyLink(p) {
  const base = (globalThis.HAPTUNE_CONFIG?.native ? `${globalThis.HAPTUNE_CONFIG?.site || 'https://haptune.name.my'}/app/` : location.href.split('#')[0]);
  const url = `${base}#post/${p.id}`;
  try { navigator.clipboard.writeText(url); toast(t('copied')); } catch { toast(url); }
}

function ShowStats({ p }) {
  const d = p.data || {};
  return (
    <div class="show-stats">
      {d.accuracy != null && <div><strong class="num t-green">{Math.round(d.accuracy * 100)}%</strong><span>{t('accuracy')}</span></div>}
      {d.minutes ? <div><strong class="num">{Math.round(d.minutes)}</strong><span>{t('min')}</span></div> : null}
      {d.tempo_pct ? <div><strong class="num">{d.tempo_pct}%</strong><span>{t('speed')}</span></div> : null}
      {d.piece && <div><strong>{d.piece}</strong><span>{t('piece')}</span></div>}
    </div>
  );
}

function Attachments({ list }) {
  const [urls, setUrls] = useState({});
  useEffect(() => {
    let alive = true;
    list.filter((a) => a.mime.startsWith('image/')).forEach(async (a) => {
      try { const u = await C.fileBlobURL(a.id); if (alive) setUrls((x) => ({ ...x, [a.id]: u })); } catch { /* expired */ }
    });
    return () => { alive = false; };
  }, [list.map((a) => a.id).join()]);
  const openPdf = async (a) => { try { openExternal(await C.fileBlobURL(a.id)); } catch (e) { toast(e.message, 'err'); } };
  return (
    <div class="attach-grid">
      {list.map((a) => a.mime.startsWith('image/')
        ? <button type="button" key={a.id} class="attach" onClick={() => urls[a.id] && openSheet('image', { src: urls[a.id] })}>{urls[a.id] ? <img src={urls[a.id]} alt={a.name} /> : <Icon name="camera" size={22} />}</button>
        : <button type="button" key={a.id} class="attach pdf" onClick={() => openPdf(a)}><Icon name="doc" size={24} /><span>{a.name}</span></button>)}
    </div>
  );
}

export function ImageSheet({ src }) {
  return <SheetFrame title="" full><img src={src} alt="" style={{ width: '100%', borderRadius: 12, background: '#fff' }} /></SheetFrame>;
}

/** The reward, "I want this too", "I'll make it" and the requester's tools. */
function RequestBox({ p, busy, run }) {
  const s = useApp();
  const claimedByMe = p.me.claimed;
  return (
    <Card class="request-box">
      <div class="rb-top">
        <div class="rb-reward"><Coins n={p.pot} size="lg" /><span>{t('rewardPlusBonus')}</span></div>
        <div class="rb-wants"><strong class="num">{p.wants}</strong><span>{t('wantThis')}</span></div>
      </div>
      {p.status === 'open' && p.claimed && <p class="rb-claim"><Icon name="pencil" size={15} /> {claimedByMe ? t('youAreMaking', { left: timeLeft(p.claimed.until) }) : t('someoneMaking', { name: p.claimed.by?.name || '' })}</p>}
      {p.status === 'open' && !p.me.is_author && (
        <div class="btn-row">
          <Button kind={p.me.wanted ? 'primary' : 'secondary'} color="purple" icon="users" disabled={busy} onClick={() => run(() => (p.me.wanted ? C.unwant(p.id) : C.want(p.id)))}>{p.me.wanted ? t('youWantThis') : t('iWantThis')}</Button>
          <Button kind="secondary" icon="plus" onClick={() => openSheet('addCredits', { post: p })}>{t('addCredits')}</Button>
        </div>
      )}
      {p.status === 'open' && !p.me.is_author && (
        <div class="btn-row">
          {!claimedByMe && !p.claimed && <Button color="green" icon="pencil" disabled={busy} onClick={() => run(() => C.claim(p.id), t('claimedToast'))}>{t('illMakeIt')}</Button>}
          {claimedByMe && <Button kind="secondary" disabled={busy} onClick={() => run(() => C.unclaim(p.id))}>{t('letGo')}</Button>}
          <Button color="green" kind={claimedByMe ? 'primary' : 'secondary'} icon="send" onClick={() => openSheet('submitScore', { post: p })}>{t('sendScore')}</Button>
        </div>
      )}
      {p.status === 'open' && !p.me.is_author && <button type="button" class="link small" onClick={() => push('help', { topic: 'making' })}>{t('howToMake')}</button>}
      {p.me.is_author && p.status === 'open' && (
        <div class="btn-row">
          {!p.spotlight && <Button kind="secondary" color="yellow" icon="star" disabled={busy} onClick={() => run(() => C.spotlight(p.id), t('spotlightOn'))}>{t('spotlightIt')}</Button>}
          <Button kind="plain" disabled={busy} onClick={() => run(() => C.edit(p.id, { status: 'closed' }), t('requestClosed'))}>{t('closeRequest')}</Button>
        </div>
      )}
      {p.me.is_author && p.status === 'open' && <p class="note-text">{t('authorTip')}</p>}
      {p.can?.publish && <Button kind="secondary" icon="share" onClick={() => run(() => C.publish(p.id), t('sharedToLibrary'))}>{t('shareToLibrary')}</Button>}
      {p.licence === 'copyrighted' && <p class="note-text"><Icon name="info" size={13} /> {t('privateDelivery')}</p>}
      {!s.me && <p class="note-text">{t('needOnline')}</p>}
    </Card>
  );
}

function ShareBox({ p, run }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try { await openScoreFile(p.file_id, p.title, { from: 'community', postId: p.id }); } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  return (
    <Card>
      <div class="report-line"><Icon name="staff" size={22} /><p class="sub">{t('shareInfo', { bars: p.data?.bars || '?', notes: p.data?.notes || '?' })}</p></div>
      <div class="btn-row">
        <Button color="green" icon="download" disabled={busy || !p.file_id} onClick={open}>{t('openInMelovyn')}</Button>
        <Button kind="secondary" icon="star" onClick={() => run(() => C.react(`p:${p.id}`, 'save'))}>{p.me.saved ? t('saved') : t('save')}</Button>
      </div>
      {p.visibility === 'unlisted' && <p class="note-text"><Icon name="info" size={13} /> {t('unlistedNote')}</p>}
    </Card>
  );
}

/** Downloads a community score into the library and opens it. */
export async function openScoreFile(fid, title, extra = {}) {
  const xml = await C.fileText(fid);
  const score = parseMusicXML(xml);
  if (!score.title || score.title === 'Untitled') score.title = title;
  const rec = await addScore(score, { source: 'community', fmt: 'musicxml', title: score.title || title, extra });
  push('piece', { id: rec.id }, getState().tab);
  return rec;
}

function Reply({ r, p, run, onAccepted }) {
  const [busy, setBusy] = useState(false);
  const accepted = r.status === 'accepted';
  const openIt = async () => {
    if (!r.file?.id) return;
    setBusy(true);
    try { await openScoreFile(r.file.id, p.song || p.title, { from: 'community', postId: p.id }); } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  return (
    <div class={`reply k-${r.kind}${accepted ? ' accepted' : ''}${r.hidden ? ' hidden' : ''}`}>
      <div class="r-head">
        <PersonLine user={r.author} sub={timeAgo(r.created)} />
        {accepted && <span class="pill green"><Icon name="check" size={13} stroke={2.8} />{t('accepted')}{r.rating ? ` · ${'★'.repeat(r.rating)}` : ''}</span>}
        {r.status === 'helpful' && <span class="pill blue">{t('helpful')}</span>}
        {r.status === 'changes' && <span class="pill orange">{t('changesAsked')}</span>}
      </div>
      {r.kind === 'submission' && (
        <div class="r-score">
          <Icon name="staff" size={22} />
          <span><strong>{t('scoreSubmitted')}</strong><span>{t('barsNotes', { bars: r.file?.bars || 0, notes: r.file?.notes || 0 })}</span></span>
          {r.file?.id ? <Button small color="green" icon="play" disabled={busy} onClick={openIt}>{t('openInMelovyn')}</Button> : <span class="pill gray"><Icon name="eye" size={12} /> {t('privateScore')}</span>}
        </div>
      )}
      {r.body && <p class="r-body">{r.body}</p>}
      {r.note && (accepted || r.status === 'changes') && <p class="r-note"><Icon name={accepted ? 'heart' : 'pencil'} size={14} /> {r.note}</p>}
      {r.reward > 0 && <p class="r-reward"><Coins n={r.reward} size="sm" /> {t('earned')}</p>}
      <div class="r-actions">
        <button type="button" class={`clap${r.liked ? ' on' : ''}`} onClick={() => run(() => C.emoji(`r:${r.id}`, 'like'))}><Icon name="heart" size={15} fill={r.liked} />{r.likes || ''}</button>
        {r.can.accept && <Button small color="green" icon="check" onClick={() => openSheet('accept', { reply: r, post: p, onDone: onAccepted })}>{t(r.kind === 'answer' ? 'acceptAnswer' : 'acceptScore')}</Button>}
        {r.can.changes && <Button small kind="secondary" onClick={() => openSheet('changes', { reply: r })}>{t('askChanges')}</Button>}
        {r.can.helpful && <Button small kind="plain" onClick={() => run(() => C.helpful(r.id), t('thanked'))}>{t('markHelpful')}</Button>}
        {!r.can.delete && <button type="button" class="link small" onClick={() => openReport(`r:${r.id}`)}>{t('report')}</button>}
        {r.can.delete && !accepted && <button type="button" class="link small" onClick={() => run(() => C.removeReply(r.id))}>{t('delete')}</button>}
      </div>
    </div>
  );
}

// ---------- sheets ----------

export function AcceptSheet({ reply, post, onDone }) {
  const [rating, setRating] = useState(5);
  const [thanks, setThanks] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const r = await attempt(() => C.accept(reply.id, rating, thanks));
    setBusy(false);
    if (r) { closeSheet(); reloadPost(); onDone?.(); toast(t('acceptedToast', { name: reply.author?.name || '' })); }
  };
  return (
    <SheetFrame title={t(reply.kind === 'answer' ? 'acceptAnswer' : 'acceptScore')} right={t('accept')} onRight={go} rightDisabled={busy}>
      <div class="with-mascot"><Mascot mood="cheer" size={56} /><div class="bubble left">{t('acceptHint')}</div></div>
      <StarsInput value={rating} onChange={setRating} />
      <p class="note-text center">{t(`stars${rating}`)}</p>
      <textarea class="textarea" rows="3" maxLength={500} placeholder={t('sayThanks')} value={thanks} onInput={(e) => setThanks(e.currentTarget.value)} aria-label={t('sayThanks')} />
      <p class="note-text">{t('acceptRewardNote', { pot: post.pot })}</p>
      <Button full color="green" icon="check" disabled={busy} onClick={go}>{t('accept')}</Button>
    </SheetFrame>
  );
}

export function ChangesSheet({ reply }) {
  const [note, setNote] = useState('');
  const go = async () => {
    const r = await attempt(() => C.changes(reply.id, note));
    if (r) { closeSheet(); reloadPost(); toast(t('changesSent')); }
  };
  return (
    <SheetFrame title={t('askChanges')} right={t('send')} onRight={go} rightDisabled={note.trim().length < 2}>
      <p class="note-text">{t('changesHint')}</p>
      <textarea class="textarea" rows="4" maxLength={1000} placeholder={t('changesExample')} value={note} onInput={(e) => setNote(e.currentTarget.value)} aria-label={t('askChanges')} />
    </SheetFrame>
  );
}

export function AddCreditsSheet({ post }) {
  const s = useApp();
  const [n, setN] = useState(10);
  const bal = s.me?.credits ?? 0;
  const go = async () => {
    const r = await attempt(() => C.want(post.id, n));
    if (r) { closeSheet(); reloadPost(); ensureAccount({ fresh: true }); toast(t('creditsAdded', { n })); }
  };
  return (
    <SheetFrame title={t('addCredits')} right={t('add')} onRight={go} rightDisabled={n > bal || n < 1}>
      <p class="note-text">{t('addCreditsHint')}</p>
      <div class="chips wrap">{[5, 10, 25, 50, 100].map((v) => <Chip key={v} on={n === v} onClick={() => setN(v)}>{v}</Chip>)}</div>
      <p class="sub">{t('yourBalance')} <Coins n={bal} size="sm" /></p>
      <p class="note-text">{t('refundNote')}</p>
    </SheetFrame>
  );
}

/** Send a score for a request: pick a piece from your library (made in Melovyn or imported from MuseScore etc.). */
export function SubmitScoreSheet({ post }) {
  const s = useApp();
  const [sel, setSel] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const scores = s.pieces.filter((x) => x.kind === 'score');
  const go = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      const data = await getPiece(sel);
      const xml = data?.rec?.xml || (data?.score ? writeMusicXML(data.score) : null);
      if (!xml) throw new Error(t('notAScore'));
      const r = await attempt(() => C.reply(post.id, { kind: 'submission', body: msg.trim(), xml }));
      if (r) { closeSheet(); reloadPost(); toast(t('scoreSent')); }
    } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  return (
    <SheetFrame title={t('sendScore')} right={t('send')} onRight={go} rightDisabled={!sel || busy}>
      <p class="note-text">{t('sendScoreHint')}</p>
      {scores.length ? (
        <List>{scores.slice(0, 60).map((x) => <Row key={x.id} icon={sel === x.id ? 'check' : 'staff'} color={sel === x.id ? 'green' : 'gray'} title={x.title}
          subtitle={[x.composer, x.measures ? t('barsN', { n: x.measures }) : ''].filter(Boolean).join(' · ')} onClick={() => setSel(x.id)} />)}</List>
      ) : <p class="sub">{t('noScoresInLibrary')}</p>}
      <textarea class="textarea" rows="2" maxLength={2000} placeholder={t('scoreMessage')} value={msg} onInput={(e) => setMsg(e.currentTarget.value)} aria-label={t('scoreMessage')} />
      <Button full color="green" icon="send" disabled={!sel || busy} onClick={go}>{busy ? t('sending') : t('sendScore')}</Button>
    </SheetFrame>
  );
}
