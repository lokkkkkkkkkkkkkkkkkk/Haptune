import test from 'node:test';
import assert from 'node:assert/strict';
import { chipScore, sortBy } from '../src/core/shelves.js';

const items = [
  { title: 'Jig', genre: 'folk', level: 2, instrument: 'violin' },
  { title: 'Amazing Grace', genre: 'hymn', level: 1, instrument: 'piano' },
  { title: 'Minuet', genre: 'classical', level: 3, instrument: 'piano' },
  { title: 'Pop song', kind: 'request' },
];

test('a chip moves its matches to the front and keeps everything else in order', () => {
  assert.deepEqual(sortBy(items, 'hymn', 'violin').map((x) => x.title), ['Amazing Grace', 'Jig', 'Minuet', 'Pop song']);
  assert.deepEqual(sortBy(items, 'mine', 'violin').map((x) => x.title), ['Jig', 'Amazing Grace', 'Minuet', 'Pop song']);
  assert.deepEqual(sortBy(items, 'pop', 'violin')[0].title, 'Pop song');
  assert.deepEqual(sortBy(items, 'exam', 'violin')[0].title, 'Minuet');
  assert.equal(sortBy(items, 'classical', '').length, items.length);
});

test('no chip: the shelf is untouched', () => {
  assert.equal(sortBy(items, '', 'violin'), items);
  assert.equal(chipScore('', items[0], 'violin'), 0);
});
