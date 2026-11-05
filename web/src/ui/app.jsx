import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { useApp, loadAll, go, pop, closeSheet, openSheet, getState } from './state.js';
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
import { ToolsView, ToolView } from './screens/tools.jsx';
import { AccountSheet, PaywallSheet } from './screens/account.jsx';

export const TABS = [
  { id: 'summary', icon: 'summary', color: 'pink', label: 'home' },
  { id: 'library', icon: 'library', color: 'blue' },
  { id: 'improvise', icon: 'improvise', color: 'purple' },
  { id: 'academy', icon: 'academy', color: 'orange' },
  { id: 'tools', icon: 'tools', color: 'teal' },
];
const ROOTS = { summary: HomeView, library: LibraryView, improvise: ImproviseView, academy: AcademyView, tools: ToolsView };
const VIEWS = { piece: PieceView, songbook: SongbookView, course: CourseView, tool: ToolView, history: HistoryView };
const SHEETS = {
  add: AddSheet, paste: PasteSheet, findSong: FindSongSheet, scale: ScaleSheet, report: ImportReportSheet, chord: ChordSheet, findKey: FindKeySheet,
  export: ExportSheet, lesson: LessonSheet, challenge: ChallengeSheet, account: AccountSheet, paywall: PaywallSheet,
  importWizard: ImportWizardSheet, finder: FinderSheet, welcome: WelcomeSheet, playAlong: PlayAlongSheet, keySheet: KeySheet, details: DetailsSheet,
};

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
    loadAll().then(() => { if (!local.get('welcomed', false)) openSheet('welcome'); });
    const onHash = () => {
      const h = location.hash.replace('#', '');
      if (TABS.some((x) => x.id === h)) go(h);
    };
    addEventListener('hashchange', onHash);
    onHash();
    return () => removeEventListener('hashchange', onHash);
  }, []);
  if (!s.ready) return <div class="splash"><div class="spinner" /></div>;
  const tabBtn = (tab, cls) => (
    <button type="button" key={tab.id} class={`c-${tab.color}${s.tab === tab.id ? ' on' : ''}`} onClick={() => {
      if (s.tab === tab.id && s.stacks[tab.id].length) pop(tab.id);
      go(tab.id);
    }} aria-current={s.tab === tab.id ? 'page' : undefined}>
      <Icon name={tab.icon} size={cls === 'side' ? 22 : 25} stroke={s.tab === tab.id ? 2.3 : 1.9} />
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
