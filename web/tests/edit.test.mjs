import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { parseABC } from '../src/core/abc.js';
import { parseMusicXML, writeMusicXML } from '../src/core/musicxml.js';
import { performance, measureLength, timeAt } from '../src/core/score.js';
import { qsum } from '../src/core/q.js';
import { findNote, movePitch, toRest, toNote, splitNote, joinNext, addChordNote, sliceMeasures } from '../src/core/edit.js';
import { arrangeFor, INSTRUMENT_DEFS } from '../src/core/instruments.js';
import { INSTRUMENTS } from '../src/core/i18n.js';

const tune = () => parseABC('X:1\nT:Test\nM:4/4\nL:1/4\nK:G\nG A B c|d2 B2|c4|]');
const ev = (s) => performance(s, { repeats: false }).events.map((e) => [e.t.num(), e.dur.num(), e.midi]);
const barsFull = (s) => s.parts.every((p) => p.measures.every((pm, mi) => {
  const byVoice = new Map();
  for (const n of pm.notes) if (!n.chord && !n.grace) byVoice.set(n.voice, (byVoice.get(n.voice) || []).concat(n.dur));
  return [...byVoice.values()].every((d) => qsum(d).eq(s.measures[mi].dur));
}));
const ids = (s, mi = 0) => s.parts[0].measures[mi].notes.map((n) => n.id);

test('editing notes keeps every bar full and the old score untouched', () => {
  const s0 = tune();
  const before = ev(s0);
  const [g, a, b] = ids(s0);
  // pitch: up a step follows the key (F is sharp in G), a semitone, an octave
  let s = movePitch(s0, ids(s0, 1)[0], 'up');           // D5 -> E5
  assert.equal(ev(s)[4][2], 76);
  s = movePitch(s0, ids(s0)[1], 'down');                // A4 -> G4
  s = movePitch(s, ids(s0)[2], 'sharp');                // B4 -> C5
  s = movePitch(s, g, 'octaveDown');
  assert.deepEqual(ev(s).slice(0, 3).map((x) => x[2]), [55, 67, 72]);
  const e4 = parseABC('X:1\nM:4/4\nL:1/4\nK:G\nE E E E|]');
  assert.deepEqual(findNote(movePitch(e4, ids(e4)[0], 'up'), ids(e4)[0]).note.pitch, { step: 'F', alter: 1, octave: 4 });
  // rest and back
  s = toRest(s0, a);
  assert.equal(ev(s).length, before.length - 1);
  s = toNote(s, a);
  assert.equal(findNote(s, a).note.pitch.step, 'G');    // takes the note before it
  // split and join
  s = splitNote(s0, b);
  assert.deepEqual(ev(s).filter((x) => x[0] >= 2 && x[0] < 3), [[2, 0.5, 71], [2.5, 0.5, 71]]);
  assert.ok(barsFull(s));
  s = joinNext(s0, g);                                  // G + A -> a half note G
  assert.deepEqual(ev(s)[0], [0, 2, 67]);
  assert.equal(findNote(s, g).note.type, 'half');
  assert.ok(barsFull(s));
  assert.equal(joinNext(s0, ids(s0)[3]), s0);           // nothing after the last note of the bar
  // chords
  const c = addChordNote(s0, g);
  assert.deepEqual(ev(c.score).filter((x) => x[0] === 0).map((x) => x[2]), [67, 71]);
  assert.equal(ev(toRest(c.score, g)).filter((x) => x[0] === 0).length, 1);     // taking one chord note out leaves the other
  assert.ok(barsFull(c.score));
  assert.deepEqual(ev(s0), before);                     // the original never changed
  // and it all survives being written and read again
  const again = parseMusicXML(writeMusicXML(c.score), { DOMParser, XMLSerializer });
  assert.deepEqual(ev(again), ev(c.score));
});

test('a few bars can be cut out to edit, with their key, time and clef', () => {
  const s = parseABC('X:1\nM:3/4\nL:1/4\nK:Bb\nB c d|e f g|a b c\'|d\'3|]');
  const cut = sliceMeasures(s, 2, 3);
  assert.equal(cut.measures.length, 2);
  assert.deepEqual(cut.parts[0].measures[0].key, { fifths: -2, mode: 'major' });
  assert.deepEqual([timeAt(cut, 0).beats, timeAt(cut, 0).beatType], [3, 4]);
  assert.equal(cut.parts[0].measures[0].clefs[0].sign, 'G');
  assert.ok(measureLength(timeAt(cut, 0)).eq(cut.measures[0].dur) && cut.measures[1].start.eq(3));
  const xml = writeMusicXML(cut);
  assert.equal(parseMusicXML(xml, { DOMParser, XMLSerializer }).measures.length, 2);
});

test('a part can be written for any instrument: clef, transposition, octave', () => {
  const s = tune();
  const sounding = ev(s).map((x) => x[2]);
  // B flat clarinet reads a tone higher; what sounds stays the same
  const cl = arrangeFor(s, 0, null, 'clarinet');
  assert.equal(cl.octaves, 0);
  assert.deepEqual(cl.score.parts[0].measures[0].key, { fifths: 3, mode: 'major' });      // G major is written in A
  assert.equal(cl.score.parts[0].measures[0].notes[0].pitch.step, 'A');
  assert.deepEqual(ev(cl.score).map((x) => x[2]), sounding);
  // alto sax in E flat: written a major sixth higher
  const sax = arrangeFor(s, 0, null, 'sax');
  assert.deepEqual(sax.score.parts[0].measures[0].key, { fifths: 4, mode: 'major' });     // E major
  assert.deepEqual(ev(sax.score).map((x) => x[2] % 12), sounding.map((m) => m % 12));
  // cello: bass clef, moved down so it sits in range
  const vc = arrangeFor(s, 0, null, 'cello');
  assert.equal(vc.score.parts[0].measures[0].clefs[0].sign, 'F');
  assert.equal(vc.octaves, 0);                           // G4..D5 is playable on a cello as it is
  const tuba = arrangeFor(s, 0, null, 'tuba');
  assert.ok(tuba.octaves < 0 && tuba.outOfRange === 0);
  assert.ok(ev(tuba.score).every((x) => x[2] >= 28 && x[2] <= 58));
  const again = parseMusicXML(writeMusicXML(cl.score), { DOMParser, XMLSerializer });
  assert.deepEqual(ev(again).map((x) => x[2]), sounding);
  // every instrument people can choose has a definition and a name
  for (const id of Object.keys(INSTRUMENT_DEFS)) assert.ok(INSTRUMENTS.includes(id), `${id} has a name`);
});
