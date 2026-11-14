// The chord-sheet editor (Create → Lyrics → chords, or any chord song): a bar grid like MuseScore's chord symbols
// and the ChordPro editors. Every bar shows its beats; tap a beat to set its chord (diatonic, borrowed, slash,
// sus/7/add9 or typed), drag a chord to another beat, split and merge bars, change beats per bar per section,
// change the key (every chord moves), see Roman numerals, capo options and how to play each chord, undo/redo,
// hear it in a rhythm style, export, and Play Along with it.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp, push, openSheet, closeSheet, toast, addScore, updatePiece, getPiece } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon, Button, Chip, Segmented, FretDiagram, PianoChord } from '../components.jsx';
import { NavBar, SheetFrame } from './common.jsx';
import * as CB from '../../core/chordbars.js';
import { RHYTHM_IDS, swingTime } from '../../core/rhythm.js';
import { parseChord } from '../../core/chords.js';
import { parseChordSheet } from '../../core/chordsheet.js';
import { keyName } from '../../core/pitch.js';
import { writeMusicXML, describeScore } from '../../core/musicxml.js';
import { Transport, audioContext } from '../audio.js';
import { saveFile } from '../files.js';
import { writePdf } from '../../core/pdf.js';
import { tick } from '../native.js';

const KEYS = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
const BEATS = [[2, 4], [3, 4], [4, 4], [5, 4], [6, 8], [12, 8]];

/** Saves a chord song as a playable piece (a score with the chords as block chords) and returns its record. */
export async function saveChordSong(song, id = null) {
  const score = CB.songToScore(song);
  if (id) {
    const xml = writeMusicXML(score);
    const info = describeScore(score);
    await updatePiece(id, { xml, title: song.title || t('untitledSong'), composer: song.artist || '', key: song.key, keyText: keyName(song.key), measures: score.measures.length, chords: info.chordSymbols, lyrics: info.lyrics > 0, tempo: song.tempo, chordSong: song, edited: Date.now() });
    return { id };
  }
  return addScore(score, { source: 'written', fmt: 'chords', title: song.title || t('untitledSong'), extra: { chordSong: song, edited: Date.now() } });
}

