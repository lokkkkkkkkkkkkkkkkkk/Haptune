// People: profiles with badges, leaderboards, notifications, the credits wallet, the weekly challenge page and
// editing your own profile.
import { useState, useEffect } from 'preact/hooks';
import { useApp, push, pop, openSheet, toast, addSongbookSong, updateSettings } from '../state.js';
import { t, instrumentName, INSTRUMENTS } from '../../core/i18n.js';
import { Icon, Button, Section, Card, Segmented, Chip, Empty, List, Row } from '../components.jsx';
import { NavBar, SheetFrame } from './common.jsx';
import { Mascot } from '../mascot.jsx';
import { C, attempt, ensureAccount } from '../account.js';
import { Person, PostCard, Coins, timeAgo, timeLeft, openReport } from './social.jsx';

const BADGES = {
  dev: ['bolt', 'purple'], first_help: ['heart', 'pink'], helper_5: ['users', 'blue'], helper_25: ['trophy', 'orange'],
  speedy: ['bolt', 'yellow'], five_star: ['star', 'yellow'], answerer: ['quiz', 'blue'], librarian: ['books', 'green'],
  challenger: ['flag', 'orange'], champion: ['trophy', 'yellow'], streak_7: ['flame', 'red'], teacher: ['academy', 'orange'], supporter: ['crown', 'purple'],
};

export function ProfileView({ handle, active }) {
  const s = useApp();
  const [u, setU] = useState(null);
  const [posts, setPosts] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!active) return;
    C.profile(handle).then(setU).catch((e) => setErr(e.message));
    C.posts({ author: handle, limit: 30 }).then((r) => setPosts(r.items)).catch(() => setPosts([]));
  }, [active, handle]);
  if (!u) return <div class="scroll"><NavBar title="" backLabel={t('back')} /><div class="wrap">{err ? <p class="sub">{err}</p> : <div class="loading"><Mascot mood="think" size={70} /></div>}</div></div>;
  const toggle = async (fn) => { const r = await attempt(fn); if (r) setU(r); };
  const st = u.stats;
  return (
    <div class="scroll">
      <NavBar title={u.name} backLabel={t('back')} actions={!u.is_me && <button type="button" class="nav-btn" aria-label={t('more')} onClick={() => openSheet('more', { items: [
        { icon: 'flag', color: 'orange', label: t('report'), onClick: () => openReport(`u:${u.handle}`, u.name) },
        { icon: 'close', color: 'red', label: u.is_blocked ? t('unblock') : t('blockPerson', { name: u.name }), onClick: () => toggle(() => C.block(u.handle, !u.is_blocked)) },
      ] })}><Icon name="more" size={22} /></button>} />
      <div class="wrap">
        <div class="profile-head fade-up">
          <Person user={u} size={84} />
          <h1>{u.name}</h1>
          <p class="sub">@{u.handle} · {t('joined')} {timeAgo(u.joined)}</p>
          {u.instruments?.length > 0 && <p class="sub">{u.instruments.map(instrumentName).join(' · ')}{u.level ? ` · ${t(u.level)}` : ''}</p>}
          {u.bio && <p class="bio">{u.bio}</p>}
          <div class="follow-row"><span><strong class="num">{u.followers}</strong> {t('followers')}</span><span><strong class="num">{u.following}</strong> {t('following')}</span></div>
          {u.is_me ? <Button kind="secondary" icon="pencil" onClick={() => push('editProfile')}>{t('editProfile')}</Button>
            : <Button kind={u.is_following ? 'secondary' : 'primary'} icon={u.is_following ? 'check' : 'plus'} onClick={() => toggle(() => C.follow(u.handle, !u.is_following))}>{u.is_following ? t('followingBtn') : t('follow')}</Button>}
        </div>
        <div class="stat-grid">
          <div><strong class="num">{st.helps}</strong><span>{t('scoresMade')}</span></div>
          <div><strong class="num">{st.rating ? `${st.rating}★` : '–'}</strong><span>{t('avgRating')}</span></div>
          <div><strong class="num">{st.answers}</strong><span>{t('answersAccepted')}</span></div>
          <div><strong class="num">{st.shares}</strong><span>{t('scoresShared')}</span></div>
          <div><strong class="num">{st.streak}</strong><span>{t('dayStreak')}</span></div>
          <div><Coins n={st.earned} /><span>{t('earnedHelping')}</span></div>
        </div>
        {u.badges.length > 0 && (
          <Section title={t('badges')}>
            <div class="badge-row">{u.badges.map((b) => (
              <span key={b} class={`badge-chip c-${(BADGES[b] || ['star', 'gray'])[1]}`}><Icon name={(BADGES[b] || ['star'])[0]} size={16} stroke={2.3} />{t(`badge_${b}`)}</span>
            ))}</div>
          </Section>
        )}
        <Section title={t('posts')}>
          {posts === null ? <div class="loading"><div class="spinner" /></div> : posts.length ? <div class="post-list">{posts.map((p) => <PostCard key={p.id} p={p} compact />)}</div> : <p class="note-text">{t('noPostsYet')}</p>}
        </Section>
      </div>
    </div>
  );
}

