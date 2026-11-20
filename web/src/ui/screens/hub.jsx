// Learn: the teaching hub. Teachers run classes (open to everyone or private), set songs to practise and see
// every student's progress: each Play Along score, the bars and notes that went wrong, and the recording, any
// time. Students join with a link, a QR code or a code, practise, and share their takes. Open classes are
// listed for anyone to find. Looking around needs nothing; teaching, joining and sharing need a sign-in.
import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, push, openSheet, closeSheet, toast, goLearn } from '../state.js';
import { t, instrumentName } from '../../core/i18n.js';
import { Icon, Button, Skeleton } from '../components.jsx';
import { MyWork, TeacherGlance } from './learnwork.jsx';
import { LargeTitle, SheetFrame, Avatar } from './common.jsx';
import { Mascot, Confetti } from '../mascot.jsx';
import { hasServer, academy, academyMe, ApiError } from '../api.js';
import { C, ensureAccount, isRegistered } from '../account.js';
import { local } from '../storage.js';
import { refreshClasses, MissionCard } from './classes.jsx';
import { isNative, openExternal } from '../native.js';
import qrcode from 'qrcode-generator';
import { track } from '../analytics.js';
import { flag } from '../analytics.js';

const CFG = () => globalThis.HAPTUNE_CONFIG || {};
const INSTR = ['piano', 'violin', 'guitar', 'voice', 'cello', 'flute', 'ukulele', 'sax'];
export const fmtCode = (c) => (c && c.length > 4 ? `${c.slice(0, 3)} ${c.slice(3)}` : c || '');
/** The link that opens a class (in the app, or on the website for anyone without it). */
export const classLink = (code) => `${(CFG().site || location.origin).replace(/\/+$/, '')}/app/#join/${code}`;

