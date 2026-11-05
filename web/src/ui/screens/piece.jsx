import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { useApp, getPiece, updatePiece, deletePiece, markOpened, pop, openSheet, closeSheet, toast, logMinutes, recordTake, go, awardBadge, getState, setState, addXP } from '../state.js';
import { t, getLang, instrumentName } from '../../core/i18n.js';
import { Icon, Card, Section, List, Row, Segmented, Stepper, Button, Chip, Stars, FretDiagram, PianoChord, Keyboard, Badge, Toggle } from '../components.jsx';
import { NavBar, SheetFrame } from './common.jsx';
import { renderMusicXML, isVerovioReady } from '../verovio.js';
import { openPdf } from '../importer.js';
import { Transport, audioContext, note, listen } from '../audio.js';
import { writeMusicXML } from '../../core/musicxml.js';
import { writeMIDI } from '../../core/midi.js';
import { writeZip } from '../../core/zip.js';
import { transposeScore, performance as perfOf, secondsAt, quartersAt, chordTrack, concertKey, pitchRange, timeAt, measureLength, beatLength, extractPart, partChoices } from '../../core/score.js';
import { transposeSheet, toChordPro, toChordsOverLyrics, sheetChords, sheetInfo } from '../../core/chordsheet.js';
import { keyName, transposeInterval, transposeKey, midiOf, spellMidi, pitchName } from '../../core/pitch.js';
import { formatChord, romanNumeral, chordNotes, capoOptions, pianoVoicing, chordPcs, rootPc } from '../../core/chords.js';
import { suggestChords, difficulty, bestKeys, VOICE_RANGES } from '../../core/analysis.js';
import { expectedNotes, Follower, trickyBars } from '../../core/follow.js';
import { q, Q, ZERO } from '../../core/q.js';
import { Mascot, Confetti } from '../mascot.jsx';
import { academy } from '../api.js';
import { dueText } from './classes.jsx';

export const SOUND = { violin: 'strings', viola: 'strings', cello: 'strings', erhu: 'strings', doublebass: 'bass', voice: 'piano', flute: 'flute', recorder: 'flute', dizi: 'flute',
  clarinet: 'clarinet', sax: 'clarinet', trumpet: 'flute', piano: 'piano', keyboard: 'piano', organ: 'organ', guitar: 'guitar', ukulele: 'guitar', bassguitar: 'bass', harp: 'piano', guzheng: 'guitar' };
const SINGING = new Set(['voice', 'voice_soprano', 'voice_alto', 'voice_tenor', 'voice_bass']);

// ---------- helpers ----------

/** Lyrics + chord symbols of a score as a chord sheet structure (verse 1, lines of about 4 bars). */
function scoreToSheet(score, harmonies) {
  const part = score.parts.find((p) => p.measures.some((pm) => pm.notes.some((n) => n.lyrics?.length))) || null;
  if (!part) return null;
  const segs = [];
  const lines = [];
  let lastChordKey = null;
  const hAt = (mi, off) => {
    let cur = null;
    for (const h of harmonies) { if (h.mi < mi || (h.mi === mi && h.off.le(off))) cur = h; else break; }
    return cur;
  };
  let lineStart = 0;
  part.measures.forEach((pm, mi) => {
    for (const n of pm.notes) {
      if (n.chord || n.rest) continue;
      const ly = n.lyrics?.find((l) => l.n === '1');
      if (!ly) continue;
      const h = hAt(mi, n.off);
      const key = h ? `${h.mi}:${h.off}` : null;
      const chord = h && key !== lastChordKey ? h.chord : null;
      lastChordKey = key;
      const space = ly.syl === 'single' || ly.syl === 'end' ? ' ' : '';
      segs.push({ chord, text: ly.text + space, mi });
      if (/[,.!?;:，。！？；]$/.test(ly.text) && mi - lineStart >= 3 && (ly.syl === 'single' || ly.syl === 'end')) {
        lines.push({ type: 'lyrics', segs: segs.splice(0) });
        lineStart = mi + 1;
      }
    }
  });
  if (segs.length) lines.push({ type: 'lyrics', segs });
  return { sections: [{ label: '', kind: 'verse', lines }] };
}

function harmonyList(score) {
  const out = [];
  score.parts.forEach((part, pi) => {
    if (out.length) return;
    part.measures.forEach((pm, mi) => pm.harmonies.forEach((h) => out.push({ mi, off: h.off, chord: h.chord, pi })));
  });
  return out.sort((a, b) => a.mi - b.mi || a.off.cmp(b.off));
}

const MIME = { zip: 'application/zip', json: 'application/json', txt: 'text/plain', pdf: 'application/pdf', mid: 'audio/midi', musicxml: 'application/vnd.recordare.musicxml+xml' };

/**
 * Hands a file to the person: the system share sheet on phones (Save to Files, AirDrop, WhatsApp...), the
 * download prompt in the Claude preview, or a normal download on computers. Returns true when it went out.
 */
