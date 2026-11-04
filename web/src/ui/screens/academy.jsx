import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { useApp, push, openSheet, closeSheet, completeLesson, addXP, awardBadge, updateSettings, toast, go, streakDays, getState, setState } from '../state.js';
import { t, getLang, instrumentName } from '../../core/i18n.js';
import { Icon, Card, Section, List, Row, Button, Badge, MiniStaff, Keyboard, Segmented, Rings } from '../components.jsx';
import { LargeTitle, NavBar, SheetFrame } from './common.jsx';
import { COURSES, findLesson, makeQuiz, tx, levelFor, BADGES, makeChallengeCode, readChallengeCode, INTERVAL_NAMES, allLessons } from '../../core/academy.js';
import { audioContext, note, playNow, click, Transport, startDrone, stopDrone, listen, drum } from '../audio.js';
import { VOICE_RANGES } from '../../core/analysis.js';
import { spellMidi, pitchName } from '../../core/pitch.js';

const dateSeed = () => { const d = new Date(); return d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate(); };

export function AcademyView() {
  const s = useApp();
  const lang = getLang();
  const lv = levelFor(s.progress.xp);
  const streak = streakDays();
  return (
    <div class="scroll">
      <div class="wrap">
        <LargeTitle title={t('academy')} color="orange" />
        <div class="hero academy">
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Rings size={74} width={9} rings={[{ value: lv.into / lv.need, color: 'cyan' }]} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <h2>{t('levelN', { n: lv.level })}</h2>
              <p class="num">{s.progress.xp} {t('xp')} · {lv.need - lv.into} → {t('levelN', { n: lv.level + 1 })}</p>
              <p><Icon name="flame" size={15} /> {streak} {streak === 1 ? t('day') : t('days')} · <Icon name="trophy" size={15} /> {s.progress.badges.length} {t('badges').toLowerCase()}</p>
            </div>
          </div>
        </div>

        <div class="grid two">
          <Card onClick={() => openSheet('lesson', { lessonId: 'ear2', seed: dateSeed(), daily: true })}>
            <div class="card-head"><span class="card-title t-purple"><Icon name="bolt" size={17} />{t('dailyChallenge')}</span><Icon name="chevronR" size={14} /></div>
            <p class="sub">{t('dailyChallengeSub')}</p>
          </Card>
          <Card onClick={() => openSheet('challenge')}>
            <div class="card-head"><span class="card-title t-pink"><Icon name="flag" size={17} />{t('challengeFriend')}</span><Icon name="chevronR" size={14} /></div>
            <p class="sub">{t('enterCode')}</p>
          </Card>
        </div>

        <Section title={t('courses')}>
          <div class="grid tiles">
            {COURSES.map((c) => {
              const done = c.lessons.filter((l) => s.progress.lessons[l.id]).length;
              return (
                <button type="button" key={c.id} class={`tile course-tile c-${c.color}`} onClick={() => push('course', { id: c.id }, 'academy')}>
                  <Badge icon={c.icon} color={c.color} size={34} solid={false} />
                  <h3>{tx(c.title, lang)}</h3>
                  <p>{tx(c.blurb, lang)}</p>
                  <div class="progress"><span style={{ width: `${(done / c.lessons.length) * 100}%` }} /></div>
                  <p class="num">{done}/{c.lessons.length}</p>
                </button>
              );
            })}
          </div>
        </Section>

        <Tutor />

        <Section title={t('badges')}>
          <div class="grid tiles">
            {BADGES.map((b) => {
              const has = s.progress.badges.includes(b.id);
              return (
                <div key={b.id} class="tile" style={{ alignItems: 'center', textAlign: 'center', opacity: has ? 1 : 0.45 }}>
                  <Badge icon={b.icon} color={has ? ['orange', 'yellow', 'pink', 'purple', 'green'][b.id.length % 5] : 'gray'} size={42} solid={has} />
                  <p style={{ fontWeight: 600, color: 'var(--ink)' }}>{tx(b.title, lang)}</p>
                </div>
              );
            })}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Tutor() {
  const s = useApp();
  const lang = getLang();
  const [sample, setSample] = useState(undefined);
  const [qtext, setQ] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const ctl = useRef(null);
  useEffect(() => {
    let alive = true;
    const c = globalThis.claude;
    if (!c?.use) { setSample(null); return undefined; }
    c.use('sample').then((fn) => { if (alive) setSample(fn || null); }).catch(() => alive && setSample(null));
    return () => { alive = false; };
  }, []);
  const ask = async () => {
    if (!sample || !qtext.trim()) return;
    const conn = navigator.connection;
    if (s.settings.wifiOnly && conn && conn.type === 'cellular') { toast(t('waitingWifi'), 'err'); return; }
    ctl.current?.abort();
    ctl.current = new AbortController();
    setBusy(true); setAnswer(t('thinking'));
    const langName = { en: 'English', ms: 'Bahasa Melayu', 'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese' }[lang];
    const prompt = `You are the music tutor inside Haptune, a practice app. The student plays ${instrumentName(s.settings.instrument)} and is at Academy level ${levelFor(s.progress.xp).level}. Answer in ${langName}, warmly and clearly, in under 170 words. Use note names (C, D, E...), give one concrete exercise when it helps, and do not use Markdown headings.\n\nQuestion: ${qtext.trim()}`;
    try {
      await sample(prompt, { signal: ctl.current.signal, onText: ({ text }) => setAnswer(text) });
      addXP(5);
    } catch (e) {
      if (e?.code === 'not_granted' || e?.code === 'sampling_disabled') { setSample(null); setAnswer(''); }
      else if (e?.code !== 'cancelled') setAnswer((e?.text || '') + (e?.code === 'rate_limited' ? '\n\n(Try again in a minute.)' : ''));
    }
    setBusy(false);
  };
  return (
    <Section title={t('aiTutor')}>
      <Card>
        <div class="report-line"><Badge icon="sparkles" color="indigo" size={34} /><p class="sub">{sample === null ? t('aiUnavailable') : t('aiTutorHelp')}</p></div>
        {sample && <>
          <textarea class="field" id="tutor-q" style={{ minHeight: 70, fontFamily: 'var(--font)', fontSize: 16 }} placeholder="Why does the V chord want to go to I?" value={qtext} onInput={(e) => setQ(e.currentTarget.value)} />
          <div class="btn-row"><Button onClick={ask} disabled={busy || !qtext.trim()} color="indigo" icon="sparkles">{busy ? t('thinking') : t('ask')}</Button>
            {busy && <Button kind="secondary" onClick={() => ctl.current?.abort()}>{t('stop')}</Button>}</div>
          {answer && <div class="ai-answer">{answer}</div>}
        </>}
      </Card>
    </Section>
  );
}

export function CourseView({ id }) {
  const s = useApp();
  const lang = getLang();
  const c = COURSES.find((x) => x.id === id);
  return (
    <div class="scroll">
      <NavBar title={tx(c.title, lang)} color={c.color} backLabel={t('academy')} />
      <div class="wrap" style={{ paddingTop: 16 }}>
        <div class={`hero course-tile c-${c.color}`} style={{ color: '#fff' }}>
          <Badge icon={c.icon} color={c.color} size={44} solid={false} />
          <h2>{tx(c.title, lang)}</h2>
          <p>{tx(c.blurb, lang)}</p>
        </div>
        <List>
          {c.lessons.map((l, i) => {
            const pr = s.progress.lessons[l.id];
            return (
              <Row key={l.id} icon={pr ? 'check' : l.quiz ? 'quiz' : l.activity ? 'bolt' : 'book'} color={pr ? 'green' : c.color} title={`${i + 1}. ${tx(l.title, lang)}`}
                subtitle={pr?.total ? t('scoreOf', { s: pr.best, n: pr.total }) : l.quiz ? t('nQuestions', { n: l.quiz.count || 8 }) : l.activity ? t('handsOn') : ''} onClick={() => openSheet('lesson', { lessonId: l.id })} />
            );
          })}
        </List>
      </div>
    </div>
  );
}

// ---------- lesson player ----------

function promptFor(qn, lang) {
  switch (qn.kind) {
    case 'chordNotes': case 'chordTones': return t('q_' + qn.kind, { chord: qn.chord });
    case 'roman': return t('q_roman', { key: qn.key, numeral: qn.numeral });
    case 'progName': return t('q_progName', { key: qn.key, chords: qn.chords });
    case 'transpose': return t('q_transpose', { chord: qn.chord, semis: (qn.semis > 0 ? '+' : '') + qn.semis });
    case 'scaleNotes': return t('q_scaleNotes', { tonic: qn.tonic, scale: t('sc_' + qn.scale) });
    default: void lang; return t('q_' + qn.kind);
  }
}

function optionLabel(qn, o, lang) {
  if (qn.kind === 'interval') return tx(INTERVAL_NAMES[o.id], lang);
  if (qn.kind === 'direction') return t(o.id === 'up' ? 'ans_higher' : 'ans_lower');
  if (qn.kind === 'swing') return t('ans_' + o.id);
  if (qn.kind === 'quality') return t('ans_' + o.id);
  return o.label;
}

function playQuestion(qn) {
  const p = qn.play;
  if (!p) return;
  audioContext();
  if (Array.isArray(p)) playNow(p.map((m) => [m]), { gap: 0.75, dur: 0.7 });
  else if (p.chord) playNow(p.chord, { dur: 1.4, arpeggio: 0.015 });
  else if (p.chords) playNow(p.chords, { gap: 1.1, dur: 1.0 });
  else if (p.pattern === 'swing') {
    const ctx = audioContext();
    const t0 = ctx.currentTime + 0.1, beat = 0.5;
    for (let b = 0; b < 8; b++) {
      drum(t0 + b * beat, 'hat', 70);
      drum(t0 + b * beat + beat * (p.swing ? 0.667 : 0.5), 'hat', 50);
      if (b % 2 === 0) drum(t0 + b * beat, 'kick', 80); else drum(t0 + b * beat, 'snare', 70);
      note(t0 + b * beat, [60, 64, 67, 64][b % 4], beat * (p.swing ? 0.6 : 0.45), 70, 'piano');
      note(t0 + b * beat + beat * (p.swing ? 0.667 : 0.5), [62, 65, 69, 65][b % 4], beat * (p.swing ? 0.3 : 0.45), 60, 'piano');
    }
  }
}

export function LessonSheet({ lessonId, seed: seedIn, daily, challenge }) {
  const lang = getLang();
  const found = findLesson(lessonId);
  const { course, lesson } = found;
  const [phase, setPhase] = useState(challenge || daily ? 'quiz' : 'cards');
  const [card, setCard] = useState(0);
  const seed = useMemo(() => seedIn ?? Math.floor(Math.random() * 900000) + 1000, [seedIn]);
  const quiz = useMemo(() => (lesson.quiz ? makeQuiz(lesson.quiz, seed) : []), [lesson, seed]);
  const [qi, setQi] = useState(0);
  const [picked, setPicked] = useState(null);
  const [score, setScore] = useState(0);
  const [t0] = useState(() => Date.now());
  const [result, setResult] = useState(null);
  const color = course.color;
  const qn = quiz[qi];
  useEffect(() => { if (phase === 'quiz' && qn?.play) setTimeout(() => playQuestion(qn), 250); }, [phase, qi]);

  const finish = (sc, total) => {
    const seconds = Math.round((Date.now() - t0) / 1000);
    const xp = sc * 10 + 50;
    const levelUp = addXP(xp);
    completeLesson(lesson.id, sc, total);
    if (challenge) { if (sc > challenge.score || (sc === challenge.score && seconds < challenge.seconds)) awardBadge('challenger'); }
    setResult({ score: sc, total, seconds, xp, levelUp });
    setPhase('done');
  };
  const choose = (o) => {
    if (picked) return;
    audioContext();
    setPicked(o.id);
    const right = o.id === qn.answer;
    if (right) setScore((x) => x + 1);
    setTimeout(() => {
      setPicked(null);
      if (qi + 1 < quiz.length) setQi(qi + 1);
      else finish(score + (right ? 1 : 0), quiz.length);
    }, right ? 650 : 1500);
  };

  const s = getState();
  const code = result ? makeChallengeCode({ lessonId: lesson.id, seed, score: result.score, seconds: result.seconds, initials: (s.settings.name || '').split(/\s+/).map((w) => w[0]).join('') }) : '';
  return (
    <SheetFrame title={tx(lesson.title, lang)} full>
      <div class={`c-${color}`} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {challenge && phase !== 'done' && <p class="note-text" style={{ textAlign: 'center' }}><Icon name="flag" size={14} /> {t('beatThis', { who: challenge.initials || '?', score: challenge.score, sec: challenge.seconds })}</p>}
        {phase === 'cards' && (
          <>
            <div class="dots">{lesson.cards.map((_, i) => <i key={i} class={i <= card ? 'on' : ''} />)}</div>
            <div class="lesson-card">{tx(lesson.cards[card], lang)}</div>
            {card === 0 && lesson.id.startsWith('read') && <div class="staff-card"><MiniStaff clef={lesson.id === 'read2' ? 'F' : 'G'} notes={lesson.id === 'read2' ? [{ step: 'G', alter: 0, octave: 2 }, { step: 'B', alter: 0, octave: 2 }, { step: 'D', alter: 0, octave: 3 }, { step: 'F', alter: 0, octave: 3 }, { step: 'A', alter: 0, octave: 3 }] : [{ step: 'E', alter: 0, octave: 4 }, { step: 'G', alter: 0, octave: 4 }, { step: 'B', alter: 0, octave: 4 }, { step: 'D', alter: 0, octave: 5 }, { step: 'F', alter: 0, octave: 5 }]} /></div>}
            <Button full onClick={() => { audioContext(); if (card + 1 < lesson.cards.length) setCard(card + 1); else if (lesson.quiz) setPhase('quiz'); else if (lesson.activity) setPhase('activity'); else finish(0, 0); }}>
              {card + 1 < lesson.cards.length ? t('next') : lesson.quiz || lesson.activity ? t('start') : t('finish')}
            </Button>
            {lesson.link === 'improvise' && <Button kind="secondary" color="purple" icon="sparkles" full onClick={() => { closeSheet(); go('improvise'); }}>{t('openImprovise')}</Button>}
          </>
        )}
        {phase === 'quiz' && qn && (
          <>
            <div class="dots">{quiz.map((_, i) => <i key={i} class={i <= qi ? 'on' : ''} />)}</div>
            <div class="q-prompt">{promptFor(qn, lang)}</div>
            {qn.staff && <div class="staff-card"><MiniStaff clef={qn.staff.clef} notes={qn.staff.notes || []} keySig={qn.staff.keySig || 0} rhythm={qn.staff.rhythm} /></div>}
            {qn.kind === 'keyboard' && <Keyboard lo={60} hi={71} marks={new Map([[qn.highlight, 'hl']])} height={110} />}
            {qn.play && <Button kind="secondary" icon="speaker" onClick={() => playQuestion(qn)}>{t('playAgain')}</Button>}
            <div class={`q-options${qn.options.length > 4 ? ' many' : ''}${qn.options.some((o) => String(o.label).length > 9) ? ' long' : ''}`}>
              {qn.options.map((o) => (
                <button type="button" key={o.id} class={`q-opt${picked && o.id === qn.answer ? ' right' : ''}${picked === o.id && o.id !== qn.answer ? ' wrong' : ''}`} onClick={() => choose(o)}>{optionLabel(qn, o, lang)}</button>
              ))}
            </div>
            <div class={`q-feedback ${picked ? (picked === qn.answer ? 'ok' : 'no') : ''}`}>{picked ? (picked === qn.answer ? t('correct') : t('notQuite', { a: optionLabel(qn, qn.options.find((o) => o.id === qn.answer), lang) })) : ''}</div>
          </>
        )}
        {phase === 'activity' && <Activity lesson={lesson} onDone={(sc, total) => finish(sc, total)} />}
        {phase === 'done' && result && (
          <>
            <div class="result-hero">
              <Badge icon="trophy" color={color} size={64} />
              <h2>{t('lessonComplete')}</h2>
              {result.total > 0 && <div class="score num">{result.score}/{result.total}</div>}
              <p class="sub num">{t('plusXP', { n: result.xp })} · {result.seconds} s</p>
              {result.levelUp && <p style={{ fontWeight: 700 }} class="t-orange">{t('levelN', { n: result.levelUp })} 🎉</p>}
              {challenge && <p style={{ fontWeight: 700 }} class={result.score > challenge.score || (result.score === challenge.score && result.seconds < challenge.seconds) ? 't-green' : 't-orange'}>
                {result.score > challenge.score || (result.score === challenge.score && result.seconds < challenge.seconds) ? t('youWon') : t('youLost')}</p>}
            </div>
            {result.total > 0 && (
              <Card>
                <strong>{t('challengeFriend')}</strong>
                <p class="sub">{t('challengeHelp')}</p>
                <div class="code" id="challenge-code">{code}</div>
                <Button kind="secondary" icon="paste" onClick={() => { navigator.clipboard?.writeText(code).then(() => toast(t('copied'))).catch(() => {}); }}>{t('copy')}</Button>
              </Card>
            )}
            <Button full onClick={closeSheet}>{t('done')}</Button>
          </>
        )}
      </div>
    </SheetFrame>
  );
}

// ---------- activities ----------

function Activity({ lesson, onDone }) {
  const a = lesson.activity;
  if (a.type === 'tap') return <TapActivity pattern={a.pattern} tempo={a.tempo} onDone={onDone} />;
  if (a.type === 'strings') return <StringsActivity onDone={onDone} />;
  if (a.type === 'voiceRange') return <VoiceRangeActivity onDone={onDone} />;
  if (a.type === 'drone') return <DroneActivity onDone={onDone} />;
  return <Button onClick={() => onDone(0, 0)}>{t('finish')}</Button>;
}

function TapActivity({ pattern, tempo, onDone }) {
  const vals = pattern.split(' ').map((x) => ({ q: 1, e: 0.5, h: 2 }[x] || 1));
  const onsets = [];
  let acc = 0;
  for (const v of vals) { onsets.push(acc); acc += v; }
  const spb = 60 / tempo;
  const [state, setS] = useState('idle');
  const [marks, setMarks] = useState([]);
  const start = useRef(0);
  const taps = useRef([]);
  const go2 = () => {
    const ctx = audioContext();
    taps.current = [];
    setMarks([]);
    const t0 = ctx.currentTime + 0.2;
    for (let i = 0; i < 4; i++) click(t0 + i * spb, i === 0);
    const total = Math.ceil(acc);
    for (let i = 0; i < total; i++) click(t0 + (4 + i) * spb, i % 4 === 0);
    start.current = t0 + 4 * spb;
    setS('count');
    setTimeout(() => setS('tap'), 4 * spb * 1000);
    setTimeout(() => evaluate(), (4 + total + 0.6) * spb * 1000 + 200);
  };
  const tap = () => {
    const ctx = audioContext();
    if (state !== 'tap' && state !== 'count') return;
    taps.current.push(ctx.currentTime - start.current);
    note(ctx.currentTime, 76, 0.08, 90, 'epiano');
  };
  const evaluate = () => {
    const res = onsets.map((o) => {
      const target = o * spb;
      const near = taps.current.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best), Infinity);
      const err = near === Infinity ? null : near - target;
      if (err === null || Math.abs(err) > 0.22) return { k: 'miss', err };
      return { k: Math.abs(err) <= 0.07 ? 'ok' : err < 0 ? 'early' : 'late', err };
    });
    setMarks(res);
    setS('done');
  };
  const okCount = marks.filter((m) => m.k === 'ok').length;
  const avg = marks.filter((m) => m.err !== null).reduce((s2, m) => s2 + Math.abs(m.err), 0) / Math.max(1, marks.filter((m) => m.err !== null).length);
  return (
    <>
      <div class="staff-card"><MiniStaff clef="G" rhythm={pattern.split(' ').map((x) => ({ type: { q: 'quarter', e: 'eighth', h: 'half' }[x] || 'quarter', dots: 0 }))} height={110} /></div>
      <p class="note-text" style={{ textAlign: 'center' }}>♩ = {tempo}</p>
      <button type="button" class="tap-pad" onPointerDown={tap}>{state === 'count' ? t('getReady') : t('tapHere')}</button>
      {marks.length > 0 && <>
        <div class="timeline">{marks.map((m, i) => <i key={i} class={m.k} />)}</div>
        <p style={{ textAlign: 'center', fontWeight: 600 }}>{t('timingResult', { ms: Math.round(avg * 1000), early: marks.filter((m) => m.k === 'early').length, late: marks.filter((m) => m.k === 'late').length })}</p>
      </>}
      <div class="btn-row">
        <Button onClick={go2} icon="play" disabled={state === 'count' || state === 'tap'}>{state === 'done' ? t('tryAgain') : t('start')}</Button>
        {state === 'done' && <Button kind="secondary" onClick={() => onDone(okCount, onsets.length)}>{t('finish')}</Button>}
      </div>
    </>
  );
}

