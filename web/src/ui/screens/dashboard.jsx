// Developer mode: the owner's dashboard. Tabs depend on the scopes a person has (the owner has all):
//   Overview, Activity, Errors       read_analytics      Users (+ profile)       manage_users
//   Features (usage + flags)          feature_flags        Access, Audit           the owner
//   Review: payments, teachers, tutors, Stage reports, feedback, credits (their own scopes)
// Charts are single-series SVG (one hue, hover tooltips, a table view for each), light and dark.
import { useEffect, useState } from 'preact/hooks';
import { useApp, push, pop, openSheet, closeSheet, toast } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, Button, Chip, Empty, List, Row, Toggle } from '../components.jsx';
import { NavBar, SheetFrame } from './common.jsx';
import { call } from '../api.js';
import { saveFile } from '../files.js';
import { timeAgo } from './social.jsx';
import { Payments, TutorsAdmin, Reports, Inbox, Tools, TeachersAdmin } from './admin.jsx';

const TABS = [
  ['overview', 'read_analytics'], ['users', 'manage_users'], ['activity', 'read_analytics'], ['features', 'feature_flags'],
  ['errors', 'read_analytics'], ['access', 'owner'], ['audit', 'owner'],
  ['payments', 'manage_users'], ['teachers', 'verify_teachers'], ['tutors', 'verify_teachers'], ['reports', 'moderate_stage'], ['feedback', 'manage_users'], ['tools', 'manage_users'],
];
const SCOPES = ['read_analytics', 'manage_users', 'feature_flags', 'moderate_stage', 'verify_teachers'];

function useStaff() {
  const s = useApp();
  const st = s.me?.staff;
  const can = (scope) => !!st?.dev_mode && (st.role === 'owner' || (scope !== 'owner' && st.scopes.includes(scope)));
  return { st, can };
}

function useLoad(path, deps = [], on = true) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = () => call(path).then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message || String(e)));
  useEffect(() => { if (on) load(); }, [path, on, ...deps]);
  return [d, err, load];
}

