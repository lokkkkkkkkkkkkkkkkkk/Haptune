// Writing a post: ask for a song's score, ask a question, share a score, or share a practice win.
import { useState, useRef, useEffect } from 'preact/hooks';
import { useApp, closeSheet, push, toast, getPiece, openSheet } from '../state.js';
import { t, instrumentName, INSTRUMENTS, getLang } from '../../core/i18n.js';
import { Icon, Button, Chip, List, Row, Section, Card } from '../components.jsx';
import { SheetFrame } from './common.jsx';
import { Mascot } from '../mascot.jsx';
import { writeMusicXML } from '../../core/musicxml.js';
import { C, attempt, ensureAccount, fileToAttachment } from '../account.js';
import { Coins, PostCard } from './social.jsx';

const LEVELS = ['beginner', 'intermediate', 'advanced'];
const LICENCES = ['pd', 'own', 'arr', 'copyrighted', 'unknown'];

export function ComposeSheet({ type: initial = 'request', piece = null, show = null }) {
  const s = useApp();
  const [type, setType] = useState(initial);
  const [title, setTitle] = useState(piece?.title || '');
  const [song, setSong] = useState('');
  const [artist, setArtist] = useState(piece?.composer || '');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [insts, setInsts] = useState(() => [s.me?.instruments?.[0] || s.settings.instrument].filter(Boolean));
  const [level, setLevel] = useState('');
  const [licence, setLicence] = useState(type === 'share' ? '' : 'unknown');
  const [pot, setPot] = useState(0);
  const [files, setFiles] = useState([]);
  const [pick, setPick] = useState(piece?.id || null);
  const [busy, setBusy] = useState(false);
  const [similar, setSimilar] = useState([]);
  const fileRef = useRef(null);
  const bal = s.me?.credits ?? 0;
  useEffect(() => { ensureAccount(); }, []);
  // "maybe it's already here": look for shared scores of the same song while typing
  useEffect(() => {
    if (type !== 'request') return undefined;
    const q = (song || title).trim();
    if (q.length < 3) { setSimilar([]); return undefined; }
    const tm = setTimeout(async () => { try { setSimilar((await C.posts({ q, limit: 3 })).items.filter((p) => p.type === 'share' || p.status === 'done')); } catch { /* offline */ } }, 500);
    return () => clearTimeout(tm);
  }, [song, title, type]);
  const toggleInst = (i) => setInsts((x) => (x.includes(i) ? x.filter((y) => y !== i) : [...x, i].slice(-3)));
  const addFiles = async (e) => {
    const list = [...(e.currentTarget.files || [])];
    e.currentTarget.value = '';
    const out = [];
    for (const f of list.slice(0, 3 - files.length)) {
      const a = await fileToAttachment(f);
      if (a.size > 2 * 1024 * 1024) { toast(t('fileTooBig'), 'err'); continue; }
      out.push(a);
    }
    setFiles((x) => [...x, ...out].slice(0, 3));
  };
  const scores = s.pieces.filter((x) => x.kind === 'score');
  const finalTitle = type === 'request' ? (title.trim() || song.trim()) : title.trim();
  const ok = type === 'show' ? true : type === 'share' ? !!pick && !!licence && finalTitle.length >= 2 : finalTitle.length >= 2;
  const post = async () => {
    if (!ok) return;
    if (!(await ensureAccount())) { toast(t('needOnline'), 'err'); return; }
    setBusy(true);
    try {
      const b = { type, title: finalTitle || show?.piece || '', body: body.trim(), instruments: insts, level, lang: getLang() };
      if (type === 'request') Object.assign(b, { song: song.trim() || title.trim(), artist: artist.trim(), link: link.trim(), licence, pot, attachments: files.map(({ name, mime, data }) => ({ name, mime, data })) });
      if (type === 'question') Object.assign(b, { pot, attachments: files.map(({ name, mime, data }) => ({ name, mime, data })) });
      if (type === 'share') {
        const data = await getPiece(pick);
        b.xml = data?.rec?.xml || writeMusicXML(data.score);
        Object.assign(b, { licence, artist: artist.trim(), song: finalTitle });
      }
      if (type === 'show') Object.assign(b, { title: t('showTitle', { piece: show.piece }), data: show });
      const r = await attempt(() => C.create(b));
      if (r) {
        closeSheet();
        ensureAccount({ fresh: true });
        toast(t(type === 'request' ? 'requestPosted' : 'posted'));
        push('post', { id: r.id }, 'community');
      }
    } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  const types = [['request', 'flag', 'pink', 'typeRequest'], ['question', 'quiz', 'blue', 'typeQuestion'], ['share', 'staff', 'green', 'typeShare']];
  return (
    <SheetFrame title={t(`new_${type}`)} right={t('post')} onRight={post} rightDisabled={!ok || busy} full>
      {!show && (
        <div class="type-pick">
          {types.map(([v, icon, color, label]) => (
            <button type="button" key={v} class={`type-btn c-${color}${type === v ? ' on' : ''}`} onClick={() => { setType(v); if (v === 'share') setLicence(''); }}>
              <Icon name={icon} size={20} stroke={2.2} /><span>{t(label)}</span>
            </button>
          ))}
        </div>
      )}

      {type === 'request' && <>
        <div class="with-mascot"><Mascot mood="listen" size={54} /><div class="bubble left">{t('requestIntro')}</div></div>
        <label class="field-label" for="c-song">{t('songName')} *</label>
        <input class="field" id="c-song" maxLength={140} value={song} onInput={(e) => setSong(e.currentTarget.value)} placeholder={t('songNameExample')} />
        <label class="field-label" for="c-artist">{t('artistOrComposer')}</label>
        <input class="field" id="c-artist" maxLength={100} value={artist} onInput={(e) => setArtist(e.currentTarget.value)} />
        <label class="field-label" for="c-link">{t('referenceLink')}</label>
        <input class="field" id="c-link" type="url" inputMode="url" maxLength={400} value={link} onInput={(e) => setLink(e.currentTarget.value)} placeholder="https://youtu.be/…" />
        <p class="note-text">{t('linkNote')}</p>
        {similar.length > 0 && (
          <Card class="maybe-card"><p class="sub"><Icon name="search" size={14} /> {t('maybeAlready')}</p><div class="post-list">{similar.map((p) => <PostCard key={p.id} p={p} compact />)}</div></Card>
        )}
      </>}

      {type !== 'request' && type !== 'show' && <>
        <label class="field-label" for="c-title">{type === 'question' ? t('yourQuestion') : t('title')} *</label>
        <input class="field" id="c-title" maxLength={120} value={title} onInput={(e) => setTitle(e.currentTarget.value)} placeholder={type === 'question' ? t('questionExample') : ''} />
      </>}

      {type === 'share' && <>
        <label class="field-label">{t('pickScore')} *</label>
        {scores.length ? <List>{scores.slice(0, 40).map((x) => <Row key={x.id} icon={pick === x.id ? 'check' : 'staff'} color={pick === x.id ? 'green' : 'gray'} title={x.title} subtitle={x.composer}
          onClick={() => { setPick(x.id); if (!title) setTitle(x.title); if (!artist) setArtist(x.composer || ''); }} />)}</List> : <p class="sub">{t('noScoresInLibrary')}</p>}
        <label class="field-label" for="c-artist2">{t('artistOrComposer')}</label>
        <input class="field" id="c-artist2" maxLength={100} value={artist} onInput={(e) => setArtist(e.currentTarget.value)} />
      </>}

      {type === 'show' && show && (
        <Card><div class="show-stats"><div><strong class="num t-green">{Math.round((show.accuracy || 0) * 100)}%</strong><span>{t('accuracy')}</span></div><div><strong>{show.piece}</strong><span>{t('piece')}</span></div></div></Card>
      )}

      {type !== 'show' && <>
        <label class="field-label">{t('instruments')}</label>
        <div class="chips wrap">{INSTRUMENTS.map((i) => <Chip key={i} on={insts.includes(i)} onClick={() => toggleInst(i)}>{instrumentName(i)}</Chip>)}</div>
        <label class="field-label">{t('level')}</label>
        <div class="chips">{LEVELS.map((l) => <Chip key={l} on={level === l} onClick={() => setLevel(level === l ? '' : l)}>{t(l)}</Chip>)}</div>
      </>}

      <label class="field-label" for="c-body">{type === 'request' ? t('whatYouNeed') : type === 'show' ? t('sayHow') : t('details')}</label>
      <textarea class="textarea" id="c-body" rows="4" maxLength={4000} value={body} onInput={(e) => setBody(e.currentTarget.value)}
        placeholder={t(type === 'request' ? 'whatYouNeedExample' : type === 'question' ? 'detailsExample' : 'sayHowExample')} />

      {(type === 'request' || type === 'question') && <>
        <input ref={fileRef} type="file" class="hidden-input" accept="image/*,application/pdf" multiple onChange={addFiles} aria-label={t('addPhotos')} />
        <div class="attach-row">
          {files.map((f, i) => <span key={i} class="attach-chip"><Icon name={f.mime === 'application/pdf' ? 'doc' : 'camera'} size={14} />{f.name.slice(0, 18)}<button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={t('delete')}><Icon name="close" size={12} /></button></span>)}
          {files.length < 3 && <Button small kind="secondary" icon="camera" onClick={() => fileRef.current?.click()}>{t(type === 'request' ? 'addPagePhotos' : 'addPhotos')}</Button>}
        </div>
      </>}

      {(type === 'request' || type === 'share') && <>
        <label class="field-label">{t('whoseMusic')}{type === 'share' ? ' *' : ''}</label>
        <div class="chips wrap">{LICENCES.filter((l) => type === 'request' || l !== 'unknown').map((l) => <Chip key={l} on={licence === l} onClick={() => setLicence(l)}>{t(`lic_${l}`)}</Chip>)}</div>
        <p class="note-text"><Icon name="info" size={13} /> {t(type === 'share' ? (licence && !['pd', 'own', 'arr'].includes(licence) ? 'shareCopyrightNote' : 'sharePublicNote') : 'requestCopyrightNote')}</p>
      </>}

      {(type === 'request' || type === 'question') && <>
        <label class="field-label">{t('reward')} <span class="sub">({t('optional')})</span></label>
        <div class="chips">{[0, 10, 25, 50, 100].map((v) => <Chip key={v} on={pot === v} onClick={() => setPot(v)} color="yellow">{v ? <><span class="coin sm" aria-hidden="true" />{v}</> : t('none')}</Chip>)}</div>
        <p class="note-text">{t(type === 'request' ? 'rewardNote' : 'bountyHint')} {t('yourBalance')} <Coins n={bal} size="sm" /></p>
      </>}

      {type === 'request' && <Tips />}

      <Button full color={type === 'request' ? 'pink' : type === 'share' ? 'green' : 'blue'} icon="send" disabled={!ok || busy} onClick={post}>{busy ? t('sending') : t(type === 'request' ? 'postRequest' : 'post')}</Button>
      <p class="note-text center">{t('beKind')} <button type="button" class="link" onClick={() => openSheet('guidelines')}>{t('guidelines')}</button></p>
    </SheetFrame>
  );
}

/** What gets people the best score fastest (shown while writing a request). */
function Tips() {
  return (
    <Card class="tips">
      <p class="tips-title"><Icon name="sparkles" size={16} /> {t('tipsTitle')}</p>
      <ul>{['reqTip1', 'reqTip2', 'reqTip3', 'reqTip4', 'reqTip5'].map((k) => <li key={k}>{t(k)}</li>)}</ul>
    </Card>
  );
}
