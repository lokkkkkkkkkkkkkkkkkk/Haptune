// Sounds: a GarageBand-style mixer for short ideas (Create > New Sound, Stage > + > Share a sound, a practice
// report's "Turn this take into a Sound", Stage > Layer). Up to 8 tracks: a microphone recording, a built-in
// instrument played on the keys, an imported audio file, backing from a chord song in any style, a Play Along
// take. Per track: volume, pan, mute, solo, gain, low/high EQ, reverb, fades, trim, loop, quantize. Tempo, key,
// metronome, count-in, time-stretch to a new tempo, master limiter, undo/redo, autosave (offline). Export WAV,
// stems, MIDI, Drive; post to Stage, where others can layer on it and practise its sheet.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp, push, openSheet, closeSheet, toast, addScore, go } from '../state.js';
import { t, getLang } from '../../core/i18n.js';
import { Icon, Button, Chip, List, Row, Toggle, Keyboard } from '../components.jsx';
import { NextChips, copyLink } from '../nextchips.jsx';
import { fromSound } from '../../core/piece.js';
import { NavBar, SheetFrame } from './common.jsx';
import * as S from '../../core/sound.js';
import * as CB from '../../core/chordbars.js';
import { RHYTHM_IDS } from '../../core/rhythm.js';
import { keyName } from '../../core/pitch.js';
import { writeZip } from '../../core/zip.js';
import { parseMusicXML } from '../../core/musicxml.js';
import { db } from '../storage.js';
import { saveFile } from '../files.js';
import { serverURL, hasServer, accountToken, deviceId } from '../api.js';
import { C } from '../account.js';
import { saveToDrive } from '../google.js';
import { whenSignedIn } from './hub.jsx';
import { tick } from '../native.js';
import * as E from '../soundengine.js';
import { note as playNote, audioContext } from '../audio.js';
import { track } from '../analytics.js';

const KIND_ICON = { mic: ['mic', 'pink'], instrument: ['piano', 'violet'], audio: ['upload', 'blue'], backing: ['chords', 'orange'], take: ['ear', 'teal'], stem: ['mixer', 'green'] };
const saveProject = (s) => db.put('kv', { k: `sound:${s.id}`, sound: s, updated: Date.now() });

