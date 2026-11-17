// Learn, grown up (Part 2 C; server/learn.py): My work (To do · Done · Missing), a class's path, the teacher's
// glance with nudges, assignment kinds and turning in, private comments, parents and guardians and their weekly
// page, the class Drive folder, and importing a roster.
import { useEffect, useState } from 'preact/hooks';
import { useApp, push, openSheet, closeSheet, toast } from '../state.js';
import { t, getLang } from '../../core/i18n.js';
import { Icon, Button, Chip, Segmented, Empty } from '../components.jsx';
import { NavBar, SheetFrame } from './common.jsx';
import { academy, hasServer } from '../api.js';
import { openExternal } from '../native.js';
import { Person, useLoad, Loading, MissionCard, refreshClasses } from './classes.jsx';

export const KINDS = [['play', 'mic'], ['record', 'wave'], ['theory', 'quiz'], ['compose', 'pencil'], ['listen', 'ear']];
const KIND_ICON = Object.fromEntries(KINDS);
export function KindPill({ kind }) {
  if (!kind || kind === 'play') return null;
  return <span class="pill3 kind-pill" data-kind={kind}><Icon name={KIND_ICON[kind] || 'flag'} size={12} stroke={2.4} />{t(`kind_${kind}`)}</span>;
}
const dateText = (iso) => (iso ? new Date(iso).toLocaleDateString(getLang(), { day: 'numeric', month: 'short' }) : '');