export function LeaderboardView({ active, board: b0 = 'helpers' }) {
  const [board, setBoard] = useState(b0);
  const [period, setPeriod] = useState('week');
  const [data, setData] = useState(null);
  useEffect(() => { if (active) { setData(null); C.leaderboard(board, board === 'challenge' ? 'week' : period).then(setData).catch(() => setData({ items: [] })); } }, [active, board, period]);
  const fmt = (v) => (board === 'challenge' ? `${Math.round(v * 100)}%` : board === 'practice' ? `${v} ${t('min')}` : v);
  return (
    <div class="scroll">
      <NavBar title={t('leaderboard')} backLabel={t('community')} color="orange" />
      <div class="wrap">
        <Segmented value={board} onChange={setBoard} options={[{ value: 'helpers', label: t('lbHelpers') }, { value: 'practice', label: t('lbPractice') }, { value: 'challenge', label: t('lbChallenge') }]} />
        {board !== 'challenge' && <div class="chips">{[['week', 'thisWeek'], ['month', 'thisMonth'], ['all', 'allTime']].map(([v, l]) => <Chip key={v} on={period === v} onClick={() => setPeriod(v)}>{t(l)}</Chip>)}</div>}
        <p class="note-text">{t(`lbNote_${board}`)}</p>
        {!data ? <div class="loading"><Mascot mood="think" size={70} /></div> : data.items.length ? (
          <div class="lb">
            {data.items.map((x) => (
              <button type="button" key={x.user.id} class={`lb-row${data.me?.user.id === x.user.id ? ' me' : ''}`} onClick={() => x.user.handle && push('profile', { handle: x.user.handle })}>
                <span class="lb-rank">{x.rank <= 3 ? ['🥇', '🥈', '🥉'][x.rank - 1] : x.rank}</span>
                <Person user={x.user} size={36} />
                <span class="lb-name"><strong>{x.user.name}</strong><span>@{x.user.handle}</span></span>
                <span class="lb-val num">{board === 'helpers' ? <Coins n={x.value} size="sm" /> : fmt(x.value)}</span>
              </button>
            ))}
          </div>
        ) : <Empty icon="trophy" title={t('lbEmpty')} sub={t('lbEmptySub')} />}
      </div>
    </div>
  );
}

const NOTE_ICON = {
  submission: ['staff', 'green'], accepted: ['check', 'green'], changes: ['pencil', 'orange'], helpful: ['heart', 'pink'], comment: ['chat', 'blue'],
  answer: ['quiz', 'blue'], want: ['users', 'purple'], follow: ['plus', 'purple'], ready: ['bell', 'green'], challenge: ['trophy', 'yellow'],
  credits: ['star', 'yellow'], mod: ['info', 'red'], claim: ['pencil', 'orange'], like: ['heart', 'pink'], new_post: ['bell', 'blue'],
  expired: ['info', 'gray'], plan: ['crown', 'purple'], published: ['books', 'green'],
};

