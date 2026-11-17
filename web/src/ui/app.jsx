import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, loadAll, go, pop, popToRoot, push, closeSheet, openSheet, getState, setState, hooks, toast } from './state.js';
import { t } from '../core/i18n.js';
import { Icon } from './components.jsx';
import { Logo } from './screens/common.jsx';
import { HomeView } from './screens/home.jsx';
import { Cover } from './cover.jsx';
import { AIChatSheet, AIFab } from './screens/aichat.jsx';
import { Boundary } from './boundary.jsx';
import { startTracking, loadFlags, screenShown, flag, track } from './analytics.js';
import { parseLink } from '../core/piece.js';
import { loadCatalog, addCatalogPiece } from './catalog.js';
import { tick } from './native.js';
import { local } from './storage.js';
import { HelpView, FeedbackSheet, GuidelinesSheet, AboutSheet, captureErrors } from './screens/help.jsx';
import { hasServer } from './api.js';
import { ensureAccount, C } from './account.js';
import { initNative } from './native.js';
import { warmVerovio } from './verovio.js';
import { setSyncOffset, onAudioProblem } from './audio.js';


// Screens load the first time they are opened (esbuild splits them into chunks/), so the first screen appears sooner.
function lazy(load, name) {
  let Comp = null, failed = null;
  const get = () => load().then((m) => { Comp = m[name]; });
  function Lazy(props) {
    const [, setV] = useState(0);
    useEffect(() => {
      if (Comp) return undefined;
      let on = true;
      get().then(() => on && setV(1)).catch((e) => { failed = e; if (on) setV(2); });
      return () => { on = false; };
    }, []);
    if (Comp) return <Comp {...props} />;
    if (failed) return <div class="loading"><p class="note-text">{t('offlineChunk')}</p><button type="button" class="btn" onClick={() => location.reload()}>{t('tryAgain')}</button></div>;
    return <div class="loading"><div class="spinner" /></div>;
  }
  Lazy.preload = () => get().catch(() => {});
  return Lazy;
}
const m_summary = () => import('./screens/summary.jsx');
const HistoryView = lazy(m_summary, 'HistoryView');
const m_find = () => import('./screens/find.jsx');
const FindView = lazy(m_find, 'FindView');
const NewSongsView = lazy(m_find, 'NewSongsView');
const m_me = () => import('./screens/me.jsx');
const MeView = lazy(m_me, 'MeView');
const m_write = () => import('./screens/write.jsx');
const WriteView = lazy(m_write, 'WriteView');
const StudioView = lazy(m_write, 'StudioView');
const NewSongSheet = lazy(m_write, 'NewSongSheet');
const m_hub = () => import('./screens/hub.jsx');
const HubRoleSheet = lazy(m_hub, 'HubRoleSheet');
const ClassQRSheet = lazy(m_hub, 'ClassQRSheet');
const PairSheet = lazy(m_hub, 'PairSheet');
const JoinLinkSheet = lazy(m_hub, 'JoinLinkSheet');
const m_progress = () => import('./screens/progress.jsx');
const StudentView = lazy(m_progress, 'StudentView');
const TakeSheet = lazy(m_progress, 'TakeSheet');
const m_stagefeed = () => import('./screens/stagefeed.jsx');
const MomentSheet = lazy(m_stagefeed, 'MomentSheet');
const LearnView = lazy(m_hub, 'LearnView');
const m_library = () => import('./screens/library.jsx');
const LibraryView = lazy(m_library, 'LibraryView');
const SongbookView = lazy(m_library, 'SongbookView');
const PasteSheet = lazy(m_library, 'PasteSheet');
const FindSongSheet = lazy(m_library, 'FindSongSheet');
const ScaleSheet = lazy(m_library, 'ScaleSheet');
const ImportReportSheet = lazy(m_library, 'ImportReportSheet');
const CatalogView = lazy(m_library, 'CatalogView');
const InstallHelpSheet = lazy(m_library, 'InstallHelpSheet');
const m_addmusic = () => import('./screens/addmusic.jsx');
const AddSheet = lazy(m_addmusic, 'AddSheet');
const ImportWizardSheet = lazy(m_addmusic, 'ImportWizardSheet');
const FinderSheet = lazy(m_addmusic, 'FinderSheet');
const m_welcome = () => import('./screens/welcome.jsx');
const WelcomeSheet = lazy(m_welcome, 'WelcomeSheet');
const m_practice = () => import('./screens/practice.jsx');
const PracticeView = lazy(m_practice, 'PracticeView');
const m_soundcheck = () => import('./screens/soundcheck.jsx');
const SoundCheckView = lazy(m_soundcheck, 'SoundCheckView');
const m_report = () => import('./screens/report.jsx');
const ReportView = lazy(m_report, 'ReportView');
const m_staff = () => import('./screens/staff.jsx');
const TwoStepSheet = lazy(m_staff, 'TwoStepSheet');
const DevModeSheet = lazy(m_staff, 'DevModeSheet');
const SessionsSheet = lazy(m_staff, 'SessionsSheet');
const m_sound = () => import('./screens/sound.jsx');
const SoundView = lazy(m_sound, 'SoundView');
const SoundPageView = lazy(m_sound, 'SoundPageView');
const SoundAddSheet = lazy(m_sound, 'SoundAddSheet');
const SoundTrackSheet = lazy(m_sound, 'SoundTrackSheet');
const SoundSettingsSheet = lazy(m_sound, 'SoundSettingsSheet');
const SoundExportSheet = lazy(m_sound, 'SoundExportSheet');
const SoundPostSheet = lazy(m_sound, 'SoundPostSheet');
const m_vary = () => import('./screens/vary.jsx');
const VaryView = lazy(m_vary, 'VaryView');
const m_learn = () => import('./screens/learn.jsx');
const LearnMoreView = lazy(m_learn, 'LearnView');
const m_piecemore = () => import('./screens/piecemore.jsx');
const PieceMoreSheet = lazy(m_piecemore, 'PieceMoreSheet');
const m_connections = () => import('./screens/connections.jsx');
const ConnectionsSheet = lazy(m_connections, 'ConnectionsSheet');
const TeacherVerifySheet = lazy(m_connections, 'TeacherVerifySheet');
const m_classroom = () => import('./screens/classroom.jsx');
const AsgMetaSheet = lazy(m_classroom, 'AsgMetaSheet');
const SessionSheet = lazy(m_classroom, 'SessionSheet');
const InviteSheet = lazy(m_classroom, 'InviteSheet');
const GradeSheet = lazy(m_classroom, 'GradeSheet');
const m_chordeditor = () => import('./screens/chordeditor.jsx');
const ChordEditorView = lazy(m_chordeditor, 'ChordEditorView');
const ChordPickSheet = lazy(m_chordeditor, 'ChordPickSheet');
const ChordSongSheet = lazy(m_chordeditor, 'ChordSongSheet');
const ChordSectionSheet = lazy(m_chordeditor, 'ChordSectionSheet');
const ChordExportSheet = lazy(m_chordeditor, 'ChordExportSheet');
const m_piece = () => import('./screens/piece.jsx');
const PieceView = lazy(m_piece, 'PieceView');
const ChordSheet = lazy(m_piece, 'ChordSheet');
const FindKeySheet = lazy(m_piece, 'FindKeySheet');
const ExportSheet = lazy(m_piece, 'ExportSheet');
const PlayAlongSheet = lazy(m_piece, 'PlayAlongSheet');
const KeySheet = lazy(m_piece, 'KeySheet');
const DetailsSheet = lazy(m_piece, 'DetailsSheet');
const MixerSheet = lazy(m_piece, 'MixerSheet');
const InstrumentPickSheet = lazy(m_piece, 'InstrumentPickSheet');
const m_editor = () => import('./screens/editor.jsx');
const EditorView = lazy(m_editor, 'EditorView');
const m_tutors = () => import('./screens/tutors.jsx');
const TutorsView = lazy(m_tutors, 'TutorsView');
const TutorView = lazy(m_tutors, 'TutorView');
const TutorMeView = lazy(m_tutors, 'TutorMeView');
const LessonsView = lazy(m_tutors, 'LessonsView');
const LessonAskSheet = lazy(m_tutors, 'LessonAskSheet');
const LessonRateSheet = lazy(m_tutors, 'LessonRateSheet');
const m_improvise = () => import('./screens/improvise.jsx');
const ImproviseView = lazy(m_improvise, 'ImproviseView');
const m_academy = () => import('./screens/academy.jsx');
const AcademyView = lazy(m_academy, 'AcademyView');
const CourseView = lazy(m_academy, 'CourseView');
const LessonSheet = lazy(m_academy, 'LessonSheet');
const ChallengeSheet = lazy(m_academy, 'ChallengeSheet');
const m_classes = () => import('./screens/classes.jsx');
const ClassView = lazy(m_classes, 'ClassView');
const AssignmentView = lazy(m_classes, 'AssignmentView');
const JoinClassSheet = lazy(m_classes, 'JoinClassSheet');
const NewClassSheet = lazy(m_classes, 'NewClassSheet');
const NewAssignmentSheet = lazy(m_classes, 'NewAssignmentSheet');
const ReviewSheet = lazy(m_classes, 'ReviewSheet');
const m_tools = () => import('./screens/tools.jsx');
const ToolsView = lazy(m_tools, 'ToolsView');
const ToolView = lazy(m_tools, 'ToolView');
const m_account = () => import('./screens/account.jsx');
const AccountSheet = lazy(m_account, 'AccountSheet');
const PaywallSheet = lazy(m_account, 'PaywallSheet');
const SetPasswordSheet = lazy(m_account, 'SetPasswordSheet');
const SignInSheet = lazy(m_account, 'SignInSheet');
const DeleteAccountSheet = lazy(m_account, 'DeleteAccountSheet');
const DevCodeSheet = lazy(m_account, 'DevCodeSheet');
const m_community = () => import('./screens/community.jsx');
const CommunityView = lazy(m_community, 'CommunityView');
const DailyView = lazy(m_community, 'DailyView');
const StageGuideSheet = lazy(m_community, 'StageGuideSheet');
const StageNewSheet = lazy(m_community, 'StageNewSheet');
const m_post = () => import('./screens/post.jsx');
const PostView = lazy(m_post, 'PostView');
const AcceptSheet = lazy(m_post, 'AcceptSheet');
const ChangesSheet = lazy(m_post, 'ChangesSheet');
const AddCreditsSheet = lazy(m_post, 'AddCreditsSheet');
const SubmitScoreSheet = lazy(m_post, 'SubmitScoreSheet');
const ImageSheet = lazy(m_post, 'ImageSheet');
const m_compose = () => import('./screens/compose.jsx');
const ComposeSheet = lazy(m_compose, 'ComposeSheet');
const m_people = () => import('./screens/people.jsx');
const ProfileView = lazy(m_people, 'ProfileView');
const LeaderboardView = lazy(m_people, 'LeaderboardView');
const NotificationsView = lazy(m_people, 'NotificationsView');
const WalletView = lazy(m_people, 'WalletView');
const ChallengeView = lazy(m_people, 'ChallengeView');
const EditProfileView = lazy(m_people, 'EditProfileView');
const m_plans = () => import('./screens/plans.jsx');
const PlansSheet = lazy(m_plans, 'PlansSheet');
const ManualPaySheet = lazy(m_plans, 'ManualPaySheet');
const m_dashboard = () => import('./screens/dashboard.jsx');
const AdminView = lazy(m_dashboard, 'AdminView');
const AdminUserView = lazy(m_dashboard, 'AdminUserView');
const DeleteUserSheet = lazy(m_dashboard, 'DeleteUserSheet');
const m_social = () => import('./screens/social.jsx');
const ReportSheet = lazy(m_social, 'ReportSheet');
const MoreSheet = lazy(m_social, 'MoreSheet');
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
  editProfile: EditProfileView, help: HelpView, admin: AdminView, adminUser: AdminUserView, find: FindView, newSongs: NewSongsView, soundPage: SoundPageView,
  __crash: () => { throw new Error('test crash'); },           // the click-through test checks the error boundary with it
  practice: PracticeView, soundCheck: SoundCheckView, report: ReportView, sound: SoundView, vary: VaryView, chordEditor: ChordEditorView, learnMore: (p) => <LearnMoreView {...p} pushed />,
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
  aiChat: AIChatSheet, deleteUser: DeleteUserSheet, twoStep: TwoStepSheet, devMode: DevModeSheet, sessions: SessionsSheet, stageNew: StageNewSheet, soundAdd: SoundAddSheet, soundTrack: SoundTrackSheet, soundSettings: SoundSettingsSheet, soundExport: SoundExportSheet, soundPost: SoundPostSheet, connections: ConnectionsSheet, teacherVerify: TeacherVerifySheet, asgMeta: AsgMetaSheet, session: SessionSheet, invite: InviteSheet, grade: GradeSheet,
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
/** The app's own links (core/piece.js parseLink): a piece (practise / create), a class or assignment, a Stage post,
 *  a Sound, a person. A piece link works on any device when it names a free-library piece. */
