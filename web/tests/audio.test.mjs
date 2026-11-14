import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMicGraph, reachesOutput, needsKeepAlive } from '../src/ui/micgraph.js';
import { fft, yinCore, Detector, correctOctave, chroma, chordMatch, rmsOf, legacyDetect } from '../src/core/detect.js';

// a fake Web Audio context that records every connection
function fakeCtx() {
  const node = (kind, extra = {}) => ({ kind, outputs: [], connect(to) { this.outputs.push(to); return to; }, disconnect() { this.outputs = []; }, ...extra });
  const destination = node('destination');
  return {
    destination,
    createMediaStreamSource: () => node('mic'),
    createBiquadFilter: () => node('biquad', { frequency: { value: 0 }, Q: { value: 0 }, type: '' }),
    createAnalyser: () => node('analyser', { fftSize: 0 }),
    createGain: () => node('gain', { gain: { value: 1 } }),
  };
}

test('the microphone graph never reaches the speakers (Chrome/Android and Safari)', () => {
  for (const keepAlive of [false, true]) {
    const ctx = fakeCtx();
    const g = buildMicGraph(ctx, {}, { keepAlive });
    assert.equal(reachesOutput(g.src, ctx.destination), false, `keepAlive=${keepAlive}`);
    assert.equal(g.hp.type, 'highpass');
    assert.equal(g.hp.frequency.value, 70);
    if (keepAlive) assert.equal(g.sink.gain.value, 0);
    else assert.equal(g.sink, null);
  }
  // the check itself works: a gain of 1 on the way out is caught
  const ctx = fakeCtx();
  const g = buildMicGraph(ctx, {}, { keepAlive: true });
  g.sink.gain.value = 1;
  assert.equal(reachesOutput(g.src, ctx.destination), true);
});

test('only Safari gets the silent keep-alive path', () => {
  assert.equal(needsKeepAlive('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), true);
  assert.equal(needsKeepAlive('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'), false);
  assert.equal(needsKeepAlive('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'), false);
});

const SR = 44100;
const tone = (f, n = 2048, amp = 0.2, harm = [1, 0.5, 0.3]) => Float64Array.from({ length: n }, (_, i) => amp * harm.reduce((s, a, k) => s + a * Math.sin((2 * Math.PI * f * (k + 1) * i) / SR), 0) / harm.length);
function noise(n, amp, seed = 1) { let s = seed; return Float64Array.from({ length: n }, () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return amp * ((s / 0x7fffffff) * 2 - 1); }); }
const add = (a, b) => a.map((x, i) => x + b[i]);

test('fft and its inverse give the signal back', () => {
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + (i % 5)), im = new Float64Array(64);
  const orig = [...re];
  fft(re, im); fft(re, im, true);
  re.forEach((x, i) => assert.ok(Math.abs(x - orig[i]) < 1e-9));
});

test('YIN finds the pitch of a tone with harmonics', () => {
  for (const f of [110, 196, 440, 880]) {
    const y = yinCore(tone(f), SR);
    assert.ok(y && Math.abs(12 * Math.log2(y.freq / f)) < 0.1, `${f}`);
  }
});

test('octave and twelfth errors are corrected towards the expected note, other notes are not', () => {
  assert.equal(correctOctave(81.1, [69]), 69.1);
  assert.equal(correctOctave(57, [69]), 69);
  assert.equal(correctOctave(88, [69]), 69);
  assert.equal(correctOctave(70, [69]), 70, 'a wrong note stays wrong');
  assert.equal(correctOctave(76, [69]), 76);
});

test('chroma recognises a piano chord', () => {
  const n = 4096;
  const x = add(add(tone(261.63, n), tone(329.63, n)), tone(392, n));
  const d = new Detector({ sr: SR, size: n });
  const ch = chroma(d.spectrum(x).mag, SR, n);
  assert.ok(chordMatch(ch, [60, 64, 67]) > 0.4);
  assert.ok(chordMatch(ch, [62, 65, 69]) < chordMatch(ch, [60, 64, 67]));
});

test('the detector learns the room: noise alone is silence, a note in noise is found, a wrong note stays wrong', () => {
  const d = new Detector({ sr: SR });
  d.startCalibration();
  for (let i = 0; i < 40; i++) d.calibrate(noise(2048, 0.03, i + 1));
  const cal = d.finishCalibration();
  assert.ok(cal.noiseRms > 0.01 && cal.db < -20);
  let hits = 0;
  for (let i = 0; i < 20; i++) if (d.process(noise(2048, 0.03, 100 + i))) hits++;
  assert.ok(hits <= 2, `noise heard as notes ${hits} times`);
  d.expect = [69];
  const a = d.process(add(tone(440, 2048, 0.15), noise(2048, 0.03, 7)));
  assert.ok(a && Math.round(a.midi) === 69);
  d.expect = [69];
  let wrong = null;
  for (let i = 0; i < 6; i++) wrong = d.process(add(tone(466.16, 2048, 0.15), noise(2048, 0.03, 20 + i)));
  assert.equal(Math.round(wrong.midi), 70);
  // the old detector, for comparison, has a fixed gate
  assert.equal(legacyDetect(tone(440, 2048, 0.005), SR), null);
  assert.ok(rmsOf(tone(440, 2048, 0.2)) > 0.05);
});