export function NotificationsView({ active }) {
  const [items, setItems] = useState(null);
  useEffect(() => {
    if (!active) return;
    C.notifications().then((r) => { setItems(r.items); if (r.items.some((n) => !n.read)) C.readNotifications().then(() => ensureAccount({ fresh: true })).catch(() => {}); }).catch(() => setItems([]));
  }, [active]);
  return (
    <div class="scroll">
      <NavBar title={t('notifications')} backLabel={t('community')} color="purple" />
      <div class="wrap">
        {!items ? <div class="loading"><Mascot mood="think" size={70} /></div> : items.length ? (
          <div class="notes">
            {items.map((n) => {
              const [icon, color] = NOTE_ICON[n.kind] || ['bell', 'gray'];
              const open = () => (n.post_id ? push('post', { id: n.post_id }) : n.actor?.handle ? push('profile', { handle: n.actor.handle }) : n.kind === 'credits' ? push('wallet') : null);
              return (
                <button type="button" key={n.id} class={`note-row${n.read ? '' : ' unread'}`} onClick={open}>
                  {n.actor ? <Person user={n.actor} size={38} /> : <span class={`note-ic c-${color}`}><Icon name={icon} size={18} stroke={2.2} /></span>}
                  <span class="note-main"><span>{t(`n_${n.kind}`, { name: n.actor?.name || '', title: n.post_title || '', credits: n.data.credits ?? n.data.amount ?? '', place: n.data.place || '', tier: n.data.tier || '' })}</span>
                    <span class="sub">{timeAgo(n.at)}</span></span>
                </button>
              );
            })}
          </div>
        ) : <Empty icon="bell" title={t('noNotifications')} sub={t('noNotificationsSub')} />}
      </div>
    </div>
  );
}

const REASON = { welcome: 'r_welcome', practice: 'r_practice', help: 'r_help', help_pot: 'r_help_pot', helpful: 'r_helpful', answer: 'r_answer', pot: 'r_pot', refund: 'r_refund',
  share: 'r_share', saved: 'r_saved', challenge: 'r_challenge', challenge_top: 'r_challenge_top', plan_bonus: 'r_plan_bonus', spotlight: 'r_spotlight', plus_week: 'r_plus_week', admin: 'r_admin' };