async function openLink(l) {
  const st = getState();
  if (l.route === 'piece') {
    let p = st.pieces.find((x) => x.id === l.id) || st.pieces.find((x) => x.catalogId === l.id);
    if (!p) {
      const entry = (await loadCatalog().catch(() => [])).find((r) => r.id === l.id);
      if (entry) p = await addCatalogPiece(entry).catch(() => null);
    }
    if (!p) { toast(t('linkNotFound'), 'err'); return; }
    if (l.action === 'create') { go('write'); push(p.chordSong ? 'chordEditor' : 'studio', { id: p.id }, 'write'); return; }
    push('piece', { id: p.id, ...(l.action === 'practise' ? { start: 'playAlong' } : l.action === 'listen' ? { start: 'listen' } : {}) }, 'library');
    return;
  }
  if (l.route === 'assignment') { go('academy'); push('assignment', { id: l.id }, 'academy'); return; }
  if (l.route === 'class') { go('academy'); push('classView', { id: l.id }, 'academy'); return; }
  if (l.route === 'post') { go('community'); push('post', { id: l.id }, 'community'); return; }
  if (l.route === 'sound') { go('community'); push('soundPage', { id: l.id }, 'community'); return; }
  if (l.route === 'person') { go('community'); push('profile', { handle: l.id }, 'community'); }
}

