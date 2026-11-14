// The Classroom tabs of a class (server/classroom.py): Stream (announcements and comments), Classwork (assignments
// by topic, rubrics, class sessions with Calendar/Meet and .ics), People (invite by email or WhatsApp, mute,
// remove) and Grades (students x assignments, rubric grading, CSV).
import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, push, openSheet, closeSheet, toast } from '../state.js';
import { t, getLang } from '../../core/i18n.js';
import { Icon, Card, List, Row, Button, Chip, Toggle } from '../components.jsx';
import { SheetFrame } from './common.jsx';
import { academy } from '../api.js';
import { C } from '../account.js';
import { connectGoogle, toBase64, withGoogle } from '../google.js';
import { saveFile } from '../files.js';
import { openExternal } from '../native.js';
import { Person, useLoad, Loading, relTime, refreshClasses, MissionCard, TeacherMission } from './classes.jsx';

const when = (iso) => { try { return new Date(iso).toLocaleString(getLang(), { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch { return iso; } };

// ---------------------------------------------------------------- Stream
export function StreamPanel({ cid }) {
  const s = useApp();
  const st = useLoad(() => academy.stream(cid), [cid, s.academyRev]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const d = st.data;
  const teacher = d?.role === 'teacher';
  const post = async () => {
    setBusy(true);
    try { await academy.post(cid, { text: text.trim() }); setText(''); refreshClasses(); } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  if (!d) return <Loading error={st.error} />;
  return (
    <div class="cr-stream" id="cr-stream">
      {d.muted && !teacher ? <div class="banner"><Icon name="info" size={18} />{t('crMutedNote')}</div> : (
        <Card class="cr-compose">
          <textarea class="field prose" id="cr-post-text" rows={2} maxLength={4000} placeholder={teacher ? t('crAnnounce') : t('crShareClass')} value={text} onInput={(e) => setText(e.currentTarget.value)} />
          <div class="row-gap" style={{ justifyContent: 'flex-end' }}><Button small icon="send" disabled={busy || !text.trim()} onClick={post} id="cr-post">{t('crPost')}</Button></div>
        </Card>
      )}
      {d.posts.map((p) => <StreamPost key={p.id} p={p} teacher={teacher} muted={d.muted && !teacher} />)}
    </div>
  );
}

function StreamPost({ p, teacher, muted }) {
  const [txt, setTxt] = useState('');
  const send = async () => { try { await academy.comment(p.id, txt.trim()); setTxt(''); refreshClasses(); } catch (e) { toast(e.message, 'err'); } };
  const del = async () => { if (!confirm(t('delete'))) return; try { await academy.deletePost(p.id); refreshClasses(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Card class={`cr-post${p.kind === 'announcement' ? ' ann' : ''}`}>
      <div class="cr-post-head">
        <Person name={p.author?.name} color={p.author?.color || 'gray'} size={34} />
        <div class="t"><strong>{p.author?.name}</strong><span class="tiny muted">{relTime(p.created)}{p.pinned ? ` · ${t('crPinned')}` : ''}</span></div>
        {(teacher || p.mine) && <button type="button" class="icon-btn" aria-label={t('delete')} onClick={del}><Icon name="trash" size={17} /></button>}
      </div>
      <p class="cr-text">{p.text}</p>
      {p.comments.map((c) => (
        <div class="cr-comment" key={c.id}><Person name={c.author?.name} color={c.author?.color || 'gray'} size={26} /><div><strong>{c.author?.name}</strong> <span>{c.text}</span></div></div>
      ))}
      {!muted && (
        <form class="cr-reply" onSubmit={(e) => { e.preventDefault(); if (txt.trim()) send(); }}>
          <input class="field" value={txt} maxLength={1500} placeholder={t('crComment')} onInput={(e) => setTxt(e.currentTarget.value)} aria-label={t('crComment')} />
          <button type="submit" class="icon-btn" disabled={!txt.trim()} aria-label={t('sendT')}><Icon name="send" size={18} /></button>
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- Classwork
export function ClassworkPanel({ cid, c, teacher }) {
  const s = useApp();
  const cw = useLoad(() => academy.classwork(cid), [cid, s.academyRev]);
  const meta = Object.fromEntries((cw.data?.assignments || []).map((a) => [a.id, a]));
  const topics = cw.data?.topics || [];
  const groups = [...topics.map((tp) => ({ id: tp.id, name: tp.name })), { id: null, name: t('crNoTopic') }]
    .map((g) => ({ ...g, items: c.assignments.filter((a) => (meta[a.id]?.topic_id || null) === g.id) }))
    .filter((g) => g.items.length || (teacher && g.id));
  const addTopic = async () => { const name = prompt(t('crNewTopic')); if (!name?.trim()) return; try { await academy.addTopic(cid, name.trim()); refreshClasses(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <div class="mission-list" id="cr-classwork">
      {teacher && (
        <div class="row-gap" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Button kind="brand" icon="plus" onClick={() => openSheet('newAssignment', { classId: cid })} id="cr-new-asg">{t('newAssignment')}</Button>
          <Button kind="secondary" icon="folder" onClick={addTopic} id="cr-new-topic">{t('crNewTopic')}</Button>
        </div>
      )}
      <SessionsPanel cid={cid} teacher={teacher} />
      {!c.assignments.length && <Card class="classes-hello"><p>{teacher ? t('noAsgTeacher') : t('noAsgStudent')}</p></Card>}
      {groups.map((g) => (
        <section key={g.id || 'none'} class="cr-topic">
          {(topics.length > 0) && <h3 class="cr-topic-name">{g.name}</h3>}
          {g.items.map((a) => (
            <div key={a.id} class="cr-asg">
              {teacher ? <TeacherMission a={a} color={c.color} /> : <MissionCard a={a} color={c.color} />}
              <div class="cr-asg-meta">
                {meta[a.id]?.tempo_pct ? <span class="pill3">{t('crTargetTempo', { n: meta[a.id].tempo_pct })}</span> : null}
                {meta[a.id]?.goal ? <span class="pill3">{t('crMinScore', { n: meta[a.id].goal })}</span> : null}
                {meta[a.id]?.rubric?.length ? <span class="pill3">{t('crRubric')} · {meta[a.id].rubric.reduce((n, r) => n + r.points, 0)}</span> : null}
                {teacher && <button type="button" class="link-btn" onClick={() => openSheet('asgMeta', { aid: a.id, topics, meta: meta[a.id] })}>{t('crTopic')} / {t('crRubric')}</button>}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export function AsgMetaSheet({ aid, topics = [], meta = {} }) {
  const [topic, setTopic] = useState(meta?.topic_id || null);
  const [rubric, setRubric] = useState(meta?.rubric?.length ? meta.rubric : []);
  const set = (i, patch) => setRubric((r) => r.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const save = async () => {
    try { await academy.setMeta(aid, { topic_id: topic, rubric: rubric.filter((r) => r.criterion.trim()).map((r) => ({ criterion: r.criterion.trim(), points: Math.max(1, Math.min(100, r.points | 0)) })) }); refreshClasses(); closeSheet(); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <SheetFrame title={`${t('crTopic')} / ${t('crRubric')}`} right={t('done')} onRight={save}>
      <span class="tiny">{t('crTopic')}</span>
      <div class="chips wrap"><Chip on={!topic} onClick={() => setTopic(null)}>{t('crNoTopic')}</Chip>{topics.map((tp) => <Chip key={tp.id} on={topic === tp.id} onClick={() => setTopic(tp.id)}>{tp.name}</Chip>)}</div>
      <span class="tiny">{t('crRubric')}</span>
      {rubric.map((r, i) => (
        <div class="row-gap" key={i} style={{ gap: 8 }}>
          <input class="field" style={{ flex: 1 }} value={r.criterion} placeholder={t('crCriterion')} maxLength={80} onInput={(e) => set(i, { criterion: e.currentTarget.value })} />
          <input class="field" style={{ width: 70 }} type="number" min="1" max="100" value={r.points} onInput={(e) => set(i, { points: Number(e.currentTarget.value) })} aria-label="points" />
          <button type="button" class="icon-btn" aria-label={t('delete')} onClick={() => setRubric((x) => x.filter((_, k) => k !== i))}><Icon name="trash" size={17} /></button>
        </div>
      ))}
      {rubric.length < 12 && <Button small kind="secondary" icon="plus" onClick={() => setRubric((x) => [...x, { criterion: '', points: 4 }])}>{t('crRubricAdd')}</Button>}
    </SheetFrame>
  );
}

// ---------------------------------------------------------------- Sessions (Calendar / Meet / .ics)
function SessionsPanel({ cid, teacher }) {
  const s = useApp();
  const ses = useLoad(() => academy.sessions(cid), [cid, s.academyRev]);
  const ics = async () => {
    try { const res = await academy.sessionsIcs(cid); await saveFile('class.ics', new Uint8Array(await res.arrayBuffer())); } catch (e) { toast(e.message, 'err'); }
  };
  const list = ses.data?.sessions || [];
  if (!teacher && !list.length) return null;
  return (
    <Card class="cr-sessions" id="cr-sessions">
      <div class="row-gap" style={{ justifyContent: 'space-between' }}><strong>{t('crSessions')}</strong>
        {teacher && <Button small icon="calendar" onClick={() => openSheet('session', { cid })} id="cr-new-session">{t('crNewSession')}</Button>}</div>
      {list.map((x) => (
        <div class={`cr-session${x.cancelled ? ' off' : ''}`} key={x.id}>
          <Icon name="calendar" size={18} /><div class="t"><strong>{x.title}</strong><span class="tiny">{when(x.start)} · {x.minutes} min{x.cancelled ? ` · ${t('crCancelled')}` : ''}</span></div>
          {x.meet_url && !x.cancelled && <Button small kind="secondary" icon="video" onClick={() => openExternal(x.meet_url)}>{t('crJoinMeet')}</Button>}
        </div>
      ))}
      {list.length > 0 && <button type="button" class="link-btn" onClick={ics} id="cr-ics">{t('crIcs')}</button>}
    </Card>
  );
}

export function SessionSheet({ cid }) {
  const [title, setTitle] = useState('');
  const [at, setAt] = useState(() => { const d = new Date(Date.now() + 86400000); d.setMinutes(0, 0, 0); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); });
  const [minutes, setMinutes] = useState(45);
  const [meet, setMeet] = useState(true);
  const [cal, setCal] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { C.gconn.list().then((r) => setCal(r)).catch(() => setCal({ available: false, features: [] })); }, []);
  const linked = cal?.features?.find((f) => f.id === 'calendar')?.linked;
  const save = async () => {
    setBusy(true);
    try {
      const r = await academy.addSession(cid, { title: title.trim() || t('crSessions'), start: new Date(at).toISOString(), minutes, meet });
      toast(r.calendar ? t('conn_calendar') : t('crSessions'));
      refreshClasses(); closeSheet();
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <SheetFrame title={t('crNewSession')} right={t('done')} onRight={save} rightDisabled={busy}>
      <label class="field3"><span>{t('songTitle')}</span><input id="session-title" value={title} maxLength={160} onInput={(e) => setTitle(e.currentTarget.value)} /></label>
      <label class="field3"><span>{t('when')}</span><input type="datetime-local" value={at} onInput={(e) => setAt(e.currentTarget.value)} /></label>
      <div class="chips wrap">{[30, 45, 60, 90].map((m) => <Chip key={m} on={minutes === m} onClick={() => setMinutes(m)}>{m} min</Chip>)}</div>
      {cal && (linked
        ? <Row icon="video" color="green" title="Google Meet" right={<Toggle id="session-meet" checked={meet} onChange={setMeet} label="Google Meet" />} chevron={false} />
        : <div class="banner"><Icon name="calendar" size={18} /><div style={{ flex: 1 }}>{t('crCalendarHint')}</div>
          {cal.available && <Button small onClick={async () => { try { setCal(await connectGoogle('calendar')); } catch (e) { toast(e.message, 'err'); } }}>{t('connect')}</Button>}</div>)}
      <Button full icon="calendar" disabled={busy} onClick={save} id="session-save">{t('crNewSession')}</Button>
    </SheetFrame>
  );
}

// ---------------------------------------------------------------- People
export function PeoplePanel({ cid, teacher, onRemove }) {
  const s = useApp();
  const pl = useLoad(() => academy.people(cid), [cid, s.academyRev]);
  const mute = async (p) => { try { await academy.mute(cid, p.id, p.muted ? 0 : 60 * 24 * 7); refreshClasses(); } catch (e) { toast(e.message, 'err'); } };
  if (!pl.data) return <Loading error={pl.error} />;
  const row = (p) => (
    <div class="row" key={p.id}>
      <Person name={p.name} color={p.color} size={32} />
      <span class="row-main"><span class="row-title">{p.name}</span><span class="row-sub">{p.role === 'teacher' ? t('teacherT') : (p.email || t('studentT'))}{p.muted ? ` · ${t('crMuted')}` : ''}</span></span>
      {teacher && p.role === 'student' && <>
        <button type="button" class="link-btn" onClick={() => mute(p)}>{p.muted ? t('crUnmute') : t('crMute')}</button>
        <button type="button" class="icon-btn" aria-label={t('delete')} onClick={() => onRemove?.(p)}><Icon name="trash" size={18} /></button>
      </>}
    </div>
  );
  return (
    <div id="cr-people">
      {teacher && <Button icon="send" onClick={() => openSheet('invite', { cid })} id="cr-invite">{t('crInvite')}</Button>}
      <h3 class="cr-topic-name">{t('teacherT')}</h3>
      <List>{pl.data.teachers.map(row)}</List>
      <h3 class="cr-topic-name">{t('studentsT')} · {pl.data.students.length}</h3>
      <List>{pl.data.students.map(row)}</List>
    </div>
  );
}

export function InviteSheet({ cid }) {
  const [text, setText] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const emails = text.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /.+@.+\..+/.test(x));
  const send = async () => { setBusy(true); try { setRes(await academy.invite(cid, emails)); refreshClasses(); } catch (e) { toast(e.message, 'err'); } setBusy(false); };
  const fromContacts = async () => {
    try { const r = await withGoogle('contacts', () => C.gconn.contacts()); setText((x) => [x, ...r.contacts.map((c) => c.email)].filter(Boolean).join('\n')); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <SheetFrame title={t('crInvite')}>
      {!res ? (
        <>
          <label class="field3"><span>{t('crInviteEmails')}</span><textarea class="field" id="invite-emails" rows={4} value={text} onInput={(e) => setText(e.currentTarget.value)} /></label>
          <Button kind="plain" small icon="users" onClick={fromContacts}>{t('crFromContacts')}</Button>
          <Button full icon="send" disabled={busy || !emails.length} onClick={send} id="invite-send">{t('crInvite')} ({emails.length})</Button>
        </>
      ) : (
        <>
          <p><strong>{t('crInvited', { n: res.invited })}</strong></p>
          <p class="note-text">{res.text}</p>
          <Button full kind="secondary" icon="chat" onClick={() => openExternal(res.whatsapp)} id="invite-wa">{t('crWhatsApp')}</Button>
          <Button full kind="secondary" icon="send" onClick={() => openExternal(res.mailto)}>{t('crEmailApp')}</Button>
          <Button full kind="plain" icon="copy" onClick={async () => { try { await navigator.clipboard.writeText(res.text); toast(t('copied')); } catch { toast(res.link); } }}>{t('copied').replace(/[.!]$/, '')}</Button>
        </>
      )}
    </SheetFrame>
  );
}

// ---------------------------------------------------------------- Grades
const STATUS_TXT = { missing: 'crMissing', turned_in: 'crTurnedIn', reached: 'crReached', graded: 'crGraded' };
export function GradesPanel({ cid, c }) {
  const s = useApp();
  const gr = useLoad(() => academy.grades(cid), [cid, s.academyRev]);
  const csv = async () => {
    try { const res = await academy.gradesCsv(cid); await saveFile(`${c.name} grades.csv`, new Uint8Array(await res.arrayBuffer())); } catch (e) { toast(e.message, 'err'); }
  };
  const g = gr.data;
  if (!g) return <Loading error={gr.error} />;
  return (
    <div id="cr-grades">
      <div class="row-gap" style={{ justifyContent: 'flex-end' }}><Button small kind="secondary" icon="download" onClick={csv} id="cr-csv">{t('crExportCsv')}</Button></div>
      <div class="cr-grid-wrap hscroll">
        <table class="cr-grid">
          <thead><tr><th>{t('studentT')}</th>{g.assignments.map((a) => <th key={a.id}>{a.title}<small>{t('crMinScore', { n: a.goal })}</small></th>)}</tr></thead>
          <tbody>
            {g.students.map((st) => (
              <tr key={st.id}>
                <th><button type="button" class="link-btn" onClick={() => push('student', { classId: cid, uid: st.id, name: st.name })}>{st.name}</button></th>
                {g.assignments.map((a) => {
                  const cell = g.cells[st.id]?.[a.id] || { status: 'missing' };
                  return (
                    <td key={a.id} class={`st-${cell.status || 'missing'}`}>
                      <button type="button" onClick={() => openSheet('grade', { cid, a, student: st, cell })} aria-label={`${st.name} ${a.title}`}>
                        <b>{cell.grade != null ? cell.grade : cell.best != null ? `${cell.best}%` : '–'}</b>
                        <small>{cell.grade != null && cell.best != null ? `${cell.best}% · ` : ''}{t(STATUS_TXT[cell.status || 'missing'])}{cell.late ? ' · ⏰' : ''}</small>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function GradeSheet({ cid, a, student, cell }) {
  const [rubric, setRubric] = useState(null);
  const [scores, setScores] = useState([]);
  const [grade, setGrade] = useState(cell.grade ?? '');
  useEffect(() => {
    // the rubric comes with the class's classwork
    academy.classwork(cid).then((cw) => {
      const m = cw.assignments.find((x) => x.id === a.id);
      setRubric(m?.rubric || []);
      setScores(cell.rubric_scores?.length ? cell.rubric_scores : (m?.rubric || []).map(() => 0));
    }).catch(() => setRubric([]));
  }, [a.id]);
  const save = async () => {
    try {
      await academy.grade(a.id, student.id, rubric?.length ? { rubric_scores: scores.map((x) => x | 0) } : { grade: grade === '' ? null : Number(grade) });
      toast(t('crGraded')); refreshClasses(); closeSheet();
    } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <SheetFrame title={`${student.name} · ${a.title}`} right={t('crReturn')} onRight={save}>
      <p class="note-text">{cell.best != null ? `${t('avgScore')}: ${cell.best}% · ${cell.tries}×` : t('crMissing')}</p>
      {rubric === null ? <div class="loading"><div class="spinner" /></div> : rubric.length ? rubric.map((r, i) => (
        <div class="row-gap" key={i} style={{ justifyContent: 'space-between' }}>
          <span>{r.criterion}</span>
          <span class="chips">{Array.from({ length: r.points + 1 }, (_, k) => <Chip key={k} on={scores[i] === k} onClick={() => setScores((x) => x.map((y, j) => (j === i ? k : y)))}>{k}</Chip>)}</span>
        </div>
      )) : <label class="field3"><span>{t('crGradeT')}</span><input id="grade-value" type="number" min="0" max="1000" value={grade} onInput={(e) => setGrade(e.currentTarget.value)} /></label>}
      <Button full icon="check" onClick={save} id="grade-save">{t('crReturn')}</Button>
    </SheetFrame>
  );
}

// ---------------------------------------------------------------- voice comments
/** Record a short voice comment on a submission or a take, with the bars to listen for. */
export function VoiceNote({ target, id, bars = [] }) {
  const [rec, setRec] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState([]);
  const [hl, setHl] = useState(bars.join(', '));
  const chunks = useRef([]);
  useEffect(() => { academy.audioNotes(target, id).then((r) => setNotes(r.notes)).catch(() => {}); }, [id]);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((x) => globalThis.MediaRecorder?.isTypeSupported?.(x)) || '';
      const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      mr.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      mr.start();
      setRec({ mr, stream, t0: Date.now() });
    } catch (e) { toast(e.message || String(e), 'err'); }
  };
  const stop = () => new Promise((resolve) => { rec.mr.onstop = resolve; rec.mr.stop(); rec.stream.getTracks().forEach((x) => x.stop()); });
  const send = async () => {
    setBusy(true);
    try {
      await stop();
      const blob = new Blob(chunks.current, { type: rec.mr.mimeType || 'audio/webm' });
      const barList = hl.split(/[\s,]+/).flatMap((x) => { const m = /^(\d+)(?:-(\d+))?$/.exec(x); if (!m) return []; const a = +m[1], b = +(m[2] || m[1]); return Array.from({ length: Math.min(64, Math.max(0, b - a + 1)) }, (_, i) => a + i); });
      await academy.audioNote(target, id, { audio_b64: toBase64(new Uint8Array(await blob.arrayBuffer())), audio_type: blob.type || 'audio/webm', bars: barList.slice(0, 64) });
      setRec(null);
      const r = await academy.audioNotes(target, id); setNotes(r.notes);
      toast(t('feedbackSent'));
    } catch (e) { toast(e.message || String(e), 'err'); setRec(null); }
    setBusy(false);
  };
  const play = async (nid) => { try { const url = await academy.audioNoteURL(nid); new Audio(url).play(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <div class="voice-note">
      <h3 class="sheet-sub">{t('crVoiceNote')}</h3>
      {notes.map((n) => <Row key={n.id} icon="play" color="violet" title={t('crVoiceNote')} subtitle={n.bars.length ? `${t('bars')} ${n.bars.join(', ')}` : relTime(n.created)} onClick={() => play(n.id)} />)}
      <label class="field3"><span>{t('crHighlight')}</span><input value={hl} onInput={(e) => setHl(e.currentTarget.value)} /></label>
      {rec ? <Button full kind="brand" icon="send" disabled={busy} onClick={send}>{t('crStopSend')}</Button>
        : <Button full kind="secondary" icon="mic" onClick={start}>{t('crRecordVoice')}</Button>}
    </div>
  );
}
