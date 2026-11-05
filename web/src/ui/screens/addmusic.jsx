// Adding music: the Add sheet, the guided AI import for PDFs and photos, and the song finder.
import { useState, useEffect, useRef } from 'preact/hooks';
import { useApp, push, openSheet, closeSheet, toast, addScore, getState, updatePiece, addXP } from '../state.js';
import { t, getLang, instrumentName } from '../../core/i18n.js';
import { Icon, List, Row, Chip, Button, Card, Section, Toggle } from '../components.jsx';
import { SheetFrame } from './common.jsx';
import { importFile, ACCEPT, openPdf } from '../importer.js';
import { parseMusicXML } from '../../core/musicxml.js';
import { performance as perfOf, secondsAt } from '../../core/score.js';
import { renderMusicXML } from '../verovio.js';
import { audioContext, note } from '../audio.js';
import { Mascot, Confetti } from '../mascot.jsx';
import { aiStatus, readSheetMusic, findMusic, fetchMusicFile, isLink, hasServer, youtubeId } from '../api.js';
import { SITES } from './library.jsx';

const baseName = (n = '') => n.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
const isPdf = (f) => /\.pdf$/i.test(f?.name || '') || f?.type === 'application/pdf';
const isImage = (f) => /^image\//.test(f?.type || '') || /\.(png|jpe?g|heic|heif|webp|gif|bmp|tiff?)$/i.test(f?.name || '');

// ---------------------------------------------------------------------------- the Add sheet
export function AddSheet() {
  const fileRef = useRef(null);
  const camRef = useRef(null);
  const pdfRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const toWizard = (e) => {
    const files = [...(e.currentTarget.files || [])];
    e.currentTarget.value = '';
    if (files.length) openSheet('importWizard', { files });
  };
  const onMusicFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    if (isPdf(file) || isImage(file)) { openSheet('importWizard', { files: [file] }); return; }
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
    <SheetFrame title={t('addMusic')}>
      <input ref={camRef} type="file" class="hidden-input" accept="image/*" capture="environment" multiple onChange={toWizard} aria-label={t('scanTile')} />
      <input ref={pdfRef} type="file" class="hidden-input" accept=".pdf,application/pdf,image/*" multiple onChange={toWizard} aria-label={t('pdfTile')} id="pdf-input" />
      <input ref={fileRef} type="file" class="hidden-input" accept={ACCEPT} onChange={onMusicFile} id="file-input" aria-label={t('fileTile')} />
      {busy && <div class="loading"><div class="spinner" />{t('importing')}</div>}
      <div class="add-tiles">
        <button type="button" class="add-tile c-blue fade-up" onClick={() => camRef.current?.click()} id="add-camera">
          <span class="ic"><Icon name="camera" size={22} stroke={2.2} /></span>
          <strong>{t('scanTile')}</strong><span>{t('scanTileSub')}</span><span class="tag">AI</span>
        </button>
        <button type="button" class="add-tile c-purple fade-up d1" onClick={() => pdfRef.current?.click()} id="add-pdf">
          <span class="ic"><Icon name="doc" size={22} stroke={2.2} /></span>
          <strong>{t('pdfTile')}</strong><span>{t('pdfTileSub')}</span><span class="tag">AI</span>
        </button>
        <button type="button" class="add-tile c-teal fade-up d2" onClick={() => openSheet('finder')} id="add-find">
          <span class="ic"><Icon name="search" size={22} stroke={2.4} /></span>
          <strong>{t('findSongTile')}</strong><span>{t('findSongTileSub')}</span>
        </button>
        <button type="button" class="add-tile c-green fade-up d3" onClick={() => fileRef.current?.click()} id="import-row">
          <span class="ic"><Icon name="folder" size={22} stroke={2.2} /></span>
          <strong>{t('fileTile')}</strong><span>{t('fileTileSub')}</span>
        </button>
      </div>
      <Section title={t('moreWays')}>
        <List>
          <Row icon="paste" color="green" title={t('pasteChords')} subtitle={t('pasteChordsSub')} onClick={() => openSheet('paste')} />
          <Row icon="stairs" color="teal" title={t('scaleExercise')} subtitle={t('scaleExerciseSub')} onClick={() => openSheet('scale')} />
          <Row icon="book" color="pink" title={t('sampleSongs')} subtitle={t('sampleSongsSub')} onClick={() => { closeSheet(); push('songbook', {}, 'library'); }} />
        </List>
      </Section>
    </SheetFrame>
  );
}

