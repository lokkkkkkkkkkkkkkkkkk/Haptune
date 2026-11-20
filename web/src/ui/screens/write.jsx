// Create (was Write): any original music. A new-song wizard (lead sheet, melody + chords, full notation, improvisation,
// chord/rhythm song, a Sound, an exercise), lyrics → chords, and your songs. Make sheet music and share it. Start a new song (instrument, key, time, speed), scan a printed page or a
// photo, type chords, or open one of your scores to fix it. The studio writes notes with a tap on the piano keys
// (or a computer keyboard, or a MIDI keyboard), shows the bars large, plays them back, and saves as you go. A
// finished song can go to Stage for others, to a class as an assignment, or out as PDF, MusicXML or MIDI.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp, push, openSheet, closeSheet, toast, getPiece, updatePiece, addScore } from '../state.js';
import { t, instrumentName } from '../../core/i18n.js';
import { Icon, Button, Keyboard, Chip } from '../components.jsx';
import { Cover } from '../cover.jsx';
import { LargeTitle, NavBar, SheetFrame, Avatar } from './common.jsx';
import { Mascot } from '../mascot.jsx';
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
import { RHYTHM_IDS } from '../../core/rhythm.js';
import { flag } from '../analytics.js';
import { tick } from '../native.js';

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
        <LargeTitle title={t('createT2')} eyebrow={t('createEyebrow')} color="teal" hapi="happy" actions={<span class="ph-only"><Avatar /></span>} />
        <section class="hero3 hero-write fade-up">
          <h1>{t('createWhat')}</h1>
          <p>{t('writeHeroSub')}</p>
          <div class="row-gap"><button type="button" class="btn white" onClick={() => openSheet('newSong')} id="write-new"><Icon name="plus" size={18} stroke={2.6} />{t('newSongT')}</button></div>
          <span class="pc-only"><Mascot mood="happy" size={120} /></span>
        </section>
        <div class="list inset">
          <button type="button" class="row" id="write-lyrics" onClick={() => openSheet('newSong', { kind: 'lead' })}>
            <span class="badge c-orange solid" style={{ width: 30, height: 30, borderRadius: 8 }}><Icon name="chords" size={18} stroke={2.1} /></span>
            <span class="row-main"><span class="row-title">{t('ceFromLyrics')}</span><span class="row-sub">{t('ceFromLyricsSub')}</span></span><Icon name="chevronR" size={15} stroke={2.4} style={{ opacity: 0.35 }} />
          </button>
          <button type="button" class="row" id="write-scan" onClick={() => pageRef.current?.click()}>
            <span class="badge c-violet solid" style={{ width: 30, height: 30, borderRadius: 8 }}><Icon name="camera" size={18} stroke={2.1} /></span>
            <span class="row-main"><span class="row-title">{t('wayScan')}{!hasPlan('pro') && <span class="pro-tag">PRO</span>}</span><span class="row-sub">{t('writeScanSub')}</span></span><Icon name="chevronR" size={15} stroke={2.4} style={{ opacity: 0.35 }} />
          </button>
          <button type="button" class="row" onClick={() => fileRef.current?.click()}>
            <span class="badge c-blue solid" style={{ width: 30, height: 30, borderRadius: 8 }}><Icon name="upload" size={18} stroke={2.1} /></span>
            <span class="row-main"><span class="row-title">{t('wayFile')}</span><span class="row-sub">{t('wayFileSub')}</span></span><Icon name="chevronR" size={15} stroke={2.4} style={{ opacity: 0.35 }} />
          </button>
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
      <button type="button" class="st-main" onClick={() => (p.chordSong ? push('chordEditor', { id: p.id }) : push('studio', { id: p.id }))}>
        <Cover title={p.title} instrument={p.instrument} keyText={p.keyText} size="xs" icon={fix ? 'pencil' : null} />
        <span class="st-txt"><strong>{p.title}</strong><span class="tiny">{[p.keyText, p.measures ? t('barsN', { n: p.measures }) : '', p.instrument ? instrumentName(p.instrument) : ''].filter(Boolean).join(' · ')}</span></span>
      </button>
      <button type="button" class="st-play" onClick={() => push('piece', { id: p.id })} aria-label={t('practice')}><Icon name="play" size={16} fill stroke={1.5} /></button>
    </div>
  );
}

