// Play Along accuracy with background noise: a test corpus and the numbers.
//   node tools/noise-corpus.mjs            (prints the table; exits 1 if the targets are missed)
//   node tools/noise-corpus.mjs --json     (the numbers as JSON, for CI)
//
// Corpus: monophonic takes (violin, flute, voice, piano-like tones; six tunes each, about 30 notes) synthesised
// here with vibrato, attacks and breath/bow noise, then mixed with three kinds of room noise at 20, 10 and 5 dB
// SNR: a café (several talkers and clinking), TV speech, and traffic (rumble, engines, passing cars). Every take
// starts with one second of the room alone, which the app also listens to before each take (calibration).
// Each take is fed frame by frame (2048 samples every 20 ms, as the app does) to the new detector
// (src/core/detect.js) and, for comparison, to the old one (fixed gate, no room model).
//
// A note counts as correct when the detector reports its pitch for 3 frames in a row inside the note, and does not
// report a wrong pitch for 6 frames in a row (which would buzz "wrong note"). Latency: from the note's start to
// the moment the third right frame is available. Targets: >= 95 % at 20 dB, >= 90 % at 10 dB, latency <= 120 ms.
import { Detector, legacyDetect } from '../src/core/detect.js';

const SR = 44100, HOP = Math.round(SR * 0.02), N = 2048;
const json = process.argv.includes('--json');

// ---------------------------------------------------------------- deterministic randomness
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hz = (m) => 440 * 2 ** ((m - 69) / 12);

// ---------------------------------------------------------------- tunes (midi, beats)
const TUNES = {
  ode: [[64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1], [60, 1], [60, 1], [62, 1], [64, 1], [64, 1.5], [62, 0.5], [62, 2], [64, 1], [64, 1], [65, 1], [67, 1], [67, 1], [65, 1], [64, 1], [62, 1], [60, 1], [60, 1], [62, 1], [64, 1], [62, 1.5], [60, 0.5], [60, 2]],
  twinkle: [[60, 1], [60, 1], [67, 1], [67, 1], [69, 1], [69, 1], [67, 2], [65, 1], [65, 1], [64, 1], [64, 1], [62, 1], [62, 1], [60, 2], [67, 1], [67, 1], [65, 1], [65, 1], [64, 1], [64, 1], [62, 2]],
  minuet: [[74, 1], [67, 0.5], [69, 0.5], [71, 0.5], [72, 0.5], [74, 1], [67, 1], [67, 1], [76, 1], [72, 0.5], [74, 0.5], [76, 0.5], [78, 0.5], [79, 1], [67, 1], [67, 1], [72, 1], [74, 0.5], [72, 0.5], [71, 0.5], [69, 0.5], [71, 1], [72, 0.5], [71, 0.5], [69, 0.5], [67, 0.5], [66, 1], [67, 0.5], [69, 0.5], [71, 0.5], [67, 0.5], [69, 3]],
  scale: [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 77, 76, 74, 72, 71, 69, 67, 65, 64, 62, 60].map((m) => [m, 0.75]),
  jacques: [[60, 1], [62, 1], [64, 1], [60, 1], [60, 1], [62, 1], [64, 1], [60, 1], [64, 1], [65, 1], [67, 2], [64, 1], [65, 1], [67, 2], [67, 0.5], [69, 0.5], [67, 0.5], [65, 0.5], [64, 1], [60, 1], [67, 0.5], [69, 0.5], [67, 0.5], [65, 0.5], [64, 1], [60, 1]],
  grace: [[62, 1], [67, 2], [71, 0.5], [67, 0.5], [71, 2], [69, 1], [67, 2], [64, 1], [62, 2], [62, 1], [67, 2], [71, 0.5], [67, 0.5], [71, 2], [69, 1], [74, 3]],
};
const INSTRUMENTS = {
  violin: { shift: 7, harm: (k) => (1 / k) * (k <= 6 ? 1 : 0.6), vib: 0.16, attack: 0.05, breath: 0.012 },
  flute: { shift: 12, harm: (k) => [1, 0.35, 0.12, 0.05, 0.02][k - 1] || 0, vib: 0.08, attack: 0.04, breath: 0.03 },
  voice: { shift: -5, harm: (k, f) => { const fr = k * f; return Math.exp(-(((fr - 700) / 300) ** 2)) + 0.6 * Math.exp(-(((fr - 1200) / 400) ** 2)) + 0.25 / k; }, vib: 0.3, attack: 0.07, breath: 0.01 },
  piano: { shift: 0, harm: (k) => 1 / k ** 1.3, vib: 0, attack: 0.005, breath: 0, decay: 1.6 },
};

