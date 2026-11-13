// "Wait for me" follower: matching, repeated notes, wrong notes, octaves, per-bar results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseABC } from '../src/core/abc.js';
import { performance } from '../src/core/score.js';
import { expectedNotes, Follower, trickyBars } from '../src/core/follow.js';
import { q } from '../src/core/q.js';

const TUNE = `X:1\nT:Test\nM:4/4\nL:1/4\nK:C\nC C G G | A A G2 | [CE] D E F |\n`;
const perf = performance(parseABC(TUNE));
const hold = (f, midi, n, rms = 0.05) => { let r = null; for (let i = 0; i < n; i++) r = f.push({ midi, rms }) || r; return r; };

test('expected notes: one entry per onset, chords grouped, range filter', () => {
  const exp = expectedNotes(perf);
  assert.deepEqual(exp.map((e) => e.top), [60, 60, 67, 67, 69, 69, 67, 64, 62, 64, 65]);
  assert.deepEqual(exp[7].midis.sort(), [60, 64]);
  assert.equal(expectedNotes(perf, () => true, { from: 1, to: 1 }).length, 3);
});

test('follower waits for each note and needs a new attack for repeated notes', () => {
  const f = new Follower(expectedNotes(perf));
  assert.equal(hold(f, 60, 2), null);                 // too short to count
  assert.equal(hold(f, 60, 1).type, 'ok');            // third frame: counted
  assert.equal(hold(f, 60, 10), null);                // still holding the same C: not the second C yet
  f.push(null);                                       // the player lets go
  assert.deepEqual(hold(f, 60, 3), { type: 'ok', index: 1 });
  assert.equal(hold(f, 67, 3).type, 'ok');
  // re-striking the same pitch (a louder attack) also counts
  assert.equal(f.push({ midi: 67, rms: 0.2 }), null);
  assert.equal(hold(f, 67, 2, 0.2).type, 'ok');
  assert.equal(f.k, 4);
});

test('a held wrong note is a mistake once, and does not move on', () => {
  const f = new Follower(expectedNotes(perf));
  const r = hold(f, 61, 8);
  assert.deepEqual(r, { type: 'wrong', index: 0, played: 61 });
  assert.equal(f.k, 0);
  assert.equal(hold(f, 60, 3).type, 'ok');
  const res = f.result();
  assert.equal(res.total, 1);
  assert.equal(res.right, 0);                          // right on the second try only
});

test('chords count when any of their notes is heard; singers may be an octave off', () => {
  const exp = expectedNotes(perf, () => true, { from: 2, to: 2 });
  const f = new Follower(exp);
  assert.equal(hold(f, 64, 3).type, 'ok');             // E of the C-E chord
  const sing = new Follower(expectedNotes(perf), { octaveOk: true });
  assert.equal(hold(sing, 48, 3).type, 'ok');          // C3 for C4
});

test('tricky bars: worst first, only below the bar', () => {
  const bars = new Map([[0, { right: 4, total: 4 }], [1, { right: 1, total: 4 }], [2, { right: 2, total: 4 }]]);
  assert.deepEqual(trickyBars(bars).map((b) => b.mi), [1, 2]);
});

test('octave slips of the pitch tracker count after a longer hold, and mistakes are listed', () => {
  const exp = [{ t: q(0), mi: 0, midis: [64], top: 64, ids: ['a'] }, { t: q(1), mi: 0, midis: [67], top: 67, ids: ['b'] }, { t: q(2), mi: 1, midis: [69], top: 69, ids: ['c'] }];
  const f = new Follower(exp);
  const feed = (m, n, rms = 0.05) => { let r = null; for (let i = 0; i < n; i++) r = f.push({ midi: m, rms }) || r; return r; };
  assert.equal(feed(52, 4), null);                                  // an octave low: not yet
  assert.deepEqual(feed(52, 1), { type: 'ok', index: 0, octave: true });
  f.push(null);
  assert.deepEqual(feed(66, 6), { type: 'wrong', index: 1, played: 66 });   // F# instead of G
  assert.deepEqual(feed(67, 3), { type: 'ok', index: 1 });
  // the app's own accompaniment is not taken for the player
  f.ignore = (m) => m === 72;
  assert.equal(feed(72, 10), null);
  f.ignore = null;
  f.push(null);
  feed(69, 3);
  const r = f.result();
  assert.equal(r.total, 3);
  assert.equal(r.right, 2);
  assert.deepEqual(r.wrong.map((w) => [w.mi, w.want, w.played]), [[0, 67, 66]]);
});

test('a bowed repeated note counts again after the sound dips and rises', () => {
  const exp = [{ t: q(0), mi: 0, midis: [69], top: 69, ids: ['a'] }, { t: q(1), mi: 0, midis: [69], top: 69, ids: ['b'] }];
  const f = new Follower(exp);
  for (let i = 0; i < 3; i++) f.push({ midi: 69, rms: 0.08 });
  assert.equal(f.k, 1);
  for (let i = 0; i < 5; i++) assert.equal(f.push({ midi: 69, rms: 0.08 }), null);   // still the same note
  f.push(null, 0.03);                                                                  // a bow change: quieter, unclear
  let r = null;
  for (let i = 0; i < 4; i++) r = f.push({ midi: 69, rms: 0.07 }) || r;
  assert.deepEqual(r, { type: 'ok', index: 1 });
});
