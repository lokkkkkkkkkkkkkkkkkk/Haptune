// Home: the fastest way to a sheet and to practising it. A search box (a song name, a composer or a link), then
// exactly three things: Practice, Learn, Create; a smaller Stage row; where you left off; and every other tool
// folded under More tools. Files can still be dropped or pasted anywhere.
// Results come from your library, the free library and Stage at once; when nothing fits, one tap asks
// the web (AI) or the community for it.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp, push, go, openSheet, streakDays, toast, setState } from '../state.js';
import { t, getLang } from '../../core/i18n.js';
import { Section, Icon, List, Row } from '../components.jsx';
import { Avatar, LargeTitle, dateLabel } from './common.jsx';
import { MoreTools } from './moretools.jsx';
import { tick } from '../native.js';
import { local } from '../storage.js';
import { hasServer, academyMe, isLink } from '../api.js';
import { C } from '../account.js';
import { loadCatalog, searchCatalog, addCatalogPiece, norm } from '../catalog.js';
import { openFiles } from '../intake.js';
import { ACCEPT } from '../importer.js';

export function dueLabel(iso, lang) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const days = Math.round((d - new Date()) / 86400000);
    const opts = days > -7 && days < 7 ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { day: 'numeric', month: 'short' };
    return d.toLocaleString(lang, opts);
  } catch { return iso.slice(0, 10); }
}

const GLYPH = { classical: '𝄞', piano: '𝄢', folk: '♪', song: '♫', hymn: '♩', kids: '♬', christmas: '❄', jazz: '♭', chinese: '♪', celtic: '♫', choral: '𝄐', dance: '♬', chamber: '𝄡' };
const TINT = { classical: 'violet', piano: 'indigo', folk: 'green', song: 'pink', hymn: 'teal', kids: 'orange', christmas: 'red', jazz: 'purple', chinese: 'red', celtic: 'green', choral: 'blue', dance: 'orange', chamber: 'brown' };

/** A score as a small cover: used on the shelves of Home, Library and Stage. */
export function ScoreCard({ title, by, genre = 'song', tag, heat, onClick }) {
  return (
    <button type="button" class={`score-card c-${TINT[genre] || 'violet'}`} onClick={onClick}>
      <span class="cover">
        <span class="lines" /><span class="glyph" aria-hidden="true">{GLYPH[genre] || '♪'}</span>
        {heat ? <span class="heat"><Icon name="flame" size={12} fill stroke={1.5} />{heat}</span> : null}
        {tag && <span class="tag">{tag}</span>}
      </span>
      <strong>{title}</strong>
      {by && <span class="by">{by}</span>}
    </button>
  );
}

async function openCatalog(entry) {
  try {
    const rec = await addCatalogPiece(entry);
    if (rec) push('piece', { id: rec.id }, 'library');
  } catch (e) { toast(e.message || String(e), 'err'); }
}