// ---------------------------------------------------------------------------- page thumbnails
async function thumbnails(files, max = 8) {
  const out = [];
  let pages = 0;
  for (const f of files) {
    if (isPdf(f)) {
      try {
        const doc = await openPdf(await f.arrayBuffer());
        pages += doc.numPages;
        for (let i = 1; i <= Math.min(doc.numPages, max - out.length); i++) {
          const page = await doc.getPage(i);
          const vp1 = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: 220 / vp1.width });
          const c = document.createElement('canvas');
          c.width = vp.width; c.height = vp.height;
          await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
          out.push({ url: c.toDataURL('image/jpeg', 0.7), label: `${i}` });
        }
      } catch { out.push({ url: '', label: 'PDF' }); pages += 1; }
    } else {
      pages += 1;
      out.push({ url: URL.createObjectURL(f), label: `${out.length + 1}` });
    }
    if (out.length >= max) break;
  }
  return { thumbs: out, pages };
}

/** A part of an original page around a bar, for "see on the page". box = [x0, y0, x1, y1] in 0..1. */
async function cropOriginal(files, pageNo, box) {
  let canvas = document.createElement('canvas');
  const pdf = files.find(isPdf);
  if (pdf) {
    const doc = await openPdf(await pdf.arrayBuffer());
    const page = await doc.getPage(Math.min(pageNo, doc.numPages));
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 1600 / vp1.width });
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  } else {
    const f = files.filter(isImage)[pageNo - 1] || files[0];
    const img = await createImageBitmap(f);
    const scale = Math.min(1, 1600 / img.width);
    canvas.width = img.width * scale; canvas.height = img.height * scale;
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  }
  if (!box) return canvas.toDataURL('image/jpeg', 0.85);
  const [x0, y0, x1, y1] = box;
  const pad = 0.02;
  const sx = Math.max(0, (x0 - pad) * canvas.width), sy = Math.max(0, (y0 - pad) * canvas.height);
  const sw = Math.min(canvas.width - sx, (x1 - x0 + 2 * pad) * canvas.width), sh = Math.min(canvas.height - sy, (y1 - y0 + 2 * pad) * canvas.height);
  const out = document.createElement('canvas');
  out.width = Math.max(1, sw); out.height = Math.max(1, sh);
  out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out.toDataURL('image/jpeg', 0.88);
}

/** Small JPEG copies of photo pages, kept with the piece so the original can be shown later. */
async function keepPhotos(files) {
  const out = [];
  for (const f of files.filter(isImage).slice(0, 12)) {
    try {
      const img = await createImageBitmap(f);
      const scale = Math.min(1, 1400 / img.width);
      const c = document.createElement('canvas');
      c.width = img.width * scale; c.height = img.height * scale;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      out.push(c.toDataURL('image/jpeg', 0.8));
    } catch { /* unreadable photo: skip */ }
  }
  return out;
}

function playBar(xml, barIndex) {
  try {
    const score = parseMusicXML(xml);
    const perf = perfOf(score, { repeats: false });
    const span = perf.spans.find((x) => x.mi === barIndex);
    if (!span) return;
    const ctx = audioContext();
    const t0 = ctx.currentTime + 0.08;
    const from = secondsAt(perf.tempos, span.t, 0.85);
    for (const e of perf.events) {
      const a = e.t.num(), b = span.t.num(), c = span.t.add(span.dur).num();
      if (a < b - 1e-6 || a >= c - 1e-6) continue;
      const st = secondsAt(perf.tempos, e.t, 0.85) - from;
      const en = secondsAt(perf.tempos, e.t.add(e.dur), 0.85) - from;
      note(t0 + st, e.midi, Math.max(0.1, en - st), e.vel || 80, 'piano');
    }
  } catch { /* nothing to play */ }
}

// ---------------------------------------------------------------------------- guided AI import
const LAYOUTS = [
  { id: 'melody', label: 'layoutMelody', text: 'one melody line on a single staff' },
  { id: 'piano', label: 'layoutPiano', text: 'piano music on two staves (right hand and left hand)' },
  { id: 'melodyPiano', label: 'layoutMelodyPiano', text: 'a melody instrument or voice with piano accompaniment' },
  { id: 'choir', label: 'layoutChoir', text: 'several voices or instruments' },
  { id: 'unsure', label: 'notSure', text: '' },
];
const QUICK_INSTRUMENTS = ['piano', 'violin', 'guitar', 'voice', 'flute', 'cello', 'erhu', 'sax'];