function useLoad(fn, deps) {
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

/** Runs `fn` once signed in (asks to sign in first when needed). */
export function whenSignedIn(fn, role = '') {
  if (isRegistered()) return fn();
  openSheet('hubRole', { need: true, role, then: fn });
  return null;
}

export function LearnView({ active }) {
  const s = useApp();
  const online = hasServer();
  const me = s.me;
  const role = me?.hub_role || local.get('hubRoleLocal', '');
  const [overview, setOverview] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!active || !online) return undefined;
    let alive = true;
    const load = () => ensureAccount().then(() => academyMe(s.settings.name)).then((r) => { if (alive) { setOverview(r); setErr(''); } }).catch((e) => alive && setErr(e.message));
    load();
    const timer = setInterval(load, 45000);                   // new students and takes show up by themselves
    const onFocus = () => load();
    addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(timer); removeEventListener('focus', onFocus); };
  }, [active, s.academyRev, s.me?.id]);
  const classes = overview?.classes || [];
  const teaching = classes.filter((c) => c.role === 'teacher');
  const learning = classes.filter((c) => c.role === 'student');
  const todo = overview?.todo || [];
  const toReview = teaching.reduce((a, c) => a + (c.to_review || 0), 0);
  const asTeacher = role === 'teacher' || (teaching.length > 0 && role !== 'student');
  const fresh = online && me && !role && !classes.length && !local.get('hubSkip', false);

  if (!online) {
    return (
      <div class="scroll" id="learn"><div class="wrap">
        <LargeTitle title={t('hub')} eyebrow={t('hubEyebrow')} hapi="think" color="orange" actions={<span class="ph-only"><Avatar /></span>} />
        <div class="empty3 card"><Mascot mood="sleep" size={90} /><h3>{t('hubOffline')}</h3><p>{t('hubOfflineSub')}</p></div>
      </div></div>
    );
  }
  return (
    <div class="scroll" id="learn">
      <div class="wrap">
        <LargeTitle title={t('hub')} eyebrow={t('hubEyebrow')} hapi="think" color="orange" actions={<span class="ph-only"><Avatar /></span>} />
        {fresh ? <HubWelcome /> : (
          <section class="hero3 hero-learn fade-up" id="hub-hero">
            <h1>{asTeacher ? t('hubTeacherHi') : t('hubStudentHi')}</h1>
            <p>{asTeacher
              ? (teaching.length ? t('hubTeacherSum', { c: teaching.length, s: teaching.reduce((a, c) => a + c.students, 0), r: toReview }) : t('hubTeacherStart'))
              : (todo.length ? t('hubStudentSum', { n: todo.length }) : learning.length ? t('hubStudentNone', { n: learning.length }) : t('hubStudentStart'))}</p>
            <span class="pc-only"><Mascot mood={asTeacher ? 'cheer' : 'wave'} size={120} /></span>
          </section>
        )}
        {err && <p class="note-text">{err}</p>}

        <div class="acts stagger" id="hub-acts">
          {asTeacher ? <>
            <button type="button" class="act c-orange" id="hub-new-class" onClick={() => whenSignedIn(() => openSheet('newClass'), 'teacher')}><span class="ic"><Icon name="plus" size={22} stroke={2.4} /></span><strong>{t('hubNewClass')}</strong><span>{t('hubNewClassSub')}</span></button>
            <button type="button" class="act c-pink" onClick={() => (teaching[0] ? push('classView', { id: teaching[0].id, tab: 'grades' }) : whenSignedIn(() => openSheet('newClass'), 'teacher'))}><span class="ic"><Icon name="users" size={22} stroke={2.2} /></span><strong>{t('hubProgress')}</strong><span>{toReview ? t('toReview', { n: toReview }) : t('hubProgressSub')}</span></button>
            <button type="button" class="act c-teal" onClick={() => (teaching[0] ? openSheet('classQR', { classId: teaching[0].id }) : whenSignedIn(() => openSheet('newClass'), 'teacher'))}><span class="ic"><Icon name="link" size={22} stroke={2.2} /></span><strong>{t('hubInvite')}</strong><span>{t('hubInviteSub')}</span></button>
            <button type="button" class="act c-blue" onClick={() => (teaching[0] ? openSheet('newAssignment', { classId: teaching[0].id }) : whenSignedIn(() => openSheet('newClass'), 'teacher'))}><span class="ic"><Icon name="flag" size={22} stroke={2.2} /></span><strong>{t('hubAssign')}</strong><span>{t('hubAssignSub')}</span></button>
          </> : <>
            <button type="button" class="act c-orange" id="join-class" onClick={() => whenSignedIn(() => openSheet('joinClass'), 'student')}><span class="ic"><Icon name="users" size={22} stroke={2.2} /></span><strong>{t('joinClass')}</strong><span>{t('hubJoinSub')}</span></button>
            <button type="button" class="act c-pink" onClick={() => document.getElementById('open-classes')?.scrollIntoView({ behavior: 'smooth' })}><span class="ic"><Icon name="globe" size={22} stroke={2.2} /></span><strong>{t('hubBrowse')}</strong><span>{t('hubBrowseSub')}</span></button>
            {flag('tutors') && <button type="button" class="act c-violet" onClick={() => push('tutors')}><span class="ic"><Icon name="person" size={22} stroke={2.2} /></span><strong>{t('findTutor')}</strong><span>{t('findTutorSub')}</span></button>}
            <button type="button" class="act c-teal" id="teach-class" onClick={() => whenSignedIn(() => { C.update({ hub_role: 'teacher' }).catch(() => {}); openSheet('newClass'); }, 'teacher')}><span class="ic"><Icon name="academy" size={22} stroke={2.2} /></span><strong>{t('teachClass')}</strong><span>{t('hubTeachSub')}</span></button>
          </>}
        </div>

        {learning.length > 0 ? <MyWork /> : todo.length > 0 && (
          <section class="sec3">
            <div class="section-head"><h2>{t('toDoT')}</h2></div>
            <div class="mission-list">{todo.slice(0, 6).map((a) => <MissionCard key={a.id} a={a} />)}</div>
          </section>
        )}
        {teaching.length > 0 && <TeacherGlance />}

        {teaching.length > 0 && <ClassGrid title={t('hubTeaching')} list={teaching} />}
        {learning.length > 0 && <ClassGrid title={t('myClasses')} list={learning} />}
        {!overview && !err && <Skeleton />}

        <OpenClasses mine={new Set(classes.map((c) => c.id))} />

        <section class="sec3">
          <div class="section-head"><h2>{t('hubTeachers')}</h2></div>
          <div class="grid2">
            {flag('tutors') && <button type="button" class="tile3 lift" onClick={() => push('tutors')} id="learn-tutors">
              <span class="k"><Icon name="users" size={15} />{t('findTutor')}</span><strong>{t('hubFindTeacher')}</strong><span class="muted">{t('findTutorSub')}</span>
            </button>}
            <button type="button" class="tile3 lift" onClick={() => push('lessons')} id="learn-lessons">
              <span class="k"><Icon name="calendar" size={15} />{t('myLessons')}</span><strong>{t('hubLessons')}</strong><span class="muted">{t('myLessonsSub')}</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function ClassGrid({ title, list }) {
  return (
    <section class="sec3">
      <div class="section-head"><h2>{title}</h2></div>
      <div class="grid3">
        {list.map((c) => (
          <button type="button" key={c.id} class={`class-card3 lift c-${c.color}`} onClick={() => push('classView', { id: c.id })}>
            <span class="cc-band" />
            <span class="cc-top"><span class="cc-ic"><Icon name={c.role === 'teacher' ? 'academy' : 'users'} size={20} stroke={2.2} /></span>
              {c.to_review ? <span class="pill3 c-pink">{t('toReview', { n: c.to_review })}</span> : null}</span>
            <strong>{c.name}</strong>
            <span class="muted">{c.role === 'teacher' ? `${t('studentsN', { n: c.students })} · ${t('assignmentsN', { n: c.assignments })}` : `${t('assignmentsN', { n: c.assignments })}`}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function OpenClasses({ mine }) {
  const [q, setQ] = useState('');
  const [inst, setInst] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const k = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(k); }, [q]);
  const app = useApp();
  const st = useLoad(() => academy.discover({ q: query, instrument: inst }), [query, inst, app.academyRev]);
  const list = st.data?.classes || [];
  return (
    <section class="sec3" id="open-classes">
      <div class="section-head"><h2>{t('hubOpen')}</h2></div>
      <div class="search3"><Icon name="search" size={18} stroke={2.3} /><input type="search" value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('hubOpenSearch')} aria-label={t('hubOpenSearch')} /></div>
      <div class="ptabs">
        <button type="button" class={!inst ? 'on' : ''} onClick={() => setInst('')}>{t('allPieces')}</button>
        {INSTR.map((k) => <button type="button" key={k} class={inst === k ? 'on' : ''} onClick={() => setInst(k)}>{instrumentName(k)}</button>)}
      </div>
      {st.loading && !st.data ? <div class="loading"><div class="spinner" /></div> : list.length ? (
        <div class="grid3">
          {list.map((c) => (
            <div key={c.id} class={`open-card c-${c.color}`}>
              <div class="oc-top"><span class="oc-av">{(c.teacher.name || '?').slice(0, 1).toUpperCase()}</span>
                <div><strong>{c.name}</strong><span class="muted">{c.teacher.name}{c.instrument ? ` · ${instrumentName(c.instrument)}` : ''}</span></div></div>
              {c.description && <p class="oc-about">{c.description}</p>}
              <div class="row-gap"><span class="pill3">{t('studentsN', { n: c.students })}</span><span class="spacer" />
                {mine.has(c.id) ? <Button small kind="secondary" onClick={() => push('classView', { id: c.id })}>{t('open')}</Button>
                  : <Button small onClick={() => whenSignedIn(() => joinOpen(c), 'student')}>{t('join')}</Button>}</div>
            </div>
          ))}
        </div>
      ) : <div class="empty3 card"><Mascot mood="think" size={70} /><p>{query || inst ? t('hubOpenNone') : t('hubOpenEmpty')}</p></div>}
    </section>
  );
}

async function joinOpen(c) {
  try {
    const r = await academy.joinOpen(c.id);
    refreshClasses();
    toast(t('joinedClass', { name: r.class.name }));
    push('classView', { id: r.class.id }, 'academy');
  } catch (e) { toast(e.message, 'err'); }
}

/** The first visit: are you teaching or learning? (Or just looking.) */
function HubWelcome() {
  const pick = (role) => {
    local.set('hubRoleLocal', role);
    if (role === '') { local.set('hubSkip', true); refreshClasses(); return; }
    const save = () => C.update({ hub_role: role }).then(refreshClasses).catch(() => {});
    if (isRegistered()) save(); else openSheet('hubRole', { role, then: save });
    refreshClasses();
  };
  return (
    <section class="hub-welcome fade-up" id="hub-welcome">
      <div class="hw-text">
        <h1>{t('hubWelcome')}</h1>
        <p>{t('hubWelcomeSub')}</p>
      </div>
      <div class="hw-choices">
        <button type="button" class="hw-choice c-orange" id="hub-im-teacher" onClick={() => pick('teacher')}>
          <span class="ic"><Icon name="academy" size={26} stroke={2.2} /></span><strong>{t('hubImTeacher')}</strong><span>{t('hubImTeacherSub')}</span></button>
        <button type="button" class="hw-choice c-blue" id="hub-im-student" onClick={() => pick('student')}>
          <span class="ic"><Icon name="users" size={26} stroke={2.2} /></span><strong>{t('hubImStudent')}</strong><span>{t('hubImStudentSub')}</span></button>
      </div>
      <button type="button" class="hw-skip" id="hub-skip" onClick={() => pick('')}>{t('hubJustLook')}</button>
    </section>
  );
}

// ---------------------------------------------------------------- sign in (Google, username, or the app code)
let gsiLoading = null;
export function loadGoogle() {
  if (globalThis.google?.accounts?.id) return Promise.resolve(globalThis.google);
  if (gsiLoading) return gsiLoading;
  gsiLoading = new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client';
    sc.async = true;
    sc.onload = () => (globalThis.google?.accounts?.id ? resolve(globalThis.google) : reject(new Error('Google sign-in did not load')));
    sc.onerror = () => { gsiLoading = null; reject(new Error('Google sign-in could not be reached')); };
    document.head.appendChild(sc);
  });
  return gsiLoading;
}

/** The four-colour Google "G" (Google's sign-in branding guidelines). */
export const GoogleG = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z" /><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.2z" /><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.5 0 20.1 0 24s1 7.5 2.6 10.8l7.9-6.2z" /><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z" /></svg>
);