function openHash() {
  const h = location.hash.replace('#', '');
  // a class link or QR code: …/app/#join/ABC123
  const jn = /^join\/([A-Za-z0-9]{4,12})$/.exec(h);
  if (jn) { go('academy'); openSheet('joinLink', { code: jn[1].toUpperCase() }); history.replaceState(null, '', location.pathname); return; }
  // the app asks the website to sign it in: …/app/#pair=ABCD2345
  const pr = /^pair=([A-Za-z0-9]{8})$/.exec(h);
  if (pr) { openSheet('pair', { approve: true, code: pr[1].toUpperCase() }); history.replaceState(null, '', location.pathname); return; }
  if (h === 'write') { go('write'); return; }
  const link = parseLink(h);
  if (link) { history.replaceState(null, '', location.pathname); track('deep_link', { label: link.route + (link.action ? `:${link.action}` : '') }); openLink(link); return; }
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
      <div class={`view${popped && stack.length === 0 ? ' popped' : ''}`} hidden={stack.length > 0}><Boundary name={tab}><Root active={active && stack.length === 0} /></Boundary></div>
      {stack.map((v, i) => {
        const V = VIEWS[v.view];
        const top = i === stack.length - 1;
        return <div class={`view pushed${popped && top ? ' popped' : ''}`} hidden={!top} key={v.key}><Boundary name={v.view}>{V ? <V {...v.props} active={active && top} /> : null}</Boundary></div>;
      })}
    </>
  );
}