async function saveFile(name, bytes) {
  const type = MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
  const blob = new Blob([bytes], { type });
  let dl = null;
  try { dl = await globalThis.claude?.use?.('downloads'); } catch { dl = null; }
  if (dl) {
    try { await dl.save({ filename: name, data: blob }); return true; } catch (e) {
      if (e?.code !== 'declined') toast(t('saveFailed'), 'err');
      return false;
    }
  }
  const touch = globalThis.matchMedia?.('(pointer: coarse)').matches;
  try {
    const file = new File([blob], name, { type });
    if (touch && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return true;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return false;               // the person closed the share sheet
  }
  if (globalThis.HAPTUNE_CONFIG?.pwa === false) { toast(t('saveFailed'), 'err'); return false; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener'; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  return true;
}

/** Prints the engraved score (the browser's print dialog also saves a PDF). */
async function printScore(xml, title) {
  const { pages } = await renderMusicXML(xml, { width: 760, scale: 40 });
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title><style>@page{margin:12mm}body{margin:0}svg{width:100%;height:auto;page-break-inside:avoid;color:#000;fill:#000}</style></head><body>${pages.join('')}</body></html>`);
  doc.close();
  setTimeout(() => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { toast(t('saveFailed'), 'err'); } setTimeout(() => frame.remove(), 60000); }, 300);
}

const matchSel = (sel) => (e) => sel.pi === null || sel.pi === undefined || (e.pi === sel.pi && (!sel.staff || (e.staff || 1) === sel.staff));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const toQ = (x) => (x instanceof Q ? x : Q.approx(Number(x) || 0));

// ---------- the piece screen ----------

export function PieceView({ id, active, start, assignment }) {
  const s = useApp();
  const meta = s.pieces.find((p) => p.id === id);
  const [data, setData] = useState(null);
  const [semis, setSemis] = useState(0);
  const [view, setView] = useState(null);
  useEffect(() => {
    let alive = true;
    getPiece(id).then((d) => {
      if (!alive) return;
      setData(d);
      setSemis(d?.rec?.transpose || 0);
      setView(d?.score ? 'sheet' : d?.rec?.kind === 'pdf' ? 'pdf' : 'lyrics');
      markOpened(id);
    });
    return () => { alive = false; };
  }, [id]);
  if (!meta) return <div class="scroll"><NavBar title="" backLabel={t('library')} /></div>;
  if (!data) return <div class="scroll"><NavBar title={meta.title} backLabel={t('library')} /><div class="loading"><Mascot mood="think" size={80} /></div></div>;
  return <PieceBody meta={meta} data={data} semis={semis} setSemis={(v) => { setSemis(v); updatePiece(id, { transpose: v }); if (v) awardBadge('transposer'); }}
    view={view} setView={setView} active={active} start={start} assignment={assignment} />;
}

function PieceBody({ meta, data, semis, setSemis, view, setView, active, start, assignment }) {
  const s = useApp();
  const { score, sheet: baseSheet, rec } = data;
  const tScore = useMemo(() => (score ? transposeScore(score, semis) : null), [score, semis]);
  const choices = useMemo(() => partChoices(tScore), [tScore]);
  const [partSel, setPartSel] = useState(assignment?.part || 'all');
  const sel = choices.find((c) => c.id === partSel) || { id: 'all', pi: null, staff: null };
  const shown = useMemo(() => (tScore && sel.pi !== null ? extractPart(tScore, sel.pi, sel.staff) : tScore), [tScore, sel.id]);
  const xml = useMemo(() => (shown ? writeMusicXML(shown) : null), [shown]);
  const written = useMemo(() => (tScore ? harmonyList(tScore) : []), [tScore]);
  const suggested = useMemo(() => (tScore && !written.length ? suggestChords(tScore).map((x) => ({ ...x, suggested: true })) : []), [tScore, written.length]);
  const harmonies = written.length ? written : suggested;
  const key = tScore ? concertKey(tScore) : null;
  const tSheet = useMemo(() => (baseSheet ? transposeSheet(baseSheet, semis) : tScore ? scoreToSheet(tScore, harmonies) : null), [baseSheet, semis, tScore, harmonies]);
  const sheetKey = tSheet?.key || key;
  const originalKey = score ? concertKey(score) : baseSheet?.key;
  const hasOriginal = !!(rec.pdf || rec.photos?.length);
  const views = [];
  if (tScore) views.push({ value: 'sheet', label: t('viewSheet') }, { value: 'roll', label: t('viewRoll') });
  if (rec.kind === 'pdf') views.push({ value: 'pdf', label: t('viewPdf') });
  if (harmonies.length || (tSheet && sheetChords(tSheet).length)) views.push({ value: 'chords', label: t('viewChords') });
  if (tSheet && tSheet.sections?.some((sec) => sec.lines.some((l) => l.segs?.some((g) => g.text.trim())))) views.push({ value: 'lyrics', label: t('viewLyrics') });
  if (hasOriginal && rec.kind !== 'pdf') views.push({ value: 'original', label: t('originalPage') });
  if (!views.some((v) => v.value === view) && views[0]) setTimeout(() => setView(views[0].value), 0);

  const perf = useMemo(() => (tScore ? perfOf(tScore, { repeats: true }) : null), [tScore]);
  const lastMi = tScore ? tScore.measures.length - 1 : 0;
  const barNo = (mi) => Number(tScore?.measures[mi]?.number) || mi + 1;
  const [player, setPlayer] = useState({ playing: false, q: 0, mi: 0, mode: null });
  const [cursorQ, setCursorQ] = useState(0);
  const [speed, setSpeed] = useState(assignment?.tempo_pct ? assignment.tempo_pct / 100 : 1);
  const [metro, setMetro] = useState(false);
  const [countIn, setCountIn] = useState(true);
  const [loop, setLoop] = useState(assignment?.bars_from ? { from: Math.max(0, assignment.bars_from - 1), to: Math.min(lastMi, (assignment.bars_to || assignment.bars_from) - 1) } : null);
  const [withChords, setWithChords] = useState(true);
  const [pa, setPa] = useState(null);           // Play Along in progress: {mode, sel, msg}
  const [result, setResult] = useState(null);   // the last Play Along result
  const [yt, setYt] = useState(false);
  const transport = useRef(null);
  const scoreBox = useRef(null);
  const lit = useRef([]);
  const builtRef = useRef(null);
  const micStop = useRef(null);
  const frames = useRef([]);
  const follower = useRef(null);
  const practice = useRef(null);
  const playStart = useRef(0);
  const lastQ = useRef(0);
  const sound = SOUND[rec.source === 'songbook' ? s.settings.instrument : (tScore?.parts[0]?.instrument || 'piano')] || 'piano';
  const instFor = (e) => SOUND[e.pi === 0 && rec.source === 'songbook' ? s.settings.instrument : tScore.parts[e.pi]?.instrument] || 'piano';
  const spanAt = (qq) => perf?.spans.find((x) => x.t.num() <= qq + 1e-9 && x.t.add(x.dur).num() > qq + 1e-9) || perf?.spans[perf.spans.length - 1];
  const spanOfBar = (mi) => perf?.spans.find((x) => x.mi === mi) || perf?.spans[0];

  // ----- the score cursor -----
  const clearMarks = () => scoreBox.current?.querySelectorAll('g.note.ok, g.note.bad, g.note.now').forEach((el) => el.classList.remove('ok', 'bad', 'now'));
  const highlight = useCallback((qNow, scroll = true) => {
    const box = scoreBox.current;
    if (!box || !perf) return;
    const ids = [];
    for (const e of perf.events) {
      const a = e.t.num();
      if (a > qNow + 1e-6) break;
      if (qNow < a + e.dur.num()) ids.push(...e.ids);
    }
    lit.current.forEach((el) => el.classList.remove('on'));
    lit.current = ids.map((nid) => box.querySelector(`[id="${nid}"]`)).filter(Boolean);
    lit.current.forEach((el) => el.classList.add('on'));
    if (scroll && lit.current[0] && view === 'sheet') {
      const r = lit.current[0].getBoundingClientRect();
      const scroller = box.closest('.scroll');
      if (scroller && (r.top < 120 || r.bottom > innerHeight - 230)) scroller.scrollBy({ top: r.top - innerHeight * 0.32, behavior: 'smooth' });
    }
  }, [perf, view]);

  const stop = (silent = false) => {
    if (transport.current?.playing) {
      transport.current.stop();
      if (!practice.current) logMinutes((performance.now() - playStart.current) / 1000);
    }
    lit.current.forEach((el) => el.classList.remove('on'));
    lit.current = [];
    setPlayer((p) => ({ ...p, playing: false, mode: null }));
    if (!silent && practice.current?.mode === 'beat') finishBeat();
  };
  const latest = useRef({});
  latest.current.stop = stop;
  useEffect(() => () => { latest.current.stop(true); micStop.current?.(); }, []);
  useEffect(() => { if (!active) { stop(true); endWait(true); } }, [active]);

  /** Events from `fromQ` on, with a count-in bar first. `mute` = the part the player plays themselves. */
  const buildEvents = (fromQ, mute = null, sp = speed, ci = countIn, click = metro) => {
    if (!perf) return null;
    const tempos = perf.tempos;
    const fq = toQ(fromQ);
    const base = secondsAt(tempos, fq, sp);
    const sec = (x) => secondsAt(tempos, x, sp) - base;
    const startSpan = spanAt(fq.num()) || perf.spans[0];
    const tStart = timeAt(tScore, startSpan.mi);
    const lead = ci ? secondsAt(tempos, fq.add(measureLength(tStart)), sp) - base : 0;
    const evs = [];
    for (const e of perf.events) {
      if (e.t.lt(fq)) continue;
      if (mute && matchSel(mute)(e)) continue;
      evs.push({ time: lead + sec(e.t), dur: sec(e.t.add(e.dur)) - sec(e.t), midi: e.midi, vel: e.vel || 80, inst: instFor(e), ids: e.ids, pan: e.pi === 0 ? 0 : -0.2 });
    }
    if (withChords && harmonies.length && tScore.parts.length === 1 && !mute) {
      for (const span of perf.spans) {
        if (span.t.add(span.dur).le(fq)) continue;
        const hs = harmonies.filter((h) => h.mi === span.mi);
        const prev = [...harmonies].reverse().find((h) => h.mi < span.mi);
        const list = hs.length ? hs : prev ? [{ ...prev, off: ZERO }] : [];
        list.forEach((h, k) => {
          const end = k + 1 < list.length ? list[k + 1].off : span.dur;
          const at = span.t.add(h.off);
          if (at.lt(fq)) return;
          pianoVoicing(h.chord, 3).map((m) => (m < 48 ? m + 12 : m)).forEach((m) => evs.push({ time: lead + sec(at), dur: sec(at.add(end.sub(h.off))) - sec(at) - 0.02, midi: m, vel: hs.length ? 44 : 38, inst: 'epiano', pan: 0.25 }));
        });
      }
    }
    // count-in clicks before the start, and the metronome through the piece
    if (ci) {
      const beat = beatLength(tStart);
      let k = 0;
      for (let b = ZERO; b.lt(measureLength(tStart)); b = b.add(beat), k++) evs.push({ time: secondsAt(tempos, fq.add(b), sp) - base, click: true, accent: k === 0 });
    }
    if (click) {
      for (const span of perf.spans) {
        const beat = beatLength(timeAt(tScore, span.mi));
        let k = 0;
        for (let b = ZERO; b.lt(span.dur); b = b.add(beat), k++) {
          const at = span.t.add(b);
          if (at.lt(fq)) continue;
          evs.push({ time: lead + sec(at), click: true, accent: k === 0 });
        }
      }
    }
    const length = lead + sec(perf.length) + 0.3;
    return { evs, lead, length, base, fromQ: fq, sp };
  };

  const play = (fromQ = null, { mode = 'listen', mute = null, sp = speed, ci = countIn, range = loop } = {}) => {
    if (!perf) return;
    audioContext();
    let startQ = toQ(fromQ ?? (cursorQ >= perf.length.num() - 0.01 ? 0 : cursorQ));
    if (range) {
      const a = spanOfBar(range.from), b = spanOfBar(range.to);
      if (startQ.lt(a.t) || startQ.ge(b.t.add(b.dur))) startQ = a.t;
    }
    const built = buildEvents(startQ, mute, sp, ci);
    if (!built) return;
    builtRef.current = built;
    if (!transport.current) transport.current = new Transport();
    const tr = transport.current;
    tr.load(built.evs, built.length);
    if (range) {
      const a = spanOfBar(range.from), b = spanOfBar(range.to);
      tr.setLoop({ start: built.lead + secondsAt(perf.tempos, a.t, sp) - built.base, end: built.lead + secondsAt(perf.tempos, b.t.add(b.dur), sp) - built.base });
    } else tr.setLoop(null);
    let lastUi = 0;
    tr.onTime = (secNow) => {
      const qNow = quartersAt(perf.tempos, built.base + Math.max(0, secNow - built.lead), sp);
      lastQ.current = qNow;
      highlight(qNow);
      const nowMs = performance.now();
      if (nowMs - lastUi > 120) {
        lastUi = nowMs;
        const span = spanAt(qNow);
        setPlayer({ playing: true, q: qNow, mi: span ? span.mi : 0, mode });
      }
    };
    tr.onEnd = () => { lastQ.current = perf.length.num(); latest.current.stop(); setCursorQ(0); setPlayer({ playing: false, q: 0, mi: 0, mode: null }); };
    playStart.current = performance.now();
    tr.play(0);
    setPlayer((p) => ({ ...p, playing: true, mode }));
  };

  // restart with new settings while listening
  useEffect(() => { if (transport.current?.playing && player.mode === 'listen') { const qNow = lastQ.current; stop(true); setTimeout(() => play(qNow), 30); } }, [speed, metro, loop, withChords, semis]);

  const toggleListen = () => {
    if (player.playing) { setCursorQ(lastQ.current); stop(); return; }
    if (pa) endWait(true);
    setResult(null);
    play(null, { mode: 'listen' });
  };
  const goToBar = (mi) => {
    mi = clamp(mi, 0, lastMi);
    const sp = spanOfBar(mi);
    if (!sp) return;
    setCursorQ(sp.t.num());
    setPlayer((p) => ({ ...p, q: sp.t.num(), mi }));
    if (transport.current?.playing && player.mode === 'listen') { stop(true); setTimeout(() => play(sp.t, { mode: 'listen' }), 30); }
    else highlight(sp.t.num());
  };
  const curMi = player.playing ? player.mi : (spanAt(cursorQ)?.mi ?? 0);
  const stepBar = (d) => {
    const sp = spanAt(player.playing ? lastQ.current : cursorQ);
    const inside = sp ? (player.playing ? lastQ.current : cursorQ) - sp.t.num() : 0;
    goToBar(d < 0 && inside > 0.6 ? curMi : curMi + d);
  };
  const toggleLoop = () => setLoop(loop ? null : { from: curMi, to: Math.min(lastMi, curMi + 3) });

  // ----- Play Along -----
  const defaultPracticePart = () => {
    if (assignment?.part && choices.some((c) => c.id === assignment.part)) return assignment.part;
    if (sel.pi !== null) return sel.id;
    const mine = choices.find((c) => tScore.parts[c.pi]?.instrument === s.settings.instrument && (!c.staff || c.staff === 1));
    return (mine || choices.find((c) => c.hand === 'right') || choices[0] || { id: 'all' }).id;
  };
  const openPlayAlong = () => {
    if (!tScore) return;
    stop(true);
    openSheet('playAlong', {
      choices, part: defaultPracticePart(), mode: assignment?.mode === 'tempo' ? 'beat' : 'wait', speed, countIn, mission: assignment || null,
      instrument: tScore.parts[0]?.instrument, onStart: (o) => { closeSheet(); startPractice(o); },
    });
  };

  const startPractice = async ({ part, mode, speed: sp, countIn: ci, range: rng }) => {
    const psel = choices.find((c) => c.id === part) || { id: 'all', pi: null, staff: null };
    setSpeed(sp); setCountIn(ci);
    setResult(null);
    clearMarks();
    setView('sheet');
    frames.current = [];
    const range = rng !== undefined ? rng : loop;
    try {
      micStop.current?.();
      micStop.current = await listen((p) => onFrame(p));
    } catch (e) {
      toast(t(e.code === 'denied' ? 'micDenied' : 'micUnavailable'), 'err');
      return;
    }
    practice.current = { mode, sel: psel, started: performance.now(), range, speed: sp };
    if (mode === 'wait') {
      const exp = expectedNotes(perf, matchSel(psel), range);
      const singer = SINGING.has(s.settings.instrument) || tScore.parts[psel.pi ?? 0]?.instrument === 'voice';
      follower.current = new Follower(exp, { octaveOk: singer });
      setPa({ mode, sel: psel, msg: null, k: 0, n: exp.length });
      markNow();
    } else {
      setPa({ mode, sel: psel, msg: null });
      const from = range ? spanOfBar(range.from).t : q(0);
      // in "keep the beat" the app never plays the player's own part, so the mic hears only them
      setTimeout(() => play(from, { mode: 'beat', mute: psel, sp, ci, range }), 50);
    }
  };

  const markNow = () => {
    const f = follower.current;
    const box = scoreBox.current;
    if (!f || !box) return;
    box.querySelectorAll('g.note.now').forEach((el) => el.classList.remove('now'));
    const cur = f.current;
    if (!cur) return;
    const els = cur.ids.map((nid) => box.querySelector(`[id="${nid}"]`)).filter(Boolean);
    els.forEach((el) => el.classList.add('now'));
    if (els[0]) {
      const r = els[0].getBoundingClientRect();
      const scroller = box.closest('.scroll');
      if (scroller && (r.top < 130 || r.bottom > innerHeight - 260)) scroller.scrollBy({ top: r.top - innerHeight * 0.3, behavior: 'smooth' });
    }
  };

  const onFrame = (p) => {
    const pr = practice.current;
    if (!pr) return;
    if (pr.mode === 'beat') {
      const tr = transport.current;
      if (!p || !tr?.playing || !builtRef.current) return;
      const secNow = tr.position() - 0.09;                     // microphone latency
      frames.current.push({ q: quartersAt(perf.tempos, builtRef.current.base + Math.max(0, secNow - builtRef.current.lead), pr.speed), midi: p.midi });
      return;
    }
    const f = follower.current;
    if (!f) return;
    const r = f.push(p ? { midi: p.midi, rms: p.rms } : null);
    if (!r) return;
    const box = scoreBox.current;
    const exp = f.exp[r.index];
    if (r.type === 'ok') {
      exp.ids.forEach((nid) => box?.querySelector(`[id="${nid}"]`)?.classList.add(f.firstTry[r.index] ? 'ok' : 'bad'));
      accompany(r.index);
      setPa((x) => x && ({ ...x, msg: null, k: f.k }));
      if (f.done) finishWait();
      else markNow();
    } else {
      try { navigator.vibrate?.(90); } catch { /* no vibration here */ }
      setPa((x) => x && ({ ...x, msg: { played: r.played, want: exp.top } }));
    }
  };

  /** In "wait for me", the other parts sound with each right note, so it still feels like music. */
  const accompany = (i) => {
    const f = follower.current;
    const pr = practice.current;
    if (!f || !pr) return;
    const a = f.exp[i].t, b = f.exp[i + 1]?.t;
    const speed = pr.speed;
    const ctx = audioContext();
    const now = ctx.currentTime + 0.02;
    for (const e of perf.events) {
      if (e.t.lt(a)) continue;
      if (b && e.t.ge(b)) break;
      if (matchSel(pr.sel)(e)) continue;
      const st = (secondsAt(perf.tempos, e.t, speed) - secondsAt(perf.tempos, a, speed));
      if (st > 0.05) continue;
      note(now, e.midi, Math.min(1.6, secondsAt(perf.tempos, e.t.add(e.dur), speed) - secondsAt(perf.tempos, e.t, speed)), Math.round((e.vel || 80) * 0.8), instFor(e), -0.2);
    }
  };

  const showResult = (r) => {
    const pr = practice.current;
    const secs = Math.round((performance.now() - (pr?.started || performance.now())) / 1000);
    practice.current = null;
    micStop.current?.(); micStop.current = null;
    setPa(null);
    if (!r.total) return;
    recordTake({ pieceId: meta.id, title: meta.title, seconds: secs, accuracy: r.accuracy, inTune: r.inTune ?? r.accuracy });
    if (r.accuracy >= 0.85) addXP(20);
    const barsList = [...r.bars.entries()].sort((x, y) => x[0] - y[0]).map(([mi, b]) => ({ bar: barNo(mi), accuracy: b.total ? b.right / b.total : 1 }));
    setResult({ ...r, seconds: secs, tricky: trickyBars(r.bars), barsList, mode: pr?.mode, speed: pr?.speed ?? speed, part: pr?.sel?.id });
  };
  const finishWait = () => { const f = follower.current; if (f) showResult(f.result()); follower.current = null; };
  const endWait = (silent) => {
    if (practice.current?.mode === 'wait') { if (silent) { practice.current = null; micStop.current?.(); micStop.current = null; setPa(null); follower.current = null; } else finishWait(); }
  };
  function finishBeat() {
    const pr = practice.current;
    if (!pr || !perf) return;
    const bars = new Map();
    let right = 0, tuned = 0, total = 0;
    const box = scoreBox.current;
    for (const e of perf.events) {
      if (!matchSel(pr.sel)(e) || e.unpitched) continue;
      if (pr.range && (e.mi < pr.range.from || e.mi > pr.range.to)) continue;
      const a = e.t.num(), b = a + e.dur.num();
      if (b > lastQ.current + 0.01) break;
      if (a < (builtRef.current?.fromQ?.num?.() ?? 0)) continue;
      const w0 = a + Math.min(0.25, (b - a) * 0.3), w1 = b - Math.min(0.1, (b - a) * 0.15);
      const fr = frames.current.filter((f) => f.q >= w0 && f.q <= w1).map((f) => f.midi).sort((x, y) => x - y);
      total++;
      let ok = false;
      if (fr.length >= 2) {
        let diff = fr[Math.floor(fr.length / 2)] - e.midi;
        diff -= 12 * Math.round(diff / 12);
        if (Math.abs(diff) <= 0.5) { ok = true; right++; if (Math.abs(diff) <= 0.25) tuned++; }
      }
      const bs = bars.get(e.mi) || { right: 0, total: 0 };
      bs.total++; if (ok) bs.right++;
      bars.set(e.mi, bs);
      e.ids.forEach((nid) => box?.querySelector(`[id="${nid}"]`)?.classList.add(ok ? 'ok' : 'bad'));
    }
    showResult({ accuracy: total ? right / total : 0, right, total, inTune: right ? tuned / right : 0, bars });
  }

  const practiseBars = (mi, pct) => {
    const range = { from: Math.max(0, mi), to: Math.min(lastMi, mi) };
    setLoop(range);
    startPractice({ part: result?.part || defaultPracticePart(), mode: result?.mode || 'wait', speed: pct / 100, countIn: true, range });
  };

  const sendToTeacher = async () => {
    if (!assignment || !result) return;
    try {
      const r = await academy.submit(assignment.id, {
        accuracy: Math.round(result.accuracy * 1000) / 1000, timing: result.inTune ?? null, tempo_pct: Math.round(result.speed * 100),
        seconds: result.seconds || 0, bars: result.barsList.map((b) => Math.round(b.accuracy * 100) / 100),
        bar_numbers: result.barsList.map((b) => Number(b.bar) || 0),
      });
      toast(t('sentToTeacher'));
      if (r.submission?.reached_goal) addXP(30);
      setResult((x) => x && ({ ...x, sent: true }));
    } catch (e) { toast(e.message, 'err'); }
  };

  // start straight away when opened from Home ("Play Along" / "Listen")
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !perf || !start) return;
    started.current = true;
    setTimeout(() => (start === 'listen' ? play(null, { mode: 'listen' }) : openPlayAlong()), 350);
  }, [perf]);

  const playSheetChords = () => {
    const chords = sheetChords(tSheet);
    if (!chords.length) return;
    audioContext();
    if (!transport.current) transport.current = new Transport();
    const tempo = (tSheet.tempo || 90) * speed;
    const bar = 4 * 60 / tempo;
    const evs = [];
    chords.forEach((c, i) => {
      pianoVoicing(c, 3).map((m) => (m < 48 ? m + 12 : m)).forEach((m, j) => evs.push({ time: i * bar + j * 0.02, dur: bar * 0.95, midi: m, vel: 64, inst: 'guitar' }));
      evs.push({ time: i * bar, dur: bar, midi: 36 + rootPc(c), vel: 70, inst: 'bass' });
    });
    const tr = transport.current;
    tr.load(evs, chords.length * bar + 0.5);
    tr.setLoop(null);
    tr.onTime = (sec) => setPlayer({ playing: true, q: sec / bar, mi: Math.floor(sec / bar), mode: 'listen', chordIndex: Math.floor(sec / bar) });
    tr.onEnd = () => setPlayer({ playing: false, q: 0, mi: 0, mode: null });
    playStart.current = performance.now();
    tr.play(0);
  };

  const curKeyText = sheetKey ? keyName(sheetKey) : '';
  const showPlayer = !!tScore || (tSheet && sheetChords(tSheet).length);
  const flags = rec.aiFlags || [];
  const t0 = tScore ? timeAt(tScore, 0) : null;
  const handLabel = (c) => (c.hand === 'right' ? t('rightHand') : c.hand === 'left' ? t('leftHand') : c.name);

  return (
    <div class={`scroll${showPlayer ? ' has-player' : ''}`}>
      <NavBar title={meta.title} backLabel={assignment ? t('back') : t('library')} actions={<>
        <button type="button" onClick={() => updatePiece(meta.id, { favorite: !meta.favorite })} aria-label={t('favourite')} class={meta.favorite ? 't-yellow' : ''}><Icon name="star" size={22} fill={meta.favorite} /></button>
        <button type="button" onClick={() => openSheet('export', { pieceId: meta.id, semis, title: meta.title, part: sel.pi !== null ? sel : null, partLabel: sel.pi !== null ? handLabel(sel) : '' })} aria-label={t('export')}><Icon name="share" size={22} /></button>
      </>} />
      <div class="wrap" style={{ paddingTop: 12 }}>
        {assignment && (
          <div class="mission-banner">
            <Badge icon="flag" color="orange" size={32} />
            <div>
              <strong>{assignment.title}</strong>
              <span>{assignment.bars_from ? `${t('barsRange')} ${assignment.bars_from}–${assignment.bars_to || assignment.bars_from} · ` : ''}{t('goalT')} {assignment.goal ?? 80}%{assignment.due_at ? ` · ${dueText(assignment)}` : ''}</span>
            </div>
          </div>
        )}
        <div class="piece-head">
          <h1>{meta.title}</h1>
          {meta.composer && <span class="sub">{meta.composer}</span>}
          <div class="meta-chips">
            {curKeyText && <button type="button" class="meta" onClick={() => openSheet('keySheet', { pieceId: meta.id, semis, onPick: setSemis, keyText: curKeyText, originalKey: originalKey ? keyName(originalKey) : '' })}><span class="k">{t('key')}</span>{curKeyText}<Icon name="arrows" size={14} stroke={2.2} /></button>}
            {tScore?.measures[0]?.tempo && <span class="meta"><span class="k">♩</span>{Math.round(tScore.measures[0].tempo * speed)}</span>}
            {t0 && <span class="meta"><span class="k">{t('time')}</span>{t0.beats}/{t0.beatType}</span>}
            {tScore && <span class="meta"><Stars n={difficulty(tScore)} /></span>}
            {tScore && <span class="meta"><span class="k">{t('bars')}</span>{tScore.measures.length}</span>}
            <button type="button" class="meta" onClick={() => openSheet('details', { pieceId: meta.id, semis })}><Icon name="info" size={15} stroke={2.2} />{t('details')}</button>
          </div>
        </div>

        {tScore && (
          <div class="play-actions">
            <button type="button" class="big-play brand" onClick={openPlayAlong} id="play-along">
              <span class="ic"><Icon name="mic" size={24} stroke={2.3} /></span>
              <span><strong>{t('playAlong')}</strong><small>{t('playAlongSub')}</small></span>
            </button>
            <button type="button" class={`big-play soft${player.playing && player.mode === 'listen' ? ' on' : ''}`} onClick={toggleListen} id="listen-btn">
              <span class="ic"><Icon name={player.playing && player.mode === 'listen' ? 'pause' : 'speaker'} size={22} stroke={2.3} /></span>
              <span><strong>{player.playing && player.mode === 'listen' ? t('pause') : t('listen')}</strong><small>{t('listenSub')}</small></span>
            </button>
          </div>
        )}

        {choices.length > 0 && (
          <div class="part-row">
            <span class="sub" style={{ fontWeight: 600 }}>{t('part')}</span>
            <div class="chips">
              <Chip on={sel.pi === null} color="indigo" onClick={() => setPartSel('all')}>{t('allParts')}</Chip>
              {choices.map((c) => <Chip key={c.id} on={sel.id === c.id} color="indigo" onClick={() => setPartSel(c.id)}>{handLabel(c)}</Chip>)}
            </div>
          </div>
        )}

        {result && <ResultCard result={result} barNo={barNo} onPractise={practiseBars} onAgain={openPlayAlong} assignment={assignment} onSend={sendToTeacher} />}

        {flags.length > 0 && view === 'sheet' && (
          <Card>
            <div class="report-line"><Mascot mood="think" size={40} /><div><strong>{flags.length === 1 ? t('oneBarToCheck') : t('barsToCheck', { n: flags.length })}</strong>
              <div class="chips wrap" style={{ marginTop: 6 }}>{flags.slice(0, 12).map((f) => <Chip key={f.bar} color="orange" onClick={() => { goToBar(Math.max(0, f.bar - 1)); }}>{t('bar', { n: f.bar })}</Chip>)}</div></div></div>
          </Card>
        )}

        {rec.youtube && (
          <Card>
            <Row icon="video" color="red" title={t('watchHere')} subtitle={t('ytNote')} onClick={() => setYt(!yt)} chevron={false} />
            {yt && <div class="yt"><iframe src={`https://www.youtube-nocookie.com/embed/${rec.youtube}?rel=0&modestbranding=1&playsinline=1`} title="YouTube" allow="encrypted-media; picture-in-picture" allowFullScreen /></div>}
          </Card>
        )}

        {views.length > 1 && <Segmented id="piece-views" value={view} onChange={setView} options={views} />}

        {view === 'sheet' && xml && <SheetMusic xml={xml} boxRef={scoreBox} flagged={flags.map((f) => f.bar - 1)} changed={rec.changedIds}
          onFallback={() => setView('roll')} onTapId={(nid) => { const e = perf?.events.find((x) => x.ids.includes(nid)); if (e) goToBar(e.mi); }} />}
        {view === 'sheet' && tScore && <p class="note-text" style={{ textAlign: 'center' }}>{t('tapBarHint')}</p>}
        {view === 'roll' && perf && <PianoRoll score={tScore} perf={perf} q={player.q} harmonies={harmonies} />}
        {view === 'chords' && <ChordChart harmonies={harmonies} sheet={tSheet} keySig={sheetKey} suggested={!written.length && !!tScore} playingBar={player.playing ? player.mi + 1 : null} />}
        {view === 'lyrics' && tSheet && <LyricsView sheet={tSheet} playing={player.playing ? player.chordIndex : null} />}
        {view === 'pdf' && rec.pdf && <PdfPages bytes={rec.pdf} />}
        {view === 'original' && <OriginalPages rec={rec} />}

        {(harmonies.length > 0 || tScore) && (
          <List>
            {tScore && <Row icon="sparkles" color="purple" title={t('fromMySong')} subtitle={t('fromMySongSub')} onClick={() => { setState(() => ({ improvSource: { pieceId: meta.id, semis, vary: true } })); go('improvise'); }} />}
            {harmonies.length > 0 && <Row icon="chords" color="indigo" title={t('improviseOver')} onClick={() => { setState(() => ({ improvSource: { pieceId: meta.id, semis } })); go('improvise'); }} />}
          </List>
        )}
      </div>

      {showPlayer && (
        <div class="player c-pink">
          <div class="player-inner">
            {pa && <PracticeBanner pa={pa} f={follower.current} piano={['piano', 'keyboard'].includes(tScore?.parts[pa.sel.pi ?? 0]?.instrument)} keyFifths={sheetKey?.fifths || 0}
              onStop={() => { if (pa.mode === 'wait') finishWait(); else stop(); }} onSkip={() => { follower.current?.skip(); markNow(); if (follower.current?.done) finishWait(); }} />}
            {!pa && tScore && <>
              <div class="transport">
                <button type="button" class="tbtn" onClick={() => stepBar(-1)} aria-label="−1 bar"><Icon name="skipBack" size={20} stroke={2.2} /></button>
                <button type="button" class="play-btn" id="play-btn" onClick={toggleListen} aria-label={player.playing ? t('pause') : t('play')}>
                  <Icon name={player.playing ? 'pause' : 'play'} size={22} fill={!player.playing} stroke={player.playing ? 3 : 1.5} />
                </button>
                <button type="button" class="tbtn" onClick={() => stepBar(1)} aria-label="+1 bar"><Icon name="skipFwd" size={20} stroke={2.2} /></button>
                <div class="bar-pos"><strong class="num">{t('barOf', { n: barNo(curMi), m: tScore.measures.length })}</strong>
                  <span>{player.playing ? t('listening') : t('startAt')}</span></div>
              </div>
              <div class="transport2">
                <div class="speed-mini" role="group" aria-label={t('speed')}>
                  <button type="button" onClick={() => setSpeed((x) => Math.max(0.3, Math.round((x - 0.05) * 100) / 100))} aria-label="−5%"><Icon name="minus" size={16} stroke={2.6} /></button>
                  <button type="button" class="val num" onClick={() => setSpeed(1)} title={t('speed')}>{Math.round(speed * 100)}%</button>
                  <button type="button" onClick={() => setSpeed((x) => Math.min(1.5, Math.round((x + 0.05) * 100) / 100))} aria-label="+5%"><Icon name="plus" size={16} stroke={2.6} /></button>
                </div>
                <button type="button" class={`ptag${loop ? ' on' : ''}`} onClick={toggleLoop} aria-pressed={!!loop}><Icon name="loop" size={16} />{loop ? t('loopBars', { a: barNo(loop.from), b: barNo(loop.to) }) : t('loop')}</button>
                <button type="button" class={`ptoggle${metro ? ' on' : ''}`} onClick={() => setMetro(!metro)} aria-pressed={metro} aria-label={t('metronome')}><Icon name="metronome" size={19} /></button>
                <button type="button" class={`ptoggle${countIn ? ' on' : ''}`} onClick={() => setCountIn(!countIn)} aria-pressed={countIn} aria-label={t('countIn')}><span style={{ fontWeight: 800, fontSize: 12 }}>1·2</span></button>
                {harmonies.length > 0 && tScore.parts.length === 1 && <button type="button" class={`ptoggle${withChords ? ' on' : ''}`} onClick={() => setWithChords(!withChords)} aria-pressed={withChords} aria-label={t('viewChords')}><Icon name="piano" size={19} /></button>}
              </div>
            </>}
            {!pa && !tScore && (
              <div class="transport">
                <button type="button" class="play-btn" id="play-btn" onClick={() => (player.playing ? stop() : playSheetChords())} aria-label={player.playing ? t('pause') : t('play')}>
                  <Icon name={player.playing ? 'pause' : 'play'} size={22} fill={!player.playing} stroke={player.playing ? 3 : 1.5} />
                </button>
                <div class="bar-pos"><strong>{meta.title}</strong><span>{t('viewChords')}</span></div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PracticeBanner({ pa, f, piano, keyFifths, onStop, onSkip }) {
  const cur = f?.current;
  const name = (m) => pitchName(spellMidi(m, keyFifths));
  return (
    <div class="pa-banner">
      <div class="pa-top">
        <Mascot mood={pa.msg ? 'think' : 'listen'} size={44} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {pa.mode === 'wait' && cur
            ? (pa.msg ? <strong class="t-orange">{t('youPlayed', { a: name(pa.msg.played), b: name(pa.msg.want) })}</strong> : <strong>{t('playNote', { n: name(cur.top) })}</strong>)
            : <strong>{t('listening')}</strong>}
          <div class="sub">{pa.mode === 'wait' ? `${t('waitForMe')} · ${Math.min(pa.k ?? 0, pa.n ?? 0)}/${pa.n ?? 0}` : t('keepBeat')}</div>
        </div>
        {pa.mode === 'wait' && <button type="button" class="ptag" onClick={onSkip}>{t('next')}</button>}
        <button type="button" class="play-btn stop" onClick={onStop} aria-label={t('stop')}><Icon name="stop" size={18} fill stroke={1.5} /></button>
      </div>
      {pa.mode === 'wait' && piano && cur && <MiniKeys want={cur.midis} played={pa.msg?.played} />}
    </div>
  );
}

/** Two octaves of keys around the note to play: blue = play this, orange = what was heard. */
function MiniKeys({ want, played }) {
  const lo = Math.max(36, Math.min(...want, played ?? 200) - 5);
  const start = lo - (((lo % 12) + 12) % 12);                     // start on a C
  const marks = new Map();
  want.forEach((m) => marks.set(m, 'mark'));
  if (played !== undefined && played !== null && !want.includes(played)) marks.set(played, 'hl');
  return <div class="kbd-wrap"><Keyboard lo={start} hi={start + 24} marks={marks} height={58} /></div>;
}

function ResultCard({ result, barNo, onPractise, onAgain, assignment, onSend }) {
  const acc = Math.round(result.accuracy * 100);
  const good = acc >= 85;
  const next = Math.min(150, Math.round(result.speed * 100) + 10);
  return (
    <Card class="result fade-up">
      {good && <Confetti />}
      <div class="report-line" style={{ alignItems: 'center' }}>
        <Mascot mood={good ? 'cheer' : acc >= 60 ? 'happy' : 'sad'} size={64} />
        <div style={{ flex: 1 }}>
          <strong style={{ fontSize: 20 }}>{good ? t('wellPlayed') : t('keepAtIt')}</strong>
          <div class="sub">{t('rightNotes')}: <b class="num">{acc}%</b> · {result.right}/{result.total}{result.inTune !== undefined && result.mode === 'beat' ? ` · ${t('inTune')} ${Math.round(result.inTune * 100)}%` : ''}</div>
        </div>
        <span class="big-score num">{acc}%</span>
      </div>
      {result.barsList?.length > 1 && (
        <div class="bar-strip" aria-hidden="true">{result.barsList.map((b) => <i key={b.bar} title={`${b.bar}`} style={{ '--a': b.accuracy }} class={b.accuracy >= 0.85 ? 'ok' : b.accuracy >= 0.6 ? 'mid' : 'low'} />)}</div>
      )}
      {result.tricky?.length > 0 && <>
        <div class="sub" style={{ fontWeight: 700 }}>{t('trickySpots')}</div>
        {result.tricky.map((x) => (
          <div class="tricky-row" key={x.mi}>
            <span class="n">{t('bar', { n: barNo(x.mi) })}</span>
            <span class="sub" style={{ flex: 1 }}>{t('missedNotes', { n: x.missed })}</span>
            <Button small kind="secondary" color="orange" icon="loop" onClick={() => onPractise(x.mi, Math.max(40, Math.round(result.speed * 100) - 20))}>{t('loopAt', { p: Math.max(40, Math.round(result.speed * 100) - 20) })}</Button>
          </div>
        ))}
      </>}
      <div class="btn-row">
        <Button small icon="mic" color="pink" onClick={onAgain}>{good && next > Math.round(result.speed * 100) ? t('tryAt', { p: next }) : t('tryAgain')}</Button>
        {assignment && <Button small icon="send" kind="brand" onClick={onSend} disabled={result.sent}>{result.sent ? t('sentToTeacher') : t('submitToTeacher')}</Button>}
      </div>
    </Card>
  );
}

function SheetMusic({ xml, boxRef, onTapId, onFallback, flagged = [], changed = null }) {
  const [state, setState2] = useState({ loading: true, pages: [], error: null, first: !isVerovioReady() });
  const wrapRef = useRef(null);
  useEffect(() => {
    let alive = true;
    const width = Math.min(980, (wrapRef.current?.clientWidth || 360));
    setState2((x) => ({ ...x, loading: true }));
    renderMusicXML(xml, { width, scale: width < 500 ? 34 : 40 })
      .then((r) => { if (alive) setState2({ loading: false, pages: r.pages, error: null }); })
      .catch((e) => { if (alive) setState2({ loading: false, pages: [], error: e.message }); });
    return () => { alive = false; };
  }, [xml]);
  useEffect(() => {
    const box = boxRef.current;
    if (!box || state.loading) return;
    const ms = box.querySelectorAll('g.measure');
    flagged.forEach((i) => ms[i]?.classList.add('flagged'));
    if (changed) for (const nid of changed) box.querySelector(`[id="${nid}"]`)?.classList.add('changed');
  }, [state.pages, flagged.join(','), changed]);
  const onClick = (e) => {
    const g = e.target.closest?.('g.note');
    if (g?.id) onTapId?.(g.id);
  };
  return (
    <div ref={wrapRef}>
      {state.loading && <div class="loading"><Mascot mood="think" size={70} />{state.first ? t('loadingEngine') : ''}</div>}
      {state.error && (
        <Card>
          <p>{t('engineFailed')}</p>
          {onFallback && <Button kind="secondary" icon="piano" onClick={onFallback}>{t('viewRoll')}</Button>}
        </Card>
      )}
      <div class="score-box vrv" ref={boxRef} onClick={onClick} hidden={state.loading && !state.pages.length}
        dangerouslySetInnerHTML={{ __html: state.pages.join('') }} />
    </div>
  );
}

function OriginalPages({ rec }) {
  if (rec.pdf) return <PdfPages bytes={rec.pdf} />;
  return <div class="pdf-pages">{(rec.photos || []).map((src, i) => <img key={i} src={src} alt={`${i + 1}`} style={{ width: '100%', borderRadius: 10, background: '#fff' }} />)}</div>;
}

const PART_COLORS = ['pink', 'blue', 'green', 'orange', 'purple', 'teal'];
export function PianoRoll({ score, perf = null, q: qNow = 0, harmonies = [] }) {
  const evs = useMemo(() => perfOf(score, { repeats: false }).events, [score]);
  const ref = useRef(null);
  const pxq = 34;
  // written position of the playhead
  const span = perf?.spans.find((x) => x.t.num() <= qNow && x.t.add(x.dur).num() > qNow);
  const wq = span ? score.measures[span.mi].start.num() + (qNow - span.t.num()) : 0;
  useEffect(() => {
    const el = ref.current;
    if (el && span) { const x = 30 + wq * pxq; if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 80) el.scrollLeft = x - el.clientWidth * 0.3; }
  }, [Math.floor(wq)]);
  if (!evs.length) return null;
  const lo = Math.min(...evs.map((e) => e.midi)) - 2, hi = Math.max(...evs.map((e) => e.midi)) + 2;
  const total = score.measures.reduce((s, m) => s + m.dur.num(), 0);
  const row = Math.max(6, Math.min(12, 260 / (hi - lo + 1)));
  const W = total * pxq + 40, H = (hi - lo + 1) * row + 28;
  const y = (m) => 22 + (hi - m) * row;
  return (
    <div class="roll" ref={ref}>
      <svg width={W} height={H}>
        {Array.from({ length: hi - lo + 1 }, (_, i) => hi - i).filter((m) => m % 12 === 0).map((m) => <g key={m}><line x1="30" x2={W} y1={y(m) + row} y2={y(m) + row} class="grid-line" /><text x="2" y={y(m) + row - 2} class="label">C{Math.floor(m / 12) - 1}</text></g>)}
        {score.measures.map((m, i) => <g key={i}><line x1={30 + m.start.num() * pxq} x2={30 + m.start.num() * pxq} y1="16" y2={H} class="bar-line" /><text x={33 + m.start.num() * pxq} y="12" class="label">{m.number}</text></g>)}
        {harmonies.map((h, i) => <text key={'h' + i} x={33 + (score.measures[h.mi].start.num() + h.off.num()) * pxq} y={H - 4} class="chord-label">{formatChord(h.chord)}</text>)}
        {evs.map((e, i) => {
          const on = span && e.t.num() <= wq && wq < e.t.num() + e.dur.num();
          return <rect key={i} class={`n f-${PART_COLORS[e.pi % PART_COLORS.length]}${on ? ' on' : ''}`} x={30 + e.t.num() * pxq + 1} y={y(e.midi) + 1} width={Math.max(3, e.dur.num() * pxq - 2)} height={row - 1.5} rx="3" opacity={on ? 1 : 0.82} />;
        })}
        {span && <line x1={30 + wq * pxq} x2={30 + wq * pxq} y1="14" y2={H} class="playhead" />}
      </svg>
    </div>
  );
}

function ChordChart({ harmonies, sheet, keySig, suggested, playingBar }) {
  const lang = getLang();
  const items = harmonies.length
    ? harmonies.map((h) => ({ chord: h.chord, bar: h.mi + 1 }))
    : sheetChords(sheet).map((c, i) => ({ chord: c, bar: null, i }));
  const k = keySig || { fifths: 0, mode: 'major' };
  return (
    <div class="section">
      {suggested && <p class="note-text"><Icon name="sparkles" size={14} /> {t('suggestedChords')}</p>}
      <div class="chord-grid">
        {items.map((it, i) => {
          if (!it.chord || it.chord.nc) return <div key={i} class="chord-cell"><span class="nm">N.C.</span></div>;
          const rn = romanNumeral(it.chord, k);
          return (
            <button type="button" key={i} class={`chord-cell fn-${rn.func}${playingBar && it.bar === playingBar ? ' on' : ''}`} onClick={() => openSheet('chord', { chord: it.chord, keySig: k })}>
              <span class="nm">{formatChord(it.chord)}</span>
              <span class="rn">{rn.text}</span>
              {it.bar && <span class="bar">{t('bar', { n: it.bar })}</span>}
            </button>
          );
        })}
      </div>
      <div class="legend"><span class="fn-T">T</span><span class="fn-S">S</span><span class="fn-D">D</span><span class="fn-V">V/x</span><span class="fn-B">♭ / borrowed</span></div>
      <p class="note-text">{t('tapChord')}</p>
      {void lang}
    </div>
  );
}

/**
 * Regroup chord/lyric segments into words so a line wraps only between words, never inside one,
 * and syllables without a chord change are merged (no gaps inside "lit-tle").
 * Returns words: [[{chord, text}, ...], ...] where every piece but the last in a word ends mid-word.
 */
export function lyricWords(segs) {
  const atoms = [];
  for (const g of segs) {
    const pieces = (g.text || '').match(/\S+\s*|\s+/g) || [''];
    pieces.forEach((tx, i) => atoms.push({ chord: i === 0 ? g.chord : null, text: tx }));
  }
  const words = [];
  let cur = [];
  for (const a of atoms) {
    const last = cur[cur.length - 1];
    if (last && !a.chord) last.text += a.text;
    else cur.push({ ...a });
    if (!a.text || /\s$/.test(a.text)) { words.push(cur); cur = []; }
  }
  if (cur.length) words.push(cur);
  return words;
}

function LyricsView({ sheet }) {
  return (
    <div class="lyrics">
      {sheet.sections.map((sec, i) => (
        <div key={i} class={`c-${sec.kind === 'chorus' ? 'pink' : sec.kind === 'bridge' ? 'purple' : sec.kind === 'intro' || sec.kind === 'outro' ? 'teal' : 'blue'}`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sec.label && <div class="sec-label" style={{ color: 'var(--c)' }}>{sec.label}</div>}
          {sec.lines.map((l, j) => {
            if (l.type === 'comment') return <div key={j} class="note-text"><em>{l.text}</em></div>;
            if (l.type === 'tab') return <pre key={j} style={{ margin: 0, fontSize: 12, overflowX: 'auto' }}>{l.text}</pre>;
            if (l.type === 'chords') return <div key={j} class="chords-only">{l.segs.map((g, k) => <button type="button" key={k} onClick={() => openSheet('chord', { chord: g.chord, keySig: sheet.key })}>{formatChord(g.chord)}</button>)}</div>;
            return (
              <div key={j} class="lyric-line">
                {lyricWords(l.segs).map((w, k) => (
                  <span key={k} class="word">
                    {w.map((g, m) => (
                      <span key={m} class={`seg${m < w.length - 1 ? ' mid' : ''}`}>
                        <span class="ch" onClick={() => g.chord && openSheet('chord', { chord: g.chord, keySig: sheet.key })}>{g.chord ? formatChord(g.chord) : ''}</span>
                        <span class="tx">{g.text || (g.chord ? ' ' : '')}</span>
                      </span>
                    ))}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function PdfPages({ bytes }) {
  const ref = useRef(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const doc = await openPdf(bytes);
        const box = ref.current;
        if (!box) return;
        box.innerHTML = '';
        for (let i = 1; i <= Math.min(doc.numPages, 20); i++) {
          if (!alive) return;
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: Math.min(2, (box.clientWidth * (devicePixelRatio || 1)) / page.getViewport({ scale: 1 }).width) });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width; canvas.height = vp.height;
          box.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        }
      } catch (e) { if (alive) setErr(e.message); }
    })();
    return () => { alive = false; };
  }, [bytes]);
  return <div>{err && <div class="loading">{err}</div>}<div class="pdf-pages" ref={ref}><div class="loading"><div class="spinner" /></div></div></div>;
}

function InfoCard({ tScore, sheet, keySig, originalKey, harmonies }) {
  const lang = getLang();
  const range = tScore ? pitchRange(tScore, 0) : null;
  const chords = harmonies.length ? harmonies.map((h) => h.chord) : sheet ? sheetChords(sheet) : [];
  const uniq = [];
  for (const c of chords) { const n = formatChord(c); if (c && !c.nc && !uniq.some((x) => formatChord(x) === n)) uniq.push(c); }
  const capo = chords.length ? capoOptions(chords)[0] : null;
  const k = keySig || { fifths: 0, mode: 'major' };
  return (
    <Card>
      <dl class="kv">
        {keySig && <><dt>{t('key')}</dt><dd>{keyName(keySig, { long: true })}</dd></>}
        {originalKey && keySig && keyName(originalKey) !== keyName(keySig) && <><dt>{t('originalKey')}</dt><dd>{keyName(originalKey, { long: true })}</dd></>}
        {tScore?.measures[0]?.tempo && <><dt>{t('tempo')}</dt><dd class="num">♩ = {tScore.measures[0].tempo}</dd></>}
        {tScore && <><dt>{t('time')}</dt><dd>{timeAt(tScore, 0).beats}/{timeAt(tScore, 0).beatType}</dd></>}
        {range && <><dt>{t('range')}</dt><dd>{pitchName(spellMidi(range.lo, k.fifths))} – {pitchName(spellMidi(range.hi, k.fifths))}</dd></>}
        {tScore && <><dt>{t('difficulty')}</dt><dd><Stars n={difficulty(tScore)} /></dd></>}
        {tScore && <><dt>{t('bars')}</dt><dd class="num">{tScore.measures.length}</dd></>}
      </dl>
      {uniq.length > 0 && <>
        <div class="sub" style={{ fontWeight: 600 }}>{t('chordsUsed')}</div>
        <div class="chips wrap">{uniq.map((c, i) => { const rn = romanNumeral(c, k); return <button type="button" key={i} class={`chip fn-${rn.func}`} onClick={() => openSheet('chord', { chord: c, keySig: k })} style={{ borderLeft: '4px solid var(--c)' }}><strong>{formatChord(c)}</strong> <span class="sub">{rn.text}</span></button>; })}</div>
        {capo && <p class="note-text"><Icon name="guitar" size={14} /> {capo.capo ? t('capoHint', { n: capo.capo, shapes: capo.names.join(' ') }) : t('noCapoNeeded')}</p>}
      </>}
      {void lang}
    </Card>
  );
}

// ---------- sheets ----------

export function ChordSheet({ chord, keySig }) {
  const s = useApp();
  const [inst, setInst] = useState(s.settings.chordView || 'guitar');
  const notes = chordNotes(chord).map((n) => n.step + (n.alter > 0 ? '♯'.repeat(n.alter) : n.alter < 0 ? '♭'.repeat(-n.alter) : ''));
  const rn = keySig ? romanNumeral(chord, keySig) : null;
  const strum = () => {
    const ctx = audioContext();
    const v = inst === 'piano' ? pianoVoicing(chord, 4) : null;
    const t0 = ctx.currentTime + 0.05;
    if (v) v.forEach((m) => note(t0, m, 1.6, 80, 'piano'));
    else {
      const tun = inst === 'ukulele' ? [67, 60, 64, 69] : [40, 45, 50, 55, 59, 64];
      import('../../core/chords.js').then(({ fretShapes }) => {
        const sh = fretShapes(chord, inst, 1)[0];
        if (!sh) return;
        sh.frets.forEach((f, i) => { if (f >= 0) note(t0 + i * 0.035, tun[i] + f, 1.8, 76, 'guitar'); });
      });
    }
  };
  return (
    <SheetFrame title={formatChord(chord)}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ font: '800 44px var(--round)' }}>{formatChord(chord)}</div>
        {rn && <div class="sub">{rn.text} {keySig ? `· ${keyName(keySig)}` : ''}</div>}
        <div style={{ marginTop: 6, fontWeight: 600 }}>{t('notes')}: {notes.join(' · ')}</div>
      </div>
      <Segmented value={inst} onChange={(v) => setInst(v)} options={[{ value: 'guitar', label: t('guitar') }, { value: 'ukulele', label: t('ukulele') }, { value: 'piano', label: t('piano') }]} />
      <Card>
        {inst === 'piano' ? <PianoChord chord={chord} /> : (
          <div class="diagram-row" style={{ justifyContent: 'center' }}>
            {[0, 1, 2].map((i) => <figure key={i}><FretDiagram chord={chord} instrument={inst} index={i} width={i ? 92 : 120} /><figcaption>{i === 0 ? '★' : `${i + 1}`}</figcaption></figure>)}
          </div>
        )}
      </Card>
      <Button icon="speaker" onClick={strum} color="purple" full>{t('play')}</Button>
    </SheetFrame>
  );
}

export function FindKeySheet({ pieceId, semis, onPick }) {
  const s = useApp();
  const [data, setData] = useState(null);
  const [voice, setVoice] = useState(s.settings.voice || 'tenor');
  useEffect(() => { getPiece(pieceId).then(setData); }, [pieceId]);
  if (!data) return <SheetFrame title={t('findMyKey')}><div class="loading"><div class="spinner" /></div></SheetFrame>;
  const range = data.score ? pitchRange(data.score, data.score.parts.findIndex((p) => p.instrument === 'voice') >= 0 ? data.score.parts.findIndex((p) => p.instrument === 'voice') : 0) : null;
  const vr = s.settings.voiceRange || VOICE_RANGES[voice];
  const key = data.score ? concertKey(data.score) : data.sheet?.key;
  const opts = range ? bestKeys(range, vr, key).slice(0, 5) : [];
  const fmt = (m) => pitchName(spellMidi(m, key?.fifths || 0));
  return (
    <SheetFrame title={t('findMyKey')}>
      <List>
        <Row title={t('voiceType')} right={<select id="fk-voice" value={voice} onChange={(e) => setVoice(e.currentTarget.value)}>{['soprano', 'mezzo', 'alto', 'tenor', 'baritone', 'bass'].map((v) => <option key={v} value={v}>{t(v === 'bass' ? 'bassVoice' : v)}</option>)}</select>} />
        <Row title={t('yourRange', { lo: fmt(vr.lo), hi: fmt(vr.hi) })} />
        {range && <Row title={t('range')} detail={`${fmt(range.lo)} – ${fmt(range.hi)}`} />}
      </List>
      {!range && <p class="note-text">{t('chordSheets')}: {t('key')} ±</p>}
      <List>
        {opts.map((o) => (
          <Row key={o.semis} icon={o.fits ? 'check' : 'info'} color={o.fits ? 'green' : 'orange'} title={`${keyName(o.key)}  (${o.semis > 0 ? '+' : ''}${o.semis})`}
            subtitle={o.fits ? `${fmt(range.lo + o.semis)} – ${fmt(range.hi + o.semis)}` : `${o.over ? '↑' + o.over : ''} ${o.under ? '↓' + o.under : ''}`}
            detail={o.semis === semis ? '✓' : ''} onClick={() => { onPick?.(o.semis); closeSheet(); }} />
        ))}
      </List>
    </SheetFrame>
  );
}


export function ExportSheet({ pieceId, semis, title, part = null, partLabel = '' }) {
  const [busy, setBusy] = useState(null);
  const [onlyPart, setOnlyPart] = useState(!!part);
  const [d, setD] = useState(null);
  useEffect(() => { getPiece(pieceId).then(setD); }, [pieceId]);
  const safe = (title || 'Haptune').replace(/[\\/:*?"<>|]+/g, ' ').trim();
  const suffix = onlyPart && part ? ` (${partLabel})` : '';
  const scoreNow = () => { let sc = transposeScore(d.score, semis); if (onlyPart && part) sc = extractPart(sc, part.pi, part.staff); return sc; };
  const textOf = () => {
    if (d.sheet) return toChordPro(transposeSheet(d.sheet, semis));
    const sc = transposeScore(d.score, semis);
    const sheet = scoreToSheet(sc, harmonyList(sc));
    return sheet ? toChordsOverLyrics({ ...sheet, title: sc.title, key: concertKey(sc) }) : '';
  };
  const run = async (kind) => {
    setBusy(kind);
    try {
      let ok = false;
      if (kind === 'musicxml') ok = await saveFile(`${safe}${suffix}.musicxml`, writeMusicXML(scoreNow()));
      else if (kind === 'midi') ok = await saveFile(`${safe}${suffix}.mid`, writeMIDI(scoreNow()));
      else if (kind === 'print') { await printScore(writeMusicXML(scoreNow()), safe + suffix); ok = true; }
      else if (kind === 'text') ok = await saveFile(`${safe} (chords and lyrics).txt`, textOf());
      else if (kind === 'pdf') ok = await saveFile(`${safe}.pdf`, new Uint8Array(d.rec.pdf));
      else if (kind === 'zip') {
        const files = [];
        if (d.score) {
          files.push({ name: `${safe}${suffix}.musicxml`, data: writeMusicXML(scoreNow()) });
          files.push({ name: `${safe}${suffix}.mid`, data: writeMIDI(scoreNow()) });
        }
        const txt = textOf();
        if (txt) files.push({ name: `${safe} (chords and lyrics).txt`, data: txt });
        if (d.rec.pdf) files.push({ name: `${safe}.pdf`, data: new Uint8Array(d.rec.pdf) });
        ok = await saveFile(`${safe}.zip`, writeZip(files));
      }
      if (ok && kind !== 'print') toast(t('export') + ' ✓');
    } catch (e) { toast(e.message || String(e), 'err'); }
    setBusy(null);
  };
  if (!d) return <SheetFrame title={t('export')}><div class="loading"><div class="spinner" /></div></SheetFrame>;
  const hasText = !!(d.sheet || (d.score && scoreToSheet(d.score, harmonyList(d.score))));
  const row = (kind, icon, color, title2, sub) => (
    <Row key={kind} icon={icon} color={color} title={title2} subtitle={busy === kind ? '…' : sub} onClick={() => !busy && run(kind)} />
  );
  return (
    <SheetFrame title={t('export')}>
      {semis !== 0 && <p class="note-text">{t('exportInKey', { key: `${semis > 0 ? '+' : ''}${semis}` })}</p>}
      {part && <List><Row icon="users" color="indigo" title={t('exportPartOnly', { p: partLabel })} right={<Toggle id="exp-part" checked={onlyPart} onChange={setOnlyPart} label={t('exportPartOnly', { p: partLabel })} />} /></List>}
      <Section title={t('exportAs')}>
        <List>
          {d.score && row('musicxml', 'doc', 'blue', 'MusicXML', 'MuseScore · Finale · Dorico · Sibelius')}
          {d.score && row('midi', 'piano', 'green', 'MIDI', 'GarageBand · Logic · any keyboard')}
          {d.score && row('print', 'print', 'purple', t('exportPrint'), 'PDF')}
          {hasText && row('text', 'chords', 'orange', t('exportText'), '.txt')}
          {d.rec.pdf && row('pdf', 'doc', 'red', t('originalPage'), 'PDF')}
          {row('zip', 'folder', 'gray', t('exportAll'), '.zip')}
        </List>
      </Section>
      <p class="note-text">{t('exportHelp')}</p>
    </SheetFrame>
  );
}

export function PlayAlongSheet({ choices = [], part, mode = 'wait', speed = 1, countIn = true, onStart, mission = null }) {
  const [p, setP] = useState(part);
  const [m, setM] = useState(mode);
  const [sp, setSp] = useState(speed);
  const [ci, setCi] = useState(countIn);
  const label = (c) => (c.hand === 'right' ? t('rightHand') : c.hand === 'left' ? t('leftHand') : c.name);
  return (
    <SheetFrame title={t('playAlong')}>
      <div class="with-mascot"><Mascot mood="listen" size={56} /><div class="bubble left">{mission ? `${mission.title} · ${t('goalT')} ${mission.goal ?? 80}%` : t('playAlongSub')}</div></div>
      {choices.length > 0 && (
        <Section title={t('youPlay')}>
          <div class="choice-chips">{choices.map((c) => <Chip key={c.id} on={p === c.id} color="pink" onClick={() => setP(c.id)}>{label(c)}</Chip>)}</div>
          <p class="note-text">{t('restPlaysAlong')}</p>
        </Section>
      )}
      <div class="mode-cards" role="radiogroup">
        {[['wait', 'waitForMe', 'waitForMeSub', 'pause'], ['beat', 'keepBeat', 'keepBeatSub', 'metronome']].map(([id, a, b, ic]) => (
          <button type="button" key={id} role="radio" aria-checked={m === id} class={`mode-card${m === id ? ' on' : ''}`} onClick={() => setM(id)}>
            <Icon name={ic} size={22} stroke={2.2} /><strong>{t(a)}</strong><span>{t(b)}</span>
          </button>
        ))}
      </div>
      <Stepper label={t('speed')} value={`${Math.round(sp * 100)}%`} onDec={() => setSp((x) => Math.max(0.3, Math.round((x - 0.05) * 100) / 100))} onInc={() => setSp((x) => Math.min(1.5, Math.round((x + 0.05) * 100) / 100))} />
      <List><Row icon="metronome" color="teal" title={t('countIn')} right={<Toggle id="pa-ci" checked={ci} onChange={setCi} label={t('countIn')} />} /></List>
      <p class="note-text" style={{ display: 'flex', gap: 8 }}><Icon name="watch" size={18} />{t('buzzHint')}</p>
      <Button kind="brand" full icon="play" onClick={() => onStart?.({ part: p, mode: m, speed: sp, countIn: ci })}>{t('start')}</Button>
    </SheetFrame>
  );
}

export function KeySheet({ pieceId, semis, onPick }) {
  const [sv, setSv] = useState(semis);
  const [d, setD] = useState(null);
  useEffect(() => { getPiece(pieceId).then(setD); }, [pieceId]);
  const set = (v) => { const x = clamp(v, -11, 11); setSv(x); onPick?.(x); };
  const keyOf = (v) => {
    if (!d) return '';
    if (d.score) return keyName(concertKey(transposeScore(d.score, v)));
    if (d.sheet?.key) return keyName(transposeSheet(d.sheet, v).key);
    return '';
  };
  const orig = keyOf(0);
  return (
    <SheetFrame title={t('key')}>
      <div class="keybar c-green">
        <Stepper label={t('key')} value={keyOf(sv) || '—'} sub={sv ? `${sv > 0 ? '+' : ''}${sv} · ${t('originalKey')} ${orig}` : t('originalKey')} onDec={() => set(sv - 1)} onInc={() => set(sv + 1)} />
      </div>
      <div class="btn-row">
        {sv !== 0 && <Button kind="secondary" icon="loop" onClick={() => set(0)}>{t('originalKey')}</Button>}
        <Button kind="secondary" icon="mic" color="purple" onClick={() => openSheet('findKey', { pieceId, semis: sv, onPick: (v) => { onPick?.(v); } })}>{t('findMyKey')}</Button>
      </div>
      <Button full onClick={closeSheet}>{t('done')}</Button>
    </SheetFrame>
  );
}

export function DetailsSheet({ pieceId, semis }) {
  const s = useApp();
  const [d, setD] = useState(null);
  useEffect(() => { getPiece(pieceId).then(setD); }, [pieceId]);
  const meta = s.pieces.find((p) => p.id === pieceId);
  if (!d || !meta) return <SheetFrame title={t('details')}><div class="loading"><div class="spinner" /></div></SheetFrame>;
  const tScore = d.score ? transposeScore(d.score, semis) : null;
  const hs = tScore ? harmonyList(tScore) : [];
  const tSheet = d.sheet ? transposeSheet(d.sheet, semis) : null;
  const keySig = tSheet?.key || (tScore ? concertKey(tScore) : null);
  return (
    <SheetFrame title={t('details')}>
      <InfoCard tScore={tScore} sheet={tSheet} keySig={keySig} originalKey={d.score ? concertKey(d.score) : d.sheet?.key} harmonies={hs.length ? hs : (tScore ? suggestChords(tScore) : [])} />
      {(d.rec.license || d.rec.sourceUrl) && (
        <List>
          {d.rec.license && <Row icon="info" color="blue" title={d.rec.license} />}
          {d.rec.sourceUrl && <a class="row" href={d.rec.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}><span class="row-main"><span class="row-title">{t('openPage')}</span><span class="row-sub">{d.rec.sourceUrl}</span></span><Icon name="share" size={16} style={{ opacity: 0.4 }} /></a>}
        </List>
      )}
      <List>
        <Row icon="share" color="blue" title={t('export')} subtitle="MusicXML · MIDI · PDF" onClick={() => openSheet('export', { pieceId, semis, title: meta.title })} />
        <Row icon="trash" color="red" title={t('delete')} danger onClick={async () => { await deletePiece(pieceId); closeSheet(); pop('library'); }} />
      </List>
    </SheetFrame>
  );
}

export { scoreToSheet, harmonyList, saveFile };