function synth(tune, inst, bpm, seed) {
  const r = rng(seed);
  const spb = 60 / bpm;
  const lead = 1.0;                                  // a second of room first (calibration)
  const notes = [];
  let t = lead;
  for (const [m, beats] of tune) { const dur = beats * spb; notes.push({ midi: m + inst.shift, on: t, off: t + dur * 0.92 }); t += dur; }
  const len = Math.ceil((t + 0.5) * SR);
  const y = new Float64Array(len);
  for (const n of notes) {
    const f0 = hz(n.midi) * (1 + (r() - 0.5) * 0.004);           // a little out of tune, like a real player
    const a = Math.floor(n.on * SR), b = Math.floor(n.off * SR);
    const ph = new Float64Array(20);
    const amps = Array.from({ length: 20 }, (_, i) => inst.harm(i + 1, f0));
    const tot = amps.reduce((s, x) => s + x, 0) || 1;
    const vibRate = 5 + r(), vibPh = r() * 6;
    for (let i = a; i < b && i < len; i++) {
      const tt = (i - a) / SR;
      const env = Math.min(1, tt / inst.attack) * Math.min(1, (b - i) / (0.05 * SR)) * (inst.decay ? Math.exp(-tt / inst.decay) : 1);
      const vib = inst.vib * Math.min(1, tt / 0.25) * Math.sin(2 * Math.PI * vibRate * tt + vibPh);
      const f = f0 * 2 ** (vib / 12);
      let s = 0;
      for (let k = 0; k < 20; k++) { if (!amps[k] || f * (k + 1) > SR / 2.2) continue; ph[k] += (2 * Math.PI * f * (k + 1)) / SR; s += amps[k] * Math.sin(ph[k]); }
      y[i] += (0.25 * env * s) / tot + inst.breath * env * (r() * 2 - 1);
    }
  }
  return { y, notes };
}

// ---------------------------------------------------------------- room noise
function resonate(x, f, bw) {
  const r = Math.exp(-Math.PI * bw / SR), c = 2 * r * Math.cos((2 * Math.PI * f) / SR), out = new Float64Array(x.length);
  let y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i] + c * y1 - r * r * y2; out[i] = v * (1 - r); y2 = y1; y1 = v; }
  return out;
}
function talker(len, r, loud = 1) {
  const src = new Float64Array(len);
  let f0 = 100 + r() * 120, ph = 0, syl = 0, on = r() < 0.6;
  for (let i = 0; i < len; i++) {
    if (i % 2205 === 0) { f0 = Math.max(85, Math.min(260, f0 + (r() - 0.5) * 30)); if (++syl % 3 === 0) on = r() < 0.75; }
    ph += f0 / SR;
    if (ph >= 1) { ph -= 1; if (on) src[i] = 1; }
    if (on) src[i] += (r() - 0.5) * 0.15;
  }
  // vowels: formants that move every syllable
  const out = new Float64Array(len);
  const seg = 6615;
  for (let s = 0; s < len; s += seg) {
    const part = src.subarray(s, Math.min(len, s + seg));
    const f1 = 300 + r() * 600, f2 = 900 + r() * 1600, f3 = 2300 + r() * 600;
    const a = resonate(part, f1, 90), b = resonate(part, f2, 120), c = resonate(part, f3, 160);
    for (let i = 0; i < part.length; i++) out[s + i] = loud * (a[i] + 0.6 * b[i] + 0.3 * c[i]) * 40;
  }
  return out;
}
function pink(len, r) {
  const out = new Float64Array(len);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) { const w = r() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
  return out;
}
const NOISES = {
  cafe(len, r) {
    const out = pink(len, r).map((x) => x * 0.3);
    for (let k = 0; k < 6; k++) { const t = talker(len, r, 0.5 + r() * 0.5); for (let i = 0; i < len; i++) out[i] += t[i]; }
    for (let c = 0; c < len / SR * 1.5; c++) {                    // cups and plates
      const at = Math.floor(r() * len), f = 2000 + r() * 4000;
      for (let i = 0; i < SR * 0.25 && at + i < len; i++) out[at + i] += 0.8 * Math.exp(-i / (SR * 0.04)) * Math.sin((2 * Math.PI * f * i) / SR);
    }
    return out;
  },
  tv(len, r) {
    const out = talker(len, r, 1.2);
    const b = talker(len, r, 0.5), p = pink(len, r);
    for (let i = 0; i < len; i++) out[i] += b[i] + 0.4 * p[i];
    return out;
  },
  traffic(len, r) {
    const out = new Float64Array(len);
    let brown = 0;
    const p = pink(len, r);
    let car = 0, carT = 0;
    for (let i = 0; i < len; i++) {
      brown = (brown + (r() * 2 - 1) * 0.02) * 0.998;
      const t = i / SR;
      if (--carT <= 0) { car = 0.5 + r(); carT = Math.floor(SR * (2 + r() * 3)); }
      const sweep = Math.sin(Math.PI * (1 - carT / (SR * 4))) ** 2;
      out[i] = brown * 6 + 0.25 * Math.sin(2 * Math.PI * 42 * t) + 0.12 * Math.sin(2 * Math.PI * 84 * t) + 0.5 * p[i] * (0.4 + car * sweep);
    }
    return out;
  },
};

