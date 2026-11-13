// A student's progress in a class, as the teacher sees it (and the student, for their own): every Play Along
// try and shared practice take, newest first, each with its score, the bars and the notes that went wrong,
// the recording to listen to, and the teacher's comments. Plus the sheet a student uses to share a take.
import { useEffect, useState } from 'preact/hooks';
import { useApp, closeSheet, toast } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, Button, Chip } from '../components.jsx';
import { NavBar, SheetFrame } from './common.jsx';
import { Mascot, Confetti } from '../mascot.jsx';
import { academy, academyMe } from '../api.js';
import { relTime, refreshClasses } from './classes.jsx';
import { blobToB64 } from './piece.jsx';
import { whenSignedIn } from './hub.jsx';

const STICKERS = [['star', '⭐'], ['fire', '🔥'], ['clap', '👏'], ['heart', '❤️'], ['rocket', '🚀'], ['trophy', '🏆'], ['music', '🎵'], ['thumbs', '👍']];
const EMOJI = Object.fromEntries(STICKERS);
const mins = (s) => (s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

export function StudentView({ classId, uid, name, active }) {
  const s = useApp();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [rev, setRev] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    academy.student(classId, uid).then((d) => alive && setData(d)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [classId, uid, rev, active, s.academyRev]);
  const items = data?.items || [];
  const teacher = data?.role === 'teacher';
  const last = items.slice(0, 5);
  const avg = last.length ? Math.round(last.reduce((a, b) => a + b.accuracy, 0) / last.length) : null;
  const minutes = Math.round(items.reduce((a, b) => a + (b.seconds || 0), 0) / 60);
  return (
    <div class="scroll" id="student-view">
      <NavBar title={data?.student?.name || name || ''} backLabel={t('back')} />
      <div class="wrap" style={{ paddingTop: 12 }}>
        {err && <div class="empty3 card"><Mascot mood="sad" size={70} /><p>{err}</p></div>}
        {!data && !err && <div class="loading"><Mascot mood="think" size={64} /></div>}
        {data && <>
          <div class="bento stagger">
            <div class="tile3 w2 c-orange"><span class="k"><Icon name="star" size={14} />{t('avgScore')}</span><span class="big">{avg ?? '–'}<small>{avg != null ? '%' : ''}</small></span><div class="meter"><i style={{ width: `${avg || 0}%` }} /></div></div>
            <div class="tile3 w2 c-blue"><span class="k"><Icon name="mic" size={14} />{t('takesT')}</span><span class="big">{items.length}</span><span class="tiny">{t('withRecordingN', { n: items.filter((x) => x.has_recording).length })}</span></div>
            <div class="tile3 w2 c-teal"><span class="k"><Icon name="clock" size={14} />{t('practisedT')}</span><span class="big">{minutes}<small> min</small></span><span class="tiny">{items[0] ? t('lastPlayed', { when: relTime(items[0].created) }) : ''}</span></div>
            {data.tricky?.length > 0 && (
              <div class="tile3 w6"><span class="k"><Icon name="flag" size={14} />{t('trickyBarsAll')}</span>
                <div class="row-gap">{data.tricky.map((b) => <span key={b.bar} class={`pill3 ${b.accuracy < 60 ? 'c-pink' : 'c-orange'}`}>{t('bar', { n: b.bar })} · {b.accuracy}%</span>)}</div></div>
            )}
          </div>
          {!items.length && <div class="empty3 card"><Mascot mood="sleep" size={80} /><h3>{t('noTakesYet')}</h3><p>{teacher ? t('noTakesTeacher') : t('noTakesStudent')}</p></div>}
          <div class="takes">{items.map((it) => <TakeCard key={it.id} it={it} teacher={teacher} onChanged={() => setRev((x) => x + 1)} />)}</div>
        </>}
      </div>
    </div>
  );
}

function TakeCard({ it, teacher, onChanged }) {
  const [audio, setAudio] = useState('');
  const [loadingRec, setLoadingRec] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [stk, setStk] = useState([]);
  const [focus, setFocus] = useState([]);
  const [busy, setBusy] = useState(false);
  const listen = async () => {
    setLoadingRec(true);
    try { setAudio(it.kind === 'take' ? await academy.takeRecordingURL(it.id) : await academy.recordingURL(it.id)); } catch (e) { toast(e.message, 'err'); }
    setLoadingRec(false);
  };
  const send = async () => {
    setBusy(true);
    try {
      const body = { text: text.trim(), stickers: stk, focus_bars: focus };
      if (it.kind === 'take') await academy.takeFeedback(it.id, body); else await academy.feedback(it.id, body);
      toast(t('feedbackSent')); setOpen(false); setText(''); setStk([]); setFocus([]); onChanged?.();
    } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  const lowBars = (it.bars || []).filter((b) => Array.isArray(b) && b[1] < 0.85).map((b) => b[0]);
  return (
    <div class={`take-card ${it.accuracy >= 85 ? 'good' : it.accuracy >= 60 ? 'mid' : 'low'}`}>
      <div class="tc-top">
        <span class="tc-score num">{it.accuracy}%</span>
        <div class="tc-main"><strong>{it.piece_title || t('practiceTake')}</strong>
          <span class="muted">{it.kind === 'assignment' ? t('assignmentT') : t('practiceTake')} · {relTime(it.created)}{it.tempo_pct ? ` · ${it.tempo_pct}%` : ''}{it.seconds ? ` · ${mins(it.seconds)}` : ''}</span></div>
        {it.has_recording && !audio && <Button small kind="secondary" icon="speaker" onClick={listen} disabled={loadingRec}>{t('listen')}</Button>}
      </div>
      {audio && <audio controls autoPlay src={audio} class="tc-audio" />}
      {it.bars?.length > 1 && <div class="bar-strip">{it.bars.map((b, i) => (Array.isArray(b) ? <i key={i} title={`${t('bar', { n: b[0] })}: ${Math.round(b[1] * 100)}%`} style={{ '--a': b[1] }} class={b[1] >= 0.85 ? 'ok' : b[1] >= 0.6 ? 'mid' : 'low'} /> : null))}</div>}
      {it.wrong?.length > 0 && (
        <div class="tc-wrong">{it.wrong.slice(0, 8).map((w, i) => <span key={i} class="wn-chip">{t('bar', { n: w.bar })}: {w.played ? <><s>{w.played}</s>→<b>{w.want}</b></> : <b>{w.want}</b>}</span>)}</div>
      )}
      {it.note && <p class="tc-note">{it.note}</p>}
      {it.feedback?.map((f, i) => (
        <div class="tc-fb" key={i}><Icon name="chat" size={15} /><span>{f.stickers?.map((k) => EMOJI[k]).join(' ')} {f.text}{f.focus_bars?.length ? ` · ${t('focusOn')} ${f.focus_bars.join(', ')}` : ''}</span></div>
      ))}
      {teacher && !open && <button type="button" class="hw-skip" onClick={() => setOpen(true)}>{t('giveFeedback')}</button>}
      {teacher && open && (
        <div class="tc-reply">
          <div class="row-gap">{STICKERS.map(([k, e]) => <button type="button" key={k} class={`stk${stk.includes(k) ? ' on' : ''}`} onClick={() => setStk(stk.includes(k) ? stk.filter((x) => x !== k) : [...stk, k])}>{e}</button>)}</div>
          {lowBars.length > 0 && <div class="chips wrap"><span class="tiny">{t('focusOn')}</span>{lowBars.slice(0, 10).map((b) => <Chip key={b} on={focus.includes(b)} onClick={() => setFocus(focus.includes(b) ? focus.filter((x) => x !== b) : [...focus, b])}>{b}</Chip>)}</div>}
          <label class="field3"><textarea rows={2} value={text} onInput={(e) => setText(e.currentTarget.value)} placeholder={t('feedbackPh')} maxLength={2000} /></label>
          <div class="row-gap"><Button small onClick={send} disabled={busy || (!text.trim() && !stk.length && !focus.length)} icon="send">{t('send')}</Button><button type="button" class="hw-skip" onClick={() => setOpen(false)}>{t('cancel')}</button></div>
        </div>
      )}
    </div>
  );
}

/** After a Play Along: share the take (score, wrong notes, recording) with one or more of your classes. */
export function TakeSheet({ result }) {
  const s = useApp();
  const [classes, setClasses] = useState(null);
  const [pick, setPick] = useState([]);
  const [withRec, setWithRec] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    academyMe(s.settings.name).then((r) => {
      const mine = (r.classes || []).filter((c) => c.role === 'student');
      setClasses(mine);
      setPick(mine.slice(0, 1).map((c) => c.id));
    }).catch(() => setClasses([]));
  }, []);
  const send = () => whenSignedIn(async () => {
    setBusy(true);
    try {
      const rec = withRec && result.recording?.blob ? await blobToB64(result.recording.blob) : null;
      await academy.shareTake({
        class_ids: pick, piece_title: result.title || '', accuracy: Math.round(result.accuracy * 1000) / 1000, timing: result.inTune ?? null,
        tempo_pct: Math.round((result.speed || 1) * 100), seconds: result.seconds || 0, mode: result.mode || '',
        bars: (result.barsList || []).map((b) => [Number(b.bar) || 0, Math.round(b.accuracy * 100) / 100]),
        wrong: (result.wrong || []).slice(0, 40).map((w) => ({ bar: Number(w.bar) || 0, want: w.want, played: w.played || '' })),
        note: note.trim(), recording_b64: rec, recording_type: rec ? result.recording.type : null,
      });
      result.shared = true;
      refreshClasses();
      setDone(true);
    } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  }, 'student');
  if (done) {
    return (
      <SheetFrame title={t('shareWithClass')} right={t('done')} onRight={closeSheet} left={false}>
        <Confetti />
        <div class="empty3"><Mascot mood="cheer" size={96} /><h3>{t('takeShared')}</h3><p>{t('takeSharedSub')}</p></div>
      </SheetFrame>
    );
  }
  return (
    <SheetFrame title={t('shareWithClass')} right={t('send')} onRight={send} rightDisabled={busy || !pick.length}>
      <div class="take-sum"><span class="tc-score num">{Math.round(result.accuracy * 100)}%</span><div><strong>{result.title}</strong><span class="muted">{t('reportWrong', { n: result.wrong?.length || 0 })}</span></div></div>
      {classes === null ? <div class="loading"><div class="spinner" /></div> : classes.length ? <>
        <span class="tiny">{t('shareWithWhich')}</span>
        <div class="chips wrap">{classes.map((c) => <Chip key={c.id} on={pick.includes(c.id)} onClick={() => setPick(pick.includes(c.id) ? pick.filter((x) => x !== c.id) : [...pick, c.id])}>{c.name}</Chip>)}</div>
      </> : <div class="empty3"><p>{t('noClassToShare')}</p></div>}
      {result.recording && (
        <label class="toggle-row"><input type="checkbox" checked={withRec} onChange={(e) => setWithRec(e.currentTarget.checked)} /><span>{t('includeRecording', { s: result.recording.seconds || 0 })}</span></label>
      )}
      {!result.recording && <p class="tiny">{t('noRecordingNote')}</p>}
      <label class="field3"><span>{t('noteToTeacher')}</span><textarea rows={2} value={note} onInput={(e) => setNote(e.currentTarget.value)} maxLength={1000} /></label>
      <Button full icon="send" onClick={send} disabled={busy || !pick.length} id="take-send">{busy ? t('sending') : t('send')}</Button>
    </SheetFrame>
  );
}
