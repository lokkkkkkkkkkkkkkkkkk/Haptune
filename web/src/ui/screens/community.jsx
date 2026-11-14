// Stage: the community. One front page answers three questions straight away:
//   what can I play?        trending and new scores, on shelves
//   how do I get a song?    "Request a song" (and "me too" on what others asked for)
//   how do I help?          "Help write": requests for your instrument, with a short guide
// Then the fun: today's tune against your friends, the weekly challenge, helpers of the week.
// The numbers at the top (online now, active today) are real counts from the server.
import { useState, useEffect, useRef } from 'preact/hooks';
import { useApp, push, openSheet, closeSheet, setState, addSongbookSong, toast } from '../state.js';
import { t, instrumentName } from '../../core/i18n.js';
import { Icon, Chip, Button, Section, Card, Segmented, Empty, List, Row } from '../components.jsx';
import { LargeTitle, NavBar, SheetFrame, Avatar } from './common.jsx';
import { Feed } from './stagefeed.jsx';
import { whenSignedIn } from './hub.jsx';
import { Mascot } from '../mascot.jsx';
import { hasServer } from '../api.js';
import { C, ensureAccount, attempt } from '../account.js';
import { PostCard, Person, timeLeft } from './social.jsx';
import { ScoreCard } from './home.jsx';
import { local } from '../storage.js';

const SEGMENTS = [
  { value: 'home', label: 'segForYou' }, { value: 'following', label: 'segFollowing' }, { value: 'requests', label: 'segRequests' },
  { value: 'library', label: 'segScores' }, { value: 'play', label: 'segPlay' }, { value: 'questions', label: 'segQuestions' },
];

/** Notes: what people earn on Stage. A small pill with the balance. */
export function Notes({ n, size = 'md' }) {
  return <span class={`nts ${size}`}><Icon name="gift" size={size === 'xl' ? 34 : size === 'sm' ? 13 : 15} stroke={2.3} />{n}</span>;
}

export function CommunityView({ active }) {
  const s = useApp();
  const seg = s.communitySeg || 'home';
  const online = hasServer();
  useEffect(() => { if (active && online) ensureAccount(); }, [active]);
  const actions = online ? <>
    <button type="button" class="stage-plus" id="stage-plus" aria-label={t('stageWhatDo')} onClick={() => openSheet('stageNew')}><Icon name="plus" size={24} stroke={2.8} /></button>
    <button type="button" class="hm-pill nts" id="stage-notes" onClick={() => push('wallet')} aria-label={t('rewards')}><Icon name="gift" size={15} stroke={2.2} />{s.me?.credits ?? '·'}</button>
    <button type="button" class="hm-pill" onClick={() => push('notifications')} aria-label={t('notifications')} style={{ position: 'relative', padding: '0 9px' }}>
      <Icon name="bell" size={17} />{s.me?.unread > 0 && <span class="tab-dot" />}
    </button>
  </> : null;
  const helpWrite = () => {
    setState({ communitySeg: 'requests', stageMine: true });
    if (!local.get('guide.help', false)) openSheet('stageGuide', { topic: 'help' });
  };
  return (
    <div class="scroll" id="stage">
      <div class="wrap">
        <LargeTitle title="Stage" color="pink" actions={<>{actions}<span class="ph-only"><Avatar /></span></>} />
        <p class="stage-purpose" id="stage-purpose">{t('stagePurpose')}</p>
        {!online ? <Empty icon="globe" title={t('communityOffline')} sub={t('communityOfflineSub')} /> : <>
          <StageExplainer />
          <button type="button" class="stage-request" id="st-request-big" onClick={() => whenSignedIn(() => openSheet('compose', { type: 'request' }))}>
            <span class="ic"><Icon name="flag" size={24} stroke={2.3} /></span>
            <span class="t"><strong>{t('requestSheetBig')}</strong><span>{t('requestSheetBigSub')}</span></span>
            <Icon name="chevronR" size={18} stroke={2.6} />
          </button>
          <div class="chips stage-chips" id="community-seg" role="tablist">
            {SEGMENTS.map((o) => <Chip key={o.value} on={seg === o.value} color="pink" onClick={() => setState({ communitySeg: o.value, stageMine: false })}>{t(o.label)}</Chip>)}
          </div>
          {seg === 'home' ? <ForYou active={active} />
            : seg === 'following' ? <Feed active={active} following />
              : seg === 'requests' ? <><button type="button" class="sr-cta" onClick={helpWrite} id="st-help"><span class="hm-art sm"><Icon name="pencil" size={20} stroke={2.2} /></span><div><strong>{t('helpWrite')}</strong><span>{t('helpWriteSub')}</span></div><Icon name="chevronR" size={16} stroke={2.4} /></button>
                <PostList key="r" type="request" active={active} mine={!!s.stageMine} /></>
                : seg === 'library' ? <PostList key="l" type="share" active={active} />
                  : seg === 'play' ? <Play active={active} />
                    : <PostList key="q" type="question" active={active} />}
        </>}
      </div>
    </div>
  );
}