export function AdminView({ active, tab: tab0, prefill = '' }) {
  const { st, can } = useStaff();
  const tabs = TABS.filter(([, sc]) => can(sc));
  const [tab, setTab] = useState(tab0 && tabs.some(([k]) => k === tab0) ? tab0 : tabs[0]?.[0]);
  if (!st?.dev_mode) {
    return <div class="scroll"><NavBar title={t('devPanel')} backLabel={t('back')} color="purple" />
      <div class="wrap"><Empty icon="bolt" title={t('dmOffTitle')} sub={t('dmOffSub')} /><Button kind="brand" full onClick={() => openSheet('devMode')}>{t('dmTurnOn')}</Button></div></div>;
  }
  return (
    <div class="scroll" id="dashboard">
      <NavBar title={t('devPanel')} backLabel={t('back')} color="purple" />
      <div class="wrap">
        <p class="tiny muted dash-who"><Icon name="bolt" size={12} /> {st.role === 'owner' ? t('dmOwner') : t('dmScopes', { s: st.scopes.map((x) => t(`scope_${x}`)).join(', ') })}</p>
        <div class="chips dash-tabs" role="tablist" id="dash-tabs">{tabs.map(([k]) => <Chip key={k} on={tab === k} onClick={() => setTab(k)} id={`dash-tab-${k}`}>{t(`dash_${k}`)}</Chip>)}</div>
        {tab === 'overview' && <Overview active={active} />}
        {tab === 'users' && <Users active={active} />}
        {tab === 'activity' && <Activity active={active} />}
        {tab === 'features' && <Features active={active} canRead={can('read_analytics')} />}
        {tab === 'errors' && <Errors active={active} canUsers={can('manage_users')} />}
        {tab === 'access' && <Access active={active} prefill={prefill} />}
        {tab === 'audit' && <Audit active={active} />}
        {tab === 'payments' && <Payments active={active} />}
        {tab === 'teachers' && <TeachersAdmin active={active} />}
        {tab === 'tutors' && <TutorsAdmin active={active} />}
        {tab === 'reports' && <Reports active={active} />}
        {tab === 'feedback' && <Inbox active={active} />}
        {tab === 'tools' && <Tools />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- small charts (one series, one hue)
function Bars({ data, unit = '', id, height = 120, label }) {
  const [hover, setHover] = useState(-1);
  const max = Math.max(1, ...data.map((d) => d.value));
  const w = 100 / Math.max(1, data.length);
  return (
    <figure class="chart" id={id}>
      {label && <figcaption>{label}</figcaption>}
      <div class="chart-plot" style={{ height }} onMouseLeave={() => setHover(-1)}>
        {data.map((d, i) => (
          <button type="button" key={d.label} class={`chart-bar${hover === i ? ' on' : ''}`} style={{ left: `${i * w}%`, width: `${w}%` }}
            onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onClick={() => setHover(i)} aria-label={`${d.label}: ${d.value}${unit}`}>
            <i style={{ height: `${(d.value / max) * 100}%` }} />
          </button>))}
        {hover >= 0 && <div class="chart-tip" style={{ left: `${Math.min(80, Math.max(0, hover * w - 10))}%` }}><b>{data[hover].value}{unit}</b> {data[hover].label}</div>}
      </div>
      <div class="chart-axis"><span>{data[0]?.label}</span><span>{data[data.length - 1]?.label}</span></div>
      <details class="chart-table"><summary>{t('dashTable')}</summary><table><tbody>{data.map((d) => <tr key={d.label}><td>{d.label}</td><td>{d.value}{unit}</td></tr>)}</tbody></table></details>
    </figure>
  );
}

function HBars({ data, unit = '', id }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div class="hbars" id={id}>{data.map((d) => (
      <div class="hbar" key={d.label} title={`${d.label}: ${d.value}${unit}`}>
        <span class="hbar-l">{d.label}</span>
        <span class="hbar-t"><i style={{ width: `${(d.value / max) * 100}%` }} /></span>
        <span class="hbar-v num">{d.value}{unit}</span>
      </div>))}</div>
  );
}

const Stat = ({ k, v, sub, id }) => <div class="stat-tile" id={id}><span class="stat-k">{k}</span><strong class="num">{v ?? '–'}</strong>{sub && <span class="stat-s">{sub}</span>}</div>;

// ---------------------------------------------------------------- overview
function Overview({ active }) {
  const [o, err] = useLoad('/c/admin/analytics/overview', [], active);
  if (err) return <p class="note-text err">{err}</p>;
  if (!o) return <div class="loading"><div class="spinner" /></div>;
  const pct = (x) => (x == null ? '–' : `${x}%`);
  const short = (d) => d.slice(5).replace('-', '/');
  return (
    <div class="dash-sec" id="dash-overview">
      <div class="stat-grid">
        <Stat k={t('dashDau')} v={o.active.dau} sub={`${t('dashWau')} ${o.active.wau} · ${t('dashMau')} ${o.active.mau}`} id="st-dau" />
        <Stat k={t('dashSignups')} v={o.signups.today} sub={`7d ${o.signups['7d']} · 30d ${o.signups['30d']}`} />
        <Stat k={t('dashSignins')} v={o.signins.today} sub={`7d ${o.signins['7d']} · 30d ${o.signins['30d']}`} />
        <Stat k={t('dashSession')} v={o.avg_session_min != null ? `${o.avg_session_min} min` : '–'} sub={t('dash30d')} />
        <Stat k={t('dashPractice')} v={o.practice_minutes} sub={t('dashMinutes30')} />
        <Stat k={t('dashPlayed')} v={o.pieces_played} sub={`${t('dashOpened')} ${o.pieces_opened}`} />
        <Stat k={t('dashSounds')} v={o.sounds_made} sub={t('dash30d')} />
        <Stat k={t('dashPosts')} v={o.stage_posts} sub={t('dash30d')} />
        <Stat k={t('dashClasses')} v={o.classes.active} sub={t('dashOfTotal', { n: o.classes.total })} />
        <Stat k={t('dashRetention')} v={pct(o.retention.d7)} sub={`D1 ${pct(o.retention.d1)} · D30 ${pct(o.retention.d30)} · n=${o.retention.cohort}`} />
      </div>
      <Bars id="ch-active" label={t('dashActiveDaily')} data={o.daily.map((d) => ({ label: short(d.day), value: d.active }))} />
      <Bars id="ch-signins" label={t('dashSigninsDaily')} data={o.daily.map((d) => ({ label: short(d.day), value: d.signins }))} height={80} />
      <h3 class="dash-h">{t('dashMethods')}</h3>
      <HBars data={[['google', 'Google'], ['password', t('admViaPassword')], ['guest', t('admGuest')]].map(([k, l]) => ({ label: l, value: o.signin_methods[k] || 0 }))} />
      <h3 class="dash-h">{t('dashPlatforms')}</h3>
      <HBars id="ch-platforms" data={Object.entries(o.platforms).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: t(`plat_${k}`), value: v }))} />
      <h3 class="dash-h">{t('dashCountries')}</h3>
      {o.countries.length ? <HBars data={o.countries.map((c) => ({ label: c.country, value: c.people }))} /> : <p class="tiny muted">{t('dashNoData')}</p>}
      <p class="tiny muted">{t('dashLoaded', { ms: o.ms })}</p>
    </div>
  );
}

