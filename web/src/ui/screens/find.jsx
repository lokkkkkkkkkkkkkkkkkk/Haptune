// Find: one search for everything (your library, the free library, Stage scores and requests), with instrument,
// level and genre chips ready before you type, so the first tap on a result opens a playable sheet.
// New songs: what's new (the newest free-library collections, requests just fulfilled, Sounds from people you
// follow, new scores on Stage).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp, push, openSheet, toast } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, Chip, Empty } from '../components.jsx';
import { NavBar } from './common.jsx';
import { hasServer, isLink } from '../api.js';
import { C } from '../account.js';
import { loadCatalog, searchCatalog, addCatalogPiece, catalogSources, norm, GENRES } from '../catalog.js';
import { Cover, INSTRUMENT_HUE } from '../cover.jsx';
import { track } from '../analytics.js';
import { openFiles } from '../intake.js';
import { call } from '../api.js';
import { RESULT_TYPES, fromClass, fromPerson, fromSound, fromPost } from '../../core/piece.js';

export const LEVELS = [1, 2, 3, 4];
const INST = ['piano', 'guitar', 'violin', 'voice', 'flute', 'cello'];

export async function openCatalogEntry(entry, start = null) {
  try {
    const rec = await addCatalogPiece(entry);
    if (rec) push('piece', { id: rec.id, ...(start ? { start } : {}) }, 'library');
  } catch (e) { toast(e.message || String(e), 'err'); }
}

/** A result row: cover, title, a line of detail, an action word. */
export function ResultRow({ title, sub, cover, act, onClick, id }) {
  return (
    <button type="button" class="sr-item" onClick={onClick} id={id}>
      {cover}
      <span class="t"><strong>{title}</strong><span>{sub}</span></span>
      {act && <span class="act">{act}</span>}
    </button>
  );
}