/** First visit: what Stage is for, in three steps. */
function StageExplainer() {
  const [seen, setSeen] = useState(() => local.get('stageExplained', false));
  if (seen) return null;
  return (
    <Card class="stage-how" id="stage-how">
      <strong>{t('stageHowT')}</strong>
      <ol>{['stageHow1', 'stageHow2', 'stageHow3'].map((k) => <li key={k}>{t(k)}</li>)}</ol>
      <Button small kind="secondary" onClick={() => { local.set('stageExplained', true); setSeen(true); }} id="stage-how-ok">{t('gotIt')}</Button>
    </Card>
  );
}

/** The one "+": what do you want to do? Share a take, share a sound, request a sheet, ask a question, post a score. */
export function StageNewSheet() {
  const go = (fn) => { closeSheet(); setTimeout(() => whenSignedIn(fn), 0); };
  const items = [
    ['request', 'flag', 'pink', 'stRequestSheet', () => openSheet('compose', { type: 'request' })],
    ['take', 'mic', 'teal', 'stShareTake', () => openSheet('moment', { record: true })],
    ['sound', 'wave', 'violet', 'stShareSound', () => push('sound', {}, 'write')],
    ['question', 'quiz', 'blue', 'stAskQuestion', () => openSheet('compose', { type: 'question' })],
    ['score', 'staff', 'green', 'stPostScore', () => openSheet('compose', { type: 'share' })],
  ].filter(([id]) => id !== 'sound' || SOUNDS_READY());
  return (
    <SheetFrame title={t('stageWhatDo')}>
      <div class="list inset" id="stage-new">
        {items.map(([id, icon, color, label, fn]) => (
          <button type="button" class="row" key={id} id={`stn-${id}`} onClick={() => go(fn)}>
            <span class={`badge c-${color} solid`} style={{ width: 34, height: 34, borderRadius: 9 }}><Icon name={icon} size={20} stroke={2.1} /></span>
            <span class="row-main"><span class="row-title">{t(label)}</span><span class="row-sub">{t(`${label}Sub`)}</span></span>
            <Icon name="chevronR" size={15} stroke={2.4} style={{ opacity: 0.35 }} />
          </button>
        ))}
      </div>
    </SheetFrame>
  );
}
export const SOUNDS_READY = () => !!globalThis.__melovynSounds;

/** Who is here: real counts. With few people online the day's and the week's numbers lead instead. */
function LiveStrip({ c }) {
  if (!c) return null;
  return (
    <div class="live-strip" id="live-strip">
      <span><span class="live-dot" /><b class="num">{c.online}</b> {t('onlineNow')}</span>
      {c.practising > 0 && <span><Icon name="mic" size={13} stroke={2.4} /><b class="num">{c.practising}</b> {t('practisingNow')}</span>}
      <span><b class="num">{c.today}</b> {t('activeToday')}</span>
      <span><b class="num">{c.scores_week}</b> {t('scoresThisWeek')}</span>
    </div>
  );
}

