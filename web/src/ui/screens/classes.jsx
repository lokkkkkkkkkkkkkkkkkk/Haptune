// Classes: learn with a teacher at your own pace. A teacher sets assignments with a time window (opens / due);
// students practise whenever they like inside it, hand in their Play Along results, and get stickers, comments
// and the bars to work on. Each class has an activity feed and a weekly leaderboard.
import { useState, useEffect } from 'preact/hooks';
import { useApp, push, pop, go, openSheet, closeSheet, toast, getPiece, addScore, addXP, setState, updateSettings, goLearn } from '../state.js';
import { t, getLang, instrumentName } from '../../core/i18n.js';
import { Icon, Card, Section, List, Row, Button, Badge, Segmented, Chip, Stepper, Rings } from '../components.jsx';
import { NavBar, SheetFrame } from './common.jsx';
import { Mascot, Confetti } from '../mascot.jsx';
import { hasServer, academyMe, academy } from '../api.js';
import { local } from '../storage.js';
import { parseMusicXML, writeMusicXML } from '../../core/musicxml.js';
import { partChoices } from '../../core/score.js';
import { StreamPanel, ClassworkPanel, PeoplePanel, GradesPanel, VoiceNote } from './classroom.jsx';

const STICKERS = [['star', '⭐'], ['fire', '🔥'], ['clap', '👏'], ['heart', '❤️'], ['rocket', '🚀'], ['trophy', '🏆'], ['music', '🎵'], ['thumbs', '👍']];
const EMOJI = Object.fromEntries(STICKERS);
const STATUS = { open: ['st_open', 'blue'], 'due-soon': ['st_dueSoon', 'orange'], late: ['st_late', 'red'], done: ['st_done', 'green'], tried: ['st_tried', 'purple'], upcoming: ['st_upcoming', 'gray'] };
const CLASS_COLORS = ['orange', 'pink', 'purple', 'blue', 'teal', 'green'];
const MEDALS = ['🥇', '🥈', '🥉'];

/** Call after any change so open class screens reload. */
export const refreshClasses = () => setState((s) => ({ academyRev: (s.academyRev || 0) + 1 }));
const hasProfile = () => !!local.get('academyToken', '');
const myId = () => local.get('academyUser', null)?.id;
const realName = (n) => (n && n !== 'Alex' ? n : '');

/** Makes (or reuses) this device's Academy profile under the given name. */
async function ensureProfile(name) {
  const r = await academyMe(name);
  if (name && r.user?.name !== name) await academy.rename(name);
  if (name) updateSettings({ name });
  return r;
}

/** "in 3 days", "tomorrow", "2 hours ago", in the app language. */
export function relTime(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  let rtf;
  try { rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: 'auto' }); } catch { return new Date(iso).toLocaleDateString(); }
  if (abs < 3600e3) return rtf.format(Math.round(ms / 60e3), 'minute');
  if (abs < 86400e3) return rtf.format(Math.round(ms / 3600e3), 'hour');
  if (abs < 14 * 86400e3) return rtf.format(Math.round(ms / 86400e3), 'day');
  return rtf.format(Math.round(ms / (7 * 86400e3)), 'week');
}
export function dueText(a) {
  const now = Date.now();
  if (a.opens_at && new Date(a.opens_at).getTime() > now) return t('opensWhen', { when: relTime(a.opens_at) });
  if (new Date(a.due_at).getTime() < now) return t('wasDue', { when: relTime(a.due_at) });
  return t('dueWhen', { when: relTime(a.due_at) });
}
export function StatusChip({ status }) {
  const [k, c] = STATUS[status] || STATUS.open;
  return <span class={`st-chip c-${c}`}>{t(k)}</span>;
}
export function Person({ name, color = 'blue', size = 36 }) {
  const ini = (name || '?').trim().split(/\s+/).map((w) => [...w][0]).join('').slice(0, 2).toUpperCase();
  return <span class={`person c-${color}`} style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">{ini}</span>;
}
const studentsText = (n) => (n === 1 ? t('oneStudent') : t('studentsN', { n }));
const barsText = (a) => (a.bars_from ? `${a.bars_from}–${a.bars_to || a.bars_from}` : t('wholePiece'));
const fmtCode = (c) => (c && c.length > 4 ? `${c.slice(0, 3)} ${c.slice(3)}` : c || '');

export function useLoad(fn, deps) {
  const [st, setSt] = useState({ data: null, error: '', loading: true });
  useEffect(() => {
    let alive = true;
    setSt((x) => ({ ...x, loading: true }));
    fn().then((data) => alive && setSt({ data, error: '', loading: false }))
      .catch((e) => alive && setSt((x) => ({ data: x.data, error: e.message || String(e), loading: false })));
    return () => { alive = false; };
  }, deps);
  return st;
}

export function Loading({ error }) {
  if (error) return <Card class="classes-hello"><Mascot mood="sad" size={70} /><p>{error}</p></Card>;
  return <div class="loading"><Mascot mood="think" size={64} /></div>;
}

