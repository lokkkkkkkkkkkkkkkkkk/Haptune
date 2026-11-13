// Write: make sheet music and share it. Start a new song (instrument, key, time, speed), scan a printed page or a
// photo, type chords, or open one of your scores to fix it. The studio writes notes with a tap on the piano keys
// (or a computer keyboard, or a MIDI keyboard), shows the bars large, plays them back, and saves as you go. A
// finished song can go to Stage for others, to a class as an assignment, or out as PDF, MusicXML or MIDI.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp, push, openSheet, closeSheet, toast, getPiece, updatePiece, addScore } from '../state.js';
import { t, instrumentName } from '../../core/i18n.js';
import { Icon, Button, Keyboard, Chip } from '../components.jsx';
import { LargeTitle, NavBar, SheetFrame, Avatar } from './common.jsx';
import { Mascot } from '../mascot.jsx';
import { renderMusicXML, warmEditor } from '../verovio.js';
import { writeMusicXML } from '../../core/musicxml.js';
import { sliceMeasures, findNote, movePitch, toRest, splitNote, joinNext } from '../../core/edit.js';
import { blankScore, writeAt, eraseBefore, addToChord, setChordSymbol, step, noteAt, LENGTHS, setInfo, trimEmptyEnd } from '../../core/write.js';
import { performance as perfOf, secondsAt, keyAt, transposeScore, concertKey } from '../../core/score.js';
import { midiOf, pitchName, keyName } from '../../core/pitch.js';
import { audioContext, note, Transport } from '../audio.js';
import { soundOf } from '../../core/instruments.js';
import { difficulty } from '../../core/analysis.js';
import { q, ZERO } from '../../core/q.js';
import { openFiles } from '../intake.js';
import { hasServer } from '../api.js';
import { hasPlan } from '../account.js';

