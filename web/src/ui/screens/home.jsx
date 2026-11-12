// Home: the fastest way to the sheet music you want.
// One box takes a song name, a composer or a link; three buttons take a file, a photo or typed notes.
// Results come from your library, the free library and Stage at once; when nothing fits, one tap asks
// the web (AI) or the community for it.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp, push, go, openSheet, minutesOn, streakDays, toast, setState } from '../state.js';
import { t, getLang } from '../../core/i18n.js';
import { Card, Section, Icon, List, Row } from '../components.jsx';
import { Mascot } from '../mascot.jsx';
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
  const picks = useMemo(() => {
    if (!catalog) return [];
    const day = Math.floor(Date.now() / 86400000);
    const have = new Set(s.pieces.map((p) => p.catalogId || (p.songId && `song:${p.songId}`)));
    const pool = catalog.filter((r) => !have.has(r.id));
    const out = [];
    for (let i = 0; i < pool.length && out.length < 12; i++) out.push(pool[(day * 7 + i * 37) % pool.length]);
    return [...new Set(out)];
  }, [catalog, s.pieces.length]);

  const onPick = (e) => { const files = [...(e.currentTarget.files || [])]; e.currentTarget.value = ''; openFiles(files); };
  const submit = (e) => {
    e?.preventDefault();
    if (!query) return;
    if (isLink(query)) openSheet('finder', { query });           // a YouTube / Spotify link: straight to the finder
  };
  const recent = [...s.pieces].filter((p) => p.opened && p.kind === 'score').sort((a, b) => b.opened - a.opened)[0] || s.pieces.find((p) => p.kind === 'score');
  const today = new Date().toISOString().slice(0, 10);
  const todayMin = Math.round(minutesOn(today));
  const goal = s.settings.dailyGoal || 20;
  const streak = Math.max(streakDays(), s.me?.streak || 0);
  const name = (s.me?.name && s.me.name !== 'Musician' ? s.me.name : s.settings.name || '').trim().split(/\s+/)[0] || '';
  const tier = s.me?.tier || 'free';
  const nothing = query && !mine.length && !free.length && stage && !stage.scores.length && !stage.requests.length;

  return (
    <div class="scroll" id="home">
      <div class="wrap">
        <input ref={pageRef} type="file" class="hidden-input" accept=".pdf,application/pdf,image/*" multiple onChange={onPick} id="home-pages" aria-label={t('wayScan')} />
        <input ref={camRef} type="file" class="hidden-input" accept="image/*" capture="environment" multiple onChange={onPick} aria-label={t('wayCamera')} />
        <input ref={fileRef} type="file" class="hidden-input" accept={ACCEPT} onChange={onPick} id="home-file" aria-label={t('wayFile')} />
        <header class="hm-top">
          <span class="logo"><span class="logo-mark"><Icon name="library" size={18} stroke={2.4} /></span>Haptune</span>
          {streak > 0 && <span class="hm-pill flame" title={t('streak')}><Icon name="flame" size={15} fill stroke={1.6} />{streak}</span>}
          {online && s.me && <button type="button" class="hm-pill notes" onClick={() => push('wallet', {}, 'me')} aria-label={t('rewards')}><Icon name="gift" size={15} stroke={2.2} />{s.me.credits ?? 0}</button>}
          {online && <button type="button" class="hm-pill" onClick={() => push('notifications', {}, 'me')} aria-label={t('notifications')} style={{ position: 'relative', padding: '0 9px' }}>
            <Icon name="bell" size={17} />{s.me?.unread > 0 && <span class="tab-dot" />}</button>}
        </header>

        <section class="hm-hero fade-up">
          <h1>{name ? t('homeAskName', { name }) : t('homeAsk')}</h1>
          <p>{t('homeAskSub')}</p>
          <form class="hm-search" onSubmit={submit} role="search">
            <Icon name="search" size={21} stroke={2.3} />
            <input id="home-search" type="search" enterkeyhint="search" autocomplete="off" placeholder={t('homeSearchPh')} value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label={t('homeSearchPh')} />
            {q && <button type="button" class="clear" onClick={() => setQ('')} aria-label={t('clear')}><Icon name="close" size={16} stroke={2.6} /></button>}
            <button type="submit" class="go" aria-label={t('search')}><Icon name="chevronR" size={20} stroke={2.8} /></button>
          </form>
          {!query && <>
            <div class="hm-ways">
              <button type="button" class="hm-way" id="way-scan" onClick={() => pageRef.current?.click()}>
                <Icon name="camera" size={22} stroke={2.1} /><div><strong>{t('wayScan')}</strong><span>{t('wayScanSub')}</span></div>
              </button>
              <button type="button" class="hm-way" id="way-file" onClick={() => fileRef.current?.click()}>
                <Icon name="upload" size={22} stroke={2.1} /><div><strong>{t('wayFile')}</strong><span>{t('wayFileSub')}</span></div>
              </button>
              <button type="button" class="hm-way" id="way-type" onClick={() => openSheet('paste')}>
                <Icon name="pencil" size={22} stroke={2.1} /><div><strong>{t('wayType')}</strong><span>{t('wayTypeSub')}</span></div>
              </button>
            </div>
            <div class="hm-tries">
              {['Canon in D', 'Ode to Joy', lang.startsWith('zh') ? '茉莉花' : 'Amazing Grace', 'Für Elise'].map((x) => <button type="button" key={x} onClick={() => setQ(x)}>{x}</button>)}
            </div>
          </>}
        </section>

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
            {recent && (
              <Card class="fade-up d1" onClick={() => push('piece', { id: recent.id }, 'library')}>
                <div class="hm-continue">
                  <span class="hm-art"><Icon name="library" size={26} stroke={2.1} /></span>
                  <div class="t">
                    <span class="sub" style={{ fontWeight: 650 }}>{t('keepGoing')}</span>
                    <strong>{recent.title}</strong>
                    <span class="sub">{recent.best !== null && recent.best !== undefined ? `${t('rightNotes')}: ${recent.best}%` : recent.composer || recent.keyText || ''}</span>
                  </div>
                  <span class="hm-play" id="home-continue" role="button" tabIndex={0} aria-label={t('playAlong')}
                    onClick={(e) => { e.stopPropagation(); push('piece', { id: recent.id, start: 'playAlong' }, 'library'); }}><Icon name="mic" size={22} stroke={2.3} /></span>
                </div>
              </Card>
            )}

            <div class="hm-row2 fade-up d2">
              <button type="button" class={`hm-stat${pulse ? ' live' : ''}`} id="home-stage" onClick={() => go('community')}>
                <span class="k">{pulse ? <><span class="live-dot" />{t('liveNow')}</> : <><Icon name="stage" size={13} stroke={2.4} />Stage</>}</span>
                <span class="v num">{pulse ? pulse.online : '—'}</span>
                <span class="s">{pulse ? t('onlineNowSub', { n: pulse.open_requests }) : t('stageOfflineSub')}</span>
              </button>
              <button type="button" class="hm-stat" onClick={() => push('history', {}, 'summary')}>
                <span class="k"><Icon name="flame" size={13} stroke={2.4} />{t('today')}</span>
                <span class="v num">{todayMin}<span style={{ fontSize: 14, fontWeight: 650, color: 'var(--ink3)' }}> / {goal} {t('min')}</span></span>
                <div class="goal-bar" style={{ margin: '2px 0 0' }}><span style={{ width: `${Math.min(100, (todayMin / goal) * 100)}%` }} /></div>
              </button>
            </div>

            {pulse?.daily && (
              <Card class="fade-up d2" onClick={() => push('daily', {}, 'community')}>
                <div class="hm-continue">
                  <span class="hm-art c-orange" style={{ color: 'var(--orange)', background: 'color-mix(in srgb, var(--orange) 14%, transparent)' }}><Icon name="bolt" size={26} stroke={2.1} /></span>
                  <div class="t">
                    <span class="sub" style={{ fontWeight: 650 }}>{t('dailyChallenge')} · {t('nPlayingToday', { n: pulse.daily.players })}</span>
                    <strong>{pulse.daily.title}</strong>
                    <span class="sub">{pulse.daily.mine ? t('yourBestToday', { n: Math.round(pulse.daily.mine * 100) }) : t('dailySub')}</span>
                  </div>
                  <Icon name="chevronR" size={18} stroke={2.4} />
                </div>
              </Card>
            )}

            {todo && todo.length > 0 && (
              <Section title={t('classTodo')}>
                <List>
                  {todo.slice(0, 3).map((a) => (
                    <Row key={a.id} icon="flag" color={a.status === 'due-soon' || a.status === 'late' ? 'orange' : 'violet'} title={a.title}
                      subtitle={`${a.class_name} · ${a.status === 'upcoming' ? t('opensOn', { d: dueLabel(a.opens_at, lang) }) : t('dueOn', { d: dueLabel(a.due_at, lang) })}`}
                      onClick={() => push('assignment', { id: a.id }, 'academy')} />
                  ))}
                </List>
              </Section>
            )}

            {pulse?.trending?.length > 0 && (
              <Section title={t('trendingOnStage')} action={<button type="button" onClick={() => go('community')}>{t('seeAll')}</button>}>
                <div class="shelf">
                  {pulse.trending.map((p) => <ScoreCard key={p.id} title={p.title} by={p.artist || p.author?.name} genre={p.kind === 'request' ? 'song' : 'classical'} heat={p.heat}
                    tag={p.kind === 'request' ? t('wanted') : (p.instrument || t('score'))} onClick={() => push('post', { id: p.id }, 'community')} />)}
                </div>
              </Section>
            )}

            {picks.length > 0 && (
              <Section title={t('freeLibrary')} action={<button type="button" onClick={() => push('catalog', {}, 'library')}>{t('browseAll', { n: catalog.length })}</button>}>
                <div class="shelf" id="home-shelf">
                  {picks.map((r) => <ScoreCard key={r.id} title={r.title} by={r.composer} genre={r.genre} tag={t(`genre_${r.genre}`)} onClick={() => openCatalog(r)} />)}
                </div>
              </Section>
            )}

            {!recent && <Card><div class="report-line" style={{ alignItems: 'center' }}><Mascot mood="wave" size={56} /><p class="sub">{t('homeEmpty')}</p></div></Card>}
          </>
        )}
      </div>
      {drag && <div class="dropzone"><div><Icon name="upload" size={44} stroke={2} />{t('dropHere')}<small>{t('dropHereSub')}</small></div></div>}
    </div>
  );
}


