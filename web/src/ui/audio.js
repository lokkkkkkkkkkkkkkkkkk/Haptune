// Web Audio engine: a recorded grand piano (Salamander Grand Piano, CC BY 3.0, Alexander Holm) with light
// synthesised voices for the other instruments, a look-ahead scheduler on the audio clock, metronome, drone,
// and YIN pitch tracking for the tuner and practising with the microphone.
//
// Why it is built this way (dense scores used to stutter and get "stuck"):
//  * every voice is 2-4 audio nodes (it was ~11), and at most MAX_VOICES sound at once, so busy piano music
//    never overloads a phone;
//  * notes are scheduled a second ahead, so a busy screen can't make them late or drop them;
//  * each play gets its own output bus: stopping or jumping to another bar fades that bus out and starts a
//    new one straight away (no timers, no shared volume to restore), so a quick jump can never leave
//    playback silent or stopped;
//  * the cursor uses the audible time (the audio clock minus the speaker/Bluetooth delay), so the score
//    shows the note you hear, not the one being prepared.

let ctx = null, out = null, verb = null, mainBus = null, vib = null;
const waves = {};
const MASTER = 0.8;
const LOOKAHEAD = 1.0;          // seconds scheduled ahead of the audio clock (a jump or stop fades the bus, so this costs nothing)
const TICK_MS = 40;
const MAX_VOICES = 64;
const stats = { scheduled: 0, dropped: 0, stolen: 0, transports: 0 };
let userOffset = 0;              // seconds, from Settings > Sound > Sync (calibration)

const CFG = () => globalThis.HAPTUNE_CONFIG || {};

export function audioContext() {
  if (!ctx) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* plays through the silent switch on iOS 17+ */ }
    ctx = new AC({ latencyHint: 'interactive' });
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.2;
    out = ctx.createGain(); out.gain.value = MASTER;
    out.connect(comp); comp.connect(ctx.destination);
    // iOS pauses audio after a call, Siri or another app ("interrupted"); wake it on the next tap
    ctx.onstatechange = () => { if (ctx.state === 'interrupted') ctx.resume().catch(() => {}); };
    // one shared room reverb, fed by each bus (not by each note)
    verb = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 1.3);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.4) * 0.5;
    }
    verb.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = 0.5;
    verb.connect(wet); wet.connect(comp);
    // one shared vibrato for all sustained voices (in cents, so it suits every pitch)
    vib = ctx.createOscillator(); vib.frequency.value = 5.3;
    const vibDepth = ctx.createGain(); vibDepth.gain.value = 9;
    vib.connect(vibDepth); vib.start();
    vib.depth = vibDepth;
    const pw = (h) => { const real = new Float32Array(h.length + 1), imag = new Float32Array(h.length + 1); h.forEach((a, i) => { imag[i + 1] = a; }); return ctx.createPeriodicWave(real, imag); };
    waves.piano = pw([1, 0.55, 0.32, 0.22, 0.12, 0.09, 0.06, 0.04, 0.03, 0.02]);
    waves.epiano = pw([1, 0.18, 0.08, 0.03, 0.02]);
    waves.organ = pw([1, 0.7, 0.4, 0.5, 0.1, 0.3, 0, 0.2]);
    waves.flute = pw([1, 0.22, 0.06, 0.02]);
    waves.clar = pw([1, 0, 0.5, 0, 0.3, 0, 0.18, 0, 0.1]);
    waves.brass = pw([1, 0.8, 0.6, 0.45, 0.32, 0.22, 0.15, 0.1]);
    mainBus = makeBus(0.22);
    installUnlock();
    loadPiano();
  }
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  return ctx;
}

/** Browsers only let sound start inside a tap. Resume on every tap, so playback started a moment later
 *  (after a bar jump, a count-in or a timer) is never stuck silent. */
function installUnlock() {
  const wake = () => { if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); };
  for (const ev of ['pointerdown', 'touchend', 'keydown']) globalThis.addEventListener?.(ev, wake, { capture: true, passive: true });
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (!document.hidden) wake(); });
}