export function FindView({ active, q: q0 = '' }) {
  const s = useApp();
  const [q, setQ] = useState(q0);
  const [inst, setInst] = useState(INST.includes(s.settings.instrument) ? s.settings.instrument : '');
  const [level, setLevel] = useState(0);
  const [genre, setGenre] = useState('');
  const [catalog, setCatalog] = useState(null);
  const [stage, setStage] = useState(null);
  const [more, setMore] = useState(null);           // classes, people, Sounds, posts (/c/find)
  const [type, setType] = useState('');             // the type chip: '' = everything
  const input = useRef(null), pageRef = useRef(null);
  const query = q.trim();
  useEffect(() => { loadCatalog().then(setCatalog); }, []);
  useEffect(() => { if (active) setTimeout(() => input.current?.focus(), 250); }, [active]);
  useEffect(() => {
    setStage(null); setMore(null);
    if (!hasServer() || query.length < 2 || isLink(query)) return undefined;
    const timer = setTimeout(() => {
      C.search(query).then(setStage).catch(() => setStage({ scores: [], requests: [] }));
      call(`/c/find?q=${encodeURIComponent(query)}`).then(setMore).catch(() => setMore(null));
      track('search', { label: query.slice(0, 60) });
    }, 380);
    return () => clearTimeout(timer);
  }, [query]);
  const mine = useMemo(() => {
    const words = norm(query).split(' ').filter(Boolean);
    return s.pieces.filter((p) => { const k = norm(`${p.title} ${p.composer}`); return words.every((w) => k.includes(w)); }).slice(0, query ? 6 : 0);
  }, [query, s.pieces]);
  const free = useMemo(() => {
    if (!catalog) return [];
    let rows = searchCatalog(catalog, query, { limit: 3000, genre });
    if (inst) { const pref = rows.filter((r) => (r.instrument || '') === inst); if (pref.length >= 6 || query) rows = [...pref, ...rows.filter((r) => (r.instrument || '') !== inst)]; }
    if (level) rows = rows.filter((r) => !r.level || r.level <= level);
    return rows.filter((r) => !mine.some((p) => p.catalogId === r.id)).slice(0, query ? 12 : 9);
  }, [catalog, query, inst, level, genre, mine]);
  const nothing = query && !mine.length && !free.length && stage && !stage.scores.length && !stage.requests.length;
  // one search for everything, with a chip per kind of result (YouTube Music's "Songs · Albums · Artists")
  const counts = {
    pieces: mine.length + (query ? free.length : 0) + (stage ? stage.scores.length + stage.requests.length : 0),
    classes: more?.classes?.length || 0, people: more?.people?.length || 0, sounds: more?.sounds?.length || 0, posts: more?.posts?.length || 0,
  };
  const kinds = RESULT_TYPES.filter((k) => counts[k] > 0);
  const show = (k) => !type || type === k;
  useEffect(() => { if (type && !counts[type]) setType(''); }, [query, more, stage]);
  const onPick = (e) => { const files = [...(e.currentTarget.files || [])]; e.currentTarget.value = ''; openFiles(files); };
  return (
    <div class="scroll" id="find">
      <NavBar title={t('findSongs')} backLabel={t('back')} color="blue" />
      <div class="wrap">
        <input ref={pageRef} type="file" class="hidden-input" accept=".pdf,application/pdf,image/*" multiple onChange={onPick} aria-label={t('wayScan')} />
        <form class="ios-search" role="search" onSubmit={(e) => { e.preventDefault(); if (isLink(query)) openSheet('finder', { query }); }}>
          <Icon name="search" size={17} stroke={2.4} />
          <input ref={input} id="find-q" type="search" enterkeyhint="search" autocomplete="off" placeholder={t('findPh')} value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label={t('findPh')} />
          {q && <button type="button" class="ios-cancel" onClick={() => setQ('')}>{t('cancel')}</button>}
        </form>
        <div class="chips find-chips" id="find-inst">{INST.map((k) => <Chip key={k} on={inst === k} onClick={() => setInst(inst === k ? '' : k)}><i class="inst-dot" style={{ '--ih': INSTRUMENT_HUE[k] ?? 200 }} />{t(`inst_${k}`)}</Chip>)}</div>
        <div class="chips find-chips" id="find-level">{LEVELS.map((n) => <Chip key={n} on={level === n} onClick={() => setLevel(level === n ? 0 : n)}>{t(`lvl_${n}`)}</Chip>)}
          {GENRES.filter((g) => catalog?.some((r) => r.genre === g)).map((g) => <Chip key={g} on={genre === g} onClick={() => setGenre(genre === g ? '' : g)}>{t(`genre_${g}`)}</Chip>)}</div>

        {query && kinds.length > 1 && <div class="chips find-chips" id="find-types" role="tablist">
          <Chip on={!type} onClick={() => setType('')} id="ft-all">{t('typeAll')}</Chip>
          {kinds.map((k) => <Chip key={k} on={type === k} onClick={() => setType(type === k ? '' : k)} id={`ft-${k}`}>{t(k === 'pieces' ? 'findPieces' : `find${k[0].toUpperCase()}${k.slice(1)}`)} · {counts[k]}</Chip>)}
        </div>}
        {show('pieces') && mine.length > 0 && <div class="sr-group"><div class="sr-label">{t('inYourLibrary')}</div>
          {mine.map((p) => <ResultRow key={p.id} title={p.title} sub={[p.composer, p.keyText].filter(Boolean).join(' · ')} act={t('openIt')}
            cover={<Cover title={p.title} instrument={p.instrument} keyText={p.keyText} size="sm" />} onClick={() => push('piece', { id: p.id }, 'library')} />)}</div>}
        {show('pieces') && <div class="sr-group" id="find-free"><div class="sr-label">{query ? t('freeLibrary') : t('findSuggested')}</div>
          {!catalog ? <div class="skeleton-rows"><i /><i /><i /></div> : free.map((r, i) => <ResultRow key={r.id} id={i === 0 ? 'find-first' : undefined} title={r.title}
            sub={[r.composer, t(`genre_${r.genre}`), r.level ? t(`lvl_${r.level}`) : ''].filter(Boolean).join(' · ')} act={t('getIt')}
            cover={<Cover title={r.title} instrument={r.instrument} genre={r.genre} size="sm" />} onClick={() => openCatalogEntry(r)} />)}
          {catalog && !free.length && !query && <p class="tiny muted">{t('findNoneFilter')}</p>}</div>}
        {show('pieces') && stage && (stage.scores.length > 0 || stage.requests.length > 0) && <div class="sr-group"><div class="sr-label"><Icon name="stage" size={14} stroke={2.4} />{t('onStage')}</div>
          {stage.scores.map((p) => <ResultRow key={p.id} title={p.title} sub={[p.artist, p.author?.name].filter(Boolean).join(' · ')} act={t('view')}
            cover={<Cover title={p.title} instrument={p.instrument} size="sm" icon="staff" />} onClick={() => push('post', { id: p.id }, 'community')} />)}
          {stage.requests.map((p) => <ResultRow key={p.id} title={p.title} sub={t('requestedBy', { n: p.wants || 1 })} act={t('wantToo')}
            cover={<Cover title={p.title} instrument={p.instrument} size="sm" icon="flag" />} onClick={() => push('post', { id: p.id }, 'community')} />)}</div>}
        {more && <FindMore more={more} type={type} />}
        {query && show('pieces') && <div class="sr-group">
          <div class="sr-label">{nothing ? t('notHereYet', { q: query }) : t('moreWaysToGetIt')}</div>
          <button type="button" class="sr-cta" id="cta-request" onClick={() => openSheet('compose', { type: 'request', title: isLink(query) ? '' : query, link: isLink(query) ? query : '' })}>
            <span class="hm-art sm" style={{ background: 'var(--brand)', color: '#fff' }}><Icon name="stage" size={21} stroke={2.2} /></span>
            <div><strong>{t('askStage')}</strong><span>{t('askStageSub')}</span></div><Icon name="chevronR" size={16} stroke={2.4} /></button>
          <button type="button" class="sr-cta" id="cta-web" onClick={() => openSheet('finder', { query })}>
            <span class="hm-art sm"><Icon name="globe" size={21} stroke={2.1} /></span>
            <div><strong>{t('findOnWeb')}</strong><span>{t('findOnWebSub')}</span></div><Icon name="chevronR" size={16} stroke={2.4} /></button>
          <button type="button" class="sr-cta" onClick={() => pageRef.current?.click()}>
            <span class="hm-art sm"><Icon name="camera" size={21} stroke={2.1} /></span>
            <div><strong>{t('haveThePage')}</strong><span>{t('haveThePageSub')}</span></div><Icon name="chevronR" size={16} stroke={2.4} /></button>
        </div>}
      </div>
    </div>
  );
}

