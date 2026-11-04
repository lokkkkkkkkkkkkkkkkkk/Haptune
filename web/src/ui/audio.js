// Web Audio engine: synthesised instruments (no downloads), a look-ahead scheduler for exact timing,
// metronome, drone, and YIN pitch tracking for the tuner and practising with the microphone.

let ctx = null, out = null, verb = null, noiseBuf = null;
const waves = {};

export function audioContext() {
  if (!ctx) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* plays through the silent switch on iOS 17+ */ }
    ctx = new AC({ latencyHint: 'interactive' });
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
    out = ctx.createGain(); out.gain.value = 0.75;
    out.connect(comp); comp.connect(ctx.destination);
    // small room reverb
    verb = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 1.4);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2) * 0.5;
    }
    verb.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = 0.16;
    verb.connect(wet); wet.connect(comp);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const pw = (h) => { const real = new Float32Array(h.length + 1), imag = new Float32Array(h.length + 1); h.forEach((a, i) => { imag[i + 1] = a; }); return ctx.createPeriodicWave(real, imag); };
    waves.piano = pw([1, 0.55, 0.32, 0.22, 0.12, 0.09, 0.06, 0.04, 0.03, 0.02]);
    waves.epiano = pw([1, 0.18, 0.08, 0.03, 0.02]);
    waves.organ = pw([1, 0.7, 0.4, 0.5, 0.1, 0.3, 0, 0.2]);
    waves.flute = pw([1, 0.22, 0.06, 0.02]);
    waves.clar = pw([1, 0, 0.5, 0, 0.3, 0, 0.18, 0, 0.1]);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export const now = () => (ctx ? ctx.currentTime : 0);
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function send(node, dry = 1, wet = 0.3) {
  const g = ctx.createGain(); g.gain.value = dry; node.connect(g); g.connect(out);
  if (wet) { const w = ctx.createGain(); w.gain.value = wet; node.connect(w); w.connect(verb); }
}