export function WalletView({ active }) {
  const s = useApp();
  const [w, setW] = useState(null);
  const load = () => C.wallet().then(setW).catch(() => setW(null));
  useEffect(() => { if (active) load(); }, [active]);
  const redeem = async () => { const r = await attempt(() => C.plusWeek()); if (r) { toast(t('plusWeekOn')); load(); } };
  const rules = w?.rules;
  return (
    <div class="scroll">
      <NavBar title={t('credits')} backLabel={t('community')} color="yellow" />
      <div class="wrap">
        <div class="wallet-hero fade-up">
          <Coins n={w?.credits ?? s.me?.credits ?? 0} size="xl" />
          <p>{t('creditsBlurb')}</p>
        </div>
        {rules && <>
          <Section title={t('howToEarn')}>
            <List>
              <Row icon="staff" color="green" title={t('earnRequest')} subtitle={t('earnRequestSub', { max: rules.bonus_cap })} />
              <Row icon="quiz" color="blue" title={t('earnAnswer')} subtitle={t('earnAnswerSub', { n: rules.answer })} />
              <Row icon="heart" color="pink" title={t('earnHelpful')} subtitle={t('earnHelpfulSub', { n: rules.helpful_comment, m: rules.runner_up_cap })} />
              <Row icon="books" color="green" title={t('earnShare')} subtitle={t('earnShareSub', { n: rules.share, m: rules.share_saved })} />
              <Row icon="flame" color="red" title={t('earnPractice')} subtitle={t('earnPracticeSub', { n: rules.daily_practice, m: rules.streak_week })} />
              <Row icon="trophy" color="orange" title={t('earnChallenge')} subtitle={t('earnChallengeSub', { n: rules.challenge_entry, a: rules.challenge_top[0] })} />
            </List>
          </Section>
          <Section title={t('howToSpend')} footer={t('noCashOut')}>
            <List>
              <Row icon="flag" color="pink" title={t('spendReward')} subtitle={t('spendRewardSub')} />
              <Row icon="star" color="yellow" title={t('spendSpotlight')} subtitle={t('spendSpotlightSub', { n: rules.spotlight_cost })} />
              <Row icon="crown" color="purple" title={t('spendPlus', { n: rules.plus_week_cost })} subtitle={w.plus_week_available ? t('spendPlusSub') : t('spendPlusUsed')}
                right={<Button small color="purple" disabled={!w.plus_week_available || (w.credits < rules.plus_week_cost)} onClick={redeem}>{t('redeem')}</Button>} />
            </List>
          </Section>
        </>}
        <Section title={t('history')}>
          {w?.history?.length ? <List>{w.history.map((h, i) => (
            <Row key={i} title={t(REASON[h.reason] || 'r_other')} subtitle={[h.note, timeAgo(h.at)].filter(Boolean).join(' · ')}
              right={<span class={`num ${h.delta >= 0 ? 't-green' : 't-red'}`}>{h.delta > 0 ? '+' : ''}{h.delta}</span>} />
          ))}</List> : <p class="note-text">{t('noHistory')}</p>}
        </Section>
        <button type="button" class="link" onClick={() => push('help', { topic: 'credits' })}>{t('creditsFaq')}</button>
      </div>
    </div>
  );
}