// ---------------------------------------------------------------- Academy home: classes + to-do
export function ClassesSection({ active }) {
  const s = useApp();
  const online = hasServer();
  const [me, setMe] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!active || !online || !hasProfile()) return undefined;
    let alive = true;
    academyMe(s.settings.name).then((r) => { if (alive) { setMe(r); setErr(''); } }).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [active, s.academyRev]);

  const actions = (
    <div class="class-actions">
      <button type="button" class="class-act c-blue" onClick={() => openSheet('joinClass')} id="join-class">
        <span class="ic"><Icon name="users" size={22} stroke={2.2} /></span><span>{t('joinClass')}</span>
      </button>
      <button type="button" class="class-act c-orange" onClick={() => openSheet('newClass')} id="teach-class">
        <span class="ic"><Icon name="academy" size={22} stroke={2.2} /></span><span>{t('teachClass')}</span>
      </button>
    </div>
  );
  if (!online) {
    return <Section title={t('myClasses')}><Card class="classes-hello"><Mascot mood="sleep" size={74} /><p>{t('classesOffline')}</p></Card></Section>;
  }
  const classes = me?.classes || [];
  const todo = me?.todo || [];
  if (!hasProfile() || (me && !classes.length)) {
    return (
      <Section title={t('myClasses')}>
        <Card class="classes-hello">
          <Mascot mood="wave" size={84} />
          <div><h3>{t('noClassesYet')}</h3><p>{t('noClassesSub')}</p></div>
        </Card>
        {actions}
      </Section>
    );
  }
  return (
    <>
      {todo.length > 0 && (
        <Section title={t('toDoT')}>
          <div class="mission-list">{todo.slice(0, 6).map((a) => <MissionCard key={a.id} a={a} />)}</div>
        </Section>
      )}
      <Section title={t('myClasses')}>
        {err && !me ? <p class="note-text">{err}</p> : null}
        {!me && !err ? <Loading /> : null}
        {classes.length > 0 && (
          <List>
            {classes.map((c) => (
              <Row key={c.id} icon={c.role === 'teacher' ? 'academy' : 'users'} color={c.color} title={c.name}
                subtitle={`${c.role === 'teacher' ? t('teacherT') : t('studentT')} · ${studentsText(c.students)}`}
                right={c.to_review ? <span class="count-pill">{t('toReview', { n: c.to_review })}</span> : null}
                onClick={() => push('classView', { id: c.id })} />
            ))}
          </List>
        )}
        {actions}
      </Section>
    </>
  );
}

