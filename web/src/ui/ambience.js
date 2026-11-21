// Haptune's own sounds, made on the device (no audio files, nothing to license):
//  * background music: 8 gentle generated tracks, 4 for the light theme and 4 for the dark one. One is picked at
//    random each time the app opens (never the same as last time), and every play is a little different: the
//    chords loop, the melody notes are chosen afresh;
//  * sound effects: a soft tick for taps, a whoosh for sheets, a chime for "done", a low blip for problems.
// Both stop by themselves while real music plays, while the microphone listens (Play Along, the tuner) and when
// the app is in the background, so they never get in the way of practice. Settings › Sounds turns either off.
import { soundBusy } from './audio.js';

const NOTE = (m) => 440 * Math.pow(2, (m - 69) / 12);
// chord = scale degrees stacked from a root degree; prog = root degree of each bar
export const TRACKS = [
  { id: 'morning', theme: 'light', bpm: 76, root: 60, scale: [0, 2, 4, 7, 9], prog: [0, 3, 4, 2], pad: 'triangle', bell: 0.55, bass: true },
  { id: 'garden', theme: 'light', bpm: 84, root: 67, scale: [0, 2, 4, 6, 7, 9, 11], prog: [0, 1, 3, 4], pad: 'sine', pluck: 0.6, bass: true },
  { id: 'boats', theme: 'light', bpm: 66, root: 65, scale: [0, 2, 4, 5, 7, 9, 11], prog: [0, 5, 3, 4], pad: 'sine', box: 0.5, bass: false },
  { id: 'tea', theme: 'light', bpm: 60, root: 62, scale: [0, 2, 4, 5, 7, 9, 11], prog: [0, 3, 1, 4], pad: 'triangle', bell: 0.35, bass: true },
  { id: 'night', theme: 'dark', bpm: 58, root: 57, scale: [0, 3, 5, 7, 10], prog: [0, 3, 2, 4], pad: 'sine', bell: 0.3, bass: true },
  { id: 'moon', theme: 'dark', bpm: 54, root: 64, scale: [0, 2, 3, 5, 7, 9, 10], prog: [0, 3, 6, 4], pad: 'triangle', pluck: 0.3, bass: true },
  { id: 'stars', theme: 'dark', bpm: 50, root: 61, scale: [0, 2, 3, 5, 7, 8, 10], prog: [0, 5, 3, 6], pad: 'sine', box: 0.35, bass: false, shimmer: true },
  { id: 'rain', theme: 'dark', bpm: 64, root: 65, scale: [0, 2, 3, 5, 7, 8, 10], prog: [0, 3, 4, 5], pad: 'sine', pluck: 0.45, bass: true, rain: true },
];

let ctx = null, master = null, wet = null, cfg = { music: true, sfx: true, theme: 'light', volume: 1 };
let track = null, timer = null, nextBar = 0, bar = 0, last = 0, running = false, lowered = false, started = false;
const listeners = new Set();
const off = () => !!globalThis.navigator?.webdriver;          // automated checks run in silence

function build() {
  if (ctx || off()) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC({ latencyHint: 'playback' });
  master = ctx.createGain(); master.gain.value = 0;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3800;
  const delay = ctx.createDelay(1.5); delay.delayTime.value = 0.42;
  const fb = ctx.createGain(); fb.gain.value = 0.32;
  wet = ctx.createGain(); wet.gain.value = 0.28;
  master.connect(lp); lp.connect(ctx.destination);
  master.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(lp);
  return ctx;
}

const darkNow = () => cfg.theme === 'dark' || (cfg.theme !== 'light' && !!globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);

/** Picks a track for the theme at random, never the one played last time. */
function pick(exceptId = '') {
  const theme = darkNow() ? 'dark' : 'light';
  let lastId = exceptId;
  try { lastId ||= localStorage.getItem('haptune.lastTrack') || ''; } catch { /* storage blocked */ }
  const list = TRACKS.filter((x) => x.theme === theme && x.id !== lastId);
  const tr = list[Math.floor(Math.random() * list.length)] || TRACKS[0];
  try { localStorage.setItem('haptune.lastTrack', tr.id); } catch { /* fine */ }
  return tr;
}

