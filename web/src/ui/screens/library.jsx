import { Fragment } from 'preact';
import { useState, useRef, useMemo, useEffect } from 'preact/hooks';
import { useApp, push, go, openSheet, closeSheet, toast, addSongbookSong, addScore, getState, updatePiece, deletePiece } from '../state.js';
import { local } from '../storage.js';
import { t, getLang, instrumentName, INSTRUMENTS } from '../../core/i18n.js';
import { Icon, Badge, List, Row, Chip, Button, Card, Section, Stars, Empty, Segmented } from '../components.jsx';
import { Cover } from '../cover.jsx';
import { LargeTitle, NavBar, SheetFrame, Avatar } from './common.jsx';
import { Mascot } from '../mascot.jsx';
import { importFile, importText, ACCEPT } from '../importer.js';
import { SONGS, songTitle } from '../../data/songs.js';
import { loadCatalog, searchCatalog, addCatalogPiece, GENRES, catalogSources } from '../catalog.js';
import { parseJianpu, isJianpu } from '../../core/jianpu.js';
import { parseChordSheet, sheetChords } from '../../core/chordsheet.js';
import { keyName, parseName, nameOf } from '../../core/pitch.js';
import { scaleScore } from '../../core/exercises.js';

const FILTERS = [
  { id: 'all', label: 'allPieces' }, { id: 'favourite', label: 'favourites' }, { id: 'written', label: 'mySongs' }, { id: 'import', label: 'imported' },
  { id: 'sheet', label: 'chordSheets' }, { id: 'improv', label: 'improvisations' }, { id: 'songbook', label: 'sampleSongs' }, { id: 'catalog', label: 'freeLibrary' },
];
const matches = (p, f) => (f === 'all' ? true : f === 'favourite' ? p.favorite : f === 'songbook' ? p.source === 'songbook' : f === 'import' ? p.source === 'import' && !p.edited
  : f === 'written' ? p.source === 'written' || !!p.edited : f === 'sheet' ? p.kind === 'sheet' || (p.kind === 'pdf' && p.key) : f === 'improv' ? p.source === 'improv' : f === 'catalog' ? p.source === 'catalog' : true);

export function pieceIcon(p) {
  if (p.kind === 'sheet') return ['chords', 'green'];
  if (p.kind === 'pdf') return ['doc', 'red'];
  if (p.source === 'improv') return ['sparkles', 'purple'];
  if (p.source === 'exercise') return ['stairs', 'teal'];
  if (p.source === 'songbook') return ['library', 'pink'];
  return ['library', 'blue'];
}

function PieceRow({ p }) {
  const [icon, color] = pieceIcon(p);
  const kind = p.kind === 'sheet' ? t('chordSheets') : p.kind === 'pdf' ? 'PDF' : p.fmt === 'midi' ? 'MIDI' : p.source === 'songbook' ? t('songbook') : p.source === 'improv' ? t('improvise') : 'MusicXML';
  return (
    <Row icon={icon} color={color} title={p.title} subtitle={[p.composer, p.keyText, kind].filter(Boolean).join(' · ')}
      right={<span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>{p.favorite && <span class="t-yellow"><Icon name="star" size={14} fill stroke={1.5} /></span>}{p.best !== null && p.best !== undefined && <span class="row-detail num">{p.best}%</span>}</span>}
      onClick={() => push('piece', { id: p.id }, 'library')} />
  );
}
void PieceRow;

