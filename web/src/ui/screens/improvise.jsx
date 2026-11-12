import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { useApp, getPiece, addScore, openSheet, toast, setState, push, logMinutes, awardBadge, addXP } from '../state.js';
import { t, getLang, instrumentName } from '../../core/i18n.js';
import { Icon, Card, Section, List, Row, Segmented, Stepper, Button, Chip, Keyboard, Badge, Toggle } from '../components.jsx';
import { LargeTitle } from './common.jsx';
import { renderMusicXML } from '../verovio.js';
import { PianoRoll } from './piece.jsx';
import { Transport, audioContext, listen } from '../audio.js';
import { SOUND } from './piece.jsx';
import { writeMusicXML } from '../../core/musicxml.js';
import { improvise, PROGRESSIONS, progressionInKey, progressionFromScore, backing, withLabels, STYLES, scaleFor, layoutProgression, RANGES } from '../../core/improv.js';
import { keyName, transposeKey, transposeInterval, spellMidi, pitchName, nameOf } from '../../core/pitch.js';
import { formatChord, chordPcs, rootPc, transposeChord, chordToneLabel } from '../../core/chords.js';
import { transposeScore, concertKey, measureLength } from '../../core/score.js';
import { sheetChords, transposeSheet } from '../../core/chordsheet.js';
import { q } from '../../core/q.js';
import { VaryPanel, STYLE_META, swingQ } from './vary.jsx';
import { Mascot } from '../mascot.jsx';

const FREE_STYLES = new Set(['pop', 'ballad', 'pentatonic']);
const INSTR = ['violin', 'voice', 'flute', 'piano', 'guitar', 'cello', 'sax', 'trumpet', 'erhu', 'dizi', 'clarinet', 'ukulele'];

/** Key signature one semitone up or down, spelled with the fewest accidentals. */
function stepKey(fifths, minor, dir) {
  const k = transposeKey({ fifths, mode: minor ? 'minor' : 'major' }, transposeInterval({ fifths, mode: minor ? 'minor' : 'major' }, dir));
  return k.fifths;
}