function voice(t, midi, dur, { type = 'sine', gain = 0.1, attack = 0.02, release = 0.6, detune = 0 } = {}) {
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = NOTE(midi); o.detune.value = detune;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.setTargetAtTime(0.0001, t + Math.max(attack, dur), release / 3);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + release + 0.2);
}

let noiseBuf = null;
function rain(t, len) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.002 ? 1 : 0.25);
  }
  const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.6;
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.03, t + 1); g.gain.setTargetAtTime(0.0001, t + len, 0.5);
  src.connect(bp); bp.connect(g); g.connect(master);
  src.start(t); src.stop(t + len + 2);
}

/** One bar of the track: a soft pad chord, a bass note, and a few melody notes chosen now. */
function scheduleBar(t) {
  const tr = track;
  const beat = 60 / tr.bpm, len = beat * 4;
  const deg = tr.prog[bar % tr.prog.length];
  const sc = tr.scale, n = sc.length;
  const at = (d) => tr.root + sc[((d % n) + n) % n] + 12 * Math.floor(d / n);
  const lite = globalThis.document?.documentElement.classList.contains('lite');
  for (const k of [0, 2, 4].slice(0, lite ? 2 : 3)) voice(t, at(deg + k) - 12, len, { type: tr.pad, gain: 0.05, attack: 1.4, release: 2.2, detune: k ? 4 : -3 });
  if (tr.bass) { voice(t, at(deg) - 24, beat * 2, { type: 'sine', gain: 0.08, attack: 0.05, release: 0.8 }); voice(t + beat * 2, at(deg + 4) - 24, beat * 2, { type: 'sine', gain: 0.06, attack: 0.05, release: 0.8 }); }
  const density = tr.bell || tr.pluck || tr.box || 0.4;
  let d = deg + 7 + Math.floor(Math.random() * 3);
  for (let i = 0; i < 8; i++) {
    if (Math.random() > density * (i % 2 ? 0.6 : 1)) continue;
    d += [-2, -1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 7)];
    const m = at(d);
    const tt = t + i * beat / 2 + (Math.random() - 0.5) * 0.02;
    if (tr.bell) { voice(tt, m, 0.05, { gain: 0.05, attack: 0.005, release: 1.6 }); voice(tt, m + 12, 0.05, { gain: 0.015, attack: 0.005, release: 0.9 }); }
    else if (tr.box) voice(tt, m + 12, 0.04, { type: 'triangle', gain: 0.035, attack: 0.003, release: 0.9 });
    else voice(tt, m, 0.08, { type: 'triangle', gain: 0.045, attack: 0.004, release: 0.45 });
  }
  if (tr.shimmer && bar % 2 === 0) voice(t + beat, at(deg + 14), len, { gain: 0.012, attack: 2, release: 3, detune: 7 });
  if (tr.rain) rain(t, len);
  bar++;
}

// While real music plays (or the microphone listens, or the app is in the background) the background music's own
// sound system is SUSPENDED, not just turned down: a second sound system running silently next to the music still
// costs a phone an audio thread and its echo, which is enough to make busy music crackle (Part 9).
let quietSince = 0;
function tick() {
  if (!ctx || !track) return;
  const busy = soundBusy() || globalThis.document?.hidden || !cfg.music;
  if (busy && ctx.state === 'suspended') return;                 // asleep: nothing to do until it is wanted again
  if (!busy && ctx.state === 'suspended') { ctx.resume?.().catch(() => {}); return; }   // wake first, schedule next tick
  const now = ctx.currentTime;
  if (busy && !lowered) { lowered = true; quietSince = performance.now(); master.gain.cancelScheduledValues(now); master.gain.setTargetAtTime(0, now, 0.3); }
  if (!busy && lowered) { lowered = false; master.gain.cancelScheduledValues(now); master.gain.setTargetAtTime(0.5 * cfg.volume, now, 1.2); if (nextBar < now) nextBar = now + 0.1; }
  if (lowered) {
    if (busy && performance.now() - quietSince > 2000 && ctx.state === 'running') ctx.suspend?.().catch(() => {});   // faded out by now
    return;
  }
  while (nextBar < now + 1.5) { scheduleBar(Math.max(nextBar, now + 0.05)); nextBar = Math.max(nextBar, now) + (60 / track.bpm) * 4; }
}