/** A score in the library: what it is, how you did, and Play Along straight away. */
function PieceCard({ p, picking, picked, onPick }) {
  const [icon, color] = pieceIcon(p);
  const kind = p.kind === 'sheet' ? t('chordSheets') : p.kind === 'pdf' ? 'PDF' : p.source === 'written' ? t('write') : p.source === 'songbook' ? t('songbook') : p.source === 'improv' ? t('improvise') : p.fmt === 'midi' ? 'MIDI' : t('score');
  return (
    <div class={`lib-card c-${color}${picking ? ' picking' : ''}${picked ? ' picked' : ''}`} data-id={p.id}>
      <button type="button" class="lc-main" onClick={() => (picking ? onPick(p.id) : push('piece', { id: p.id }, 'library'))} aria-pressed={picking ? !!picked : undefined}>
        {picking && <span class={`lc-check${picked ? ' on' : ''}`} aria-hidden="true">{picked && <Icon name="check" size={14} stroke={3} />}</span>}
        <Cover title={p.title} instrument={p.instrument} keyText={p.keyText} genre={(p.tags || [])[0]} size="sm" icon={p.kind === 'score' ? null : icon} />
        <span class="lc-txt"><strong>{p.title}</strong><span class="tiny">{[p.composer, p.keyText].filter(Boolean).join(' · ') || kind}</span></span>
        {p.favorite && <span class="t-yellow lc-star"><Icon name="star" size={14} fill stroke={1.5} /></span>}
      </button>
      <div class="lc-foot">
        <span class="pill3">{kind}</span>
        {p.folder && <span class="pill3 folder"><Icon name="folder" size={11} stroke={2.4} />{p.folder}</span>}
        {p.measures ? <span class="tiny">{t('barsN', { n: p.measures })}</span> : null}
        <span class="spacer" />
        {p.best !== null && p.best !== undefined && <span class={`lc-best ${p.best >= 85 ? 'good' : p.best >= 60 ? 'mid' : 'low'}`}>{p.best}%</span>}
        {p.kind === 'score' && !picking && <button type="button" class="lc-play" onClick={() => push('piece', { id: p.id, start: 'playAlong' }, 'library')} aria-label={t('playAlong')}><Icon name="mic" size={16} stroke={2.4} /></button>}
      </div>
    </div>
  );
}

/* the reader's own folders: a folder is a name on each piece (rec.folder); empty folders are kept in local storage */
export function folderList(pieces) {
  const names = new Set(local.get('folders', []));
  for (const p of pieces) if (p.folder) names.add(p.folder);
  return [...names].sort((a, b) => a.localeCompare(b));
}
function keepFolders(list) { local.set('folders', [...new Set(list)].filter(Boolean)); }
export async function movePieces(ids, folder) {
  for (const id of ids) await updatePiece(id, { folder: folder || undefined });
  if (folder) keepFolders([...local.get('folders', []), folder]);
}
export async function renameFolder(from, to, pieces) {
  to = to.trim();
  if (!to || to === from) return;
  for (const p of pieces) if (p.folder === from) await updatePiece(p.id, { folder: to });
  keepFolders(local.get('folders', []).map((f) => (f === from ? to : f)).concat(to));
}
export async function removeFolder(name, pieces) {
  for (const p of pieces) if (p.folder === name) await updatePiece(p.id, { folder: undefined });
  keepFolders(local.get('folders', []).filter((f) => f !== name));
}

