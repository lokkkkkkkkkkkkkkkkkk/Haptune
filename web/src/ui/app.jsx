import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { useApp, loadAll, go, pop, push, closeSheet, openSheet, getState, setState, hooks, toast } from './state.js';
import { t } from '../core/i18n.js';
import { Icon } from './components.jsx';
import { HistoryView } from './screens/summary.jsx';
import { HomeView } from './screens/home.jsx';
import { LibraryView, SongbookView, PasteSheet, FindSongSheet, ScaleSheet, ImportReportSheet } from './screens/library.jsx';
import { AddSheet, ImportWizardSheet, FinderSheet } from './screens/addmusic.jsx';
import { WelcomeSheet } from './screens/welcome.jsx';
import { Aurora } from './mascot.jsx';
import { local } from './storage.js';
import { PieceView, ChordSheet, FindKeySheet, ExportSheet, PlayAlongSheet, KeySheet, DetailsSheet } from './screens/piece.jsx';
import { ImproviseView } from './screens/improvise.jsx';
import { AcademyView, CourseView, LessonSheet, ChallengeSheet } from './screens/academy.jsx';
import { ClassView, AssignmentView, JoinClassSheet, NewClassSheet, NewAssignmentSheet, ReviewSheet } from './screens/classes.jsx';
import { ToolsView, ToolView } from './screens/tools.jsx';
import { AccountSheet, PaywallSheet, SetPasswordSheet, SignInSheet, DeleteAccountSheet, DevCodeSheet } from './screens/account.jsx';
import { CommunityView } from './screens/community.jsx';
import { PostView, AcceptSheet, ChangesSheet, AddCreditsSheet, SubmitScoreSheet, ImageSheet } from './screens/post.jsx';
import { ComposeSheet } from './screens/compose.jsx';
import { ProfileView, LeaderboardView, NotificationsView, WalletView, ChallengeView, EditProfileView } from './screens/people.jsx';
import { PlansSheet } from './screens/plans.jsx';
import { HelpView, FeedbackSheet, GuidelinesSheet, AboutSheet, captureErrors } from './screens/help.jsx';
import { AdminView } from './screens/admin.jsx';
import { ReportSheet, MoreSheet } from './screens/social.jsx';
import { hasServer } from './api.js';
import { ensureAccount, C } from './account.js';
import { initNative } from './native.js';
import { setSyncOffset } from './audio.js';