/** The mini-player: what is playing (a piece's Listen, a Sound), on every tab above the tab bar; tap to open it. */
function MiniPlayer({ s, immersive }) {
  const np = s.nowPlaying;
  if (!np || immersive) return null;
  const open = () => {
    if (hooks.player?.open) return hooks.player.open();
    const stack = s.stacks.library || [];
    const top = stack[stack.length - 1];
    if (np.kind === 'piece') { if (top?.view === 'piece' && top.props?.id === np.id) go('library'); else push('piece', { id: np.id }, 'library'); }
  };
  return (
    <div class="mini-player" id="mini-player" role="region" aria-label={t('nowPlaying')}>
      <button type="button" class="mp-open" onClick={open} id="mp-open">
        <Cover title={np.title} instrument={np.instrument} keyText={np.keyText} size="xs" />
        <span class="mp-t"><strong>{np.title}</strong><span>{np.playing ? t('nowPlaying') : t('paused')}{np.sub ? ` · ${np.sub}` : ''}</span></span>
      </button>
      <button type="button" class="mp-btn" onClick={() => hooks.player?.toggle()} aria-label={np.playing ? t('pause') : t('listen')} id="mp-toggle"><Icon name={np.playing ? 'pause' : 'play'} size={22} fill={!np.playing} /></button>
      <button type="button" class="mp-btn sm" onClick={() => { if (np.playing) hooks.player?.toggle(); setState({ nowPlaying: null }); }} aria-label={t('close')}><Icon name="close" size={16} stroke={2.4} /></button>
    </div>
  );
}

