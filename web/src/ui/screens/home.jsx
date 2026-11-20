// Summary (the first tab): like Apple Health's Summary, one look at everything. 
// New songs · Find songs · Create, then a tile for each part of Haptune (practice, accuracy, Learn, Stage, Create,
// Library, level, Google), each one tap from its screen; below them the music shelves and More tools.
// Files can still be dropped or pasted anywhere on this page.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp, push, go, openSheet, streakDays, minutesOn, setState } from '../state.js';
import { Rings, MiniBars, MiniLine } from '../components.jsx';
import { levelFor } from '../../core/academy.js';
import { local } from '../storage.js';
import { Mascot } from '../mascot.jsx';
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
import { startCoach, coachDone } from '../coach.jsx';

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

/** One pinned tile (Health style): the colour and name on top, a big number or "No data", a small chart. */
function SumTile({ id, color, icon, title, value, unit, foot, chart, onClick }) {
  const none = value === null || value === undefined || value === '';
  return (
    <button type="button" class={`sum-tile c-${color}${none ? ' none' : ''}`} id={id} onClick={() => { tick(); onClick(); }}>
      <span class="st-head"><Icon name={icon} size={15} stroke={2.4} /><span class="st-t">{title}</span><Icon name="chevronR" size={13} /></span>
      <span class="st-body">
        <span class="st-v">{none ? <span class="st-none">{t('noDataT')}</span> : <span class="st-num"><span class="num">{value}</span>{unit && <small>{unit}</small>}</span>}
          {foot && <span class="st-f">{foot}</span>}</span>
        {!none && chart}
      </span>
    </button>
  );
}

const DEFAULT_PINS = ['time', 'acc', 'learn', 'stage', 'library', 'create'];

/** Short reads, each opening its part of Help (Health's "Articles"). */
const ARTICLES = [
  { id: 'slow', topic: 'playing' }, { id: 'mic', topic: 'playing' }, { id: 'read', topic: 'start' }, { id: 'teach', topic: 'community' },
];

/** Drawn covers for the articles (no photos to download): bands of colour with notes and staff lines. */
function ArtCover({ kind }) {
  const C = {
    slow: ['#FDE68A', '#F59E0B', '#B45309', '#78350F'],
    mic: ['#C7D2FE', '#818CF8', '#4F46E5', '#312E81'],
    read: ['#BBF7D0', '#4ADE80', '#16A34A', '#14532D'],
    teach: ['#FBCFE8', '#F472B6', '#DB2777', '#831843'],
  }[kind] || ['#E5E7EB', '#9CA3AF', '#4B5563', '#111827'];
  return (
    <svg class="art-cover" viewBox="0 0 320 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="320" height="150" fill={C[0]} />
      {kind === 'slow' && [0, 1, 2, 3].map((i) => <path key={i} d={`M${-20 + i * 30} 150 C ${60 + i * 30} ${70 - i * 12}, ${160 + i * 20} ${120 - i * 18}, 340 ${40 + i * 18} L340 150Z`} fill={C[i]} opacity={0.55 + i * 0.15} />)}
      {kind === 'mic' && [0, 1, 2, 3].map((i) => <circle key={i} cx="240" cy="75" r={110 - i * 26} fill={C[i]} />)}
      {kind === 'read' && <>{[0, 1, 2, 3, 4].map((i) => <line key={i} x1="0" x2="320" y1={45 + i * 14} y2={45 + i * 14} stroke={C[3]} stroke-width="2" opacity=".5" />)}
        {[[60, 87], [110, 73], [160, 59], [210, 66], [260, 80]].map(([x, y], i) => <g key={i}><ellipse cx={x} cy={y} rx="11" ry="8" transform={`rotate(-20 ${x} ${y})`} fill={C[2 + (i % 2)]} /><rect x={x + 8} y={y - 42} width="3.5" height="42" fill={C[3]} /></g>)}</>}
      {kind === 'teach' && [0, 1, 2].map((i) => <rect key={i} x={40 + i * 85} y={30 + (i % 2) * 22} width="70" height="90" rx="20" fill={C[i + 1]} opacity=".9" />)}
    </svg>
  );
}

