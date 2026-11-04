import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { useApp, getPiece, updatePiece, deletePiece, markOpened, pop, openSheet, closeSheet, toast, logMinutes, recordTake, go, awardBadge, getState, setState } from '../state.js';
import { t, getLang, instrumentName } from '../../core/i18n.js';
import { Icon, Card, Section, List, Row, Segmented, Stepper, Button, Chip, Stars, FretDiagram, PianoChord, Keyboard, Badge } from '../components.jsx';
import { NavBar, SheetFrame } from './common.jsx';
import { renderMusicXML, isVerovioReady } from '../verovio.js';
import { openPdf } from '../importer.js';
import { Transport, audioContext, note, listen } from '../audio.js';
import { writeMusicXML } from '../../core/musicxml.js';
import { writeMIDI } from '../../core/midi.js';
import { writeZip } from '../../core/zip.js';
import { transposeScore, performance as perfOf, secondsAt, quartersAt, chordTrack, concertKey, pitchRange, timeAt, measureLength, beatLength } from '../../core/score.js';
import { transposeSheet, toChordPro, toChordsOverLyrics, sheetChords, sheetInfo } from '../../core/chordsheet.js';
import { keyName, transposeInterval, transposeKey, midiOf, spellMidi, pitchName } from '../../core/pitch.js';
import { formatChord, romanNumeral, chordNotes, capoOptions, pianoVoicing, chordPcs, rootPc } from '../../core/chords.js';
import { suggestChords, difficulty, bestKeys, VOICE_RANGES } from '../../core/analysis.js';
import { q, ZERO } from '../../core/q.js';

export const SOUND = { violin: 'strings', viola: 'strings', cello: 'strings', erhu: 'strings', doublebass: 'bass', voice: 'piano', flute: 'flute', recorder: 'flute', dizi: 'flute',
  clarinet: 'clarinet', sax: 'clarinet', trumpet: 'flute', piano: 'piano', keyboard: 'piano', organ: 'organ', guitar: 'guitar', ukulele: 'guitar', bassguitar: 'bass', harp: 'piano', guzheng: 'guitar' };

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

const MIME = { zip: 'application/zip', json: 'application/json', txt: 'text/plain', pdf: 'application/pdf' };

