import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, loadAll, go, pop, popToRoot, push, closeSheet, openSheet, getState, setState, hooks, toast } from './state.js';
import { t } from '../core/i18n.js';
import { Icon } from './components.jsx';
import { Logo } from './screens/common.jsx';
import { HistoryView } from './screens/summary.jsx';
import { HomeView } from './screens/home.jsx';
import { MeView } from './screens/me.jsx';
import { WriteView, StudioView, NewSongSheet } from './screens/write.jsx';
import { HubRoleSheet, ClassQRSheet, PairSheet, JoinLinkSheet } from './screens/hub.jsx';
import { StudentView, TakeSheet } from './screens/progress.jsx';
import { MomentSheet } from './screens/stagefeed.jsx';
import { LearnView } from './screens/hub.jsx';
import { LibraryView, SongbookView, PasteSheet, FindSongSheet, ScaleSheet, ImportReportSheet, CatalogView, InstallHelpSheet } from './screens/library.jsx';
import { AddSheet, ImportWizardSheet, FinderSheet } from './screens/addmusic.jsx';
import { WelcomeSheet } from './screens/welcome.jsx';
import { PracticeView } from './screens/practice.jsx';
import { VaryView } from './screens/moretools.jsx';
import { LearnView as LearnMoreView } from './screens/learn.jsx';
import { PieceMoreSheet } from './screens/piecemore.jsx';
import { ConnectionsSheet, TeacherVerifySheet } from './screens/connections.jsx';
import { AsgMetaSheet, SessionSheet, InviteSheet, GradeSheet } from './screens/classroom.jsx';
import { ChordEditorView, ChordPickSheet, ChordSongSheet, ChordSectionSheet, ChordExportSheet } from './screens/chordeditor.jsx';
import { tick } from './native.js';
import { local } from './storage.js';
import { PieceView, ChordSheet, FindKeySheet, ExportSheet, PlayAlongSheet, KeySheet, DetailsSheet, MixerSheet, InstrumentPickSheet } from './screens/piece.jsx';
import { EditorView } from './screens/editor.jsx';
import { TutorsView, TutorView, TutorMeView, LessonsView, LessonAskSheet, LessonRateSheet } from './screens/tutors.jsx';
import { ImproviseView } from './screens/improvise.jsx';
import { AcademyView, CourseView, LessonSheet, ChallengeSheet } from './screens/academy.jsx';
import { ClassView, AssignmentView, JoinClassSheet, NewClassSheet, NewAssignmentSheet, ReviewSheet } from './screens/classes.jsx';
import { ToolsView, ToolView } from './screens/tools.jsx';
import { AccountSheet, PaywallSheet, SetPasswordSheet, SignInSheet, DeleteAccountSheet, DevCodeSheet } from './screens/account.jsx';
import { CommunityView, DailyView, StageGuideSheet, StageNewSheet } from './screens/community.jsx';
import { PostView, AcceptSheet, ChangesSheet, AddCreditsSheet, SubmitScoreSheet, ImageSheet } from './screens/post.jsx';
import { ComposeSheet } from './screens/compose.jsx';
import { ProfileView, LeaderboardView, NotificationsView, WalletView, ChallengeView, EditProfileView } from './screens/people.jsx';
import { PlansSheet, ManualPaySheet } from './screens/plans.jsx';
import { HelpView, FeedbackSheet, GuidelinesSheet, AboutSheet, captureErrors } from './screens/help.jsx';
import { AdminView } from './screens/admin.jsx';
import { ReportSheet, MoreSheet } from './screens/social.jsx';
import { hasServer } from './api.js';
import { ensureAccount, C } from './account.js';
import { initNative } from './native.js';
import { warmVerovio } from './verovio.js';
import { setSyncOffset, onAudioProblem } from './audio.js';