function StringsActivity({ onDone }) {
  const sets = { violin: [55, 62, 69, 76], guitar: [40, 45, 50, 55, 59, 64], ukulele: [67, 60, 64, 69], cello: [36, 43, 50, 57] };
  const [inst, setInst] = useState('violin');
  return (
    <>
      <Segmented value={inst} onChange={setInst} options={Object.keys(sets).map((k) => ({ value: k, label: instrumentName(k) }))} />
      <div class="q-options many">{sets[inst].map((m) => <button type="button" key={m} class="q-opt" onClick={() => { const ctx = audioContext(); note(ctx.currentTime + 0.03, m, 2.2, 90, inst === 'violin' || inst === 'cello' ? 'strings' : 'guitar'); }}>{pitchName(spellMidi(m, 0))}</button>)}</div>
      <p class="note-text">{t('referenceTones')} · A4 = 440 Hz</p>
      <Button full onClick={() => onDone(0, 0)}>{t('finish')}</Button>
    </>
  );
}

function VoiceRangeActivity({ onDone }) {
  const s = getState();
  const [voice, setVoice] = useState(s.settings.voice || 'tenor');
  const [lo, setLo] = useState(null), [hi, setHi] = useState(null);
  const [mic, setMic] = useState(null);
  const stopRef = useRef(null);
  const measure = async (which) => {
    try {
      stopRef.current?.();
      const seen = [];
      setMic(which);
      stopRef.current = await listen((p) => { if (p) seen.push(p.midi); });
      setTimeout(() => {
        stopRef.current?.(); stopRef.current = null; setMic(null);
        if (seen.length < 5) return;
        const sorted = seen.slice().sort((a, b) => a - b);
        const v = Math.round(which === 'lo' ? sorted[Math.floor(sorted.length * 0.2)] : sorted[Math.floor(sorted.length * 0.8)]);
        if (which === 'lo') setLo(v); else setHi(v);
      }, 3000);
    } catch (e) { setMic(null); toast(t(e.code === 'denied' ? 'micDenied' : 'micUnavailable'), 'err'); }
  };
  useEffect(() => () => stopRef.current?.(), []);
  const save = () => {
    const range = lo !== null && hi !== null && hi > lo + 5 ? { lo, hi } : null;
    updateSettings({ voice, voiceRange: range });
    onDone(0, 0);
  };
  const vr = VOICE_RANGES[voice];
  return (
    <>
      <List>
        <Row title={t('voiceType')} right={<select id="vr-voice" value={voice} onChange={(e) => setVoice(e.currentTarget.value)}>{['soprano', 'mezzo', 'alto', 'tenor', 'baritone', 'bass'].map((v) => <option key={v} value={v}>{t(v === 'bass' ? 'bassVoice' : v)}</option>)}</select>} />
        <Row title={t('yourRange', { lo: pitchName(spellMidi(lo ?? vr.lo, 0)), hi: pitchName(spellMidi(hi ?? vr.hi, 0)) })} />
      </List>
      <p class="note-text">{t('singLowHigh')}</p>
      <div class="btn-row">
        <Button kind="secondary" icon="mic" onClick={() => measure('lo')} disabled={!!mic}>{mic === 'lo' ? t('listening') : t('lowest')}</Button>
        <Button kind="secondary" icon="mic" onClick={() => measure('hi')} disabled={!!mic}>{mic === 'hi' ? t('listening') : t('highest')}</Button>
      </div>
      <Button full onClick={save}>{t('save')}</Button>
    </>
  );
}

