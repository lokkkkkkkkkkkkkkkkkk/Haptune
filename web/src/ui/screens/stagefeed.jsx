// Stage as a music feed: everyone posts anything (a few words, photos, a recording, a video link, a score, a
// request or a question), and the feed shows it like a social app: who, when, the post, and react, reply, share.
import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, push, openSheet, closeSheet, toast } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, Button } from '../components.jsx';
import { SheetFrame } from './common.jsx';
import { Mascot } from '../mascot.jsx';
import { C, attempt, ensureAccount, fileToAttachment } from '../account.js';
import { serverURL } from '../api.js';
import { listen } from '../audio.js';
import { Person, timeAgo, StatusPill, TYPE, EMOJI } from './social.jsx';
import { whenSignedIn } from './hub.jsx';
import { blobToB64 } from './piece.jsx';

const fileURL = (id) => `${serverURL()}/c/files/${id}`;
const ytId = (url) => /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(url || '')?.[1] || null;

/** The box at the top of Stage: "What are you playing?" and quick ways to post. */
export function Composer() {
  const s = useApp();
  const me = s.me;
  const go = (type) => whenSignedIn(() => (type === 'moment' ? openSheet('moment') : type === 'record' ? openSheet('moment', { record: true }) : openSheet('compose', { type })));
  return (
    <div class="composer3 card" id="st-composer">
      <div class="c3-top">
        <Person user={me ? { name: me.name, avatar: me.avatar } : null} size={42} />
        <button type="button" class="c3-input" onClick={() => go('moment')} id="st-post">{t('composerPrompt')}</button>
      </div>
      <div class="c3-quick">
        <button type="button" class="c-teal" onClick={() => go('record')} id="st-record"><Icon name="mic" size={17} stroke={2.3} />{t('qRecord')}</button>
        <button type="button" class="c-violet" onClick={() => go('moment')}><Icon name="camera" size={17} stroke={2.3} />{t('qPhoto')}</button>
        <button type="button" class="c-green" onClick={() => go('share')} id="st-share"><Icon name="staff" size={17} stroke={2.3} />{t('qScore')}</button>
        <button type="button" class="c-pink" onClick={() => go('request')} id="st-request"><Icon name="flag" size={17} stroke={2.3} />{t('qRequest')}</button>
        <button type="button" class="c-blue" onClick={() => go('question')}><Icon name="quiz" size={17} stroke={2.3} />{t('qAsk')}</button>
      </div>
    </div>
  );
}