const WIZ = [
  { id: 'lead', icon: 'chords', color: 'orange' }, { id: 'melody', icon: 'note1', color: 'teal' }, { id: 'full', icon: 'staff', color: 'blue' },
  { id: 'improv', icon: 'sparkles', color: 'pink' }, { id: 'rhythm', icon: 'metronome', color: 'violet' }, { id: 'sound', icon: 'wave', color: 'red' }, { id: 'exercise', icon: 'stairs', color: 'green' },
];
const WIZ_LABEL = { lead: 'wizLead', melody: 'wizMelody', full: 'wizFull', improv: 'wizImprov', rhythm: 'wizRhythm', sound: 'wizSound', exercise: 'wizExercise' };

/** A tiny moving picture for each kind (CSS only; still with reduced motion). */
function WizArt({ kind }) {
  if (kind === 'lead') return <span class="wiz-art" aria-hidden="true">{[['C', 8, 20], ['G', 36, 42], ['Am', 54, 18], ['F', 30, 64]].map(([c, x, y], i) => <i key={c} style={{ '--i': i, left: `${x}%`, top: `${y}%` }}>{c}</i>)}</span>;
  if (kind === 'melody') return <span class="wiz-art" aria-hidden="true"><b class="staff" />{[0, 1, 2, 3, 4].map((i) => <i key={i} class="nt" style={{ '--i': i, '--y': [10, 4, 7, 1, 5][i] }} />)}</span>;
  if (kind === 'sound') return <span class="wiz-art" aria-hidden="true">{[0, 1, 2, 3, 4, 5, 6].map((i) => <i key={i} class="bar" style={{ '--i': i }} />)}</span>;
  return <span class="wiz-art" aria-hidden="true"><b class="staff" />{[0, 1, 2].map((i) => <i key={i} class="nt" style={{ '--i': i, '--y': [8, 3, 6][i] }} />)}</span>;
}

/** New song: first what kind (lead sheet, melody + chords, full notation, improvisation, chord/rhythm song,
 *  a Sound, an exercise), then just the few settings that kind needs. */