export const now = () => (ctx ? ctx.currentTime : 0);
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Seconds between the audio clock and the sound leaving the speaker (Bluetooth adds a lot). */
export function outputDelay() {
  if (!ctx) return 0;
  return Math.max(0, (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + userOffset);
}
/** Extra delay from the "sync" calibration in Settings (milliseconds; may be negative). */
export function setSyncOffset(ms) { userOffset = Math.max(-0.3, Math.min(0.6, (Number(ms) || 0) / 1000)); }

function makeBus(wet = 0.22) {
  const g = ctx.createGain(); g.gain.value = 1;
  g.connect(out);
  const s = ctx.createGain(); s.gain.value = wet;
  g.connect(s); s.connect(verb);
  g.sources = [];
  g.send = s;
  return g;
}
function releaseBus(bus) {
  if (!bus || !ctx) return;
  const t = ctx.currentTime;
  try {
    bus.gain.cancelScheduledValues(t);
    bus.gain.setValueAtTime(bus.gain.value, t);
    bus.gain.linearRampToValueAtTime(0.0001, t + 0.03);
  } catch { /* already released */ }
  for (const s of bus.sources) { try { s.stop(t + 0.05); } catch { /* not started or already stopped */ } }
  bus.sources = [];
  setTimeout(() => { try { bus.disconnect(); bus.send.disconnect(); } catch { /* gone */ } }, 250);
}

// ---------- voices ----------

const live = [];   // {start, end, gain, srcs}
function track(v) {
  const t = ctx.currentTime;
  for (let i = live.length - 1; i >= 0; i--) if (live[i].end < t) live.splice(i, 1);
  live.push(v);
  if (live.length > MAX_VOICES) {
    // steal the voice that started first (it is the quietest by now)
    let k = 0;
    for (let i = 1; i < live.length; i++) if (live[i].start < live[k].start) k = i;
    const old = live.splice(k, 1)[0];
    const at = Math.max(t, old.start);
    try { old.gain.gain.cancelScheduledValues(at); old.gain.gain.setTargetAtTime(0.0001, at, 0.02); } catch { /* ok */ }
    old.srcs.forEach((s) => { try { s.stop(at + 0.12); } catch { /* ok */ } });
    stats.stolen++;
  }
}

// Recorded piano: one sample every 3 semitones, pitched at most 1.5 semitones (so it stays natural).
const PIANO_KEYS = [21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 87, 90, 93, 96, 99, 102, 105, 108];
let piano = null, pianoLoading = null;
export function loadPiano() {
  if (piano || pianoLoading || !ctx || typeof fetch !== 'function') return pianoLoading || Promise.resolve(!!piano);
  const base = CFG().piano;
  if (!base) return Promise.resolve(false);              // single-file preview: synthesised piano
  pianoLoading = Promise.all(PIANO_KEYS.map(async (m) => {
    const res = await fetch(`${base}${m}.mp3`);
    if (!res.ok) throw new Error('sample missing');
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    // skip the encoder's silent lead-in so notes start exactly on time
    const d = buf.getChannelData(0);
    let i = 0;
    while (i < d.length && Math.abs(d[i]) < 0.004) i++;
    return [m, { buf, off: Math.max(0, i / buf.sampleRate - 0.002) }];
  })).then((list) => { piano = new Map(list); return true; }).catch(() => { pianoLoading = null; return false; });
  return pianoLoading;
}
export const pianoReady = () => !!piano;

function connect(node, dest, pan) {
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    node.connect(p); p.connect(dest);
  } else node.connect(dest);
}