function start() {
  if (started || off() || !cfg.music) return;
  if (!build()) return;
  started = true;
  ctx.resume?.().catch(() => {});
  track = pick();
  bar = 0; nextBar = ctx.currentTime + 0.3; lowered = true;
  timer = setInterval(tick, 400);
  tick();
  listeners.forEach((f) => f(track));
}

/** The track playing now (or null), and a way to hear when it changes. */
export const nowPlaying = () => (started ? track : null);
export function onTrack(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Another track for the same theme. */
export function nextTrack() {
  if (!started) { cfg.music = true; start(); return; }
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now); master.gain.setTargetAtTime(0, now, 0.2);
  setTimeout(() => { track = pick(track?.id); bar = 0; nextBar = ctx.currentTime + 0.1; lowered = true; listeners.forEach((f) => f(track)); }, 700);
}

/** Settings: { music, sfx, theme }. Music starts with the first tap (browsers allow sound only then). */
export function configureSounds(next) {
  const was = cfg;
  cfg = { ...cfg, ...next };
  if (started && was.theme !== cfg.theme && (darkNow() ? 'dark' : 'light') !== track?.theme) nextTrack();
  if (cfg.music && !started) {
    const go = () => { removeEventListener('pointerdown', go, true); removeEventListener('keydown', go, true); start(); };
    addEventListener('pointerdown', go, true); addEventListener('keydown', go, true);
  }
}

// ---------------------------------------------------------------- sound effects
export function sfx(kind) {
  if (!cfg.sfx || off() || soundBusy()) return;
  const t0 = performance.now();
  if (kind === 'tap' && t0 - last < 70) return;
  last = t0;
  if (!build()) return;
  if (ctx.state !== 'running') ctx.resume?.().catch(() => {});
  const t = ctx.currentTime + 0.01;
  const fx = (midi, dur, opts) => {                                // effects skip the background-music echo
    const o = ctx.createOscillator(); o.type = opts.type || 'sine'; o.frequency.setValueAtTime(NOTE(midi), t + (opts.at || 0));
    if (opts.to) o.frequency.exponentialRampToValueAtTime(NOTE(opts.to), t + (opts.at || 0) + dur);
    const g = ctx.createGain(); const a = t + (opts.at || 0);
    g.gain.setValueAtTime(0.0001, a); g.gain.linearRampToValueAtTime(opts.gain, a + 0.006); g.gain.setTargetAtTime(0.0001, a + 0.01, dur / 3);
    o.connect(g); g.connect(ctx.destination); o.start(a); o.stop(a + dur + 0.3);
  };
  if (kind === 'tap') fx(96, 0.03, { gain: 0.035 });
  else if (kind === 'tab') fx(84, 0.06, { gain: 0.04, to: 91, type: 'triangle' });
  else if (kind === 'open') {
    if (!noiseBuf) { noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2; bp.frequency.setValueAtTime(500, t); bp.frequency.exponentialRampToValueAtTime(2800, t + 0.16);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.05, t + 0.04); g.gain.setTargetAtTime(0.0001, t + 0.08, 0.05);
    src.connect(bp); bp.connect(g); g.connect(ctx.destination); src.start(t); src.stop(t + 0.4);
  } else if (kind === 'success') { fx(84, 0.25, { gain: 0.05 }); fx(88, 0.35, { gain: 0.05, at: 0.09 }); fx(91, 0.5, { gain: 0.04, at: 0.18 }); }
  else if (kind === 'error') { fx(64, 0.18, { gain: 0.06, type: 'triangle' }); fx(60, 0.28, { gain: 0.06, type: 'triangle', at: 0.12 }); }
  else if (kind === 'toggle') fx(88, 0.05, { gain: 0.04, type: 'triangle' });
}
globalThis.__haptuneSfx = sfx;
// read-only state for checks
globalThis.__haptuneAmbience = () => ({ track: started ? track?.id : null, state: ctx?.state || 'none', gain: master ? +master.gain.value.toFixed(3) : 0, bars: bar, quiet: lowered });