// The places. Practice (getting a score and playing it with the microphone), Learn (the teaching hub: classes,
// teachers, students), Write (making and fixing scores), Stage (the community) and Library (your scores).
// Me holds your account, plan and settings. On a computer they sit in a sidebar; on a phone four of them are
// in the tab bar with Write raised in the middle, and Me is the picture at the top of each page.
export const TABS = [
  { id: 'summary', icon: 'home', color: 'violet', label: 'practice' },
  { id: 'academy', icon: 'academy', color: 'orange', label: 'hub' },
  { id: 'write', icon: 'pencil', color: 'teal', label: 'create', center: true },
  { id: 'community', icon: 'stage', color: 'pink', label: 'stage' },
  { id: 'library', icon: 'library', color: 'blue', label: 'library' },
  { id: 'me', icon: 'person', color: 'gray', label: 'me', side: false },
];
const ROOTS = { summary: HomeView, library: LibraryView, community: CommunityView, academy: LearnView, write: WriteView, me: MeView };
const VIEWS = {
  improvise: (p) => <ImproviseView {...p} pushed />, tools: (p) => <ToolsView {...p} pushed />, courses: (p) => <AcademyView {...p} pushed />,
  piece: PieceView, editor: EditorView, studio: StudioView, student: StudentView, tutors: TutorsView, tutor: TutorView, tutorMe: TutorMeView, lessons: LessonsView, songbook: SongbookView, catalog: CatalogView, course: CourseView, tool: ToolView, history: HistoryView, classView: ClassView, assignment: AssignmentView,
  post: PostView, daily: DailyView, profile: ProfileView, leaderboard: LeaderboardView, notifications: NotificationsView, wallet: WalletView, challenge: ChallengeView,
  editProfile: EditProfileView, help: HelpView, admin: AdminView,
  practice: PracticeView, vary: VaryView, chordEditor: ChordEditorView, learnMore: (p) => <LearnMoreView {...p} pushed />,
};
const SHEETS = {
  add: AddSheet, paste: PasteSheet, findSong: FindSongSheet, scale: ScaleSheet, report: ImportReportSheet, chord: ChordSheet, findKey: FindKeySheet,
  export: ExportSheet, lesson: LessonSheet, challenge: ChallengeSheet, account: AccountSheet, paywall: PaywallSheet,
  importWizard: ImportWizardSheet, finder: FinderSheet, welcome: WelcomeSheet, playAlong: PlayAlongSheet, keySheet: KeySheet, details: DetailsSheet,
  joinClass: JoinClassSheet, newClass: NewClassSheet, newAssignment: NewAssignmentSheet, review: ReviewSheet,
  plans: PlansSheet, manualPay: ManualPaySheet, compose: ComposeSheet, accept: AcceptSheet, changes: ChangesSheet, addCredits: AddCreditsSheet, submitScore: SubmitScoreSheet,
  image: ImageSheet, reportPost: ReportSheet, more: MoreSheet, feedback: FeedbackSheet, guidelines: GuidelinesSheet, about: AboutSheet, installHelp: InstallHelpSheet, stageGuide: StageGuideSheet, mixer: MixerSheet, instrumentPick: InstrumentPickSheet, lessonAsk: LessonAskSheet, lessonRate: LessonRateSheet,
  newSong: NewSongSheet, hubRole: HubRoleSheet, classQR: ClassQRSheet, pair: PairSheet, take: TakeSheet, joinLink: JoinLinkSheet, moment: MomentSheet,
  setPassword: SetPasswordSheet, signIn: SignInSheet, deleteAccount: DeleteAccountSheet, devCode: DevCodeSheet,
  pieceMore: PieceMoreSheet, chordPick: ChordPickSheet, ceSong: ChordSongSheet, ceSection: ChordSectionSheet, ceExport: ChordExportSheet,
  stageNew: StageNewSheet, connections: ConnectionsSheet, teacherVerify: TeacherVerifySheet, asgMeta: AsgMetaSheet, session: SessionSheet, invite: InviteSheet, grade: GradeSheet,
};

/** Android back button: close a sheet, go back a screen, go Home, then leave the app. */
function onBack() {
  const st = getState();
  if (st.sheet) { closeSheet(); return true; }
  if (st.stacks[st.tab]?.length) { pop(); return true; }
  if (st.tab !== 'summary') { go('summary'); return true; }
  return false;
}

let practiceMinutes = 0;
/** Practice time also counts online: daily credits and the streak shown in the community. */
function reportPractice(minutes) {
  practiceMinutes += minutes;
  if (practiceMinutes < 1 || !hasServer() || !getState().me) return;
  const m = practiceMinutes;
  practiceMinutes = 0;
  C.practice(m).then((r) => { if (r.credits) { toast(t('practiceCredits', { n: r.credits, s: r.streak })); ensureAccount({ fresh: true }); } }).catch(() => { practiceMinutes += m; });
}

