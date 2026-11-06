import { useEffect, useState } from 'preact/hooks';
import { useApp, push, go, openSheet, minutesOn, streakDays, clearExamples, goLearn } from '../state.js';
import { t, getLang } from '../../core/i18n.js';
import { Card, Section, Icon, Button, List, Row } from '../components.jsx';
import { Avatar } from './common.jsx';
import { Mascot } from '../mascot.jsx';
import { levelFor, allLessons, tx } from '../../core/academy.js';
import { local } from '../storage.js';
import { hasServer, academyMe } from '../api.js';

const dayKey = (d) => d.toISOString().slice(0, 10);
function lastDays(n) {
  const out = [];
  const d = new Date();
  d.setDate(d.getDate() - (n - 1));
  for (let i = 0; i < n; i++) { out.push(dayKey(d)); d.setDate(d.getDate() + 1); }
  return out;
}

export function dueLabel(iso, lang) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const days = Math.round((d - new Date()) / 86400000);
    const opts = days > -7 && days < 7 ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { day: 'numeric', month: 'short' };
    return d.toLocaleString(lang, opts);
  } catch { return iso.slice(0, 10); }
}

/** The first tab: a friendly start page instead of a dashboard. */
export function HomeView({ active }) {
  const s = useApp();
  const lang = getLang();
  const [todo, setTodo] = useState(null);
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'helloMorning' : hour < 18 ? 'helloAfternoon' : 'helloEvening';
  const name = (s.settings.name || '').trim().split(/\s+/)[0] || '';
  const days = lastDays(7);
  const mins = days.map((d) => Math.round(minutesOn(d)));
  const todayMin = mins[6];
  const goal = s.settings.dailyGoal || 20;
  const streak = streakDays();
  const lv = levelFor(s.progress.xp);
  const recent = [...s.pieces].filter((p) => p.opened && p.kind === 'score').sort((a, b) => b.opened - a.opened)[0]
    || s.pieces.find((p) => p.kind === 'score');
  const next = allLessons().find((x) => !s.progress.lessons[x.lesson.id]);
  const maxMin = Math.max(goal, ...mins, 1);

  useEffect(() => {
    if (!active || !hasServer() || !local.get('academyToken', '')) return;
    academyMe(s.settings.name).then((r) => setTodo(r.todo || [])).catch(() => setTodo(null));
  }, [active]);

  return (
    <div class="scroll">
      <div class="wrap">
        <header class="hello fade-up">
          <Mascot mood={todayMin >= goal ? 'cheer' : 'wave'} size={74} />
          <div class="txt">
            <h1>{name ? t(hello, { name }) : t(hello, { name: '' }).replace(/,\s*!$/, '!').replace(/，！$/, '！')}</h1>
            <p>{t('helloSub')}</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
            <Avatar />
            {streak > 0 && <span class="streak-chip" title={t('streak')}><Icon name="flame" size={16} fill stroke={1.6} />{streak}</span>}
          </div>
        </header>

        <div class="action-grid fade-up d1">
          <button type="button" class="action-tile brand" onClick={() => openSheet('add')} id="home-add">
            <span class="ic"><Icon name="plus" size={24} stroke={2.6} /></span>
            <strong>{t('addMusic')}</strong>
            <span>{t('addMusicSub')}</span>
          </button>
          <button type="button" class="action-tile c-teal" onClick={() => openSheet('finder')} id="home-find">
            <span class="ic"><Icon name="search" size={22} stroke={2.4} /></span>
            <strong>{t('findSongTile')}</strong>
            <span>{t('findSongTileSub')}</span>
          </button>
        </div>

        {recent && (
          <Card class="continue-card fade-up d2">
            <div class="top">
              <span class="art"><Icon name="library" size={26} stroke={2.2} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div class="sub" style={{ fontWeight: 600 }}>{t('keepGoing')}</div>
                <strong style={{ fontSize: 18, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{recent.title}</strong>
                {recent.best !== null && recent.best !== undefined && <span class="sub">{t('rightNotes')}: {recent.best}%</span>}
              </div>
            </div>
            <div class="btn-row">
              <Button icon="mic" color="pink" onClick={() => push('piece', { id: recent.id, start: 'playAlong' }, 'library')}>{t('playAlong')}</Button>
              <Button icon="speaker" kind="secondary" color="indigo" onClick={() => push('piece', { id: recent.id, start: 'listen' }, 'library')}>{t('listen')}</Button>
            </div>
          </Card>
        )}

        {todo && todo.length > 0 && (
          <Section title={t('classTodo')}>
            <List>
              {todo.slice(0, 3).map((a) => (
                <Row key={a.id} icon="flag" color={a.status === 'due-soon' || a.status === 'late' ? 'orange' : 'blue'} title={a.title}
                  subtitle={`${a.class_name} · ${a.status === 'upcoming' ? t('opensOn', { d: dueLabel(a.opens_at, lang) }) : t('dueOn', { d: dueLabel(a.due_at, lang) })}`}
                  right={<span class={`fmt ${a.status === 'late' ? 'page' : a.status === 'due-soon' ? 'ai' : 'ready'}`}>{t(a.status === 'due-soon' ? 'st_dueSoon' : `st_${a.status}`)}</span>}
                  onClick={() => push('assignment', { id: a.id }, 'community')} />
              ))}
            </List>
          </Section>
        )}

        <Card class="fade-up d3">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <strong>{todayMin >= goal ? t('goalDone') : t('todayGoal', { n: todayMin, g: goal })}</strong>
            {s.examples
              ? <button type="button" class="sub" onClick={clearExamples} aria-label={t('removeExamples')}><span class="example-tag">{t('exampleData')}</span> ✕</button>
              : <span class="sub">{t('levelN', { n: lv.level })} · {s.progress.xp} {t('xp')}</span>}
          </div>
          <div class="goal-bar" role="progressbar" aria-valuemin="0" aria-valuemax={goal} aria-valuenow={Math.min(goal, todayMin)}>
            <span style={{ width: `${Math.min(100, (todayMin / goal) * 100)}%` }} />
          </div>
          <div class="sub" style={{ fontWeight: 600, marginTop: 4 }}>{t('thisWeek')}</div>
          <div class="mini-week" aria-hidden="true">
            {mins.map((m, i) => <i key={i} class={i === 6 ? 'today' : ''} style={{ height: `${Math.max(6, (m / maxMin) * 100)}%` }} />)}
          </div>
          <div class="mini-week-l" aria-hidden="true">
            {days.map((d, i) => <span key={d}>{new Date(d + 'T12:00:00').toLocaleDateString(lang, { weekday: 'narrow' })}</span>)}
          </div>
          <Button kind="plain" small onClick={() => push('history', {}, 'summary')}>{t('activity')} ›</Button>
        </Card>

        <div class="action-grid fade-up d4">
          <button type="button" class="action-tile c-orange" onClick={() => openSheet('lesson', { lessonId: 'ear2', seed: Number(new Date().toISOString().slice(0, 10).replace(/-/g, '')) % 100000, daily: true })}>
            <span class="ic"><Icon name="bolt" size={22} stroke={2.4} /></span>
            <strong>{t('dailyChallenge')}</strong>
            <span>{t('dailyChallengeSub')}</span>
          </button>
          <button type="button" class="action-tile c-purple" onClick={() => next ? openSheet('lesson', { lessonId: next.lesson.id }) : goLearn()}>
            <span class="ic"><Icon name="academy" size={22} stroke={2.4} /></span>
            <strong>{t('nextLesson')}</strong>
            <span>{next ? tx(next.lesson.title, lang) : t('academy')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
