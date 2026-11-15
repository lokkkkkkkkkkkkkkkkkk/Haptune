// The free library: the licence rules of tools/import-catalog.mjs, and an audit of what is actually in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { okLicence, readPiece } from '../tools/import-catalog.mjs';
import { GENRE_IDS } from '../src/core/genres.js';
import { newSound, newTrack, addTrack, soundToMidi } from '../src/core/sound.js';

const CAT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'assets', 'catalog');

test('only licences that allow use in a paid app', () => {
  for (const ok of ['Public domain', 'Public domain · Mutopia Project', 'CC0 · OpenScore String Quartets', 'CC BY 4.0 · Mutopia Project · typeset by A',
    'CC BY-SA 3.0 · Mutopia Project', 'CC BY-SA']) assert.ok(okLicence(ok), ok);
  for (const no of ['', 'CC BY-NC 4.0', 'CC BY-NC-SA 4.0', 'CC BY-ND 4.0', 'All rights reserved', 'GPL', 'Unknown', 'Creative Commons',
    'CC BY-SA 4.0 · NonCommercial', 'Copyright 2000, John Miller']) assert.ok(!okLicence(no), no);
});

test('a MIDI file opens with the app reader (as Mutopia pieces do)', async () => {
  let s = newSound({ tempo: 100, bars: 4 });
  s = addTrack(s, newTrack('instrument', { notes: Array.from({ length: 24 }, (_, i) => ({ t: i * 0.5, dur: 0.5, midi: 60 + (i % 8), vel: 90 })) }));
  const score = await readPiece(soundToMidi(s), 'x.mid');
  assert.ok(score.measures.length >= 3);
});

test('every piece in the catalogue: open licence, known genre, its file is there', () => {
  const index = JSON.parse(fs.readFileSync(path.join(CAT, 'index.json'), 'utf8'));
  assert.ok(index.items.length > 4000);
  const ids = new Set();
  const files = new Set();
  for (const [id, title, , genre, , file, licence] of index.items) {
    assert.ok(!ids.has(id), `duplicate id ${id}`); ids.add(id);
    assert.ok(title, id);
    assert.ok(okLicence(licence), `${id}: licence "${licence}"`);
    assert.ok(GENRE_IDS.includes(genre), `${id}: genre ${genre}`);
    files.add(file.split('#')[0]);
  }
  for (const f of files) assert.ok(fs.existsSync(path.join(CAT, f)), `missing ${f}`);
  for (const s of index.sources || []) assert.ok(s.name && /^https:\/\//.test(s.url) && s.count >= 0, JSON.stringify(s));
});
