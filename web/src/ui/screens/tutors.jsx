// Find a tutor. Students browse verified teachers for free, ask for a lesson (a time, every week, or
// "whenever suits you"), the teacher accepts or suggests a time, and the student confirms. Online lessons get a
// private video room. Afterwards the student gives stars. Teachers make a profile under Me > Teach on Haptune
// and pay a small one-time fee; a person checks each profile before it is listed.
import { useEffect, useState } from 'preact/hooks';
import { useApp, push, openSheet, closeSheet, toast } from '../state.js';
import { t, instrumentName, INSTRUMENTS, getLang } from '../../core/i18n.js';
import { Icon, Chip, Button, Section, List, Row, Empty, Card, Toggle, Segmented } from '../components.jsx';
import { NavBar, SheetFrame } from './common.jsx';
import { C, attempt, ensureAccount } from '../account.js';
import { hasServer } from '../api.js';
import { Person, StarsInput } from './social.jsx';
import { openExternal } from '../native.js';
import { guessCurrency } from './plans.jsx';

const QUICK = ['piano', 'violin', 'guitar', 'voice', 'cello', 'flute', 'ukulele', 'erhu', 'guzheng', 'sax'];
const when = (iso) => { try { return new Date(iso).toLocaleString(getLang(), { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch { return iso; } };
const Stars = ({ v, n }) => (v ? <span class="tu-stars"><Icon name="star" size={14} fill stroke={1.5} />{v.toFixed(1)}<small>({n})</small></span> : <span class="tu-stars new">{t('tutorNew')}</span>);

function TutorCard({ x }) {
  return (
    <button type="button" class="tu-card" onClick={() => push('tutor', { handle: x.user.handle })}>
      <Person user={x.user} size={54} badge={false} />
      <span class="m">
        <strong>{x.user.name} <Icon name="shield" size={14} stroke={2.4} /></strong>
        <span class="h">{x.headline}</span>
        <span class="tags">{x.instruments.slice(0, 3).map((i) => <i key={i}>{instrumentName(i)}</i>)}{x.online && <i class="on">{t('online')}</i>}{x.in_person && x.city && <i>{x.city}</i>}</span>
      </span>
      <span class="r"><Stars v={x.rating} n={x.ratings} />{x.rate && <b>{x.rate}</b>}</span>
    </button>
  );
}

export function TutorsView({ active }) {
  const s = useApp();
  const [inst, setInst] = useState('');
  const [online, setOnline] = useState(false);
  const [q, setQ] = useState('');
  const [items, setItems] = useState(null);
  useEffect(() => {
    if (!active || !hasServer()) return undefined;
    const timer = setTimeout(() => C.tutors.list({ instrument: inst, online, q }).then((r) => setItems(r.items)).catch(() => setItems([])), q ? 350 : 0);
    return () => clearTimeout(timer);
  }, [active, inst, online, q]);
  const mine = s.settings.instrument;
  return (
    <div class="scroll" id="tutors">
      <NavBar title={t('findTutor')} backLabel={t('learn')} actions={<button type="button" onClick={() => push('lessons')} aria-label={t('myLessons')} id="my-lessons"><Icon name="calendar" size={21} /></button>} />
      <div class="wrap" style={{ paddingTop: 10 }}>
        <label class="search" for="tu-search"><Icon name="search" size={18} /><input id="tu-search" type="search" placeholder={t('tutorSearchPh')} value={q} onInput={(e) => setQ(e.currentTarget.value)} /></label>
        <div class="chips">
          <Chip on={!inst} onClick={() => setInst('')}>{t('genre_all')}</Chip>
          {[...new Set([mine, ...QUICK])].filter((k) => INSTRUMENTS.includes(k)).map((k) => <Chip key={k} on={inst === k} onClick={() => setInst(k)}>{instrumentName(k)}</Chip>)}
        </div>
        <div class="chips"><Chip on={online} color="green" onClick={() => setOnline(!online)}><Icon name="video" size={14} /> {t('onlineLessons')}</Chip></div>
        {!hasServer() ? <Empty icon="globe" title={t('needOnline')} />
          : items === null ? <div class="loading"><div class="spinner" /></div>
            : items.length ? <div class="tu-list">{items.map((x) => <TutorCard key={x.user.id} x={x} />)}</div>
              : <Empty icon="users" title={t('noTutorsYet')} sub={t('noTutorsYetSub')} />}
        <button type="button" class="sr-cta" onClick={() => push('tutorMe')} id="teach-cta">
          <span class="hm-art sm"><Icon name="academy" size={21} stroke={2.1} /></span>
          <div><strong>{t('teachOnHaptune')}</strong><span>{t('teachOnHaptuneSub')}</span></div><Icon name="chevronR" size={16} stroke={2.4} />
        </button>
        <p class="note-text">{t('tutorHow')}</p>
      </div>
    </div>
  );
}

export function TutorView({ handle, active }) {
  const [x, setX] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { if (active) C.tutors.get(handle).then(setX).catch((e) => setErr(e.message)); }, [active, handle]);
  if (err) return <div class="scroll"><NavBar title={t('findTutor')} /><Empty icon="info" title={err} /></div>;
  if (!x) return <div class="scroll"><NavBar title="" /><div class="loading"><div class="spinner" /></div></div>;
  return (
    <div class="scroll">
      <NavBar title={x.user.name} backLabel={t('back')} />
      <div class="wrap" style={{ paddingTop: 10 }}>
        <div class="tu-head">
          <Person user={x.user} size={76} badge={false} />
          <div><h1>{x.user.name}</h1><p>{x.headline}</p>
            <span class="tu-ver"><Icon name="shield" size={14} stroke={2.4} />{t('verifiedTeacher')}</span> <Stars v={x.rating} n={x.ratings} /></div>
        </div>
        <Button kind="brand" full icon="calendar" onClick={() => openSheet('lessonAsk', { tutor: x })} id="ask-lesson">{t('askLesson')}</Button>
        <List>
          <Row icon="library" color="violet" title={t('teaches')} subtitle={x.instruments.map(instrumentName).join(', ') + (x.levels.length ? ` · ${x.levels.map((l) => t(l)).join(', ')}` : '')} />
          <Row icon="video" color="green" title={t('lessonWhere')} subtitle={[x.online && t('online'), x.in_person && `${t('inPerson')}${x.city ? ` (${x.city})` : ''}`].filter(Boolean).join(' · ')} />
          {x.rate && <Row icon="card" color="orange" title={t('lessonFee')} subtitle={`${x.rate} · ${t('feeBetweenYou')}`} />}
          {x.times && <Row icon="clock" color="blue" title={t('usualTimes')} subtitle={x.times} />}
          {x.languages.length > 0 && <Row icon="globe" color="teal" title={t('speaks')} subtitle={x.languages.join(', ')} />}
        </List>
        <Section title={t('aboutTeacher')}><Card><p style={{ whiteSpace: 'pre-wrap', fontSize: 15, lineHeight: 1.5 }}>{x.bio}</p></Card></Section>
        <Section title={t('reviewsN', { n: x.ratings })}>
          {x.reviews.length ? <div class="post-list">{x.reviews.map((r, i) => (
            <Card key={i}><div class="report-line" style={{ alignItems: 'center' }}><Person user={r.by} size={32} badge={false} /><strong style={{ flex: 1 }}>{r.by?.name}</strong><span class="tu-stars"><Icon name="star" size={14} fill stroke={1.5} />{r.rating}</span></div>
              {r.review && <p class="sub">{r.review}</p>}</Card>))}</div> : <p class="note-text">{t('noReviewsYet')}</p>}
        </Section>
      </div>
    </div>
  );
}

/** Ask for a lesson: online or in person, a set time (once or every week) or "whenever suits you". */
export function LessonAskSheet({ tutor }) {
  const both = tutor.online && tutor.in_person;
  const [kind, setKind] = useState(tutor.online ? 'online' : 'in_person');
  const [mode, setMode] = useState('flex');
  const [at, setAt] = useState('');
  const [minutes, setMinutes] = useState(45);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const ts = mode === 'flex' ? null : Date.parse(at) / 1000;
    if (mode !== 'flex' && !ts) { toast(t('pickTime'), 'err'); return; }
    setBusy(true);
    await ensureAccount();
    const r = await attempt(() => C.tutors.ask({ tutor: tutor.user.handle, kind, instrument: tutor.instruments[0] || '', at: ts, weekly: mode === 'weekly', minutes, message: msg }));
    setBusy(false);
    if (r) { closeSheet(); toast(t('lessonAsked', { name: tutor.user.name })); push('lessons'); }
  };
  return (
    <SheetFrame title={t('askLesson')}>
      {both && <Segmented value={kind} onChange={setKind} options={[{ value: 'online', label: t('online') }, { value: 'in_person', label: t('inPerson') }]} />}
      <Section title={t('lessonWhen')}>
        <Segmented id="ask-mode" value={mode} onChange={setMode} options={[{ value: 'flex', label: t('whenFlex') }, { value: 'once', label: t('whenOnce') }, { value: 'weekly', label: t('whenWeekly') }]} />
        {mode === 'flex' ? <p class="note-text">{t('whenFlexSub')}</p>
          : <input class="field" type="datetime-local" id="ask-at" value={at} onInput={(e) => setAt(e.currentTarget.value)} aria-label={t('lessonWhen')} />}
      </Section>
      <div class="chips">{[30, 45, 60, 90].map((m) => <Chip key={m} on={minutes === m} onClick={() => setMinutes(m)}>{m} {t('min')}</Chip>)}</div>
      <textarea class="textarea" rows="3" maxLength={600} placeholder={t('lessonMsgPh')} value={msg} onInput={(e) => setMsg(e.currentTarget.value)} id="ask-msg" aria-label={t('lessonMsgPh')} />
      <Button kind="brand" full disabled={busy} onClick={send} id="ask-send">{busy ? t('sending') : t('sendRequest')}</Button>
      <p class="note-text center">{t('askFree')}</p>
    </SheetFrame>
  );
}

const ST = { requested: 'orange', accepted: 'blue', confirmed: 'green', done: 'gray', declined: 'red', cancelled: 'gray' };

/** My lessons, as a student and as a teacher: what needs my answer comes first. */
export function LessonsView({ active }) {
  const [items, setItems] = useState(null);
  const [edit, setEdit] = useState({});
  const load = () => C.tutors.lessons().then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { if (active) load(); }, [active]);
  const act = async (l, action, extra = {}) => { const r = await attempt(() => C.tutors.act(l.id, { action, ...extra })); if (r) { setItems(r.items); toast(t(`ls_${action}`)); } };
  const mineFirst = (l) => ((l.role === 'teacher' && l.status === 'requested') || (l.role === 'student' && l.status === 'accepted') ? 0 : l.status === 'confirmed' ? 1 : 2);
  const sorted = items ? [...items].sort((a, b) => mineFirst(a) - mineFirst(b)) : null;
  return (
    <div class="scroll" id="lessons">
      <NavBar title={t('myLessons')} backLabel={t('back')} />
      <div class="wrap" style={{ paddingTop: 10 }}>
        {sorted === null ? <div class="loading"><div class="spinner" /></div>
          : !sorted.length ? <Empty icon="calendar" title={t('noLessons')} sub={t('noLessonsSub')}><Button icon="search" onClick={() => push('tutors')}>{t('findTutor')}</Button></Empty>
            : sorted.map((l) => {
              const other = l.role === 'teacher' ? l.student : l.teacher;
              const e = edit[l.id] || {};
              const past = l.at && Date.parse(l.at) < Date.now();
              return (
                <Card key={l.id} class="lesson">
                  <div class="report-line" style={{ alignItems: 'center' }}>
                    <Person user={other} size={42} badge={false} />
                    <div style={{ flex: 1, minWidth: 0 }}><strong>{other?.name}</strong>
                      <div class="sub">{t(l.role === 'teacher' ? 'yourStudent' : 'yourTeacher')} · {t(l.kind === 'online' ? 'online' : 'inPerson')} · {l.minutes} {t('min')}{l.weekly ? ` · ${t('everyWeek')}` : ''}</div></div>
                    <span class={`pill ${ST[l.status]}`}>{t(`ls_${l.status}`)}</span>
                  </div>
                  <div class="lesson-when"><Icon name="clock" size={16} stroke={2.2} />{l.at ? when(l.at) : t('whenFlex')}</div>
                  {l.message && <p class="sub">“{l.message}”</p>}
                  {l.reply && <p class="sub"><b>{l.teacher?.name}:</b> {l.reply}</p>}
                  {l.role === 'teacher' && l.status === 'requested' && <>
                    <input class="field" type="datetime-local" value={e.at ?? (l.at ? new Date(Date.parse(l.at) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '')} onInput={(ev) => setEdit((x) => ({ ...x, [l.id]: { ...e, at: ev.currentTarget.value } }))} aria-label={t('lessonWhen')} />
                    <input class="field" type="text" placeholder={t('replyPh')} value={e.reply || ''} maxLength={300} onInput={(ev) => setEdit((x) => ({ ...x, [l.id]: { ...e, reply: ev.currentTarget.value } }))} aria-label={t('replyPh')} />
                    <div class="btn-row">
                      <Button small color="green" icon="check" onClick={() => act(l, 'accept', { at: e.at ? Date.parse(e.at) / 1000 : (l.at ? Date.parse(l.at) / 1000 : null), reply: e.reply || '' })}>{t('accept')}</Button>
                      <Button small kind="secondary" color="red" onClick={() => act(l, 'decline', { reply: e.reply || '' })}>{t('decline')}</Button>
                    </div>
                  </>}
                  {l.role === 'student' && l.status === 'accepted' && (
                    <div class="btn-row">
                      <Button small kind="brand" icon="check" onClick={() => act(l, 'confirm')} >{t('confirmLesson')}</Button>
                      <Button small kind="secondary" onClick={() => act(l, 'cancel')}>{t('cancel')}</Button>
                    </div>
                  )}
                  {l.status === 'confirmed' && (
                    <div class="btn-row">
                      {l.room && <Button small kind="brand" icon="video" onClick={() => openExternal(l.room)}>{t('joinRoom')}</Button>}
                      {l.role === 'student' && past && <Button small color="green" icon="star" onClick={() => openSheet('lessonRate', { lesson: l, onDone: load })}>{t('rateLesson')}</Button>}
                      {!past && <Button small kind="secondary" onClick={() => act(l, 'cancel')}>{t('cancel')}</Button>}
                    </div>
                  )}
                  {l.status === 'requested' && l.role === 'student' && <Button small kind="secondary" onClick={() => act(l, 'cancel')}>{t('cancel')}</Button>}
                  {l.status === 'done' && l.rating && <span class="tu-stars"><Icon name="star" size={14} fill stroke={1.5} />{l.rating}{l.review ? ` · ${l.review}` : ''}</span>}
                </Card>
              );
            })}
      </div>
    </div>
  );
}

export function LessonRateSheet({ lesson, onDone }) {
  const [stars, setStars] = useState(5);
  const [text, setText] = useState('');
  const send = async () => { const r = await attempt(() => C.tutors.act(lesson.id, { action: 'done', rating: stars, review: text })); if (r) { closeSheet(); toast(t('thanksRating')); onDone?.(); } };
  return (
    <SheetFrame title={t('rateLesson')}>
      <p class="note-text center">{t('rateLessonSub', { name: lesson.teacher?.name || '' })}</p>
      <StarsInput value={stars} onChange={setStars} />
      <textarea class="textarea" rows="3" maxLength={600} placeholder={t('reviewPh')} value={text} onInput={(e) => setText(e.currentTarget.value)} aria-label={t('reviewPh')} />
      <Button kind="brand" full onClick={send}>{t('send')}</Button>
    </SheetFrame>
  );
}

/** Teach on Haptune: the teacher's own profile, the verification fee, and where it stands. */
export function TutorMeView({ active }) {
  const s = useApp();
  const [info, setInfo] = useState(null);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => C.tutors.me().then((r) => {
    setInfo(r);
    setF((old) => old || (r.profile ? { headline: r.profile.headline, bio: r.profile.bio, instruments: r.profile.instruments, levels: r.profile.levels, languages: r.profile.languages.join(', '), city: r.profile.city, online: r.profile.online, in_person: r.profile.in_person, rate: r.profile.rate, times: r.profile.times }
      : { headline: '', bio: '', instruments: [s.settings.instrument].filter(Boolean), levels: ['beginner'], languages: '', city: '', online: true, in_person: false, rate: '', times: '' }));
  }).catch((e) => toast(e.message, 'err'));
  useEffect(() => { if (active && hasServer()) ensureAccount().then(load); }, [active]);
  if (!hasServer()) return <div class="scroll"><NavBar title={t('teachOnHaptune')} /><Empty icon="globe" title={t('needOnline')} /></div>;
  if (!info || !f) return <div class="scroll"><NavBar title={t('teachOnHaptune')} /><div class="loading"><div class="spinner" /></div></div>;
  const p = info.profile;
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const tog = (key, v) => set({ [key]: f[key].includes(v) ? f[key].filter((x) => x !== v) : [...f[key], v] });
  const save = async () => {
    setBusy(true);
    const r = await attempt(() => C.tutors.save({ ...f, languages: f.languages.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) }));
    setBusy(false);
    if (r) { setInfo(r); toast(t('saved')); }
  };
  const cur = guessCurrency();
  const payCard = async () => { const r = await attempt(() => C.billing.checkout('teacher', 'once', cur)); if (r?.url) location.href = r.url; };
  const ok = f.headline.trim().length >= 4 && f.bio.trim().length >= 20 && f.instruments.length && (f.online || f.in_person);
  const fee = cur === 'myr' ? `RM ${info.fee.myr}` : `US$${info.fee.usd}`;
  return (
    <div class="scroll" id="tutor-me">
      <NavBar title={t('teachOnHaptune')} backLabel={t('back')} actions={p?.status === 'verified' ? <button type="button" onClick={() => push('lessons')} aria-label={t('myLessons')}><Icon name="calendar" size={21} /></button> : null} />
      <div class="wrap" style={{ paddingTop: 10 }}>
        {!p && <div class="pro-gate"><h2>{t('teachTitle')}</h2><p>{t('teachSub', { fee })}</p></div>}
        {p && (
          <div class={`banner ${p.status === 'verified' ? 'good' : p.status === 'rejected' || p.status === 'paused' ? 'warn' : ''}`} id="tutor-status">
            <Icon name={p.status === 'verified' ? 'shield' : 'clock'} size={20} stroke={2.2} />
            <div><strong>{t(`ts_${p.status}${p.status === 'draft' && p.paid ? 'Paid' : ''}`)}</strong>{p.admin_note && <div class="sub">{p.admin_note}</div>}</div>
          </div>
        )}
        <Section title={t('yourTeaching')}>
          <input class="field" type="text" id="tu-headline" placeholder={t('headlinePh')} maxLength={120} value={f.headline} onInput={(e) => set({ headline: e.currentTarget.value })} aria-label={t('headlinePh')} />
          <textarea class="textarea" rows="5" id="tu-bio" maxLength={2000} placeholder={t('bioPh')} value={f.bio} onInput={(e) => set({ bio: e.currentTarget.value })} aria-label={t('bioPh')} />
        </Section>
        <Section title={t('teaches')}>
          <div class="chips wrap">{[...new Set([...f.instruments, ...QUICK])].map((k) => <Chip key={k} on={f.instruments.includes(k)} onClick={() => tog('instruments', k)}>{instrumentName(k)}</Chip>)}
            <Chip onClick={() => openSheet('instrumentPick', { onPick: (k) => setF((x) => ({ ...x, instruments: [...new Set([...x.instruments, k])] })) })}><Icon name="plus" size={14} /> {t('otherInstrument')}</Chip></div>
          <div class="chips">{['beginner', 'intermediate', 'advanced'].map((l) => <Chip key={l} color="green" on={f.levels.includes(l)} onClick={() => tog('levels', l)}>{t(l)}</Chip>)}</div>
        </Section>
        <List>
          <Row icon="video" color="green" title={t('onlineLessons')} right={<Toggle id="tu-online" checked={f.online} onChange={(v) => set({ online: v })} label={t('onlineLessons')} />} />
          <Row icon="pin" color="orange" title={t('inPerson')} right={<Toggle id="tu-inperson" checked={f.in_person} onChange={(v) => set({ in_person: v })} label={t('inPerson')} />} />
        </List>
        <input class="field" type="text" placeholder={t('cityPh')} maxLength={80} value={f.city} onInput={(e) => set({ city: e.currentTarget.value })} aria-label={t('cityPh')} />
        <input class="field" type="text" id="tu-rate" placeholder={t('ratePh')} maxLength={60} value={f.rate} onInput={(e) => set({ rate: e.currentTarget.value })} aria-label={t('ratePh')} />
        <input class="field" type="text" placeholder={t('timesPh')} maxLength={300} value={f.times} onInput={(e) => set({ times: e.currentTarget.value })} aria-label={t('timesPh')} />
        <input class="field" type="text" placeholder={t('languagesPh')} maxLength={120} value={f.languages} onInput={(e) => set({ languages: e.currentTarget.value })} aria-label={t('languagesPh')} />
        <Button kind={p?.paid ? 'brand' : 'dark'} full disabled={busy || !ok} onClick={save} id="tu-save">{t(p ? 'saveProfile' : 'saveAndContinue')}</Button>
        {p && !p.paid && (
          <Section title={t('verifyFee', { fee })} footer={t('verifyFeeNote')}>
            <div class="pay-btns">
              {info.stripe && <Button full kind="brand" icon="card" onClick={payCard} id="tu-card">{t('payByCard')}</Button>}
              {cur === 'myr' && <Button full kind="secondary" icon="pin" onClick={() => openSheet('manualPay', { product: 'teacher', period: 'once', onDone: load })} id="tu-duitnow">{t('payDuitNow')}</Button>}
              {!info.stripe && cur !== 'myr' && <p class="note-text">{t('payNotReady')}</p>}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