export function ChordEditorView({ id = null, text = '', title = '', fresh = false, init = null, active }) {
  const s = useApp();
  const [h, setH] = useState(null);                  // undo history around the song
  const [pieceId, setPieceId] = useState(id);
  const [sel, setSel] = useState(null);              // {s, b, beat}
  const [mode, setMode] = useState('edit');
  const [playing, setPlaying] = useState(null);      // {s, b}
  const tr = useRef(null);
  const saveTimer = useRef(null);
  const drag = useRef(null);

  useEffect(() => {
    (async () => {
      if (id) {
        const p = await getPiece(id);
        if (p?.rec?.chordSong) { setH(CB.history.start(p.rec.chordSong)); return; }
      }
      let song;
      if (text.trim()) {
        song = CB.songFromSheet(parseChordSheet(text, { title }));
        if (init?.time && (init.time.beats !== song.time.beats || init.time.beatType !== song.time.beatType)) song = CB.setSongTime(song, init.time.beats, init.time.beatType);
        song = CB.autoChords(song);
      } else {
        song = CB.newSong({ title: title || t('untitledSong'), bars: 8, ...(init ? { key: init.key, time: init.time } : {}) });
        song = CB.autoChords(song);
      }
      if (init?.style) song = CB.setSong(song, { style: init.style });
      if (init?.tempo) song = CB.setSong(song, { tempo: init.tempo });
      if (!song.title) song = CB.setSong(song, { title: title || t('untitledSong') });
      setH(CB.history.start(song));
      if (fresh || !id) { const rec = await saveChordSong(song); setPieceId(rec.id); }
    })().catch((e) => toast(e.message || String(e), 'err'));
  }, [id]);
  useEffect(() => () => { tr.current?.stop(); clearTimeout(saveTimer.current); }, []);
  useEffect(() => { if (!active) stop(); }, [active]);

  const song = h?.now;
  // autosave a moment after the last change
  useEffect(() => {
    if (!song || !pieceId) return undefined;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveChordSong(song, pieceId).catch(() => {}), 600);
    return () => clearTimeout(saveTimer.current);
  }, [song, pieceId]);

  const change = (fn) => { try { setH((x) => CB.history.push(x, fn(x.now))); tick(); } catch (e) { toast(e.message || String(e), 'err'); } };

  if (!song) return <div class="scroll"><NavBar title={t('chordEditorT')} backLabel={t('back')} /><div class="loading"><div class="spinner" /></div></div>;

  const pick = (pos) => {
    setSel(pos);
    const cur = CB.chordAt(song, pos)?.name || '';
    openSheet('chordPick', { song, pos, current: cur, onPick: (name) => change((x) => CB.setChord(x, pos, name)) });
  };

  function stop() { tr.current?.stop(); setPlaying(null); }
  const play = () => {
    if (playing) { stop(); return; }
    audioContext();
    const acc = CB.songAccompaniment(song);
    const spb = 60 / (song.tempo || 80);
    const evs = acc.events.map((e) => {
      const t0 = swingTime(e.t, acc.swing) * spb, t1 = swingTime(e.t + e.dur, acc.swing) * spb;
      return e.inst === 'drums' ? { time: t0, drum: e.drum, vel: e.vel } : { time: t0, dur: Math.max(0.05, t1 - t0 - 0.02), midi: e.midi, vel: e.vel, inst: e.inst === 'bass' ? 'bass' : acc.sound, pan: e.inst === 'bass' ? 0.1 : -0.2 };
    });
    if (!tr.current) tr.current = new Transport();
    tr.current.load(evs, acc.length * spb);
    const lay = CB.barLayout(song);
    tr.current.onTime = (sec) => { const qn = sec / spb; const bar = lay.find((b) => qn >= b.t && qn < b.t + b.len); if (bar) setPlaying((p) => (p && p.s === bar.s && p.b === bar.b ? p : { s: bar.s, b: bar.b })); };
    tr.current.onEnd = () => setPlaying(null);
    tr.current.play(0);
    setPlaying({ s: 0, b: 0 });
  };

  const playAlong = async () => {
    stop();
    clearTimeout(saveTimer.current);
    const rec = await saveChordSong(song, pieceId);
    push('piece', { id: rec.id, start: 'playAlong' });
  };

  // drag a chord with a finger or the mouse onto another beat
  const onDown = (e, pos) => {
    e.stopPropagation();
    drag.current = { pos, x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => { const d = drag.current; if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) { d.moved = true; document.body.classList.add('ce-dragging'); } };
  const onUp = (e) => {
    const d = drag.current; drag.current = null; document.body.classList.remove('ce-dragging');
    if (!d) return;
    if (!d.moved) { pick(d.pos); return; }
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-pos]');
    if (!el) return;
    const [ts, tb, tbeat] = el.dataset.pos.split('.').map(Number);
    change((x) => CB.moveChord(x, d.pos, { s: ts, b: tb, beat: tbeat }));
  };

  const exp = async (kind) => {
    const name = (song.title || 'song').replace(/[\\/:*?"<>|]+/g, ' ').trim();
    try {
      if (kind === 'cho') await saveFile(`${name}.cho`, new TextEncoder().encode(CB.songToChordPro(song)));
      else if (kind === 'txt') await saveFile(`${name}.txt`, new TextEncoder().encode(CB.songToChordsOverLyrics(song)));
      else if (kind === 'xml') await saveFile(`${name}.musicxml`, new TextEncoder().encode(CB.songToMusicXML(song)));
      else if (kind === 'pdf') await saveFile(`${name}.pdf`, await chordSheetPdf(song));
    } catch (e) { toast(e.message || String(e), 'err'); }
  };

  return (
    <div class="scroll" id="chord-editor">
      <NavBar title={song.title || t('chordEditorT')} color="teal" backLabel={t('back')} actions={<>
        <button type="button" id="ce-undo" disabled={!h.past.length} onClick={() => setH(CB.history.undo)} aria-label={t('undo')}><Icon name="arrowDown" size={20} style={{ transform: 'rotate(90deg)' }} /></button>
        <button type="button" id="ce-redo" disabled={!h.future.length} onClick={() => setH(CB.history.redo)} aria-label={t('redo')}><Icon name="arrowDown" size={20} style={{ transform: 'rotate(-90deg)' }} /></button>
        <button type="button" id="ce-play" onClick={play} aria-label={playing ? t('pause') : t('listen')}><Icon name={playing ? 'pause' : 'play'} size={21} fill={!playing} /></button>
      </>} />
      <div class="wrap c-teal" style={{ paddingTop: 10 }}>
        <input class="ce-title" value={song.title} onChange={(e) => change((x) => CB.setSong(x, { title: e.currentTarget.value }))} aria-label={t('songTitle')} placeholder={t('untitledSong')} />
        <div class="ce-meta chips">
          <Chip id="ce-key" onClick={() => openSheet('ceSong', { song, onChange: (patch) => change((x) => (patch.key ? CB.setSongKey(x, patch.key) : patch.time ? CB.setSongTime(x, patch.time.beats, patch.time.beatType) : CB.setSong(x, patch))) })}>
            {t('key')} {keyName(song.key)} · {song.time.beats}/{song.time.beatType} · ♩{song.tempo} · {t(`rh_${song.style}`)}</Chip>
          <Chip onClick={() => openSheet('ceSong', { song, tab: 'capo', onChange: (patch) => change((x) => CB.setSong(x, patch)) })}>{song.capo ? `${t('ceCapo')} ${song.capo}` : t('ceCapoNone')}</Chip>
        </div>
        <Segmented value={mode} onChange={setMode} options={[{ value: 'edit', label: t('ceEdit') }, { value: 'preview', label: t('cePreview') }]} id="ce-mode" />
        {mode === 'preview' ? <pre class="ce-preview" id="ce-preview">{CB.songToChordsOverLyrics(song)}</pre> : (
          <>
            <p class="tiny muted" style={{ margin: '2px 4px' }}>{t('ceTapBeat')}</p>
            {song.sections.map((sec, si) => {
              const n = CB.beatsOf(song, si);
              return (
                <section class={`ce-sec k-${sec.kind}`} key={sec.id}>
                  <div class="ce-sec-head">
                    <button type="button" class="ce-sec-name" onClick={() => openSheet('ceSection', { song, s: si, onChange: (fn) => change(fn) })}>
                      <strong>{sec.label}</strong><span>{n}/{(sec.time || song.time).beatType}{sec.style ? ` · ${t(`rh_${sec.style}`)}` : ''}</span><Icon name="more" size={18} stroke={2.6} />
                    </button>
                  </div>
                  <div class="ce-bars">
                    {sec.bars.map((bar, bi) => {
                      const on = sel && sel.s === si && sel.b === bi;
                      const now = playing && playing.s === si && playing.b === bi;
                      return (
                        <div class={`ce-bar${on ? ' sel' : ''}${now ? ' now' : ''}`} key={bi}>
                          <div class="ce-beats" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
                            {Array.from({ length: n }, (_, bt) => {
                              const c = bar.chords.find((x) => x.beat === bt);
                              const pos = { s: si, b: bi, beat: bt };
                              return (
                                <button type="button" key={bt} class={`ce-beat${c ? ' has' : ''}${c?.auto ? ' auto' : ''}${on && sel.beat === bt ? ' on' : ''}`} data-pos={`${si}.${bi}.${bt}`} id={si === 0 && bi === 0 ? `ce-beat-${bt}` : undefined}
                                  onClick={c ? undefined : () => pick(pos)} onPointerDown={c ? (e) => onDown(e, pos) : undefined} onPointerMove={c ? onMove : undefined} onPointerUp={c ? onUp : undefined}>
                                  {c ? <><b class="ce-chord">{c.name}</b><i class="ce-rn">{CB.roman(c.name, song.key)}</i></> : <span class="ce-dot" />}
                                </button>
                              );
                            })}
                          </div>
                          <input class="ce-lyr" value={bar.lyrics} placeholder={on ? t('ceLyricsPh') : ''} onFocus={() => setSel({ s: si, b: bi, beat: 0 })}
                            onChange={(e) => change((x) => CB.setLyrics(x, si, bi, e.currentTarget.value))} aria-label={t('ceLyricsPh')} />
                        </div>
                      );
                    })}
                  </div>
                  {sel && sel.s === si && (
                    <div class="ce-tools">
                      <Button small kind="secondary" icon="plus" id="ce-addbar" onClick={() => change((x) => CB.insertBar(x, si, sel.b + 1))}>{t('ceAddBar')}</Button>
                      <Button small kind="secondary" id="ce-split" onClick={() => change((x) => CB.splitBar(x, si, sel.b, sel.beat || undefined))}>{t('ceSplit')}</Button>
                      <Button small kind="secondary" id="ce-merge" onClick={() => change((x) => CB.mergeBars(x, si, sel.b))}>{t('ceMerge')}</Button>
                      <Button small kind="secondary" icon="trash" onClick={() => { change((x) => CB.deleteBar(x, si, sel.b)); setSel(null); }}>{t('ceDelBar')}</Button>
                    </div>
                  )}
                </section>
              );
            })}
            <div class="chips">
              {['verse', 'chorus', 'bridge', 'intro', 'outro'].map((k) => <Chip key={k} onClick={() => change((x) => CB.addSection(x, k))}>+ {t(`sec_${k}`)}</Chip>)}
            </div>
          </>
        )}
        <div class="ce-bottom">
          <Button kind="brand" icon="mic" onClick={playAlong} id="ce-playalong">{t('cePlayAlong')}</Button>
          <Button kind="secondary" icon="share" onClick={() => openSheet('ceExport', { onPick: exp })} id="ce-export">{t('export')}</Button>
        </div>
      </div>
    </div>
  );
}

/** The chord picker: suggestions with Roman numerals, the key's chords, borrowed, colour and slash chords, or typed. */
export function ChordPickSheet({ song, pos, current = '', onPick }) {
  const [txt, setTxt] = useState(current);
  const pal = useMemo(() => CB.chordPalette(song.key), [song.key.fifths, song.key.mode]);
  const sug = useMemo(() => CB.suggestionsFor(song, pos.s, pos.b), [song, pos.s, pos.b]);
  const valid = CB.chordName(txt);
  const shown = valid ? parseChord(valid) : null;
  const choose = (name) => { onPick(name); closeSheet(); };
  const row = (label, list, id) => list.length > 0 && (
    <div class="cp-row" id={id}><span class="tiny">{label}</span>
      <div class="chips wrap">{list.map((n) => <Chip key={n} on={n === current} onClick={() => choose(n)}>{n}<small class="cp-rn">{CB.roman(n, song.key)}</small></Chip>)}</div>
    </div>
  );
  return (
    <SheetFrame title={t('chordEditorT')} right={t('done')} onRight={() => (valid ? choose(valid) : closeSheet())} rightDisabled={!!txt && !valid}>
      {sug.length > 0 && <div class="cp-row" id="cp-suggest"><span class="tiny">{t('ceSuggested')}</span>
        <div class="chips wrap">{sug.map((x) => <Chip key={x.name} color="teal" onClick={() => choose(x.name)}>{x.name}<small class="cp-rn">{x.roman}</small></Chip>)}</div></div>}
      {row(t('ceDiatonic'), pal.diatonic, 'cp-diatonic')}
      {row(t('ceSevenths'), pal.sevenths)}
      {row(t('ceBorrowed'), pal.borrowed)}
      {row(t('ceColour'), pal.colour)}
      {row(t('ceSlash'), pal.slash)}
      <label class="field3"><span>{t('ceTypeChord')}</span>
        <input id="cp-text" value={txt} onInput={(e) => setTxt(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && valid) choose(valid); }} autocapitalize="off" autocomplete="off" />
      </label>
      {txt && !valid && <p class="tiny" style={{ color: 'var(--s-pink)' }}>{t('ceNotChord')}</p>}
      {shown && (
        <div class="cp-shapes"><span class="tiny">{t('ceShapes')}</span>
          <div class="row-gap" style={{ flexWrap: 'wrap', gap: 12 }}><FretDiagram chord={shown} instrument="guitar" /><FretDiagram chord={shown} instrument="ukulele" /><PianoChord chord={shown} /></div>
        </div>
      )}
      {current && <Button kind="plain" icon="trash" full onClick={() => choose(null)} id="cp-remove">{t('ceRemoveChord')}</Button>}
    </SheetFrame>
  );
}