export function SoundView({ id = null, fromTake = null, layerOf = null, active }) {
  const s = useApp();
  const [h, setH] = useState(null);
  const [playing, setPlaying] = useState(null);       // {stop, position}
  const [pos, setPos] = useState(0);
  const [rec, setRec] = useState(null);                // stop() of the microphone recording
  const [armed, setArmed] = useState(null);            // instrument track id the keys play into
  const [peaksOf, setPeaks] = useState({});
  const raf = useRef(0);
  const saveT = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        if (id) { const r = await db.get('kv', `sound:${id}`); if (r) { setH(S.history.start(r.sound)); return; } }
        let snd = S.newSound({ title: t('wizSound'), tempo: 90 });
        if (fromTake) {                      // a Play Along take as track 1
          const bytes = new Uint8Array(await (await fetch(fromTake.url)).arrayBuffer());
          const clip = await E.saveClip(bytes, 'audio/webm');
          snd = S.setSound(snd, { title: fromTake.title || snd.title, bars: Math.max(4, Math.ceil(clip.seconds / S.barSeconds(snd))) });
          snd = S.addTrack(snd, S.newTrack('take', { name: fromTake.title || 'Take', clip }));
        }
        if (layerOf) {                       // Layer with me: their mixdown is track 1
          const meta = await C.sounds.get(layerOf);
          const bytes = new Uint8Array(await (await fetch(`${serverURL()}/c/sounds/${layerOf}/audio`)).arrayBuffer());
          const clip = await E.saveClip(bytes, 'audio/mp4');
          snd = S.layerOn({ ...(meta.project || {}), title: meta.title, post_id: layerOf, credits: [...(meta.credits || []), meta.author ? { handle: meta.author.handle, name: meta.author.name } : null].filter(Boolean) },
            { mixdownClipId: clip.id, seconds: clip.seconds, sampleRate: clip.sampleRate });
          snd = S.setSound(snd, { bars: Math.max(snd.bars, Math.ceil(clip.seconds / S.barSeconds(snd))) });
        }
        setH(S.history.start(snd));
      } catch (e) { toast(e.message || String(e), 'err'); setH(S.history.start(S.newSound({ title: t('wizSound') }))); }
    })();
    return () => { cancelAnimationFrame(raf.current); };
  }, [id]);
  const snd = h?.now;
  useEffect(() => { if (!snd) return undefined; clearTimeout(saveT.current); saveT.current = setTimeout(() => saveProject(snd).catch(() => {}), 500); return () => clearTimeout(saveT.current); }, [snd]);
  useEffect(() => { if (!active) stopAll(); }, [active]);
  // waveforms of the clips
  useEffect(() => {
    if (!snd) return;
    snd.tracks.filter((x) => x.clip?.id && !peaksOf[x.clip.id]).forEach(async (x) => {
      const b = await E.loadClip(x.clip.id).catch(() => null);
      if (b) setPeaks((p) => ({ ...p, [x.clip.id]: S.peaks(b.getChannelData(0), 120) }));
    });
  }, [snd?.tracks.length]);

  const change = (fn) => { try { setH((x) => S.history.push(x, fn(x.now))); tick(); } catch (e) { toast(e.message || String(e), 'err'); } };
  if (!snd) return <div class="scroll"><NavBar title={t('wizSound')} backLabel={t('back')} /><div class="loading"><div class="spinner" /></div></div>;
  const total = S.soundSeconds(snd);

  function stopAll() { playing?.stop(); setPlaying(null); cancelAnimationFrame(raf.current); }
  const play = async (opts = {}) => {
    stopAll();
    const p = await E.play(snd, { from: opts.from ?? 0, clicks: snd.metronome });
    setPlaying(p);
    const loop = () => { const x = p.position(); setPos(Math.max(0, x)); if (x < p.length) raf.current = requestAnimationFrame(loop); else setPlaying(null); };
    raf.current = requestAnimationFrame(loop);
    return p;
  };
  const record = async () => {
    if (rec) {                                                         // stop: the take becomes a new track
      const r = await rec.stop();
      stopAll(); setRec(null);
      try {
        const clip = await E.saveClip(r.bytes, r.type);
        change((x) => S.addTrack(x, S.newTrack('mic', { name: `${t('scDevice')} ${x.tracks.filter((y) => y.kind === 'mic').length + 1}`, clip, offset: Math.max(0, rec.from - (snd.countIn ? S.barSeconds(snd) : 0)), trim: { start: (snd.countIn ? S.barSeconds(snd) : 0) + r.latency, end: null } })));
      } catch (e) { toast(e.message || String(e), 'err'); }
      return;
    }
    if (snd.tracks.length >= S.MAX_TRACKS) { toast(t('sdFull'), 'err'); return; }
    try {
      const stop = await E.recordMic();
      const lead = snd.countIn ? S.barSeconds(snd) : 0;
      setRec({ stop, from: pos });
      // count-in bar of clicks, then everyone else plays while you record
      await play({ from: Math.max(0, pos - lead) });
    } catch (e) { toast(t(e?.name === 'NotAllowedError' ? 'micDenied' : 'micUnavailable'), 'err'); }
  };
  const keyDown = (midi) => {
    audioContext(); playNote(audioContext().currentTime + 0.01, midi, 0.4, 90, 'piano');
    const tr = snd.tracks.find((x) => x.id === armed);
    if (!tr) return;
    const beat = Math.max(0, (playing ? playing.position() : pos) / S.secondsPerBeat(snd));
    change((x) => S.updateTrack(x, armed, (y) => ({ notes: [...y.notes, { t: Math.round(beat * 100) / 100, dur: 0.5, midi, vel: 90 }] })));
  };
  const fmt = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  return (
    <div class="scroll" id="sound">
      <NavBar title={snd.title || t('wizSound')} color="violet" backLabel={t('back')} actions={<>
        <button type="button" disabled={!h.past.length} onClick={() => setH(S.history.undo)} aria-label={t('undo')}><Icon name="arrowDown" size={20} style={{ transform: 'rotate(90deg)' }} /></button>
        <button type="button" disabled={!h.future.length} onClick={() => setH(S.history.redo)} aria-label={t('redo')}><Icon name="arrowDown" size={20} style={{ transform: 'rotate(-90deg)' }} /></button>
        <button type="button" onClick={() => openSheet('soundExport', { sound: snd })} aria-label={t('export')} id="sd-export"><Icon name="share" size={21} /></button>
      </>} />
      <div class="wrap" style={{ paddingTop: 10 }}>
        <input class="ce-title" value={snd.title} onChange={(e) => change((x) => S.setSound(x, { title: e.currentTarget.value }))} aria-label={t('songTitle')} />
        <div class="chips">
          <Chip onClick={() => openSheet('soundSettings', { sound: snd, onChange: (fn) => change(fn) })} id="sd-settings">♩{snd.tempo} · {keyName(snd.key)} · {snd.time.beats}/{snd.time.beatType} · {snd.bars} {t('bars').toLowerCase()}</Chip>
          <Chip on={snd.metronome} onClick={() => change((x) => S.setSound(x, { metronome: !x.metronome }))}>{t('metronome')}</Chip>
          <Chip on={snd.countIn} onClick={() => change((x) => S.setSound(x, { countIn: !x.countIn }))}>{t('countIn')}</Chip>
          {snd.parent && <span class="pill3"><Icon name="users" size={12} /> {snd.credits.map((c) => c.name || c.handle).join(', ')}</span>}
        </div>
        <div class="sd-transport">
          <button type="button" class="sd-btn" onClick={() => (playing ? stopAll() : play({ from: pos >= total ? 0 : pos }))} id="sd-play" aria-label={playing ? t('pause') : t('listen')}><Icon name={playing ? 'pause' : 'play'} size={24} fill={!playing} /></button>
          <button type="button" class={`sd-btn rec${rec ? ' on' : ''}`} onClick={record} id="sd-rec" aria-label={t('recordingNow')}><span class="dot" /></button>
          <button type="button" class="sd-btn" onClick={() => { stopAll(); setPos(0); }} aria-label={t('skipBack')}><Icon name="skipBack" size={20} /></button>
          <span class="sd-time num">{fmt(pos)} / {fmt(total)}</span>
        </div>
        <div class="sd-ruler" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPos(Math.max(0, Math.min(total, ((e.clientX - r.left) / r.width) * total))); }}>
          {(() => { const n = Math.round(total / S.barSeconds(snd)), every = n > 16 ? 4 : n > 8 ? 2 : 1; return Array.from({ length: Math.ceil(n / every) }, (_, i) => <i key={i}>{i * every + 1}</i>); })()}
          <b style={{ left: `${(pos / total) * 100}%` }} />
        </div>
        <div class="sd-tracks" id="sd-tracks">
          {snd.tracks.map((tr) => {
            const [ic, col] = KIND_ICON[tr.kind] || ['wave', 'gray'];
            const pk = tr.clip?.id && peaksOf[tr.clip.id];
            return (
              <div class={`sd-track c-${col}${tr.mute ? ' muted' : ''}${armed === tr.id ? ' armed' : ''}`} key={tr.id}>
                <button type="button" class="sd-tname" onClick={() => openSheet('soundTrack', { sound: snd, id: tr.id, onChange: (fn) => change(fn) })}>
                  <span class="badge solid" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--c)', color: '#fff', display: 'grid', placeItems: 'center' }}><Icon name={ic} size={16} stroke={2.2} /></span>
                  <span>{tr.name}</span>
                </button>
                <div class="sd-lane">
                  {pk ? <svg viewBox={`0 0 ${pk.length} 40`} preserveAspectRatio="none" style={{ left: `${(tr.offset / total) * 100}%`, width: `${Math.min(100, (S.trackSeconds(snd, tr) / total) * 100)}%` }}>
                    {pk.map(([lo, hi], i) => <rect key={i} x={i} y={20 - hi * 20} width={0.8} height={Math.max(0.5, (hi - lo) * 20)} />)}</svg>
                    : tr.kind === 'instrument' ? tr.notes.map((n, i) => <i key={i} class="sd-note" style={{ left: `${(n.t * S.secondsPerBeat(snd) / total) * 100}%`, width: `${Math.max(0.6, (n.dur * S.secondsPerBeat(snd) / total) * 100)}%`, top: `${100 - ((n.midi - 36) / 60) * 100}%` }} />)
                      : tr.kind === 'backing' ? <span class="sd-lane-label">{t(`rh_${tr.style || tr.song?.style || 'pop'}`)}</span> : null}
                </div>
                <div class="sd-ctl">
                  <button type="button" class={tr.mute ? 'on' : ''} onClick={() => change((x) => S.updateTrack(x, tr.id, { mute: !tr.mute }))} aria-label="mute">M</button>
                  <button type="button" class={tr.solo ? 'on' : ''} onClick={() => change((x) => S.updateTrack(x, tr.id, { solo: !tr.solo }))} aria-label="solo">S</button>
                  {tr.kind === 'instrument' && <button type="button" class={armed === tr.id ? 'on' : ''} onClick={() => setArmed(armed === tr.id ? null : tr.id)} aria-label={t('sdPlayKeys')}><Icon name="piano" size={14} /></button>}
                  <input type="range" min="0" max="1.2" step="0.01" value={tr.volume} onChange={(e) => change((x) => S.updateTrack(x, tr.id, { volume: Number(e.currentTarget.value) }))} aria-label={t('volume')} />
                </div>
              </div>
            );
          })}
          {snd.tracks.length < S.MAX_TRACKS && <Button kind="secondary" full icon="plus" onClick={() => openSheet('soundAdd', { sound: snd, onAdd: (tr) => { change((x) => S.addTrack(x, tr)); if (tr.kind === 'instrument') setArmed(tr.id); } })} id="sd-add">{t('sdAddTrack')}</Button>}
        </div>
        {/* one thing pinned at the bottom: the keys while a track is armed, otherwise Share */}
        {armed
          ? <div class="sd-keys"><p class="tiny muted">{t('sdKeysHint')}</p><Keyboard lo={48} hi={84} onKey={keyDown} />
            <Button kind="plain" small full onClick={() => setArmed(null)} id="sd-keys-done">{t('done')}</Button></div>
          : <div class="ce-bottom">
            <Button kind="brand" icon="stage" onClick={() => whenSignedIn(() => openSheet('soundPost', { sound: snd }))} id="sd-post">{t('stShareSound')}</Button>
          </div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sheets
export function SoundAddSheet({ sound, onAdd }) {
  const s = useApp();
  const fileRef = useRef(null);
  const [step, setStep] = useState('pick');
  const [style, setStyle] = useState('pop');
  const songs = s.pieces.filter((p) => p.chordSong);
  const add = (tr) => { onAdd(tr); closeSheet(); };
  const importFile = async (e) => {
    const f = e.currentTarget.files?.[0]; e.currentTarget.value = '';
    if (!f) return;
    if (!/^audio\//.test(f.type) && !/\.(wav|mp3|m4a|ogg|webm|flac|aac)$/i.test(f.name)) { toast(t('sdNotAudio'), 'err'); return; }
    if (f.size > 40 << 20) { toast(t('sdTooBig'), 'err'); return; }
    try { const clip = await E.saveClip(new Uint8Array(await f.arrayBuffer()), f.type); add(S.newTrack('audio', { name: f.name.replace(/\.[^.]+$/, '').slice(0, 30), clip })); } catch { toast(t('sdNotAudio'), 'err'); }
  };
  const quickSong = () => CB.autoChords(CB.newSong({ key: sound.key, time: sound.time, tempo: sound.tempo, bars: sound.bars, style }));
  if (step === 'backing') {
    return (
      <SheetFrame title={t('sdBacking')} left={t('back')} onLeft={() => setStep('pick')}>
        <span class="tiny">{t('styleT')}</span>
        <div class="chips wrap">{RHYTHM_IDS.map((r) => <Chip key={r} on={style === r} onClick={() => setStyle(r)}>{t(`rh_${r}`)}</Chip>)}</div>
        <List>
          <Row icon="sparkles" color="orange" title={t('sdQuickBacking')} subtitle={`${keyName(sound.key)} · I–V–vi–IV`} onClick={() => add(S.newTrack('backing', { name: t('sdBacking'), song: quickSong(), style }))} id="sd-add-quick" />
          {songs.map((p) => <Row key={p.id} icon="chords" color="orange" title={p.title} subtitle={p.keyText} onClick={() => add(S.newTrack('backing', { name: p.title, song: p.chordSong, style }))} />)}
        </List>
      </SheetFrame>
    );
  }
  return (
    <SheetFrame title={t('sdAddTrack')}>
      <input ref={fileRef} type="file" class="hidden-input" accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm,.flac" onChange={importFile} />
      <List>
        <Row icon="mic" color="pink" title={t('sdMicTrack')} subtitle={t('sdMicTrackSub')} onClick={() => { closeSheet(); toast(t('sdTapRecord')); }} />
        <Row icon="piano" color="violet" title={t('sdInstrument')} subtitle={t('sdInstrumentSub')} onClick={() => add(S.newTrack('instrument', { name: t('sdInstrument') }))} id="sd-add-inst" />
        <Row icon="chords" color="orange" title={t('sdBacking')} subtitle={t('sdBackingSub')} onClick={() => setStep('backing')} id="sd-add-backing" />
        <Row icon="upload" color="blue" title={t('sdImport')} subtitle={t('sdImportSub')} onClick={() => fileRef.current?.click()} />
      </List>
    </SheetFrame>
  );
}

export function SoundTrackSheet({ sound, id, onChange }) {
  const tr0 = sound.tracks.find((x) => x.id === id);
  const [tr, setTr] = useState(tr0);
  if (!tr) return null;
  const set = (patch) => { setTr((x) => ({ ...x, ...patch })); onChange((s) => S.updateTrack(s, id, patch)); };
  const slider = (key, label, min, max, step, fmt = (v) => v) => (
    <label class="field3"><span>{label}: {fmt(tr[key])}</span><input type="range" min={min} max={max} step={step} value={tr[key]} onInput={(e) => set({ [key]: Number(e.currentTarget.value) })} /></label>
  );
  return (
    <SheetFrame title={tr.name} right={t('done')} onRight={closeSheet}>
      <label class="field3"><span>{t('songTitle')}</span><input value={tr.name} maxLength={40} onChange={(e) => set({ name: e.currentTarget.value })} /></label>
      {slider('volume', t('volume'), 0, 1.2, 0.01, (v) => `${Math.round(v * 100)}%`)}
      {slider('pan', t('sdPan'), -1, 1, 0.05, (v) => (v < -0.02 ? `L${Math.round(-v * 100)}` : v > 0.02 ? `R${Math.round(v * 100)}` : 'C'))}
      {slider('gain', t('sdGain'), 0, 2, 0.05, (v) => `${(20 * Math.log10(Math.max(v, 0.01))).toFixed(1)} dB`)}
      {slider('eqLow', t('sdEqLow'), -12, 12, 1, (v) => `${v} dB`)}
      {slider('eqHigh', t('sdEqHigh'), -12, 12, 1, (v) => `${v} dB`)}
      {slider('reverb', t('sdReverb'), 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
      {slider('fadeIn', t('sdFadeIn'), 0, 5, 0.1, (v) => `${v}s`)}
      {slider('fadeOut', t('sdFadeOut'), 0, 5, 0.1, (v) => `${v}s`)}
      {tr.clip && <>
        {slider('offset', t('sdStart'), 0, Math.max(1, S.soundSeconds(sound)), 0.05, (v) => `${v.toFixed(2)}s`)}
        <label class="field3"><span>{t('sdTrim')}: {tr.trim.start.toFixed(2)}s – {(tr.trim.end ?? tr.clip.seconds).toFixed(2)}s</span>
          <input type="range" min="0" max={tr.clip.seconds} step="0.05" value={tr.trim.start} onInput={(e) => set({ trim: { ...tr.trim, start: Number(e.currentTarget.value) } })} />
          <input type="range" min="0" max={tr.clip.seconds} step="0.05" value={tr.trim.end ?? tr.clip.seconds} onInput={(e) => set({ trim: { ...tr.trim, end: Number(e.currentTarget.value) } })} /></label>
        <Row icon="loop" color="orange" title={t('loop')} chevron={false} right={<Toggle id="sd-loop" checked={!!tr.loop} label={t('loop')} onChange={(v) => set({ loop: v ? { start: tr.trim.start, end: tr.trim.end ?? tr.clip.seconds } : null })} />} />
      </>}
      {tr.kind === 'instrument' && <div class="row-gap" style={{ gap: 8, flexWrap: 'wrap' }}>
        {[[1, '♩'], [0.5, '♪'], [0.25, '𝅘𝅥𝅯'], [1 / 3, '3']].map(([g, lab]) => <Button key={lab} small kind="secondary" onClick={() => set({ notes: S.quantize(tr.notes, g) })}>{t('sdQuantize')} {lab}</Button>)}
      </div>}
      {tr.kind === 'backing' && <div class="chips wrap">{RHYTHM_IDS.map((r) => <Chip key={r} on={(tr.style || tr.song?.style) === r} onClick={() => set({ style: r })}>{t(`rh_${r}`)}</Chip>)}</div>}
      {(tr.kind === 'mic' || tr.kind === 'take') && hasServer() && <Button small kind="secondary" icon="staff" onClick={() => transcribe(tr)}>{t('sdTranscribe')} <span class="pro-tag beta">{t('beta')}</span></Button>}
      <Button kind="plain" full icon="trash" onClick={() => { onChange((s) => S.removeTrack(s, id)); closeSheet(); }}>{t('delete')}</Button>
    </SheetFrame>
  );
}

/** A recorded melody becomes a sheet others can practise (the server's recording -> score). */
async function transcribe(tr) {
  try {
    const rec = await db.get('kv', tr.clip.id);
    const form = new FormData();
    form.append('file', new Blob([rec.data], { type: rec.type || 'audio/webm' }), 'melody.webm');
    form.append('instrument', 'voice');
    toast(t('sdTranscribing'));
    const res = await fetch(`${serverURL()}/score/transcribe`, { method: 'POST', body: form, headers: { 'X-Haptune-Device': deviceId(), Authorization: `Bearer ${accountToken()}` } });
    if (!res.ok) throw new Error(`${res.status}`);
    const xml = await res.text();
    const p = await addScore(parseMusicXML(xml), { source: 'written', fmt: 'musicxml', title: tr.name });
    closeSheet(); push('piece', { id: p.id });
  } catch (e) { toast(`${t('sdTranscribe')}: ${e.message}`, 'err'); }
}

export function SoundSettingsSheet({ sound, onChange }) {
  const [sd, setSd] = useState(sound);
  const set = (fn) => { onChange(fn); setSd((x) => fn(x)); };
  return (
    <SheetFrame title={t('wizSound')} right={t('done')} onRight={closeSheet}>
      <label class="field3"><span>{t('tempoT')} ♩ = {sd.tempo} ({t('sdStretchNote')})</span><input type="range" min="40" max="200" step="1" value={sd.tempo} onChange={(e) => set((x) => S.changeTempo(x, Number(e.currentTarget.value)))} /></label>
      <span class="tiny">{t('key')}</span>
      <div class="chips wrap">{[-4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map((f) => <Chip key={f} on={sd.key.fifths === f} onClick={() => set((x) => S.setSound(x, { key: { fifths: f, mode: 'major' } }))}>{keyName({ fifths: f, mode: 'major' })}</Chip>)}</div>
      <span class="tiny">{t('time')}</span>
      <div class="chips wrap">{[[4, 4], [3, 4], [6, 8]].map(([b, bt]) => <Chip key={`${b}/${bt}`} on={sd.time.beats === b && sd.time.beatType === bt} onClick={() => set((x) => S.setSound(x, { time: { beats: b, beatType: bt } }))}>{b}/{bt}</Chip>)}</div>
      <span class="tiny">{t('bars')}</span>
      <div class="chips wrap">{[4, 8, 12, 16, 24, 32].map((n) => <Chip key={n} on={sd.bars === n} onClick={() => set((x) => S.setSound(x, { bars: n }))}>{n}</Chip>)}</div>
    </SheetFrame>
  );
}

export function SoundExportSheet({ sound }) {
  const [busy, setBusy] = useState('');
  const name = (sound.title || 'sound').replace(/[\\/:*?"<>|]+/g, ' ').trim();
  const run = async (kind) => {
    setBusy(kind);
    try {
      if (kind === 'wav' || kind === 'drive' || kind === 'share') {
        const t0 = performance.now();
        const wav = E.wavOf(await E.mixdown(sound));
        globalThis.__lastMixdownMs = Math.round(performance.now() - t0);
        if (kind === 'wav') await saveFile(`${name}.wav`, wav);
        else if (kind === 'drive') { const r = await saveToDrive(`${name}.wav`, 'audio/wav', wav); toast(t('savedToDrive')); void r; }
        else if (navigator.canShare?.({ files: [new File([wav], `${name}.wav`, { type: 'audio/wav' })] })) await navigator.share({ files: [new File([wav], `${name}.wav`, { type: 'audio/wav' })], title: name });
        else await saveFile(`${name}.wav`, wav);
      } else if (kind === 'stems') {
        const files = [];
        for (const tr of sound.tracks) files.push({ name: `${String(files.length + 1).padStart(2, '0')} ${tr.name.replace(/[\\/:*?"<>|]+/g, ' ')}.wav`, data: E.wavOf(await E.mixdown(sound, { only: tr.id })) });
        await saveFile(`${name} stems.zip`, writeZip(files));
      } else if (kind === 'midi') await saveFile(`${name}.mid`, S.soundToMidi(sound));
    } catch (e) { toast(e.message || String(e), 'err'); }
    setBusy('');
  };
  const hasInst = sound.tracks.some((x) => x.kind === 'instrument' && x.notes.length);
  return (
    <SheetFrame title={t('export')}>
      <List>
        <Row icon="download" color="violet" title={t('sdWav')} onClick={() => run('wav')} id="sd-exp-wav" detail={busy === 'wav' ? '…' : null} />
        <Row icon="mixer" color="green" title={t('sdStems')} onClick={() => run('stems')} id="sd-exp-stems" detail={busy === 'stems' ? '…' : null} />
        {hasInst && <Row icon="piano" color="blue" title="MIDI" onClick={() => run('midi')} id="sd-exp-midi" />}
        <Row icon="cloud" color="teal" title={t('saveToDrive')} onClick={() => run('drive')} />
        <Row icon="share" color="orange" title={t('repShare')} onClick={() => run('share')} />
      </List>
    </SheetFrame>
  );
}

export function SoundPostSheet({ sound }) {
  const [title, setTitle] = useState(sound.title);
  const [body, setBody] = useState('');
  const [rights, setRights] = useState('');
  const [busy, setBusy] = useState(false);
  const backing = sound.tracks.find((x) => x.kind === 'backing' && x.song);
  const post = async () => {
    setBusy(true);
    try {
      const wav = E.wavOf(await E.mixdown(sound));
      const form = new FormData();
      form.append('title', title.trim() || 'Sound');
      form.append('body', body.trim());
      form.append('rights', rights);
      form.append('project', JSON.stringify({ ...S.projectForPost(sound), seconds: S.soundSeconds(sound) }));
      if (sound.parent) form.append('parent_id', sound.parent);
      if (backing) form.append('sheet_xml', CB.songToMusicXML({ ...backing.song, title: title.trim() || backing.song.title, tempo: sound.tempo }));
      form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'mix.wav');
      const res = await fetch(`${serverURL()}/c/sounds`, { method: 'POST', body: form, headers: { 'X-Haptune-Device': deviceId(), Authorization: `Bearer ${accountToken()}` } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof j.detail === 'string' ? j.detail : j.detail?.message || `${res.status}`);
      toast(t('sdPosted'));
      track('sound_made', { value: S.soundSeconds(sound), props: { tracks: sound.tracks.length } });
      closeSheet();
      go('community');
      if (j.id) push('soundPage', { id: j.id, justPosted: true }, 'community');
    } catch (e) { toast(e.message || String(e), 'err'); setBusy(false); }
  };
  return (
    <SheetFrame title={t('stShareSound')} right={t('post')} onRight={post} rightDisabled={busy || !rights}>
      <label class="field3"><span>{t('songTitle')}</span><input id="sd-post-title" value={title} maxLength={120} onInput={(e) => setTitle(e.currentTarget.value)} /></label>
      <label class="field3"><span>{t('sdAbout')}</span><textarea class="field" rows={2} maxLength={1000} value={body} onInput={(e) => setBody(e.currentTarget.value)} /></label>
      <span class="tiny">{t('sdRights')}</span>
      <div class="chips wrap" id="sd-rights">{['own', 'pd', 'licensed'].map((r) => <Chip key={r} on={rights === r} onClick={() => setRights(r)}>{t(`sdRights_${r}`)}</Chip>)}</div>
      <p class="note-text">{t('sdCopyright')}</p>
      {backing && <p class="note-text"><Icon name="staff" size={14} /> {t('sdWithSheet')}</p>}
      <Button kind="brand" full icon="stage" disabled={busy || !rights} onClick={post} id="sd-post-send">{busy ? t('sending') : t('post')}</Button>
    </SheetFrame>
  );
}

// ---------------------------------------------------------------- on Stage
export function SoundsFeed({ active }) {
  const s = useApp();
  const [items, setItems] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { if (active) C.sounds.list().then((r) => setItems(r.items)).catch((e) => setErr(e.message)); }, [active, s.stageRev]);
  if (err) return <p class="note-text">{err}</p>;
  if (!items) return <div class="loading"><div class="spinner" /></div>;
  if (!items.length) return <div class="empty3 card"><h3>{t('stShareSound')}</h3><p>{t('stShareSoundSub')}</p><Button icon="wave" onClick={() => whenSignedIn(() => push('sound', {}, 'write'))}>{t('wizSound')}</Button></div>;
  return <div class="sound-feed" id="sound-feed">{items.map((x) => <SoundCard key={x.id} x={x} />)}</div>;
}

/** One Sound on its own page (#sound/ID, links from Home, Find and notifications). */
export function SoundPageView({ id, justPosted = false }) {
  const [x, setX] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { C.sounds.get(id).then(setX).catch((e) => setErr(e.message || String(e))); }, [id]);
  return (
    <div class="scroll" id="sound-page">
      <NavBar title={x?.title || t('segSounds')} backLabel={t('back')} color="violet" />
      <div class="wrap" style={{ paddingTop: 12 }}>
        {err ? <p class="note-text err">{err}</p> : !x ? <div class="loading"><div class="spinner" /></div> : <>
          {justPosted && <NextChips flow="sound" id="sound-next" on={{ copyLink: () => copyLink(fromSound(x)), newSound: () => push('sound', {}, 'write') }} />}
          <SoundCard x={x} />
          {x.versions && (x.versions.before.length > 0 || x.versions.layers.length > 0) && <List>
            {[...x.versions.before, ...x.versions.layers].map((v) => <Row key={v.id} icon="wave" color="violet" title={v.title} subtitle={v.author?.name || ''} onClick={() => push('soundPage', { id: v.id })} />)}
          </List>}
        </>}
      </div>
    </div>
  );
}

export function SoundCard({ x }) {
  const [liked, setLiked] = useState({ on: x.liked, n: x.likes });
  const like = () => whenSignedIn(async () => { try { const r = await C.sounds.like(x.id); setLiked({ on: r.liked, n: r.likes }); } catch (e) { toast(e.message, 'err'); } });
  const sheet = async () => {
    try {
      const xml = await (await fetch(`${serverURL()}/c/sounds/${x.id}/sheet`)).text();
      const p = await addScore(parseMusicXML(xml), { source: 'stage', fmt: 'musicxml', title: x.title });
      push('piece', { id: p.id }, 'library'); go('library');
    } catch (e) { toast(e.message || String(e), 'err'); }
  };
  return (
    <div class="card sound-card">
      <div class="sc-head"><span class="badge c-violet solid" style={{ width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--s-violet)', color: '#fff' }}><Icon name="wave" size={20} /></span>
        <div class="t"><strong>{x.title}</strong><span class="tiny muted">{x.author?.name}{x.parent_id ? ` · ${t('sdLayer')}` : ''} · {Math.round(x.seconds)}s{x.tempo ? ` · ♩${x.tempo}` : ''}</span></div></div>
      {x.body && <p class="cr-text">{x.body}</p>}
      <audio controls preload="none" src={`${serverURL()}/c/sounds/${x.id}/audio`} style={{ width: '100%' }} />
      <div class="row-gap" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button small kind="secondary" icon="heart" onClick={like}>{liked.n || ''}</Button>
        <Button small kind="secondary" icon="plus" onClick={() => whenSignedIn(() => push('sound', { layerOf: x.id }, 'write'))}>{t('sdLayerWithMe')}</Button>
        {x.has_sheet && <Button small kind="brand" icon="staff" onClick={sheet}>{t('sdGetSheet')}</Button>}
      </div>
    </div>
  );
}
