// Summary (the first tab): like Apple Health's Summary, one look at everything. Today's rings, where you left off,
// New songs · Find songs · Create, then a tile for each part of Melovyn (practice, accuracy, Learn, Stage, Create,
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

/** One Summary tile: coloured title line, a big number, a small chart, and a tap to its screen. */
function SumTile({ id, color, icon, title, detail, value, unit, foot, chart, onClick }) {
  return (
    <button type="button" class={`sum-tile c-${color}`} id={id} onClick={() => { tick(); onClick(); }}>
      <span class="st-head"><Icon name={icon} size={15} stroke={2.4} /><span class="st-t">{title}</span>{detail && <span class="st-d">{detail}</span>}<Icon name="chevronR" size={13} /></span>
      <span class="st-body"><span class="st-v"><span class="st-num"><span class="num">{value}</span>{unit && <small>{unit}</small>}</span>{foot && <span class="st-f">{foot}</span>}</span>{chart}</span>
    </button>
  );
}

/** A short "how Melovyn works" for someone new: three steps, dismissed for good with one tap. */
function FirstGuide({ onClose, teacher }) {
  const steps = [['search', 'blue', 'guide1T', 'guide1S', () => push('find')], ['mic', 'pink', 'guide2T', 'guide2S', () => push('find')],
    teacher ? ['academy', 'orange', 'guide3tT', 'guide3tS', () => go('academy')] : ['academy', 'orange', 'guide3T', 'guide3S', () => go('academy')]];
  return (
    <section class="guide-card" id="home-guide">
      <div class="gc-head"><Mascot mood="wave" size={52} /><div><strong>{t('guideT')}</strong><span>{t('guideSub')}</span></div>
        <button type="button" class="gc-x" onClick={onClose} aria-label={t('close')} id="guide-close"><Icon name="close" size={16} /></button></div>
      <ol>{steps.map(([ic, c, a, b, f], i) => (
        <li key={a}><button type="button" onClick={f}><span class={`gc-n c-${c}`}>{i + 1}</span><span><strong>{t(a)}</strong><span>{t(b)}</span></span><Icon name={ic} size={18} /></button></li>
      ))}</ol>
    </section>
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
      <span class="ic"><Icon name={icon} size={26} stroke={2.2} /></span><strong>{t(title)}</strong><span>{t(sub)}</span>
    </button>
  );
  // today and this week (on this device and, for streak, the account)
  const week = lastDays(7).map((d) => Math.round(minutesOn(d)));
  const todayMin = week[6];
  const goal = Math.max(5, s.settings.dailyGoal || 15);
  const takes = s.history.filter((x) => x.accuracy !== undefined && x.accuracy !== null).slice(-12);
  const lastTake = takes[takes.length - 1];
  const lv = levelFor(s.progress.xp);
  const todayXP = Math.min(120, Object.values(s.progress.lessons).filter((x) => new Date(x.at).toDateString() === new Date().toDateString()).length * 60 + Math.round(todayMin * 5));
  const mine = s.pieces.filter((p) => p.kind === 'score' && (p.source === 'written' || p.edited));
  // the guide is for someone new: closed for good with ✕, and gone by itself after a first take
  const [guide, setGuide] = useState(() => !local.get('guideDone', false) && s.history.length < 2);
  const closeGuide = () => { local.set('guideDone', true); setGuide(false); };
  const g = s.me?.google;
  return (
    <div class="scroll" id="home">
      <div class="wrap">
        <input ref={pageRef} type="file" class="hidden-input" accept=".pdf,application/pdf,image/*" multiple onChange={(e) => { const f = [...(e.currentTarget.files || [])]; e.currentTarget.value = ''; openFiles(f); }} aria-label={t('wayScan')} />
        <LargeTitle title={t('summary')} eyebrow={dateLabel(lang)} color="violet" actions={<>
          {streak > 0 && <span class="hm-pill flame" title={t('streak')} id="home-streak"><Icon name="flame" size={15} fill stroke={1.6} />{streak}</span>}
          {online && <button type="button" class="hm-pill" onClick={() => push('notifications', {}, 'me')} aria-label={t('notifications')} style={{ position: 'relative', padding: '0 9px' }}>
            <Icon name="bell" size={17} />{s.me?.unread > 0 && <span class="tab-dot" />}</button>}
          <span class="ph-only"><Avatar /></span>
        </>} />
        <p class="sum-greet" id="home-greet">{greet}</p>

        {guide && <FirstGuide onClose={closeGuide} teacher={(s.me?.hub_role || local.get('hubRoleLocal', '')) === 'teacher'} />}

        <div class="sum-top" id="home-rings">
        <button type="button" class="rings-card2" id="rings-btn" onClick={() => { tick(); push('history', { metric: 'time' }, 'summary'); }}>
          <Rings size={104} width={12} rings={[{ value: todayMin / goal, color: 'pink' }, { value: todayXP / 120, color: 'green' }, { value: Math.min(7, streak) / 7, color: 'cyan' }]} />
          <span class="rc-legend">
            <span><span class="lab t-pink">{t('ringPractise')}</span><span class="val num">{todayMin}<small>/{goal} {t('min')}</small></span></span>
            <span><span class="lab t-green">{t('ringLearn')}</span><span class="val num">{todayXP}<small>/120 {t('xp')}</small></span></span>
            <span><span class="lab t-cyan">{t('ringStreak')}</span><span class="val num">{streak}<small>/7 {t('days')}</small></span></span>
          </span>
        </button>

        {last && <button type="button" class="resume-card" id="home-continue" onClick={() => { tick(); push('piece', { id: last.id, ...(last.lastBar > 1 ? { bar: last.lastBar } : {}) }, 'library'); }}>
          <Cover title={last.title} instrument={last.instrument} keyText={last.keyText} size="sm" />
          <span class="cc-t"><span class="cc-k">{t('continueK')}</span><strong>{last.title}</strong><span>{last.lastBar > 1 ? t('atBar', { n: last.lastBar }) : (last.composer || last.keyText || '')}</span></span>
          <span class="cc-play" role="presentation"><Icon name="play" size={20} fill /></span>
        </button>}
        </div>

        <div class="hero-row" id="home-hero">
          {hero('new', 'violet', 'sparkles', 'heroNew', 'heroNewSub', () => push('newSongs'))}
          {hero('find', 'blue', 'search', 'heroFind', 'heroFindSub', () => push('find'))}
          {hero('create', 'teal', 'pencil', 'heroCreate', 'heroCreateSub', () => openSheet('newSong', { quick: true }))}
        </div>

        <section class="sum-sec" id="home-band">
          <div class="shelf-head"><h2>{t('pinned')}</h2></div>
          <div class="sum-grid">
            <SumTile id="tile-time" color="pink" icon="flame" title={t('practiceTime')} detail={t('today')} value={todayMin} unit={t('min')} foot={t('goalMin', { n: goal })}
              chart={<MiniBars values={week} color="pink" width={96} height={40} />} onClick={() => push('history', { metric: 'time' }, 'summary')} />
            <SumTile id="tile-acc" color="green" icon="check" title={t('accuracy')} detail={lastTake ? new Date(lastTake.date).toLocaleDateString(lang, { month: 'short', day: 'numeric' }) : ''}
              value={lastTake ? Math.round(lastTake.accuracy * 100) : '–'} unit="%" foot={lastTake ? lastTake.title : t('noTakes')}
              chart={takes.length > 1 ? <MiniLine values={takes.map((x) => x.accuracy * 100)} color="green" width={96} height={40} /> : null} onClick={() => push('history', { metric: 'accuracy' }, 'summary')} />
            <SumTile id="band-learn" color="orange" icon="academy" title={t('hub')}
              value={!online ? '–' : L?.teacher ? L.teacher.to_review : L?.todo ?? (L?.next_assignment ? 1 : 0)}
              unit={!online ? '' : L?.teacher ? t('toReviewShort') : t('toDoShort')}
              foot={!online ? t('bandOffline') : L?.teacher ? (L.teacher.inactive ? t('quietStudents', { n: L.teacher.inactive }) : t('takesToReview', { n: L.teacher.to_review }))
                : L?.next_assignment ? `${L.next_assignment.title} · ${t('dueOn', { d: dueLabel(L.next_assignment.due, lang) })}` : L?.classes ? t('nothingDue') : t('joinAClass')}
              onClick={() => go('academy')} />
            <SumTile id="band-stage" color="pink" icon="stage" title={t('stage')} detail={ST?.friends_new ? t('friendsNewN', { n: ST.friends_new }) : ''}
              value={ST?.daily ? (ST.daily.mine != null ? Math.round(ST.daily.mine * 100) : ST.daily.players) : (ST?.open_requests ?? '–')}
              unit={ST?.daily ? (ST.daily.mine != null ? '%' : t('playersShort')) : t('requestsShort')}
              foot={ST?.daily ? `${t('todaysChallenge')}: ${ST.daily.title}` : t('stageRowSub')} onClick={() => go('community')} />
            <SumTile id="tile-create" color="teal" icon="pencil" title={t('create')} value={mine.length} unit={t('songsShort')} foot={mine[0]?.title || t('heroCreateSub')} onClick={() => go('write')} />
            <SumTile id="tile-library" color="blue" icon="library" title={t('library')} value={s.pieces.length} unit={t('piecesShort')} foot={catalog ? t('freeLibN', { n: catalog.length.toLocaleString(lang) }) : t('library')} onClick={() => go('library')} />
            <SumTile id="tile-level" color="violet" icon="star" title={t('levelN', { n: lv.level })} value={s.progress.xp} unit={t('xp')} foot={t('xpToNext', { n: Math.max(0, lv.need - lv.into) })}
              chart={<Rings size={40} width={6} rings={[{ value: lv.into / Math.max(1, lv.need), color: 'violet' }]} />} onClick={() => push('courses')} />
            {online && s.me?.registered && (
              <SumTile id="tile-google" color={g ? 'green' : 'gray'} icon="link" title="Google" value={g ? '✓' : '–'} unit="" foot={g ? s.me.email : t('gNeedSignInShort')} onClick={() => openSheet('connections')} />
            )}
          </div>
        </section>

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

        <MoreTools scan={() => pageRef.current?.click()} />
      </div>
      {drag && <div class="dropzone"><div><Icon name="upload" size={44} stroke={2} />{t('dropHere')}<small>{t('dropHereSub')}</small></div></div>}
    </div>
  );
}
