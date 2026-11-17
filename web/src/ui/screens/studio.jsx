// The studio, MuseScore 4 style (Part 2 F): three modes at the top, Score · Mix · Share.
//   Score  a note toolbar (lengths, dot, rest, chord, accidentals, articulations, delete), the bars large,
//          and Palettes (key, tempo, dynamics, articulations, chords) · Instruments (add, change, remove a
//          part) · Properties (the selected note or bar): a side panel on computers, tabs in the dock on
//          phones, the piano keys below. Lead sheet: one chord per bar in a lane under the music.
//   Mix    a channel strip per part: sound, volume, pan, mute, solo; it plays as mixed and is saved.
//   Share  Play Along, Stage, a class, export, and what next.
// Notes are written with a tap on the keys, the computer keyboard (A–G, 1–6, ., 0, ⌫, arrows) or a MIDI
// keyboard; everything saves as you go, and undo / redo keep 80 steps.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp, push, openSheet, toast, getPiece, updatePiece } from '../state.js';
import { t, instrumentName } from '../../core/i18n.js';
import { Icon, Button, Keyboard, Chip, Segmented } from '../components.jsx';
import { NavBar } from './common.jsx';
import { renderMusicXML, warmEditor } from '../verovio.js';
import { writeMusicXML } from '../../core/musicxml.js';
import { sliceMeasures, findNote, movePitch, toRest, splitNote, joinNext } from '../../core/edit.js';
import { writeAt, eraseBefore, addToChord, setChordSymbol, step, noteAt, LENGTHS, setInfo, trimEmptyEnd } from '../../core/write.js';
import { keyAt, transposeScore, concertKey } from '../../core/score.js';
import { midiOf, pitchName, keyName } from '../../core/pitch.js';
import { audioContext, note, Transport } from '../audio.js';
import { soundOf, INSTRUMENT_DEFS } from '../../core/instruments.js';
import { difficulty } from '../../core/analysis.js';
import { ZERO, q } from '../../core/q.js';
import { hasServer } from '../api.js';
import { addPart, removePart, setPartInstrument, setKeySig, addDynamic, toggleArticulation, DYNAMICS, barChords, chordsForKey, stripOf, mixEvents } from '../../core/studio.js';
import { NextChips } from '../nextchips.jsx';
import { track } from '../analytics.js';

const ADDABLE = ['piano', 'violin', 'viola', 'cello', 'flute', 'clarinet', 'sax', 'trumpet', 'guitar', 'bassguitar', 'voice', 'erhu'];
const SOUNDS = ['piano', 'epiano', 'organ', 'strings', 'guitar', 'bass', 'flute', 'clarinet', 'brass', 'voice'];
const TEMPOS = [60, 72, 90, 108, 120, 140];