function ForYou({ active }) {
  const s = useApp();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = async () => { try { setData(await C.stage()); setErr(''); } catch (e) { setErr(e.message); } };
  useEffect(() => { if (active) load(); }, [active, s.me?.id]);
  if (err && !data) return <Card><p class="sub">{err}</p><Button kind="secondary" onClick={load}>{t('tryAgain')}</Button></Card>;
  if (!data) return <div class="loading"><Mascot mood="think" size={70} /></div>;
  const mine = s.me?.instruments || [];
  const all = (v, extra = {}) => <button type="button" onClick={() => setState({ communitySeg: v, ...extra })}>{t('seeAll')}</button>;
  return (
    <>
      <LiveStrip c={data.counts} />
      <DailyCard d={data.daily} />
      {data.trending.length > 0 && (
        <Section title={t('trendingOnStage')}>
          <div class="shelf" id="st-trending">
            {data.trending.map((p) => <ScoreCard key={p.id} title={p.title} by={p.artist || p.author?.name} genre={p.kind === 'request' ? 'song' : 'classical'} heat={p.heat || null}
              tag={p.kind === 'request' ? t('wanted') : (p.instrument ? instrumentName(p.instrument) : t('score'))} onClick={() => push('post', { id: p.id })} />)}
          </div>
        </Section>
      )}
      {mine.length > 0 && data.help_wanted.length > 0 && (
        <Section title={t('helpWantedFor', { inst: mine.map(instrumentName).join(', ') })} action={all('requests', { stageMine: true })}>
          <div class="post-list">{data.help_wanted.slice(0, 3).map((p) => <PostCard key={p.id} p={p} compact />)}</div>
        </Section>
      )}
      <Section title={t('latestOnStage')}>
        <Feed active={active} />
      </Section>
      {data.helpers.length > 0 && (
        <Section title={t('topHelpersWeek')} action={<button type="button" onClick={() => push('leaderboard')}>{t('leaderboard')}</button>}>
          <div class="helpers-strip">
            {data.helpers.map((h) => (
              <button type="button" key={h.user.id} class="helper" onClick={() => h.user.handle && push('profile', { handle: h.user.handle })}>
                <span class="rank">{h.rank <= 3 ? ['🥇', '🥈', '🥉'][h.rank - 1] : h.rank}</span>
                <Person user={h.user} size={46} />
                <strong>{h.user.name}</strong>
                <Notes n={h.value} size="sm" />
              </button>
            ))}
          </div>
        </Section>
      )}
      <HowStageWorks />
      <div class="community-foot">
        <button type="button" class="link" onClick={() => push('help', { topic: 'community' })}>{t('howItWorks')}</button> ·
        <button type="button" class="link" onClick={() => openSheet('guidelines')}>{t('guidelines')}</button>
      </div>
    </>
  );
}