/** Plays one note at audio time t on `dest` (a bus; the shared one by default). Returns the voice. */
export function note(t, midi, dur, vel = 80, inst = 'piano', pan = 0, dest = null) {
  if (!audioContext()) return null;
  dest = dest || mainBus;
  const v = Math.max(0.03, Math.min(1, vel / 127));
  const f = hz(midi);
  const end = t + Math.max(0.05, dur);
  const g = ctx.createGain();
  const srcs = [];
  let stopAt = end + 0.5;
  // shared vibrato into the oscillator's detune; unhooked when the note ends so stopped notes are freed
  const sustain = (o) => {
    if (!vib) return;
    vib.depth.connect(o.detune);
    o.onended = () => { try { vib.depth.disconnect(o.detune); } catch { /* already gone */ } };
  };
  switch (inst) {
    case 'strings': case 'violin': case 'viola': case 'cello': case 'erhu': {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; sustain(o);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(7000, f * 4.5 + 700); lp.Q.value = 0.6;
      o.connect(lp); lp.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.2 * v, t + 0.08); g.gain.setTargetAtTime(0.15 * v, t + 0.08, 0.25);
      g.gain.setTargetAtTime(0.0001, end, 0.08);
      srcs.push(o);
      break;
    }
    case 'voice': {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; sustain(o);
      const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 760; f1.Q.value = 4;
      o.connect(f1); f1.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.75 * v, t + 0.09); g.gain.setTargetAtTime(0.6 * v, t + 0.1, 0.3);
      g.gain.setTargetAtTime(0.0001, end, 0.08);
      srcs.push(o);
      break;
    }
    case 'flute': case 'recorder': case 'dizi': case 'clarinet': case 'sax': case 'trumpet': case 'brass': {
      const o = ctx.createOscillator();
      o.setPeriodicWave(inst === 'clarinet' || inst === 'sax' ? waves.clar : inst === 'trumpet' || inst === 'brass' ? waves.brass : waves.flute);
      o.frequency.value = f; sustain(o);
      o.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.28 * v, t + 0.05); g.gain.setTargetAtTime(0.22 * v, t + 0.05, 0.2);
      g.gain.setTargetAtTime(0.0001, end, 0.05);
      srcs.push(o);
      break;
    }
    case 'bass': case 'bassguitar': case 'doublebass': {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(1200, t); lp.frequency.setTargetAtTime(450, t, 0.08);
      o.connect(lp); lp.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.55 * v, t + 0.008); g.gain.setTargetAtTime(0.25 * v, t + 0.01, 0.35);
      g.gain.setTargetAtTime(0.0001, end, 0.04);
      stopAt = end + 0.3;
      srcs.push(o);
      break;
    }
    case 'guitar': case 'ukulele': {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.4;
      lp.frequency.setValueAtTime(Math.min(7000, f * 8), t); lp.frequency.setTargetAtTime(f * 1.6, t, 0.12);
      o.connect(lp); lp.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.3 * v, t + 0.004); g.gain.setTargetAtTime(0.0001, t + 0.01, 0.6 + 60 / f);
      g.gain.setTargetAtTime(0.0001, end, 0.08);
      stopAt = Math.min(end, t + 3) + 0.6;
      srcs.push(o);
      break;
    }
    case 'organ': case 'epiano': {
      const o = ctx.createOscillator(); o.setPeriodicWave(inst === 'organ' ? waves.organ : waves.epiano); o.frequency.value = f;
      o.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.24 * v, t + 0.006); g.gain.setTargetAtTime(0.1 * v, t + 0.01, inst === 'organ' ? 10 : 0.9);
      g.gain.setTargetAtTime(0.0001, end, 0.1);
      srcs.push(o);
      break;
    }
    default: { // piano, keys, harp, guzheng: the recorded grand piano when it has loaded
      if (piano) {
        let best = PIANO_KEYS[0];
        for (const k of PIANO_KEYS) if (Math.abs(k - midi) < Math.abs(best - midi)) best = k;
        const s = piano.get(best);
        const src = ctx.createBufferSource(); src.buffer = s.buf; src.playbackRate.value = Math.pow(2, (midi - best) / 12);
        src.connect(g);
        const amp = 0.95 * Math.pow(v, 1.35);
        const length = s.buf.duration - s.off;
        g.gain.setValueAtTime(amp, t);
        g.gain.setValueAtTime(amp, end);
        g.gain.setTargetAtTime(0.0001, end, 0.1);              // damper
        src.start(t, s.off);
        stopAt = Math.min(end + 0.6, t + length);
        src.stop(stopAt);
        connect(g, dest, pan);
        if (dest.sources) dest.sources.push(src);
        const voice = { start: t, end: stopAt, gain: g, srcs: [src] };
        track(voice);
        return voice;
      }
      const o = ctx.createOscillator(); o.setPeriodicWave(waves.piano); o.frequency.value = f;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(Math.min(11000, 2400 + f * 4 * v), t); lp.frequency.setTargetAtTime(Math.min(5000, 800 + f * 2), t, 0.25);
      o.connect(lp); lp.connect(g);
      const decay = Math.max(0.6, 3.2 - (midi - 40) * 0.035);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.4 * v, t + 0.004);
      g.gain.setTargetAtTime(0.12 * v, t + 0.005, 0.12); g.gain.setTargetAtTime(0.0001, t + 0.3, decay);
      g.gain.setTargetAtTime(0.0001, end, 0.09);
      stopAt = end + 0.7;
      srcs.push(o);
    }
  }
  srcs.forEach((x) => { x.start(t); x.stop(stopAt); });
  connect(g, dest, pan);
  if (dest.sources) dest.sources.push(...srcs);
  const voice = { start: t, end: stopAt, gain: g, srcs };
  track(voice);
  return voice;
}

