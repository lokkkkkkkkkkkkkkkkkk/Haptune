// Plays and renders a Sound (core/sound.js) with Web Audio. One graph builder serves both the live mixer and the
// mixdown (OfflineAudioContext), so what you export is what you heard:
//   clip -> gain -> low shelf -> high shelf -> pan -> master (+ reverb send) -> limiter -> out
// Instrument and backing tracks are rendered to audio buffers first (pre-rendered accompaniment: no live synth
// voices to run out of time on a low-end phone). Clips (recordings, imports, takes) are kept in IndexedDB.
import * as S from '../core/sound.js';
import { songAccompaniment } from '../core/chordbars.js';
import { swingTime } from '../core/rhythm.js';
import { db } from './storage.js';
import { audioContext, outputDelay } from './audio.js';

const AC = () => globalThis.AudioContext || globalThis.webkitAudioContext;
const OAC = () => globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
const SR = 44100;
const hz = (m) => 440 * 2 ** ((m - 69) / 12);

// ---------------------------------------------------------------- clips
export async function saveClip(bytes, type, { decode = true } = {}) {
  const id = `clip:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  await db.put('kv', { k: id, data: bytes, type });
  let info = { id, seconds: 0, sampleRate: SR };
  if (decode) { const buf = await decodeClip(bytes); info = { id, seconds: buf.duration, sampleRate: buf.sampleRate }; cache.set(id, buf); }
  return info;
}
const cache = new Map();
async function decodeClip(bytes) {
  const c = audioContext() || new (AC())();
  return c.decodeAudioData(bytes.slice(0).buffer || bytes.slice(0));
}
export async function loadClip(id) {
  if (cache.has(id)) return cache.get(id);
  const rec = await db.get('kv', id);
  if (!rec) return null;
  const buf = await decodeClip(new Uint8Array(rec.data));
  cache.set(id, buf);
  return buf;
}

// ---------------------------------------------------------------- note tracks -> buffers
// One wave table and one noise buffer per render: building a PeriodicWave per note costs several FFTs, and
// that (not the voices) is what made a 60-second backing take half a minute to render.
const WAVES = { bass: [0, 1, 0.3, 0.1, 0, 0], organ: [0, 1, 0.7, 0.5, 0.3, 0.2], other: [0, 1, 0.5, 0.3, 0.2, 0.1] };
const perCtx = new WeakMap();
function shared(c) {
  let x = perCtx.get(c);
  if (!x) {
    const nb = c.createBuffer(1, Math.floor(c.sampleRate * 0.4), c.sampleRate);
    const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    x = { waves: {}, noise: nb };
    perCtx.set(c, x);
  }
  return x;
}
function waveFor(c, inst) {
  const k = WAVES[inst] ? inst : 'other';
  const x = shared(c);
  return x.waves[k] || (x.waves[k] = c.createPeriodicWave(new Float32Array(WAVES[k]), new Float32Array(6), { disableNormalization: false }));
}
function synthVoice(c, dest, t, midi, dur, vel, inst) {
  const g = c.createGain();
  const o = c.createOscillator();
  o.setPeriodicWave(waveFor(c, inst));
  o.frequency.value = hz(midi);
  const v = Math.max(0.05, Math.min(1, vel / 127)) * (inst === 'bass' ? 0.5 : 0.28);
  const decay = inst === 'organ' ? 0 : inst === 'guitar' ? 1.2 : 1.8;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(v, t + 0.008);
  if (decay) g.gain.setTargetAtTime(v * 0.35, t + 0.02, decay / 3);
  g.gain.setTargetAtTime(0.0001, t + dur, 0.08);
  o.connect(g); g.connect(dest);
  o.start(t); o.stop(t + dur + 0.6);
}
function drumHit(c, dest, t, kind, vel) {
  const g = c.createGain(); g.connect(dest);
  const v = vel / 127;
  if (kind === 'kick') {
    const o = c.createOscillator(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(0.9 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35); o.connect(g); o.start(t); o.stop(t + 0.4);
    return;
  }
  const n = c.createBufferSource();
  n.buffer = shared(c).noise;
  const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = kind === 'snare' ? 1400 : kind === 'rim' ? 1700 : 7000;
  const len = kind === 'snare' ? 0.2 : kind === 'ride' ? 0.4 : 0.06;
  g.gain.setValueAtTime((kind === 'snare' ? 0.45 : 0.18) * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
  n.connect(f); f.connect(g); n.start(t); n.stop(t + len + 0.02);
}

/** Events in seconds for a track: [{time, dur, midi, vel, inst} | {time, drum, vel}]. */
export function trackEvents(sound, track) {
  const spb = S.secondsPerBeat(sound);
  if (track.kind === 'instrument') return track.notes.map((n) => ({ time: n.t * spb, dur: n.dur * spb, midi: n.midi, vel: n.vel || 90, inst: track.instrument }));
  if (track.kind === 'backing' && track.song) {
    const acc = songAccompaniment({ ...track.song, tempo: sound.tempo }, { style: track.style || track.song.style });
    const qs = 60 / sound.tempo;
    return acc.events.map((e) => (e.inst === 'drums' ? { time: swingTime(e.t, acc.swing) * qs, drum: e.drum, vel: e.vel }
      : { time: swingTime(e.t, acc.swing) * qs, dur: e.dur * qs, midi: e.midi, vel: e.vel, inst: e.inst === 'bass' ? 'bass' : acc.sound }));
  }
  return [];
}

const newBuffer = (ch, len, sr) => (typeof AudioBuffer === 'function' && AudioBuffer.length !== undefined
  ? (() => { try { return new AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: sr }); } catch { return null; } })() : null)
  || new (OAC())(ch, Math.max(1, len), sr).createBuffer(ch, Math.max(1, len), sr);

/**
 * Renders events to an AudioBuffer offline. Browsers walk every scheduled node on each 128-sample block, so one
 * context holding a whole song's notes gets slow (1000 notes over 60 s took ~9 s in Chrome). The song is cut into
 * windows of a few seconds, each rendered with only its own notes (plus their ring-out), side by side, and summed.
 */
export const RENDER_WINDOW = 4;
export async function renderEvents(events, seconds, { window: win = RENDER_WINDOW } = {}) {
  const O = OAC();
  const total = Math.max(1, Math.ceil((seconds + 1) * SR));
  const out = newBuffer(2, total, SR);
  const groups = new Map();
  for (const e of events) { const k = Math.floor(Math.max(0, e.time) / win); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  const jobs = [...groups].map(([k, evs]) => async () => {
    const t0 = k * win;
    const end = evs.reduce((m, e) => Math.max(m, e.time + (e.drum ? 0.5 : (e.dur || 0) + 0.7)), t0 + 0.1);
    const len = Math.min(total - Math.floor(t0 * SR), Math.ceil((end - t0) * SR));
    if (len <= 0) return;
    const c = new O(2, len, SR);
    const bus = c.createGain(); bus.gain.value = 0.9; bus.connect(c.destination);
    for (const e of evs) { const at = Math.max(0, e.time - t0); if (e.drum) drumHit(c, bus, at, e.drum, e.vel); else synthVoice(c, bus, at, e.midi, e.dur, e.vel, e.inst); }
    const part = await c.startRendering();
    const off = Math.floor(t0 * SR);
    for (let ch = 0; ch < 2; ch++) {
      const src = part.getChannelData(ch), dst = out.getChannelData(ch);
      const n = Math.min(src.length, dst.length - off);
      for (let i = 0; i < n; i++) dst[off + i] += src[i];
    }
  });
  // a few at a time: enough to use the cores, not so many that a phone runs out of memory
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => { while (next < jobs.length) await jobs[next++](); }));
  return out;
}

const rendered = new Map();       // track id + its content -> buffer
async function bufferFor(sound, t) {
  if (t.clip?.id) {
    const b = await loadClip(t.clip.id);
    if (b && Math.abs((t.stretch || 1) - 1) > 1e-3) {
      const key = `${t.clip.id}@${t.stretch}`;
      if (!rendered.has(key)) {
        const chans = Array.from({ length: b.numberOfChannels }, (_, i) => S.timeStretch(b.getChannelData(i), t.stretch));
        const out = new (OAC())(chans.length, chans[0].length, b.sampleRate).createBuffer(chans.length, chans[0].length, b.sampleRate);
        chans.forEach((x, i) => out.copyToChannel(x, i));
        rendered.set(key, out);
      }
      return rendered.get(key);
    }
    return b;
  }
  if (t.kind === 'instrument' || t.kind === 'backing') {
    const key = `${t.id}:${JSON.stringify(t.notes)}:${JSON.stringify(t.song)}:${sound.tempo}:${t.style || ''}`;
    if (!rendered.has(key)) {
      const ev = trackEvents(sound, t);
      if (!ev.length) return null;                     // an empty instrument track: nothing to render
      const end = ev.reduce((m, e) => Math.max(m, e.time + (e.dur || 0.4)), 0);
      rendered.set(key, renderEvents(ev, Math.min(S.soundSeconds(sound), end + 0.5)));   // the promise, so parallel calls share one render
    }
    return rendered.get(key);
  }
  return null;
}

// ---------------------------------------------------------------- the graph (live and offline)
function impulse(c) {
  const len = Math.floor(c.sampleRate * 1.2), ir = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3; }
  return ir;
}

/**
 * Schedules the Sound on context `c` into `dest`, starting `from` seconds into it at context time `when`.
 * Returns the sources (to stop them). `buffers` maps track id -> AudioBuffer.
 */
export function schedule(c, dest, sound, buffers, { when = c.currentTime + 0.05, from = 0, clicks = false } = {}) {
  const length = S.soundSeconds(sound);
  const master = c.createGain(); master.gain.value = sound.master?.volume ?? 0.9;
  const limiter = c.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.1;
  master.connect(limiter); limiter.connect(dest);
  const verb = c.createConvolver(); verb.buffer = impulse(c);
  const wet = c.createGain(); wet.gain.value = 0.6; verb.connect(wet); wet.connect(master);
  const sources = [];
  for (const t of S.audible(sound)) {
    const buf = buffers.get(t.id);
    if (!buf) continue;
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain();
    const low = c.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 200; low.gain.value = t.eqLow || 0;
    const high = c.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 4000; high.gain.value = t.eqHigh || 0;
    const pan = c.createStereoPanner ? c.createStereoPanner() : null;
    if (pan) pan.pan.value = t.pan || 0;
    const send = c.createGain(); send.gain.value = t.reverb || 0;
    src.connect(g); g.connect(low); low.connect(high);
    if (pan) { high.connect(pan); pan.connect(master); } else high.connect(master);
    high.connect(send); send.connect(verb);
    const isClip = !!t.clip;
    const clipStart = isClip ? t.trim.start * (t.stretch || 1) : 0;
    const clipEnd = isClip ? (t.trim.end ?? buf.duration / (t.stretch || 1)) * (t.stretch || 1) : buf.duration;
    const start = isClip ? t.offset : 0;
    if (t.loop && isClip) { src.loop = true; src.loopStart = t.loop.start * (t.stretch || 1); src.loopEnd = t.loop.end * (t.stretch || 1); }
    const playFor = t.loop ? length - start : clipEnd - clipStart;
    const skip = Math.max(0, from - start);
    if (skip >= playFor) continue;
    const at = when + Math.max(0, start - from);
    const vol = (t.volume ?? 0.8) * (t.gain ?? 1);
    const dur = playFor - skip;
    g.gain.setValueAtTime(t.fadeIn && skip < t.fadeIn ? 0.0001 : vol, at);
    if (t.fadeIn && skip < t.fadeIn) g.gain.linearRampToValueAtTime(vol, at + (t.fadeIn - skip));
    if (t.fadeOut) { g.gain.setValueAtTime(vol, at + Math.max(0, dur - t.fadeOut)); g.gain.linearRampToValueAtTime(0.0001, at + dur); }
    src.start(at, clipStart + (t.loop ? skip % Math.max(0.01, (t.loop.end - t.loop.start) * (t.stretch || 1)) : skip), t.loop ? undefined : dur);
    if (t.loop) src.stop(at + dur);
    sources.push(src);
  }
  if (clicks) {
    const spb = S.secondsPerBeat(sound), beats = sound.time?.beats || 4;
    for (let k = Math.ceil(from / spb); k * spb < length; k++) {
      const at = when + k * spb - from;
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = k % beats === 0 ? 1500 : 1000;
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.3, at + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      o.connect(g); g.connect(dest); o.start(at); o.stop(at + 0.06); sources.push(o);
    }
  }
  return { sources, length, stop: () => sources.forEach((s) => { try { s.stop(); } catch { /* ended */ } }), master };
}

export async function buffersFor(sound) {
  // offline renders run on their own threads: render the tracks side by side
  const bufs = await Promise.all(sound.tracks.map((t) => bufferFor(sound, t)));
  const m = new Map();
  sound.tracks.forEach((t, i) => { if (bufs[i]) m.set(t.id, bufs[i]); });
  return m;
}

/** Live playback from `from` seconds; returns {stop, startedAt, position()}. */
export async function play(sound, { from = 0, clicks = false } = {}) {
  const c = audioContext();
  const buffers = await buffersFor(sound);
  const when = c.currentTime + 0.08;
  const h = schedule(c, c.destination, sound, buffers, { when, from, clicks });
  return { ...h, startedAt: when, position: () => from + (c.currentTime - outputDelay() - when) };
}

/** The mixdown (stereo AudioBuffer), rendered offline. Also used per track for stems. */
export async function mixdown(sound, { only = null } = {}) {
  const s = only ? { ...sound, tracks: sound.tracks.filter((t) => t.id === only).map((t) => ({ ...t, solo: false, mute: false })) } : sound;
  const buffers = await buffersFor(s);
  const length = S.soundSeconds(s);
  const c = new (OAC())(2, Math.ceil((length + 0.5) * SR), SR);
  schedule(c, c.destination, s, buffers, { when: 0, from: 0 });
  return c.startRendering();
}
export const wavOf = (buf) => S.encodeWav(Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)), buf.sampleRate);

/** Records the microphone (overdub while the others play). Resolves stop() -> {bytes, type, seconds, latency}. */
export async function recordMic() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find((x) => globalThis.MediaRecorder?.isTypeSupported?.(x)) || '';
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const t0 = performance.now();
  rec.start(250);
  return () => new Promise((resolve) => {
    rec.onstop = async () => {
      stream.getTracks().forEach((x) => x.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' });
      // the take reaches the recorder after the speaker delay and the mic's own buffer
      resolve({ bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type, seconds: (performance.now() - t0) / 1000, latency: outputDelay() + 0.03 });
    };
    rec.stop();
  });
}