/** Song settings: key (chords move), time signature, tempo, rhythm style and capo. */
export function ChordSongSheet({ song, onChange, tab = 'song' }) {
  const [sg, setSg] = useState(song);
  const set = (patch) => { onChange(patch); setSg((x) => ({ ...x, ...patch })); };
  const capo = CB.songCapo(song).filter((c) => c.capo > 0);
  return (
    <SheetFrame title={t('ceSongStyle')} right={t('done')} onRight={closeSheet}>
      {tab !== 'capo' && <>
        <span class="tiny">{t('key')}</span>
        <div class="chips wrap" id="ces-keys">{KEYS.map((f) => <Chip key={f} on={sg.key.fifths === f && sg.key.mode !== 'minor'} onClick={() => set({ key: { fifths: f, mode: 'major' } })}>{keyName({ fifths: f, mode: 'major' })}</Chip>)}</div>
        <div class="chips wrap">{KEYS.map((f) => <Chip key={`m${f}`} on={sg.key.fifths === f && sg.key.mode === 'minor'} onClick={() => set({ key: { fifths: f, mode: 'minor' } })}>{keyName({ fifths: f, mode: 'minor' })}</Chip>)}</div>
        <span class="tiny">{t('time')}</span>
        <div class="chips wrap">{BEATS.map(([b, bt]) => <Chip key={`${b}/${bt}`} on={sg.time.beats === b && sg.time.beatType === bt} onClick={() => set({ time: { beats: b, beatType: bt } })}>{b}/{bt}</Chip>)}</div>
        <label class="field3"><span>{t('tempoT')} ♩ = {sg.tempo}</span><input type="range" min="40" max="200" step="2" value={sg.tempo} onInput={(e) => set({ tempo: Number(e.currentTarget.value) })} /></label>
        <span class="tiny">{t('styleT')}</span>
        <div class="chips wrap" id="ces-styles">{RHYTHM_IDS.map((r) => <Chip key={r} on={sg.style === r} onClick={() => set({ style: r })}>{t(`rh_${r}`)}</Chip>)}</div>
      </>}
      <span class="tiny">{t('ceCapo')}</span>
      <div class="chips wrap">
        <Chip on={!sg.capo} onClick={() => set({ capo: 0 })}>{t('ceCapoNone')}</Chip>
        {capo.map((c) => <Chip key={c.capo} on={sg.capo === c.capo} onClick={() => set({ capo: c.capo })}>{t('ceCapoAt', { n: c.capo, names: c.names.slice(0, 4).join(' ') })}</Chip>)}
      </div>
    </SheetFrame>
  );
}