export function LibraryView() {
  const s = useApp();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [folder, setFolder] = useState('');
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState(() => new Set());
  const [sure, setSure] = useState(false);
  const folders = useMemo(() => folderList(s.pieces), [s.pieces, s.sheet]);
  useEffect(() => { if (folder && !folders.includes(folder)) setFolder(''); }, [folders, folder]);
  useEffect(() => { setSure(false); }, [picked, picking]);
  const pick = (id) => setPicked((x) => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const stopPicking = () => { setPicking(false); setPicked(new Set()); };
  const ids = [...picked].filter((id) => s.pieces.some((p) => p.id === id));
  const del = async () => {
    if (!sure) { setSure(true); return; }
    for (const id of ids) await deletePiece(id);
    toast(t('libDeleted', { n: ids.length }));
    stopPicking();
  };
  const fav = async () => {
    const all = ids.every((id) => s.pieces.find((p) => p.id === id)?.favorite);
    for (const id of ids) await updatePiece(id, { favorite: !all });
  };
  const [count, setCount] = useState(null);
  useEffect(() => { loadCatalog().then((r) => setCount(r.length)).catch(() => {}); }, []);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, s.pieces.filter((p) => matches(p, f.id)).length])), [s.pieces]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return s.pieces.filter((p) => matches(p, filter) && (!folder || p.folder === folder) && (!needle || `${p.title} ${p.composer} ${p.keyText} ${p.instrument} ${p.folder || ''}`.toLowerCase().includes(needle)));
  }, [s.pieces, q, filter, folder]);
  const recent = !q && filter === 'all' && !folder && !picking ? [...s.pieces].filter((p) => p.opened).sort((a, b) => b.opened - a.opened).slice(0, 4) : [];
  return (
    <div class={`scroll${picking ? ' lib-picking' : ''}`} id="library">
      <div class="wrap">
        <LargeTitle title={t('library')} eyebrow={t('libEyebrow')} hapi="listen" color="blue" actions={<>{s.pieces.length > 0 && <button type="button" class={`btn small ${picking ? 'brand' : 'secondary'}`} onClick={() => (picking ? stopPicking() : setPicking(true))} id="lib-select">{picking ? t('done') : t('libSelect')}</button>}<button type="button" class="btn brand small" onClick={() => openSheet('add')} id="lib-add"><Icon name="plus" size={18} stroke={2.6} />{t('add')}</button><span class="ph-only"><Avatar /></span></>} />
        <div class="acts three stagger" id="lib-doors">
          <button type="button" class="act c-blue" onClick={() => document.getElementById('lib-search')?.focus()}><span class="ic"><Icon name="library" size={22} stroke={2.2} /></span><strong>{t('myScores')}</strong><span>{t('piecesCount', { n: s.pieces.length })}</span></button>
          <button type="button" class="act c-violet" id="lib-free" onClick={() => push('catalog')}><span class="ic"><Icon name="books" size={22} stroke={2.2} /></span><strong>{t('freeLibrary')}</strong><span>{count ? t('freeLibraryN', { n: count.toLocaleString() }) : t('freeLibrarySub')}</span></button>
          <button type="button" class="act c-pink" onClick={() => push('songbook', {}, 'library')}><span class="ic"><Icon name="book" size={22} stroke={2.2} /></span><strong>{t('browseSongbook')}</strong><span>{t('browseSongbookSub', { n: SONGS.length })}</span></button>
        </div>
        <label class="search3" for="lib-search"><Icon name="search" size={18} stroke={2.3} /><input id="lib-search" type="search" placeholder={t('searchPrompt')} value={q} onInput={(e) => setQ(e.currentTarget.value)} /></label>
        <div class="ptabs hscroll" id="lib-filters">{FILTERS.filter((f) => f.id === 'all' || counts[f.id]).map((f) => <button type="button" key={f.id} class={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>{t(f.label)}<span class="n">{counts[f.id]}</span></button>)}</div>
        <div class="lib-folders hscroll" id="lib-folders">
          <span class="lf-lbl"><Icon name="folder" size={15} stroke={2.3} />{t('libFolders')}</span>
          {folders.map((f) => <button type="button" key={f} class={`chip${folder === f ? ' on' : ''}`} onClick={() => setFolder(folder === f ? '' : f)} id={`lib-folder-${folders.indexOf(f)}`}>{f}<span class="n">{s.pieces.filter((p) => p.folder === f).length}</span></button>)}
          <button type="button" class="chip add" onClick={() => openSheet('libFolder', { ids: picking ? ids : [] })} id="lib-new-folder"><Icon name="plus" size={14} stroke={2.6} />{t('libNewFolder')}</button>
          {folder && <button type="button" class="chip ghost" onClick={() => openSheet('libFolder', { rename: folder })} id="lib-folder-edit"><Icon name="pencil" size={13} stroke={2.4} />{t('libEditFolder')}</button>}
        </div>
        {recent.length > 0 && (
          <section class="sec3">
            <div class="section-head"><h2>{t('recentlyPractised')}</h2></div>
            <div class="grid3">{recent.map((p) => <PieceCard key={'r' + p.id} p={p} />)}</div>
          </section>
        )}
        <section class="sec3">
          <div class="section-head"><h2>{folder || t(FILTERS.find((f) => f.id === filter).label)}</h2><span class="tiny">{list.length ? t('piecesCount', { n: list.length }) : ''}</span>
            {picking && list.length > 0 && <button type="button" class="link-btn" id="lib-all" onClick={() => setPicked(list.every((p) => picked.has(p.id)) ? new Set() : new Set(list.map((p) => p.id)))}>{list.every((p) => picked.has(p.id)) ? t('libNone') : t('libAll')}</button>}</div>
          {!picking && list.length > 0 && <p class="tiny muted lib-tip">{t('libManageTip')}</p>}
          {list.length ? <div class="grid3" id="lib-list">{list.map((p) => <PieceCard key={p.id} p={p} picking={picking} picked={picked.has(p.id)} onPick={pick} />)}</div>
            : folder && !q ? <Empty icon="folder" title={t('libFolderEmpty')} sub={t('libFolderEmptySub')}><Button kind="secondary" onClick={() => { setFolder(''); setPicking(true); }}>{t('libSelect')}</Button></Empty>
            : q ? <Empty icon="search" title={t('noResults', { q })} sub={t('emptyFindSub')}><Button kind="brand" icon="search" onClick={() => push('find', { q }, 'summary')}>{t('findSongs')}</Button></Empty>
              : <Empty icon="library" title={t('emptyLibrary')} sub={t('emptyLibrarySub')}><Button onClick={() => openSheet('add')} icon="plus">{t('add')}</Button></Empty>}
        </section>
      </div>
      {picking && (
        <div class="lib-bar" id="lib-bar" role="toolbar" aria-label={t('libSelect')}>
          <span class="lb-n">{t('libPicked', { n: ids.length })}</span>
          <button type="button" class="lb-b" disabled={!ids.length} onClick={fav} id="lib-fav"><Icon name="star" size={19} stroke={2.2} /><span>{t('favourites')}</span></button>
          <button type="button" class="lb-b" disabled={!ids.length} onClick={() => openSheet('libFolder', { ids })} id="lib-move"><Icon name="folder" size={19} stroke={2.2} /><span>{t('libMove')}</span></button>
          <button type="button" class={`lb-b danger${sure ? ' sure' : ''}`} disabled={!ids.length} onClick={del} id="lib-delete"><Icon name="trash" size={19} stroke={2.2} /><span>{sure ? t('libSure', { n: ids.length }) : t('delete')}</span></button>
        </div>
      )}
    </div>
  );
}