/** Classes, people, Sounds and posts that match (the server's /c/find), filtered by the type chip above. */
function FindMore({ more, type }) {
  const groups = [['classes', fromClass, 'findClasses'], ['people', fromPerson, 'findPeople'], ['sounds', fromSound, 'findSounds'], ['posts', fromPost, 'findPosts']]
    .filter(([k]) => more[k]?.length && (!type || type === k));
  if (!groups.length) return null;
  const open = (it) => (it.type === 'class' ? push('classView', { id: it.id }, 'academy') : it.type === 'person' ? push('profile', { handle: it.id }, 'community')
    : it.type === 'sound' ? push('soundPage', { id: it.id }, 'community') : push('post', { id: it.id }, 'community'));
  return (
    <div id="find-more">
      {groups.map(([k, model, l]) => (
        <div class="sr-group" key={k} id={`find-${k}`}><div class="sr-label">{t(l)}</div>
          {more[k].map(model).map((it, i) => <ResultRow key={it.id} id={i === 0 ? `find-${k}-first` : undefined} title={it.title} sub={it.sub}
            cover={<Cover title={it.title} genre={it.genre} size="sm" icon={it.icon} />} onClick={() => open(it)} />)}</div>))}
    </div>
  );
}

export function NewSongsView({ active }) {
  const [catalog, setCatalog] = useState(null);
  const [h, setH] = useState(null);
  useEffect(() => { loadCatalog().then(setCatalog); if (hasServer()) call('/c/homescreen').then(setH).catch(() => setH(null)); }, [active]);
  const newest = useMemo(() => newInLibrary(catalog, 12), [catalog]);
  return (
    <div class="scroll" id="new-songs">
      <NavBar title={t('newSongs')} backLabel={t('back')} color="violet" />
      <div class="wrap">
        <div class="sr-group"><div class="sr-label">{t('newInLibrary')}</div>
          {!catalog ? <div class="skeleton-rows"><i /><i /><i /></div> : newest.map((r, i) => <ResultRow key={r.id} id={i === 0 ? 'new-first' : undefined} title={r.title}
            sub={[r.composer, t(`genre_${r.genre}`)].filter(Boolean).join(' · ')} act={t('getIt')} cover={<Cover title={r.title} instrument={r.instrument} genre={r.genre} size="sm" />}
            onClick={() => openCatalogEntry(r)} />)}</div>
        {h?.new.fulfilled.length > 0 && <div class="sr-group"><div class="sr-label">{t('newFulfilled')}</div>
          {h.new.fulfilled.map((x) => <ResultRow key={x.id} title={x.title} sub={[x.artist, x.mine ? t('yourRequest') : ''].filter(Boolean).join(' · ')} act={t('view')}
            cover={<Cover title={x.title} size="sm" icon="check" />} onClick={() => push('post', { id: x.id }, 'community')} />)}</div>}
        {h?.new.sounds.length > 0 && <div class="sr-group"><div class="sr-label">{t('newFriendSounds')}</div>
          {h.new.sounds.map((x) => <ResultRow key={x.id} title={x.title} sub={`${x.by} · ${x.seconds}s`} act={t('listen')}
            cover={<Cover title={x.title} genre="sound" size="sm" icon="wave" />} onClick={() => push('soundPage', { id: x.id }, 'community')} />)}</div>}
        {h?.new.scores.length > 0 && <div class="sr-group"><div class="sr-label">{t('newOnStage')}</div>
          {h.new.scores.map((x) => <ResultRow key={x.id} title={x.title} sub={[x.artist, x.by].filter(Boolean).join(' · ')} act={t('view')}
            cover={<Cover title={x.title} size="sm" icon="staff" />} onClick={() => push('post', { id: x.id }, 'community')} />)}</div>}
        {catalog && !newest.length && <Empty icon="library" title={t('dashNoData')} />}
      </div>
    </div>
  );
}

/** The newest collections' pieces (index.json "sources", last added first), a stable pick for the day. */
export function newInLibrary(catalog, n = 6) {
  if (!catalog) return [];
  const keys = catalogSources().slice().reverse().map((x) => x.key).filter((k) => !['tunebooks', 'bach', 'lieder'].includes(k));
  const day = Math.floor(Date.now() / 86400000);
  const out = [];
  for (const k of keys) {
    const rows = catalog.filter((r) => String(r.id).startsWith(`${k}-`));
    for (let i = 0; i < rows.length && out.length < n; i += Math.max(1, Math.floor(rows.length / n))) out.push(rows[(i + day * 7) % rows.length]);
    if (out.length >= n) break;
  }
  return out.length ? out : catalog.slice(-n);
}
