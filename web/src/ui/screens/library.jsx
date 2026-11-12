import { Fragment } from 'preact';
import { useState, useRef, useMemo, useEffect } from 'preact/hooks';
import { useApp, push, openSheet, closeSheet, toast, addSongbookSong, addScore, getState } from '../state.js';
import { t, getLang, instrumentName, INSTRUMENTS } from '../../core/i18n.js';
import { Icon, Badge, List, Row, Chip, Button, Card, Section, Stars, Empty, Segmented } from '../components.jsx';
import { LargeTitle, NavBar, SheetFrame } from './common.jsx';
import { Mascot } from '../mascot.jsx';
import { importFile, importText, ACCEPT } from '../importer.js';
import { SONGS, songTitle } from '../../data/songs.js';
import { loadCatalog, searchCatalog, addCatalogPiece, GENRES } from '../catalog.js';
import { parseChordSheet, sheetChords } from '../../core/chordsheet.js';
import { keyName, parseName, nameOf } from '../../core/pitch.js';
import { scaleScore } from '../../core/exercises.js';

const FILTERS = [
  { id: 'all', label: 'allPieces', color: 'blue' }, { id: 'favourite', label: 'favourites', color: 'yellow' }, { id: 'import', label: 'imported', color: 'indigo' },
  { id: 'sheet', label: 'chordSheets', color: 'green' }, { id: 'improv', label: 'improvisations', color: 'purple' }, { id: 'songbook', label: 'sampleSongs', color: 'pink' },
];

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

export function LibraryView() {
  const s = useApp();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return s.pieces.filter((p) => {
      if (filter === 'favourite' && !p.favorite) return false;
      if (filter === 'songbook' && p.source !== 'songbook') return false;
      if (filter === 'import' && p.source !== 'import') return false;
      if (filter === 'sheet' && p.kind !== 'sheet' && !(p.kind === 'pdf' && p.key)) return false;
      if (filter === 'improv' && p.source !== 'improv') return false;
      if (!needle) return true;
      return `${p.title} ${p.composer} ${p.keyText} ${p.instrument}`.toLowerCase().includes(needle);
    });
  }, [s.pieces, q, filter]);
  const recent = !q && filter === 'all' ? [...s.pieces].filter((p) => p.opened).sort((a, b) => b.opened - a.opened).slice(0, 3) : [];
  return (
    <div class="scroll">
      <div class="wrap">
        <LargeTitle title={t('library')} actions={<button type="button" class="btn brand small" onClick={() => openSheet('add')} id="lib-add"><Icon name="plus" size={18} stroke={2.6} />{t('add')}</button>} />
        <button type="button" class="sr-cta fade-up" id="lib-free" onClick={() => push('catalog')}>
          <span class="hm-art sm"><Icon name="books" size={21} stroke={2.1} /></span>
          <div><strong>{t('freeLibrary')}</strong><span>{t('freeLibrarySub')}</span></div>
          <Icon name="chevronR" size={16} stroke={2.4} />
        </button>
        <label class="search" for="lib-search"><Icon name="search" size={18} /><input id="lib-search" type="search" placeholder={t('searchPrompt')} value={q} onInput={(e) => setQ(e.currentTarget.value)} /></label>
        <div class="chips">{FILTERS.map((f) => <Chip key={f.id} on={filter === f.id} color={f.color} onClick={() => setFilter(f.id)}>{t(f.label)}</Chip>)}</div>
        {recent.length > 0 && <Section title={t('recentlyPractised')}><List>{recent.map((p) => <PieceRow key={'r' + p.id} p={p} />)}</List></Section>}
        <Section title={t(FILTERS.find((f) => f.id === filter).label)} footer={list.length ? t('piecesCount', { n: list.length }) : null}>
          {list.length ? <List>{list.map((p) => <PieceRow key={p.id} p={p} />)}</List>
            : q ? <Empty icon="search" title={t('noResults', { q })} />
              : <Empty icon="library" title={t('emptyLibrary')} sub={t('emptyLibrarySub')}><Button onClick={() => openSheet('add')} icon="plus">{t('add')}</Button></Empty>}
        </Section>
      </div>
    </div>
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

export function PasteSheet({ initial = '' }) {
  const [text, setText] = useState(initial);
  const preview = useMemo(() => {
    if (!text.trim()) return null;
    if (/^X:\s*\d/m.test(text) && /^K:/m.test(text)) return 'ABC';
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
    <SheetFrame title={t('pasteChords')} right={t('add')} onRight={add} rightDisabled={!preview} full>
      <p class="note-text">{t('pasteChordsSub')}. ChordPro, ABC.</p>
      <textarea class="field" id="paste-text" placeholder={`${t('pasteHere')}\n\nG            G7         C         G\nAmazing grace, how sweet the sound`} value={text} onInput={(e) => setText(e.currentTarget.value)} onPaste={(e) => { const v = e.clipboardData?.getData('text'); if (v) { e.preventDefault(); setText((x) => x + v); } }} />
      {preview && <div class="report-line"><span class="t-green"><Icon name="check" size={20} stroke={2.4} /></span><strong>{preview}</strong></div>}
      <Button onClick={add} disabled={!preview} full>{t('addToLibrary')}</Button>
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
      <List><Row title={t('instrument')} right={<select id="scale-inst" value={inst} onChange={(e) => setInst(e.currentTarget.value)}>{INSTRUMENTS.map((k) => <option key={k} value={k}>{instrumentName(k)}</option>)}</select>} /></List>
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