export function ChallengeView({ active }) {
  const [ch, setCh] = useState(null);
  useEffect(() => { if (active) C.challenge().then(setCh).catch(() => setCh(null)); }, [active]);
  const play = async () => {
    const rec = await addSongbookSong(ch.song, { silent: true });
    if (rec) push('piece', { id: rec.id, start: 'playAlong', challenge: ch.song });
  };
  return (
    <div class="scroll">
      <NavBar title={t('weeklyChallenge')} backLabel={t('community')} color="orange" />
      <div class="wrap">
        {!ch ? <div class="loading"><Mascot mood="think" size={70} /></div> : <>
          <div class="challenge-card big">
            <div class="cc-top"><span class="cc-badge"><Icon name="trophy" size={18} />{t('weeklyChallenge')}</span><span class="cc-left">{timeLeft(ch.ends)}</span></div>
            <h3>{ch.title}</h3>
            <p>{t('challengeRules', { n: ch.rewards.entry, a: ch.rewards.top[0], b: ch.rewards.top[1], c: ch.rewards.top[2] })}</p>
            <Button color="orange" icon="mic" onClick={play}>{ch.mine ? t('challengeAgain') : t('playChallenge')}</Button>
          </div>
          <Section title={t('thisWeek')}>
            {ch.entries.length ? <div class="lb">{ch.entries.map((e, i) => (
              <button type="button" key={e.user.id} class="lb-row" onClick={() => e.user.handle && push('profile', { handle: e.user.handle })}>
                <span class="lb-rank">{i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</span><Person user={e.user} size={34} />
                <span class="lb-name"><strong>{e.user.name}</strong><span>{e.tempo_pct}% {t('speed').toLowerCase()}</span></span>
                <span class="lb-val num t-green">{Math.round(e.accuracy * 100)}%</span>
              </button>))}</div> : <p class="note-text">{t('beFirst')}</p>}
          </Section>
          {ch.last_week.winners.length > 0 && (
            <Section title={t('lastWeek', { song: ch.last_week.song })}>
              <div class="helpers-strip">{ch.last_week.winners.map((e, i) => (
                <div class="helper" key={e.user.id}><span class="rank">{['🥇', '🥈', '🥉'][i]}</span><Person user={e.user} size={44} /><strong>{e.user.name}</strong><span class="num">{Math.round(e.accuracy * 100)}%</span></div>
              ))}</div>
            </Section>
          )}
        </>}
      </div>
    </div>
  );
}

const COLORS = ['purple', 'pink', 'blue', 'green', 'orange', 'teal', 'indigo', 'red'];
const EMOJI = ['', '🎻', '🎹', '🎸', '🎤', '🥁', '🎺', '🎷', '🪕', '🎵', '🐱', '🦊', '🐼', '🌸', '⭐', '🔥'];

export function EditProfileView() {
  const s = useApp();
  const me = s.me;
  const [name, setName] = useState(me?.name || s.settings.name || '');
  const [handle, setHandle] = useState(me?.handle || '');
  const [bio, setBio] = useState(me?.bio || '');
  const [insts, setInsts] = useState(me?.instruments?.length ? me.instruments : [s.settings.instrument]);
  const [level, setLevel] = useState(me?.level || '');
  const [color, setColor] = useState(me?.avatar?.color || 'purple');
  const [emoji, setEmoji] = useState(me?.avatar?.emoji || '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { ensureAccount(); }, []);
  const save = async () => {
    setBusy(true);
    const body = { name: name.trim() || 'Musician', bio, instruments: insts, level, avatar: { color, emoji } };
    if (handle && handle !== me?.handle) body.handle = handle;
    const r = await attempt(() => C.update(body));
    setBusy(false);
    if (r) { updateSettings({ name: r.name, instrument: insts[0] || s.settings.instrument }); toast(t('saved')); pop(); }
  };
  const preview = { name: name || 'Musician', avatar: { color, emoji }, badge: me?.badge };
  return (
    <div class="scroll">
      <NavBar title={t('editProfile')} backLabel={t('back')} actions={<button type="button" class="nav-btn text" disabled={busy} onClick={save}>{t('save')}</button>} />
      <div class="wrap">
        <div class="profile-head"><Person user={preview} size={84} /></div>
        <label class="field-label">{t('colour')}</label>
        <div class="color-pick">{COLORS.map((c) => <button type="button" key={c} class={`swatch c-${c}${color === c ? ' on' : ''}`} onClick={() => setColor(c)} aria-label={c} />)}</div>
        <label class="field-label">{t('emoji')}</label>
        <div class="emoji-pick">{EMOJI.map((e) => <button type="button" key={e || 'none'} class={emoji === e ? 'on' : ''} onClick={() => setEmoji(e)}>{e || 'Aa'}</button>)}</div>
        <label class="field-label" for="ep-name">{t('yourName')}</label>
        <input class="field" id="ep-name" maxLength={60} value={name} onInput={(e) => setName(e.currentTarget.value)} />
        <label class="field-label" for="ep-handle">{t('username')}</label>
        <input class="field" id="ep-handle" maxLength={20} value={handle} onInput={(e) => setHandle(e.currentTarget.value.toLowerCase().replace(/[^a-z0-9_.]/g, ''))} autocapitalize="off" />
        <label class="field-label">{t('instruments')}</label>
        <div class="chips wrap">{INSTRUMENTS.map((i) => <Chip key={i} on={insts.includes(i)} onClick={() => setInsts((x) => (x.includes(i) ? x.filter((y) => y !== i) : [...x, i].slice(-4)))}>{instrumentName(i)}</Chip>)}</div>
        <label class="field-label">{t('level')}</label>
        <div class="chips wrap">{['beginner', 'intermediate', 'advanced', 'teacher'].map((l) => <Chip key={l} on={level === l} onClick={() => setLevel(level === l ? '' : l)}>{t(l)}</Chip>)}</div>
        <label class="field-label" for="ep-bio">{t('aboutYou')}</label>
        <textarea class="textarea" id="ep-bio" rows="3" maxLength={300} value={bio} onInput={(e) => setBio(e.currentTarget.value)} placeholder={t('aboutYouExample')} />
        <Button full disabled={busy} onClick={save}>{t('save')}</Button>
      </div>
    </div>
  );
}