/** A section's name, beats per bar, its own style, and moving, duplicating or deleting it. */
export function ChordSectionSheet({ song, s, onChange }) {
  const sec = song.sections[s];
  const [label, setLabel] = useState(sec.label);
  const n = CB.beatsOf(song, s);
  const tm = sec.time || song.time;
  const done = (fn) => { onChange(fn); closeSheet(); };
  return (
    <SheetFrame title={sec.label} right={t('done')} onRight={() => done((x) => CB.setSection(x, s, { label: label.trim() || sec.label }))}>
      <label class="field3"><span>{t('ceSectionName')}</span><input value={label} onInput={(e) => setLabel(e.currentTarget.value)} maxLength={40} /></label>
      <span class="tiny">{t('ceBeats')}</span>
      <div class="chips wrap">{BEATS.map(([b, bt]) => <Chip key={`${b}/${bt}`} on={n === b && tm.beatType === bt} onClick={() => done((x) => CB.setSectionTime(x, s, b, bt))}>{b}/{bt}</Chip>)}</div>
      <span class="tiny">{t('ceSectionStyle')}</span>
      <div class="chips wrap">
        <Chip on={!sec.style} onClick={() => done((x) => CB.setSection(x, s, { style: null }))}>{t('ceSameAsSong')}</Chip>
        {RHYTHM_IDS.map((r) => <Chip key={r} on={sec.style === r} onClick={() => done((x) => CB.setSection(x, s, { style: r }))}>{t(`rh_${r}`)}</Chip>)}
      </div>
      <div class="row-gap" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Button small kind="secondary" onClick={() => done((x) => CB.duplicateSection(x, s))}>{t('ceDuplicate')}</Button>
        <Button small kind="secondary" onClick={() => done((x) => CB.moveSection(x, s, -1))} disabled={s === 0}>{t('ceMoveUp')}</Button>
        <Button small kind="secondary" onClick={() => done((x) => CB.moveSection(x, s, 1))} disabled={s === song.sections.length - 1}>{t('ceMoveDown')}</Button>
        <Button small kind="plain" icon="trash" onClick={() => done((x) => CB.deleteSection(x, s))} disabled={song.sections.length <= 1}>{t('delete')}</Button>
      </div>
    </SheetFrame>
  );
}