export function ImproviseView({ active, pushed = false }) {
  const s = useApp();
  const lang = getLang();
  const [mode, setMode] = useState(() => (s.pieces.some((p) => p.kind === 'score') ? 'vary' : 'solo'));
  const [varySrc, setVarySrc] = useState(null);
  const [source, setSource] = useState('preset');
  const [preset, setPreset] = useState('axis');
  const [keyF, setKeyF] = useState(0);
  const [minor, setMinor] = useState(false);
  const [style, setStyle] = useState('pop');
  const [level, setLevel] = useState(2);
  const [inst, setInst] = useState(s.settings.instrument || 'violin');
  const [bars, setBars] = useState(8);
  const [tempo, setTempo] = useState(STYLES.pop.tempo);
  const [seed, setSeed] = useState(7);
  const [piece, setPiece] = useState(null); // {id, title, progression, key}
  const [result, setResult] = useState(null);
  const [roles, setRoles] = useState(s.settings.showRoles);
  const [svg, setSvg] = useState({ loading: false, pages: [] });
  const [playing, setPlaying] = useState(null); // 'solo' | 'jam'
  const [jamChord, setJamChord] = useState(null);
  const [heard, setHeard] = useState(null);
  const tr = useRef(null);
  const stopMic = useRef(null);
  const started = useRef(0);

  // a piece sent from the piece screen
  useEffect(() => {
    const src = s.improvSource;
    if (!src) return;
    setState({ improvSource: null });
    if (src.vary) { stop(); setMode('vary'); setVarySrc({ ...src, n: Date.now() }); return; }
    setMode('solo');
    (async () => {
      const d = await getPiece(src.pieceId);
      if (!d) return;
      let prog = null, key = null;
      if (d.score) {
        const sc = transposeScore(d.score, src.semis || 0);
        prog = progressionFromScore(sc, 16);
        key = concertKey(sc);
      } else if (d.sheet) {
        const sh = transposeSheet(d.sheet, src.semis || 0);
        prog = sheetChords(sh).slice(0, 16);
        key = sh.key;
      }
      if (prog && prog.length) {
        setPiece({ id: d.rec.id, title: d.rec.title, progression: prog, key });
        setSource('piece');
        setKeyF(key.fifths); setMinor(key.mode === 'minor');
      }
    })();
  }, [s.improvSource]);

  const key = { fifths: keyF, mode: minor ? 'minor' : 'major' };
  const progression = useMemo(() => {
    if (source === 'piece' && piece) return piece.progression;
    return progressionInKey(preset, key);
  }, [source, piece, preset, keyF, minor]);
  const time = { beats: 4, beatType: 4 };
  const locked = !s.plus && (!FREE_STYLES.has(style) || level === 3);

  const generate = (newSeed = seed) => {
    if (locked) { openSheet('plans', { reason: { feature: 'improvise' } }); return; }
    const k = source === 'piece' && piece ? piece.key : { fifths: keyF, mode: PROGRESSIONS[preset]?.mode === 'minor' ? 'minor' : minor ? 'minor' : 'major' };
    const nBars = source === 'piece' && piece ? Math.min(16, Math.max(4, Math.round(piece.progression.reduce((a, x) => a + (x.dur ? x.dur.num() : 4), 0) / 4))) : (preset === 'blues' ? 12 : bars);
    const r = improvise({ key: k, time, progression, bars: nBars, style, level, instrument: inst, seed: newSeed, tempo, title: `${t('st_' + style)} · ${source === 'piece' && piece ? piece.title : PROGRESSIONS[preset].name}` });
    setResult({ ...r, key: k, bars: nBars });
    awardBadge('improviser');
  };

  const xml = useMemo(() => (result ? writeMusicXML(roles ? withLabels(result.score, result.labels) : result.score) : null), [result, roles]);
  useEffect(() => {
    if (!xml) return;
    let alive = true;
    setSvg((x) => ({ ...x, loading: true }));
    renderMusicXML(xml, { width: Math.min(900, innerWidth - 40), scale: innerWidth < 500 ? 34 : 40 }).then((r) => alive && setSvg({ loading: false, pages: r.pages })).catch(() => alive && setSvg({ loading: false, pages: [], failed: true }));
    return () => { alive = false; };
  }, [xml]);

  const stop = useCallback(() => {
    if (tr.current?.playing) { tr.current.stop(); logMinutes((performance.now() - started.current) / 1000); }
    stopMic.current?.(); stopMic.current = null;
    setPlaying(null); setJamChord(null); setHeard(null);
    document.querySelectorAll('.improv-score g.note.on').forEach((el) => el.classList.remove('on'));
  }, []);
  useEffect(() => { if (!active) stop(); }, [active]);
  useEffect(() => () => stop(), []);

  const start = (mode) => {
    if (!result) return;
    audioContext();
    stop();
    const spb = 60 / tempo;
    const ratio = result.swing || 0;
    const evs = [];
    const band = backing(result.spans, { style: result.style, time, bars: result.bars, seed });
    for (const b of band) {
      const t0 = swingQ(b.t.num(), ratio), t1 = swingQ(b.t.add(b.dur).num(), ratio);
      if (b.inst === 'drums') evs.push({ time: t0 * spb, drum: b.drum, vel: b.vel });
      else evs.push({ time: t0 * spb, dur: Math.max(0.05, (t1 - t0) * spb - 0.02), midi: b.midi, vel: b.vel, inst: b.inst === 'keys' ? (result.style === 'rock' ? 'guitar' : 'epiano') : 'bass', pan: b.inst === 'keys' ? -0.25 : 0.1 });
    }
    if (mode === 'solo') {
      for (const e of result.events) {
        const t0 = swingQ(e.t.num(), ratio), t1 = swingQ(e.t.add(e.dur).num(), ratio);
        evs.push({ time: t0 * spb, dur: (t1 - t0) * spb * 0.97, midi: e.midi, vel: 92, inst: SOUND[inst] || 'strings', q: e.t.num(), qEnd: e.t.add(e.dur).num(), pan: 0.15 });
      }
    }
    const length = result.bars * 4 * spb;
    if (!tr.current) tr.current = new Transport();
    tr.current.load(evs, length);
    tr.current.setLoop(mode === 'jam' ? { start: 0, end: length } : null);
    const notesSorted = result.events;
    const noteIds = result.score.parts[0].measures.flatMap((m) => m.notes.filter((n) => !n.rest && !n.tie.stop).map((n) => n.id));
    const lit = [];
    tr.current.onTime = (sec) => {
      const qn = sec / spb;
      // un-swing for lookups
      const span = result.spans.find((x) => x.t.num() <= qn && x.t.add(x.dur).num() > qn);
      if (mode === 'jam') { if (span) setJamChord((c) => (c?.t === span.t ? c : { t: span.t, chord: span.chord, next: result.spans[(result.spans.indexOf(span) + 1) % result.spans.length]?.chord })); return; }
      lit.forEach((el) => el.classList.remove('on')); lit.length = 0;
      const box = document.querySelector('.improv-score');
      if (!box) return;
      for (const ev of notesSorted) {
        if (ev.t.num() > qn) break;
        if (qn < ev.t.add(ev.dur).num()) {
          const id = noteIds[notesSorted.indexOf(ev)];
          const el = id && box.querySelector(`[id="${id}"]`);
          if (el) { el.classList.add('on'); lit.push(el); }
        }
      }
    };
    tr.current.onEnd = () => stop();
    started.current = performance.now();
    tr.current.play(0);
    setPlaying(mode);
    if (mode === 'jam') {
      listen((p) => setHeard(p ? Math.round(p.midi) : null)).then((fn) => { stopMic.current = fn; }).catch(() => {});
    }
  };

  const save = async () => {
    if (!result) return;
    const rec = await addScore(result.score, { source: 'improv', fmt: 'generated', title: result.score.title });
    addXP(15);
    toast(t('savedToLibrary'));
    void rec;
  };

  const jamMarks = useMemo(() => {
    const m = new Map();
    const c = jamChord?.chord;
    if (!c) return m;
    const scale = scaleFor(c, result?.key || key, STYLES[style].scale);
    const tones = chordPcs(c);
    for (let x = 48; x <= 84; x++) {
      const p = ((x % 12) + 12) % 12;
      if (p === rootPc(c)) m.set(x, 'mark-root');
      else if (tones.includes(p)) m.set(x, 'mark');
      else if (scale.has(p)) m.set(x, 'scale');
    }
    if (heard !== null) m.set(heard, 'you');
    return m;
  }, [jamChord, heard, style]);

  return (
    <div class="scroll">
      <div class="wrap">
        <LargeTitle title={t('improvise')} back={pushed} />
        <div class="hero improv">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="sparkles" size={22} stroke={2.2} /><h2>AI {t('improvise')}</h2></div>
          <p>{mode === 'vary' ? t('varyIntro') : t('improviseIntro')}</p>
          <span class="mascot-peek"><Mascot mood={mode === 'vary' ? 'cheer' : 'think'} size={96} /></span>
        </div>

        <div class="mode-cards improv-modes" role="radiogroup" aria-label={t('improvise')}>
          {[['vary', 'fromMySong', 'fromMySongSub', 'wand', 'purple'], ['solo', 'newSolo', 'newSoloSub', 'sparkles', 'pink']].map(([id, a, b, ic, c]) => (
            <button type="button" key={id} role="radio" aria-checked={mode === id} class={`mode-card${mode === id ? ' on' : ''}`} onClick={() => { stop(); setMode(id); }}>
              <Badge icon={ic} color={c} size={34} /><strong>{t(a)}</strong><span>{t(b)}</span>
            </button>
          ))}
        </div>

        {mode === 'vary' ? <VaryPanel active={active} src={varySrc} /> : <>
        <Section title={t('chordsFrom')}>
          <Segmented value={source} onChange={setSource} options={[{ value: 'preset', label: t('presets') }, { value: 'piece', label: t('fromPiece') }]} />
          {source === 'preset' ? (
            <>
              <div class="chips wrap">{Object.entries(PROGRESSIONS).map(([id, p]) => <Chip key={id} on={preset === id} color="purple" onClick={() => { setPreset(id); setMinor(p.mode === 'minor'); }}>{p.name}</Chip>)}</div>
              <Stepper label={t('key')} value={keyName(key)} sub={progression.map((c) => formatChord(c.chord || c)).join(' · ')}
                onDec={() => setKeyF(stepKey(keyF, minor, -1))} onInc={() => setKeyF(stepKey(keyF, minor, 1))} />
            </>
          ) : (
            <List>
              {piece && <Row icon="check" color="green" title={piece.title} subtitle={piece.progression.slice(0, 8).map((x) => formatChord(x.chord || x)).join(' · ')} />}
              {s.pieces.filter((p) => (p.chords > 0 || p.kind === 'sheet') && p.id !== piece?.id).slice(0, 8).map((p) => (
                <Row key={p.id} icon="library" color="blue" title={p.title} subtitle={p.keyText} onClick={() => setState({ improvSource: { pieceId: p.id, semis: 0 } })} />
              ))}
            </List>
          )}
        </Section>

        <Section title={t('style')}>
          <div class="grid tiles">
            {STYLE_META.map(([id, color, icon]) => (
              <button type="button" key={id} class={`tile c-${color}`} onClick={() => { setStyle(id); setTempo(STYLES[id].tempo); }} style={style === id ? { outline: '2.5px solid var(--c)', outlineOffset: '-2.5px' } : null}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><Badge icon={icon} color={color} size={30} />{!s.plus && !FREE_STYLES.has(id) && <span class="t-yellow"><Icon name="crown" size={16} /></span>}</div>
                <h3>{t('st_' + id)}</h3>
              </button>
            ))}
          </div>
        </Section>

        <Section title={t('levelLabel')}>
          <Segmented value={level} onChange={setLevel} options={[{ value: 1, label: t('beginner') }, { value: 2, label: t('intermediate') }, { value: 3, label: t('advanced') + (s.plus ? '' : ' 👑') }]} />
          <List>
            <Row title={t('instrument')} right={<select id="imp-inst" value={inst} onChange={(e) => setInst(e.currentTarget.value)}>{INSTR.map((k) => <option key={k} value={k}>{instrumentName(k)}</option>)}</select>} />
            {source === 'preset' && preset !== 'blues' && <Row title={t('bars')} right={<select id="imp-bars" value={bars} onChange={(e) => setBars(Number(e.currentTarget.value))}>{[4, 8, 12, 16].map((n) => <option key={n} value={n}>{n}</option>)}</select>} />}
            <Row title={t('tempo')} right={<span style={{ display: 'flex', alignItems: 'center', gap: 8, width: '55%' }}><input type="range" id="imp-tempo" min="50" max="200" value={tempo} onInput={(e) => setTempo(Number(e.currentTarget.value))} /><span class="num row-detail">{tempo}</span></span>} />
          </List>
        </Section>

        <Button kind="gradient" icon="sparkles" full onClick={() => { const ns = seed + 1; setSeed(ns); generate(ns); }}>{result ? t('regenerate') : t('generate')}</Button>

        {result && (
          <Section title={result.score.title}>
            {svg.failed ? (
              <Card><p class="note-text">{t('engineFailedShort')}</p><PianoRoll score={result.score} /></Card>
            ) : <div class="score-box vrv improv-score" dangerouslySetInnerHTML={{ __html: svg.pages.join('') }} />}
            {svg.loading && <div class="loading"><div class="spinner" /></div>}
            <List>
              <Row title={t('showRoles')} subtitle={t('rolesLegend')} right={<Toggle id="roles" checked={roles} onChange={setRoles} label={t('showRoles')} />} />
            </List>
            <div class="btn-row c-purple">
              <Button icon={playing === 'solo' ? 'pause' : 'play'} color="purple" onClick={() => (playing === 'solo' ? stop() : start('solo'))}>{t('withBand')}</Button>
              <Button icon={playing === 'jam' ? 'pause' : 'drone'} kind="secondary" color="pink" onClick={() => (playing === 'jam' ? stop() : start('jam'))}>{t('jam')}</Button>
              <Button icon="plus" kind="secondary" color="blue" onClick={save}>{t('addToLibrary')}</Button>
            </div>
            {playing === 'jam' && (
              <Card>
                <div class="jam-chord">{jamChord ? formatChord(jamChord.chord) : '…'}</div>
                <div class="jam-next">{jamChord?.next ? `→ ${formatChord(jamChord.next)}` : ''}</div>
                <Keyboard lo={48} hi={84} marks={jamMarks} height={86} />
                <p class="note-text">{t('jamHelp')}</p>
                {heard !== null && jamChord && <p style={{ textAlign: 'center', fontWeight: 700 }}>{pitchName(spellMidi(heard, (result?.key || key).fifths))} · {chordToneLabel(jamChord.chord, ((heard % 12) + 12) % 12) || (scaleFor(jamChord.chord, result?.key || key, STYLES[style].scale).has(((heard % 12) + 12) % 12) ? '·' : '✕')}</p>}
              </Card>
            )}
          </Section>
        )}
        </>}
      </div>
    </div>
  );
}
