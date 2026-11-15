import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/core/sound.js';
import { yinCore } from '../src/core/detect.js';

test('mixer state: tracks, limits, mute and solo', () => {
  let s = S.newSound({ title: 'Idea', tempo: 120 });
  const a = S.newTrack('mic', { name: 'Voice' }), b = S.newTrack('backing'), c = S.newTrack('instrument');
  s = S.addTrack(S.addTrack(S.addTrack(s, a), b), c);
  assert.deepEqual(S.audible(s).map((t) => t.kind), ['mic', 'backing', 'instrument']);
  s = S.updateTrack(s, b.id, { mute: true });
  assert.deepEqual(S.audible(s).map((t) => t.kind), ['mic', 'instrument']);
  s = S.updateTrack(s, a.id, { solo: true });
  assert.deepEqual(S.audible(s).map((t) => t.id), [a.id]);
  s = S.removeTrack(s, c.id);
  assert.equal(s.tracks.length, 2);
  let full = S.newSound();
  for (let i = 0; i < 8; i++) full = S.addTrack(full, S.newTrack('audio'));
  assert.throws(() => S.addTrack(full, S.newTrack('audio')), /at most 8/);
  assert.throws(() => S.newTrack('video'), /unknown/);
});

test('length in whole bars, trim, loop and stretch', () => {
  let s = S.newSound({ tempo: 120, bars: 2 });                        // a bar = 2 s
  assert.equal(S.soundSeconds(s), 4);
  s = S.addTrack(s, S.newTrack('audio', { clip: { id: 'x', seconds: 9, sampleRate: 44100 }, trim: { start: 1, end: 6 }, offset: 0.5 }));
  assert.equal(S.trackSeconds(s, s.tracks[0]), 5);
  assert.equal(S.soundSeconds(s), 6);                                 // 5.5 s -> 3 bars
  const st = S.changeTempo(s, 60);
  assert.equal(st.tracks[0].stretch, 2);
  assert.equal(st.tracks[0].offset, 1);
  const n = S.addTrack(S.newSound({ tempo: 60 }), S.newTrack('instrument', { notes: [{ t: 0, dur: 1, midi: 60, vel: 90 }, { t: 6, dur: 2, midi: 64, vel: 90 }] }));
  assert.equal(S.trackSeconds(n, n.tracks[0]), 8);
  assert.equal(S.changeTempo(n, 120).tracks[0].notes[1].t, 6, 'notes keep their beats');
});

test('quantize to the grid', () => {
  const q = S.quantize([{ t: 0.12, dur: 0.4, midi: 60 }, { t: 0.93, dur: 0.55, midi: 62 }], 0.5);
  assert.deepEqual(q.map((n) => [n.t, n.dur]), [[0, 0.5], [1, 0.5]]);
  const half = S.quantize([{ t: 0.2, dur: 1, midi: 60 }], 1, 0.5);
  assert.equal(half[0].t, 0.1);
});

test('time-stretch keeps the pitch and changes the length', () => {
  const sr = 22050;
  const x = Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * 330 * i) / sr) * 0.5);
  for (const f of [0.8, 1.25]) {
    const y = S.timeStretch(x, f);
    assert.ok(Math.abs(y.length - sr * f) < 2);
    const mid = y.subarray(Math.floor(y.length / 2) - 1024, Math.floor(y.length / 2) + 1024);
    const p = yinCore(Float64Array.from(mid), sr);
    assert.ok(Math.abs(12 * Math.log2(p.freq / 330)) < 0.15, `pitch after x${f}: ${p.freq}`);
  }
});

test('WAV mixdown round trip, MIDI for instrument tracks, peaks', () => {
  const l = Float32Array.from([0, 0.5, -0.5, 1, -1]), r = Float32Array.from([0.25, 0, 0, 0, 0]);
  const wav = S.encodeWav([l, r], 44100);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
  assert.equal(wav.length, 44 + 5 * 2 * 2);
  const back = S.decodeWav(wav);
  assert.equal(back.sampleRate, 44100);
  assert.ok(Math.abs(back.channels[0][1] - 0.5) < 1e-3 && Math.abs(back.channels[1][0] - 0.25) < 1e-3);
  const s = S.addTrack(S.newSound({ tempo: 100 }), S.newTrack('instrument', { notes: [{ t: 0, dur: 1, midi: 60, vel: 90 }] }));
  const mid = S.soundToMidi(s);
  assert.equal(String.fromCharCode(...mid.subarray(0, 4)), 'MThd');
  assert.equal(mid[11], 2, 'tempo track + one instrument track');
  assert.equal(S.peaks(Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i)), 10).length, 10);
});

test('layer with me: a new Sound on the original, with credit', () => {
  const parent = { ...S.newSound({ title: 'Riff', tempo: 100, bars: 4 }), post_id: 'abc', credits: [{ handle: 'ana' }] };
  const l = S.layerOn(parent, { mixdownClipId: 'c1', seconds: 9.6, sampleRate: 44100, author: { handle: 'ben' } });
  assert.equal(l.parent, 'abc');
  assert.deepEqual(l.credits.map((c) => c.handle), ['ana', 'ben']);
  assert.equal(l.tracks[0].clip.id, 'c1');
  assert.equal(l.tempo, 100);
  const post = S.projectForPost(l);
  assert.equal(post.tracks[0].clip.id, undefined);
});

test('undo and redo', () => {
  let h = S.history.start(S.newSound());
  h = S.history.push(h, S.setSound(h.now, { tempo: 100 }));
  h = S.history.undo(h);
  assert.equal(h.now.tempo, 90);
  assert.equal(S.history.redo(h).now.tempo, 100);
});