/** Back from Stripe's checkout page (…/app/?paid=<session>): switch the plan on straight away. */
async function backFromCheckout() {
  let session = '';
  try { session = new URLSearchParams(location.search).get('paid') || ''; } catch { return; }
  if (!session) return;
  history.replaceState(null, '', location.pathname);
  try {
    const me = await C.billing.sync(session);
    if (me.tier !== 'free') toast(t('welcomePlan', { plan: t(`plan_${me.tier}`) }));
    go('me');
  } catch (e) { toast(e.message || String(e), 'err'); openSheet('plans'); }
}

/** Links like …/#post/<id> (shared from the community) open that post. */
function openHash() {
  const h = location.hash.replace('#', '');
  // a class link or QR code: …/app/#join/ABC123
  const jn = /^join\/([A-Za-z0-9]{4,12})$/.exec(h);
  if (jn) { go('academy'); openSheet('joinLink', { code: jn[1].toUpperCase() }); history.replaceState(null, '', location.pathname); return; }
  // the app asks the website to sign it in: …/app/#pair=ABCD2345
  const pr = /^pair=([A-Za-z0-9]{8})$/.exec(h);
  if (pr) { openSheet('pair', { approve: true, code: pr[1].toUpperCase() }); history.replaceState(null, '', location.pathname); return; }
  if (h === 'write') { go('write'); return; }
  const m = /^post\/([0-9a-f]{6,16})$/.exec(h);
  if (m) { go('community'); push('post', { id: m[1] }, 'community'); return; }
  const u = /^u\/([a-z0-9_.]{3,20})$/.exec(h);
  if (u) { go('community'); push('profile', { handle: u[1] }, 'community'); return; }
  const sq = /^q=(.+)$/.exec(h);
  if (sq) { go('summary'); setState({ homeQuery: decodeURIComponent(sq[1]).slice(0, 120) }); history.replaceState(null, '', location.pathname); return; }
  if (h === 'tutors') { go('academy'); push('tutors', {}, 'academy'); return; }
  if (h === 'daily') { go('community'); push('daily', {}, 'community'); return; }
  if (h === 'stage') go('community');
  else if (h === 'learn') go('academy');
  else if (h === 'plans') openSheet('plans');
  else if (TABS.some((x) => x.id === h)) go(h);
}

function Stack({ tab, active }) {
  const s = useApp();
  const stack = s.stacks[tab];
  const Root = ROOTS[tab];
  // a screen that comes back into view after a pop slides in from the left, like iOS
  const prev = useRef(stack.length);
  const popped = stack.length < prev.current;
  useEffect(() => { prev.current = stack.length; });
  return (
    <>
      <div class={`view${popped && stack.length === 0 ? ' popped' : ''}`} hidden={stack.length > 0}><Root active={active && stack.length === 0} /></div>
      {stack.map((v, i) => {
        const V = VIEWS[v.view];
        const top = i === stack.length - 1;
        return <div class={`view pushed${popped && top ? ' popped' : ''}`} hidden={!top} key={v.key}><V {...v.props} active={active && top} /></div>;
      })}
    </>
  );
}

function SheetHost({ sheet }) {
  const S = SHEETS[sheet.type];
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') closeSheet(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  if (!S) return null;
  return (
    <div class="sheet-bg" onClick={(e) => { if (e.target === e.currentTarget && !S.modal) closeSheet(); }}>
      <S {...sheet.props} />
    </div>
  );
}