const INSTRUMENTS = ['piano', 'violin', 'guitar', 'voice', 'flute', 'cello', 'ukulele', 'clarinet', 'sax', 'trumpet', 'erhu', 'guzheng'];
const KEYS = [-4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
const TIMES = [[4, 4], [3, 4], [2, 4], [6, 8]];
const keyLabel = (f) => keyName({ fifths: f, mode: 'major' });

export function WriteView() {
  const s = useApp();
  const pageRef = useRef(null), fileRef = useRef(null);
  const mine = s.pieces.filter((p) => p.kind === 'score' && (p.source === 'written' || p.edited)).slice(0, 12);
  const recent = s.pieces.filter((p) => p.kind === 'score' && p.source !== 'written').slice(0, 8);
  const onPick = (e) => { const files = [...(e.currentTarget.files || [])]; e.currentTarget.value = ''; openFiles(files); };
  return (
    <div class="scroll" id="write">
      <div class="wrap">
        <input ref={pageRef} type="file" class="hidden-input" accept=".pdf,application/pdf,image/*" multiple onChange={onPick} id="write-scan-in" aria-label={t('wayScan')} />
        <input ref={fileRef} type="file" class="hidden-input" accept=".musicxml,.xml,.mxl,.mid,.midi,.abc,.cho,.chordpro,.txt" onChange={onPick} aria-label={t('wayFile')} />
        <LargeTitle title={t('write')} eyebrow={t('writeEyebrow')} actions={<span class="ph-only"><Avatar /></span>} />
        <section class="hero3 hero-write fade-up">
          <h1>{t('writeHero')}</h1>
          <p>{t('writeHeroSub')}</p>
          <div class="row-gap"><button type="button" class="btn white" onClick={() => openSheet('newSong')} id="write-new"><Icon name="plus" size={18} stroke={2.6} />{t('newSongT')}</button></div>
          <span class="pc-only"><Mascot mood="happy" size={120} /></span>
        </section>
        <div class="acts stagger">
          <button type="button" class="act c-teal big" onClick={() => openSheet('newSong')} id="write-new-act"><span class="ic"><Icon name="pencil" size={22} stroke={2.2} /></span><strong>{t('newSongT')}</strong><span>{t('newSongSub')}</span></button>
          <button type="button" class="act c-violet" onClick={() => pageRef.current?.click()} id="write-scan"><span class="ic"><Icon name="camera" size={22} stroke={2.2} /></span>{!hasPlan('pro') && <span class="lock"><Icon name="lock" size={11} stroke={2.6} />PRO</span>}<strong>{t('wayScan')}</strong><span>{t('writeScanSub')}</span></button>
          <button type="button" class="act c-orange" onClick={() => openSheet('paste')}><span class="ic"><Icon name="chords" size={22} stroke={2.2} /></span><strong>{t('pasteChords')}</strong><span>{t('pasteChordsSub')}</span></button>
          <button type="button" class="act c-blue" onClick={() => fileRef.current?.click()}><span class="ic"><Icon name="upload" size={22} stroke={2.2} /></span><strong>{t('wayFile')}</strong><span>{t('wayFileSub')}</span></button>
        </div>
        <section class="sec3">
          <div class="section-head"><h2>{t('mySongs')}</h2></div>
          {mine.length ? (
            <div class="grid3">{mine.map((p) => <SongTile key={p.id} p={p} />)}</div>
          ) : <div class="empty3 card"><Mascot mood="think" size={70} /><h3>{t('noSongsYet')}</h3><p>{t('noSongsYetSub')}</p></div>}
        </section>
        {recent.length > 0 && (
          <section class="sec3">
            <div class="section-head"><h2>{t('fixAScore')}</h2></div>
            <p class="muted" style={{ margin: '-6px 4px 0' }}>{t('fixAScoreSub')}</p>
            <div class="grid3">{recent.map((p) => <SongTile key={p.id} p={p} fix />)}</div>
          </section>
        )}
      </div>
    </div>
  );
}

function SongTile({ p, fix = false }) {
  return (
    <div class="song-tile">
      <button type="button" class="st-main" onClick={() => push('studio', { id: p.id })}>
        <span class="st-ic"><Icon name={fix ? 'pencil' : 'note1'} size={20} stroke={2.2} /></span>
        <span class="st-txt"><strong>{p.title}</strong><span class="tiny">{[p.keyText, p.measures ? t('barsN', { n: p.measures }) : '', p.instrument ? instrumentName(p.instrument) : ''].filter(Boolean).join(' · ')}</span></span>
      </button>
      <button type="button" class="st-play" onClick={() => push('piece', { id: p.id })} aria-label={t('practice')}><Icon name="play" size={16} fill stroke={1.5} /></button>
    </div>
  );
}

export function NewSongSheet() {
  const s = useApp();
  const [title, setTitle] = useState('');
  const [instrument, setInstrument] = useState(INSTRUMENTS.includes(s.settings.instrument) ? s.settings.instrument : 'piano');
  const [key, setKey] = useState(0);
  const [time, setTime] = useState([4, 4]);
  const [tempo, setTempo] = useState(90);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const score = blankScore({ title: title.trim() || t('untitledSong'), composer: (s.me?.name && s.me.name !== 'Musician' ? s.me.name : s.settings.name) || '', instrument, key, time, tempo, bars: 4 });
      const rec = await addScore(score, { source: 'written', title: score.title, extra: { edited: Date.now() } });
      closeSheet();
      push('studio', { id: rec.id, fresh: true }, 'write');
    } catch (e) { toast(e.message || String(e), 'err'); setBusy(false); }
  };
  return (
    <SheetFrame title={t('newSongT')} right={t('createT')} onRight={make} rightDisabled={busy}>
      <label class="field3"><span>{t('songTitle')}</span><input id="new-song-title" value={title} onInput={(e) => setTitle(e.currentTarget.value)} placeholder={t('untitledSong')} maxLength={120} /></label>
      <span class="tiny">{t('instrument')}</span>
      <div class="chips wrap">{INSTRUMENTS.map((k) => <Chip key={k} on={instrument === k} onClick={() => setInstrument(k)}>{instrumentName(k)}</Chip>)}</div>
      <span class="tiny">{t('key')}</span>
      <div class="chips wrap">{KEYS.map((f) => <Chip key={f} on={key === f} onClick={() => setKey(f)}>{keyLabel(f)}</Chip>)}</div>
      <span class="tiny">{t('time')}</span>
      <div class="chips wrap">{TIMES.map((x) => <Chip key={x.join('/')} on={time.join('/') === x.join('/')} onClick={() => setTime(x)}>{x.join('/')}</Chip>)}</div>
      <label class="field3"><span>{t('tempoT')} ♩ = {tempo}</span><input type="range" min="40" max="200" step="2" value={tempo} onInput={(e) => setTempo(Number(e.currentTarget.value))} /></label>
      <Button full icon="pencil" onClick={make} disabled={busy} id="new-song-make">{t('startWriting')}</Button>
    </SheetFrame>
  );
}