export function NewSongSheet({ kind: kind0 = null, quick = false }) {
  const s = useApp();
  const [kind, setKind] = useState(kind0);
  const [title, setTitle] = useState('');
  const [instrument, setInstrument] = useState(INSTRUMENTS.includes(s.settings.instrument) ? s.settings.instrument : 'piano');
  const [key, setKey] = useState(0);
  const [time, setTime] = useState([4, 4]);
  const [tempo, setTempo] = useState(90);
  const [style, setStyle] = useState('pop');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const kinds = WIZ.filter((k) => (k.id !== 'sound' || flag('sounds')) && (k.id !== 'improv' || flag('improvise')));
  const choose = (k) => {
    if (k === 'improv') { closeSheet(); push('improvise', {}, 'write'); return; }
    if (k === 'exercise') { closeSheet(); setTimeout(() => openSheet('scale'), 0); return; }
    if (k === 'sound') { closeSheet(); push('sound', {}, 'write'); return; }
    setKind(k);
  };
  const make = async () => {
    setBusy(true);
    try {
      if (kind === 'lead' || kind === 'rhythm') {
        closeSheet();
        push('chordEditor', { text: kind === 'lead' ? text : '', title: title.trim(), fresh: true, init: { key: { fifths: key, mode: 'major' }, time: { beats: time[0], beatType: time[1] }, tempo, style, keyGiven: !text.trim() } }, 'write');
        return;
      }
      const inst = kind === 'full' ? instrument : (instrument === 'piano' ? 'voice' : instrument);
      const score = blankScore({ title: title.trim() || t('untitledSong'), composer: (s.me?.name && s.me.name !== 'Musician' ? s.me.name : s.settings.name) || '', instrument: inst, key, time, tempo, bars: 4 });
      const rec = await addScore(score, { source: 'written', title: score.title, extra: { edited: Date.now(), writeKind: kind } });
      closeSheet();
      push('studio', { id: rec.id, fresh: true }, 'write');
    } catch (e) { toast(e.message || String(e), 'err'); setBusy(false); }
  };
  if (!kind) {
    // three clear choices (most people want one of these), the rest folded under "More ways"
    const big = ['lead', 'melody', flag('sounds') ? 'sound' : 'full'];
    const moreKinds = kinds.filter((k) => !big.includes(k.id) && k.id !== 'rhythm');
    const forYou = ['voice', 'guitar', 'ukulele', 'bass'].includes(s.settings.instrument) ? 'lead' : 'melody';
    return (
      <SheetFrame title={t('createWhat')}>
        <div class="wiz-hello"><Mascot mood="cheer" size={58} /><p>{t('wizHello')}</p></div>
        {quick && <button type="button" class="quick-start" id="wiz-quick" onClick={() => { closeSheet(); push('chordEditor', { title: t('mySong'), fresh: true, init: { key: { fifths: 0, mode: 'major' }, time: { beats: 4, beatType: 4 }, tempo: 90, style: 'pop', keyGiven: true } }, 'write'); }}>
          <span class="badge c-teal solid" style={{ width: 40, height: 40, borderRadius: 12 }}><Icon name="sparkles" size={22} stroke={2.1} /></span>
          <span class="row-main"><span class="row-title">{t('quickStart')}</span><span class="row-sub">{t('quickStartSub')}</span></span>
          <Icon name="play" size={18} fill />
        </button>}
        <div class="wiz-big" id="wiz-kinds">
          {big.map((id) => (
            <button type="button" class={`wiz-card wiz-opt k-${id}`} key={id} id={`wiz-${id}`} onClick={() => { tick(); choose(id); }}>
              <WizArt kind={id} />
              <span class="wiz-t"><strong>{t(WIZ_LABEL[id])}</strong><span>{t(`${WIZ_LABEL[id]}Sub`)}</span></span>
              {id === forYou && <span class="wiz-rec">{t('wizForYou')}</span>}
              <span class="wiz-go"><Icon name="chevronR" size={18} stroke={2.6} /></span>
            </button>
          ))}
        </div>
        <button type="button" class="wiz-more-btn" id="wiz-more" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
          {t('wizMoreWays')}<Icon name="chevronR" size={14} stroke={2.6} style={{ transform: moreOpen ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }} />
        </button>
        {moreOpen && <div class="wiz-more" id="wiz-more-list">{moreKinds.map((k) => (
          <button type="button" class="wiz-chip" key={k.id} id={`wiz-${k.id}`} onClick={() => { tick(); choose(k.id); }}>
            <span class={`badge c-${k.color} solid`}><Icon name={k.icon} size={18} stroke={2.1} /></span>
            <span><strong>{t(WIZ_LABEL[k.id])}</strong><span>{t(`${WIZ_LABEL[k.id]}Sub`)}</span></span>
          </button>
        ))}</div>}
      </SheetFrame>
    );
  }
  const chordKind = kind === 'lead' || kind === 'rhythm';
  return (
    <SheetFrame title={t(WIZ_LABEL[kind])} left={kind0 ? undefined : t('back')} onLeft={kind0 ? undefined : () => setKind(null)} right={t('createT')} onRight={make} rightDisabled={busy}>
      <label class="field3"><span>{t('songTitle')}</span><input id="new-song-title" value={title} onInput={(e) => setTitle(e.currentTarget.value)} placeholder={t('untitledSong')} maxLength={120} /></label>
      {kind === 'lead' && (
        <label class="field3"><span>{t('wizPaste')}</span>
          <textarea id="new-song-lyrics" class="field" rows={6} value={text} onInput={(e) => setText(e.currentTarget.value)} placeholder={t('wizPastePh')} />
        </label>
      )}
      {!chordKind && <>
        <span class="tiny">{t('instrument')}</span>
        <div class="chips wrap">{INSTRUMENTS.map((k) => <Chip key={k} on={instrument === k} onClick={() => setInstrument(k)}>{instrumentName(k)}</Chip>)}</div>
      </>}
      {(!chordKind || !text.trim()) && <>
        <span class="tiny">{t('key')}</span>
        <div class="chips wrap">{KEYS.map((f) => <Chip key={f} on={key === f} onClick={() => setKey(f)}>{keyLabel(f)}</Chip>)}</div>
      </>}
      <span class="tiny">{t('time')}</span>
      <div class="chips wrap">{TIMES.map((x) => <Chip key={x.join('/')} on={time.join('/') === x.join('/')} onClick={() => { setTime(x); if (chordKind) setStyle(x[0] === 3 ? 'waltz' : x[1] === 8 ? 'six8' : style === 'waltz' || style === 'six8' ? 'pop' : style); }}>{x.join('/')}</Chip>)}</div>
      {chordKind && <>
        <span class="tiny">{t('styleT')}</span>
        <div class="chips wrap" id="new-song-styles">{RHYTHM_IDS.map((r) => <Chip key={r} on={style === r} onClick={() => setStyle(r)}>{t(`rh_${r}`)}</Chip>)}</div>
      </>}
      <label class="field3"><span>{t('tempoT')} ♩ = {tempo}</span><input type="range" min="40" max="200" step="2" value={tempo} onInput={(e) => setTempo(Number(e.currentTarget.value))} /></label>
      <Button full icon={chordKind ? 'chords' : 'pencil'} onClick={make} disabled={busy} id="new-song-make">{t('startWriting')}</Button>
    </SheetFrame>
  );
}
// ---------------------------------------------------------------- the studio