/** A student's assignment as a colourful card: status, due, best try against the goal. */
export function MissionCard({ a, color, onClick }) {
  const best = a.best ?? null;
  return (
    <button type="button" class={`mission c-${color || a.class_color || 'orange'}`} onClick={onClick || (() => push('assignment', { id: a.id }))}>
      <span class="m-main">
        <span class="m-top"><StatusChip status={a.status} />{a.class_name && <span class="m-class">{a.class_name}</span>}</span>
        <strong>{a.title}</strong>
        <span class="m-sub">{a.piece_title && a.piece_title !== a.title ? `${a.piece_title} · ` : ''}{dueText(a)}</span>
      </span>
      <span class="m-ring">
        <Rings size={52} width={7} rings={[{ value: best == null ? 0 : best / Math.max(1, a.goal), color: a.status === 'done' ? 'green' : 'orange' }]} />
        <span class="num">{best == null ? `${a.goal}%` : `${best}%`}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------- one class
export function ClassView({ id, tab: tab0 }) {
  const s = useApp();
  const [tab, setTab] = useState(tab0 || 'stream');
  const cls = useLoad(() => academy.classDetail(id), [id, s.academyRev]);
  const feed = useLoad(() => (tab === 'stream' ? academy.feed(id) : Promise.resolve(null)), [id, tab, s.academyRev]);
  const board = useLoad(() => (tab === 'stream' ? academy.leaderboard(id) : Promise.resolve(null)), [id, tab, s.academyRev]);
  const prog = useLoad(() => (tab === 'grades' ? academy.progress(id) : Promise.resolve(null)), [id, tab, s.academyRev]);
  const c = cls.data;
  const teacher = c?.role === 'teacher';
  useEffect(() => { if (c && !teacher && tab === 'grades') setTab('stream'); }, [c?.role]);
  const setVisibility = async (v) => { try { await academy.editClass(id, { visibility: v }); refreshClasses(); toast(v === 'public' ? t('classNowOpen') : t('classNowPrivate')); } catch (e) { if (e.detail?.code === 'teacher_unverified') openSheet('teacherVerify'); else toast(e.message, 'err'); } };
  const newCode = async () => { if (!confirm(t('newCodeConfirm'))) return; try { await academy.editClass(id, { new_code: true }); refreshClasses(); } catch (e) { toast(e.message, 'err'); } };

  const share = async () => {
    const text = t('shareCodeText', { name: c.name, code: c.join_code });
    try { if (navigator.share) { await navigator.share({ title: c.name, text }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch { toast(c.join_code); }
  };
  const leave = async () => {
    if (!confirm(teacher ? t('confirmClose') : t('confirmLeave'))) return;
    try { await academy.leave(id, myId()); refreshClasses(); pop(); } catch (e) { toast(e.message, 'err'); }
  };
  const remove = async (m) => {
    if (!confirm(t('confirmRemove', { name: m.name }))) return;
    try { await academy.leave(id, m.id); refreshClasses(); } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <div class="scroll">
      <NavBar title={c?.name || t('myClasses')} color={c?.color || 'orange'} backLabel={t('hub')} />
      <div class="wrap" style={{ paddingTop: 14 }}>
        {!c ? <Loading error={cls.error} /> : (
          <>
            <div class={`hero class-hero c-${c.color}`}>
              <div class="ch-top">
                <Badge icon={teacher ? 'academy' : 'users'} color={c.color} size={42} solid={false} />
                <div>
                  <h2>{c.name}</h2>
                  <p>{teacher ? studentsText(c.members.filter((m) => m.role === 'student').length) : `${t('teacherT')}: ${c.teacher?.name || ''}`}</p>
                </div>
              </div>
              {c.description && <p class="ch-about">{c.description}</p>}
              {c.join_code && (
                <div class="code-box">
                  <span class="lbl">{t('classCode')}</span>
                  <span class="code-val" id="class-code">{fmtCode(c.join_code)}</span>
                  <button type="button" class="btn small white" onClick={() => openSheet('classQR', { classId: id })} id="class-invite"><Icon name="link" size={16} stroke={2.2} />{t('hubInvite')}</button>
                </div>
              )}
              <div class="row-gap"><span class="pill3 on-dark"><Icon name={c.visibility === 'public' ? 'globe' : 'lock'} size={13} />{c.visibility === 'public' ? t('classOpen') : t('classPrivate')}</span>
                {c.instrument && <span class="pill3 on-dark">{instrumentName(c.instrument)}</span>}</div>
              <span class="mascot-peek"><Mascot mood={teacher ? 'cheer' : 'wave'} size={78} /></span>
            </div>

            <Segmented id="class-tabs" value={tab} onChange={(v) => (v === 'mine' ? push('student', { classId: id, uid: myId(), name: t('myProgress') }) : setTab(v))}
              options={(teacher ? [['stream', t('crStream')], ['classwork', t('crClasswork')], ['people', t('crPeople')], ['grades', t('crGrades')]]
                : [['stream', t('crStream')], ['classwork', t('crClasswork')], ['people', t('crPeople')], ['mine', t('myProgress')]]).map(([value, label]) => ({ value, label }))} />

            {tab === 'stream' && <StreamPanel cid={id} />}
            {tab === 'classwork' && <ClassworkPanel cid={id} c={c} teacher={teacher} />}
            {tab === 'grades' && teacher && <GradesPanel cid={id} c={c} />}

            {tab === 'grades' && teacher && (prog.data ? (
              prog.data.students.length ? (
                <div class="prog-table" id="progress-table">
                  <div class="pt-head"><span>{t('studentT')}</span><span>{t('avgScore')}</span><span class="pc-only">{t('thisWeek')}</span><span>{t('doneT')}</span><span /></div>
                  {prog.data.students.map((st) => (
                    <button type="button" class="pt-row" key={st.id} onClick={() => push('student', { classId: id, uid: st.id, name: st.name })}>
                      <span class="pt-who"><Person name={st.name} color={st.color} size={34} /><span><strong>{st.name}</strong><span class="tiny">{st.last ? relTime(st.last) : t('notYet')}</span></span></span>
                      <span class={`pt-acc ${st.accuracy == null ? '' : st.accuracy >= 85 ? 'good' : st.accuracy >= 60 ? 'mid' : 'low'}`}>{st.accuracy == null ? '–' : `${st.accuracy}%`}
                        {st.trend ? <small class={st.trend > 0 ? 'up' : 'down'}>{st.trend > 0 ? '▲' : '▼'}{Math.abs(st.trend)}</small> : null}</span>
                      <span class="pc-only">{t('minN', { n: st.minutes_week })} · {t('takesN', { n: st.week_takes })}</span>
                      <span>{st.done}/{st.assigned}{st.recordings ? <Icon name="mic" size={13} /> : null}</span>
                      <Icon name="chevronR" size={16} stroke={2.4} />
                    </button>
                  ))}
                </div>
              ) : <Card class="classes-hello"><Mascot mood="wave" size={70} /><p>{t('noStudentsYet')}</p><Button small icon="link" onClick={() => openSheet('classQR', { classId: id })}>{t('hubInvite')}</Button></Card>
            ) : <Loading error={prog.error} />)}

            {tab === 'stream' && <h3 class="cr-topic-name">{t('crActivity')}</h3>}
            {tab === 'stream' && (feed.data ? (
              feed.data.items.length ? (
                <div class="feed">
                  {feed.data.items.map((it, i) => (
                    <div class="feed-item" key={i}>
                      <Person name={it.who?.name} color={it.who?.color || 'gray'} />
                      <div class="fi-main">
                        <p>{it.type === 'goal' ? t('feedGoal', { name: it.who.name, a: it.assignment })
                          : it.type === 'practice' ? t('feedPractice', { name: it.who.name, a: it.assignment })
                            : t('feedFeedback', { name: it.who.name })}</p>
                        <span class="fi-meta">
                          {relTime(it.at)}
                          {it.accuracy != null && <b> · {it.accuracy}%</b>}
                          {it.points ? <b class="pts"> · +{it.points}</b> : null}
                          {it.stickers?.length ? <span class="fi-stk"> {it.stickers.map((k) => EMOJI[k]).join(' ')}</span> : null}
                        </span>
                      </div>
                      {it.type === 'goal' && <span class="fi-badge" aria-hidden="true">🏆</span>}
                    </div>
                  ))}
                </div>
              ) : <Card class="classes-hello"><Mascot mood="sleep" size={64} /><p>{t('feedEmpty')}</p></Card>
            ) : <Loading error={feed.error} />)}

            {tab === 'stream' && <h3 class="cr-topic-name">{t('leaderboardT')}</h3>}
            {tab === 'stream' && (board.data ? (
              <div class="board">
                {board.data.board.map((b) => (
                  <div class={`board-row${b.me ? ' me' : ''}${b.rank <= 3 && b.points > 0 ? ' top' : ''}`} key={b.id}>
                    <span class="rank">{b.rank <= 3 && b.points > 0 ? MEDALS[b.rank - 1] : b.rank}</span>
                    <Person name={b.name} color={b.color} />
                    <span class="b-name">{b.name}{b.me ? ` · ${t('youT')}` : ''}</span>
                    <span class="b-pts"><b>{t('pointsN', { n: b.points })}</b><small>{t('minN', { n: b.minutes })}</small></span>
                  </div>
                ))}
                {!board.data.board.length && <Card class="classes-hello"><p>{t('feedEmpty')}</p></Card>}
              </div>
            ) : <Loading error={board.error} />)}

            {tab === 'people' && teacher && (
              <div class="card class-settings">
                <strong>{t('whoCanJoin')}</strong>
                <div class="seg2">
                  <button type="button" class={c.visibility !== 'public' ? 'on' : ''} onClick={() => setVisibility('private')}><Icon name="lock" size={16} />{t('classPrivate')}<span>{t('classPrivateSub')}</span></button>
                  <button type="button" class={c.visibility === 'public' ? 'on' : ''} onClick={() => setVisibility('public')} id="make-open"><Icon name="globe" size={16} />{t('classOpen')}<span>{t('classOpenSub')}</span></button>
                </div>
                <Button small kind="secondary" icon="loop" onClick={newCode}>{t('newCode')}</Button>
              </div>
            )}
            {tab === 'people' && <PeoplePanel cid={id} teacher={teacher} onRemove={remove} />}

            <List><Row icon={teacher ? 'close' : 'arrowDown'} color="red" title={teacher ? t('closeClass') : t('leaveClass')} danger onClick={leave} chevron={false} /></List>
          </>
        )}
      </div>
    </div>
  );
}

export function TeacherMission({ a, color }) {
  const frac = a.students ? a.reached_goal / a.students : 0;
  return (
    <button type="button" class={`mission c-${color}`} onClick={() => push('assignment', { id: a.id })}>
      <span class="m-main">
        <strong>{a.title}</strong>
        <span class="m-sub">{dueText(a)}</span>
        <span class="m-progress"><i style={{ width: `${Math.round(frac * 100)}%` }} /></span>
        <span class="m-sub">{a.students ? `${t('handedIn', { a: a.submitted, b: a.students })} · ${t('reachedGoalN', { n: a.reached_goal })}` : t('shareCode')}</span>
      </span>
      <Icon name="chevronR" size={16} stroke={2.4} />
    </button>
  );
}

// ---------------------------------------------------------------- one assignment
/** The library piece for an assignment, imported the first time it is practised. */
async function pieceFor(a) {
  const map = local.get('asgPieces', {});
  if (map[a.id] && (await getPiece(map[a.id]))) return map[a.id];
  if (!a.musicxml) return null;
  const score = parseMusicXML(a.musicxml);
  const rec = await addScore(score, { source: 'academy', fmt: 'musicxml', title: a.piece_title || a.title, extra: { assignmentId: a.id } });
  local.set('asgPieces', { ...map, [a.id]: rec.id });
  return rec.id;
}
const barsOf = (sub, a) => (sub.bars || []).map((x, i) => (Array.isArray(x) ? { bar: x[0], acc: x[1] } : { bar: (a.bars_from || 1) + i, acc: x }));

export function AssignmentView({ id }) {
  const s = useApp();
  const st = useLoad(() => academy.assignment(id), [id, s.academyRev]);
  const a = st.data;
  const teacher = a?.role === 'teacher';
  const [busy, setBusy] = useState(false);

  const practise = async (range = null) => {
    setBusy(true);
    try {
      const pid = await pieceFor(a);
      if (!pid) { toast(t('engineFailedShort'), 'err'); return; }
      const asg = { id: a.id, part: a.part, mode: a.mode, tempo_pct: a.tempo_pct, goal: a.goal, title: a.title, due_at: a.due_at,
        bars_from: range ? range.from : a.bars_from, bars_to: range ? range.to : a.bars_to };
      push('piece', { id: pid, assignment: asg, start: 'playAlong' });
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!confirm(t('confirmDeleteAsg'))) return;
    try { await academy.deleteAssignment(id); refreshClasses(); pop(); } catch (e) { toast(e.message, 'err'); }
  };

  if (!a) {
    return (
      <div class="scroll"><NavBar title={t('assignmentsT')} color="orange" backLabel={t('back')} />
        <div class="wrap" style={{ paddingTop: 14 }}><Loading error={st.error} /></div></div>
    );
  }
  const upcoming = a.status === 'upcoming';
  const subs = a.submissions || [];
  const byStudent = [];
  for (const sub of subs) {
    let g = byStudent.find((x) => x.id === sub.student.id);
    if (!g) { g = { id: sub.student.id, name: sub.student.name, subs: [] }; byStudent.push(g); }
    g.subs.push(sub);
  }
  return (
    <div class="scroll">
      <NavBar title={a.title} color="orange" backLabel={t('back')} />
      <div class="wrap" style={{ paddingTop: 14 }}>
        {a.status === 'done' && <Confetti />}
        <div class="hero class-hero c-orange">
          <div class="m-top">{!teacher && <StatusChip status={a.status} />}<span class="due">{dueText(a)}</span></div>
          <h2>{a.title}</h2>
          {a.piece_title && <p>{a.piece_title}</p>}
          <div class="facts">
            <span><small>{t('barsRange')}</small>{barsText(a)}</span>
            <span><small>{t('speed')}</small>{a.tempo_pct}%</span>
            <span><small>{t('goalT')}</small>{a.goal}%</span>
            <span><small>{t('howToPlay')}</small>{a.mode === 'tempo' ? t('keepBeat') : t('waitForMe')}</span>
          </div>
          <span class="mascot-peek"><Mascot mood={a.status === 'done' ? 'cheer' : 'listen'} size={74} /></span>
        </div>

        {a.instructions && (
          <div class="teacher-note"><Badge icon="pencil" color="orange" size={30} /><div><small>{t('teacherSays')}</small><p>{a.instructions}</p></div></div>
        )}

        {!teacher && (
          <>
            {a.status === 'done' && <div class="goal-banner"><Mascot mood="cheer" size={54} /><strong>{t('goalReachedT')}</strong></div>}
            <Button kind="brand" full icon="mic" onClick={() => practise()} disabled={busy || upcoming || !a.has_piece}>{upcoming ? dueText(a) : t('practiseNow')}</Button>
            {a.attempts ? <p class="note-text" style={{ textAlign: 'center' }}>{t('attemptsLeft', { n: Math.max(0, a.attempts - subs.length) })}</p> : null}
            <Section title={t('myTries')}>
              {!subs.length && <Card class="classes-hello"><Mascot mood="think" size={60} /><p>{t('noTriesYet')}</p></Card>}
              {subs.map((sub) => <TryCard key={sub.id} sub={sub} a={a} onPractise={practise} />)}
            </Section>
          </>
        )}

        {teacher && (
          <>
            <div class="stat-pair">
              <div><b>{byStudent.length}</b><small>{t('submissionsT')}</small></div>
              <div><b>{byStudent.filter((g) => g.subs.some((x) => x.accuracy >= a.goal)).length}</b><small>{t('reachedGoalT')}</small></div>
            </div>
            <Section title={t('submissionsT')}>
              {!byStudent.length && <Card class="classes-hello"><Mascot mood="sleep" size={60} /><p>{t('noSubsYet')}</p></Card>}
              {byStudent.length > 0 && (
                <List>
                  {byStudent.map((g) => {
                    const best = Math.max(...g.subs.map((x) => x.accuracy));
                    const reviewed = g.subs[0].feedback.length > 0;
                    return (
                      <button type="button" class="row" key={g.id} onClick={() => openSheet('review', { a, subs: g.subs })}>
                        <Person name={g.name} color={best >= a.goal ? 'green' : 'orange'} size={34} />
                        <span class="row-main">
                          <span class="row-title">{g.name}</span>
                          <span class="row-sub">{t('bestN', { n: best })} · {g.subs.length === 1 ? t('oneTry') : t('triesN', { n: g.subs.length })}{g.subs.some((x) => x.late) ? ` · ${t('late')}` : ''} · {relTime(g.subs[0].created)}</span>
                        </span>
                        {reviewed ? <span class="count-pill done">{t('reviewedT')}</span> : <span class="count-pill">{t('toReviewT')}</span>}
                        <Icon name="chevronR" size={15} stroke={2.4} style={{ opacity: 0.35 }} />
                      </button>
                    );
                  })}
                </List>
              )}
            </Section>
            <List><Row icon="trash" color="red" title={t('deleteAsg')} danger onClick={del} chevron={false} /></List>
          </>
        )}
      </div>
    </div>
  );
}

function TryCard({ sub, a, onPractise }) {
  const bars = barsOf(sub, a);
  const reached = sub.accuracy >= a.goal;
  return (
    <Card class="try-card">
      <div class="try-top">
        <span class={`try-pct${reached ? ' ok' : ''}`}>{sub.accuracy}%</span>
        <span class="try-meta">{relTime(sub.created)}{sub.late ? ` · ${t('late')}` : ''}{sub.points ? ` · +${sub.points}` : ''}{sub.tempo_pct ? ` · ${t('speed')} ${sub.tempo_pct}%` : ''}</span>
      </div>
      {bars.length > 1 && <div class="bar-strip">{bars.map((b) => <i key={b.bar} title={`${b.bar}`} style={{ '--a': b.acc }} class={b.acc >= 0.85 ? 'ok' : b.acc >= 0.6 ? 'mid' : 'low'} />)}</div>}
      {sub.feedback.map((f, i) => {
        const fb = [...(f.focus_bars || [])].sort((x, y) => x - y);
        return (
          <div class="fb" key={i}>
            {f.stickers?.length > 0 && <div class="fb-stk">{f.stickers.map((k) => <span key={k}>{EMOJI[k]}</span>)}</div>}
            {f.text && <p>{f.text}</p>}
            {fb.length > 0 && (
              <div class="fb-bars">
                <small>{t('focusBars')}:</small>{fb.map((n) => <span class="count-pill" key={n}>{n}</span>)}
                <Button small kind="secondary" color="orange" icon="loop" onClick={() => onPractise({ from: fb[0], to: fb[fb.length - 1] })}>{t('practiseBarsAB', { a: fb[0], b: fb[fb.length - 1] })}</Button>
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

// ---------------------------------------------------------------- sheets
export function JoinClassSheet() {
  const s = useApp();
  const [code, setCode] = useState('');
  const [name, setName] = useState(realName(s.settings.name) || (s.me?.name && s.me.name !== 'Musician' ? s.me.name : ''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const ok = clean.length >= 4 && name.trim();
  const join = async () => {
    if (!ok) return;
    setBusy(true); setErr('');
    try {
      await ensureProfile(name.trim());
      const r = await academy.join(clean);
      refreshClasses();
      closeSheet();
      toast(t('joinedClass', { name: r.class.name }));
      addXP(10);
      goLearn();
      push('classView', { id: r.class.id }, 'academy');
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <SheetFrame title={t('joinClass')} right={t('join')} onRight={join} rightDisabled={!ok || busy}>
      <div class="sheet-mascot"><Mascot mood="wave" size={86} /></div>
      <label class="field-label" for="class-code-in">{t('joinCodePrompt')}</label>
      <input class="field code-field" id="class-code-in" inputMode="text" autoComplete="off" autoCapitalize="characters" spellcheck={false}
        maxLength={9} placeholder="ABC 123" value={fmtCode(clean)} onInput={(e) => { setCode(e.currentTarget.value); setErr(''); }}
        onKeyDown={(e) => { if (e.key === 'Enter') join(); }} />
      <label class="field-label" for="class-name-in">{t('yourName')}</label>
      <input class="field" id="class-name-in" value={name} onInput={(e) => setName(e.currentTarget.value)} maxLength={60} />
      <p class="note-text">{t('nameSeen')}</p>
      {err && <p class="t-red">{err}</p>}
      <Button kind="brand" full icon="users" onClick={join} disabled={!ok || busy}>{t('join')}</Button>
    </SheetFrame>
  );
}

export function NewClassSheet() {
  const s = useApp();
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [color, setColor] = useState('orange');
  const [visibility, setVis] = useState('private');
  const [instrument, setInstrument] = useState(s.settings.instrument || '');
  const [teacherName, setTeacherName] = useState(realName(s.settings.name) || (s.me?.name && s.me.name !== 'Musician' ? s.me.name : ''));
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(null);
  const [err, setErr] = useState('');
  const ok = name.trim() && teacherName.trim();
  const create = async () => {
    if (!ok) return;
    setBusy(true); setErr('');
    try {
      await ensureProfile(teacherName.trim());
      const r = await academy.createClass(name.trim(), about.trim(), color, { visibility, instrument });
      setMade(r.class);
      refreshClasses();
      addXP(10);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const share = async () => {
    const text = t('shareCodeText', { name: made.name, code: made.join_code });
    try { if (navigator.share) { await navigator.share({ title: made.name, text }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch { toast(made.join_code); }
  };
  if (made) {
    return (
      <SheetFrame title={t('teachClass')} right={t('done')} onRight={() => { closeSheet(); goLearn(); push('classView', { id: made.id }, 'academy'); }} left={false}>
        <Confetti />
        <div class="sheet-mascot"><Mascot mood="cheer" size={100} /></div>
        <h2 style={{ textAlign: 'center', font: '800 24px/1.2 var(--round)' }}>{made.name}</h2>
        <p class="note-text" style={{ textAlign: 'center' }}>{t('classReady')}</p>
        <div class={`code-big c-${color}`}>{fmtCode(made.join_code)}</div>
        <Button kind="brand" full icon="link" onClick={() => openSheet('classQR', { classId: made.id })}>{t('hubInvite')}</Button>
        <Button kind="secondary" full icon="share" onClick={share}>{t('shareCodeBtn')}</Button>
      </SheetFrame>
    );
  }
  return (
    <SheetFrame title={t('teachClass')} right={t('createT')} onRight={create} rightDisabled={!ok || busy}>
      <div class="sheet-mascot"><Mascot mood="happy" size={80} /></div>
      <label class="field-label" for="new-class-name">{t('className')}</label>
      <input class="field" id="new-class-name" placeholder="Grade 3 Violin" value={name} onInput={(e) => setName(e.currentTarget.value)} maxLength={80} />
      <label class="field-label" for="new-class-about">{t('classAbout')}</label>
      <textarea class="field prose" id="new-class-about" rows={2} value={about} onInput={(e) => setAbout(e.currentTarget.value)} maxLength={2000} />
      <div class="color-pick" role="radiogroup" aria-label="Colour">
        {CLASS_COLORS.map((c) => <button type="button" key={c} role="radio" aria-checked={color === c} aria-label={c} class={`swatch c-${c}${color === c ? ' on' : ''}`} onClick={() => setColor(c)} />)}
      </div>
      <div class="seg2">
        <button type="button" class={visibility === 'private' ? 'on' : ''} onClick={() => setVis('private')} id="new-class-private"><Icon name="lock" size={16} />{t('classPrivate')}<span>{t('classPrivateSub')}</span></button>
        <button type="button" class={visibility === 'public' ? 'on' : ''} onClick={() => setVis('public')} id="new-class-public"><Icon name="globe" size={16} />{t('classOpen')}<span>{t('classOpenSub')}</span></button>
      </div>
      <label class="field-label" for="new-class-inst">{t('instrument')}</label>
      <select class="field" id="new-class-inst" value={instrument} onChange={(e) => setInstrument(e.currentTarget.value)}>
        <option value="">{t('anyInstrument')}</option>
        {['piano', 'violin', 'guitar', 'voice', 'cello', 'flute', 'ukulele', 'sax', 'clarinet', 'trumpet', 'erhu', 'guzheng'].map((k) => <option key={k} value={k}>{instrumentName(k)}</option>)}
      </select>
      <label class="field-label" for="new-class-teacher">{t('yourName')}</label>
      <input class="field" id="new-class-teacher" placeholder="Ms Tan" value={teacherName} onInput={(e) => setTeacherName(e.currentTarget.value)} maxLength={60} />
      <p class="note-text">{t('nameSeen')}</p>
      {err && <p class="t-red">{err}</p>}
      <Button kind="brand" full icon="academy" onClick={create} disabled={!ok || busy}>{t('createT')}</Button>
    </SheetFrame>
  );
}

const dayISO = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };

export function NewAssignmentSheet({ classId }) {
  const s = useApp();
  const songs = s.pieces.filter((p) => p.kind === 'score');
  const [piece, setPiece] = useState(null);             // {rec, score}
  const [title, setTitle] = useState('');
  const [whole, setWhole] = useState(true);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(1);
  const [part, setPart] = useState('');
  const [mode, setMode] = useState('wait');
  const [tempo, setTempo] = useState(100);
  const [goal, setGoal] = useState(80);
  const [opens, setOpens] = useState(dayISO(Date.now()));
  const [due, setDue] = useState(dayISO(Date.now() + 7 * 86400e3));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const nBars = piece?.score?.measures.length || 1;
  const choices = piece?.score ? partChoices(piece.score) : [];

  const pick = async (p) => {
    const d = await getPiece(p.id);
    if (!d?.score) return;
    setPiece(d);
    setTitle(d.rec.title);
    setFrom(1); setTo(Math.min(8, d.score.measures.length)); setPart('');
  };
  const create = async () => {
    if (!piece || !title.trim()) return;
    const opensAt = opens === dayISO(Date.now()) ? new Date() : new Date(`${opens}T00:00:00`);
    const dueAt = new Date(`${due}T23:59:00`);
    if (dueAt <= opensAt) { setErr(t('dueAfterOpen')); return; }
    setBusy(true); setErr('');
    try {
      await academy.createAssignment(classId, {
        title: title.trim(), instructions: note.trim(), piece_title: piece.rec.title, musicxml: piece.rec.xml || writeMusicXML(piece.score),
        bars_from: whole ? null : Math.min(from, to), bars_to: whole ? null : Math.max(from, to), part, mode: mode === 'beat' ? 'tempo' : 'wait',
        tempo_pct: tempo, goal, opens_at: opensAt.toISOString(), due_at: dueAt.toISOString(),
      });
      refreshClasses();
      closeSheet();
      toast(t('newAssignment'));
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  if (!piece) {
    return (
      <SheetFrame title={t('newAssignment')}>
        <h3 class="sheet-sub">{t('fromYourLibrary')}</h3>
        {!songs.length && <Card class="classes-hello"><Mascot mood="think" size={64} /><p>{t('needSongFirst')}</p></Card>}
        <List>
          {songs.map((p, i) => <Row key={p.id} icon="library" color={CLASS_COLORS[i % CLASS_COLORS.length]} title={p.title} subtitle={p.composer || p.keyText} onClick={() => pick(p)} />)}
        </List>
      </SheetFrame>
    );
  }
  const label = (c) => (c.hand === 'right' ? t('rightHand') : c.hand === 'left' ? t('leftHand') : c.name);
  return (
    <SheetFrame title={t('newAssignment')} right={t('createT')} onRight={create} rightDisabled={busy || !title.trim()} left={t('back')} onLeft={() => setPiece(null)}>
      <label class="field-label" for="asg-title">{t('titleT')}</label>
      <input class="field" id="asg-title" value={title} onInput={(e) => setTitle(e.currentTarget.value)} maxLength={120} />
      <p class="note-text"><Icon name="library" size={14} /> {piece.rec.title}</p>

      <h3 class="sheet-sub">{t('barsRange')}</h3>
      <div class="chips wrap">
        <Chip on={whole} color="orange" onClick={() => setWhole(true)}>{t('wholePiece')}</Chip>
        <Chip on={!whole} color="orange" onClick={() => setWhole(false)}>{`${Math.min(from, to)}–${Math.max(from, to)}`}</Chip>
      </div>
      {!whole && (
        <>
          <Stepper label={t('fromBar')} value={from} onDec={() => setFrom((x) => Math.max(1, x - 1))} onInc={() => setFrom((x) => Math.min(nBars, x + 1))} />
          <Stepper label={t('toBar')} value={to} onDec={() => setTo((x) => Math.max(1, x - 1))} onInc={() => setTo((x) => Math.min(nBars, x + 1))} />
        </>
      )}
      {choices.length > 0 && (
        <>
          <h3 class="sheet-sub">{t('part')}</h3>
          <div class="chips wrap">
            <Chip on={!part} color="indigo" onClick={() => setPart('')}>{t('allParts')}</Chip>
            {choices.map((c) => <Chip key={c.id} on={part === c.id} color="indigo" onClick={() => setPart(c.id)}>{label(c)}</Chip>)}
          </div>
        </>
      )}
      <h3 class="sheet-sub">{t('howToPlay')}</h3>
      <div class="mode-cards" role="radiogroup">
        {[['wait', 'waitForMe', 'waitForMeSub', 'pause'], ['beat', 'keepBeat', 'keepBeatSub', 'metronome']].map(([id, a, b, ic]) => (
          <button type="button" key={id} role="radio" aria-checked={mode === id} class={`mode-card${mode === id ? ' on' : ''}`} onClick={() => setMode(id)}>
            <Icon name={ic} size={22} stroke={2.2} /><strong>{t(a)}</strong><span>{t(b)}</span>
          </button>
        ))}
      </div>
      <Stepper label={t('speed')} value={`${tempo}%`} onDec={() => setTempo((x) => Math.max(40, x - 5))} onInc={() => setTempo((x) => Math.min(150, x + 5))} />
      <Stepper label={t('goalT')} value={`${goal}%`} onDec={() => setGoal((x) => Math.max(40, x - 5))} onInc={() => setGoal((x) => Math.min(100, x + 5))} />
      <div class="date-pair">
        <label><span class="field-label">{t('opensT')}</span><input class="field" type="date" id="asg-opens" value={opens} min={dayISO(Date.now())} onInput={(e) => setOpens(e.currentTarget.value)} /></label>
        <label><span class="field-label">{t('dueT')}</span><input class="field" type="date" id="asg-due" value={due} min={opens} onInput={(e) => setDue(e.currentTarget.value)} /></label>
      </div>
      <label class="field-label" for="asg-note">{t('instructionsT')}</label>
      <textarea class="field prose" id="asg-note" rows={3} value={note} onInput={(e) => setNote(e.currentTarget.value)} maxLength={4000} placeholder="Watch the dynamics in bar 5 ✨" />
      {err && <p class="t-red">{err}</p>}
      <Button kind="brand" full icon="send" onClick={create} disabled={busy || !title.trim()}>{t('createT')}</Button>
    </SheetFrame>
  );
}

export function ReviewSheet({ a, subs }) {
  const sub = subs[0];
  const [text, setText] = useState('');
  const [stickers, setStickers] = useState([]);
  const [focus, setFocus] = useState([]);
  const [audio, setAudio] = useState(null);
  const [busy, setBusy] = useState(false);
  const bars = barsOf(sub, a);
  const toggle = (list, setList, x) => setList(list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  const send = async () => {
    setBusy(true);
    try {
      await academy.feedback(sub.id, { text: text.trim(), stickers, focus_bars: focus });
      toast(t('feedbackSent'));
      refreshClasses();
      closeSheet();
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  const listen = async () => {
    try { setAudio(await academy.recordingURL(sub.id)); } catch (e) { toast(e.message, 'err'); }
  };
  const ready = text.trim() || stickers.length || focus.length;
  return (
    <SheetFrame title={sub.student.name} right={t('sendT')} onRight={send} rightDisabled={busy || !ready}>
      <div class="review-head">
        <span class={`try-pct big${sub.accuracy >= a.goal ? ' ok' : ''}`}>{sub.accuracy}%</span>
        <div class="review-facts">
          <span>{t('goalT')} {a.goal}%</span>
          {sub.timing != null && <span>{t('timingT')} {sub.timing}%</span>}
          {sub.tempo_pct ? <span>{t('speed')} {sub.tempo_pct}%</span> : null}
          {sub.seconds ? <span>{t('minN', { n: Math.max(1, Math.round(sub.seconds / 60)) })}</span> : null}
          <span>{relTime(sub.created)}{sub.late ? ` · ${t('late')}` : ''}</span>
        </div>
      </div>
      {bars.length > 0 && (
        <>
          <h3 class="sheet-sub">{t('focusBars')}</h3>
          <p class="note-text">{t('tapBarsHint')}</p>
          <div class="bar-pick">
            {bars.map((b) => (
              <button type="button" key={b.bar} aria-pressed={focus.includes(b.bar)} class={`${b.acc >= 0.85 ? 'ok' : b.acc >= 0.6 ? 'mid' : 'low'}${focus.includes(b.bar) ? ' sel' : ''}`}
                style={{ '--a': b.acc }} onClick={() => toggle(focus, setFocus, b.bar)}>
                <i /><span>{b.bar}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {sub.has_recording && (audio ? <audio controls autoPlay src={audio} style={{ width: '100%' }} /> : <Button kind="secondary" color="blue" icon="play" onClick={listen}>{t('listenRecording')}</Button>)}
      {sub.note && <div class="teacher-note"><Person name={sub.student.name} size={30} /><div><p>{sub.note}</p></div></div>}
      <h3 class="sheet-sub">{t('stickersT')}</h3>
      <div class="sticker-pick">
        {STICKERS.map(([k, e]) => <button type="button" key={k} aria-pressed={stickers.includes(k)} aria-label={k} class={stickers.includes(k) ? 'on' : ''} onClick={() => toggle(stickers, setStickers, k)}>{e}</button>)}
      </div>
      <textarea class="field prose" id="review-text" rows={3} placeholder={t('commentHint')} value={text} onInput={(e) => setText(e.currentTarget.value)} maxLength={2000} />
      <Button kind="brand" full icon="send" onClick={send} disabled={busy || !ready}>{t('giveFeedback')}</Button>
      <VoiceNote target="submission" id={sub.id} bars={focus} />
      {subs.length > 1 && (
        <>
          <h3 class="sheet-sub">{t('earlierTries')}</h3>
          <List>{subs.slice(1).map((x) => <Row key={x.id} title={`${x.accuracy}%`} subtitle={`${relTime(x.created)}${x.late ? ` · ${t('late')}` : ''}${x.feedback.length ? ` · ${t('reviewedT')}` : ''}`} />)}</List>
        </>
      )}
    </SheetFrame>
  );
}