/** Plays one note at audio time t. inst: piano | keys | strings | violin | voice | flute | bass | guitar | organ | clarinet */
export function note(t, midi, dur, vel = 80, inst = 'piano', pan = 0) {
  if (!audioContext()) return;
  const v = Math.max(0.02, Math.min(1, vel / 127));
  const f = hz(midi);
  const end = t + Math.max(0.05, dur);
  const g = ctx.createGain();
  let stopAt = end + 0.6;
  const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (panner) { panner.pan.value = pan; g.connect(panner); }
  const target = panner || g;
  switch (inst) {
    case 'strings': case 'violin': case 'viola': case 'cello': case 'erhu': {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = f; o2.detune.value = 6;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(9000, f * 6 + 900); lp.Q.value = 0.8;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.4;
      const depth = ctx.createGain(); depth.gain.setValueAtTime(0, t); depth.gain.linearRampToValueAtTime(f * 0.006, t + 0.35);
      lfo.connect(depth); depth.connect(o.frequency); depth.connect(o2.frequency);
      o.connect(lp); o2.connect(lp); lp.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.2 * v, t + 0.07); g.gain.setTargetAtTime(0.16 * v, t + 0.07, 0.2);
      g.gain.setTargetAtTime(0.0001, end, 0.08);
      [o, o2, lfo].forEach((x) => { x.start(t); x.stop(stopAt); });
      send(target, 1, 0.35);
      break;
    }
    case 'voice': {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 760; f1.Q.value = 5;
      const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1180; f2.Q.value = 6;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.2;
      const depth = ctx.createGain(); depth.gain.setValueAtTime(0, t); depth.gain.linearRampToValueAtTime(f * 0.008, t + 0.4);
      lfo.connect(depth); depth.connect(o.frequency);
      o.connect(f1); o.connect(f2); f1.connect(g); f2.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.9 * v, t + 0.09); g.gain.setTargetAtTime(0.75 * v, t + 0.1, 0.3);
      g.gain.setTargetAtTime(0.0001, end, 0.08);
      [o, lfo].forEach((x) => { x.start(t); x.stop(stopAt); });
      send(target, 1, 0.4);
      break;
    }
    case 'flute': case 'recorder': case 'dizi': case 'clarinet': case 'sax': case 'trumpet': {
      const o = ctx.createOscillator(); o.setPeriodicWave(inst === 'clarinet' || inst === 'sax' ? waves.clar : waves.flute); o.frequency.value = f;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5;
      const depth = ctx.createGain(); depth.gain.setValueAtTime(0, t); depth.gain.linearRampToValueAtTime(f * 0.004, t + 0.3);
      lfo.connect(depth); depth.connect(o.frequency);
      const n = ctx.createBufferSource(); n.buffer = noiseBuf;
      const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = f * 2; nf.Q.value = 2;
      const ng = ctx.createGain(); ng.gain.setValueAtTime(0.05 * v, t); ng.gain.setTargetAtTime(0.012 * v, t + 0.05, 0.05);
      n.connect(nf); nf.connect(ng); ng.connect(g);
      o.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.32 * v, t + 0.05); g.gain.setTargetAtTime(0.26 * v, t + 0.05, 0.2);
      g.gain.setTargetAtTime(0.0001, end, 0.05);
      [o, lfo, n].forEach((x) => { x.start(t); x.stop(stopAt); });
      send(target, 1, 0.3);
      break;
    }
    case 'bass': case 'bassguitar': case 'doublebass': {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const s = ctx.createOscillator(); s.type = 'sine'; s.frequency.value = f;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(1400, t); lp.frequency.setTargetAtTime(500, t, 0.08);
      o.connect(lp); s.connect(lp); lp.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.5 * v, t + 0.008); g.gain.setTargetAtTime(0.22 * v, t + 0.01, 0.35);
      g.gain.setTargetAtTime(0.0001, end, 0.04);
      stopAt = end + 0.3;
      [o, s].forEach((x) => { x.start(t); x.stop(stopAt); });
      send(target, 1, 0.08);
      break;
    }
    case 'guitar': case 'ukulele': {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.5;
      lp.frequency.setValueAtTime(Math.min(8000, f * 9), t); lp.frequency.setTargetAtTime(f * 1.6, t, 0.12);
      o.connect(lp); lp.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.32 * v, t + 0.004); g.gain.setTargetAtTime(0.0001, t + 0.01, 0.6 + 60 / f);
      g.gain.setTargetAtTime(0.0001, end, 0.08);
      o.start(t); o.stop(stopAt + 1);
      send(target, 1, 0.25);
      break;
    }
    case 'organ': case 'keys': case 'epiano': {
      const o = ctx.createOscillator(); o.setPeriodicWave(inst === 'organ' ? waves.organ : waves.epiano); o.frequency.value = f;
      const trem = ctx.createOscillator(); trem.frequency.value = 4.5;
      const td = ctx.createGain(); td.gain.value = inst === 'organ' ? 0 : 0.06 * v;
      trem.connect(td); td.connect(g.gain);
      o.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.26 * v, t + 0.006); g.gain.setTargetAtTime(0.1 * v, t + 0.01, inst === 'organ' ? 10 : 0.9);
      g.gain.setTargetAtTime(0.0001, end, 0.1);
      [o, trem].forEach((x) => { x.start(t); x.stop(stopAt); });
      send(target, 1, 0.3);
      break;
    }
    default: { // piano
      const o = ctx.createOscillator(); o.setPeriodicWave(waves.piano); o.frequency.value = f;
      const o2 = ctx.createOscillator(); o2.setPeriodicWave(waves.piano); o2.frequency.value = f; o2.detune.value = 3;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(Math.min(12000, 2500 + f * 4 * v), t); lp.frequency.setTargetAtTime(Math.min(6000, 800 + f * 2), t, 0.25);
      o.connect(lp); o2.connect(lp); lp.connect(g);
      const decay = Math.max(0.6, 3.2 - (midi - 40) * 0.035);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.42 * v, t + 0.004);
      g.gain.setTargetAtTime(0.12 * v, t + 0.005, 0.12); g.gain.setTargetAtTime(0.0001, t + 0.3, decay);
      g.gain.setTargetAtTime(0.0001, end, 0.09);
      // hammer
      const h = ctx.createBufferSource(); h.buffer = noiseBuf;
      const hf = ctx.createBiquadFilter(); hf.type = 'bandpass'; hf.frequency.value = Math.min(6000, f * 3); hf.Q.value = 1;
      const hg = ctx.createGain(); hg.gain.setValueAtTime(0.06 * v, t); hg.gain.setTargetAtTime(0.0001, t, 0.012);
      h.connect(hf); hf.connect(hg); hg.connect(g);
      stopAt = end + 0.8;
      [o, o2].forEach((x) => { x.start(t); x.stop(stopAt); });
      h.start(t); h.stop(t + 0.1);
      send(target, 1, 0.28);
    }
  }
}

