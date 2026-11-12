import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { useApp, push, openSheet, toast, addSheet } from '../state.js';
import { t, instrumentName } from '../../core/i18n.js';
import { Icon, Card, Section, List, Row, Button, Badge, Segmented, Stepper, Chip, FretDiagram, PianoChord } from '../components.jsx';
import { LargeTitle, NavBar } from './common.jsx';
import { audioContext, listen, note, click, Transport, startDrone, stopDrone } from '../audio.js';
import { parseChord, formatChord, chordNotes, QUALITIES, capoOptions, pianoVoicing } from '../../core/chords.js';
import { parseChordSheet, transposeSheet, toChordsOverLyrics, sheetChords } from '../../core/chordsheet.js';
import { keyName, spellMidi, pitchName, nameOf } from '../../core/pitch.js';

const TOOLS = [
  { id: 'tuner', icon: 'tuningfork', color: 'teal' }, { id: 'metronome', icon: 'metronome', color: 'orange' },
  { id: 'chordFinder', icon: 'chords', color: 'purple' }, { id: 'transposer', icon: 'arrows', color: 'green' },
  { id: 'scales', icon: 'stairs', color: 'blue' }, { id: 'drone', icon: 'drone', color: 'indigo' },
];

export function ToolsView({ pushed = false }) {
  return (
    <div class="scroll">
      <div class="wrap">
        <LargeTitle title={t('tools')} back={pushed} />
        <div class="grid tiles">
          {TOOLS.map((x) => (
            <button type="button" key={x.id} class={`tile c-${x.color}`} onClick={() => (x.id === 'scales' ? openSheet('scale') : push('tool', { tool: x.id }))}>
              <Badge icon={x.icon} color={x.color} size={40} />
              <h3>{t(x.id === 'scales' ? 'scaleExercise' : x.id)}</h3>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ToolView({ tool, active }) {
  const meta = TOOLS.find((x) => x.id === tool);
  return (
    <div class="scroll">
      <NavBar title={t(tool)} color={meta.color} backLabel={t('tools')} />
      <div class={`wrap c-${meta.color}`} style={{ paddingTop: 16 }}>
        {tool === 'tuner' && <Tuner active={active} />}
        {tool === 'metronome' && <Metronome active={active} />}
        {tool === 'chordFinder' && <ChordFinder />}
        {tool === 'transposer' && <Transposer />}
        {tool === 'drone' && <Drone active={active} />}
      </div>
    </div>
  );
}

// Open strings (MIDI) for the reference tones, per instrument.
const OPEN_STRINGS = {
  violin: [55, 62, 69, 76], viola: [48, 55, 62, 69], cello: [36, 43, 50, 57], erhu: [62, 69],
  guitar: [40, 45, 50, 55, 59, 64], ukulele: [67, 60, 64, 69], bassguitar: [28, 33, 38, 43],
};
const STRING_SOUND = { guitar: 'guitar', ukulele: 'guitar', bassguitar: 'bass' };

function Tuner({ active }) {
  const s = useApp();
  const [p, setP] = useState(null);
  const [on, setOn] = useState(false);
  const [a4, setA4] = useState(440);
  const [inst, setInst] = useState(OPEN_STRINGS[s.settings.instrument] ? s.settings.instrument : 'violin');
  // The Claude preview can never use the mic, so say so up front there; elsewhere only after a failed start.
  const [micErr, setMicErr] = useState(globalThis.HAPTUNE_CONFIG?.pwa === false ? 'unavailable' : null);
  const stopRef = useRef(null);
  const start = async () => {
    try {
      stopRef.current = await listen((x) => setP(x ? { ...x, midi: 69 + 12 * Math.log2(x.freq / a4) } : null));
      setOn(true);
      setMicErr(null);
    } catch (e) { setMicErr(e.code === 'denied' ? 'denied' : 'unavailable'); toast(t(e.code === 'denied' ? 'micDenied' : 'micUnavailable'), 'err'); }
  };
  const playRef = (m) => {
    const ctx = audioContext();
    if (ctx) note(ctx.currentTime + 0.02, m + 12 * Math.log2(a4 / 440), 2.2, 90, STRING_SOUND[inst] || 'strings');
  };
  const stop = () => { stopRef.current?.(); stopRef.current = null; setOn(false); setP(null); };
  useEffect(() => { if (!active) stop(); }, [active]);
  useEffect(() => () => stopRef.current?.(), []);
  const near = p ? Math.round(p.midi) : null;
  const cents = p ? Math.round((p.midi - near) * 100) : 0;
  return (
    <>
      <Card>
        <div class="tuner">
          <div class="note" style={{ color: p ? (Math.abs(cents) <= 5 ? 'var(--green)' : Math.abs(cents) <= 20 ? 'var(--orange)' : 'var(--red)') : 'var(--ink3)' }}>{near !== null ? pitchName(spellMidi(near, 0)) : '–'}</div>
          <div class="gauge"><div class="needle" style={{ left: `${50 + Math.max(-50, Math.min(50, cents))}%` }} /></div>
          <div class="sub num">{p ? `${cents > 0 ? '+' : ''}${cents} ${t('cents')} · ${p.freq.toFixed(1)} Hz` : t('tunerHelp')}</div>
        </div>
        <Button full onClick={on ? stop : start} icon={on ? 'stop' : 'mic'}>{on ? t('stop') : t('start')}</Button>
      </Card>
      <Stepper label="A4" value={`${a4} Hz`} onDec={() => setA4(Math.max(415, a4 - 1))} onInc={() => setA4(Math.min(466, a4 + 1))} />
      <Section title={t('referenceTones')}>
        <div class="chips">{Object.keys(OPEN_STRINGS).map((k) => <Chip key={k} on={inst === k} onClick={() => setInst(k)}>{instrumentName(k)}</Chip>)}</div>
        <div class="q-options many">{OPEN_STRINGS[inst].map((m) => <button type="button" key={m} class="q-opt" onClick={() => playRef(m)}>{pitchName(spellMidi(m, 0))}</button>)}</div>
      </Section>
      {micErr && <p class="note-text">{t(micErr === 'denied' ? 'micDenied' : 'micUnavailable')}</p>}
    </>
  );
}

function Metronome({ active }) {
  const [bpm, setBpm] = useState(90);
  const [beats, setBeats] = useState(4);
  const [on, setOn] = useState(false);
  const [beat, setBeat] = useState(-1);
  const tr = useRef(null);
  const taps = useRef([]);
  const run = (b = bpm, n = beats) => {
    audioContext();
    const spb = 60 / b;
    const bars = 64;
    const evs = [];
    for (let i = 0; i < bars * n; i++) evs.push({ time: i * spb, click: true, accent: i % n === 0 });
    if (!tr.current) tr.current = new Transport();
    tr.current.load(evs, bars * n * spb);
    tr.current.setLoop({ start: 0, end: bars * n * spb });
    tr.current.onTime = (sec) => setBeat(Math.floor(sec / spb) % n);
    tr.current.play(0);
    setOn(true);
  };
  const stop = () => { tr.current?.stop(); setOn(false); setBeat(-1); };
  useEffect(() => { if (!active) stop(); }, [active]);
  useEffect(() => () => tr.current?.stop(), []);
  useEffect(() => { if (on) { stop(); run(); } }, [bpm, beats]);
  const tapTempo = () => {
    const now = performance.now();
    taps.current = [...taps.current.filter((x) => now - x < 2500), now];
    if (taps.current.length >= 2) {
      const d = taps.current.slice(1).map((x, i) => x - taps.current[i]);
      setBpm(Math.max(30, Math.min(260, Math.round(60000 / (d.reduce((a, c) => a + c, 0) / d.length)))));
    }
  };
  return (
    <>
      <Card>
        <div class="bpm num">{bpm}</div>
        <p class="sub" style={{ textAlign: 'center' }}>BPM</p>
        <input type="range" id="metro-bpm" min="30" max="240" value={bpm} onInput={(e) => setBpm(Number(e.currentTarget.value))} aria-label="BPM" />
        <div class="beat-dots">{Array.from({ length: beats }, (_, i) => <i key={i} class={`${beat === i ? 'on' : ''}${i === 0 ? ' accent' : ''}`} />)}</div>
        <div class="btn-row">
          <Button onClick={on ? stop : () => run()} icon={on ? 'stop' : 'play'} color="orange">{on ? t('stop') : t('start')}</Button>
          <Button kind="secondary" color="orange" onClick={tapTempo}>{t('tapTempo')}</Button>
        </div>
      </Card>
      <Section title={t('beatsPerBar')}><Segmented value={beats} onChange={setBeats} options={[2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) }))} /></Section>
    </>
  );
}

const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const TYPES = ['maj', 'min', '7', 'maj7', 'm7', 'sus2', 'sus4', 'add9', '6', 'm6', '9', 'dim', 'dim7', 'm7b5', 'aug'];
function ChordFinder() {
  const s = useApp();
  const [root, setRoot] = useState('G');
  const [type, setType] = useState('maj');
  const [inst, setInst] = useState(s.settings.chordView || 'guitar');
  const chord = parseChord(root + (QUALITIES[type].sym.replace(/♭/g, 'b').replace(/♯/g, '#')));
  if (!chord) return null;
  return (
    <>
      <Card>
        <div style={{ textAlign: 'center', font: '800 48px var(--round)' }}>{formatChord(chord)}</div>
        <p style={{ textAlign: 'center', fontWeight: 600 }}>{chordNotes(chord).map((n) => nameOf(n)).join(' · ')}</p>
        <Segmented value={inst} onChange={setInst} options={[{ value: 'guitar', label: t('guitar') }, { value: 'ukulele', label: t('ukulele') }, { value: 'piano', label: t('piano') }]} />
        {inst === 'piano' ? <PianoChord chord={chord} /> : <div class="diagram-row" style={{ justifyContent: 'center' }}>{[0, 1, 2].map((i) => <FretDiagram key={i} chord={chord} instrument={inst} index={i} width={i ? 92 : 120} />)}</div>}
        <Button icon="speaker" color="purple" onClick={() => { const ctx = audioContext(); pianoVoicing(chord, 4).forEach((m, i) => note(ctx.currentTime + 0.03 + i * 0.03, m, 1.6, 80, inst === 'piano' ? 'piano' : 'guitar')); }}>{t('play')}</Button>
      </Card>
      <Section title={t('root')}><div class="chips wrap">{ROOTS.map((r) => <Chip key={r} on={root === r} color="purple" onClick={() => setRoot(r)}>{r.replace('#', '♯').replace('b', '♭')}</Chip>)}</div></Section>
      <Section title={t('type')}><div class="chips wrap">{TYPES.map((x) => <Chip key={x} on={type === x} color="purple" onClick={() => setType(x)}>{QUALITIES[x].sym || 'maj'}</Chip>)}</div></Section>
    </>
  );
}

const SAMPLE = `Am          F           C           G
Paste any chord sheet here and move it up or down
Am          F           C           G
Every chord is re-spelled for the new key`;
function Transposer() {
  const [text, setText] = useState(SAMPLE);
  const [semis, setSemis] = useState(0);
  const sheet = useMemo(() => { try { const s = parseChordSheet(text); return sheetChords(s).length ? s : null; } catch { return null; } }, [text]);
  const moved = sheet ? transposeSheet(sheet, semis) : null;
  const out = moved ? toChordsOverLyrics({ ...moved, title: '', key: null }).trim() : '';
  const capo = moved ? capoOptions(sheetChords(moved))[0] : null;
  return (
    <>
      <p class="note-text">{t('transposerHelp')}</p>
      <textarea class="field" id="tr-text" value={text} onInput={(e) => setText(e.currentTarget.value)} style={{ minHeight: 130 }} />
      <Stepper label={t('key')} value={moved?.key ? keyName(moved.key) : '—'} sub={semis ? `${semis > 0 ? '+' : ''}${semis}` : t('originalKey')} onDec={() => setSemis(Math.max(-11, semis - 1))} onInc={() => setSemis(Math.min(11, semis + 1))} />
      {out && <Card><pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 14, lineHeight: 1.45 }} id="tr-out">{out}</pre></Card>}
      {capo && capo.capo > 0 && <p class="note-text"><Icon name="guitar" size={14} /> {t('capoHint', { n: capo.capo, shapes: capo.names.join(' ') })}</p>}
      <div class="btn-row">
        <Button kind="secondary" icon="paste" onClick={() => navigator.clipboard?.writeText(out).then(() => toast(t('copied'))).catch(() => {})}>{t('copy')}</Button>
        <Button icon="plus" color="green" onClick={async () => { if (moved) { await addSheet(moved, { title: moved.title || 'Chord sheet' }); toast(t('added')); } }}>{t('addToLibrary')}</Button>
      </div>
    </>
  );
}

function Drone({ active }) {
  const [on, setOn] = useState(null);
  useEffect(() => { if (!active) { stopDrone(); setOn(null); } }, [active]);
  useEffect(() => () => stopDrone(), []);
  const notes = [['C', 48], ['C♯', 49], ['D', 50], ['E♭', 51], ['E', 52], ['F', 53], ['F♯', 54], ['G', 55], ['A♭', 56], ['A', 57], ['B♭', 58], ['B', 59]];
  return (
    <>
      <div class="q-options many">{notes.map(([n, m]) => <button type="button" key={n} class={`q-opt${on === m ? ' right' : ''}`} onClick={() => { audioContext(); if (on === m) { stopDrone(); setOn(null); } else { startDrone(m); setOn(m); } }}>{n}</button>)}</div>
      <p class="note-text">{t('drone')}: {on ? t('droneOn', { note: notes.find((x) => x[1] === on)[0] }) : '—'}</p>
    </>
  );
}