// ---------------------------------------------------------------- the studio
export function StudioView({ id, active, fresh = false }) {
  const s = useApp();
  const meta = s.pieces.find((p) => p.id === id);
  const [hist, setHist] = useState({ list: [], i: -1 });
  const [cur, setCur] = useState({ pi: 0, staff: 1, mi: 0, off: ZERO });
  const [len, setLen] = useState(2);              // index into LENGTHS: a quarter note
  const [dot, setDot] = useState(false);
  const [chordMode, setChordMode] = useState(false);
  const [sel, setSel] = useState(null);           // a note tapped on the page
  const [octave, setOctave] = useState(4);
  const [svg, setSvg] = useState('');
  const [wide, setWide] = useState(true);
  const [panel, setPanel] = useState('keys');      // keys | chords | song
  const [chordText, setChordText] = useState('');
  const boxRef = useRef(null);
  const transport = useRef(null);
  const saveTimer = useRef(null);
  const dirty = useRef(false);
  const score = hist.i >= 0 ? hist.list[hist.i] : null;
  const N = wide ? 4 : 2;
  const win = Math.max(0, cur.mi - (cur.mi % N));
  const lenQ = LENGTHS[len]?.q.mul(dot ? q(3, 2) : q(1)) || q(1);

  useEffect(() => {
    warmEditor();
    getPiece(id).then((d) => {
      if (!d?.score) return;
      setHist({ list: [d.score], i: 0 });
      const w = (boxRef.current?.clientWidth || 360) > 640;
      setWide(w);
      const instr = d.score.parts[0]?.instrument;
      setOctave(['cello', 'bass', 'bassoon', 'trombone', 'tuba'].includes(instr) ? 3 : 4);
    });
    return () => transport.current?.stop();
  }, [id]);

  const slice = useMemo(() => (score ? sliceMeasures(score, win, win + N - 1) : null), [score, win, N]);
  useEffect(() => {
    if (!slice) return undefined;
    let alive = true;
    const width = Math.min(1000, boxRef.current?.clientWidth || 360);
    renderMusicXML(writeMusicXML(slice), { width, scale: width < 500 ? 50 : 56, lane: 'edit', key: 'studio' })
      .then((r) => { if (alive) setSvg(r.pages.join('')); }).catch((e) => { if (alive && !e.superseded) setSvg(''); });
    return () => { alive = false; };
  }, [slice]);
  // the cursor: the note or rest standing where the next note goes, and the note tapped
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !score) return;
    box.querySelectorAll('.at, .sel').forEach((el) => el.classList.remove('at', 'sel'));
    const here = noteAt(score, cur);
    if (here) box.querySelector(`[id="${here.id}"]`)?.classList.add('at');
    if (sel) box.querySelector(`[id="${sel}"]`)?.classList.add('sel');
  }, [svg, cur, sel, score]);

  // saving: a moment after each change, and when leaving
  const save = (sc = score) => {
    if (!sc || !dirty.current) return;
    dirty.current = false;
    const out = trimEmptyEnd(sc);
    const key = concertKey(out);
    updatePiece(id, { xml: writeMusicXML(out), title: out.title || meta?.title, composer: out.composer || '', measures: out.measures.length, difficulty: difficulty(out), key, keyText: keyName(key), edited: Date.now() });
  };
  const latest = useRef({});
  latest.current = { score, save };
  useEffect(() => () => { clearTimeout(saveTimer.current); latest.current.save(latest.current.score); }, []);
  useEffect(() => { if (!active) { transport.current?.stop(); latest.current.save(latest.current.score); } }, [active]);
  const commit = (next, nextCur) => {
    setHist((h) => ({ list: [...h.list.slice(0, h.i + 1), next].slice(-80), i: Math.min(h.i + 1, 79) }));
    if (nextCur) setCur(nextCur);
    dirty.current = true;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => latest.current.save(next), 1200);
  };
  const undo = () => { if (hist.i > 0) { setHist((h) => ({ ...h, i: h.i - 1 })); dirty.current = true; } };
  const redo = () => { if (hist.i < hist.list.length - 1) { setHist((h) => ({ ...h, i: h.i + 1 })); dirty.current = true; } };

  const instrument = score?.parts[0]?.instrument || 'piano';
  const sound = (m) => { const ctx = audioContext(); if (ctx) note(ctx.currentTime + 0.02, m, 0.5, 84, soundOf(instrument)); };
  /** A key on the piano (or the computer keyboard, or a MIDI keyboard): writes the note, or adds it to the chord. */
  const enter = (midi) => {
    if (!score) return;
    sound(midi);
    if (chordMode) {
      const r = addToChord(score, cur, midi);
      if (r.id) commit(r.score); else toast(t('chordNeedsNote'), 'err');
      return;
    }
    const r = writeAt(score, cur, { midi, len: lenQ });
    setSel(null);
    commit(r.score, r.cur);
  };
  const rest = () => { if (!score) return; const r = writeAt(score, cur, { midi: null, len: lenQ }); setSel(null); commit(r.score, r.cur); };
  const back = () => { if (!score) return; const r = eraseBefore(score, cur); setSel(null); commit(r.score, r.cur); };
  const move = (d) => { if (score) { setSel(null); setCur(step(score, cur, d)); } };
  const onSel = (fn, keep = true) => {
    if (!score || !sel) return;
    const out = fn(score, sel);
    const next = out?.score || out;
    if (!next || next === score) { toast(t('edCant'), 'err'); return; }
    commit(next);
    if (!keep) setSel(null);
    const n = findNote(next, sel)?.note;
    if (n?.pitch) sound(midiOf(n.pitch));
  };
  const bar = (d) => { setSel(null); setCur((c) => ({ ...c, mi: Math.max(0, Math.min((score?.measures.length || 1) - 1, c.mi + d * N - (c.mi % N))), off: ZERO })); };

  // computer keyboard: A–G write notes, 1–6 lengths, . dot, 0 rest, Backspace, arrows, Ctrl+Z
  useEffect(() => {
    if (!active) return undefined;
    const STEP = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
    const onKey = (e) => {
      if (/input|textarea|select/i.test(e.target?.tagName || '')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k in STEP) {
        e.preventDefault();
        const fifths = (score && keyAt(score.parts[0], cur.mi)?.fifths) || 0;
        let pc = STEP[k];
        // the key signature's sharps and flats apply, as on paper
        const sharps = ['f', 'c', 'g', 'd', 'a', 'e', 'b'], flats = ['b', 'e', 'a', 'd', 'g', 'c', 'f'];
        if (fifths > 0 && sharps.slice(0, fifths).includes(k)) pc += 1;
        if (fifths < 0 && flats.slice(0, -fifths).includes(k)) pc -= 1;
        enter(12 * (octave + 1) + pc + (e.shiftKey ? 1 : 0));
        return;
      }
      const L = { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1, 6: 0 }[e.key];
      if (L !== undefined) { e.preventDefault(); setLen(L); return; }
      if (e.key === '.') { e.preventDefault(); setDot((x) => !x); return; }
      if (e.key === '0') { e.preventDefault(); rest(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); back(); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); move(1); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); return; }
      if (e.key === 'ArrowUp' && sel) { e.preventDefault(); onSel((sc, i) => movePitch(sc, i, e.shiftKey ? 'octaveUp' : 'up')); return; }
      if (e.key === 'ArrowDown' && sel) { e.preventDefault(); onSel((sc, i) => movePitch(sc, i, e.shiftKey ? 'octaveDown' : 'down')); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setOctave((o) => Math.min(7, o + 1)); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setOctave((o) => Math.max(1, o - 1)); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  // a MIDI keyboard plugged in (Chrome, Edge and Android): each key pressed is written
  const [midiIn, setMidiIn] = useState(false);
  const enterRef = useRef(enter);
  enterRef.current = enter;
  useEffect(() => {
    if (!active || !navigator.requestMIDIAccess) return undefined;
    let access = null;
    const onMsg = (ev) => { const [st, n, v] = ev.data; if ((st & 0xf0) === 0x90 && v > 0) enterRef.current(n); };
    navigator.requestMIDIAccess().then((a) => {
      access = a;
      const hook = () => { let any = false; for (const inp of a.inputs.values()) { inp.onmidimessage = onMsg; any = true; } setMidiIn(any); };
      hook();
      a.onstatechange = hook;
    }).catch(() => {});
    return () => { if (access) for (const inp of access.inputs.values()) inp.onmidimessage = null; };
  }, [active]);

  const onTap = (e) => {
    const box = boxRef.current;
    if (!box || !score) return;
    let g = e.target.closest?.('g.note, g.rest, g.mRest');
    if (!g) {
      let best = 36;
      for (const el of box.querySelectorAll('g.note, g.rest, g.mRest')) {
        const r = (el.querySelector('.notehead') || el).getBoundingClientRect();
        const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        if (d < best) { best = d; g = el; }
      }
    }
    if (!g?.id) return;
    const loc = findNote(score, g.id);
    if (!loc) return;
    setCur({ pi: loc.pi, staff: loc.note.staff || 1, mi: loc.mi, off: loc.note.off });
    setSel(loc.note.rest ? null : g.id);
    if (loc.note.pitch) sound(midiOf(loc.note.pitch) + (loc.part.transpose?.c || 0));
  };

  const hear = (all = false) => {
    if (!score) return;
    audioContext();
    if (!transport.current) transport.current = new Transport();
    const tr = transport.current;
    if (tr.playing) { tr.stop(); return; }
    const src = all ? score : slice;
    const perf = perfOf(src, { repeats: false });
    const evs = perf.events.map((e) => { const a = secondsAt(perf.tempos, e.t); return { time: a, dur: secondsAt(perf.tempos, e.t.add(e.dur)) - a, midi: e.midi, vel: 82, inst: soundOf(src.parts[e.pi]?.instrument) }; });
    tr.load(evs, secondsAt(perf.tempos, perf.length) + 0.3);
    tr.setLoop(null);
    tr.play(0);
  };
  const transpose = (d) => { if (score) { commit(transposeScore(score, d)); toast(t('keyNow', { k: keyName(concertKey(transposeScore(score, d))) })); } };
  const addChord = () => {
    if (!score) return;
    const out = setChordSymbol(score, cur.mi, chordText.trim(), cur.off);
    if (!out) { toast(t('chordNotUnderstood'), 'err'); return; }
    commit(out);
    setChordText('');
  };
  const finish = () => { latest.current.save(score); push('piece', { id }); };

  if (!meta) return <div class="scroll"><NavBar title={t('write')} /></div>;
  const total = score?.measures.length || 0;
  const n = sel && score ? findNote(score, sel)?.note : null;
  const here = score ? noteAt(score, cur) : null;
  const keyF = score ? (keyAt(score.parts[0], cur.mi)?.fifths || 0) : 0;
  const lo = 12 * (octave + 1);
  return (
    <div class="scroll has-editor studio" id="studio">
      <NavBar title={score?.title || meta.title} backLabel={t('write')} actions={<>
        <button type="button" onClick={undo} disabled={hist.i <= 0} aria-label={t('edUndo')} id="st-undo" style={hist.i <= 0 ? { opacity: 0.35 } : null}><Icon name="skipBack" size={21} /></button>
        <button type="button" onClick={redo} disabled={hist.i >= hist.list.length - 1} aria-label={t('edRedo')} style={hist.i >= hist.list.length - 1 ? { opacity: 0.35 } : null}><Icon name="skipFwd" size={21} /></button>
        <button type="button" onClick={finish} aria-label={t('practice')} id="st-done"><Icon name="check" size={22} stroke={2.6} /></button>
      </>} />
      <div class="wrap" style={{ paddingTop: 8 }}>
        <div class="st-bar">
          <button type="button" class="tbtn" onClick={() => bar(-1)} disabled={win <= 0} aria-label="−"><Icon name="chevronL" size={20} stroke={2.6} /></button>
          <strong class="num" id="st-bars">{t('edBars', { a: win + 1, b: Math.min(total, win + N), n: total })}</strong>
          <button type="button" class="tbtn" onClick={() => bar(1)} disabled={win + N >= total} aria-label="+"><Icon name="chevronR" size={20} stroke={2.6} /></button>
          <span class="spacer" />
          <button type="button" class="ptag" onClick={() => hear(false)} id="st-hear"><Icon name="speaker" size={16} />{t('edHear')}</button>
          <button type="button" class="ptag" onClick={() => hear(true)}><Icon name="play" size={14} fill stroke={1.5} />{t('playAll')}</button>
        </div>
        <div class="score-box vrv ed-score st-score" ref={boxRef} onClick={onTap} dangerouslySetInnerHTML={{ __html: svg }} />
        {!svg && <div class="loading"><div class="spinner" /></div>}
        <p class="note-text center" id="st-info">
          {n ? <><b>{pitchName(n.pitch)}</b> · {t('bar', { n: cur.mi + 1 })} · {t('stSelHint')}</>
            : <>{t('bar', { n: cur.mi + 1 })} · {t('stBeat', { n: Math.round(cur.off.num() * 100) / 100 + 1 })} · {here?.rest ? t('stOnRest') : t('stOnNote')}{fresh && hist.i <= 0 ? ` · ${t('stFirstHint')}` : ''}</>}
          {midiIn && <span class="pill3 c-teal" style={{ marginLeft: 8 }}><Icon name="piano" size={13} />MIDI</span>}
        </p>
        <p class="tiny center pc-only">{t('stKeysHelp')}</p>
      </div>

      <div class="ed-bar st-dock">
        <div class="st-tabs">
          {[['keys', 'piano', t('stNotes')], ['chords', 'chords', t('viewChords')], ['song', 'gear', t('stSong')]].map(([v, ic, l]) => (
            <button type="button" key={v} class={panel === v ? 'on' : ''} onClick={() => setPanel(v)}><Icon name={ic} size={16} />{l}</button>
          ))}
        </div>
        {panel === 'keys' && <>
          <div class="st-lens" role="radiogroup" aria-label={t('noteLength')}>
            {LENGTHS.slice(0, 5).map((L, i) => <button type="button" key={L.id} role="radio" aria-checked={len === i} class={len === i ? 'on' : ''} onClick={() => setLen(i)} title={L.id} id={`len-${L.id}`}><span class="gl">{L.glyph}</span></button>)}
            <button type="button" class={dot ? 'on' : ''} onClick={() => setDot(!dot)} aria-pressed={dot} title={t('dotted')}><span class="gl">•</span></button>
            <button type="button" onClick={rest} id="st-rest" title={t('edRest')}><span class="gl">𝄽</span></button>
            <button type="button" class={chordMode ? 'on' : ''} onClick={() => setChordMode(!chordMode)} aria-pressed={chordMode} title={t('edChord')}><Icon name="chords" size={18} /></button>
            <button type="button" onClick={back} id="st-back" title={t('delete')}><Icon name="chevronL" size={18} stroke={2.6} /><span class="tiny">⌫</span></button>
          </div>
          {n && (
            <div class="st-sel">
              <button type="button" onClick={() => onSel((sc, i) => movePitch(sc, i, 'up'))} id="st-up"><Icon name="arrowUp" size={17} /></button>
              <button type="button" onClick={() => onSel((sc, i) => movePitch(sc, i, 'down'))}><Icon name="arrowDown" size={17} /></button>
              <button type="button" onClick={() => onSel((sc, i) => movePitch(sc, i, 'sharp'))}>♯</button>
              <button type="button" onClick={() => onSel((sc, i) => movePitch(sc, i, 'flat'))}>♭</button>
              <button type="button" onClick={() => onSel(splitNote)}>÷2</button>
              <button type="button" onClick={() => onSel(joinNext)}>+</button>
              <button type="button" onClick={() => onSel((sc, i) => toRest(sc, i), false)}>𝄽</button>
            </div>
          )}
          <div class="st-keys">
            <button type="button" class="oct" onClick={() => setOctave((o) => Math.max(1, o - 1))} aria-label={t('octaveDown')}>−</button>
            <div class="st-kbd"><Keyboard lo={lo} hi={lo + 24} labels onKey={enter} height={wide ? 120 : 104} /></div>
            <button type="button" class="oct" onClick={() => setOctave((o) => Math.min(7, o + 1))} aria-label={t('octaveUp')}>+</button>
          </div>
        </>}
        {panel === 'chords' && (
          <div class="st-panel">
            <p class="tiny">{t('stChordHint', { n: cur.mi + 1 })}</p>
            <div class="row-gap">
              <label class="field3" style={{ flex: 1 }}><input value={chordText} onInput={(e) => setChordText(e.currentTarget.value)} placeholder="C, Am7, F/C…" onKeyDown={(e) => { if (e.key === 'Enter') addChord(); }} id="st-chord-in" /></label>
              <Button small onClick={addChord} disabled={!chordText.trim()}>{t('add')}</Button>
              <Button small kind="secondary" onClick={() => { const out = setChordSymbol(score, cur.mi, '', cur.off); if (out) commit(out); }}>{t('clear')}</Button>
            </div>
            <div class="chips wrap">{['C', 'G', 'Am', 'F', 'Dm', 'Em', 'D', 'E7', 'G7', 'Cmaj7'].map((c) => <Chip key={c} onClick={() => { const out = setChordSymbol(score, cur.mi, c, cur.off); if (out) commit(out); }}>{c}</Chip>)}</div>
          </div>
        )}
        {panel === 'song' && score && <SongPanel score={score} keyF={keyF} onChange={commit} onTranspose={transpose} pieceId={id} />}
      </div>
    </div>
  );
}

function SongPanel({ score, keyF, onChange, onTranspose, pieceId }) {
  const app = useApp();
  const piece = app.pieces.find((p) => p.id === pieceId);
  const [title, setTitle] = useState(score.title || '');
  const [composer, setComposer] = useState(score.composer || '');
  return (
    <div class="st-panel">
      <div class="grid2">
        <label class="field3"><span>{t('songTitle')}</span><input value={title} onInput={(e) => setTitle(e.currentTarget.value)} onBlur={() => onChange(setInfo(score, { title: title.trim() || score.title }))} maxLength={120} /></label>
        <label class="field3"><span>{t('composerT')}</span><input value={composer} onInput={(e) => setComposer(e.currentTarget.value)} onBlur={() => onChange(setInfo(score, { composer: composer.trim() }))} maxLength={120} /></label>
      </div>
      <div class="row-gap">
        <span class="pill3"><Icon name="key" size={13} />{keyName({ fifths: keyF, mode: 'major' })}</span>
        <Button small kind="secondary" icon="arrowDown" onClick={() => onTranspose(-1)}>{t('keyDown')}</Button>
        <Button small kind="secondary" icon="arrowUp" onClick={() => onTranspose(1)}>{t('keyUp')}</Button>
      </div>
      <div class="row-gap">
        <Button small icon="share" onClick={() => openSheet('compose', { type: 'share', piece })} disabled={!hasServer()}>{t('shareToStage')}</Button>
        <Button small kind="secondary" icon="download" onClick={() => openSheet('export', { pieceId, semis: 0, title: score.title })}>{t('export')}</Button>
      </div>
    </div>
  );
}
