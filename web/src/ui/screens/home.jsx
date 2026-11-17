// Home: where you left off, then New songs · Find songs · Create, filter chips that re-sort every shelf, the Learn
// and Stage band, practice shelves with Play all, and More tools folded at the bottom (docs/ui-research.md).
// Files can still be dropped or pasted anywhere on Home.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp, push, go, openSheet, streakDays, toast, setState } from '../state.js';
import { Cover } from '../cover.jsx';
import { openCatalogEntry, newInLibrary } from './find.jsx';
import { track } from '../analytics.js';
import { chipScore, sortBy } from '../../core/shelves.js';
import { t, getLang } from '../../core/i18n.js';
import { Icon, Chip } from '../components.jsx';
import { Avatar, LargeTitle, dateLabel } from './common.jsx';
import { MoreTools } from './moretools.jsx';
import { tick } from '../native.js';
import { hasServer, call } from '../api.js';
import { loadCatalog, searchCatalog, norm } from '../catalog.js';
import { openFiles } from '../intake.js';

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


// ---------------------------------------------------------------- Home (Part 2 A)
// Spotify's "pick up where you left off", then three hero tiles (New songs · Find songs · Create), YouTube Music
// style filter chips that re-sort every shelf, a Learn & Stage band, dense 3x2 practice shelves with Play all,
// and More tools folded at the bottom. The mini-player (app.jsx) sits above the tab bar on every tab.
const HOME_CHIPS = ['mine', 'beginner', 'hymn', 'classical', 'pop', 'exam', 'five'];

function greetingKey(d = new Date()) {
  const h = d.getHours();
  return h < 5 ? 'greetNight' : h < 12 ? 'greetMorning' : h < 18 ? 'greetAfternoon' : 'greetEvening';
}

function Shelf({ id, title, items, onPlayAll, more }) {
  if (!items.length) return null;
  return (
    <section class="pshelf" id={id}>
      <div class="shelf-head"><h2>{title}</h2>
        <div class="shelf-acts">{onPlayAll && <button type="button" class="pill-btn" onClick={onPlayAll} id={`${id}-play`}><Icon name="play" size={13} fill /> {t('playAll')}</button>}
          {more && <button type="button" class="pill-btn ghost" onClick={more}>{t('more')}</button>}</div></div>
      <div class="shelf-grid">{items.slice(0, 6).map((x) => (
        <button type="button" class="shelf-item" key={x.key} onClick={x.open} id={x.domId}>
          <Cover title={x.title} instrument={x.instrument} genre={x.genre} keyText={x.keyText} badge={x.badge} icon={x.icon} />
          <span class="si-t"><strong>{x.title}</strong><span>{x.sub}</span></span>
        </button>))}</div>
    </section>
  );
}

