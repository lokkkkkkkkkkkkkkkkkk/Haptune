// The Write studio's note entry: blank scores, writing over rests, bars staying full, new bars, chords, Backspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { q, ZERO } from '../src/core/q.js';
import { blankScore, writeAt, eraseBefore, addToChord, setChordSymbol, splitLength, noteAt, step, trimEmptyEnd } from '../src/core/write.js';
import { writeMusicXML, parseMusicXML } from '../src/core/musicxml.js';
import { midiOf } from '../src/core/pitch.js';

globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const voice1 = (sc, mi, staff = 1) => sc.parts[0].measures[mi].notes.filter((n) => (n.staff || 1) === staff && !n.chord);
const full = (sc, mi, staff = 1) => voice1(sc, mi, staff).reduce((a, n) => a.add(n.dur), ZERO);

test('a blank score is all rests, with the key, time and tempo asked for', () => {
  const sc = blankScore({ title: 'My Song', instrument: 'violin', key: 2, time: [3, 4], tempo: 72, bars: 4 });
  assert.equal(sc.measures.length, 4);
  assert.equal(sc.title, 'My Song');
  assert.ok(sc.measures[0].dur.eq(q(3)));
  assert.equal(sc.parts[0].measures[0].key.fifths, 2);
  assert.ok(sc.parts[0].measures.every((pm) => pm.notes.every((n) => n.rest)));
  const piano = blankScore({ instrument: 'piano', bars: 2 });
  assert.equal(piano.parts[0].staves, 2);
});

test('notes are written at the cursor, bars stay full, and the cursor moves on', () => {
  let sc = blankScore({ instrument: 'violin', key: 1, bars: 1 });
  let cur = { pi: 0, staff: 1, mi: 0, off: ZERO };
  for (const m of [67, 69, 71]) ({ score: sc, cur } = writeAt(sc, cur, { midi: m, len: q(1) }));
  assert.ok(cur.off.eq(q(3)) && cur.mi === 0);
  assert.ok(full(sc, 0).eq(q(4)));
  assert.deepEqual(voice1(sc, 0).map((n) => (n.rest ? 'r' : midiOf(n.pitch))), [67, 69, 71, 'r']);
  // a half note with one beat left is cut to fit, and a new bar appears
  ({ score: sc, cur } = writeAt(sc, cur, { midi: 66, len: q(2) }));
  assert.equal(sc.measures.length, 2);
  assert.ok(cur.mi === 1 && cur.off.isZero());
  const fs = voice1(sc, 0)[3];
  assert.equal(fs.pitch.step, 'F'); assert.equal(fs.pitch.alter, 1);                 // F sharp in G major
  // writing over the middle of the bar replaces what was there
  ({ score: sc } = writeAt(sc, { pi: 0, staff: 1, mi: 0, off: q(1) }, { midi: null, len: q(1, 2) }));
  assert.ok(full(sc, 0).eq(q(4)));
  assert.deepEqual(voice1(sc, 0).map((n) => (n.rest ? 'r' : midiOf(n.pitch))), [67, 'r', 'r', 71, 66]);
  // round trip through MusicXML
  const back = parseMusicXML(writeMusicXML(sc));
  assert.ok(back.parts[0].measures.every((pm, i) => pm.notes.filter((n) => !n.chord && (n.staff || 1) === 1).reduce((a, n) => a.add(n.dur), ZERO).eq(sc.measures[i].dur)));
});

test('chords, chord symbols, Backspace and moving the cursor', () => {
  let sc = blankScore({ instrument: 'piano', bars: 1 });
  let cur = { pi: 0, staff: 1, mi: 0, off: ZERO };
  ({ score: sc, cur } = writeAt(sc, cur, { midi: 60, len: q(2) }));
  ({ score: sc } = addToChord(sc, cur, 64));
  ({ score: sc } = addToChord(sc, cur, 67));
  const pm = sc.parts[0].measures[0];
  assert.deepEqual(pm.notes.filter((n) => n.off.isZero() && !n.rest && (n.staff || 1) === 1).map((n) => midiOf(n.pitch)).sort(), [60, 64, 67]);
  assert.ok(full(sc, 0, 2).eq(q(4)));                                                   // the left hand is untouched
  sc = setChordSymbol(sc, 0, 'C');
  assert.equal(sc.parts[0].measures[0].harmonies.length, 1);
  assert.equal(setChordSymbol(sc, 0, 'not a chord!'), null);
  ({ score: sc, cur } = eraseBefore(sc, cur));
  assert.ok(cur.off.isZero());
  assert.ok(voice1(sc, 0).every((n) => n.rest) && full(sc, 0).eq(q(4)));
  assert.ok(noteAt(sc, cur).rest);
  assert.ok(step(sc, cur, 1).off.gt(ZERO));
  assert.equal(trimEmptyEnd(blankScore({ bars: 5 })).measures.length, 1);
});

test('lengths split into plain note values', () => {
  assert.deepEqual(splitLength(q(5, 4)).map((x) => x.num()), [1, 0.25]);
  assert.deepEqual(splitLength(q(3)).map((x) => x.num()), [3]);                         // a dotted half
  assert.deepEqual(splitLength(q(7, 2)).map((x) => x.num()), [3, 0.5]);
});