function SheetHost({ sheet }) {
  const S = SHEETS[sheet.type];
  if (!S) return null;
  return (
    <div class="sheet-bg" onClick={(e) => { if (e.target === e.currentTarget && !S.modal) closeSheet(); }}>
      <Boundary sheet name={sheet.type}><S {...sheet.props} /></Boundary>
    </div>
  );
}

function App() {
  const s = useApp();
  useEffect(() => {
    // Escape closes the open sheet. One listener for the app's lifetime: a listener added by each sheet only
    // started after the sheet had been drawn, so a quick Escape right after it opened was missed.
    const onKey = (e) => { if (e.key === 'Escape' && getState().sheet) closeSheet(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    captureErrors();
    hooks.practice = reportPractice;
    loadAll().then(() => {
      startTracking();
      loadFlags().then(() => setState({ flagsRev: Date.now() }));
      if (!local.get('welcomed', false)) openSheet('welcome');
      if (hasServer()) ensureAccount().then(backFromCheckout);
      openHash();
      // the sheet engraver (2.3 MB) downloads once Home is on screen and the phone is idle, not before
      setTimeout(() => (globalThis.requestIdleCallback || setTimeout)(() => warmVerovio(), { timeout: 5000 }), 2500);
    });
    initNative({ onBack, onResume: () => { if (hasServer()) ensureAccount({ fresh: true }); } });
    addEventListener('hashchange', openHash);
    return () => removeEventListener('hashchange', openHash);
  }, []);
  useEffect(() => { setSyncOffset(s.settings.syncMs || 0); }, [s.settings.syncMs]);
  const visited = useRef(new Set());                    // a tab is built the first time it is opened (faster start)
  const [soundTap, setSoundTap] = useState(null);       // the phone paused the sound and wants a tap to carry on
  useEffect(() => onAudioProblem(setSoundTap), []);
  const shown = s.stacks[s.tab]?.[s.stacks[s.tab].length - 1]?.view || s.tab;
  useEffect(() => { if (s.ready) screenShown(shown); }, [shown, s.ready]);
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
  const immersive = top === 'piece' || top === 'editor' || top === 'studio' || top === 'chordEditor' || top === 'sound';
  const name = (s.me?.name && s.me.name !== 'Musician' ? s.me.name : s.settings.name || '').trim();
  const sec = TABS.find((x) => x.id === s.tab)?.color || 'violet';
  return (
    <div class={`app v3 sec-${sec}${immersive ? ' immersive' : ''}${s.nowPlaying && !immersive ? ' has-mini' : ''}`}>
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
        {TABS.map((tab) => <div class="tab-pane" hidden={s.tab !== tab.id} key={tab.id}>{(visited.current.has(tab.id) || s.tab === tab.id || s.stacks[tab.id].length > 0) && (visited.current.add(tab.id), <Stack tab={tab.id} active={s.tab === tab.id} />)}</div>)}
      </main>
      <nav class="tabbar" aria-label="Sections">{TABS.filter((x) => x.side !== false).map((tab) => tabBtn(tab, 'bar'))}</nav>
      <MiniPlayer s={s} immersive={immersive} />
      {!immersive && !s.sheet && hasServer() && flag('hapi') && <AIFab />}
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
  globalThis.__haptune = { getState, push, go, popToRoot };
}