// ---------------------------------------------------------------- users
function Users({ active }) {
  const [q, setQ] = useState('');
  const [who, setWho] = useState('signed_in');
  const [qq, setQQ] = useState('');
  useEffect(() => { const id = setTimeout(() => setQQ(q), 250); return () => clearTimeout(id); }, [q]);
  const [d, err] = useLoad(`/c/admin/users?q=${encodeURIComponent(qq)}&who=${who}&limit=100`, [], active);
  return (
    <div class="dash-sec" id="dash-users">
      <label class="search" for="dash-users-q"><Icon name="search" size={18} /><input id="dash-users-q" type="search" placeholder={t('admPeopleSearch')} value={q} onInput={(e) => setQ(e.currentTarget.value)} autocapitalize="off" /></label>
      <div class="chips">{['signed_in', 'all', 'staff', 'teachers'].map((k) => <Chip key={k} on={who === k} onClick={() => setWho(k)}>{t(`dashWho_${k}`)}</Chip>)}</div>
      {err && <p class="note-text err">{err}</p>}
      {!d ? <div class="loading"><div class="spinner" /></div> : !d.items.length ? <Empty icon="users" title={t('admNobody')} /> : <>
        <p class="tiny muted">{t('admPeopleCount', { n: d.total })}</p>
        <div class="dash-table-wrap"><table class="dash-table" id="users-table">
          <thead><tr>{['dashName', 'dashRole', 'dashPlan', 'dashSeen', 'dashTime', 'dashSessions', 'dashPieces', 'dashTakes', 'dashPostsCol', 'dashClassesCol', 'dashDevice', 'dashJoined'].map((k) => <th key={k}>{t(k)}</th>)}</tr></thead>
          <tbody>{d.items.map((x) => (
            <tr key={x.handle} onClick={() => push('adminUser', { handle: x.handle })} id={`u-${x.handle}`} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && push('adminUser', { handle: x.handle })}>
              <td><strong>{x.name || x.handle}</strong><span class="tiny muted">@{x.handle}{x.email ? ` · ${x.email}` : ''}</span></td>
              <td><span class={`role-pill r-${x.role}`}>{t(`role_${x.role}`)}</span>{x.suspended && <span class="role-pill r-banned">{t('dashSuspended')}</span>}</td>
              <td>{t(`plan_${x.plan}`)}{x.plan !== 'free' ? <span class="tiny muted">{x.until ? x.until.slice(0, 10) : t('admNoEnd')}</span> : null}</td>
              <td>{timeAgo(x.seen)}</td><td class="num">{x.minutes} min</td><td class="num">{x.sessions}</td><td class="num">{x.pieces}</td><td class="num">{x.takes}</td>
              <td class="num">{x.posts}</td><td class="num">{x.classes}</td><td>{x.device ? t(`plat_${x.device}`) : '–'}</td><td>{x.joined?.slice(0, 10)}</td>
            </tr>))}</tbody>
        </table></div>
      </>}
    </div>
  );
}