/**
 * Sign in with Google. Website: our own button opens Google's OAuth window and the server checks the answer
 * (Google's "Continue as" button iframe could get stuck: the click opened and closed Google's window and nothing
 * came back); if the window can't open, the whole page goes to Google and back. App: Google's native sheet when
 * the app has the plugin, otherwise the phone's browser signs in and the app is paired to the same account.
 */
export function GoogleButton({ onDone, fresh = false }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(isNative() || null);               // web: is Google sign-in set up on the server?
  useEffect(() => {
    if (isNative()) return;
    import('../google.js').then((G) => { G.preloadGoogle(); G.googleStatus().then((st) => setReady(!!st.configured), () => setReady(!!CFG().google)); });
  }, []);
  const go = async () => {
    setErr(''); setBusy(true);
    try {
      if (isNative()) {
        const S = await import('../signin.js');
        if (!S.nativeGoogleAvailable()) { setBusy(false); openSheet('pair', { then: onDone }); return; }
        const me = await S.nativeGoogleSignIn({ fresh });
        if (me) onDone?.(me);
      } else {
        const G = await import('../google.js');
        const me = await G.googleSignInPopup({ fresh });
        if (me) onDone?.(me);
      }
    } catch (e) { setErr(e.detail?.message || e.message || String(e)); }
    setBusy(false);
  };
  if (ready === false) return null;
  return (
    <div class="gsi-wrap">
      <button type="button" class="g-btn" onClick={go} disabled={busy} id={isNative() ? 'google-native' : 'google-btn'}>
        <GoogleG />{busy ? t('gSigningIn') : t('signInGoogle')}
      </button>
      {err && <p class="t-red tiny" id="google-err">{err}</p>}
    </div>
  );
}

