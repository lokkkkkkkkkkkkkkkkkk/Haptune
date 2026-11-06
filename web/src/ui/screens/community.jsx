// The Community tab: the heart of Haptune. People ask for the score of any song (from a YouTube link or a
// photo of a page), others make it and earn credits; there are questions and answers, a library of shared
// scores, practice wins, a weekly challenge, leaderboards, and the Academy ("Learn").
import { useState, useEffect, useRef } from 'preact/hooks';
import { useApp, push, openSheet, setState, addSongbookSong, toast } from '../state.js';
import { t, instrumentName } from '../../core/i18n.js';
import { Icon, Chip, Button, Section, Card, Segmented, Empty } from '../components.jsx';
import { LargeTitle } from './common.jsx';
import { Mascot } from '../mascot.jsx';
import { hasServer } from '../api.js';
import { C, ensureAccount, attempt } from '../account.js';
import { AcademyBody } from './academy.jsx';
import { PostCard, Person, Coins, timeLeft } from './social.jsx';

const SEGMENTS = [
  { value: 'home', label: 'segForYou' }, { value: 'requests', label: 'segRequests' }, { value: 'library', label: 'segLibrary' },
  { value: 'questions', label: 'segQuestions' }, { value: 'learn', label: 'segLearn' },
];

export function CommunityView({ active }) {
  const s = useApp();
  const seg = s.communitySeg || 'home';
  const online = hasServer();
  useEffect(() => { if (active && online) ensureAccount(); }, [active]);
  const actions = online ? <>
    <button type="button" class="head-btn" onClick={() => push('wallet')} aria-label={t('credits')}><Coins n={s.me?.credits ?? '·'} size="sm" /></button>
    <button type="button" class="head-btn bell" onClick={() => push('notifications')} aria-label={t('notifications')}>
      <Icon name="bell" size={22} />{s.me?.unread > 0 && <span class="dot">{s.me.unread > 9 ? '9+' : s.me.unread}</span>}
    </button>
  </> : null;
  return (
    <div class="scroll">
      <div class="wrap">
        <LargeTitle title={t('community')} eyebrow={t('communityEyebrow')} color="purple" actions={actions} />
        <div class="seg-scroll"><Segmented id="community-seg" value={seg} onChange={(v) => setState({ communitySeg: v })} options={SEGMENTS.map((o) => ({ value: o.value, label: t(o.label) }))} /></div>
        {seg === 'learn' ? <AcademyBody active={active} />
          : !online ? <Offline />
            : seg === 'home' ? <ForYou active={active} />
              : seg === 'requests' ? <PostList key="r" type="request" active={active} />
                : seg === 'library' ? <PostList key="l" type="share" active={active} />
                  : <PostList key="q" type="question" active={active} />}
      </div>
    </div>
  );
}

function Offline() {
  return <Empty icon="globe" title={t('communityOffline')} sub={t('communityOfflineSub')} />;
}

/** "Can't find a score? Ask": the first thing people see. */
function AskHero() {
  return (
    <div class="ask-hero fade-up">
      <div class="ask-text">
        <h2>{t('askHeroTitle')}</h2>
        <p>{t('askHeroSub')}</p>
        <div class="btn-row">
          <Button color="pink" icon="flag" onClick={() => openSheet('compose', { type: 'request' })}>{t('askForSong')}</Button>
          <Button kind="secondary" icon="quiz" onClick={() => openSheet('compose', { type: 'question' })}>{t('askQuestion')}</Button>
        </div>
      </div>
      <span class="ask-mascot"><Mascot mood="wave" size={92} /></span>
    </div>
  );
}