export function AdminUserView({ handle, active }) {
  const { can, st } = useStaff();
  const [u, err, load] = useLoad(`/c/admin/users/${encodeURIComponent(handle)}`, [], active);
  const [days, setDays] = useState(0);
  const [msg, setMsg] = useState('');
  const [email, setEmail] = useState(false);
  const act = async (path, json, done) => {
    try { await call(`/c/admin/users/${encodeURIComponent(handle)}/${path}`, { method: 'POST', json }); toast(done); load(); } catch (e) { toast(e.message, 'err'); }
  };
  if (err) return <div class="scroll"><NavBar title={`@${handle}`} backLabel={t('back')} color="purple" /><div class="wrap"><p class="note-text err">{err}</p></div></div>;
  if (!u) return <div class="scroll"><NavBar title={`@${handle}`} backLabel={t('back')} color="purple" /><div class="loading"><div class="spinner" /></div></div>;
  const protectedAcc = u.role === 'owner' || (u.role === 'developer' && st?.role !== 'owner');
  return (
    <div class="scroll" id="admin-user">
      <NavBar title={u.name || `@${u.handle}`} backLabel={t('back')} color="purple" />
      <div class="wrap">
        <div class="au-head"><span class={`role-pill r-${u.role}`}>{t(`role_${u.role}`)}</span>{u.suspended && <span class="role-pill r-banned">{t('dashSuspended')}</span>}
          <span class="tiny muted">@{u.handle}{u.email ? ` · ${u.email}` : ''} · {t(u.how === 'google' ? 'admViaGoogle' : u.how === 'password' ? 'admViaPassword' : 'admGuest')}{u.totp ? ' · 2FA' : ''}</span>
          <span class="tiny muted">{t('dashJoined')} {u.joined?.slice(0, 10)} · {t('admSeen', { when: timeAgo(u.seen) })}</span></div>

        <h3 class="dash-h">{t('dashPlan')}: {t(`plan_${u.plan}`)}{u.plan !== 'free' ? ` · ${u.until ? t('admUntil', { date: u.until.slice(0, 10) }) : t('admNoEnd')}` : ''}</h3>
        <div class="au-row"><label class="tiny">{t('days')} <input class="field" type="number" min="0" max="3650" value={days} onInput={(e) => setDays(e.currentTarget.value)} style={{ width: 80, display: 'inline-block' }} /></label><span class="tiny muted">{t('admZeroDays')}</span></div>
        <div class="row-gap" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Button small kind="brand" icon="crown" onClick={() => act('plan', { tier: 'pro', days: Number(days) || 0 }, t('grantedPlan', { handle: u.handle, plan: t('plan_pro') }))} id="au-pro">{t('admGive', { plan: t('plan_pro') })}</Button>
          <Button small kind="secondary" onClick={() => act('plan', { tier: 'plus', days: Number(days) || 0 }, t('grantedPlan', { handle: u.handle, plan: t('plan_plus') }))}>{t('admGive', { plan: t('plan_plus') })}</Button>
          {u.plan !== 'free' && <Button small kind="plain" onClick={() => act('plan', { tier: 'free', days: 0 }, t('done'))}>{t('admBackToFree')}</Button>}
        </div>

        <List>
          {can('verify_teachers') && u.role !== 'owner' && u.role !== 'developer' && <Row icon="check" color="green" title={t('verifiedTeacher')}
            right={<Toggle id="au-teacher" checked={u.role === 'teacher'} onChange={(v) => act('teacher', { on: v }, t('done'))} label={t('verifiedTeacher')} />} />}
          {!protectedAcc && <Row icon="info" color="orange" title={t('dashSuspend')} subtitle={t('dashSuspendSub')}
            right={<Toggle id="au-suspend" checked={u.suspended} onChange={(v) => act('suspend', { on: v }, t('done'))} label={t('dashSuspend')} />} />}
          {st?.role === 'owner' && u.role !== 'owner' && <Row icon="bolt" color="purple" title={u.developer ? t('dashDevAccessEdit') : t('dashDevAccessGive')}
            subtitle={u.developer ? u.developer.scopes.map((x) => t(`scope_${x}`)).join(', ') : t('dashDevAccessSub')} onClick={() => push('admin', { tab: 'access', prefill: u.handle })} id="au-access" />}
        </List>

        <h3 class="dash-h">{t('dashMessage')}</h3>
        <textarea class="field" rows={2} maxLength={1000} value={msg} onInput={(e) => setMsg(e.currentTarget.value)} placeholder={t('dashMessagePh')} id="au-msg" />
        <div class="au-row"><Toggle id="au-email" checked={email} onChange={setEmail} label={t('dashAlsoEmail')} /> <span class="tiny">{t('dashAlsoEmail')}</span>
          <Button small kind="secondary" icon="send" disabled={!msg.trim()} onClick={() => { act('message', { text: msg.trim(), email }, t('dashSent')); setMsg(''); }}>{t('send')}</Button></div>

        <h3 class="dash-h">{t('dashTimeByScreen')}</h3>
        {Object.keys(u.time_by_screen).length ? <HBars data={Object.entries(u.time_by_screen).slice(0, 10).map(([k, v]) => ({ label: t(`scr_${k}`) === `scr_${k}` ? k : t(`scr_${k}`), value: v }))} unit=" min" /> : <p class="tiny muted">{t('dashNoData')}</p>}
        {u.pieces.length > 0 && <><h3 class="dash-h">{t('dashPiecesPractised')}</h3><p class="tiny">{u.pieces.join(' · ')}</p></>}

        <h3 class="dash-h">{t('dashTimeline')}</h3>
        <ul class="timeline" id="au-timeline">{u.timeline.slice(0, 120).map((e, i) => (
          <li key={i} class={`tl-${e.name}`}><span class="tl-t">{new Date(e.t).toLocaleString()}</span><span class="tl-n">{t(`ev_${e.name}`) === `ev_${e.name}` ? e.name : t(`ev_${e.name}`)}</span>
            <span class="tl-d">{[e.screen, e.label, e.value != null ? Math.round(e.value) : '', e.platform && e.platform !== 'server' ? t(`plat_${e.platform}`) : '', e.country].filter(Boolean).join(' · ')}</span></li>))}
          {!u.timeline.length && <li class="tiny muted">{t('dashNoData')}</li>}</ul>
        {u.sound_checks.length > 0 && <><h3 class="dash-h">{t('scT')}</h3>{u.sound_checks.map((x, i) => <p key={i} class="tiny"><b>{x.t.slice(0, 16).replace('T', ' ')}</b> {JSON.stringify(x.props)}</p>)}</>}
        {(u.posts.length > 0 || u.reported.length > 0) && <><h3 class="dash-h">{t('dash_reports')}</h3>
          <p class="tiny">{t('dashPostsN', { n: u.posts.length })} · {t('dashReportedN', { n: u.reported.length })} · {t('dashReportsSentN', { n: u.reports_sent })}</p></>}

        <div class="au-danger">
          <Button kind="secondary" full icon="download" onClick={async () => { try { const r = await call(`/c/admin/users/${encodeURIComponent(handle)}/export`, { raw: true }); await saveFile(`melovyn-${handle}.json`, new Uint8Array(await r.arrayBuffer())); } catch (e) { toast(e.message, 'err'); } }} id="au-export">{t('dashExport')}</Button>
          {!protectedAcc && <Button kind="plain" full icon="trash" onClick={() => openSheet('deleteUser', { handle: u.handle })} id="au-delete">{t('dashDelete')}</Button>}
        </div>
      </div>
    </div>
  );
}