/** Sign in with Apple (web: Apple's popup when set up; iPhone app: the native sheet). */
export function AppleButton({ onDone }) {
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);
  useEffect(() => { import('../signin.js').then((S) => setOk(S.appleAvailable())).catch(() => {}); }, []);
  if (!ok) return null;
  const go = async () => {
    setErr('');
    try { const S = await import('../signin.js'); const me = await S.appleSignIn(); if (me) onDone?.(me); } catch (e) { setErr(e.message || String(e)); }
  };
  return <div class="apple-wrap"><button type="button" class="apple-btn" onClick={go} id="apple-btn"><svg width="16" height="18" viewBox="0 0 17 20" aria-hidden="true"><path fill="currentColor" d="M14.1 10.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.7-4.1zM11.6 3.1c.7-.9 1.2-2.1 1.1-3.1-1 0-2.3.7-3 1.6-.7.8-1.3 2-1.1 3.1 1.1.1 2.3-.6 3-1.6z" /></svg>{t('signInApple')}</button>{err && <p class="t-red tiny">{err}</p>}</div>;
}

export function HubRoleSheet({ need = false, role = '', then = null, switching = false }) {
  const s = useApp();
  const [mode, setMode] = useState('choose');     // choose | password
  const [handle, setHandle] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const done = async () => {
    if (role) { try { await C.update({ hub_role: role }); } catch { /* not important */ } local.set('hubRoleLocal', role); }
    refreshClasses();
    closeSheet();
    { const nm = getName(); toast(t('signedInAs', { name: nm && nm !== 'Musician' ? ` · ${nm}` : '' })); }
    try { await then?.(); } catch (e) { if (!(e instanceof ApiError)) toast(e.message || String(e), 'err'); }
  };
  const getName = () => (globalThis.__haptune?.getState?.().me?.name) || s.me?.name || '';
  const create = async () => {
    setBusy(true); setErr('');
    try {
      if (switching) await C.logout();          // a new account, not a new name for the one signed in here
      await ensureAccount();
      const r = await C.setPassword(handle.trim(), pw);
      await ensureAccount({ fresh: true });
      toast(t('recoveryCodeIs', { code: r.recovery_code }));
      await done();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const login = async () => {
    setBusy(true); setErr('');
    try { await C.login(handle.trim(), pw); await done(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <SheetFrame title={switching ? t('switchAccount') : role === 'teacher' ? t('hubSignTeacher') : role === 'student' ? t('hubSignStudent') : t('signIn')}>
      <div class="sheet-mascot"><Mascot mood={role === 'teacher' ? 'cheer' : 'wave'} size={84} /></div>
      <p class="note-text center">{switching ? t('switchWhy', { who: s.me?.email || (s.me?.handle ? `@${s.me.handle}` : '') }) : need ? t('hubSignNeed') : t('hubSignWhy')}</p>
      {mode === 'choose' && <>
        <GoogleButton onDone={done} fresh={switching} />
        <AppleButton onDone={done} />
        {!CFG().google && !isNative() && <p class="tiny center">{t('googleNotSetUp')}</p>}
        <div class="or-line"><span>{t('orT')}</span></div>
        <Button full kind="secondary" icon="person" onClick={() => setMode('password')} id="hub-use-password">{t('useUsername')}</Button>
        {!isNative() && <Button full kind="secondary" icon="link" onClick={() => openSheet('pair', { approve: true })}>{t('pairApproveBtn')}</Button>}
        <button type="button" class="hw-skip" onClick={() => { local.set('hubSkip', true); closeSheet(); }}>{t('hubJustLook')}</button>
      </>}
      {mode === 'password' && <>
        <label class="field3"><span>{t('username')}</span><input id="hub-handle" autoComplete="username" autoCapitalize="none" spellcheck={false} value={handle} onInput={(e) => setHandle(e.currentTarget.value)} maxLength={20} /></label>
        <label class="field3"><span>{t('password')}</span><input id="hub-pw" type="password" autoComplete="current-password" value={pw} onInput={(e) => setPw(e.currentTarget.value)} /></label>
        <p class="tiny">{t('pwRules')}</p>
        {err && <p class="t-red">{err}</p>}
        <div class="grid2">
          <Button full onClick={create} disabled={busy || handle.trim().length < 3 || pw.length < 8} id="hub-create-account">{t('createAccount')}</Button>
          <Button full kind="secondary" onClick={login} disabled={busy || !handle.trim() || !pw} id="hub-login">{t('signIn')}</Button>
        </div>
        <button type="button" class="hw-skip" onClick={() => setMode('choose')}>{t('back')}</button>
      </>}
    </SheetFrame>
  );
}

/** The app signs in through the website: it shows a code, the website (signed in with Google) approves it. */
export function PairSheet({ then = null, approve = false, code: given = '' }) {
  const [code, setCode] = useState(given);
  const [state, setSt] = useState(approve ? 'enter' : 'start');
  const [err, setErr] = useState('');
  useEffect(() => {
    if (approve) return undefined;
    let alive = true, timer = 0;
    C.pairStart().then((r) => {
      if (!alive) return;
      setCode(r.code); setSt('waiting');
      const site = `${(CFG().site || location.origin).replace(/\/+$/, '')}/app/`;
      // straight to Google in the phone's browser; the app is signed in when Google answers (the old way, a
      // code to approve on the website, stays as the fallback when Google sign-in isn't set up)
      C.googleStart({ return_to: site, pair: r.code }).then((g) => openExternal(g.url)).catch(() => openExternal(`${site}#pair=${r.code}`));
      const poll = async () => {
        try {
          const p = await C.pairPoll(r.code);
          if (p.status === 'done') { C.pairDone(p); closeSheet(); toast(t('signedInAs', { name: p.me?.name ? ` · ${p.me.name}` : '' })); then?.(p.me); return; }
        } catch (e) { if (e.status === 404) { setErr(t('pairExpired')); return; } }
        if (alive) timer = setTimeout(poll, 2500);
      };
      timer = setTimeout(poll, 2500);
    }).catch((e) => alive && setErr(e.message));
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  const ok = async () => {
    try { await C.pairApprove(code.replace(/\W/g, '').toUpperCase()); setSt('approved'); } catch (e) { if (e.signin) openSheet('hubRole', { need: true }); else setErr(e.message); }
  };
  return (
    <SheetFrame title={t('pairTitle')}>
      <div class="sheet-mascot"><Mascot mood="listen" size={80} /></div>
      {state === 'enter' && <>
        <p class="note-text center">{t('pairEnter')}</p>
        <input class="field code-field" value={code} onInput={(e) => setCode(e.currentTarget.value.toUpperCase())} maxLength={9} placeholder="ABCD 2345" />
        {err && <p class="t-red">{err}</p>}
        <Button full onClick={ok} disabled={code.replace(/\W/g, '').length < 8}>{t('pairApproveBtn')}</Button>
      </>}
      {state === 'approved' && <><Confetti /><p class="note-text center">{t('pairApproved')}</p><Button full onClick={closeSheet}>{t('done')}</Button></>}
      {(state === 'start' || state === 'waiting') && <>
        <p class="note-text center">{t('pairApp')}</p>
        <div class="code-big c-violet">{code ? `${code.slice(0, 4)} ${code.slice(4)}` : '…'}</div>
        {err && <p class="t-red">{err}</p>}
        <p class="tiny center">{t('pairWaiting')}</p>
      </>}
    </SheetFrame>
  );
}

// ---------------------------------------------------------------- invite: link, QR code and code
export function qrSVG(text, { size = 220 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cell = size / (n + 8);
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${((c + 4) * cell).toFixed(2)} ${((r + 4) * cell).toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="100%" height="100%" rx="18" fill="#fff"/><path d="${d}" fill="#101223"/></svg>`;
}

export function ClassQRSheet({ classId }) {
  const st = useLoad(() => academy.classDetail(classId), [classId]);
  const c = st.data;
  const link = c?.join_code ? classLink(c.join_code) : '';
  const share = async () => {
    const text = t('inviteText', { name: c.name, code: fmtCode(c.join_code), link });
    try { if (navigator.share) { await navigator.share({ title: c.name, text, url: link }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch { toast(link); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(link); toast(t('copied')); } catch { toast(link); } };
  return (
    <SheetFrame title={t('hubInvite')}>
      {!c ? <div class="loading"><div class="spinner" /></div> : <>
        <p class="note-text center">{t('inviteHow', { name: c.name })}</p>
        <div class="qr-box" dangerouslySetInnerHTML={{ __html: qrSVG(link) }} />
        <div class="code-big c-orange" id="invite-code">{fmtCode(c.join_code)}</div>
        <div class="link-box"><span>{link}</span><button type="button" onClick={copy} aria-label={t('copy')}><Icon name="copy" size={18} /></button></div>
        <Button full icon="share" onClick={share} id="invite-share">{t('shareCodeBtn')}</Button>
        {c.role === 'teacher' && <p class="tiny center">{c.visibility === 'public' ? t('inviteOpen') : t('invitePrivate')}</p>}
      </>}
    </SheetFrame>
  );
}

/** What a class link (…/app/#join/CODE) opens: the class, and Join. */
export function JoinLinkSheet({ code }) {
  const st = useLoad(() => academy.preview(code), [code]);
  const [busy, setBusy] = useState(false);
  const c = st.data?.class;
  const join = () => whenSignedIn(async () => {
    setBusy(true);
    try {
      const r = await academy.join(code);
      track('class_joined');
      refreshClasses(); closeSheet(); goLearn();
      toast(t('joinedClass', { name: r.class.name }));
      push('classView', { id: r.class.id }, 'academy');
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  }, 'student');
  return (
    <SheetFrame title={t('joinClass')}>
      {st.error ? <div class="empty3"><Mascot mood="sad" size={80} /><p>{st.error}</p></div> : !c ? <div class="loading"><div class="spinner" /></div> : <>
        <div class={`open-card big c-${c.color}`}>
          <div class="oc-top"><span class="oc-av">{(c.teacher.name || '?').slice(0, 1).toUpperCase()}</span>
            <div><strong>{c.name}</strong><span class="muted">{t('teacherT')}: {c.teacher.name}</span></div></div>
          {c.description && <p class="oc-about">{c.description}</p>}
          <span class="pill3">{t('studentsN', { n: c.students })}</span>
        </div>
        <Button full icon="users" onClick={join} disabled={busy} id="join-link-btn">{t('join')}</Button>
      </>}
    </SheetFrame>
  );
}