function mix(sig, notes, noise, snrDb) {
  let ps = 0, nsamp = 0;
  for (const n of notes) for (let i = Math.floor(n.on * SR); i < Math.floor(n.off * SR); i++) { ps += sig[i] * sig[i]; nsamp++; }
  ps /= nsamp || 1;
  let pn = 0;
  for (let i = 0; i < noise.length; i++) pn += noise[i] * noise[i];
  pn /= noise.length;
  const g = Math.sqrt(ps / (pn * 10 ** (snrDb / 10)));
  const out = new Float64Array(sig.length);
  for (let i = 0; i < sig.length; i++) out[i] = sig[i] + g * noise[i];
  return out;
}

// ---------------------------------------------------------------- scoring
function run(y, notes, mode) {
  const det = new Detector({ sr: SR, size: N });
  const frames = [];
  const calEnd = Math.floor(0.95 * SR);
  if (mode === 'new') det.startCalibration();
  for (let end = N; end <= y.length; end += HOP) {
    const frame = y.subarray(end - N, end);
    const t = end / SR;
    if (mode === 'new' && end <= calEnd) { det.calibrate(frame); continue; }
    if (mode === 'new' && det.calibrating) det.finishCalibration();
    const k = notes.findIndex((n) => t >= n.on && t < n.off + 0.06);
    det.expect = k >= 0 ? [notes[k].midi] : [];
    const p = mode === 'new' ? det.process(frame) : legacyDetect(frame, SR);
    frames.push({ t, midi: p ? Math.round(p.midi) : null });
  }
  let right = 0;
  const lat = [];
  for (const n of notes) {
    const fs = frames.filter((f) => f.t >= n.on && f.t < n.off + 0.06);
    let run = 0, wrongRun = 0, ok = false, wrong = false, first = null, wm = null;
    for (const f of fs) {
      if (f.midi === n.midi) { run++; wrongRun = 0; if (run >= 3 && !ok) { ok = true; first = f.t; } }
      else { run = 0; if (f.midi !== null && f.t > n.on + 0.08) { wrongRun = f.midi === wm ? wrongRun + 1 : 1; wm = f.midi; if (wrongRun >= 6) wrong = true; } else wrongRun = 0; }
    }
    if (ok && !wrong) { right++; lat.push(first - n.on); }
  }
  lat.sort((a, b) => a - b);
  return { right, total: notes.length, latency: lat.length ? lat[Math.floor(lat.length / 2)] : null };
}

const results = [];
const tuneNames = Object.keys(TUNES);
for (const noise of ['clean', 'cafe', 'tv', 'traffic']) {
  for (const snr of noise === 'clean' ? [Infinity] : [20, 10, 5]) {
    const agg = { new: { right: 0, total: 0, lat: [] }, old: { right: 0, total: 0, lat: [] } };
    let seed = 1;
    for (const [iname, inst] of Object.entries(INSTRUMENTS)) {
      for (const tn of tuneNames) {
        const { y: sig, notes } = synth(TUNES[tn], inst, 96 + (seed % 3) * 12, seed * 7 + 1);
        const y = noise === 'clean' ? sig : mix(sig, notes, NOISES[noise](sig.length, rng(seed * 13 + snr)), snr);
        for (const mode of ['new', 'old']) {
          const r = run(y, notes, mode);
          agg[mode].right += r.right; agg[mode].total += r.total; if (r.latency != null) agg[mode].lat.push(r.latency);
        }
        seed++;
        void iname;
      }
    }
    const pct = (a) => Math.round((1000 * a.right) / a.total) / 10;
    const ms = (a) => (a.lat.length ? Math.round(a.lat.sort((x, y) => x - y)[Math.floor(a.lat.length / 2)] * 1000) : null);
    results.push({ noise, snr: snr === Infinity ? 'clean' : snr, notes: agg.new.total, new: pct(agg.new), old: pct(agg.old), latency_ms: ms(agg.new) });
  }
}

const by = (snr) => results.filter((r) => r.snr === snr && r.noise !== 'clean');
const avg = (xs, k) => Math.round((10 * xs.reduce((s, r) => s + r[k], 0)) / xs.length) / 10;
const at20 = avg(by(20), 'new'), at10 = avg(by(10), 'new');
const lat = Math.max(...results.map((r) => r.latency_ms || 0));
const pass = at20 >= 95 && at10 >= 90 && lat <= 120;
if (json) console.log(JSON.stringify({ results, at20, at10, latency_ms: lat, pass }, null, 2));
else {
  console.log('Play Along: notes detected right (monophonic corpus: violin, flute, voice, piano tone x 6 tunes)\n');
  console.log('| Noise | SNR | Notes | New detector | Old detector | Latency (median) |');
  console.log('|---|---|---|---|---|---|');
  for (const r of results) console.log(`| ${r.noise} | ${r.snr === 'clean' ? '-' : `${r.snr} dB`} | ${r.notes} | ${r.new} % | ${r.old} % | ${r.latency_ms} ms |`);
  console.log(`\nAverage: ${at20} % at 20 dB, ${at10} % at 10 dB (targets 95 % and 90 %); worst median latency ${lat} ms (target 120 ms): ${pass ? 'PASS' : 'FAIL'}`);
}
process.exit(pass ? 0 : 1);