export function ImportWizardSheet({ files: initial = [], title = '', youtube = null }) {
  const s = useApp();
  const [files, setFiles] = useState(initial);
  const [thumbs, setThumbs] = useState({ thumbs: [], pages: 0 });
  const piano = ['piano', 'keyboard'].includes(s.settings.instrument);
  const [hints, setHints] = useState({ title: title || baseName(initial[0]?.name), instrument: s.settings.instrument || 'piano', layout: piano ? 'piano' : 'melody', handwritten: false, firstPages: 0 });
  const [phase, setPhase] = useState('setup');
  const [prog, setProg] = useState({ progress: 0, message: '' });
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const [ai, setAi] = useState(null);
  const [svg, setSvg] = useState('');
  const [peek, setPeek] = useState({});
  const addRef = useRef(null);
  const abort = useRef(null);
  const boxRef = useRef(null);

  useEffect(() => { aiStatus().then(setAi); }, []);
  useEffect(() => { let alive = true; thumbnails(files).then((r) => { if (alive) setThumbs(r); }); return () => { alive = false; }; }, [files]);
  useEffect(() => {
    if (phase !== 'check' || !result) return;
    let alive = true;
    renderMusicXML(result.musicxml, { width: 360, scale: 32 }).then((r) => {
      if (!alive) return;
      setSvg(r.pages.join(''));
    }).catch(() => setSvg(''));
    return () => { alive = false; };
  }, [phase, result]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !svg || !result) return;
    const measures = box.querySelectorAll('g.measure');
    for (const f of result.flags || []) measures[f.index]?.classList.add('flagged');
  }, [svg, result]);

  const set = (patch) => setHints((h) => ({ ...h, ...patch }));
  const start = async () => {
    setPhase('reading');
    setProg({ progress: 0.02, message: t('readingHelp') });
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const layout = LAYOUTS.find((l) => l.id === hints.layout);
      const res = await readSheetMusic(files, {
        title: hints.title, instrument: hints.instrument, description: layout?.text || '', handwritten: hints.handwritten,
        pages: hints.firstPages ? `1-${hints.firstPages}` : '',
      }, (st) => setProg({ progress: st.progress || 0, message: st.message || '' }), { signal: ctl.signal });
      setResult(res);
      setPhase('check');
    } catch (e) {
      if (e.message === 'Cancelled') { setPhase('setup'); return; }
      setErr(e.message || String(e));
      setPhase('error');
    }
  };
  const save = async () => {
    const score = parseMusicXML(result.musicxml);
    if (hints.title) score.title = hints.title;
    const pdf = files.find(isPdf);
    const extra = {
      aiFlags: (result.flags || []).map((f) => ({ bar: f.bar, page: f.page, box: f.box, reasons: f.reasons })),
      aiPages: thumbs.pages, youtube: youtube || null,
    };
    if (pdf && files.length === 1) extra.pdf = await pdf.arrayBuffer();
    else extra.photos = await keepPhotos(files);
    const rec = await addScore(score, { source: 'import', fmt: 'ai', title: score.title, extra });
    addXP(15);
    closeSheet();
    push('piece', { id: rec.id }, 'library');
    toast(t('added'));
  };
  const keepPdf = async () => {
    const pdf = files.find(isPdf);
    if (!pdf) { closeSheet(); return; }
    try {
      const { piece, report } = await importFile(pdf);
      if (youtube) updatePiece(piece.id, { youtube });
      openSheet('report', { pieceId: piece.id, report });
    } catch (e) { toast(e.message, 'err'); }
  };
  const addPages = (e) => {
    const more = [...(e.currentTarget.files || [])];
    e.currentTarget.value = '';
    if (more.length) setFiles((f) => [...f, ...more]);
  };

  const steps = ['setup', 'reading', 'check'];
  const stepIdx = Math.max(0, steps.indexOf(phase === 'error' ? 'reading' : phase));

  // --- no AI on this server: keep the PDF, explain
  if (ai && !ai.ai && phase === 'setup') {
    return (
      <SheetFrame title={t('readMusic')}>
        <div class="reading"><Mascot mood="sleep" size={110} /><p class="note-text">{t('aiOff')}</p></div>
        {files.some(isPdf) ? <Button onClick={keepPdf} full icon="doc">{t('keepAsPdf')}</Button> : <Button kind="secondary" onClick={closeSheet} full>{t('close')}</Button>}
      </SheetFrame>
    );
  }

  return (
    <SheetFrame title={t('readMusic')} full>
      <div class="steps" aria-hidden="true">{steps.map((x, i) => <i key={x} class={i <= stepIdx ? 'on' : ''} />)}</div>

      {phase === 'setup' && <>
        <Section title={t('stepPages')}>
          <div class="page-thumbs">
            {thumbs.thumbs.map((th, i) => (
              <figure key={i} class={i === 0 ? 'on' : ''}>
                {th.url ? <img src={th.url} alt={`${i + 1}`} /> : <canvas width="92" height="120" />}
                <figcaption>{th.label}</figcaption>
              </figure>
            ))}
            {!files.some(isPdf) && (
              <figure>
                <button type="button" class="add-tile" style={{ width: 92, height: 120, minHeight: 0, alignItems: 'center', justifyContent: 'center' }} onClick={() => addRef.current?.click()} aria-label={t('addPage')}>
                  <Icon name="plus" size={26} stroke={2.4} />
                </button>
                <figcaption>{t('addPage')}</figcaption>
              </figure>
            )}
          </div>
          <input ref={addRef} type="file" class="hidden-input" accept="image/*" capture="environment" multiple onChange={addPages} aria-label={t('addPage')} />
        </Section>

        <div class="with-mascot">
          <Mascot mood="happy" size={52} />
          <div class="bubble left"><strong>{t('aboutMusic')}</strong><br /><span class="sub">{t('aboutMusicHelp')}</span></div>
        </div>

        <List>
          <Row title={t('songName')} right={<input type="text" id="wiz-title" value={hints.title} onInput={(e) => set({ title: e.currentTarget.value })} aria-label={t('songName')} style={{ maxWidth: '60%' }} />} />
        </List>
        <Section title={t('instrument')}>
          <div class="choice-chips">
            {[...new Set([hints.instrument, ...QUICK_INSTRUMENTS])].map((k) => <Chip key={k} on={hints.instrument === k} color="purple" onClick={() => set({ instrument: k, layout: k === 'piano' ? 'piano' : hints.layout === 'piano' ? 'melody' : hints.layout })}>{instrumentName(k)}</Chip>)}
          </div>
        </Section>
        <Section title={t('whatOnPage')}>
          <div class="choice-chips">
            {LAYOUTS.map((l) => <Chip key={l.id} on={hints.layout === l.id} color="indigo" onClick={() => set({ layout: l.id })}>{t(l.label)}</Chip>)}
          </div>
        </Section>
        <List>
          <Row icon="pencil" color="orange" title={t('handwritten')} right={<Toggle id="wiz-hand" checked={hints.handwritten} onChange={(v) => set({ handwritten: v })} label={t('handwritten')} />} />
          {thumbs.pages > 3 && (
            <Row icon="doc" color="blue" title={t('whichPages')} right={
              <select id="wiz-pages" value={hints.firstPages} onChange={(e) => set({ firstPages: Number(e.currentTarget.value) })}>
                <option value={0}>{t('allPagesN', { n: Math.min(thumbs.pages, ai?.max_pages || 12) })}</option>
                {[1, 2, 3, 4, 6].filter((n) => n < thumbs.pages).map((n) => <option key={n} value={n}>{t('firstPages', { n })}</option>)}
              </select>} />
          )}
        </List>
        <Button kind="brand" full onClick={start} disabled={!files.length || !ai} icon="sparkles">{t('startReading')}</Button>
      </>}

      {phase === 'reading' && (
        <div class="reading">
          <Mascot mood="think" size={130} />
          <h3>{t('readingTitle')}</h3>
          <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round((prog.progress || 0) * 100)}>
            <span style={{ width: `${Math.max(4, Math.round((prog.progress || 0) * 100))}%` }} />
          </div>
          <p class="note-text">{prog.message || t('readingHelp')}</p>
          <Button kind="plain" onClick={() => abort.current?.abort()}>{t('cancel')}</Button>
        </div>
      )}

      {phase === 'error' && (
        <div class="reading">
          <Mascot mood="sad" size={110} />
          <h3>{t('readFailed')}</h3>
          <p class="note-text">{err}</p>
          <p class="note-text">{t('tryClearer')}</p>
          <div class="btn-row" style={{ width: '100%' }}>
            <Button onClick={() => setPhase('setup')} icon="loop">{t('tryAgain')}</Button>
            {files.some(isPdf) && <Button kind="secondary" onClick={keepPdf} icon="doc">{t('keepAsPdf')}</Button>}
          </div>
        </div>
      )}

      {phase === 'check' && result && <>
        {!(result.flags || []).length && <Confetti />}
        <div class="with-mascot">
          <Mascot mood="cheer" size={64} />
          <div class="bubble left">
            <strong>{t('readDone')}</strong><br />
            <span class="sub">{result.report?.bars} {t('bars').toLowerCase()} · {(result.report?.parts || []).map((p) => p.name).join(', ')}
              {' · '}{(result.flags || []).length === 0 ? t('allBarsOk') : result.flags.length === 1 ? t('oneBarToCheck') : t('barsToCheck', { n: result.flags.length })}</span>
          </div>
        </div>
        <div class="score-box vrv" ref={boxRef} dangerouslySetInnerHTML={{ __html: svg }} />
        {!svg && <div class="loading"><div class="spinner" /></div>}
        {(result.flags || []).length > 0 && (
          <Section title={t('barsToCheck', { n: result.flags.length })}>
            <div class="list">
              {result.flags.map((f) => (
                <div class="flag-row" key={f.index}>
                  <span class="n">{t('bar', { n: f.bar })}</span>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 14 }}>{(f.reasons || [])[0]}</span>
                    <div class="btn-row">
                      <Button small kind="secondary" icon="eye" onClick={async () => {
                        if (peek[f.index]) { setPeek((p) => ({ ...p, [f.index]: null })); return; }
                        const url = await cropOriginal(files, f.page, f.box).catch(() => null);
                        setPeek((p) => ({ ...p, [f.index]: url }));
                      }}>{t('showOnPage')}</Button>
                      <Button small kind="secondary" color="indigo" icon="speaker" onClick={() => playBar(result.musicxml, f.index)}>{t('hearBar')}</Button>
                    </div>
                    {peek[f.index] && <img src={peek[f.index]} alt={t('originalPage')} style={{ width: '100%', borderRadius: 10, background: '#fff' }} />}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}
        <Button kind="brand" full onClick={save} icon="check">{t('saveToLibrary')}</Button>
        <Button kind="plain" full onClick={() => setPhase('setup')}>{t('tryAgain')}</Button>
      </>}
    </SheetFrame>
  );
}