/** Put pieces in a folder (an existing one, a new one or none), or rename / remove a folder. */
export function FolderSheet({ ids = [], rename = '' }) {
  const s = useApp();
  const folders = folderList(s.pieces);
  const [name, setName] = useState(rename);
  const into = async (f) => {
    if (ids.length) { await movePieces(ids, f); toast(f ? t('libMoved', { n: ids.length, f }) : t('libUnfiled', { n: ids.length })); }
    else if (f) { keepFolders([...local.get('folders', []), f]); toast(t('libFolderMade', { f })); }
    closeSheet();
  };
  if (rename) {
    const n = s.pieces.filter((p) => p.folder === rename).length;
    return (
      <SheetFrame title={t('libEditFolder')} right={t('save')} onRight={async () => { await renameFolder(rename, name, s.pieces); closeSheet(); }} rightDisabled={!name.trim() || name.trim() === rename}>
        <input class="field" id="folder-name" value={name} maxLength={40} onInput={(e) => setName(e.currentTarget.value)} />
        <List><Row icon="trash" color="red" danger title={t('libRemoveFolder')} subtitle={t('libRemoveFolderSub', { n })} onClick={async () => { await removeFolder(rename, s.pieces); closeSheet(); }} id="folder-remove" /></List>
      </SheetFrame>
    );
  }
  const fresh = name.trim();
  return (
    <SheetFrame title={ids.length ? t('libMoveN', { n: ids.length }) : t('libNewFolder')}>
      <div class="folder-new">
        <input class="field" id="folder-name" placeholder={t('libFolderPh')} value={name} maxLength={40} onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && fresh) into(fresh); }} />
        <Button onClick={() => into(fresh)} disabled={!fresh} id="folder-make">{ids.length ? t('libMakeMove') : t('libMake')}</Button>
      </div>
      {ids.length > 0 && (
        <List>
          {folders.map((f) => <Row key={f} icon="folder" color="blue" title={f} subtitle={t('piecesCount', { n: s.pieces.filter((p) => p.folder === f).length })} onClick={() => into(f)} id={`folder-to-${folders.indexOf(f)}`} />)}
          <Row icon="close" color="gray" title={t('libNoFolder')} onClick={() => into('')} id="folder-none" />
        </List>
      )}
    </SheetFrame>
  );
}