/** The feed: newest first, every kind of post, loading more at the end. */
export function Feed({ active, following = false }) {
  const s = useApp();
  const [items, setItems] = useState(null);
  const [more, setMore] = useState(true);
  const [err, setErr] = useState('');
  const load = async (offset = 0) => {
    try {
      const r = await C.posts({ sort: 'new', following: following || undefined, limit: 15, offset });
      setItems((x) => (offset ? [...(x || []), ...r.items] : r.items));
      setMore(r.items.length === 15);
      setErr('');
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { if (active) load(0); }, [active, following, s.me?.id, s.stageRev]);
  if (err && !items) return <div class="empty3 card"><Mascot mood="sad" size={70} /><p>{err}</p><Button kind="secondary" onClick={() => load(0)}>{t('tryAgain')}</Button></div>;
  if (!items) return <div class="loading"><Mascot mood="think" size={70} /></div>;
  if (!items.length) return <div class="empty3 card"><Mascot mood="wave" size={80} /><h3>{following ? t('feedFollowEmpty') : t('feedEmpty3')}</h3><p>{t('feedEmptySub')}</p></div>;
  return (
    <div class="feed3" id="stage-feed">
      {items.map((p) => <FeedCard key={p.id} p={p} />)}
      {more && <Button kind="secondary" full onClick={() => load(items.length)}>{t('loadMore')}</Button>}
    </div>
  );
}

export function FeedCard({ p }) {
  const [liked, setLiked] = useState(!!p.me?.liked);
  const [likes, setLikes] = useState(p.likes || 0);
  const [face, setFace] = useState(null);
  const open = () => push('post', { id: p.id });
  const ty = TYPE[p.type];
  const imgs = (p.attachments || []).filter((a) => a.mime?.startsWith('image/'));
  const audio = (p.attachments || []).find((a) => a.mime?.startsWith('audio/'));
  const yt = ytId(p.link);
  const like = async (e) => {
    e.stopPropagation();
    const r = await attempt(() => C.react(`p:${p.id}`, 'like'));
    if (r) { setLiked(!!r.on); setLikes(r.count ?? (likes + (r.on ? 1 : -1))); if (r.on) { setFace('❤️'); setTimeout(() => setFace(null), 700); } }
  };
  const share = async (e) => {
    e.stopPropagation();
    const url = `${(globalThis.HAPTUNE_CONFIG?.site || location.origin).replace(/\/+$/, '')}/app/#post/${p.id}`;
    try { if (navigator.share) { await navigator.share({ title: p.title, url }); return; } } catch (er) { if (er?.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(url); toast(t('copied')); } catch { toast(url); }
  };
  const d = p.data || {};
  return (
    <article class={`fc3 t-${p.type}`} onClick={open}>
      <header class="fc3-head">
        <button type="button" class="fc3-who" onClick={(e) => { e.stopPropagation(); if (p.author?.handle) push('profile', { handle: p.author.handle }); }}>
          <Person user={p.author} size={40} />
          <span><strong>{p.author?.name || ''}</strong><span class="tiny">{timeAgo(p.created)}{p.instruments?.length ? ` · ${p.instruments.slice(0, 2).join(', ')}` : ''}</span></span>
        </button>
        {ty && p.type !== 'moment' && <span class={`pill3 c-${ty.color}`}><Icon name={ty.icon} size={13} stroke={2.4} />{t(ty.label)}</span>}
        <StatusPill p={p} />
      </header>
      {p.type === 'show' ? (
        <div class="fc3-show"><span class="big num">{d.accuracy != null ? `${Math.round(d.accuracy * 100)}%` : '🎵'}</span><span>{t('showLine', { name: '', piece: d.piece || p.title })}</span></div>
      ) : p.type !== 'moment' && <h3 class="fc3-title">{p.title}</h3>}
      {p.body && <p class="fc3-body">{p.body}</p>}
      {imgs.length > 0 && <div class={`fc3-imgs n${Math.min(imgs.length, 4)}`}>{imgs.slice(0, 4).map((a) => <img key={a.id} src={fileURL(a.id)} alt={a.name || ''} loading="lazy" />)}</div>}
      {audio && <div class="fc3-audio" onClick={(e) => e.stopPropagation()}><Icon name="mic" size={16} /><audio controls preload="none" src={fileURL(audio.id)} /></div>}
      {yt && <div class="fc3-yt"><img src={`https://i.ytimg.com/vi/${yt}/hqdefault.jpg`} alt="" loading="lazy" /><span class="play"><Icon name="play" size={26} fill stroke={1.4} /></span></div>}
      {p.type === 'share' && <div class="fc3-score"><Icon name="staff" size={20} /><span>{[p.song || p.title, p.artist].filter(Boolean).join(' · ')}{d.bars ? ` · ${t('barsN', { n: d.bars })}` : ''}</span><span class="pill3 c-green">{t('openIt')}</span></div>}
      {p.type === 'request' && <div class="fc3-req"><Icon name="users" size={16} />{t('requestedBy', { n: p.wants || 1 })}{p.pot ? ` · ${t('rewardN', { n: p.pot })}` : ''}</div>}
      <footer class="fc3-act">
        <button type="button" class={liked ? 'on' : ''} onClick={like} aria-pressed={liked}><Icon name="heart" size={19} fill={liked} stroke={2.1} />{likes || ''}{face && <span class="pop">{face}</span>}</button>
        <button type="button" onClick={(e) => { e.stopPropagation(); open(); }}><Icon name="chat" size={19} stroke={2.1} />{p.replies || ''}</button>
        <button type="button" onClick={share}><Icon name="share" size={19} stroke={2.1} /></button>
        <span class="spacer" />
        {p.type === 'request' && <span class="tiny">{t('canYouHelp')}</span>}
      </footer>
    </article>
  );
}
void EMOJI;

/** A moment: a few words, up to four photos, a recording made right here, or a video link. */
export function MomentSheet({ record = false }) {
  const s = useApp();
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [files, setFiles] = useState([]);
  const [rec, setRec] = useState(null);          // {blob, type, seconds, url}
  const [recording, setRecording] = useState(false);
  const [secs, setSecs] = useState(0);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const stopRef = useRef(null);
  const timer = useRef(0);
  useEffect(() => { ensureAccount(); if (record) startRec(); return () => { stopRef.current?.(); clearInterval(timer.current); }; }, []);
  const startRec = async () => {
    try {
      const stop = await listen(() => {}, { record: true });
      stopRef.current = stop;
      setRecording(true); setSecs(0);
      const t0 = Date.now();
      timer.current = setInterval(() => { const n = Math.round((Date.now() - t0) / 1000); setSecs(n); if (n >= 150) stopRec(); }, 500);
    } catch (e) { toast(t(e.code === 'denied' ? 'micDenied' : 'micUnavailable'), 'err'); }
  };
  const stopRec = async () => {
    clearInterval(timer.current);
    const stop = stopRef.current;
    stopRef.current = null;
    setRecording(false);
    if (!stop) return;
    stop();
    const r = await stop.recording();
    if (r?.blob) setRec({ ...r, url: URL.createObjectURL(r.blob) });
  };
  const onPick = async (e) => {
    const list = [...(e.currentTarget.files || [])].slice(0, 4 - files.length);
    e.currentTarget.value = '';
    const out = [];
    for (const f of list) { try { out.push({ ...(await fileToAttachment(f)), preview: URL.createObjectURL(f) }); } catch { /* skip */ } }
    setFiles((x) => [...x, ...out].slice(0, 4));
  };
  const ok = (text.trim() || files.length || rec || link.trim()) && !recording;
  const post = async () => {
    if (!ok) return;
    if (link.trim() && !/^https?:\/\/\S+$/.test(link.trim())) { toast(t('linkStartsHttp'), 'err'); return; }
    setBusy(true);
    try {
      const attachments = files.map(({ name, mime, data }) => ({ name, mime, data }));
      if (rec?.blob) {
        if (rec.blob.size > 2 * 1024 * 1024) { toast(t('recordingTooLong'), 'err'); setBusy(false); return; }
        attachments.push({ name: `recording.${rec.type.includes('mp4') ? 'm4a' : 'webm'}`, mime: rec.type, data: await blobToB64(rec.blob) });
      }
      const p = await C.create({ type: 'moment', title: '', body: text.trim(), link: link.trim(), attachments, instruments: [s.me?.instruments?.[0] || s.settings.instrument].filter(Boolean) });
      closeSheet();
      toast(t('posted'));
      import('../state.js').then((m) => m.setState((st) => ({ stageRev: (st.stageRev || 0) + 1 })));
      void p;
    } catch (e) { toast(e.message || String(e), 'err'); }
    setBusy(false);
  };
  return (
    <SheetFrame title={t('newMoment')} right={t('post')} onRight={post} rightDisabled={!ok || busy}>
      <input ref={fileRef} type="file" accept="image/*" multiple class="hidden-input" onChange={onPick} />
      <label class="field3"><textarea id="moment-text" rows={4} value={text} onInput={(e) => setText(e.currentTarget.value)} placeholder={t('momentPh')} maxLength={4000} /></label>
      {files.length > 0 && <div class="fc3-imgs edit">{files.map((f, i) => <span key={i} class="thumb"><img src={f.preview} alt="" /><button type="button" onClick={() => setFiles(files.filter((_, k) => k !== i))} aria-label={t('delete')}><Icon name="close" size={14} stroke={2.6} /></button></span>)}</div>}
      {recording && <div class="rec-live"><span class="dot" />{t('recordingNow')} {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}<span class="spacer" /><Button small onClick={stopRec} icon="stop">{t('stop')}</Button></div>}
      {rec && !recording && <div class="fc3-audio"><Icon name="mic" size={16} /><audio controls src={rec.url} /><button type="button" class="icon-btn" onClick={() => setRec(null)} aria-label={t('delete')}><Icon name="trash" size={17} /></button></div>}
      <label class="field3"><span>{t('videoLink')}</span><input value={link} onInput={(e) => setLink(e.currentTarget.value)} placeholder="https://youtube.com/…" inputMode="url" /></label>
      <div class="row-gap">
        <Button small kind="secondary" icon="camera" onClick={() => fileRef.current?.click()} disabled={files.length >= 4}>{t('qPhoto')}</Button>
        {!recording && !rec && <Button small kind="secondary" icon="mic" onClick={startRec} id="moment-rec">{t('qRecord')}</Button>}
      </div>
      <p class="tiny">{t('momentRules')}</p>
      <Button full icon="send" onClick={post} disabled={!ok || busy} id="moment-post">{busy ? t('sending') : t('post')}</Button>
    </SheetFrame>
  );
}