function App() {
  const s = useApp();
  useEffect(() => {
    captureErrors();
    hooks.practice = reportPractice;
    loadAll().then(() => {
      if (!local.get('welcomed', false)) openSheet('welcome');
      if (hasServer()) ensureAccount().then(backFromCheckout);
      openHash();
      warmVerovio();
    });
    initNative({ onBack, onResume: () => { if (hasServer()) ensureAccount({ fresh: true }); } });
    addEventListener('hashchange', openHash);
    return () => removeEventListener('hashchange', openHash);
  }, []);
  useEffect(() => { setSyncOffset(s.settings.syncMs || 0); }, [s.settings.syncMs]);
  const [soundTap, setSoundTap] = useState(null);       // the phone paused the sound and wants a tap to carry on
  useEffect(() => onAudioProblem(setSoundTap), []);
  if (!s.ready) return <div class="splash"><div class="spinner" /></div>;
  const tabBtn = (tab, cls) => (
    <button type="button" key={tab.id} id={`${cls === 'bar' ? 'tab' : 'side'}-${tab.label}`} class={`c-${tab.color}${s.tab === tab.id ? ' on' : ''}${tab.center && cls === 'bar' ? ' center' : ''}`} onClick={() => {
      if (s.tab !== tab.id) tick();
      if (s.tab === tab.id && s.stacks[tab.id].length) popToRoot(tab.id);
      go(tab.id);
    }} aria-current={s.tab === tab.id ? 'page' : undefined}>
      <span class="tab-ic"><Icon name={tab.center && cls === 'bar' ? 'plus' : tab.icon} size={tab.center && cls === 'bar' ? 26 : cls === 'side' ? 20 : 24} stroke={s.tab === tab.id || (tab.center && cls === 'bar') ? 2.4 : 2} />
        {tab.id === 'community' && s.me?.unread > 0 && <span class="tab-dot" />}</span>
      <span class="tab-label">{t(tab.label)}</span>
    </button>
  );
  const tier = s.me?.tier || 'free';
  const top = s.stacks[s.tab]?.[s.stacks[s.tab].length - 1]?.view;
  const immersive = top === 'piece' || top === 'editor' || top === 'studio' || top === 'chordEditor';
  const name = (s.me?.name && s.me.name !== 'Musician' ? s.me.name : s.settings.name || '').trim();
  const sec = TABS.find((x) => x.id === s.tab)?.color || 'violet';
  return (
    <div class={`app v3 sec-${sec}${immersive ? ' immersive' : ''}`}>
      <aside class="side" aria-label="Sections">
        <button type="button" class="brand" onClick={() => { popToRoot('summary'); go('summary'); }}><Logo /><span>Melovyn</span></button>
        <button type="button" class="side-create" onClick={() => openSheet('newSong')} id="side-newsong"><Icon name="plus" size={18} stroke={2.6} />{t('newSongT')}</button>
        <nav>{TABS.filter((x) => x.side !== false).map((tab) => tabBtn(tab, 'side'))}</nav>
        <div class="side-foot">
          {(tier === 'free' || tier === 'plus') && (
            <button type="button" class="side-pro" onClick={() => openSheet('plans')}>
              <strong>{t(tier === 'free' ? 'getPro' : 'upgradePro')}</strong><span>{t('sidePro')}</span>
            </button>
          )}
          <button type="button" class={`side-me${s.tab === 'me' ? ' on' : ''}`} id="top-me" onClick={() => { popToRoot('me'); go('me'); }}>
            <span class="avatar">{name.slice(0, 1).toUpperCase() || <Icon name="person" size={18} />}</span>
            <span class="who"><strong>{name || t('me')}</strong><span>{tier === 'free' ? t('plan_free') : tier === 'dev' ? 'DEV' : t(`plan_${tier}`)}</span></span>
            <Icon name="gear" size={18} />
          </button>
        </div>
      </aside>
      <main class="content">
        {TABS.map((tab) => <div class="tab-pane" hidden={s.tab !== tab.id} key={tab.id}><Stack tab={tab.id} active={s.tab === tab.id} /></div>)}
      </main>
      <nav class="tabbar" aria-label="Sections">{TABS.filter((x) => x.side !== false).map((tab) => tabBtn(tab, 'bar'))}</nav>
      {s.sheet && <SheetHost sheet={s.sheet} />}
      {soundTap && <button type="button" class="sound-pill" id="sound-pill"><Icon name="speaker" size={18} stroke={2.3} />{t('tapForSound')}</button>}
      {s.toast && <div class={`toast${s.toast.kind === 'err' ? ' err' : ''}`} role="status"><Icon name={s.toast.kind === 'err' ? 'info' : 'check'} size={18} stroke={2.4} />{s.toast.text}</div>}
    </div>
  );
}

export function mount() {
  let root = document.getElementById('haptune');
  if (!root) { root = document.createElement('div'); root.id = 'haptune'; document.body.appendChild(root); }
  root.style.height = '100%';
  render(<App />, root);
  globalThis.__haptune = { getState };
}