export function AddSheet() {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const onFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const { piece, report } = await importFile(file);
      openSheet('report', { pieceId: piece.id, report });
    } catch (err) {
      setBusy(false);
      openSheet('report', { error: err.message || String(err), name: file.name });
    }
  };
  return (
    <SheetFrame title={t('add')}>
      <input ref={fileRef} type="file" class="hidden-input" accept={ACCEPT} onChange={onFile} id="file-input" aria-label={t('importFile')} />
      {busy && <div class="loading"><div class="spinner" />{t('importing')}</div>}
      <List>
        <Row icon="book" color="pink" title={t('browseSongbook')} subtitle={t('browseSongbookSub', { n: SONGS.length })} onClick={() => { closeSheet(); push('songbook', {}, 'library'); }} />
        <Row icon="folder" color="blue" title={t('importFile')} subtitle={t('importFileSub')} onClick={() => fileRef.current?.click()} id="import-row" />
        <Row icon="paste" color="green" title={t('pasteChords')} subtitle={t('pasteChordsSub')} onClick={() => openSheet('paste')} />
        <Row icon="globe" color="orange" title={t('findSong')} subtitle={t('findSongSub')} onClick={() => openSheet('findSong')} />
        <Row icon="stairs" color="teal" title={t('scaleExercise')} subtitle={t('scaleExerciseSub')} onClick={() => openSheet('scale')} />
      </List>
      <p class="note-text">{t('wifiOnlyHelp')}</p>
    </SheetFrame>
  );
}