let noiseBuf = null;
function noise() {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

export function drum(t, kind, vel = 80, dest = null) {
  if (!audioContext()) return;
  dest = dest || mainBus;
  const v = vel / 127;
  const g = ctx.createGain();
  g.connect(dest);
  const srcs = [];
  if (kind === 'kick') {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(0.9 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g); o.start(t); o.stop(t + 0.4); srcs.push(o);
  } else if (kind === 'snare' || kind === 'rim') {
    const n = ctx.createBufferSource(); n.buffer = noise();
    const f = ctx.createBiquadFilter(); f.type = kind === 'rim' ? 'bandpass' : 'highpass'; f.frequency.value = kind === 'rim' ? 1700 : 1400;
    n.connect(f); f.connect(g);
    g.gain.setValueAtTime((kind === 'rim' ? 0.25 : 0.45) * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'rim' ? 0.06 : 0.2));
    n.start(t); n.stop(t + 0.25); srcs.push(n);
  } else {
    const n = ctx.createBufferSource(); n.buffer = noise();
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = kind === 'ride' ? 5200 : 7500;
    n.connect(f); f.connect(g);
    const len = kind === 'ride' ? 0.45 : kind === 'pedal' ? 0.04 : 0.06;
    g.gain.setValueAtTime((kind === 'ride' ? 0.16 : 0.2) * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    n.start(t); n.stop(t + len + 0.02); srcs.push(n);
  }
  if (dest.sources) dest.sources.push(...srcs);
}

export function click(t, accent = false, dest = null) {
  if (!audioContext()) return;
  dest = dest || out;
  const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = accent ? 1760 : 1180;
  const g = ctx.createGain();
  g.gain.setValueAtTime(accent ? 0.5 : 0.32, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.06);
  if (dest.sources) dest.sources.push(o);
}

/** Plays a list of MIDI notes now (chords or melodies). items: midi[] (together) or [[midi...], ...] steps. */
export function playNow(items, { gap = 0.7, dur = 0.9, inst = 'piano', arpeggio = 0 } = {}) {
  if (!audioContext()) return;
  const t0 = ctx.currentTime + 0.05;
  const steps = Array.isArray(items[0]) ? items : [items];
  steps.forEach((step, i) => step.forEach((m, j) => note(t0 + i * gap + j * arpeggio, m, dur, 84, inst)));
}

// ---------- scheduler ----------

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * A transport that plays timed events: [{time (s), dur (s), midi, vel, inst, drum, click, accent, pan}].
 * Calls onTime(seconds) on every animation frame while playing, with the time you can hear.
 *   play(from, {preroll}) starts at `from` seconds; `preroll` events (count-in clicks, times before `from`)
 *   play first. Calling play() again while playing jumps straight there.
 */
export class Transport {
  constructor() {
    this.events = []; this.times = new Float64Array(0); this.length = 0; this.playing = false; this.loop = null;
    this.timer = null; this.raf = null; this.onTime = null; this.onEnd = null; this.onLoop = null;
    this.bus = null; this.pos = 0; this.gen = 0; this.segs = [];
    stats.transports++;
  }
  load(events, length) {
    this.events = [...events].sort((a, b) => a.time - b.time);
    this.times = Float64Array.from(this.events, (e) => e.time);
    this.length = length;
  }
  setLoop(loop) { this.loop = loop && loop.end - loop.start > 0.05 ? loop : null; }
  /** Song time (seconds) that is audible right now. */
  position() {
    if (!this.playing || !this.segs.length) return this.pos || 0;
    const heard = ctx.currentTime - outputDelay();
    let seg = this.segs[0];
    for (const s of this.segs) if (s.at <= heard) seg = s;
    return seg.off + (heard - seg.at);
  }
  play(from = 0, { preroll = [] } = {}) {
    if (!audioContext()) return;
    this.stop(false);
    this.playing = true;
    const gen = ++this.gen;
    const begin = () => {
      if (gen !== this.gen || !this.playing) return;
      this.bus = makeBus(0.22);
      const start = preroll.length ? Math.min(from, ...preroll.map((e) => e.time)) : from;   // count-in starts earlier
      const t0 = ctx.currentTime + 0.05;
      this.segs = [{ at: t0, off: start }];
      this.schedAt = t0; this.schedOff = start;
      this.pre = preroll.filter((e) => e.time < from).sort((a, b) => a.time - b.time);
      this.idx = lowerBound(this.times, from - 1e-6);
      this.ended = false;
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.tick();
      const frame = () => {
        if (!this.playing || gen !== this.gen) return;
        this.onTime?.(Math.max(0, this.position()));
        this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
    };
    if (ctx.state === 'running') begin();
    else ctx.resume().then(begin, begin);
  }
  tick() {
    if (!this.playing || !ctx) return;
    const nowT = ctx.currentTime;
    const horizon = nowT + LOOKAHEAD;
    const fireAt = (e) => {
      const at = this.schedAt + (e.time - this.schedOff);
      if (at > horizon) return false;
      if (at < nowT - 0.05) stats.dropped++;          // too late to sound right: skip instead of a burst
      else { this.fire(e, Math.max(at, nowT)); stats.scheduled++; }
      return true;
    };
    while (this.pre.length && fireAt(this.pre[0])) this.pre.shift();
    for (let guard = 0; guard < 4; guard++) {
      const loopEnd = this.loop ? this.loop.end : Infinity;
      while (this.idx < this.events.length) {
        const e = this.events[this.idx];
        if (e.time >= loopEnd - 1e-9) break;
        if (!fireAt(e)) break;
        this.idx++;
      }
      const exhausted = this.idx >= this.events.length || (this.loop && this.events[this.idx].time >= this.loop.end - 1e-9);
      if (!exhausted) break;
      const end = this.loop ? this.loop.end : this.length;
      const endAt = this.schedAt + (end - this.schedOff);
      if (this.loop) {
        if (endAt > horizon) break;
        // the next pass starts exactly at the loop end time
        this.schedAt = endAt; this.schedOff = this.loop.start;
        this.segs.push({ at: endAt, off: this.loop.start });
        if (this.segs.length > 4) this.segs.shift();
        this.idx = lowerBound(this.times, this.loop.start - 1e-6);
        this.onLoop?.();
        continue;
      }
      if (nowT >= endAt + outputDelay() && !this.ended) {
        this.ended = true;
        this.stop();
        this.onEnd?.();
      }
      break;
    }
  }
  fire(e, at) {
    if (e.click) click(at, e.accent, this.bus);
    else if (e.drum) drum(at, e.drum, e.vel, this.bus);
    else if (e.midi !== undefined) note(at, e.midi, e.dur, e.vel, e.inst, e.pan || 0, this.bus);
    e.onFire?.(at);
  }
  stop(resetPos = true) {
    if (this.playing) this.pos = this.position();
    this.playing = false;
    this.gen++;
    clearInterval(this.timer); this.timer = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.bus) { releaseBus(this.bus); this.bus = null; }
    this.segs = [];
    if (resetPos) this.pos = 0;
  }
}

// ---------- drone ----------
let droneNodes = null;
export function startDrone(midi) {
  if (!audioContext()) return;
  stopDrone();
  const g = ctx.createGain(); g.gain.value = 0.0001; g.gain.setTargetAtTime(0.12, ctx.currentTime, 0.3);
  const oscs = [midi - 12, midi, midi + 7].map((m, i) => {
    const o = ctx.createOscillator(); o.type = i === 1 ? 'sawtooth' : 'sine'; o.frequency.value = hz(m);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200;
    o.connect(lp); lp.connect(g); o.start(); return o;
  });
  g.connect(out);
  droneNodes = { g, oscs };
}
export function stopDrone() {
  if (!droneNodes) return;
  const { g, oscs } = droneNodes;
  g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.1);
  oscs.forEach((o) => o.stop(ctx.currentTime + 0.5));
  droneNodes = null;
}

