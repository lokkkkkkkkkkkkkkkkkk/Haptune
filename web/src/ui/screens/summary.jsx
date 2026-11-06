import { useApp, push, go, openSheet, minutesOn, streakDays, clearExamples } from '../state.js';
import { t, getLang } from '../../core/i18n.js';
import { Card, CardHead, BigValue, Section, Rings, MiniBars, MiniLine, Badge, Button, Icon, List, Row } from '../components.jsx';
import { LargeTitle, NavBar, dateLabel } from './common.jsx';
import { allLessons, tx, levelFor } from '../../core/academy.js';
import { SONGS, songTitle } from '../../data/songs.js';

const dayKey = (d) => d.toISOString().slice(0, 10);
function lastDays(n) {
  const out = [];
  const d = new Date();
  d.setDate(d.getDate() - (n - 1));
  for (let i = 0; i < n; i++) { out.push(dayKey(d)); d.setDate(d.getDate() + 1); }
  return out;
}

export function SummaryView() {
  const s = useApp();
  const lang = getLang();
  const days = lastDays(7);
  const mins = days.map((d) => Math.round(minutesOn(d)));
  const todayMin = mins[mins.length - 1];
  const streak = streakDays();
  const takes = s.history.filter((h) => h.accuracy !== undefined && h.accuracy !== null).slice(-12);
  const last = takes[takes.length - 1];
  const weekTakes = s.history.filter((h) => h.date > Date.now() - 7 * 86400000 && h.inTune !== undefined);
  const inTune = weekTakes.length ? Math.round(100 * weekTakes.reduce((a, h) => a + h.inTune, 0) / weekTakes.length) : null;
  const lv = levelFor(s.progress.xp);
  const todayXP = Math.min(200, Object.keys(s.progress.lessons).filter((k) => new Date(s.progress.lessons[k].at).toDateString() === new Date().toDateString()).length * 60 + Math.round(todayMin * 5));
  const next = allLessons().find((x) => !s.progress.lessons[x.lesson.id]);
  const recent = [...s.pieces].filter((p) => p.opened).sort((a, b) => b.opened - a.opened)[0] || s.pieces[0];
  const highlights = [];
  if (takes.length >= 2) {
    const first = takes[0], lastT = takes[takes.length - 1];
    const diff = Math.round((lastT.accuracy - first.accuracy) * 100);
    if (diff > 0) highlights.push({ icon: 'arrowUp', color: 'green', text: lang.startsWith('zh') ? `你的准确率从 ${Math.round(first.accuracy * 100)}% 提升到 ${Math.round(lastT.accuracy * 100)}%。` : lang === 'ms' ? `Ketepatan anda naik daripada ${Math.round(first.accuracy * 100)}% kepada ${Math.round(lastT.accuracy * 100)}%.` : `Your accuracy rose from ${Math.round(first.accuracy * 100)}% to ${Math.round(lastT.accuracy * 100)}%.` });
  }
  const weekTotal = mins.reduce((a, b) => a + b, 0);
  if (weekTotal > 0) highlights.push({ icon: 'flame', color: 'orange', text: lang.startsWith('zh') ? `这 7 天你练习了 ${weekTotal} 分钟，平均每天 ${Math.round(weekTotal / 7)} 分钟。` : lang === 'ms' ? `Anda berlatih ${weekTotal} minit dalam 7 hari ini, purata ${Math.round(weekTotal / 7)} minit sehari.` : `You practised ${weekTotal} minutes in the last 7 days, ${Math.round(weekTotal / 7)} a day on average.` });
  const doneLessons = Object.keys(s.progress.lessons).length;
  if (doneLessons) highlights.push({ icon: 'academy', color: 'orange', text: lang.startsWith('zh') ? `已完成 ${doneLessons} 节学院课程，等级 ${lv.level}。` : lang === 'ms' ? `${doneLessons} pelajaran Akademi selesai, tahap ${lv.level}.` : `${doneLessons} Academy lessons done; you are level ${lv.level}.` });
  const idea = SONGS[(new Date().getDate()) % SONGS.length];
  const styles = ['st_pop', 'st_bossa', 'st_blues', 'st_ballad', 'st_pentatonic', 'st_jazz'];
  const styleKey = styles[new Date().getDate() % styles.length];

  return (
    <div class="scroll">
      <div class="wrap">
        <LargeTitle title={t('summary')} eyebrow={dateLabel(lang)} color="pink" />

        {s.pieces.length === 0 && (
          <Card>
            <h2 style={{ fontSize: 22 }}>{t('welcomeTitle')}</h2>
            {[['music', 'blue', 'welcome1', 'welcome1b'], ['key', 'green', 'welcome2', 'welcome2b'], ['sparkles', 'purple', 'welcome3', 'welcome3b']].map(([ic, c, a, b]) => (
              <div class="report-line" key={a}><Badge icon={ic === 'music' ? 'library' : ic} color={c} size={34} /><div><strong>{t(a)}</strong><p class="sub">{t(b)}</p></div></div>
            ))}
            <Button onClick={() => push('songbook', {}, 'library')} full>{t('openSongbook')}</Button>
          </Card>
        )}

        <Card class="rings-card" onClick={() => push('history', {}, 'summary')}>
          <Rings size={118} rings={[{ value: todayMin / Math.max(1, s.settings.dailyGoal), color: 'pink' }, { value: todayXP / 120, color: 'green' }, { value: Math.min(7, streak) / 7, color: 'cyan' }]} />
          <div class="ring-legend">
            <div><div class="lab t-pink">{t('ringPractise')}</div><div class="val num">{todayMin}<small>/{s.settings.dailyGoal} {t('min')}</small></div></div>
            <div><div class="lab t-green">{t('ringLearn')}</div><div class="val num">{todayXP}<small>/120 {t('xp')}</small></div></div>
            <div><div class="lab t-cyan">{t('ringStreak')}</div><div class="val num">{streak}<small>/7 {t('days')}</small></div></div>
          </div>
        </Card>

        <Section title={t('pinned')} action={s.examples ? <button type="button" onClick={clearExamples}><span class="example-tag">{t('exampleData')}</span> ✕</button> : null}>
          <div class="grid two">
            <Card onClick={() => push('history', { metric: 'time' }, 'summary')}>
              <CardHead icon="flame" color="pink" title={t('practiceTime')} detail={t('today')} />
              <div class="split">
                <div><BigValue value={todayMin} unit={t('min')} /><div class="foot">{t('goalMin', { n: s.settings.dailyGoal })}</div></div>
                <MiniBars values={mins} color="pink" />
              </div>
            </Card>
            <Card onClick={() => push('history', { metric: 'accuracy' }, 'summary')}>
              <CardHead icon="check" color="green" title={t('accuracy')} detail={last ? new Date(last.date).toLocaleDateString(lang, { month: 'short', day: 'numeric' }) : ''} />
              <div class="split">
                <div><BigValue value={last ? Math.round(last.accuracy * 100) : '–'} unit="%" /><div class="foot">{last ? last.title : t('noTakes')}</div></div>
                <MiniLine values={takes.map((h) => h.accuracy * 100)} color="green" />
              </div>
            </Card>
            <Card onClick={() => push('history', { metric: 'intonation' }, 'summary')}>
              <CardHead icon="tuningfork" color="purple" title={t('inTune')} detail="7 d" />
              <BigValue value={inTune ?? '–'} unit="%" />
              <div class="foot">{t('inTuneHint')}</div>
            </Card>
            <Card onClick={() => go('academy')}>
              <CardHead icon="academy" color="orange" title={t('academy')} detail={t('levelN', { n: lv.level })} />
              <div class="split">
                <div><BigValue value={s.progress.xp} unit={t('xp')} /><div class="foot">{t('streak')}: {streak} {streak === 1 ? t('day') : t('days')}</div></div>
                <Rings size={46} width={7} rings={[{ value: lv.into / lv.need, color: 'orange' }]} />
              </div>
            </Card>
            {recent && (
              <Card onClick={() => push('piece', { id: recent.id }, 'library')}>
                <CardHead icon="play" color="blue" title={t('continuePractising')} detail={recent.keyText} />
                <div class="report-line"><Badge icon={recent.kind === 'sheet' ? 'chords' : recent.kind === 'pdf' ? 'doc' : 'library'} color={recent.kind === 'sheet' ? 'green' : recent.kind === 'pdf' ? 'red' : 'blue'} size={40} />
                  <div style={{ minWidth: 0 }}><strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{recent.title}</strong><span class="sub">{recent.composer || '—'}</span></div></div>
              </Card>
            )}
            {next && (
              <Card onClick={() => openSheet('lesson', { lessonId: next.lesson.id })}>
                <CardHead icon={next.course.icon === 'staff' ? 'staff' : next.course.icon} color={next.course.color} title={t('nextLesson')} detail={tx(next.course.title, lang)} />
                <strong>{tx(next.lesson.title, lang)}</strong>
                <span class="foot">{tx(next.lesson.cards[0], lang).slice(0, 90)}…</span>
              </Card>
            )}
          </div>
        </Section>

        <button type="button" class="hero improv" onClick={() => go('improvise')} style={{ textAlign: 'left' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 14, textTransform: 'uppercase', letterSpacing: '.05em' }}><Icon name="sparkles" size={18} stroke={2.3} />{t('improviseIdea')}</div>
          <h2>{t('improviseIdeaText', { style: t(styleKey).toLowerCase(), song: songTitle(idea, lang) })}</h2>
          <span class="btn small" style={{ alignSelf: 'flex-start' }}>{t('generate')}</span>
        </button>

        {highlights.length > 0 && (
          <Section title={t('highlights')}>
            <div class="grid two">
              {highlights.map((h, i) => <Card key={i}><div class="report-line"><span class={`t-${h.color}`}><Icon name={h.icon} size={24} stroke={2.2} /></span><span>{h.text}</span></div></Card>)}
            </div>
          </Section>
        )}

        {!s.plus && (
          <button type="button" class="hero plus" onClick={() => openSheet('plans')} style={{ textAlign: 'left' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="crown" size={20} stroke={2.3} /><h2>{t('plusTitle')}</h2></div>
            <p>{t('plusBlurb')}</p>
            <strong>{t('tryFreeWeek')} ›</strong>
          </button>
        )}
      </div>
    </div>
  );
}

export function HistoryView({ metric = 'time' }) {
  const s = useApp();
  const lang = getLang();
  const days = lastDays(14);
  const mins = days.map((d) => Math.round(minutesOn(d)));
  const takes = s.history.filter((h) => h.accuracy !== undefined).slice(-30);
  return (
    <div class="scroll">
      <NavBar title={t(metric === 'accuracy' ? 'accuracy' : metric === 'intonation' ? 'inTune' : 'practiceTime')} color="pink" backLabel={t('summary')} />
      <div class="wrap" style={{ paddingTop: 16 }}>
        <Card>
          {metric === 'time' && <><CardHead icon="flame" color="pink" title={t('practiceTime')} detail="14 d" chevron={false} /><MiniBars values={mins} width={340} height={140} color="pink" /></>}
          {metric !== 'time' && <><CardHead icon={metric === 'accuracy' ? 'check' : 'tuningfork'} color={metric === 'accuracy' ? 'green' : 'purple'} title={t(metric === 'accuracy' ? 'accuracy' : 'inTune')} detail={`${takes.length}`} chevron={false} />
            <MiniLine values={takes.map((h) => (metric === 'accuracy' ? h.accuracy : h.inTune) * 100)} width={340} height={140} color={metric === 'accuracy' ? 'green' : 'purple'} /></>}
        </Card>
        <List>
          {[...s.history].reverse().slice(0, 40).map((h) => (
            <Row key={h.id} title={h.title || '—'} subtitle={new Date(h.date).toLocaleString(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + (h.example ? ' · example' : '')}
              detail={h.accuracy !== undefined ? `${Math.round(h.accuracy * 100)}% · ${Math.round((h.seconds || 0) / 60)} ${t('min')}` : `${Math.round((h.seconds || 0) / 60)} ${t('min')}`} />
          ))}
          {!s.history.length && <Row title={t('noTakes')} />}
        </List>
      </div>
    </div>
  );
}