export function ChordExportSheet({ onPick }) {
  const go = (k) => { closeSheet(); onPick(k); };
  return (
    <SheetFrame title={t('export')}>
      <div class="list inset">
        {[['cho', 'doc', 'ceExportChordPro'], ['txt', 'paste', 'ceExportText'], ['pdf', 'print', 'ceExportPdf'], ['xml', 'staff', 'ceExportXml']].map(([k, ic, lab]) => (
          <button type="button" class="row" key={k} id={`ce-exp-${k}`} onClick={() => go(k)}><Icon name={ic} size={20} /><span class="row-main"><span class="row-title">{t(lab)}</span></span></button>
        ))}
      </div>
    </SheetFrame>
  );
}

/** Chords over lyrics on A4 pages (drawn on a canvas, one JPEG a page). */
export async function chordSheetPdf(song) {
  const W = 1240, H = 1754, M = 90, LH = 40;
  const lines = CB.songToChordsOverLyrics(song).split('\n');
  const pages = [];
  let cv = null, g = null, y = 0;
  const page = () => {
    if (cv) pages.push(cv);
    cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); y = M;
  };
  page();
  lines.forEach((ln, i) => {
    if (y > H - M) page();
    const isTitle = i === 0, isChord = /^[A-G]/.test(ln) && ln.split(/\s+/).filter(Boolean).every((w) => CB.chordName(w));
    g.font = isTitle ? '700 46px sans-serif' : isChord ? '700 30px monospace' : /^\[/.test(ln) ? '700 30px sans-serif' : '30px monospace';
    g.fillStyle = isChord ? '#5236F2' : '#111';
    g.fillText(ln, M, y);
    y += isTitle ? LH * 1.6 : LH;
  });
  pages.push(cv);
  const jpgs = await Promise.all(pages.map((c) => new Promise((res) => c.toBlob((b) => b.arrayBuffer().then((x) => res({ jpeg: new Uint8Array(x), w: W, h: H })), 'image/jpeg', 0.9))));
  return writePdf(jpgs, { title: song.title });
}