/** Deleting someone: two confirmations (this sheet, then typing their username). */
export function DeleteUserSheet({ handle }) {
  const [sure, setSure] = useState(false);
  const [typed, setTyped] = useState('');
  const go = async () => {
    try { await call(`/c/admin/users/${encodeURIComponent(handle)}/delete`, { method: 'POST', json: { confirm: typed } }); toast(t('dashDeleted')); closeSheet(); pop(); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <SheetFrame title={t('dashDelete')}>
      <p class="note-text">{t('dashDeleteHelp', { h: handle })}</p>
      {!sure ? <Button full color="red" onClick={() => setSure(true)} id="du-1">{t('dashDeleteSure')}</Button> : <>
        <input class="field" value={typed} onInput={(e) => setTyped(e.currentTarget.value)} placeholder={`@${handle}`} autocapitalize="off" id="du-type" />
        <Button full color="red" disabled={typed.trim().toLowerCase().replace(/^@/, '') !== handle} onClick={go} id="du-2">{t('dashDeleteFinal')}</Button>
      </>}
    </SheetFrame>
  );
}

// ---------------------------------------------------------------- activity + funnels
function Activity({ active }) {
  const [name, setName] = useState('');
  const [plat, setPlat] = useState('');
  const [d, err, load] = useLoad(`/c/admin/analytics/activity?name=${name}&platform=${plat}`, [], active);
  const [f] = useLoad('/c/admin/analytics/funnels?days=30', [], active);
  useEffect(() => { if (!active) return undefined; const id = setInterval(load, 30000); return () => clearInterval(id); }, [active, name, plat]);
  const names = ['', 'session_start', 'screen_view', 'piece_open', 'play_along_finish', 'create_export', 'post_created', 'class_joined', 'sound_made', 'hapi_ask', 'sign_in', 'error'];
  return (
    <div class="dash-sec" id="dash-activity">
      <h3 class="dash-h">{t('dashFunnels')}</h3>
      {!f ? <div class="loading"><div class="spinner" /></div> : f.funnels.map((x) => (
        <div class="funnel" key={x.id}><p class="tiny"><b>{x.label}</b> · {t('dash30d')}</p>
          <HBars data={x.steps.map((s, i) => ({ label: `${i + 1}. ${s.step}`, value: s.people }))} /></div>))}
      <h3 class="dash-h">{t('dashLive')}</h3>
      <div class="chips wrap">
        <select class="field" value={name} onChange={(e) => setName(e.currentTarget.value)} aria-label={t('dashEvent')} style={{ width: 'auto' }}>{names.map((n) => <option key={n} value={n}>{n ? (t(`ev_${n}`) === `ev_${n}` ? n : t(`ev_${n}`)) : t('dashAllEvents')}</option>)}</select>
        <select class="field" value={plat} onChange={(e) => setPlat(e.currentTarget.value)} aria-label={t('dashDevice')} style={{ width: 'auto' }}>{['', 'web', 'homescreen', 'android', 'ios'].map((p) => <option key={p} value={p}>{p ? t(`plat_${p}`) : t('dashAllDevices')}</option>)}</select>
      </div>
      {err && <p class="note-text err">{err}</p>}
      {!d ? <div class="loading"><div class="spinner" /></div> : !d.items.length ? <p class="tiny muted">{t('dashNoData')}</p> : (
        <ul class="timeline" id="activity-feed">{d.items.map((e, i) => (
          <li key={i}><span class="tl-t">{new Date(e.t).toLocaleTimeString()}</span><span class="tl-n">{t(`ev_${e.name}`) === `ev_${e.name}` ? e.name : t(`ev_${e.name}`)}</span>
            <span class="tl-d">{[e.who ? `@${e.who}` : '', e.screen, e.label, e.value != null ? Math.round(e.value) : '', t(`plat_${e.platform}`), e.country].filter(Boolean).join(' · ')}</span></li>))}</ul>)}
      {d && !d.personal && <p class="tiny muted">{t('dashAggregatesOnly')}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- features + flags
function Features({ active, canRead }) {
  const [u] = useLoad('/c/admin/analytics/features?days=30', [], active && canRead);
  const [fl, err, load] = useLoad('/c/admin/flags', [], active);
  const [edit, setEdit] = useState(null);
  const save = async () => {
    try {
      await call(`/c/admin/flags/${edit.key}`, { method: 'POST', json: { state: edit.state, percent: Number(edit.percent), users: String(edit.usersText || '').split(/[\s,]+/).filter(Boolean), note: edit.note || '' } });
      toast(t('done')); setEdit(null); load();
    } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <div class="dash-sec" id="dash-features">
      <h3 class="dash-h">{t('dashFlags')}</h3>
      <p class="tiny muted">{t('dashFlagsHelp')}</p>
      {err && <p class="note-text err">{err}</p>}
      {fl && <List>{fl.items.map((f) => (
        <Row key={f.key} icon="bolt" color={f.state === 'off' ? 'gray' : f.state === 'beta' ? 'orange' : 'green'} title={f.label}
          subtitle={`${t(`flag_${f.state}`)}${f.state !== 'off' && f.percent < 100 ? ` · ${f.percent}%` : ''}${f.users?.length ? ` · +${f.users.length}` : ''}`}
          onClick={() => setEdit({ ...f, usersText: (f.users || []).join(', ') })} id={`flag-${f.key}`} />))}</List>}
      {edit && <div class="card flag-edit" id="flag-edit">
        <strong>{edit.label}</strong>
        <div class="chips">{['on', 'beta', 'off'].map((x) => <Chip key={x} on={edit.state === x} onClick={() => setEdit({ ...edit, state: x })} id={`flag-state-${x}`}>{t(`flag_${x}`)}</Chip>)}</div>
        {edit.state !== 'off' && <label class="field3"><span>{t('dashPercent')}: {edit.percent}%</span><input type="range" min="0" max="100" step="5" value={edit.percent} onInput={(e) => setEdit({ ...edit, percent: e.currentTarget.value })} /></label>}
        <label class="field3"><span>{t('dashNamedUsers')}</span><input class="field" value={edit.usersText} onInput={(e) => setEdit({ ...edit, usersText: e.currentTarget.value })} placeholder="@mei_ling, @ben" autocapitalize="off" /></label>
        <div class="row-gap" style={{ gap: 8 }}><Button small kind="brand" onClick={save} id="flag-save">{t('save')}</Button><Button small kind="plain" onClick={() => setEdit(null)}>{t('cancel')}</Button></div>
      </div>}
      {canRead && <>
        <h3 class="dash-h">{t('dashTimeByScreen')} · {t('dash30d')}</h3>
        {!u ? <div class="loading"><div class="spinner" /></div> : u.screens.length ? <HBars id="ch-screens" data={u.screens.slice(0, 14).map((x) => ({ label: t(`scr_${x.screen}`) === `scr_${x.screen}` ? x.screen : t(`scr_${x.screen}`), value: Math.round(x.minutes) }))} unit=" min" /> : <p class="tiny muted">{t('dashNoData')}</p>}
        {u && <><h3 class="dash-h">{t('dashUsage')}</h3><HBars data={u.events.filter((e) => !['screen_view', 'screen_time'].includes(e.name)).slice(0, 14).map((e) => ({ label: t(`ev_${e.name}`) === `ev_${e.name}` ? e.name : t(`ev_${e.name}`), value: e.count }))} /></>}
      </>}
    </div>
  );
}

// ---------------------------------------------------------------- errors
function Errors({ active, canUsers }) {
  const [days, setDays] = useState(7);
  const [d, err] = useLoad(`/c/admin/analytics/errors?days=${days}`, [], active);
  return (
    <div class="dash-sec" id="dash-errors">
      <div class="chips">{[1, 7, 30].map((n) => <Chip key={n} on={days === n} onClick={() => setDays(n)}>{t('dashDays', { n })}</Chip>)}</div>
      {err && <p class="note-text err">{err}</p>}
      {!d ? <div class="loading"><div class="spinner" /></div> : !d.items.length ? <Empty icon="check" title={t('dashNoErrors')} /> : d.items.map((x, i) => (
        <div class="card err-card" key={i}>
          <div class="err-top"><span class={`role-pill ${x.source === 'server' ? 'r-developer' : 'r-user'}`}>{t(x.source === 'server' ? 'dashServer' : 'dashApp')}</span><b class="num">×{x.count}</b><span class="tiny muted">{t('dashPeopleN', { n: x.people })} · {timeAgo(x.last)}</span></div>
          <code class="err-msg">{x.message}</code>
          <span class="tiny muted">{[...x.screens, ...x.platforms.map((p) => t(`plat_${p}`)), x.device].filter(Boolean).join(' · ')}</span>
          {canUsers && x.who.length > 0 && <div class="row-gap" style={{ gap: 6, flexWrap: 'wrap' }}>{x.who.map((h) => <Chip key={h} onClick={() => push('adminUser', { handle: h })}>@{h}</Chip>)}</div>}
        </div>))}
    </div>
  );
}

// ---------------------------------------------------------------- access (the owner)
function Access({ active, prefill }) {
  const [d, err, load] = useLoad('/c/admin/access', [], active);
  const [form, setForm] = useState({ handle: prefill || '', scopes: ['read_analytics'], days: 30, reason: '' });
  const grant = async () => {
    try { await call('/c/admin/access', { method: 'POST', json: { ...form, handle: form.handle.trim().replace(/^@/, ''), days: Number(form.days) || 0 } }); toast(t('dashGranted', { h: form.handle })); setForm({ ...form, handle: '', reason: '' }); load(); } catch (e) { toast(e.message, 'err'); }
  };
  const revoke = async (h) => { try { const r = await call(`/c/admin/access/${encodeURIComponent(h)}`, { method: 'DELETE' }); toast(r.env_note ? t('dashRevokedEnv') : t('dashRevoked')); load(); } catch (e) { toast(e.message, 'err'); } };
  const flip = (sc) => setForm({ ...form, scopes: form.scopes.includes(sc) ? form.scopes.filter((x) => x !== sc) : [...form.scopes, sc] });
  return (
    <div class="dash-sec" id="dash-access">
      <h3 class="dash-h">{t('dashDevelopers')}</h3>
      {err && <p class="note-text err">{err}</p>}
      {d && <div class="access-list">{d.items.map((x) => (
        <div class="card access-card" key={x.handle} id={`acc-${x.handle}`}>
          <div class="err-top"><span class={`role-pill r-${x.role}`}>{t(`role_${x.role}`)}</span><strong>@{x.handle}</strong>{x.dev_mode_now && <span class="role-pill r-developer">{t('dmTitle')}</span>}{x.expired && <span class="role-pill r-banned">{t('dashExpired')}</span>}</div>
          <span class="tiny">{x.scopes.map((sc) => t(`scope_${sc}`)).join(' · ')}</span>
          <span class="tiny muted">{[x.expires ? t('admUntil', { date: x.expires.slice(0, 10) }) : t('admNoEnd'), x.totp ? '2FA ✓' : t('dashNo2fa'), x.reason, x.granted_by ? `${t('dashBy')} @${x.granted_by}` : ''].filter(Boolean).join(' · ')}</span>
          {x.revocable && <Button small kind="plain" icon="trash" onClick={() => revoke(x.handle)} id={`revoke-${x.handle}`}>{t('dashRevoke')}</Button>}
        </div>))}</div>}
      <h3 class="dash-h">{t('dashGrantTitle')}</h3>
      <div class="card grant-form" id="grant-form">
        <input class="field" placeholder="@username" value={form.handle} onInput={(e) => setForm({ ...form, handle: e.currentTarget.value })} autocapitalize="off" id="grant-handle" />
        <div class="scope-list">{SCOPES.map((sc) => (
          <label key={sc} class="scope-row"><input type="checkbox" checked={form.scopes.includes(sc)} onChange={() => flip(sc)} id={`grant-${sc}`} /><span><b>{t(`scope_${sc}`)}</b><span class="tiny muted">{t(`scopeSub_${sc}`)}</span></span></label>))}</div>
        <label class="field3"><span>{t('dashExpiry')}</span><select class="field" value={form.days} onChange={(e) => setForm({ ...form, days: e.currentTarget.value })} id="grant-days">
          {[[7, t('dashDays', { n: 7 })], [30, t('dashDays', { n: 30 })], [90, t('dashDays', { n: 90 })], [365, t('dashDays', { n: 365 })], [0, t('admNoEnd')]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <input class="field" placeholder={t('dashReason')} value={form.reason} onInput={(e) => setForm({ ...form, reason: e.currentTarget.value })} id="grant-reason" maxLength={300} />
        <Button kind="brand" icon="bolt" disabled={!form.handle.trim() || !form.scopes.length || form.reason.trim().length < 3} onClick={grant} id="grant-go">{t('dashGrant')}</Button>
        <p class="tiny muted">{t('dashGrantHelp')}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- audit (the owner)
function Audit({ active }) {
  const [action, setAction] = useState('');
  const [d, err] = useLoad(`/c/admin/audit?action=${action}&limit=200`, [], active);
  const exportCsv = async () => { try { const r = await call('/c/admin/audit/export', { raw: true }); await saveFile('melovyn-audit.csv', await r.text()); } catch (e) { toast(e.message, 'err'); } };
  return (
    <div class="dash-sec" id="dash-audit">
      <div class="row-gap" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {d && <select class="field" value={action} onChange={(e) => setAction(e.currentTarget.value)} style={{ width: 'auto' }} aria-label={t('dashAction')}>
          <option value="">{t('dashAllActions')}</option>{d.actions.map((a) => <option key={a} value={a}>{a}</option>)}</select>}
        <Button small kind="secondary" icon="download" onClick={exportCsv} id="audit-export">CSV</Button>
      </div>
      <p class="tiny muted">{t('dashAuditHelp')}</p>
      {err && <p class="note-text err">{err}</p>}
      {!d ? <div class="loading"><div class="spinner" /></div> : (
        <ul class="timeline" id="audit-list">{d.items.map((r) => (
          <li key={r.id}><span class="tl-t">{new Date(r.t).toLocaleString()}</span><span class="tl-n">{r.action}</span>
            <span class="tl-d">@{r.who}{r.whom ? ` → @${r.whom}` : ''}{r.after ? ` · ${JSON.stringify(r.after)}` : ''}{r.note ? ` · ${r.note}` : ''}</span></li>))}</ul>)}
    </div>
  );
}