function DroneActivity({ onDone }) {
  const [on, setOn] = useState(null);
  useEffect(() => () => stopDrone(), []);
  const tonics = [['C', 48], ['D', 50], ['E', 52], ['F', 53], ['G', 55], ['A', 57], ['B♭', 58]];
  return (
    <>
      <div class="q-options many">{tonics.map(([n, m]) => <button type="button" key={n} class={`q-opt${on === m ? ' right' : ''}`} onClick={() => { audioContext(); if (on === m) { stopDrone(); setOn(null); } else { startDrone(m); setOn(m); } }}>{n}</button>)}</div>
      <p class="note-text">{on ? t('droneOn', { note: tonics.find((x) => x[1] === on)[0] }) : t('drone')}</p>
      <Button full onClick={() => { stopDrone(); onDone(0, 0); }}>{t('finish')}</Button>
    </>
  );
}

export function ChallengeSheet() {
  const [code, setCode] = useState('');
  const [err, setErr] = useState(false);
  const go3 = () => {
    const c = readChallengeCode(code);
    if (!c) { setErr(true); return; }
    openSheet('lesson', { lessonId: c.lessonId, seed: c.seed, challenge: c });
  };
  return (
    <SheetFrame title={t('challengeFriend')} right={t('start')} onRight={go3} rightDisabled={!code.trim()}>
      <p class="note-text">{t('challengeHelp')}</p>
      <input class="field" id="challenge-input" placeholder="HT-XXXXXX-XXXX-AT" value={code} onInput={(e) => { setCode(e.currentTarget.value); setErr(false); }} style={{ fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase' }} />
      {err && <p class="t-red">{t('badCode')}</p>}
      <Button full onClick={go3} disabled={!code.trim()} color="pink" icon="flag">{t('start')}</Button>
    </SheetFrame>
  );
}