export function ImportReportSheet({ pieceId, report, error, name }) {
  if (error) {
    return (
      <SheetFrame title={t('importFailed')}>
        <Card><div class="report-line"><span class="t-red"><Icon name="info" size={22} /></span><div><strong>{name}</strong><p class="sub" style={{ marginTop: 4 }}>{error}</p></div></div></Card>
        <Button kind="secondary" onClick={() => openSheet('findSong')} icon="globe" full>{t('findSong')}</Button>
      </SheetFrame>
    );
  }
  const r = report || {};
  const lines = [];
  if (r.exact || (r.format !== 'MIDI' && r.format !== 'PDF')) lines.push(['check', 'green', t('importExact')]);
  if (r.format === 'MIDI' && r.moved) lines.push(['info', 'orange', t('importAligned', { n: r.moved, ms: r.maxMoveMs })]);
  if (r.format === 'MIDI' && r.exact) lines.push(['check', 'green', t('importExact')]);
  if (r.keyFromFile === false || r.keyEstimated) lines.push(['key', 'blue', t('importKeyEstimated')]);
  if (r.drumNotes) lines.push(['info', 'gray', t('importDrums', { n: r.drumNotes })]);
  if (r.format === 'PDF') lines.push(r.pdfNoText ? ['info', 'orange', t('importPdfNoText')] : ['check', 'green', t('importPdfChords', { n: r.pdfChords, l: r.pdfLyrics })]);
  const kv = [
    [t('importDone', { ms: r.ms }), r.format],
    r.notes !== undefined && ['♪', r.notes], r.measures && [t('bars'), r.measures], r.parts && ['Parts', r.parts], r.chordSymbols !== undefined && [t('viewChords'), r.chordSymbols],
    r.lyrics && [t('viewLyrics'), r.lyrics], r.pages && ['PDF', t('pages', { n: r.pages })],
  ].filter(Boolean);
  const unique = [...new Set(lines.map((l) => l[2]))].map((txt) => lines.find((l) => l[2] === txt));
  return (
    <SheetFrame title={t('added')} right={t('done')} onRight={() => { closeSheet(); push('piece', { id: pieceId }, 'library'); }}>
      <Card>
        <div class="report-line"><Badge icon="check" color="green" size={34} /><div><strong>{r.name}</strong><p class="sub">{(r.size / 1024).toFixed(1)} KB</p></div></div>
        <dl class="kv">{kv.map(([k, v], i) => <Fragment key={i}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
      </Card>
      <List>{unique.map(([ic, c, txt], i) => <Row key={i} icon={ic} color={c} title={<span style={{ whiteSpace: 'normal' }}>{txt}</span>} />)}</List>
      <Button onClick={() => { closeSheet(); push('piece', { id: pieceId }, 'library'); }} full>{t('continue')}</Button>
    </SheetFrame>
  );
}

const JIANPU_EXAMPLE = 'title: 茉莉花\nkey: 1=F\ntime: 2/4\ntempo: 72\n---\n3 3_ 5_ | 6_ 1\'_ 1\'_ 6_ | 5 5_ 6_ | 5 - |\nw: 好 一 朵 美 丽 的 茉 莉 花\n5 5_ 6_ | 1\' 1\'_ 6_ | 5 5_ 6_ | 5 - ||\nw: 好 一 朵 美 丽 的 茉 莉 花';

export function PasteSheet({ initial = '' }) {
  const [text, setText] = useState(initial);
  const preview = useMemo(() => {
    if (!text.trim()) return null;
    if (/^X:\s*\d/m.test(text) && /^K:/m.test(text)) return 'ABC';
    if (isJianpu(text)) { try { const sc = parseJianpu(text); return `簡譜 · ${sc.measures.length} ${t('bars').toLowerCase()}`; } catch (e) { return null; } }
    try { const s = parseChordSheet(text); const n = sheetChords(s).length; return n ? t('detected', { n, key: keyName(s.key) }) : null; } catch { return null; }
  }, [text]);
  const add = async () => {
    try {
      const { piece, report } = await importText(text, { title: '' });
      report.name = piece.title; report.size = text.length;
      openSheet('report', { pieceId: piece.id, report });
    } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <SheetFrame title={t('wayType')} right={t('add')} onRight={add} rightDisabled={!preview} full>
      <p class="note-text">{t('typeItSub')}</p>
      <div class="chips">
        <Chip onClick={() => setText(JIANPU_EXAMPLE)} >簡譜 {t('example')}</Chip>
        <Chip onClick={() => setText('{title: Amazing Grace}\n{key: G}\nA[G]mazing [G7]grace, how [C]sweet the [G]sound\nThat saved a wretch like [D]me')}>{t('viewChords')} {t('example')}</Chip>
        <Chip onClick={() => setText('X:1\nT:Ode to Joy\nM:4/4\nL:1/4\nK:D\nF F G A|A G F E|D D E F|F3/2 E/2 E2|]')}>ABC {t('example')}</Chip>
      </div>
      <textarea class="field" id="paste-text" placeholder={`${t('pasteHere')}\n\nG            G7         C         G\nAmazing grace, how sweet the sound`} value={text} onInput={(e) => setText(e.currentTarget.value)} onPaste={(e) => { const v = e.clipboardData?.getData('text'); if (v) { e.preventDefault(); setText((x) => x + v); } }} />
      {preview && <div class="report-line"><span class="t-green"><Icon name="check" size={20} stroke={2.4} /></span><strong>{preview}</strong></div>}
      <Button onClick={add} disabled={!preview} full>{t('addToLibrary')}</Button>
      {text.trim() && !/^X:\s*\d/m.test(text) && !isJianpu(text) && (
        <Button kind="secondary" icon="chords" full id="paste-edit-chords" onClick={() => { closeSheet(); push('chordEditor', { text, fresh: true }, 'write'); go('write'); }}>{t('ceEditChords')}</Button>
      )}
    </SheetFrame>
  );
}

export const SITES = [
  { name: 'Ultimate Guitar', kind: 'siteChords', url: (q) => `https://www.ultimate-guitar.com/search.php?search_type=title&value=${q}`, color: 'orange' },
  { name: 'Chordify', kind: 'siteChords', url: (q) => `https://chordify.net/search/${q}`, color: 'green' },
  { name: 'MuseScore', kind: 'siteSheet', url: (q) => `https://musescore.com/sheetmusic?text=${q}`, color: 'blue' },
  { name: 'IMSLP', kind: 'siteFree', url: (q) => `https://imslp.org/index.php?title=Special:Search&search=${q}`, color: 'brown' },
  { name: 'Google', kind: 'siteChords', url: (q) => `https://www.google.com/search?q=${q}+chords+lyrics`, color: 'indigo' },
  { name: 'YouTube', kind: 'siteVideo', url: (q) => `https://www.youtube.com/results?search_query=${q}+tutorial`, color: 'red' },
];

export function FindSongSheet() {
  const [q, setQ] = useState('');
  const enc = encodeURIComponent(q.trim());
  return (
    <SheetFrame title={t('findSong')}>
      <p class="note-text">{t('findSongHelp')}</p>
      <label class="search" for="song-q"><Icon name="search" size={18} /><input id="song-q" type="search" placeholder={t('songName')} value={q} onInput={(e) => setQ(e.currentTarget.value)} /></label>
      <List>
        {SITES.map((site) => (
          <a key={site.name} class="row" href={q.trim() ? site.url(enc) : site.url('')} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
            <Badge icon="globe" color={site.color} size={30} />
            <span class="row-main"><span class="row-title">{site.name}</span><span class="row-sub">{t(site.kind)}</span></span>
            <Icon name="share" size={16} style={{ opacity: 0.4 }} />
          </a>
        ))}
      </List>
      <div class="btn-row">
        <Button icon="paste" onClick={() => openSheet('paste')} color="green">{t('pasteChords')}</Button>
        <Button icon="folder" kind="secondary" onClick={() => openSheet('add')}>{t('importFile')}</Button>
      </div>
    </SheetFrame>
  );
}

export function SongbookView() {
  const s = useApp();
  const lang = getLang();
  const open = async (song) => {
    const rec = await addSongbookSong(song.id, { silent: true });
    if (rec) push('piece', { id: rec.id }, 'library');
  };
  return (
    <div class="scroll">
      <NavBar title={t('browseSongbook')} backLabel={t('library')} />
      <div class="wrap" style={{ paddingTop: 16 }}>
        <List>
          {SONGS.map((song) => {
            const have = s.pieces.some((p) => p.songId === song.id);
            const composer = /C:(.*)/.exec(song.abc)?.[1]?.trim() || '';
            return (
              <Row key={song.id} icon={song.tags.includes('christmas') ? 'star' : song.tags.includes('classical') ? 'staff' : song.tags.includes('chinese') ? 'globe' : 'library'}
                color={['pink', 'orange', 'green', 'blue', 'purple', 'teal'][song.level * 2 % 6]} title={songTitle(song, lang)} subtitle={composer}
                right={<span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Stars n={song.level + 1} max={4} />{have && <span class="t-green"><Icon name="check" size={16} stroke={2.6} /></span>}</span>}
                onClick={() => open(song)} />
            );
          })}
        </List>
        <p class="section-foot">{t('licences').split('. ').slice(-1)[0]}</p>
      </div>
    </div>
  );
}

const TONICS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'F', 'Bb', 'Eb', 'Ab', 'Db'];
export function ScaleSheet() {
  const s = getState();
  const [tonic, setTonic] = useState('G');
  const [type, setType] = useState('major');
  const [oct, setOct] = useState(1);
  const [inst, setInst] = useState(s.settings.instrument);
  const add = async () => {
    const score = scaleScore({ tonic: parseName(tonic), type, octaves: oct, instrument: inst });
    score.title = `${nameOf(parseName(tonic))} ${t(type === 'arpeggio' ? 'arpeggio' : type)}`;
    const rec = await addScore(score, { source: 'exercise', fmt: 'generated' });
    closeSheet();
    push('piece', { id: rec.id }, 'library');
  };
  const types = ['major', 'minor', 'harmonicMinor', 'majorPent', 'minorPent', 'blues', 'arpeggio'];
  return (
    <SheetFrame title={t('scaleExercise')} right={t('add')} onRight={add}>
      <Section title={t('key')}><div class="chips wrap">{TONICS.map((x) => <Chip key={x} on={tonic === x} color="teal" onClick={() => setTonic(x)}>{nameOf(parseName(x))}</Chip>)}</div></Section>
      <Section title={t('scaleKind')}><div class="chips wrap">{types.map((x) => <Chip key={x} on={type === x} color="teal" onClick={() => setType(x)}>{t(x)}</Chip>)}</div></Section>
      <Section title={t('octaves')}><Segmented value={oct} onChange={setOct} options={[{ value: 1, label: '1' }, { value: 2, label: '2' }]} /></Section>
      <List><Row title={t('instrument')} right={<select id="scale-inst" value={inst} onChange={(e) => setInst(e.currentTarget.value)}>{INSTRUMENTS.filter((k) => k !== 'drums').map((k) => <option key={k} value={k}>{instrumentName(k)}</option>)}</select>} /></List>
      <Button onClick={add} color="teal" full>{t('addToLibrary')}</Button>
    </SheetFrame>
  );
}


// ---------------------------------------------------------------------------- the free library
const GENRE_ICON = { classical: 'staff', piano: 'piano', folk: 'guitar', song: 'mic', hymn: 'book', kids: 'star', christmas: 'star', jazz: 'sparkles', chinese: 'globe', celtic: 'violin', choral: 'users', dance: 'metronome', chamber: 'violin' };

/** Every piece of the free library: search, filter by kind of music, tap to add and open. */
export function CatalogView({ genre: genre0 = '' }) {
  const s = useApp();
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [genre, setGenre] = useState(genre0);
  const [busy, setBusy] = useState(null);
  const [shown, setShown] = useState(60);
  useEffect(() => { loadCatalog().then(setList); }, []);
  useEffect(() => { setShown(60); }, [q, genre]);
  const genres = useMemo(() => (list ? GENRES.filter((g) => list.some((r) => r.genre === g)) : []), [list]);
  const found = useMemo(() => (list ? searchCatalog(list, q, { limit: 5000, genre }) : []), [list, q, genre]);
  const have = new Set(s.pieces.map((p) => p.catalogId || (p.songId && `song:${p.songId}`)));
  const open = async (r) => {
    setBusy(r.id);
    try { const rec = await addCatalogPiece(r); if (rec) push('piece', { id: rec.id }, 'library'); } catch (e) { toast(e.message || String(e), 'err'); }
    setBusy(null);
  };
  return (
    <div class="scroll">
      <NavBar title={t('freeLibrary')} backLabel={t('library')} />
      <div class="wrap" style={{ paddingTop: 12 }}>
        <label class="search" for="cat-search"><Icon name="search" size={18} /><input id="cat-search" type="search" placeholder={t('homeSearchPh')} value={q} onInput={(e) => setQ(e.currentTarget.value)} /></label>
        <div class="chips">
          <Chip on={!genre} onClick={() => setGenre('')}>{t('genre_all')}</Chip>
          {genres.map((g) => <Chip key={g} on={genre === g} onClick={() => setGenre(g)}>{t(`genre_${g}`)}</Chip>)}
        </div>
        {!list ? <div class="loading"><div class="spinner" /></div>
          : found.length ? (
            <List>
              {found.slice(0, shown).map((r) => (
                <Row key={r.id} icon={GENRE_ICON[r.genre] || 'library'} color="violet" title={r.title} subtitle={[r.composer, t(`genre_${r.genre}`)].filter(Boolean).join(' · ')}
                  right={busy === r.id ? <div class="spinner small" /> : have.has(r.id) ? <span class="t-green"><Icon name="check" size={17} stroke={2.6} /></span> : <span class="t-violet"><Icon name="download" size={17} stroke={2.2} /></span>}
                  onClick={() => open(r)} />
              ))}
            </List>
          ) : <Empty icon="search" title={t('noResults', { q })} />}
        {found.length > shown && <Button kind="secondary" full onClick={() => setShown(shown + 120)}>{t('loadMore')}</Button>}
        <p class="section-foot">{t('freeLibraryNote', { n: list?.length || 0 })}</p>
        {list && catalogSources().length > 0 && <details class="cat-sources" id="cat-sources">
          <summary>{t('catSources')}</summary>
          <p class="tiny muted">{t('catSourcesSub')}</p>
          <ul>{catalogSources().map((x) => <li key={x.key}><a href={x.url} target="_blank" rel="noopener noreferrer">{x.name}</a> · {x.count} {x.note ? `· ${x.note}` : ''}</li>)}</ul>
        </details>}
      </div>
    </div>
  );
}

export function InstallHelpSheet() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return (
    <SheetFrame title={t('installApp')}>
      <List>
        {ios ? [1, 2, 3].map((n) => <Row key={n} icon={n === 2 ? 'share' : n === 3 ? 'plus' : 'globe'} color="violet" title={t(`installIOS${n}`)} />)
          : <Row icon="download" color="violet" title={t('installOther')} />}
      </List>
      <p class="note-text">{t('installAppSub')}</p>
    </SheetFrame>
  );
}