// ---------- pitch tracking ----------

/** YIN fundamental frequency estimate. Returns {freq, clarity} or null. */
export function yin(buf, sr, { fmin = 60, fmax = 1600, threshold = 0.15 } = {}) {
  const n = buf.length;
  const tauMin = Math.floor(sr / fmax), tauMax = Math.min(Math.floor(sr / fmin), Math.floor(n / 2));
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.008) return null;
  const d = new Float32Array(tauMax + 1);
  const W = n - tauMax;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const x = buf[i] - buf[i + tau]; s += x * x; }
    d[tau] = s;
  }
  let running = 0;
  const cmnd = new Float32Array(tauMax + 1).fill(1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = running ? d[tau] * (tau - tauMin + 1) / running : 1;
  }
  let tau = -1;
  for (let t = tauMin + 1; t < tauMax; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 < tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t; break;
    }
  }
  if (tau < 0) return null;
  const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1] ?? b;
  const denom = a - 2 * b + c;
  const shift = denom ? (a - c) / (2 * denom) : 0;
  return { freq: sr / (tau + shift), clarity: 1 - b, rms };
}

/** Opens the microphone and calls onPitch({midi, freq, cents, clarity, rms, time}) about 40 times a second. */
export async function listen(onPitch) {
  audioContext();
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('nomic'), { code: 'unavailable' });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    throw Object.assign(new Error('denied'), { code: e?.name === 'NotAllowedError' ? 'denied' : 'unavailable' });
  }
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser(); an.fftSize = 2048;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  let running = true;
  const loop = () => {
    if (!running) return;
    an.getFloatTimeDomainData(buf);
    const r = yin(buf, ctx.sampleRate);
    if (r && r.clarity > 0.8) {
      const midi = 69 + 12 * Math.log2(r.freq / 440);
      onPitch({ midi, freq: r.freq, cents: Math.round((midi - Math.round(midi)) * 100), clarity: r.clarity, rms: r.rms, time: ctx.currentTime });
    } else onPitch(null);
    setTimeout(loop, 22);
  };
  loop();
  return () => { running = false; stream.getTracks().forEach((t) => t.stop()); src.disconnect(); };
}

// read-only state for automated checks (smoke tests) and the in-app problem report
globalThis.__haptuneAudio = () => ({
  state: ctx?.state || 'none', gain: out ? out.gain.value : null, piano: !!piano, voices: live.length,
  latencyMs: Math.round(outputDelay() * 1000), ...stats,
});