const dayKey = (d) => d.toISOString().slice(0, 10);
const lastDays = (n) => Array.from({ length: n }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - (n - 1 - i)); return dayKey(d); });

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
      <span class="ic"><Icon name={icon} size={24} stroke={2.2} /></span><strong>{t(title)}</strong><span>{t(sub)}</span>
    </button>
  );
  // this week, on this device (and the account's streak)
  const week = lastDays(7).map((d) => Math.round(minutesOn(d)));
  const todayMin = week[6];
  const goal = Math.max(5, s.settings.dailyGoal || 15);
  const takes = s.history.filter((x) => x.accuracy !== undefined && x.accuracy !== null).slice(-12);
  const lastTake = takes[takes.length - 1];
  const lv = levelFor(s.progress.xp);
  const mine = s.pieces.filter((p) => p.kind === 'score' && (p.source === 'written' || p.edited));
  const me = s.me;
  const fullName = (me?.name && me.name !== 'Musician' ? me.name : s.settings.name || '').trim();
  const initials = fullName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const [pins, setPins] = useState(() => local.get('homePins', DEFAULT_PINS));
  const [hidden, setHidden] = useState(() => local.get('homeHidden', []));
  const [editing, setEditing] = useState(false);
  // tiles and suggestions slide into place when added or closed (AutoAnimate, 3 KB, MIT)
  const gridRef = useRef(null), gmRef = useRef(null);
  useEffect(() => { import('@formkit/auto-animate').then((m) => { for (const r of [gridRef, gmRef]) if (r.current && !r.current.dataset.aa) { m.default(r.current); r.current.dataset.aa = '1'; } }).catch(() => {}); });
  const togglePin = (id) => { const v = pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id]; setPins(v); local.set('homePins', v); };
  const hide = (id) => { const v = [...hidden, id]; setHidden(v); local.set('homeHidden', v); };

  // the one thing to know now (like Health's status card): sign in, allow Google, review takes, an assignment due
  const status = !online ? null
    : !me?.registered ? { id: 'signin', icon: 'person', title: t('stSignInT'), text: t('stSignInS'), act: t('signIn'), go: () => openSheet('hubRole', {}) }
      : L?.teacher?.to_review ? { id: 'review', icon: 'academy', title: t('takesToReview', { n: L.teacher.to_review }), text: L.teacher.inactive ? t('quietStudents', { n: L.teacher.inactive }) : t('allPractised'), act: t('open'), go: () => go('academy') }
        : L?.next_assignment ? { id: 'due', icon: 'calendar', title: L.next_assignment.title, text: `${L.next_assignment.class} · ${t('dueOn', { d: dueLabel(L.next_assignment.due, lang) })}`, act: t('open'), go: () => go('academy') }
          : me?.google ? null : { id: 'google', icon: 'link', title: t('stGoogleT'), text: t('stGoogleS'), act: t('signInGoogle'), go: () => openSheet('hubRole', {}) };
  const showStatus = status && !hidden.includes(`st-${status.id}`);

  const tiles = {
    time: { color: 'pink', icon: 'flame', title: t('practiceTime'), value: todayMin || null, unit: t('min'), foot: t('goalMin', { n: goal }), chart: week.some(Boolean) ? <MiniBars values={week} color="pink" width={96} height={40} /> : null, go: () => push('history', { metric: 'time' }, 'summary') },
    acc: { color: 'green', icon: 'check', title: t('accuracy'), value: lastTake ? Math.round(lastTake.accuracy * 100) : null, unit: '%', foot: lastTake?.title, chart: takes.length > 1 ? <MiniLine values={takes.map((x) => x.accuracy * 100)} color="green" width={96} height={40} /> : null, go: () => push('history', { metric: 'accuracy' }, 'summary') },
    streak: { color: 'orange', icon: 'flame', title: t('streak'), value: streak || null, unit: t('days'), foot: t('streakFoot'), go: () => push('history', { metric: 'time' }, 'summary') },
    learn: { id: 'band-learn', color: 'orange', icon: 'academy', title: t('hub'), value: !online ? null : L?.teacher ? L.teacher.to_review : (L?.todo ?? (L?.next_assignment ? 1 : 0)), unit: L?.teacher ? t('toReviewShort') : t('toDoShort'),
      foot: !online ? t('bandOffline') : L?.teacher ? t('takesToReview', { n: L.teacher.to_review }) : L?.next_assignment ? L.next_assignment.title : L?.classes ? t('nothingDue') : t('joinAClass'), go: () => go('academy') },
    stage: { id: 'band-stage', color: 'pink', icon: 'stage', title: t('stage'), value: ST?.daily ? (ST.daily.mine != null ? Math.round(ST.daily.mine * 100) : ST.daily.players) : (ST?.open_requests ?? null),
      unit: ST?.daily ? (ST.daily.mine != null ? '%' : t('playersShort')) : t('requestsShort'), foot: ST?.daily ? `${t('todaysChallenge')}: ${ST.daily.title}` : t('stageRowSub'), go: () => go('community') },
    create: { color: 'teal', icon: 'pencil', title: t('create'), value: mine.length || null, unit: t('songsShort'), foot: mine[0]?.title || t('heroCreateSub'), go: () => go('write') },
    library: { color: 'blue', icon: 'library', title: t('library'), value: s.pieces.length || null, unit: t('piecesShort'), foot: catalog ? t('freeLibN', { n: catalog.length.toLocaleString(lang) }) : '', go: () => go('library') },
    level: { color: 'violet', icon: 'star', title: t('levelN', { n: lv.level }), value: s.progress.xp || null, unit: t('xp'), foot: t('xpToNext', { n: Math.max(0, lv.need - lv.into) }), go: () => push('courses', {}, 'summary') },
    google: { color: 'blue', icon: 'link', title: 'Google', value: me?.google ? '✓' : null, unit: '', foot: me?.google ? me.email : t('gNeedSignInShort'), go: () => openSheet('connections') },
  };
  // "Get more from Haptune": the next useful thing for this person, closed for good with ✕
  const more = [
    !coachDone() && { id: 'tour', icon: 'sparkles', grad: ['#7B3FE4', '#E07BF0'], title: t('gmTourT'), text: t('gmTourS'), go: () => startCoach() },
    !me?.registered && online && { id: 'signin', icon: 'person', grad: ['#5B3FD6', '#9C85FF'], title: t('gmSignInT'), text: t('gmSignInS'), go: () => openSheet('hubRole', {}) },
    !takes.length && { id: 'play', icon: 'mic', grad: ['#E2531F', '#FF9C5B'], title: t('guide2T'), text: t('guide2S'), go: () => push('find', {}, 'summary') },
    online && !L?.classes && { id: 'class', icon: 'academy', grad: ['#B0399C', '#F07BD8'], title: me?.hub_role === 'teacher' ? t('guide3tT') : t('guide3T'), text: me?.hub_role === 'teacher' ? t('guide3tS') : t('guide3S'), go: () => go('academy') },
    online && me?.registered && !me?.google && { id: 'google', icon: 'link', grad: ['#1E5BD8', '#5EA8FF'], title: t('stGoogleT'), text: t('stGoogleS'), go: () => openSheet('connections') },
    !mine.length && { id: 'create', icon: 'pencil', grad: ['#0B8C7E', '#3FD3BF'], title: t('gmCreateT'), text: t('gmCreateS'), go: () => openSheet('newSong', { quick: true }) },
    online && { id: 'friends', icon: 'users', grad: ['#0A7FC2', '#5CC8F5'], title: t('gmFriendsT'), text: t('gmFriendsS'), go: () => { go('community'); push('friends', {}, 'community'); } },
  ].filter((x) => x && !hidden.includes(`gm-${x.id}`)).slice(0, 3);

  return (
    <div class="scroll home4" id="home">
      <div class="home-glow" aria-hidden="true" />
      <div class="wrap">
        <input ref={pageRef} type="file" class="hidden-input" accept=".pdf,application/pdf,image/*" multiple onChange={(e) => { const f = [...(e.currentTarget.files || [])]; e.currentTarget.value = ''; openFiles(f); }} aria-label={t('wayScan')} />
        <div class="home-head" id="home-head">
          <div class="hh-who">
            <button type="button" class="hh-avatar" onClick={() => go('me')} aria-label={t('me')}>{initials || <Icon name="person" size={30} />}</button>
            <div class="hh-text">
              <span class="hh-date">{dateLabel(lang)}</span>
              <h1>{t('homeTab')}</h1>
              <button type="button" class="hh-profile" onClick={() => go('me')}>{fullName || t('profileT')} <Icon name="chevronR" size={13} /></button>
              <span class="hh-sub">{greet}{streak > 0 ? ` · ${t('streakN', { n: streak })}` : ''}</span>
            </div>
            <span class="hh-acts">
              <button type="button" class="hh-mini-av ph-only" onClick={() => go('me')} aria-label={t('me')} id="home-me">{initials || <Icon name="person" size={18} />}</button>
              <button type="button" class="hh-menu ph-only" onClick={() => setState({ drawer: true })} aria-label={t('categoriesT')} id="home-menu"><Icon name="sidebar" size={19} /></button>
              {online && <button type="button" class="hm-pill" onClick={() => push('notifications', {}, 'me')} aria-label={t('notifications')} style={{ position: 'relative', padding: '0 9px' }}>
                <Icon name="bell" size={17} />{s.me?.unread > 0 && <span class="tab-dot" />}</button>}
            </span>
          </div>
          {showStatus && (
            <div class="hh-status" id="home-status">
              <div class="hs-top"><span class="hs-k">{t('statusK')}</span><button type="button" class="hs-x" onClick={() => hide(`st-${status.id}`)} aria-label={t('close')}><Icon name="close" size={13} stroke={2.6} /></button></div>
              <strong>{status.title}</strong><span>{status.text}</span>
              <button type="button" class="hs-act" onClick={status.go} id="home-status-act">{status.act}</button>
            </div>
          )}
        </div>

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

        <HapiTip />

        <section class="sum-sec" id="home-band">
          <div class="shelf-head"><h2>{t('pinned')}</h2><button type="button" class="link-btn" onClick={() => setEditing(!editing)} id="pins-edit">{editing ? t('done') : t('edit')}</button></div>
          {editing && (
            <div class="pin-edit" id="pin-edit">{Object.entries(tiles).map(([id, x]) => (
              <button type="button" key={id} class={`chip${pins.includes(id) ? ' on' : ''}`} onClick={() => togglePin(id)}><Icon name={pins.includes(id) ? 'check' : 'plus'} size={13} stroke={2.6} /> {x.title}</button>))}</div>
          )}
          <div class="sum-grid" ref={gridRef}>
            {pins.filter((id) => tiles[id]).map((id) => { const x = tiles[id]; return <SumTile key={id} id={x.id || `tile-${id}`} color={x.color} icon={x.icon} title={x.title} value={x.value} unit={x.unit} foot={x.foot} chart={x.chart} onClick={x.go} />; })}
          </div>
          <button type="button" class="show-all" onClick={() => { tick(); push('browse', {}, 'summary'); }} id="home-browse">
            <span class="sa-ic"><Icon name="grid" size={16} stroke={2.4} /></span>{t('showAllHaptune')}<Icon name="chevronR" size={14} />
          </button>
        </section>

        {more.length > 0 && (
          <section class="sum-sec" id="home-more">
            <div class="shelf-head"><h2>{t('getMoreT')}</h2></div>
            <div class="gm-grid" ref={gmRef}>{more.map((x) => (
              <div class="gm-card" key={x.id} id={`gm-${x.id}`}>
                <button type="button" class="gm-x" onClick={() => hide(`gm-${x.id}`)} aria-label={t('close')}><Icon name="close" size={12} stroke={2.6} /></button>
                <button type="button" class="gm-main" onClick={() => { tick(); x.go(); }}>
                  <span class="gm-ic" style={{ background: `linear-gradient(to top right, ${x.grad[0]}, ${x.grad[1]})` }}><Icon name={x.icon} size={30} stroke={2} /></span>
                  <span class="gm-t"><strong>{x.title}</strong><span>{x.text}</span></span>
                </button>
              </div>))}</div>
          </section>
        )}

        <div class="shelf-head disc-head"><h2>{t('discoverMusic')}</h2></div>
        <div class="chips home-chips" id="home-chips" role="toolbar" aria-label={t('filter')}>
          {HOME_CHIPS.map((c) => <Chip key={c} on={chip === c} onClick={() => pick(c)} id={`chip-${c}`}>{c === 'mine' && myInst && t(`inst_${myInst}`) !== `inst_${myInst}` ? t(`inst_${myInst}`) : t(`hc_${c}`)}</Chip>)}
        </div>

        <Shelf id="shelf-again" title={t('shelfAgain')} items={again} onPlayAll={playFirst(again)} more={() => go('library')} />
        <Shelf id="shelf-level" title={t('shelfLevel')} items={recommended} onPlayAll={playFirst(recommended)} more={() => push('find')} />
        <Shelf id="shelf-class" title={t('shelfClass')} items={classPieces} onPlayAll={playFirst(classPieces)} />
        <Shelf id="shelf-trending" title={t('shelfTrending')} items={trending} more={() => go('community')} />
        <Shelf id="shelf-new" title={t('shelfNew')} items={fresh} onPlayAll={playFirst(fresh)} more={() => push('newSongs')} />
        {!catalog && <div class="shelf-skeleton"><i /><i /><i /><i /><i /><i /></div>}

        <section class="sum-sec" id="home-articles">
          <div class="shelf-head"><h2>{t('articlesT')}</h2></div>
          <div class="art-grid">{ARTICLES.map((a) => (
            <button type="button" class="art-card" key={a.id} id={`art-${a.id}`} onClick={() => { tick(); push('help', { topic: a.topic }, 'summary'); }}>
              <ArtCover kind={a.id} />
              <span class="art-t"><strong>{t(`art_${a.id}T`)}</strong><span>{t(`art_${a.id}S`)}</span></span>
            </button>))}</div>
        </section>

        <MoreTools scan={() => pageRef.current?.click()} />
      </div>
      {drag && <div class="dropzone"><div><Icon name="upload" size={44} stroke={2} />{t('dropHere')}<small>{t('dropHereSub')}</small></div></div>}
    </div>
  );
}

/** Hapi's tip of the day (tap for the next one). */
const TIPS = ['hapiTip1', 'hapiTip2', 'hapiTip3', 'hapiTip4', 'hapiTip5', 'hapiTip6'];
function HapiTip() {
  const day = Math.floor(Date.now() / 86400000);
  const [k, setK] = useState(day % TIPS.length);
  const moods = ['happy', 'think', 'cheer', 'listen', 'wave', 'happy'];
  return (
    <button type="button" class="hapi-tip" id="home-tip" onClick={() => setK((k + 1) % TIPS.length)} aria-label={t('hapiTipT')}>
      <Mascot mood={moods[k]} size={50} />
      <span><strong>{t('hapiTipT')}</strong><span key={k} class="ht-text">{t(TIPS[k])}</span></span>
      <Icon name="chevronR" size={14} />
    </button>
  );
}