function HowStageWorks() {
  const steps = [['flag', 'how1', 'how1Sub', 'request'], ['pencil', 'how2', 'how2Sub', 'help'], ['upload', 'how3', 'how3Sub', 'upload']];
  return (
    <Section title={t('howStageWorks')}>
      <div class="how-grid">
        {steps.map(([icon, a, b, topic], i) => (
          <button type="button" class="how-step" key={a} onClick={() => openSheet('stageGuide', { topic })}>
            <span class="no">{i + 1}</span><Icon name={icon} size={20} stroke={2.2} />
            <strong>{t(a)}</strong><span>{t(b)}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

/** A short how-to for each of the three things people do on Stage. Shown once before the first time. */
export function StageGuideSheet({ topic = 'help' }) {
  const STEPS = {
    request: [['search', 'gReq1'], ['flag', 'gReq2'], ['users', 'gReq3'], ['star', 'gReq4']],
    help: [['flag', 'gHelp1'], ['pencil', 'gHelp2'], ['send', 'gHelp3'], ['gift', 'gHelp4']],
    upload: [['doc', 'gUp1'], ['shield', 'gUp2'], ['upload', 'gUp3'], ['heart', 'gUp4']],
  }[topic];
  const done = () => {
    local.set(`guide.${topic}`, true);
    closeSheet();
    if (topic === 'upload') setTimeout(() => openSheet('compose', { type: 'share' }), 60);
    if (topic === 'request') setTimeout(() => openSheet('compose', { type: 'request' }), 60);
  };
  return (
    <SheetFrame title={t({ request: 'requestSong', help: 'helpWrite', upload: 'shareScore' }[topic])}>
      <div class="guide-steps">
        {STEPS.map(([icon, key], i) => (
          <div class="guide-step" key={key}><span class="no">{i + 1}</span><span class="ic"><Icon name={icon} size={20} stroke={2.2} /></span><p>{t(key)}</p></div>
        ))}
      </div>
      <Button kind="brand" full onClick={done} id="guide-go">{t({ request: 'gReqGo', help: 'gHelpGo', upload: 'gUpGo' }[topic])}</Button>
    </SheetFrame>
  );
}

async function playSong(song, props) {
  const rec = await addSongbookSong(song, { silent: true });
  if (!rec) { toast(t('challengeMissing'), 'err'); return; }
  push('piece', { id: rec.id, start: 'playAlong', ...props });
}

/** Today's tune: the same short piece for everyone, new at midnight (UTC). */
export function DailyCard({ d }) {
  if (!d) return null;
  return (
    <div class="daily-card fade-up" id="daily-card">
      <div class="dc-top"><span class="dc-badge"><Icon name="bolt" size={15} stroke={2.4} />{t('dailyChallenge')}</span>
        <span class="dc-n">{d.players > 0 ? t('nPlayingToday', { n: d.players }) : t('beFirstToday')}</span></div>
      <h3>{d.title}</h3>
      <p>{d.mine != null ? t('yourBestToday', { n: Math.round(d.mine * 100) }) : t('dailySub')}</p>
      <div class="btn-row">
        <Button icon="mic" onClick={() => playSong(d.song, { daily: d.song })}>{d.mine != null ? t('beatIt') : t('playNow')}</Button>
        <Button kind="secondary" icon="users" onClick={() => push('daily')}>{t('friendsAndRanks')}</Button>
      </div>
    </div>
  );
}

function LbRow({ e, i, right }) {
  return (
    <button type="button" class="lb-row" onClick={() => e.user?.handle && push('profile', { handle: e.user.handle })}>
      <span class="lb-rank">{i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</span><Person user={e.user} size={34} />
      <span class="lb-name"><strong>{e.user?.name}</strong><span>{e.tempo_pct}% {t('speed').toLowerCase()}</span></span>
      {right || <span class="lb-val num t-green">{Math.round(e.accuracy * 100)}%</span>}
    </button>
  );
}

/** The daily challenge: your friends first, then everyone. Friends who haven't played can be nudged. */
export function DailyView({ active }) {
  const [d, setD] = useState(null);
  const [sent, setSent] = useState({});
  const load = () => C.daily().then(setD).catch(() => setD(null));
  useEffect(() => { if (active) load(); }, [active]);
  const nudge = async (u) => {
    const r = await attempt(() => C.nudge(u.handle));
    if (r) { setSent((x) => ({ ...x, [u.handle]: true })); toast(t('nudged', { name: u.name })); }
  };
  const share = async () => {
    const url = `${(globalThis.HAPTUNE_CONFIG?.site || location.origin)}/app/#daily`;
    const text = t('dailyShareText', { title: d.title, n: d.mine ? Math.round(d.mine.accuracy * 100) : '' });
    try { if (navigator.share) await navigator.share({ text, url }); else { await navigator.clipboard.writeText(`${text} ${url}`); toast(t('linkCopied')); } } catch { /* closed */ }
  };
  return (
    <div class="scroll">
      <NavBar title={t('dailyChallenge')} backLabel="Stage" />
      <div class="wrap">
        {!d ? <div class="loading"><Mascot mood="think" size={70} /></div> : <>
          <div class="daily-card big">
            <div class="dc-top"><span class="dc-badge"><Icon name="bolt" size={15} stroke={2.4} />{t('todaysTune')}</span><span class="dc-n">{timeLeft(d.ends)}</span></div>
            <h3>{d.title}</h3>
            <p>{t('dailyRules', { n: d.rewards.entry, a: d.rewards.top[0] })}</p>
            <div class="dc-stats">
              <div><strong class="num">{d.mine ? `${Math.round(d.mine.accuracy * 100)}%` : '—'}</strong><span>{t('yourBest')}</span></div>
              <div><strong class="num">{d.mine ? `#${d.mine.rank}` : '—'}</strong><span>{t('ofN', { n: d.players })}</span></div>
              <div><strong class="num">{d.streak}</strong><span>{t('dailyStreak')}</span></div>
            </div>
            <div class="btn-row">
              <Button icon="mic" onClick={() => playSong(d.song, { daily: d.song })} id="daily-play">{d.mine ? t('beatIt') : t('playNow')}</Button>
              <Button kind="secondary" icon="share" onClick={share}>{t('challengeFriends')}</Button>
            </div>
          </div>
          <Section title={t('friends')}>
            {d.friends.length || d.waiting.length ? (
              <div class="lb">
                {d.friends.map((e, i) => <LbRow key={e.user.id} e={e} i={i} />)}
                {d.waiting.map((u) => (
                  <div class="lb-row" key={u.id}>
                    <span class="lb-rank">·</span><Person user={u} size={34} />
                    <span class="lb-name"><strong>{u.name}</strong><span>{t('notPlayedYet')}</span></span>
                    <Button small kind="secondary" disabled={sent[u.handle]} onClick={() => nudge(u)}>{sent[u.handle] ? t('nudgedShort') : t('nudge')}</Button>
                  </div>
                ))}
              </div>
            ) : <p class="note-text">{t('noFriendsYet')}</p>}
          </Section>
          <Section title={t('everyoneToday')}>
            {d.entries.length ? <div class="lb">{d.entries.map((e, i) => <LbRow key={e.user.id} e={e} i={i} />)}</div> : <p class="note-text">{t('beFirst')}</p>}
          </Section>
          {d.yesterday.winners.length > 0 && (
            <Section title={t('yesterdayWinners', { song: d.yesterday.title })}>
              <div class="helpers-strip">{d.yesterday.winners.map((e, i) => (
                <div class="helper" key={e.user.id}><span class="rank">{['🥇', '🥈', '🥉'][i]}</span><Person user={e.user} size={44} /><strong>{e.user.name}</strong><span class="num">{Math.round(e.accuracy * 100)}%</span></div>
              ))}</div>
            </Section>
          )}
        </>}
      </div>
    </div>
  );
}

/** This week's song: play it with Play Along, best accuracy wins Notes. */
export function ChallengeCard({ ch }) {
  if (!ch) return null;
  return (
    <div class="challenge-card fade-up d1">
      <div class="cc-top">
        <span class="cc-badge"><Icon name="trophy" size={18} stroke={2.3} />{t('weeklyChallenge')}</span>
        <span class="cc-left">{timeLeft(ch.ends)}</span>
      </div>
      <h3>{ch.title}</h3>
      <p>{t('challengeHow', { n: ch.rewards.entry, a: ch.rewards.top[0] })}</p>
      <div class="cc-row">
        <div class="cc-faces">{ch.entries.slice(0, 5).map((e) => <Person key={e.user.id} user={e.user} size={28} badge={false} />)}<span>{t('nPlayers', { n: ch.count })}</span></div>
        {ch.mine && <span class="cc-mine">{t('yourBest')} <strong>{Math.round(ch.mine.accuracy * 100)}%</strong></span>}
      </div>
      <div class="btn-row">
        <Button color="orange" icon="mic" onClick={() => playSong(ch.song, { challenge: ch.song })}>{ch.mine ? t('challengeAgain') : t('playChallenge')}</Button>
        <Button kind="secondary" onClick={() => push('challenge')}>{t('leaderboard')}</Button>
      </div>
    </div>
  );
}

/** Play: the daily tune, the weekly song, the boards, and what people are proud of. */
function Play({ active }) {
  const [data, setData] = useState(null);
  useEffect(() => { if (active) C.stage().then(setData).catch(() => {}); }, [active]);
  if (!data) return <div class="loading"><Mascot mood="think" size={70} /></div>;
  return (
    <>
      <DailyCard d={data.daily} />
      <ChallengeCard ch={data.challenge} />
      <List>
        <Row icon="trophy" color="orange" title={t('leaderboard')} subtitle={t('leaderboardSub')} onClick={() => push('leaderboard')} />
        <Row icon="gift" color="violet" title={t('rewards')} subtitle={t('rewardsRowSub')} onClick={() => push('wallet')} />
      </List>
      <Section title={t('winsAndShares')} action={<button type="button" onClick={() => openSheet('compose', { type: 'show' })}>{t('shareWin')}</button>}>
        {data.wins.length ? <div class="post-list">{data.wins.map((p) => <PostCard key={p.id} p={p} compact />)}</div> : <p class="note-text">{t('noWinsYet')}</p>}
      </Section>
    </>
  );
}

const SORTS = {
  request: [['wanted', 'sortWanted'], ['new', 'sortNew'], ['reward', 'sortReward']],
  share: [['popular', 'sortPopular'], ['new', 'sortNew']],
  question: [['new', 'sortNew'], ['active', 'sortActive']],
};

function PostList({ type, active, mine = false }) {
  const s = useApp();
  const [status, setStatus] = useState(type === 'share' ? 'all' : 'open');
  const [sort, setSort] = useState(SORTS[type][0][0]);
  const [mineInst, setMineInst] = useState(mine);
  const [qtext, setQ] = useState('');
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const timer = useRef(null);
  useEffect(() => { if (mine) setMineInst(true); }, [mine]);
  const inst = mineInst ? (s.me?.instruments?.[0] || s.settings.instrument) : '';
  const params = (offset = 0) => ({ type, status: type === 'share' ? '' : status, sort, instrument: inst, q: qtext, offset, limit: 20 });
  const load = async (offset = 0) => {
    const r = await attempt(() => C.posts(params(offset)), { quiet: offset === 0 && items !== null });
    if (!r) { if (items === null) setItems([]); return; }
    setItems((old) => (offset ? [...(old || []), ...r.items] : r.items));
    setNext(r.next);
  };
  useEffect(() => { if (active) load(0); }, [active, status, sort, inst]);
  useEffect(() => { clearTimeout(timer.current); timer.current = setTimeout(() => active && load(0), 350); return () => clearTimeout(timer.current); }, [qtext]);
  const newLabel = { request: 'requestSong', share: 'shareScore', question: 'askQuestion' }[type];
  return (
    <>
      <div class="list-tools">
        <label class="search" for={`search-${type}`}><Icon name="search" size={18} /><input id={`search-${type}`} type="search" placeholder={t(type === 'share' ? 'searchLibrary' : 'searchPosts')} value={qtext} onInput={(e) => setQ(e.currentTarget.value)} /></label>
        <Button small icon="plus" onClick={() => openSheet('compose', { type })}>{t(newLabel)}</Button>
      </div>
      <div class="chips">
        {type !== 'share' && <>
          <Chip on={status === 'open'} onClick={() => setStatus('open')}>{t('open')}</Chip>
          <Chip on={status === 'done'} onClick={() => setStatus('done')}>{t(type === 'request' ? 'delivered' : 'answered')}</Chip>
        </>}
        <Chip on={mineInst} onClick={() => setMineInst(!mineInst)}><Icon name="violin" size={14} /> {t('myInstrument')}</Chip>
        {SORTS[type].map(([v, l]) => <Chip key={v} on={sort === v} onClick={() => setSort(v)}>{t(l)}</Chip>)}
      </div>
      {type === 'share' && <p class="note-text">{t('libraryNote')}</p>}
      {type === 'request' && mineInst && <div class="banner"><Icon name="pencil" size={18} stroke={2.2} /><div class="sub">{t('helpWriteHint')} <button type="button" class="link" onClick={() => openSheet('stageGuide', { topic: 'help' })}>{t('howItWorks')}</button></div></div>}
      {items === null ? <div class="loading"><Mascot mood="think" size={70} /></div>
        : items.length ? <div class="post-list">{items.map((p) => <PostCard key={p.id} p={p} />)}</div>
          : <Empty icon={type === 'share' ? 'staff' : type === 'question' ? 'quiz' : 'flag'} title={t(qtext ? 'noResults' : 'nothingHereYet', { q: qtext })} sub={t(`empty_${type}`)}>
            <Button icon="plus" onClick={() => openSheet('compose', { type })}>{t(newLabel)}</Button>
          </Empty>}
      {next !== null && items?.length > 0 && <Button kind="secondary" full onClick={() => load(next)}>{t('loadMore')}</Button>}
    </>
  );
}