export function HomeView({ active }) {
  const s = useApp();
  const lang = getLang();
  const [q, setQ] = useState('');
  const [catalog, setCatalog] = useState(null);
  const [stage, setStage] = useState(null);         // matches on Stage for the text being typed
  const [pulse, setPulse] = useState(null);         // who is online, what is trending
  const [todo, setTodo] = useState(null);
  const [drag, setDrag] = useState(false);
  const pageRef = useRef(null), fileRef = useRef(null), camRef = useRef(null);
  const online = hasServer();
  const query = q.trim();

  useEffect(() => { loadCatalog().then(setCatalog); }, [lang]);
  // a song typed on the website's front page arrives here
  useEffect(() => { if (s.homeQuery) { setQ(s.homeQuery); setState({ homeQuery: '' }); } }, [s.homeQuery]);
  useEffect(() => {
    if (!active || !online) return undefined;
    let alive = true;
    const load = () => C.pulse().then((r) => alive && setPulse(r)).catch(() => {});
    load();
    const timer = setInterval(load, 60000);
    if (local.get('academyToken', '')) academyMe(s.settings.name).then((r) => alive && setTodo(r.todo || [])).catch(() => {});
    return () => { alive = false; clearInterval(timer); };
  }, [active]);

  // Stage is searched a moment after typing stops
  useEffect(() => {
    setStage(null);
    if (!online || query.length < 2 || isLink(query)) return undefined;
    const timer = setTimeout(() => {
      C.search(query).then(setStage).catch(() => setStage({ scores: [], requests: [] }));
    }, 380);
    return () => clearTimeout(timer);
  }, [query]);

  // files dropped anywhere on the window (computers) or pasted (a screenshot of a page)
  useEffect(() => {
    if (!active) return undefined;
    let depth = 0;
    const has = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const enter = (e) => { if (has(e)) { depth++; setDrag(true); e.preventDefault(); } };
    const over = (e) => { if (has(e)) e.preventDefault(); };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDrag(false); };
    const drop = (e) => { if (!has(e)) return; e.preventDefault(); depth = 0; setDrag(false); openFiles(e.dataTransfer.files); };
    const paste = (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length && !/input|textarea/i.test(e.target?.tagName || '')) { e.preventDefault(); openFiles(files); } };
    addEventListener('dragenter', enter); addEventListener('dragover', over); addEventListener('dragleave', leave); addEventListener('drop', drop); addEventListener('paste', paste);
    return () => { removeEventListener('dragenter', enter); removeEventListener('dragover', over); removeEventListener('dragleave', leave); removeEventListener('drop', drop); removeEventListener('paste', paste); };
  }, [active]);

  const mine = useMemo(() => {
    if (!query) return [];
    const words = norm(query).split(' ').filter(Boolean);
    return s.pieces.filter((p) => { const k = norm(`${p.title} ${p.composer}`); return words.every((w) => k.includes(w)); }).slice(0, 5);
  }, [query, s.pieces]);
  const free = useMemo(() => (catalog && query ? searchCatalog(catalog, query, { limit: 8 }).filter((r) => !mine.some((p) => p.catalogId === r.id || (r.songId && p.songId === r.songId))) : []), [catalog, query, mine]);
  const onPick = (e) => { const files = [...(e.currentTarget.files || [])]; e.currentTarget.value = ''; openFiles(files); };
  const submit = (e) => {
    e?.preventDefault();
    if (!query) return;
    if (isLink(query)) openSheet('finder', { query });           // a YouTube / Spotify link: straight to the finder
  };
  const streak = Math.max(streakDays(), s.me?.streak || 0);
  const name = (s.me?.name && s.me.name !== 'Musician' ? s.me.name : s.settings.name || '').trim().split(/\s+/)[0] || '';
  const tier = s.me?.tier || 'free';
  const nothing = query && !mine.length && !free.length && stage && !stage.scores.length && !stage.requests.length;

  const greet = name ? t('homeHelloName', { name }) : t('homeHello');
  const recents = [...s.pieces].filter((p) => p.kind === 'score').sort((a, b) => (b.opened || b.created || 0) - (a.opened || a.created || 0)).slice(0, 3);
  const tile = (id, color, icon, title, sub, onGo) => (
    <button type="button" class={`home-tile c-${color}`} id={`tile-${id}`} onClick={() => { tick(); onGo(); }}>
      <span class="ic"><Icon name={icon} size={24} stroke={2.2} /></span>
      <strong>{t(title)}</strong><span>{t(sub)}</span>
    </button>
  );

  return (
    <div class="scroll" id="home">
      <div class="wrap">
        <input ref={pageRef} type="file" class="hidden-input" accept=".pdf,application/pdf,image/*" multiple onChange={onPick} id="home-pages" aria-label={t('wayScan')} />
        <input ref={camRef} type="file" class="hidden-input" accept="image/*" capture="environment" multiple onChange={onPick} aria-label={t('wayCamera')} />
        <input ref={fileRef} type="file" class="hidden-input" accept={ACCEPT} onChange={onPick} id="home-file" aria-label={t('wayFile')} />
        <LargeTitle title={greet} eyebrow={dateLabel(lang)} color="violet" actions={<>
          {streak > 0 && <span class="hm-pill flame" title={t('streak')}><Icon name="flame" size={15} fill stroke={1.6} />{streak}</span>}
          {online && <button type="button" class="hm-pill" onClick={() => push('notifications', {}, 'me')} aria-label={t('notifications')} style={{ position: 'relative', padding: '0 9px' }}>
            <Icon name="bell" size={17} />{s.me?.unread > 0 && <span class="tab-dot" />}</button>}
          <span class="ph-only"><Avatar /></span>
        </>} />
        <form class="ios-search" onSubmit={submit} role="search">
          <Icon name="search" size={17} stroke={2.4} />
          <input id="home-search" type="search" enterkeyhint="search" autocomplete="off" placeholder={t('homeSearchPh')} value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label={t('homeSearchPh')} />
          {q && <button type="button" class="ios-cancel" onClick={() => setQ('')}>{t('cancel')}</button>}
        </form>

        {query ? (
          <div class="section fade-up" id="results">
            {mine.length > 0 && (
              <div class="sr-group">
                <div class="sr-label">{t('inYourLibrary')}</div>
                {mine.map((p) => (
                  <button type="button" class="sr-item" key={p.id} onClick={() => push('piece', { id: p.id }, 'library')}>
                    <span class="hm-art sm"><Icon name="library" size={20} stroke={2.2} /></span>
                    <span class="t"><strong>{p.title}</strong><span>{[p.composer, p.keyText].filter(Boolean).join(' · ')}</span></span>
                    <span class="act">{t('openIt')}</span>
                  </button>
                ))}
              </div>
            )}
            {free.length > 0 && (
              <div class="sr-group">
                <div class="sr-label">{t('freeLibrary')}</div>
                {free.map((r) => (
                  <button type="button" class="sr-item" key={r.id} onClick={() => openCatalog(r)}>
                    <span class={`hm-art sm c-${TINT[r.genre] || 'violet'}`} style={{ color: 'var(--c)' }}><span style={{ font: '400 24px/1 serif' }}>{GLYPH[r.genre] || '♪'}</span></span>
                    <span class="t"><strong>{r.title}</strong><span>{[r.composer, t(`genre_${r.genre}`)].filter(Boolean).join(' · ')}</span></span>
                    <span class="act">{t('getIt')}</span>
                  </button>
                ))}
              </div>
            )}
            {stage && (stage.scores.length > 0 || stage.requests.length > 0) && (
              <div class="sr-group">
                <div class="sr-label"><Icon name="stage" size={14} stroke={2.4} />{t('onStage')}</div>
                {stage.scores.map((p) => (
                  <button type="button" class="sr-item" key={p.id} onClick={() => push('post', { id: p.id }, 'community')}>
                    <span class="hm-art sm"><Icon name="staff" size={20} stroke={2.1} /></span>
                    <span class="t"><strong>{p.title}</strong><span>{[p.artist, p.author?.name].filter(Boolean).join(' · ')}</span></span>
                    <span class="act">{t('view')}</span>
                  </button>
                ))}
                {stage.requests.map((p) => (
                  <button type="button" class="sr-item" key={p.id} onClick={() => push('post', { id: p.id }, 'community')}>
                    <span class="hm-art sm c-pink" style={{ color: 'var(--coral)' }}><Icon name="flag" size={20} stroke={2.1} /></span>
                    <span class="t"><strong>{p.title}</strong><span>{t('requestedBy', { n: p.wants || 1 })}{p.status === 'claimed' ? ` · ${t('beingMade')}` : ''}</span></span>
                    <span class="act">{t('wantToo')}</span>
                  </button>
                ))}
              </div>
            )}
            {online && !stage && query.length >= 2 && !isLink(query) && <div class="loading" style={{ padding: 8 }}><div class="spinner small" /></div>}
            <div class="sr-group">
              <div class="sr-label">{nothing ? t('notHereYet', { q: query }) : t('moreWaysToGetIt')}</div>
              <button type="button" class="sr-cta" id="cta-request" onClick={() => openSheet('compose', { type: 'request', title: isLink(query) ? '' : query, link: isLink(query) ? query : '' })}>
                <span class="hm-art sm" style={{ background: 'var(--brand)', color: '#fff' }}><Icon name="stage" size={21} stroke={2.2} /></span>
                <div><strong>{t('askStage')}</strong><span>{t('askStageSub')}</span></div>
                <Icon name="chevronR" size={16} stroke={2.4} />
              </button>
              <button type="button" class="sr-cta" id="cta-web" onClick={() => openSheet('finder', { query })}>
                <span class="hm-art sm"><Icon name="globe" size={21} stroke={2.1} /></span>
                <div><strong>{t('findOnWeb')} {tier === 'free' && <span class="pro-tag plus">Plus</span>}</strong><span>{t('findOnWebSub')}</span></div>
                <Icon name="chevronR" size={16} stroke={2.4} />
              </button>
              <button type="button" class="sr-cta" onClick={() => pageRef.current?.click()}>
                <span class="hm-art sm"><Icon name="camera" size={21} stroke={2.1} /></span>
                <div><strong>{t('haveThePage')} {tier !== 'pro' && tier !== 'dev' && <span class="pro-tag">Pro</span>}</strong><span>{t('haveThePageSub')}</span></div>
                <Icon name="chevronR" size={16} stroke={2.4} />
              </button>
            </div>
          </div>
        ) : (
          <>
            <div class="home-tiles fade-up" id="home-tiles">
              {tile('practice', 'violet', 'mic', 'tilePractice', 'tilePracticeSub', () => push('practice'))}
              {tile('learn', 'orange', 'academy', 'tileLearn', 'tileLearnSub', () => go('academy'))}
              {tile('create', 'teal', 'pencil', 'tileCreate', 'tileCreateSub', () => go('write'))}
            </div>
            <List>
              <Row id="home-stage" icon="stage" color="pink" title={t('stageRow')} subtitle={t('stageRowSub')}
                detail={pulse ? <span class="live-n"><span class="live-dot" />{pulse.online}</span> : null} onClick={() => { tick(); go('community'); }} />
            </List>

            <Section title={t('continueWhere')}>
              <List>
                {recents.map((p, i) => (
                  <Row key={p.id} icon="library" color="blue" title={p.title}
                    subtitle={p.best !== null && p.best !== undefined ? `${t('rightNotes')}: ${p.best}%` : p.composer || p.keyText || ''}
                    onClick={() => push('piece', { id: p.id }, 'library')} chevron={false}
                    right={<button type="button" class="row-play" id={i === 0 ? 'home-continue' : undefined} aria-label={t('playAlong')}
                      onClick={(e) => { e.stopPropagation(); tick(); push('piece', { id: p.id, start: 'playAlong' }, 'library'); }}><Icon name="mic" size={18} stroke={2.4} /></button>} />
                ))}
                {todo && todo.slice(0, 2).map((a) => (
                  <Row key={a.id} icon="flag" color={a.status === 'due-soon' || a.status === 'late' ? 'orange' : 'violet'} title={a.title}
                    subtitle={`${a.class_name} · ${a.status === 'upcoming' ? t('opensOn', { d: dueLabel(a.opens_at, lang) }) : t('dueOn', { d: dueLabel(a.due_at, lang) })}`}
                    onClick={() => push('assignment', { id: a.id }, 'academy')} />
                ))}
                {!recents.length && !(todo && todo.length) && <Row icon="info" color="gray" title={t('continueEmpty')} />}
              </List>
            </Section>

            <MoreTools scan={() => pageRef.current?.click()} />
          </>
        )}
      </div>
      {drag && <div class="dropzone"><div><Icon name="upload" size={44} stroke={2} />{t('dropHere')}<small>{t('dropHereSub')}</small></div></div>}
    </div>
  );
}