function ForYou({ active }) {
  const s = useApp();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = async () => {
    try { setData(await C.home()); setErr(''); } catch (e) { setErr(e.message); }
  };
  useEffect(() => { if (active) load(); }, [active, s.me?.id]);
  if (err && !data) return <><AskHero /><Card><p class="sub">{err}</p><Button kind="secondary" onClick={load}>{t('tryAgain')}</Button></Card></>;
  if (!data) return <><AskHero /><div class="loading"><Mascot mood="think" size={70} /></div></>;
  const mine = s.me?.instruments || [];
  return (
    <>
      <AskHero />
      <div class="stat-strip">
        <div><strong class="num">{data.counts.open_requests}</strong><span>{t('openRequests')}</span></div>
        <div><strong class="num">{data.counts.helped_week}</strong><span>{t('helpedThisWeek')}</span></div>
        <div><strong class="num">{data.counts.members}</strong><span>{t('members')}</span></div>
      </div>
      <ChallengeCard ch={data.challenge} />
      {data.spotlight.length > 0 && (
        <Section title={t('spotlight')}>
          <div class="hscroll cards">{data.spotlight.map((p) => <PostCard key={p.id} p={p} compact />)}</div>
        </Section>
      )}
      {mine.length > 0 && data.for_you.length > 0 && (
        <Section title={t('helpWantedFor', { inst: mine.map(instrumentName).join(', ') })} action={<button type="button" class="link" onClick={() => setState({ communitySeg: 'requests' })}>{t('seeAll')}</button>}>
          <div class="post-list">{data.for_you.map((p) => <PostCard key={p.id} p={p} compact />)}</div>
        </Section>
      )}
      {!mine.length && (
        <Card class="tip-card" onClick={() => push('editProfile')}>
          <div class="report-line"><Icon name="violin" size={22} /><p class="sub">{t('setInstrumentsTip')}</p><Icon name="chevronR" size={14} /></div>
        </Card>
      )}
      <Section title={t('newRequests')} action={<button type="button" class="link" onClick={() => setState({ communitySeg: 'requests' })}>{t('seeAll')}</button>}>
        {data.new_requests.length ? <div class="post-list">{data.new_requests.map((p) => <PostCard key={p.id} p={p} compact />)}</div>
          : <Empty icon="flag" title={t('noRequestsYet')} sub={t('noRequestsYetSub')} />}
      </Section>
      {data.helpers.length > 0 && (
        <Section title={t('topHelpersWeek')} action={<button type="button" class="link" onClick={() => push('leaderboard')}>{t('leaderboard')}</button>}>
          <div class="helpers-strip">
            {data.helpers.map((h) => (
              <button type="button" key={h.user.id} class="helper" onClick={() => h.user.handle && push('profile', { handle: h.user.handle })}>
                <span class="rank">{h.rank <= 3 ? ['🥇', '🥈', '🥉'][h.rank - 1] : h.rank}</span>
                <Person user={h.user} size={46} />
                <strong>{h.user.name}</strong>
                <Coins n={h.value} size="sm" />
              </button>
            ))}
          </div>
        </Section>
      )}
      {data.recently_done.length > 0 && (
        <Section title={t('recentlyDelivered')}>
          <div class="post-list">{data.recently_done.map((p) => <PostCard key={p.id} p={p} compact />)}</div>
        </Section>
      )}
      {data.shows.length > 0 && (
        <Section title={t('winsAndShares')}>
          <div class="post-list">{data.shows.map((p) => <PostCard key={p.id} p={p} compact />)}</div>
        </Section>
      )}
      {data.questions.length > 0 && (
        <Section title={t('questionsWaiting')} action={<button type="button" class="link" onClick={() => setState({ communitySeg: 'questions' })}>{t('seeAll')}</button>}>
          <div class="post-list">{data.questions.map((p) => <PostCard key={p.id} p={p} compact />)}</div>
        </Section>
      )}
      <div class="community-foot">
        <button type="button" class="link" onClick={() => push('help', { topic: 'community' })}>{t('howItWorks')}</button> ·
        <button type="button" class="link" onClick={() => openSheet('guidelines')}>{t('guidelines')}</button>
      </div>
    </>
  );
}

/** This week's song: play it with Play Along, best accuracy wins credits. */
export function ChallengeCard({ ch }) {
  if (!ch) return null;
  const play = async () => {
    const rec = await addSongbookSong(ch.song, { silent: true });
    if (!rec) { toast(t('challengeMissing'), 'err'); return; }
    push('piece', { id: rec.id, start: 'playAlong', challenge: ch.song }, 'community');
  };
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
        <Button color="orange" icon="mic" onClick={play}>{ch.mine ? t('challengeAgain') : t('playChallenge')}</Button>
        <Button kind="secondary" onClick={() => push('challenge')}>{t('leaderboard')}</Button>
      </div>
    </div>
  );
}

const SORTS = {
  request: [['new', 'sortNew'], ['wanted', 'sortWanted'], ['reward', 'sortReward']],
  share: [['popular', 'sortPopular'], ['new', 'sortNew']],
  question: [['new', 'sortNew'], ['active', 'sortActive']],
};

function PostList({ type, active }) {
  const s = useApp();
  const [status, setStatus] = useState(type === 'share' ? 'all' : 'open');
  const [sort, setSort] = useState(SORTS[type][0][0]);
  const [mineInst, setMineInst] = useState(false);
  const [qtext, setQ] = useState('');
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const timer = useRef(null);
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
  const newLabel = { request: 'askForSong', share: 'shareScore', question: 'askQuestion' }[type];
  return (
    <>
      <div class="list-tools">
        <label class="search" for={`search-${type}`}><Icon name="search" size={18} /><input id={`search-${type}`} type="search" placeholder={t(type === 'share' ? 'searchLibrary' : 'searchPosts')} value={qtext} onInput={(e) => setQ(e.currentTarget.value)} /></label>
        <Button small icon="plus" color={type === 'request' ? 'pink' : type === 'share' ? 'green' : 'blue'} onClick={() => openSheet('compose', { type })}>{t(newLabel)}</Button>
      </div>
      <div class="chips">
        {type !== 'share' && <>
          <Chip on={status === 'open'} onClick={() => setStatus('open')}>{t('open')}</Chip>
          <Chip on={status === 'done'} onClick={() => setStatus('done')}>{t(type === 'request' ? 'delivered' : 'answered')}</Chip>
        </>}
        <Chip on={mineInst} color="purple" onClick={() => setMineInst(!mineInst)}><Icon name="violin" size={14} /> {t('myInstrument')}</Chip>
        {SORTS[type].map(([v, l]) => <Chip key={v} on={sort === v} color="blue" onClick={() => setSort(v)}>{t(l)}</Chip>)}
      </div>
      {type === 'share' && <p class="note-text">{t('libraryNote')}</p>}
      {items === null ? <div class="loading"><Mascot mood="think" size={70} /></div>
        : items.length ? <div class="post-list">{items.map((p) => <PostCard key={p.id} p={p} />)}</div>
          : <Empty icon={type === 'share' ? 'staff' : type === 'question' ? 'quiz' : 'flag'} title={t(qtext ? 'noResults' : 'nothingHereYet', { q: qtext })} sub={t(`empty_${type}`)}>
            <Button icon="plus" onClick={() => openSheet('compose', { type })}>{t(newLabel)}</Button>
          </Empty>}
      {next !== null && items?.length > 0 && <Button kind="secondary" full onClick={() => load(next)}>{t('loadMore')}</Button>}
    </>
  );
}