// ---------------------------------------------------------------- My work (students)
export function MyWork() {
  const s = useApp();
  const [tab, setTab] = useState('todo');
  const st = useLoad(() => academy.work(), [s.academyRev]);
  const w = st.data;
  if (!w) return st.error ? null : <div class="skeleton-rows"><i /><i /></div>;
  if (!w.todo.length && !w.done.length && !w.missing.length) return null;
  const list = w[tab] || [];
  return (
    <section class="sec3" id="my-work">
      <div class="section-head"><h2>{t('myWork')}</h2><button type="button" class="link-btn" onClick={() => openSheet('guardians', {})} id="my-guardians">{t('parentsT')}</button></div>
      <Segmented id="work-tabs" value={tab} onChange={setTab} options={[
        { value: 'todo', label: `${t('workTodo')} · ${w.todo.length}` }, { value: 'done', label: `${t('workDone')} · ${w.done.length}` },
        { value: 'missing', label: `${t('workMissing')} · ${w.missing.length}` }]} />
      <div class="mission-list" style={{ marginTop: 10 }}>
        {list.length ? list.slice(0, 12).map((a) => <div key={a.id} class="work-row"><MissionCard a={a} /><KindPill kind={a.kind} /></div>)
          : <p class="tiny muted" style={{ padding: '8px 4px' }}>{t(tab === 'missing' ? 'workNoneMissing' : tab === 'done' ? 'workNoneDone' : 'workNoneTodo')}</p>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- the path (a class, for a student)
export function PathPanel({ cid }) {
  const s = useApp();
  const st = useLoad(() => academy.path(cid), [cid, s.academyRev]);
  const p = st.data;
  if (!p) return <Loading error={st.error} />;
  if (!p.total) return <p class="tiny muted">{t('noAsgStudent')}</p>;
  const pct = p.done == null ? null : Math.round((p.done / Math.max(1, p.total)) * 100);
  return (
    <div id="class-path">
      {pct != null && <div class="path-sum"><div class="path-bar"><i style={{ width: `${pct}%` }} /></div><span>{t('pathDone', { n: p.done, of: p.total })}</span></div>}
      {p.topics.map((g) => (
        <section key={g.id || 'loose'} class="path-topic">
          {g.name && <h3 class="cr-topic-name">{g.name}</h3>}
          <ol class="path-list">
            {g.assignments.map((a) => (
              <li key={a.id} class={`path-step ${a.place || ''}`}>
                <button type="button" onClick={() => push('assignment', { id: a.id })}>
                  <span class="dot">{a.place === 'done' ? <Icon name="check" size={14} stroke={3} /> : a.place === 'missing' ? '!' : ''}</span>
                  <span class="ps-t"><strong>{a.title}</strong><span>{[a.piece_title, t(`kind_${a.kind}`), a.done != null ? t('doneOf', { n: a.done, of: a.of }) : a.place === 'now' ? t('pathNow') : dateText(a.due_at)].filter(Boolean).join(' · ')}</span></span>
                  {a.best != null && <span class="ps-best">{a.best}%</span>}
                </button>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the teacher's glance (all classes, or one)
function GlanceCard({ c, onNudged }) {
  const [busy, setBusy] = useState(false);
  const nudge = async (ids) => {
    setBusy(true);
    try { const r = await academy.nudge(c.id, ids); toast(r.sent ? t('nudgedN', { n: r.sent }) : t('nudgedAlready')); onNudged?.(); } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  const fresh = c.quiet.filter((q) => !q.nudged);
  return (
    <div class={`glance c-${c.color || 'orange'}`} id={`glance-${c.id}`}>
      <div class="gl-head"><strong>{c.name}</strong><span class="muted">{t('studentsN', { n: c.students })}</span></div>
      <div class="gl-stats">
        <button type="button" onClick={() => push('classView', { id: c.id, tab: 'grades' })}><b>{c.to_review}</b><span>{t('glToReview')}</span></button>
        <span><b>{c.quiet.length}</b><span>{t('glQuiet')}</span></span>
        <span><b>{c.missing.reduce((n, x) => n + x.n, 0)}</b><span>{t('glMissing')}</span></span>
      </div>
      {c.quiet.length > 0 && <div class="gl-quiet">
        {c.quiet.slice(0, 5).map((q) => <span key={q.id} class="gl-person"><Person name={q.name} size={26} />{q.name}<small>{t('daysQuiet', { n: q.days })}</small></span>)}
        <Button small kind="brand" icon="bell" disabled={busy || !fresh.length} onClick={() => nudge(fresh.map((q) => q.id))} id={`nudge-${c.id}`}>{fresh.length ? t('nudgeN', { n: fresh.length }) : t('nudgedToday')}</Button>
      </div>}
    </div>
  );
}

export function TeacherGlance({ cid = null }) {
  const s = useApp();
  const [rev, setRev] = useState(0);
  const st = useLoad(() => academy.teacherOverview(), [s.academyRev, rev]);
  const list = (st.data?.classes || []).filter((c) => !cid || c.id === cid);
  if (!list.length) return null;
  return (
    <section class="sec3" id="teacher-glance">
      {!cid && <div class="section-head"><h2>{t('glanceT')}</h2></div>}
      <div class="glance-list">{list.map((c) => <GlanceCard key={c.id} c={c} onNudged={() => setRev((x) => x + 1)} />)}</div>
    </section>
  );
}

// ---------------------------------------------------------------- turning in (kinds other than Play Along)
export function TurnInCard({ a, onDone }) {
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try { await academy.turnIn(a.id, { text: text.trim(), link: link.trim() }); toast(t('turnedIn')); refreshClasses(); onDone?.(); } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  const okLink = !link || /^https:\/\/\S+$/.test(link.trim());
  return (
    <div class="turnin card-ish" id="turn-in">
      {a.prompt && <p class="ti-prompt"><Icon name={KIND_ICON[a.kind] || 'quiz'} size={16} />{a.prompt}</p>}
      <label class="field3"><span>{t(a.kind === 'theory' || a.kind === 'listen' ? 'yourAnswer' : 'aNote')}</span>
        <textarea id="ti-text" rows={a.kind === 'theory' ? 4 : 2} maxLength={4000} value={text} onInput={(e) => setText(e.currentTarget.value)} /></label>
      {a.kind !== 'theory' && <label class="field3"><span>{t(a.kind === 'record' ? 'tiLinkRecord' : 'tiLink')}</span>
        <input id="ti-link" type="url" inputMode="url" placeholder="https://" value={link} onInput={(e) => setLink(e.currentTarget.value)} /></label>}
      <Button kind="brand" full icon="send" disabled={busy || (!text.trim() && !link.trim()) || !okLink} onClick={send} id="ti-send">{t('turnIn')}</Button>
    </div>
  );
}

// ---------------------------------------------------------------- private comments
export function PrivateThread({ aid, student = null }) {
  const [items, setItems] = useState(null);
  const [text, setText] = useState('');
  const load = () => academy.privateThread(aid, student).then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { load(); }, [aid, student]);
  const send = async () => {
    if (!text.trim()) return;
    try { await academy.privatePost(aid, text.trim(), student); setText(''); load(); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <section class="private-thread" id="private-thread">
      <div class="pt-k"><Icon name="lock" size={14} stroke={2.4} />{t('privateComments')}</div>
      <p class="tiny muted">{t(student ? 'privateSubTeacher' : 'privateSub')}</p>
      {(items || []).map((x) => <div key={x.id} class={`pt-msg${x.mine ? ' mine' : ''}`}><span>{x.text}</span><small>{x.author?.name || ''}</small></div>)}
      <div class="pt-send">
        <input id="pt-text" maxLength={2000} value={text} placeholder={t('privatePh')} onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
        <button type="button" class="icon-btn" onClick={send} disabled={!text.trim()} aria-label={t('send')} id="pt-send"><Icon name="send" size={18} /></button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- parents and guardians
export function GuardiansSheet({ cid = null, uid = null, name = '' }) {
  const [items, setItems] = useState(null);
  const [email, setEmail] = useState('');
  const [gname, setGname] = useState('');
  const load = () => academy.guardians(cid, uid).then((r) => setItems(r.items)).catch((e) => { toast(e.message, 'err'); setItems([]); });
  useEffect(() => { load(); }, []);
  const add = async () => {
    try { await academy.addGuardian(cid, uid, { email: email.trim(), name: gname.trim() }); setEmail(''); setGname(''); load(); toast(t('guardianAdded')); } catch (e) { toast(e.message, 'err'); }
  };
  const copy = async (g) => { try { await navigator.clipboard.writeText(g.link); toast(t('linkCopied')); } catch { toast(g.link); } };
  const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  return (
    <SheetFrame title={name ? t('parentsOf', { name }) : t('parentsT')}>
      <p class="tiny muted">{t('parentsSub')}</p>
      {(items || []).map((g) => (
        <div class="row3" key={g.id}>
          <span class="row-main"><strong>{g.name || g.email}</strong><span class="tiny">{g.name ? g.email : ''}{g.last_sent ? ` · ${t('lastSent', { d: dateText(g.last_sent) })}` : ''}</span></span>
          <button type="button" class="link-btn" onClick={() => copy(g)}>{t('nxCopyLink')}</button>
          {!cid && <button type="button" class="icon-btn" aria-label={t('delete')} onClick={async () => { await academy.removeGuardian(g.id).catch(() => {}); load(); }}><Icon name="trash" size={16} /></button>}
        </div>
      ))}
      {(items?.length || 0) < 3 && <>
        <label class="field3"><span>{t('emailT')}</span><input id="g-email" type="email" value={email} onInput={(e) => setEmail(e.currentTarget.value)} /></label>
        <label class="field3"><span>{t('guardianName')}</span><input id="g-name" value={gname} maxLength={80} onInput={(e) => setGname(e.currentTarget.value)} /></label>
        <Button kind="brand" full icon="plus" disabled={!ok} onClick={add} id="g-add">{t('addGuardian')}</Button>
      </>}
    </SheetFrame>
  );
}

/** What a parent sees from the weekly email (#guardian/TOKEN): no account needed. */
export function GuardianView({ token }) {
  const [g, setG] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { academy.guardianPage(token).then(setG).catch((e) => setErr(e.message)); }, [token]);
  return (
    <div class="scroll" id="guardian-page">
      <NavBar title={t('weekSummary')} color="orange" backLabel={t('back')} />
      <div class="wrap" style={{ paddingTop: 12 }}>
        {err ? <Empty icon="info" title={err} /> : !g ? <div class="skeleton-rows"><i /><i /><i /></div> : <>
          <div class="hero class-hero c-orange"><h2>{t('weekOf', { name: g.student })}</h2><p>{g.classes.join(' · ')}</p>
            <div class="facts"><span><small>{t('practiceTime')}</small>{g.minutes} min</span><span><small>{t('takesT')}</small>{g.takes}</span>{g.best != null && <span><small>{t('bestT')}</small>{g.best}%</span>}</div></div>
          {[['done', 'workDone', 'check'], ['missing', 'workMissing', 'info'], ['todo', 'comingUp', 'calendar']].map(([k, label, icon]) => g[k].length > 0 && (
            <section class="sec3" key={k}><div class="section-head"><h2>{t(label)}</h2></div>
              <div class="list inset">{g[k].map((x, i) => <div class="row" key={i}><Icon name={icon} size={16} /><span class="row-main"><span class="row-title">{x.title}</span><span class="row-sub">{[x.class, x.due_at ? dateText(x.due_at) : '', x.best != null ? `${x.best}%` : ''].filter(Boolean).join(' · ')}</span></span></div>)}</div>
            </section>))}
          {g.teacher_notes.length > 0 && <section class="sec3"><div class="section-head"><h2>{t('fromTeacher')}</h2></div>
            {g.teacher_notes.map((n, i) => <blockquote class="teacher-note" key={i}>{n.text}</blockquote>)}</section>}
        </>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the class Drive folder and the roster
export function DriveRow({ cid, url, teacher }) {
  const set = async () => {
    const v = prompt(t('drivePrompt'), url || '');
    if (v === null) return;
    try { await academy.setDrive(cid, v.trim()); refreshClasses(); toast(v.trim() ? t('driveSaved') : t('driveRemoved')); } catch (e) { toast(e.message, 'err'); }
  };
  if (!url && !teacher) return null;
  return (
    <div class="drive-row" id="class-drive">
      <span class="dr-ic"><Icon name="folder" size={18} stroke={2.2} /></span>
      <span class="row-main"><strong>{t('driveFolder')}</strong><span class="tiny">{url ? t('driveSub') : t('driveNone')}</span></span>
      {url && <Button small kind="secondary" icon="globe" onClick={() => openExternal(url)} id="drive-open">{t('openBtn')}</Button>}
      {teacher && <button type="button" class="link-btn" onClick={set} id="drive-set">{url ? t('change') : t('add')}</button>}
    </div>
  );
}

export function RosterSheet({ cid }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const pick = async (e) => { const f = e.currentTarget.files?.[0]; if (f) setText(await f.text()); };
  const go = async () => {
    setBusy(true);
    try { setRes(await academy.roster(cid, text)); refreshClasses(); } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  return (
    <SheetFrame title={t('rosterT')}>
      {res ? <>
        <p class="note-text" id="roster-done">{t('rosterDone', { n: res.invited, m: res.on_melovyn })}</p>
        <div class="list inset">{res.people.slice(0, 12).map((p) => <div class="row" key={p.email}><span class="row-main"><span class="row-title">{p.name || p.email}</span><span class="row-sub">{p.name ? p.email : ''}</span></span></div>)}</div>
        <Button kind="brand" full onClick={closeSheet}>{t('done')}</Button>
      </> : <>
        <p class="tiny muted">{t('rosterSub')}</p>
        <textarea id="roster-text" class="field" rows={7} placeholder={'Aisha Rahman, aisha@school.edu\nWei Lim, wei@school.edu'} value={text} onInput={(e) => setText(e.currentTarget.value)} />
        <label class="btn secondary small" style={{ alignSelf: 'flex-start' }}><Icon name="upload" size={16} />{t('rosterFile')}<input type="file" accept=".csv,text/csv,text/plain" class="hidden-input" onChange={pick} /></label>
        <Button kind="brand" full icon="send" disabled={busy || !/@/.test(text)} onClick={go} id="roster-send">{t('rosterInvite')}</Button>
      </>}
    </SheetFrame>
  );
}

/** Teacher, People tab: import a list, weekly summaries to parents. */
export function PeopleTools({ cid }) {
  const [busy, setBusy] = useState(false);
  const summaries = async () => {
    setBusy(true);
    try { const r = await academy.sendSummaries(cid); toast(r.guardians ? t('summariesSent', { n: r.guardians, e: r.emailed }) : t('summariesNone')); } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  if (!hasServer()) return null;
  return (
    <div class="row-gap" style={{ gap: 8, flexWrap: 'wrap', margin: '6px 0 10px' }} id="people-tools">
      <Button small kind="secondary" icon="upload" onClick={() => openSheet('roster', { cid })} id="roster-open">{t('rosterT')}</Button>
      <Button small kind="secondary" icon="send" disabled={busy} onClick={summaries} id="send-summaries">{t('sendSummaries')}</Button>
    </div>
  );
}