export function drum(t, kind, vel = 80) {
  if (!audioContext()) return;
  const v = vel / 127;
  const g = ctx.createGain();
  send(g, 1, kind === 'snare' ? 0.15 : 0.05);
  if (kind === 'kick') {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(0.9 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g); o.start(t); o.stop(t + 0.4);
  } else if (kind === 'snare' || kind === 'rim') {
    const n = ctx.createBufferSource(); n.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = kind === 'rim' ? 'bandpass' : 'highpass'; f.frequency.value = kind === 'rim' ? 1700 : 1400;
    n.connect(f); f.connect(g);
    const o = ctx.createOscillator(); o.type = kind === 'rim' ? 'square' : 'triangle'; o.frequency.value = kind === 'rim' ? 820 : 190;
    const og = ctx.createGain(); og.gain.setValueAtTime(0.3 * v, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o.connect(og); og.connect(g);
    g.gain.setValueAtTime((kind === 'rim' ? 0.25 : 0.45) * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'rim' ? 0.06 : 0.2));
    n.start(t); n.stop(t + 0.25); o.start(t); o.stop(t + 0.1);
  } else {
    // hat, ride, pedal
    const n = ctx.createBufferSource(); n.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = kind === 'ride' ? 5200 : 7500;
    n.connect(f); f.connect(g);
    const len = kind === 'ride' ? 0.45 : kind === 'pedal' ? 0.04 : 0.06;
    g.gain.setValueAtTime((kind === 'ride' ? 0.16 : 0.2) * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    n.start(t); n.stop(t + len + 0.02);
  }
}

export function click(t, accent = false) {
  if (!audioContext()) return;
  const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = accent ? 1760 : 1180;
  const g = ctx.createGain();
  g.gain.setValueAtTime(accent ? 0.5 : 0.32, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.06);
}

/** Plays a list of MIDI notes now (chords or melodies). items: midi[] (together) or [[midi...], ...] steps. */
export function playNow(items, { gap = 0.7, dur = 0.9, inst = 'piano', arpeggio = 0 } = {}) {
  if (!audioContext()) return;
  const t0 = ctx.currentTime + 0.05;
  const steps = Array.isArray(items[0]) ? items : [items];
  steps.forEach((step, i) => step.forEach((m, j) => note(t0 + i * gap + j * arpeggio, m, dur, 84, inst)));
}

// ---------- scheduler ----------

/**
 * A transport that plays timed events: [{time (s), dur (s), midi, vel, inst, drum, click, accent}].
 * Calls onTime(seconds) on every animation frame while playing.
 */
export class Transport {
  constructor() { this.events = []; this.length = 0; this.playing = false; this.loop = null; this.timer = null; this.raf = null; this.onTime = null; this.onEnd = null; }
  load(events, length) { this.events = [...events].sort((a, b) => a.time - b.time); this.length = length; }
  setLoop(loop) { this.loop = loop; }
  position() {
    if (!this.playing) return this.pos || 0;
    return this.offset + (ctx.currentTime - this.startedAt);
  }
  play(from = 0) {
    if (!audioContext()) return;
    this.stop(false);
    this.playing = true;
    this.offset = from;
    this.startedAt = ctx.currentTime + 0.08;
    this.cursor = from;
    this.idx = this.events.findIndex((e) => e.time >= from - 1e-6);
    if (this.idx < 0) this.idx = this.events.length;
    const tick = () => {
      if (!this.playing) return;
      const ahead = ctx.currentTime + 0.15;
      const songNow = this.offset + (ctx.currentTime - this.startedAt);
      void songNow;
      while (this.idx < this.events.length) {
        const e = this.events[this.idx];
        const at = this.startedAt + (e.time - this.offset);
        if (at > ahead) break;
        if (this.loop && e.time >= this.loop.end) break;
        if (at >= ctx.currentTime - 0.02) this.fire(e, Math.max(at, ctx.currentTime));
        this.idx++;
      }
      const end = this.loop ? this.loop.end : this.length;
      const endAt = this.startedAt + (end - this.offset);
      if (ctx.currentTime + 0.15 >= endAt && (this.idx >= this.events.length || (this.loop && this.events[this.idx].time >= this.loop.end))) {
        if (this.loop) {
          // jump back seamlessly: next pass starts exactly at the loop end time
          this.startedAt = endAt;
          this.offset = this.loop.start;
          this.idx = this.events.findIndex((e) => e.time >= this.loop.start - 1e-6);
          if (this.idx < 0) this.idx = this.events.length;
          this.onLoop?.();
        } else if (ctx.currentTime >= endAt) {
          this.stop();
          this.onEnd?.();
          return;
        }
      }
    };
    this.timer = setInterval(tick, 25);
    tick();
    const frame = () => {
      if (!this.playing) return;
      const p = this.position();
      if (p >= this.offset || this.loop) this.onTime?.(Math.max(0, p));
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }
  fire(e, at) {
    if (e.click) click(at, e.accent);
    else if (e.drum) drum(at, e.drum, e.vel);
    else if (e.midi !== undefined) note(at, e.midi, e.dur, e.vel, e.inst, e.pan || 0);
    e.onFire?.(at);
  }
  stop(resetPos = true) {
    if (this.playing) this.pos = this.position();
    this.playing = false;
    clearInterval(this.timer); this.timer = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (resetPos) this.pos = 0;
    // silence quickly
    if (ctx && out) {
      const g = out.gain.value;
      out.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.02);
      setTimeout(() => { if (out) out.gain.setTargetAtTime(g || 0.75, ctx.currentTime, 0.01); }, 120);
    }
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
