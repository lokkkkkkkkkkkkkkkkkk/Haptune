// The microphone in Play Along: a quiet phone microphone (gain control off) and someone who starts playing while
// the room is being measured must both still be heard (Part 3: "the mic hears nothing").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Detector } from '../src/core/detect.js';

const sr = 48000, N = 2048, hop = 960;
function synth(seconds, notes, amp, noise, seed = 7) {
  const out = new Float32Array(Math.round(seconds * sr));
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (const { midi, t0, dur } of notes) {
    const f = 440 * 2 ** ((midi - 69) / 12);
    for (let i = Math.round(t0 * sr); i < Math.min(out.length, Math.round((t0 + dur) * sr)); i++) {
      const tt = i / sr - t0;
      let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * tt) / (h * h);
      out[i] += amp * Math.exp(-tt * 1.5) * v;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] += noise * rnd();
  return out;
}
const tune = [60, 62, 64, 65, 67].map((m, i) => ({ midi: m, t0: 0.2 + i * 0.6, dur: 0.6 }));
function heard(sig, cal) {
  const d = new Detector({ sr, size: N });
  d.startCalibration();
  for (let i = 0; i + N <= cal.length; i += hop) d.calibrate(cal.subarray(i, i + N));
  d.finishCalibration();
  const notes = new Set();
  let frames = 0;
  for (let i = 0; i + N <= sig.length; i += hop) { const r = d.process(sig.subarray(i, i + N)); if (r) { frames++; notes.add(Math.round(r.midi)); } }
  return { frames, notes };
}

test('a quiet microphone (peaks near -50 dB) is still heard', () => {
  const r = heard(synth(3.4, tune, 0.003, 0.0003), synth(1, [], 0, 0.0003));
  for (const m of [60, 62, 64, 65, 67]) assert.ok(r.notes.has(m), `note ${m} not heard`);
  assert.ok(r.frames > 120, `only ${r.frames} pitched frames`);
});

test('playing while the room is measured does not make the detector deaf', () => {
  const r = heard(synth(3.4, tune, 0.05, 0.001), synth(1, [{ midi: 60, t0: 0, dur: 1 }], 0.05, 0.001));
  for (const m of [60, 62, 64, 65, 67]) assert.ok(r.notes.has(m), `note ${m} not heard`);
  assert.ok(r.frames > 110, `only ${r.frames} pitched frames`);
});

test('silence stays silent', () => {
  const r = heard(synth(2, [], 0, 0.0004), synth(1, [], 0, 0.0004));
  assert.equal(r.frames, 0);
});