// The Academy (courses, classes, the tutor) is inside Community, as "Learn".
export const TABS = [
  { id: 'summary', icon: 'summary', color: 'pink', label: 'home' },
  { id: 'library', icon: 'library', color: 'blue' },
  { id: 'community', icon: 'users', color: 'purple', label: 'community', center: true },
  { id: 'improvise', icon: 'improvise', color: 'orange' },
  { id: 'tools', icon: 'tools', color: 'teal' },
];
const ROOTS = { summary: HomeView, library: LibraryView, community: CommunityView, improvise: ImproviseView, academy: AcademyView, tools: ToolsView };
const VIEWS = {
  piece: PieceView, songbook: SongbookView, course: CourseView, tool: ToolView, history: HistoryView, classView: ClassView, assignment: AssignmentView,
  post: PostView, profile: ProfileView, leaderboard: LeaderboardView, notifications: NotificationsView, wallet: WalletView, challenge: ChallengeView,
  editProfile: EditProfileView, help: HelpView, admin: AdminView,
};
const SHEETS = {
  add: AddSheet, paste: PasteSheet, findSong: FindSongSheet, scale: ScaleSheet, report: ImportReportSheet, chord: ChordSheet, findKey: FindKeySheet,
  export: ExportSheet, lesson: LessonSheet, challenge: ChallengeSheet, account: AccountSheet, paywall: PaywallSheet,
  importWizard: ImportWizardSheet, finder: FinderSheet, welcome: WelcomeSheet, playAlong: PlayAlongSheet, keySheet: KeySheet, details: DetailsSheet,
  joinClass: JoinClassSheet, newClass: NewClassSheet, newAssignment: NewAssignmentSheet, review: ReviewSheet,
  plans: PlansSheet, compose: ComposeSheet, accept: AcceptSheet, changes: ChangesSheet, addCredits: AddCreditsSheet, submitScore: SubmitScoreSheet,
  image: ImageSheet, reportPost: ReportSheet, more: MoreSheet, feedback: FeedbackSheet, guidelines: GuidelinesSheet, about: AboutSheet,
  setPassword: SetPasswordSheet, signIn: SignInSheet, deleteAccount: DeleteAccountSheet, devCode: DevCodeSheet,
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

/** Links like …/#post/<id> (shared from the community) open that post. */
function openHash() {
  const h = location.hash.replace('#', '');
  const m = /^post\/([0-9a-f]{6,16})$/.exec(h);
  if (m) { go('community'); push('post', { id: m[1] }, 'community'); return; }
  const u = /^u\/([a-z0-9_.]{3,20})$/.exec(h);
  if (u) { go('community'); push('profile', { handle: u[1] }, 'community'); return; }
  if (TABS.some((x) => x.id === h)) go(h);
}

function Stack({ tab, active }) {
  const s = useApp();
  const stack = s.stacks[tab];
  const Root = ROOTS[tab];
  return (
    <>
      <div class="view" hidden={stack.length > 0}><Root active={active && stack.length === 0} /></div>
      {stack.map((v, i) => {
        const V = VIEWS[v.view];
        return <div class="view pushed" hidden={i !== stack.length - 1} key={v.key}><V {...v.props} active={active && i === stack.length - 1} /></div>;
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
      if (hasServer()) ensureAccount();
      openHash();
    });
    initNative({ onBack, onResume: () => { if (hasServer()) ensureAccount({ fresh: true }); } });
    addEventListener('hashchange', openHash);
    return () => removeEventListener('hashchange', openHash);
  }, []);
  useEffect(() => { setSyncOffset(s.settings.syncMs || 0); }, [s.settings.syncMs]);
  if (!s.ready) return <div class="splash"><div class="spinner" /></div>;
  const tabBtn = (tab, cls) => (
    <button type="button" key={tab.id} class={`c-${tab.color}${s.tab === tab.id ? ' on' : ''}${tab.center ? ' center' : ''}`} onClick={() => {
      if (s.tab === tab.id && s.stacks[tab.id].length) pop(tab.id);
      go(tab.id);
    }} aria-current={s.tab === tab.id ? 'page' : undefined}>
      <span class="tab-ic"><Icon name={tab.icon} size={cls === 'side' ? 22 : 25} stroke={s.tab === tab.id ? 2.3 : 1.9} />
        {tab.id === 'community' && s.me?.unread > 0 && <span class="tab-dot" />}</span>
      <span>{t(tab.label || tab.id)}</span>
    </button>
  );
  return (
    <>
    <Aurora tab={s.tab} />
    <div class="app">
      <nav class="sidebar" aria-label="Sections">
        <h1>Haptune</h1>
        {TABS.map((tab) => tabBtn(tab, 'side'))}
        <div class="side-foot">
          <button type="button" onClick={() => { go(s.tab); push('help'); }}><Icon name="quiz" size={22} /> <span>{t('help')}</span></button>
          <button type="button" onClick={() => openSheet('account')}><Icon name="person" size={22} /> <span>{t('account')}</span></button>
        </div>
      </nav>
      <main class="content">
        {TABS.map((tab) => <div class="tab-pane" hidden={s.tab !== tab.id} key={tab.id}><Stack tab={tab.id} active={s.tab === tab.id} /></div>)}
      </main>
      <nav class="tabbar" aria-label="Sections">{TABS.map((tab) => tabBtn(tab, 'bar'))}</nav>
      {s.sheet && <SheetHost sheet={s.sheet} />}
      {s.toast && <div class={`toast${s.toast.kind === 'err' ? ' err' : ''}`} role="status"><Icon name={s.toast.kind === 'err' ? 'info' : 'check'} size={18} stroke={2.4} />{s.toast.text}</div>}
    </div>
    </>
  );
}

export function mount() {
  let root = document.getElementById('haptune');
  if (!root) { root = document.createElement('div'); root.id = 'haptune'; document.body.appendChild(root); }
  root.style.height = '100%';
  render(<App />, root);
  globalThis.__haptune = { getState };
}