export function StudioView({ id, active, fresh = false }) {
  const s = useApp();
  const meta = s.pieces.find((p) => p.id === id);
  const t0 = useRef(performance.now());
  const [hist, setHist] = useState({ list: [], i: -1 });
  const [cur, setCur] = useState({ pi: 0, staff: 1, mi: 0, off: ZERO });
  const [len, setLen] = useState(2);
  const [dot, setDot] = useState(false);
  const [chordMode, setChordMode] = useState(false);
  const [sel, setSel] = useState(null);
  const [octave, setOctave] = useState(4);
  const [svg, setSvg] = useState('');
  const [wide, setWide] = useState(true);
  const [mode, setMode] = useState('score');          // score | mix | share
  const [side, setSide] = useState('palettes');        // palettes | instruments | properties
  const [dock, setDock] = useState('notes');           // phones: notes | palettes | instruments | properties
  const [lead, setLead] = useState(false);
  const [mix, setMix] = useState({});
  const [playing, setPlaying] = useState(false);
  const boxRef = useRef(null);
  const transport = useRef(null);
  const saveTimer = useRef(null);
  const dirty = useRef(false);
  const score = hist.i >= 0 ? hist.list[hist.i] : null;
  const N = wide ? 4 : 2;
  const win = Math.max(0, cur.mi - (cur.mi % N));
  const lenQ = LENGTHS[len]?.q.mul(dot ? q(3, 2) : q(1)) || q(1);
  const desk = typeof innerWidth === 'number' && innerWidth >= 900;

  useEffect(() => {
    warmEditor();
    getPiece(id).then((d) => {
      if (!d?.score) return;
      setHist({ list: [d.score], i: 0 });
      setMix(d.rec?.studioMix || {});
      setLead(!!d.rec?.leadSheet || (d.score.parts.length === 1 && d.score.parts[0].instrument === 'voice'));
      setWide((boxRef.current?.clientWidth || 360) > 640);
      const instr = d.score.parts[0]?.instrument;
      setOctave(['cello', 'bass', 'bassoon', 'trombone', 'tuba', 'bassguitar'].includes(instr) ? 3 : 4);
    });
    return () => transport.current?.stop();
  }, [id]);

  const slice = useMemo(() => (score ? sliceMeasures(score, win, win + N - 1) : null), [score, win, N]);
  useEffect(() => {
    if (!slice || mode !== 'score') return undefined;
    let alive = true;
    const width = Math.min(1000, boxRef.current?.clientWidth || 360);
    renderMusicXML(writeMusicXML(slice), { width, scale: width < 500 ? 50 : 56, lane: 'edit', key: 'studio' })
      .then((r) => {
        if (!alive) return;
        setSvg(r.pages.join(''));
        if (t0.current) { track('screen_time', { screen: 'studio_ready', value: Math.round(performance.now() - t0.current) / 1000 }); globalThis.__studioReadyMs = Math.round(performance.now() - t0.current); t0.current = 0; }
      }).catch((e) => { if (alive && !e.superseded) setSvg(''); });
    return () => { alive = false; };
  }, [slice, mode]);
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
    updatePiece(id, { xml: writeMusicXML(out), title: out.title || meta?.title, composer: out.composer || '', measures: out.measures.length, parts: out.parts.length,
      difficulty: difficulty(out), key, keyText: keyName(key), edited: Date.now() });
  };
  const latest = useRef({});
  latest.current = { score, save };
  useEffect(() => () => { clearTimeout(saveTimer.current); latest.current.save(latest.current.score); }, []);
  useEffect(() => { if (!active) { transport.current?.stop(); setPlaying(false); latest.current.save(latest.current.score); } }, [active]);
  const commit = (next, nextCur) => {
    setHist((h) => ({ list: [...h.list.slice(0, h.i + 1), next].slice(-80), i: Math.min(h.i + 1, 79) }));
    if (nextCur) setCur(nextCur);
    dirty.current = true;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => latest.current.save(next), 1200);
  };
  const undo = () => { if (hist.i > 0) { setHist((h) => ({ ...h, i: h.i - 1 })); dirty.current = true; } };
  const redo = () => { if (hist.i < hist.list.length - 1) { setHist((h) => ({ ...h, i: h.i + 1 })); dirty.current = true; } };

  const part = score?.parts[cur.pi] || score?.parts[0];
  const instrument = part?.instrument || 'piano';
  const sound = (m) => { const ctx = audioContext(); if (ctx) note(ctx.currentTime + 0.02, m, 0.5, 84, stripOf(mix, part || {}).sound || soundOf(instrument), stripOf(mix, part || {}).pan); };
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
  const goPart = (pi) => { setSel(null); setCur((c) => ({ pi, staff: 1, mi: c.mi, off: ZERO })); };

  // computer keyboard: A–G write notes, 1–6 lengths, . dot, 0 rest, Backspace, arrows, Ctrl+Z
  useEffect(() => {
    if (!active || mode !== 'score') return undefined;
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
    if (!loc.note.rest && !desk) setDock((d) => (d === 'notes' ? d : 'properties'));
    if (!loc.note.rest && desk) setSide('properties');
    if (loc.note.pitch) sound(midiOf(loc.note.pitch) + (loc.part.transpose?.c || 0));
  };

  const hear = (all = false) => {
    if (!score) return;
    audioContext();
    if (!transport.current) transport.current = new Transport();
    const tr = transport.current;
    if (tr.playing) { tr.stop(); setPlaying(false); return; }
    const { evs, length } = mixEvents(all ? score : slice, mix, score);
    tr.load(evs, length);
    tr.setLoop(null);
    tr.onEnd = () => setPlaying(false);
    tr.play(0);
    setPlaying(true);
  };
  const setStrip = (p, patch) => {
    const next = { ...mix, [p.id]: { ...stripOf(mix, p), ...patch } };
    setMix(next);
    updatePiece(id, { studioMix: next }).catch(() => {});
  };
  const transpose = (d) => { if (score) { commit(transposeScore(score, d)); toast(t('keyNow', { k: keyName(concertKey(transposeScore(score, d))) })); } };
  const chordAt = (mi, text) => { if (!score) return; const out = setChordSymbol(score, mi, text, ZERO); if (!out) { toast(t('chordNotUnderstood'), 'err'); return; } commit(out); };
  const toggleLead = () => { const v = !lead; setLead(v); updatePiece(id, { leadSheet: v }).catch(() => {}); };
  const finish = () => { latest.current.save(score); push('piece', { id }); };

  if (!meta) return <div class="scroll"><NavBar title={t('write')} /></div>;
  const total = score?.measures.length || 0;
  const n = sel && score ? findNote(score, sel)?.note : null;
  const here = score ? noteAt(score, cur) : null;
  const keyF = score ? (keyAt(score.parts[0], cur.mi)?.fifths || 0) : 0;
  const lo = 12 * (octave + 1);
  const chords = score ? barChords(score) : [];

  // ---- the three panels (side on computers, dock tabs on phones)
  const palettes = score && (
    <div class="ms-pal" id="st-palettes">
      <div class="ms-k">{t('palKey')}</div>
      <div class="chips wrap">{[-4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map((f) => <Chip key={f} on={keyF === f} onClick={() => commit(setKeySig(score, f, cur.mi))} id={`pal-key-${f}`}>{keyName({ fifths: f, mode: 'major' })}</Chip>)}</div>
      <div class="ms-k">{t('palTempo')}</div>
      <div class="chips wrap">{TEMPOS.map((bpm) => <Chip key={bpm} on={score.measures[0]?.tempo === bpm} onClick={() => commit(setInfo(score, { tempo: bpm }))}>♩ = {bpm}</Chip>)}</div>
      <div class="ms-k">{t('palDynamics')}</div>
      <div class="chips wrap">{DYNAMICS.map((d) => <Chip key={d} onClick={() => commit(addDynamic(score, cur.pi, cur.mi, cur.off, d, cur.staff))} id={`pal-dyn-${d}`}><i class="dyn">{d}</i></Chip>)}</div>
      <div class="ms-k">{t('palArtic')}</div>
      <div class="chips wrap">{[['staccato', '·'], ['accent', '>'], ['tenuto', '–'], ['fermata', '𝄐']].map(([k, g]) => <Chip key={k} onClick={() => (sel ? onSel((sc, i) => toggleArticulation(sc, i, k)) : toast(t('palPickNote')))} id={`pal-art-${k}`}>{g} {t(`art_${k}`)}</Chip>)}</div>
      <div class="ms-k">{t('palChords', { n: cur.mi + 1 })}</div>
      <div class="chips wrap">{chordsForKey(keyF).map((c) => <Chip key={c} on={chords[cur.mi] === c} onClick={() => chordAt(cur.mi, c)}>{c}</Chip>)}<Chip onClick={() => chordAt(cur.mi, '')}>{t('clear')}</Chip></div>
    </div>
  );
  const instruments = score && (
    <div class="ms-ins" id="st-instruments">
      {score.parts.map((p, pi) => (
        <div class={`ms-part${cur.pi === pi ? ' on' : ''}`} key={p.id}>
          <button type="button" class="mp-name" onClick={() => goPart(pi)} id={`part-${pi}`}><Icon name="staff" size={16} />{instrumentName(p.instrument) || p.name}</button>
          <select aria-label={t('instrument')} value={p.instrument} onChange={(e) => commit(setPartInstrument(score, pi, e.currentTarget.value))}>
            {Object.keys(INSTRUMENT_DEFS).map((k) => <option key={k} value={k}>{instrumentName(k)}</option>)}
          </select>
          {score.parts.length > 1 && <button type="button" class="icon-btn" aria-label={t('delete')} onClick={() => { if (confirm(t('removePartQ', { name: instrumentName(p.instrument) }))) { commit(removePart(score, pi)); goPart(0); } }}><Icon name="trash" size={16} /></button>}
        </div>
      ))}
      {score.parts.length < 8 && <>
        <div class="ms-k">{t('addInstrument')}</div>
        <div class="chips wrap">{ADDABLE.map((k) => <Chip key={k} onClick={() => { commit(addPart(score, k)); toast(t('partAdded', { name: instrumentName(k) })); }} id={`add-${k}`}>+ {instrumentName(k)}</Chip>)}</div>
      </>}
    </div>
  );
  const properties = score && (
    <div class="ms-props" id="st-properties">
      {n ? <>
        <div class="ms-k">{t('propNote')}</div>
        <p class="ms-big"><b>{pitchName(n.pitch)}</b> · {t('bar', { n: cur.mi + 1 })}</p>
        <div class="st-sel">
          <button type="button" onClick={() => onSel((sc, i) => movePitch(sc, i, 'up'))} id="st-up"><Icon name="arrowUp" size={17} /></button>
          <button type="button" onClick={() => onSel((sc, i) => movePitch(sc, i, 'down'))}><Icon name="arrowDown" size={17} /></button>
          <button type="button" onClick={() => onSel((sc, i) => movePitch(sc, i, 'octaveUp'))}>8va</button>
          <button type="button" onClick={() => onSel((sc, i) => movePitch(sc, i, 'sharp'))}>♯</button>
          <button type="button" onClick={() => onSel((sc, i) => movePitch(sc, i, 'flat'))}>♭</button>
          <button type="button" onClick={() => onSel(splitNote)}>÷2</button>
          <button type="button" onClick={() => onSel(joinNext)}>+</button>
          <button type="button" onClick={() => onSel((sc, i) => toRest(sc, i), false)}>𝄽</button>
        </div>
      </> : <>
        <div class="ms-k">{t('propBar', { n: cur.mi + 1 })}</div>
        <p class="tiny muted">{t('propPickHint')}</p>
      </>}
      <div class="ms-k">{t('stSong')}</div>
      <SongFields score={score} onChange={commit} />
      <div class="row-gap">
        <span class="pill3"><Icon name="key" size={13} />{keyName({ fifths: keyF, mode: 'major' })}</span>
        <Button small kind="secondary" icon="arrowDown" onClick={() => transpose(-1)}>{t('keyDown')}</Button>
        <Button small kind="secondary" icon="arrowUp" onClick={() => transpose(1)}>{t('keyUp')}</Button>
      </div>
    </div>
  );
  const panels = { palettes, instruments, properties };

  return (
    <div class={`scroll has-editor studio ms4 m-${mode}`} id="studio">
      <NavBar title={score?.title || meta.title} backLabel={t('write')} actions={<>
        <button type="button" onClick={undo} disabled={hist.i <= 0} aria-label={t('edUndo')} id="st-undo" style={hist.i <= 0 ? { opacity: 0.35 } : null}><Icon name="skipBack" size={21} /></button>
        <button type="button" onClick={redo} disabled={hist.i >= hist.list.length - 1} aria-label={t('edRedo')} style={hist.i >= hist.list.length - 1 ? { opacity: 0.35 } : null}><Icon name="skipFwd" size={21} /></button>
        <button type="button" onClick={finish} aria-label={t('practice')} id="st-done"><Icon name="check" size={22} stroke={2.6} /></button>
      </>} />
      <div class="ms-modes"><Segmented id="st-modes" value={mode} onChange={(v) => { transport.current?.stop(); setPlaying(false); setMode(v); }}
        options={[{ value: 'score', label: t('modeScore') }, { value: 'mix', label: t('modeMix') }, { value: 'share', label: t('modeShare') }]} /></div>

      {mode === 'score' && <>
        <div class="ms-toolbar hscroll" id="st-toolbar" role="toolbar" aria-label={t('noteLength')}>
          {LENGTHS.slice(0, 5).map((L, i) => <button type="button" key={L.id} role="radio" aria-checked={len === i} class={len === i ? 'on' : ''} onClick={() => setLen(i)} title={L.id} id={`len-${L.id}`}><span class="gl">{L.glyph}</span></button>)}
          <button type="button" class={dot ? 'on' : ''} onClick={() => setDot(!dot)} aria-pressed={dot} title={t('dotted')}><span class="gl">•</span></button>
          <button type="button" onClick={rest} id="st-rest" title={t('edRest')}><span class="gl">𝄽</span></button>
          <span class="sep" />
          <button type="button" disabled={!sel} onClick={() => onSel((sc, i) => movePitch(sc, i, 'sharp'))} title="♯">♯</button>
          <button type="button" disabled={!sel} onClick={() => onSel((sc, i) => movePitch(sc, i, 'flat'))} title="♭">♭</button>
          <button type="button" class={chordMode ? 'on' : ''} onClick={() => setChordMode(!chordMode)} aria-pressed={chordMode} title={t('edChord')}><Icon name="chords" size={18} /></button>
          <button type="button" onClick={back} id="st-back" title={t('delete')}><span class="tiny">⌫</span></button>
          <span class="sep" />
          <button type="button" class={lead ? 'on' : ''} onClick={toggleLead} aria-pressed={lead} id="st-lead" title={t('leadSheet')}><Icon name="doc" size={17} /><span class="lbl">{t('leadSheetShort')}</span></button>
          <button type="button" class={playing ? 'on' : ''} onClick={() => hear(false)} id="st-hear" title={t('edHear')}><Icon name={playing ? 'stop' : 'speaker'} size={17} /></button>
        </div>
        <div class="ms-layout">
          {desk && <aside class="ms-side" id="st-side">
            <div class="ms-side-tabs">{[['palettes', 'grid'], ['instruments', 'staff'], ['properties', 'sliders']].map(([v, ic]) => (
              <button type="button" key={v} class={side === v ? 'on' : ''} onClick={() => setSide(v)} id={`side-${v}`}><Icon name={ic} size={15} />{t(`ms_${v}`)}</button>))}</div>
            {panels[side]}
          </aside>}
          <div class="wrap ms-main" style={{ paddingTop: 8 }}>
            <div class="st-bar">
              <button type="button" class="tbtn" onClick={() => bar(-1)} disabled={win <= 0} aria-label="−"><Icon name="chevronL" size={20} stroke={2.6} /></button>
              <strong class="num" id="st-bars">{t('edBars', { a: win + 1, b: Math.min(total, win + N), n: total })}</strong>
              <button type="button" class="tbtn" onClick={() => bar(1)} disabled={win + N >= total} aria-label="+"><Icon name="chevronR" size={20} stroke={2.6} /></button>
              <span class="spacer" />
              {score?.parts.length > 1 && <span class="pill3" id="st-part">{instrumentName(instrument)}</span>}
              <button type="button" class="ptag" onClick={() => hear(true)} id="st-playall"><Icon name="play" size={14} fill stroke={1.5} />{t('playAll')}</button>
            </div>
            <div class="score-box vrv ed-score st-score" ref={boxRef} onClick={onTap} dangerouslySetInnerHTML={{ __html: svg }} />
            {!svg && <div class="loading"><div class="spinner" /></div>}
            {lead && score && <div class="lead-lane" id="lead-lane">{Array.from({ length: Math.min(N, total - win) }, (_, k) => win + k).map((mi) => (
              <div class={`ll-bar${cur.mi === mi ? ' on' : ''}`} key={mi}>
                <button type="button" class="ll-n" onClick={() => setCur((c) => ({ ...c, mi, off: ZERO }))}>{mi + 1}</button>
                <div class="ll-chips">{chordsForKey(keyF).slice(0, 6).map((c) => <button type="button" key={c} class={chords[mi] === c ? 'on' : ''} onClick={() => chordAt(mi, chords[mi] === c ? '' : c)} id={`ll-${mi}-${c}`}>{c}</button>)}</div>
              </div>))}</div>}
            <p class="note-text center" id="st-info">
              {n ? <><b>{pitchName(n.pitch)}</b> · {t('bar', { n: cur.mi + 1 })} · {t('stSelHint')}</>
                : <>{t('bar', { n: cur.mi + 1 })} · {t('stBeat', { n: Math.round(cur.off.num() * 100) / 100 + 1 })} · {here?.rest ? t('stOnRest') : t('stOnNote')}{fresh && hist.i <= 0 ? ` · ${t('stFirstHint')}` : ''}</>}
              {midiIn && <span class="pill3 c-teal" style={{ marginLeft: 8 }}><Icon name="piano" size={13} />MIDI</span>}
            </p>
            <p class="tiny center pc-only">{t('stKeysHelp')}</p>
          </div>
        </div>
        <div class="ed-bar st-dock">
          {!desk && <div class="st-tabs">{[['notes', 'piano'], ['palettes', 'grid'], ['instruments', 'staff'], ['properties', 'sliders']].map(([v, ic]) => (
            <button type="button" key={v} class={dock === v ? 'on' : ''} onClick={() => setDock(v)} id={`dock-${v}`}><Icon name={ic} size={15} />{t(`ms_${v}`)}</button>))}</div>}
          {(desk || dock === 'notes') && <div class="st-keys">
            <button type="button" class="oct" onClick={() => setOctave((o) => Math.max(1, o - 1))} aria-label={t('octaveDown')}>−</button>
            <div class="st-kbd"><Keyboard lo={lo} hi={lo + 24} labels onKey={enter} height={wide ? 120 : 104} /></div>
            <button type="button" class="oct" onClick={() => setOctave((o) => Math.min(7, o + 1))} aria-label={t('octaveUp')}>+</button>
          </div>}
          {!desk && dock !== 'notes' && <div class="st-panel ms-dock-panel">{panels[dock]}</div>}
        </div>
      </>}

      {mode === 'mix' && score && <div class="wrap ms-mix" id="st-mixer">
        <div class="mix-strips">
          {score.parts.map((p) => {
            const st = stripOf(mix, p);
            return (
              <div class={`strip${st.mute ? ' muted' : ''}${st.solo ? ' solo' : ''}`} key={p.id} id={`strip-${p.id}`}>
                <strong class="sn">{instrumentName(p.instrument)}</strong>
                <select aria-label={t('soundT')} value={st.sound || soundOf(p.instrument)} onChange={(e) => setStrip(p, { sound: e.currentTarget.value })}>
                  {SOUNDS.map((x) => <option key={x} value={x}>{t(`snd_${x}`)}</option>)}
                </select>
                <label class="sl"><span>{t('volume')}</span><input type="range" min="0" max="100" value={Math.round(st.vol * 100)} onInput={(e) => setStrip(p, { vol: Number(e.currentTarget.value) / 100 })} class="vol" aria-label={t('volume')} /><b>{Math.round(st.vol * 100)}</b></label>
                <label class="sl"><span>{t('panT')}</span><input type="range" min="-100" max="100" value={Math.round(st.pan * 100)} onInput={(e) => setStrip(p, { pan: Number(e.currentTarget.value) / 100 })} class="pan" aria-label={t('panT')} /><b>{st.pan === 0 ? 'C' : st.pan < 0 ? `L${Math.round(-st.pan * 100)}` : `R${Math.round(st.pan * 100)}`}</b></label>
                <div class="ms-btns">
                  <button type="button" class={`mix-b${st.mute ? ' on m' : ''}`} aria-pressed={st.mute} onClick={() => setStrip(p, { mute: !st.mute })} id={`mute-${p.id}`}>M</button>
                  <button type="button" class={`mix-b${st.solo ? ' on s' : ''}`} aria-pressed={st.solo} onClick={() => setStrip(p, { solo: !st.solo })} id={`solo-${p.id}`}>S</button>
                </div>
              </div>
            );
          })}
        </div>
        <div class="row-gap" style={{ justifyContent: 'center', gap: 8 }}>
          <Button kind="brand" icon={playing ? 'stop' : 'play'} onClick={() => hear(true)} id="mix-play">{playing ? t('stop') : t('playAll')}</Button>
          <Button kind="secondary" icon="loop" onClick={() => { setMix({}); updatePiece(id, { studioMix: {} }).catch(() => {}); }}>{t('mixerReset')}</Button>
        </div>
        <p class="note-text center">{t('mixSaved')}</p>
      </div>}

      {mode === 'share' && score && <div class="wrap ms-share" id="st-share">
        <div class="share-grid">
          <button type="button" class="share-card c-violet" onClick={() => { latest.current.save(score); push('piece', { id, start: 'playAlong' }, 'library'); }} id="share-playalong"><Icon name="mic" size={22} /><strong>{t('nxPlayAlong')}</strong><span>{t('sharePlaySub')}</span></button>
          <button type="button" class="share-card c-pink" disabled={!hasServer()} onClick={() => { latest.current.save(score); openSheet('compose', { type: 'share', piece: meta }); }} id="share-stage"><Icon name="stage" size={22} /><strong>{t('shareToStage')}</strong><span>{t('shareStageSub')}</span></button>
          <button type="button" class="share-card c-blue" onClick={() => { latest.current.save(score); openSheet('export', { pieceId: id, semis: 0, title: score.title }); }} id="share-export"><Icon name="download" size={22} /><strong>{t('export')}</strong><span>{t('shareExportSub')}</span></button>
        </div>
        <NextChips flow="create" ctx={{ online: hasServer() }} id="studio-next" on={{
          playAlong: () => push('piece', { id, start: 'playAlong' }, 'library'),
          shareStage: hasServer() ? () => openSheet('compose', { type: 'share', piece: meta }) : null,
          export: () => openSheet('export', { pieceId: id, semis: 0, title: score.title }),
        }} />
      </div>}
    </div>
  );
}

function SongFields({ score, onChange }) {
  const [title, setTitle] = useState(score.title || '');
  const [composer, setComposer] = useState(score.composer || '');
  return (
    <div class="grid2">
      <label class="field3"><span>{t('songTitle')}</span><input value={title} id="st-title" onInput={(e) => setTitle(e.currentTarget.value)} onBlur={() => onChange(setInfo(score, { title: title.trim() || score.title }))} maxLength={120} /></label>
      <label class="field3"><span>{t('composerT')}</span><input value={composer} onInput={(e) => setComposer(e.currentTarget.value)} onBlur={() => onChange(setInfo(score, { composer: composer.trim() }))} maxLength={120} /></label>
    </div>
  );
}