// ---------------------------------------------------------------------------- song finder
const READY = new Set(['musicxml', 'mxl', 'midi', 'abc']);

export function FinderSheet({ initial = '' }) {
  const s = useApp();
  const [q, setQ] = useState(initial);
  const [inst, setInst] = useState(s.settings.instrument || 'piano');
  const [st, setSt] = useState({ phase: 'idle' });
  const [yt, setYt] = useState(false);
  const [adding, setAdding] = useState(null);
  const [ai, setAi] = useState(null);
  useEffect(() => { aiStatus().then(setAi); }, []);
  const link = isLink(q);
  const search = async () => {
    if (!q.trim()) return;
    setSt({ phase: 'searching' });
    setYt(false);
    try {
      const res = await findMusic(link ? { link: q.trim(), instrument: inst } : { query: q.trim(), instrument: inst });
      setSt({ phase: 'done', res });
    } catch (e) { setSt({ phase: 'error', err: e.message || String(e) }); }
  };
  const add = async (c) => {
    setAdding(c.file_url);
    try {
      const file = await fetchMusicFile(c.file_url);
      const ytId = st.res?.youtube_id || youtubeId(q);
      if (isPdf(file)) { openSheet('importWizard', { files: [file], title: c.title || st.res?.song?.title || '', youtube: ytId }); return; }
      const { piece } = await importFile(file);
      await updatePiece(piece.id, { youtube: ytId || null, sourceUrl: c.page_url || null, license: c.license || null });
      closeSheet();
      push('piece', { id: piece.id }, 'library');
      toast(t('added'));
    } catch (e) { toast(e.message || String(e), 'err'); }
    setAdding(null);
  };
  const offline = !hasServer() || (ai && !ai.ai);
  const res = st.res;
  const ready = res ? res.candidates.filter((c) => c.file_url && READY.has(c.format)) : [];
  const pdfs = res ? res.candidates.filter((c) => c.file_url && c.format === 'pdf') : [];
  const pages = res ? res.candidates.filter((c) => !c.file_url) : [];
  const card = (c, i) => (
    <Card class="result-card" key={i}>
      <div class="head">
        <div class="main">
          <h3>{c.title}</h3>
          <div class="src">{[c.arrangement, c.level !== 'unknown' ? c.level : '', c.pages ? t('pages', { n: c.pages }) : ''].filter(Boolean).join(' · ')}</div>
          <div class="src">{[c.source, c.license].filter(Boolean).join(' · ')}</div>
        </div>
        <span class={`fmt ${!c.file_url ? 'page' : READY.has(c.format) ? 'ready' : 'ai'}`}>{!c.file_url ? c.source : READY.has(c.format) ? t('readyToPlay') : t('aiWillRead')}</span>
      </div>
      {c.file_url
        ? <Button small onClick={() => add(c)} disabled={!!adding} icon="plus" color={READY.has(c.format) ? 'green' : 'purple'}>{adding === c.file_url ? t('adding') : t('add')}</Button>
        : <a class="btn small secondary" href={c.page_url} target="_blank" rel="noopener noreferrer">{t('openPage')}</a>}
    </Card>
  );

  return (
    <SheetFrame title={t('findSongTile')} full>
      <label class="search" for="finder-q">
        <Icon name={link ? 'video' : 'search'} size={18} />
        <input id="finder-q" type="search" placeholder={t('findPlaceholder')} value={q} onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') search(); }} enterkeyhint="search" />
      </label>
      <div class="choice-chips">
        {[...new Set([inst, ...QUICK_INSTRUMENTS])].slice(0, 6).map((k) => <Chip key={k} on={inst === k} color="teal" onClick={() => setInst(k)}>{instrumentName(k)}</Chip>)}
      </div>

      {offline ? (
        <>
          <p class="note-text">{t('findOffline')}</p>
          <List>
            {SITES.map((site) => (
              <a key={site.name} class="row" href={site.url(encodeURIComponent(q.trim()))} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
                <span class="row-main"><span class="row-title">{site.name}</span><span class="row-sub">{t(site.kind)}</span></span>
                <Icon name="share" size={16} style={{ opacity: 0.4 }} />
              </a>
            ))}
          </List>
        </>
      ) : <Button kind="brand" full onClick={search} disabled={!q.trim() || st.phase === 'searching'} icon="search">{t('search')}</Button>}

      {st.phase === 'searching' && (
        <div class="reading"><Mascot mood="think" size={110} /><p class="note-text">{t('searching')}</p></div>
      )}
      {st.phase === 'error' && (
        <div class="reading"><Mascot mood="sad" size={90} /><p class="note-text">{st.err}</p></div>
      )}
      {st.phase === 'done' && res && <>
        <div class="with-mascot">
          <Mascot mood={res.candidates.length ? 'happy' : 'sad'} size={52} />
          <div class="bubble left">
            <strong>{res.song.title}</strong>{res.song.artist ? <span class="sub"> · {res.song.artist}</span> : null}
            {(res.advice || !res.candidates.length) && <><br /><span class="sub">{res.advice || t('noneFound')}</span></>}
          </div>
        </div>
        {res.youtube_id && (
          <Card>
            <Row icon="video" color="red" title={t('watchHere')} subtitle={t('ytNote')} onClick={() => setYt(!yt)} chevron={false} />
            {yt && <div class="yt"><iframe src={`https://www.youtube-nocookie.com/embed/${res.youtube_id}?rel=0&modestbranding=1&playsinline=1`} title="YouTube" allow="encrypted-media; picture-in-picture" allowFullScreen /></div>}
          </Card>
        )}
        {ready.length > 0 && <Section title={t('readyToPlay')}>{ready.map(card)}</Section>}
        {pdfs.length > 0 && <Section title={t('aiWillRead')}>{pdfs.map(card)}</Section>}
        {pages.length > 0 && <Section title={t('openPage')}>{pages.map(card)}</Section>}
      </>}
    </SheetFrame>
  );
}