/** Save a generated file: through Claude's download prompt in the preview, as a normal download in the app. */
async function saveFile(name, bytes) {
  const blob = new Blob([bytes], { type: MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream' });
  let dl = null;
  try { dl = await globalThis.claude?.use?.('downloads'); } catch { dl = null; }
  if (dl) {
    try { await dl.save({ filename: name, data: blob }); return true; } catch (e) {
      if (e?.code !== 'declined') toast(t('saveFailed'), 'err');
      return false;
    }
  }
  if (globalThis.HAPTUNE_CONFIG?.pwa === false) { toast(t('saveFailed'), 'err'); return false; } // plain links are inert in the preview
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
  return true;
}

// ---------- the piece screen ----------

export function PieceView({ id, active }) {
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
  if (!data) return <div class="scroll"><NavBar title={meta.title} backLabel={t('library')} /><div class="loading"><div class="spinner" /></div></div>;
  return <PieceBody meta={meta} data={data} semis={semis} setSemis={(v) => { setSemis(v); updatePiece(id, { transpose: v }); if (v) awardBadge('transposer'); }} view={view} setView={setView} active={active} />;
}

function PieceBody({ meta, data, semis, setSemis, view, setView, active }) {
  const s = useApp();
  const lang = getLang();
  const { score, sheet: baseSheet, rec } = data;
  const tScore = useMemo(() => (score ? transposeScore(score, semis) : null), [score, semis]);
  const xml = useMemo(() => (tScore ? writeMusicXML(tScore) : null), [tScore]);
  const written = useMemo(() => (tScore ? harmonyList(tScore) : []), [tScore]);
  const suggested = useMemo(() => (tScore && !written.length ? suggestChords(tScore).map((x) => ({ ...x, suggested: true })) : []), [tScore, written.length]);
  const harmonies = written.length ? written : suggested;
  const key = tScore ? concertKey(tScore) : null;
  const tSheet = useMemo(() => (baseSheet ? transposeSheet(baseSheet, semis) : tScore ? scoreToSheet(tScore, harmonies) : null), [baseSheet, semis, tScore, harmonies]);
  const sheetKey = tSheet?.key || key;
  const originalKey = score ? concertKey(score) : baseSheet?.key;
  const views = [];
  if (tScore) views.push({ value: 'sheet', label: t('viewSheet') }, { value: 'roll', label: t('viewRoll') });
  if (rec.kind === 'pdf') views.push({ value: 'pdf', label: t('viewPdf') });
  if (harmonies.length || (tSheet && sheetChords(tSheet).length)) views.push({ value: 'chords', label: t('viewChords') });
  if (tSheet && tSheet.sections?.some((sec) => sec.lines.some((l) => l.segs?.some((g) => g.text.trim())))) views.push({ value: 'lyrics', label: t('viewLyrics') });
  if (!views.some((v) => v.value === view) && views[0]) setTimeout(() => setView(views[0].value), 0);
  const [player, setPlayer] = useState({ playing: false, q: 0, bar: 1 });
  const transport = useRef(null);
  const scoreBox = useRef(null);
  const lit = useRef([]);
  const [speed, setSpeed] = useState(1);
  const [metro, setMetro] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [loop, setLoop] = useState(false);
  const [withChords, setWithChords] = useState(true);
  const playStart = useRef(0);
  const builtRef = useRef(null);
  const micStop = useRef(null);
  const frames = useRef([]);
  const practiceOn = useRef(false);
  const lastQ = useRef(0);
  const [practice, setPractice] = useState(null);
  const perf = useMemo(() => (tScore ? perfOf(tScore, { repeats: true }) : null), [tScore]);
  const sound = SOUND[rec.source === 'songbook' ? s.settings.instrument : (tScore?.parts[0]?.instrument || 'piano')] || 'piano';

  const evaluate = useCallback(() => {
    micStop.current?.(); micStop.current = null;
    if (!practiceOn.current || !perf) return;
    practiceOn.current = false;
    const box = scoreBox.current;
    let right = 0, tuned = 0, total = 0;
    for (const e of perf.events) {
      if (e.pi !== 0) continue;
      const a = e.t.num(), b = a + e.dur.num();
      if (b > lastQ.current + 0.01) break;
      const w0 = a + Math.min(0.25, (b - a) * 0.3), w1 = b - Math.min(0.1, (b - a) * 0.15);
      const fr = frames.current.filter((f) => f.q >= w0 && f.q <= w1).map((f) => f.midi).sort((x, y) => x - y);
      total++;
      let ok = false;
      if (fr.length >= 2) {
        let diff = fr[Math.floor(fr.length / 2)] - e.midi;
        diff -= 12 * Math.round(diff / 12); // singers an octave away still count
        if (Math.abs(diff) <= 0.5) { ok = true; right++; if (Math.abs(diff) <= 0.25) tuned++; }
      }
      e.ids.forEach((nid) => box?.querySelector(`[id="${nid}"]`)?.classList.add(ok ? 'ok' : 'bad'));
    }
    if (!total) { setPractice(null); return; }
    const accuracy = right / total, inTune = right ? tuned / right : 0;
    recordTake({ pieceId: meta.id, title: meta.title, seconds: Math.round((performance.now() - playStart.current) / 1000), accuracy, inTune });
    setPractice({ result: { accuracy, inTune, right, total } });
  }, [perf, meta.id, meta.title]);

  const stop = useCallback(() => {
    if (transport.current?.playing) {
      transport.current.stop();
      const secs = (performance.now() - playStart.current) / 1000;
      if (!practiceOn.current) logMinutes(secs);
    }
    lit.current.forEach((el) => el.classList.remove('on'));
    lit.current = [];
    setPlayer((p) => ({ ...p, playing: false }));
    if (practiceOn.current) evaluate();
  }, [evaluate]);
  useEffect(() => () => stop(), [stop]);
  useEffect(() => { if (!active) stop(); }, [active]);

  const buildEvents = useCallback(() => {
    if (!perf) return null;
    const tempos = perf.tempos;
    const sec = (x) => secondsAt(tempos, x, speed);
    const evs = [];
    const lead = countIn ? sec(measureLength(timeAt(tScore, 0))) : 0;
    for (const e of perf.events) {
      const part = tScore.parts[e.pi];
      const inst = SOUND[e.pi === 0 && rec.source === 'songbook' ? s.settings.instrument : part.instrument] || 'piano';
      evs.push({ time: lead + sec(e.t), dur: sec(e.t.add(e.dur)) - sec(e.t), midi: e.midi, vel: e.vel || 80, inst, ids: e.ids, q: e.t.num(), qEnd: e.t.add(e.dur).num(), pan: e.pi === 0 ? 0 : -0.2 });
    }
    if (withChords && harmonies.length && tScore.parts.length === 1) {
      // soft piano chords under a lead sheet: each chord until the next one, played in performance order
      for (const span of perf.spans) {
        const hs = harmonies.filter((h) => h.mi === span.mi);
        hs.forEach((h, k) => {
          const end = k + 1 < hs.length ? hs[k + 1].off : span.dur;
          const at = span.t.add(h.off);
          const v = pianoVoicing(h.chord, 3).map((m) => (m < 48 ? m + 12 : m));
          v.forEach((m) => evs.push({ time: lead + sec(at), dur: sec(at.add(end.sub(h.off))) - sec(at) - 0.02, midi: m, vel: 44, inst: 'epiano', pan: 0.25 }));
        });
        // carry a chord from an earlier bar into bars without a change
        if (!hs.length) {
          const prev = [...harmonies].reverse().find((h) => h.mi < span.mi);
          if (prev) pianoVoicing(prev.chord, 3).map((m) => (m < 48 ? m + 12 : m)).forEach((m) => evs.push({ time: lead + sec(span.t), dur: sec(span.t.add(span.dur)) - sec(span.t) - 0.02, midi: m, vel: 38, inst: 'epiano', pan: 0.25 }));
        }
      }
    }
    if (metro || countIn) {
      for (let i = 0; i < perf.spans.length + (countIn ? 1 : 0); i++) {
        const isCount = countIn && i === 0;
        const span = isCount ? { mi: 0, t: ZERO, dur: measureLength(timeAt(tScore, 0)) } : perf.spans[i - (countIn ? 1 : 0)];
        const time = timeAt(tScore, span.mi);
        const beat = beatLength(time);
        let k = 0;
        for (let b = ZERO; b.lt(span.dur); b = b.add(beat), k++) {
          if (!metro && !isCount) break;
          const at = isCount ? sec(b) : lead + sec(span.t.add(b));
          evs.push({ time: at, click: true, accent: k === 0 });
        }
      }
    }
    const length = lead + sec(perf.length) + 0.3;
    return { evs, lead, length };
  }, [perf, speed, metro, countIn, withChords, harmonies, tScore, rec.source, s.settings.instrument]);

  const highlight = useCallback((qNow) => {
    const box = scoreBox.current;
    if (!box || !perf) return;
    const ids = [];
    for (const e of perf.events) {
      const a = e.t.num();
      if (a > qNow) break;
      if (qNow < a + e.dur.num()) ids.push(...e.ids);
    }
    lit.current.forEach((el) => el.classList.remove('on'));
    lit.current = ids.map((nid) => box.querySelector(`[id="${nid}"]`)).filter(Boolean);
    lit.current.forEach((el) => el.classList.add('on'));
    if (lit.current[0] && view === 'sheet') {
      const r = lit.current[0].getBoundingClientRect();
      const scroller = box.closest('.scroll');
      if (scroller && (r.top < 120 || r.bottom > innerHeight - 200)) scroller.scrollBy({ top: r.top - innerHeight * 0.35, behavior: 'smooth' });
    }
  }, [perf, view]);

  const play = useCallback((fromQ = null) => {
    if (!perf) return;
    audioContext();
    const built = buildEvents();
    if (!built) return;
    builtRef.current = built;
    if (!transport.current) transport.current = new Transport();
    const tr = transport.current;
    tr.load(built.evs, built.length);
    const startQ = fromQ ?? (player.q >= perf.length.num() - 0.01 ? 0 : player.q);
    const startSec = startQ > 0 ? built.lead + secondsAt(perf.tempos, startQ, speed) : 0;
    if (loop) {
      const span = perf.spans.find((x) => x.t.num() <= startQ && x.t.add(x.dur).num() > startQ) || perf.spans[0];
      const idx = perf.spans.indexOf(span);
      const endSpan = perf.spans[Math.min(perf.spans.length - 1, idx + 3)];
      tr.setLoop({ start: built.lead + secondsAt(perf.tempos, span.t, speed), end: built.lead + secondsAt(perf.tempos, endSpan.t.add(endSpan.dur), speed) });
    } else tr.setLoop(null);
    let lastUi = 0;
    tr.onTime = (secNow) => {
      const qNow = quartersAt(perf.tempos, Math.max(0, secNow - built.lead), speed);
      lastQ.current = qNow;
      highlight(qNow);
      const nowMs = performance.now();
      if (nowMs - lastUi > 120) {
        lastUi = nowMs;
        const span = perf.spans.find((x) => x.t.num() <= qNow && x.t.add(x.dur).num() > qNow);
        setPlayer({ playing: true, q: qNow, bar: span ? Number(tScore.measures[span.mi].number) || span.mi + 1 : 1 });
      }
    };
    tr.onEnd = () => { lastQ.current = perf.length.num(); stop(); setPlayer({ playing: false, q: 0, bar: 1 }); };
    playStart.current = performance.now();
    tr.play(startSec);
    setPlayer((p) => ({ ...p, playing: true }));
  }, [perf, buildEvents, highlight, loop, speed, player.q, stop, tScore]);

  // restart with new settings while playing
  useEffect(() => { if (transport.current?.playing) { const qNow = player.q; stop(); setTimeout(() => play(qNow), 30); } }, [speed, metro, loop, withChords, semis]);

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
      evs.push({ time: i * bar, dur: bar, midi: 36 + ((rootPc(c) + 12 - 0) % 12), vel: 70, inst: 'bass' });
    });
    const tr = transport.current;
    tr.load(evs, chords.length * bar + 0.5);
    tr.setLoop(null);
    tr.onTime = (sec) => setPlayer({ playing: true, q: sec / bar, bar: Math.floor(sec / bar) + 1, chordIndex: Math.floor(sec / bar) });
    tr.onEnd = () => setPlayer({ playing: false, q: 0, bar: 1 });
    playStart.current = performance.now();
    tr.play(0);
  };

  const startPractice = async () => {
    if (!tScore) return;
    stop();
    scoreBox.current?.querySelectorAll('g.note.ok, g.note.bad').forEach((el) => el.classList.remove('ok', 'bad'));
    try {
      frames.current = [];
      micStop.current = await listen((p) => {
        const tr = transport.current;
        if (!p || !tr?.playing || !builtRef.current) return;
        const sec = tr.position() - 0.09; // microphone latency
        frames.current.push({ q: quartersAt(perf.tempos, Math.max(0, sec - builtRef.current.lead), speed), midi: p.midi });
      });
    } catch (e) {
      toast(t(e.code === 'denied' ? 'micDenied' : 'micUnavailable'), 'err');
      return;
    }
    practiceOn.current = true;
    setPractice({ on: true });
    setView('sheet');
    play(0);
  };

  const curKeyText = sheetKey ? keyName(sheetKey) : '';
  const showPlayer = !!tScore || (tSheet && sheetChords(tSheet).length);
  const total = perf ? perf.length.num() : 1;

  return (
    <div class={`scroll${showPlayer ? ' has-player' : ''}`}>
      <NavBar title={meta.title} backLabel={t('library')} actions={<>
        <button type="button" onClick={() => updatePiece(meta.id, { favorite: !meta.favorite })} aria-label={t('favourite')} class={meta.favorite ? 't-yellow' : ''}><Icon name="star" size={22} fill={meta.favorite} /></button>
        <button type="button" onClick={() => openSheet('export', { pieceId: meta.id, semis, title: meta.title })} aria-label={t('export')}><Icon name="share" size={22} /></button>
      </>} />
      <div class="wrap" style={{ paddingTop: 14 }}>
        <div class="piece-head">
          <h1>{meta.title}</h1>
          {meta.composer && <span class="sub">{meta.composer}</span>}
          <div class="meta-chips">
            {curKeyText && <span class="meta"><span class="k">{t('key')}</span>{curKeyText}</span>}
            {tScore?.measures[0]?.tempo && <span class="meta"><span class="k">♩</span>{Math.round(tScore.measures[0].tempo * speed)}</span>}
            {tScore && <span class="meta"><span class="k">{t('time')}</span>{timeAt(tScore, 0).beats}/{timeAt(tScore, 0).beatType}</span>}
            {tScore && <span class="meta"><span class="k">{t('difficulty')}</span><Stars n={difficulty(tScore)} /></span>}
            {rec.kind === 'pdf' && <span class="meta">PDF · {t('pages', { n: rec.pages || 1 })}</span>}
          </div>
        </div>

        {(sheetKey || tScore) && (
          <div class="keybar c-green">
            <Stepper label={t('key')} value={curKeyText || '—'} sub={semis ? `${semis > 0 ? '+' : ''}${semis} · ${t('originalKey')} ${originalKey ? keyName(originalKey) : ''}` : t('originalKey')}
              onDec={() => setSemis(Math.max(-11, semis - 1))} onInc={() => setSemis(Math.min(11, semis + 1))} />
            <div class="btn-row">
              {semis !== 0 && <Button kind="secondary" small icon="loop" onClick={() => setSemis(0)}>{t('originalKey')}</Button>}
              <Button kind="secondary" small icon="mic" color="purple" onClick={() => openSheet('findKey', { pieceId: meta.id, semis, onPick: setSemis })}>{t('findMyKey')}</Button>
            </div>
          </div>
        )}

        {views.length > 1 && <Segmented id="piece-views" value={view} onChange={setView} options={views} />}

        {practice?.result && (
          <Card>
            <div class="report-line"><Badge icon="mic" color="pink" size={34} /><div><strong>{t('takeResult', { acc: Math.round(practice.result.accuracy * 100), tune: Math.round(practice.result.inTune * 100) })}</strong>
              <p class="sub num">{practice.result.right}/{practice.result.total} ♪</p></div></div>
            <div class="btn-row"><Button small icon="mic" color="pink" onClick={startPractice}>{t('tryAgain')}</Button><Button small kind="secondary" onClick={() => { setPractice(null); scoreBox.current?.querySelectorAll('g.note.ok, g.note.bad').forEach((el) => el.classList.remove('ok', 'bad')); }}>{t('close')}</Button></div>
          </Card>
        )}
        {view === 'sheet' && xml && <SheetMusic xml={xml} boxRef={scoreBox} onFallback={() => setView('roll')} onTapId={(nid) => { const e = perf?.events.find((x) => x.ids.includes(nid)); if (e) play(e.t.num()); }} />}
        {view === 'roll' && perf && <PianoRoll score={tScore} perf={perf} q={player.q} harmonies={harmonies} />}
        {view === 'chords' && <ChordChart harmonies={harmonies} sheet={tSheet} keySig={sheetKey} suggested={!written.length && !!tScore} playingBar={player.playing ? player.bar : null} />}
        {view === 'lyrics' && tSheet && <LyricsView sheet={tSheet} playing={player.playing ? player.chordIndex : null} />}
        {view === 'pdf' && rec.pdf && <PdfPages bytes={rec.pdf} />}

        <Section title={t('songInfo')}>
          <InfoCard tScore={tScore} sheet={tSheet} keySig={sheetKey} originalKey={originalKey} harmonies={harmonies} />
          <div class="btn-row">
            {(harmonies.length > 0 || (tSheet && sheetChords(tSheet).length)) && <Button icon="sparkles" kind="secondary" color="purple" onClick={() => { setState((st) => ({ improvSource: { pieceId: meta.id, semis } })); go('improvise'); }}>{t('improviseOver')}</Button>}
            {tScore && <Button icon="mic" kind="secondary" color="pink" onClick={startPractice}>{practice?.on ? t('listening') : t('practiseMic')}</Button>}
          </div>
          <List>
            <Row icon="share" color="blue" title={t('export')} subtitle="MusicXML · MIDI · ChordPro" onClick={() => openSheet('export', { pieceId: meta.id, semis, title: meta.title })} />
            <Row icon="trash" color="red" title={t('delete')} danger onClick={async () => { await deletePiece(meta.id); pop(); }} />
          </List>
        </Section>
      </div>

      {showPlayer && (
        <div class="player c-pink">
          <div class="player-inner">
            <div class="player-top">
              <button type="button" class="play-btn" id="play-btn" onClick={() => (player.playing ? stop() : (tScore ? play() : playSheetChords()))} aria-label={player.playing ? t('pause') : t('play')}>
                <Icon name={player.playing ? 'pause' : 'play'} size={22} fill={!player.playing} stroke={player.playing ? 3 : 1.5} />
              </button>
              <div class="player-info">
                <strong>{meta.title}</strong>
                <span class="num">{tScore ? `${t('bar', { n: player.bar })} · ${instrumentName(Object.keys(SOUND).find((k) => SOUND[k] === sound && k === s.settings.instrument) || tScore.parts[0].instrument)}` : t('viewChords')}</span>
              </div>
              {tScore && <>
                <button type="button" class={`ptoggle${loop ? ' on' : ''}`} onClick={() => setLoop(!loop)} aria-pressed={loop} aria-label={t('loop')} title={t('loop')}><Icon name="loop" size={20} /></button>
                <button type="button" class={`ptoggle${metro ? ' on' : ''}`} onClick={() => setMetro(!metro)} aria-pressed={metro} aria-label={t('metronome')} title={t('metronome')}><Icon name="metronome" size={20} /></button>
                {harmonies.length > 0 && tScore.parts.length === 1 && <button type="button" class={`ptoggle${withChords ? ' on' : ''}`} onClick={() => setWithChords(!withChords)} aria-pressed={withChords} aria-label={t('viewChords')} title={t('viewChords')}><Icon name="piano" size={20} /></button>}
                <button type="button" class={`ptoggle${countIn ? ' on' : ''}`} onClick={() => setCountIn(!countIn)} aria-pressed={countIn} aria-label={t('countIn')} title={t('countIn')}><span style={{ fontWeight: 700, fontSize: 13 }}>1·2</span></button>
              </>}
            </div>
            {tScore && <div class="progressbar"><span style={{ width: `${Math.min(100, (player.q / total) * 100)}%` }} /></div>}
            <div class="player-bottom">
              <span>{t('speed')}</span>
              <input type="range" id="speed" min="0.5" max="1.5" step="0.05" value={speed} onInput={(e) => setSpeed(Number(e.currentTarget.value))} aria-label={t('speed')} />
              <span class="num" style={{ width: 42, textAlign: 'right' }}>{Math.round(speed * 100)}%</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SheetMusic({ xml, boxRef, onTapId, onFallback }) {
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
  const onClick = (e) => {
    const g = e.target.closest?.('g.note');
    if (g?.id) onTapId?.(g.id);
  };
  return (
    <div ref={wrapRef}>
      {state.loading && <div class="loading"><div class="spinner" />{state.first ? t('loadingEngine') : ''}</div>}
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

export function ExportSheet({ pieceId, semis, title }) {
  const s = useApp();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!s.plus) { openSheet('paywall', { feature: 'export' }); return; }
    setBusy(true);
    try {
      const d = await getPiece(pieceId);
      const safe = (title || 'Haptune').replace(/[\\/:*?"<>|]+/g, ' ').trim();
      const files = [];
      if (d.score) {
        const sc = transposeScore(d.score, semis);
        files.push({ name: `${safe}.musicxml`, data: writeMusicXML(sc) });
        files.push({ name: `${safe}.mid`, data: writeMIDI(sc) });
        const sheet = scoreToSheet(sc, harmonyList(sc));
        if (sheet) files.push({ name: `${safe} (lyrics and chords).txt`, data: toChordsOverLyrics({ ...sheet, title: sc.title, key: concertKey(sc) }) });
      }
      if (d.sheet) {
        const sh = transposeSheet(d.sheet, semis);
        files.push({ name: `${safe}.chordpro.txt`, data: toChordPro(sh) });
        files.push({ name: `${safe} (chords over lyrics).txt`, data: toChordsOverLyrics(sh) });
      }
      if (d.rec.kind === 'pdf' && d.rec.pdf) files.push({ name: `${safe}.pdf`, data: new Uint8Array(d.rec.pdf) });
      const ok = await saveFile(`${safe}.zip`, writeZip(files));
      if (ok) { toast(t('export') + ' ✓'); closeSheet(); }
    } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  return (
    <SheetFrame title={t('export')}>
      <Card>
        <div class="report-line"><Badge icon="download" color="blue" size={40} /><div><strong>{title}.zip</strong><p class="sub">{t('exportHelp')}</p></div></div>
        {semis !== 0 && <p class="note-text">{t('exportInKey', { key: `${semis > 0 ? '+' : ''}${semis}` })}</p>}
      </Card>
      {!s.plus && <p class="note-text"><Icon name="crown" size={14} /> {t('plusOnly')}</p>}
      <Button onClick={run} disabled={busy} icon="download" full>{busy ? '…' : t('export')}</Button>
    </SheetFrame>
  );
}

export { scoreToSheet, harmonyList, saveFile };
