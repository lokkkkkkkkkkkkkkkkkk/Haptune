import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, stability, trend, recommendations, nextExercise, stars, reportText } from '../src/core/report.js';

const take = {
  accuracy: 0.72, right: 18, total: 25, speed: 0.9, mode: 'wait',
  barsList: [{ bar: 1, accuracy: 1 }, { bar: 2, accuracy: 0.4 }, { bar: 3, accuracy: 0.9 }, { bar: 4, accuracy: 0.6 }],
  wrong: [{ bar: 2, mi: 1, want: 'F#5', played: 'F5' }, { bar: 2, mi: 1, want: 'F#5', played: 'F5' }, { bar: 4, mi: 3, want: 'C5', played: null }],
  tricky: [{ mi: 1, missed: 3 }],
};

test('overview, details, worst bars', () => {
  const r = buildReport(take, { pieceId: 'p1', key: { fifths: 1, mode: 'major' } });
  assert.equal(r.overview.accuracy, 72);
  assert.equal(r.overview.stars, 1);
  assert.deepEqual(r.worstBars.map((b) => b.bar), [2, 4]);
  assert.equal(r.bars[1].pct, 40);
  assert.equal(r.notes.length, 3);
  assert.ok(r.overview.stability < 80);
});

test('three concrete recommendations: loop the worst bar slower, the repeated slip, steadiness', () => {
  const recs = recommendations(take);
  assert.equal(recs.length, 3);
  assert.deepEqual(recs[0], { key: 'recLoopBar', vars: { bar: 2, speed: 70 }, bars: [1] });
  assert.deepEqual(recs[1], { key: 'recSameSlip', vars: { want: 'F#5', played: 'F5', n: 2 } });
  assert.equal(recommendations({ accuracy: 0.97, speed: 0.8, barsList: [] })[0].key, 'recFaster');
  assert.equal(recommendations({ accuracy: 0.4, speed: 1, barsList: [] })[0].key, 'recSlower');
});

test('trend, stability, stars, next exercise and the text version', () => {
  const h = [{ pieceId: 'p1', date: 2, accuracy: 0.5 }, { pieceId: 'p2', date: 1, accuracy: 0.9 }, { pieceId: 'p1', date: 1, accuracy: 0.4 }];
  assert.deepEqual(trend(h, 'p1', { date: 3, accuracy: 0.7 }).map((x) => x.accuracy), [0.4, 0.5, 0.7]);
  assert.equal(stability([{ accuracy: 0.8 }, { accuracy: 0.8 }]), 1);
  assert.equal(stability([]), null);
  assert.deepEqual([0.96, 0.8, 0.6, 0.2].map(stars), [3, 2, 1, 0]);
  assert.deepEqual(nextExercise({ accuracy: 0.9 }, { fifths: 2, mode: 'major' }), { tonic: 'D', type: 'major', octaves: 2, speed: 100 });
  assert.equal(nextExercise({ accuracy: 0.5 }, { fifths: 0, mode: 'minor' }).tonic, 'A');
  const txt = reportText(buildReport(take), 'Minuet', (k, v) => `${k}:${v?.n ?? v?.bar ?? ''}`);
  assert.match(txt, /^Minuet: 72% \(18\/25\) ★/);
  assert.equal(txt.split('\n').length, 5);
});