export function HomeView({ active }) {
  const s = useApp();
  const lang = getLang();
  const [catalog, setCatalog] = useState(null);
  const [h, setH] = useState(null);                     // /c/homescreen
  const [chip, setChip] = useState(() => s.homeChip || '');
  const pageRef = useRef(null);
  const online = hasServer();
  const myInst = s.settings.instrument || '';
  // the free library's index (130 KB) is fetched once Home is on screen, so it never delays the first frame
  useEffect(() => {
    const idle = globalThis.requestIdleCallback || ((f) => setTimeout(f, 300));
    idle(() => loadCatalog().then(setCatalog), { timeout: 1500 });
  }, [lang]);
  useEffect(() => { if (s.homeQuery) { setState({ homeQuery: '' }); push('find', { q: s.homeQuery }); } }, [s.homeQuery]);
  useEffect(() => {
    if (!active || !online) return undefined;
    let alive = true;
    const load = () => call('/c/homescreen').then((r) => alive && setH(r)).catch(() => {});
    load();
    const timer = setInterval(load, 120000);
    return () => { alive = false; clearInterval(timer); };
  }, [active]);
  const [drag, setDrag] = useState(false);
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
  const pick = (c) => { tick(); const v = chip === c ? '' : c; setChip(v); setState({ homeChip: v }); track('screen_view', { screen: 'home_chip', label: v || 'none' }); };

  const streak = Math.max(streakDays(), s.me?.streak || 0);
  const name = (s.me?.name && s.me.name !== 'Musician' ? s.me.name : s.settings.name || '').trim().split(/\s+/)[0] || '';
  const greet = t(greetingKey(), { name: name ? `, ${name}` : '' });
  const scores = useMemo(() => [...s.pieces].filter((p) => p.kind === 'score' || p.kind === 'sheet').sort((a, b) => (b.opened || b.created || 0) - (a.opened || a.created || 0)), [s.pieces]);
  const last = scores.find((p) => p.opened) || null;
  const lvl = Math.min(4, Math.max(1, Math.round((scores.reduce((m, p) => m + (p.level || 0), 0) / Math.max(1, scores.filter((p) => p.level).length)) || 1)));

  const pieceItem = (p) => ({ key: p.id, title: p.title, instrument: p.instrument, genre: (p.tags || [])[0], keyText: p.keyText, level: p.level, measures: p.measures,
    sub: p.best != null ? `${t('rightNotes')}: ${p.best}%` : (p.composer || p.keyText || ''), open: () => push('piece', { id: p.id }, 'library'), play: () => push('piece', { id: p.id, start: 'playAlong' }, 'library') });
  const catItem = (r, domId) => ({ key: r.id, domId, title: r.title, instrument: r.instrument, genre: r.genre, level: r.level, badge: r.level ? '●'.repeat(r.level) : null,
    sub: [r.composer, t(`genre_${r.genre}`)].filter(Boolean).join(' · '), open: () => openCatalogEntry(r), play: () => openCatalogEntry(r, 'playAlong') });
  const again = useMemo(() => sortBy(scores.slice(0, 12).map(pieceItem), chip, myInst), [scores, chip]);
  const recommended = useMemo(() => {
    if (!catalog) return [];
    const day = Math.floor(Date.now() / 86400000);
    let rows = catalog.filter((r) => r.level && r.level <= lvl + 1 && !s.pieces.some((p) => p.catalogId === r.id));
    const inst = rows.filter((r) => r.instrument === myInst);
    if (inst.length >= 6) rows = inst;
    const picked = [];
    for (let i = 0; i < 24 && rows.length; i++) picked.push(rows[(day * 31 + i * 97) % rows.length]);
    return sortBy([...new Map(picked.map((r) => [r.id, r])).values()].map((r) => catItem(r)), chip, myInst);
  }, [catalog, chip, lvl, myInst, s.pieces]);
  const classPieces = useMemo(() => {
    if (!h?.class_pieces?.length) return [];
    return h.class_pieces.map((title) => {
      const lib = s.pieces.find((p) => norm(p.title) === norm(title));
      if (lib) return pieceItem(lib);
      const r = catalog && searchCatalog(catalog, title, { limit: 1 })[0];
      return r ? catItem(r) : { key: title, title, sub: t('assignmentPiece'), icon: 'flag', open: () => go('academy') };
    });
  }, [h, catalog, s.pieces]);
  const trending = useMemo(() => sortBy((h?.trending || []).map((p) => ({ key: p.id, title: p.title, instrument: p.instrument, kind: p.kind, icon: p.kind === 'request' ? 'flag' : 'staff',
    sub: p.kind === 'request' ? t('requestedBy', { n: p.wants || 1 }) : [p.artist, p.author?.name].filter(Boolean).join(' · '), open: () => push('post', { id: p.id }, 'community') })), chip, myInst), [h, chip]);
  const fresh = useMemo(() => sortBy(newInLibrary(catalog, 12).map((r, i) => catItem(r, i === 0 ? 'shelf-new-first' : undefined)), chip, myInst), [catalog, chip]);
  const playFirst = (items) => () => { tick(); const x = items[0]; if (!x) return; if (x.play) x.play(); else x.open(); };

  const L = h?.learn, ST = h?.stage;
  const hero = (id, color, icon, title, sub, onGo) => (
    <button type="button" class={`hero-tile c-${color}`} id={`hero-${id}`} onClick={() => { tick(); onGo(); }}>
      <span class="ic"><Icon name={icon} size={26} stroke={2.2} /></span><strong>{t(title)}</strong><span>{t(sub)}</span>
    </button>
  );
  return (
    <div class="scroll" id="home">
      <div class="wrap">
        <input ref={pageRef} type="file" class="hidden-input" accept=".pdf,application/pdf,image/*" multiple onChange={(e) => { const f = [...(e.currentTarget.files || [])]; e.currentTarget.value = ''; openFiles(f); }} aria-label={t('wayScan')} />
        <LargeTitle title={greet} eyebrow={dateLabel(lang)} color="violet" actions={<>
          {streak > 0 && <span class="hm-pill flame" title={t('streak')} id="home-streak"><Icon name="flame" size={15} fill stroke={1.6} />{streak}</span>}
          {online && <button type="button" class="hm-pill" onClick={() => push('notifications', {}, 'me')} aria-label={t('notifications')} style={{ position: 'relative', padding: '0 9px' }}>
            <Icon name="bell" size={17} />{s.me?.unread > 0 && <span class="tab-dot" />}</button>}
          <span class="ph-only"><Avatar /></span>
        </>} />

        {last && <button type="button" class="resume-card" id="home-continue" onClick={() => { tick(); push('piece', { id: last.id, ...(last.lastBar > 1 ? { bar: last.lastBar } : {}) }, 'library'); }}>
          <Cover title={last.title} instrument={last.instrument} keyText={last.keyText} size="sm" />
          <span class="cc-t"><span class="cc-k">{t('continueK')}</span><strong>{last.title}</strong><span>{last.lastBar > 1 ? t('atBar', { n: last.lastBar }) : (last.composer || last.keyText || '')}</span></span>
          <span class="cc-play" role="presentation"><Icon name="play" size={20} fill /></span>
        </button>}

        <div class="hero-row" id="home-hero">
          {hero('new', 'violet', 'sparkles', 'heroNew', 'heroNewSub', () => push('newSongs'))}
          {hero('find', 'blue', 'search', 'heroFind', 'heroFindSub', () => push('find'))}
          {hero('create', 'teal', 'pencil', 'heroCreate', 'heroCreateSub', () => openSheet('newSong', { quick: true }))}
        </div>

        <div class="chips home-chips" id="home-chips" role="toolbar" aria-label={t('filter')}>
          {HOME_CHIPS.map((c) => <Chip key={c} on={chip === c} onClick={() => pick(c)} id={`chip-${c}`}>{c === 'mine' && myInst && t(`inst_${myInst}`) !== `inst_${myInst}` ? t(`inst_${myInst}`) : t(`hc_${c}`)}</Chip>)}
        </div>

        <div class="band" id="home-band">
          <button type="button" class="band-card c-orange" id="band-learn" onClick={() => { tick(); go('academy'); }}>
            <span class="bc-h"><Icon name="academy" size={18} stroke={2.3} />{t('hub')}</span>
            {!online ? <span class="bc-l">{t('bandOffline')}</span>
              : L?.teacher ? <><strong>{t('takesToReview', { n: L.teacher.to_review })}</strong><span class="bc-l">{L.teacher.inactive ? t('quietStudents', { n: L.teacher.inactive }) : t('allPractised')}</span></>
                : L?.next_assignment ? <><strong>{L.next_assignment.title}</strong><span class="bc-l">{L.next_assignment.class} · {t('dueOn', { d: dueLabel(L.next_assignment.due, lang) })}</span></>
                  : <><strong>{L?.classes ? t('nothingDue') : t('joinAClass')}</strong><span class="bc-l">{L?.classes ? t('classesN', { n: L.classes }) : t('joinAClassSub')}</span></>}
            {L?.next_lesson && <span class="bc-l bc-lesson"><Icon name="calendar" size={13} /> {L.next_lesson.title} · {dueLabel(L.next_lesson.start, lang)}</span>}
            {L?.class_posts_week > 0 && <span class="bc-badge">{t('classPostsN', { n: L.class_posts_week })}</span>}
          </button>
          <button type="button" class="band-card c-pink" id="band-stage" onClick={() => { tick(); go('community'); }}>
            <span class="bc-h"><Icon name="stage" size={18} stroke={2.3} />{t('stage')}</span>
            {ST?.daily ? <><strong>{t('todaysChallenge')}: {ST.daily.title}</strong><span class="bc-l">{ST.daily.mine != null ? t('youScored', { n: Math.round(ST.daily.mine * 100) }) : t('playersN', { n: ST.daily.players })}</span></>
              : <strong>{t('stageRowSub')}</strong>}
            {ST && <span class="bc-l">{[ST.friends_new ? t('friendsNewN', { n: ST.friends_new }) : '', ST.requests_for_you ? t('reqForYouN', { n: ST.requests_for_you }) : t('openReqN', { n: ST.open_requests })].filter(Boolean).join(' · ')}</span>}
          </button>
        </div>

        <Shelf id="shelf-again" title={t('shelfAgain')} items={again} onPlayAll={playFirst(again)} more={() => go('library')} />
        <Shelf id="shelf-level" title={t('shelfLevel')} items={recommended} onPlayAll={playFirst(recommended)} more={() => push('find')} />
        <Shelf id="shelf-class" title={t('shelfClass')} items={classPieces} onPlayAll={playFirst(classPieces)} />
        <Shelf id="shelf-trending" title={t('shelfTrending')} items={trending} more={() => go('community')} />
        <Shelf id="shelf-new" title={t('shelfNew')} items={fresh} onPlayAll={playFirst(fresh)} more={() => push('newSongs')} />
        {!catalog && <div class="shelf-skeleton"><i /><i /><i /><i /><i /><i /></div>}

        <MoreTools scan={() => pageRef.current?.click()} />
      </div>
      {drag && <div class="dropzone"><div><Icon name="upload" size={44} stroke={2} />{t('dropHere')}<small>{t('dropHereSub')}</small></div></div>}
    </div>
  );
}
