// The studio (MuseScore 4 style): parts, key palette, dynamics and articulations, lead-sheet chords, the mix;
// everything survives a save (MusicXML out and back in).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { q, ZERO } from '../src/core/q.js';
import { blankScore, writeAt, setChordSymbol } from '../src/core/write.js';
import { writeMusicXML, parseMusicXML } from '../src/core/musicxml.js';
import { addPart, removePart, setPartInstrument, setKeySig, addDynamic, toggleArticulation, barChords, chordsForKey, audibleParts, mixEvents, stripOf } from '../src/core/studio.js';

globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const round = (sc) => parseMusicXML(writeMusicXML(sc));

test('add, change and remove instruments; the score stays valid', () => {
  let sc = blankScore({ instrument: 'violin', bars: 4, key: 2 });
  sc = addPart(sc, 'cello');
  sc = addPart(sc, 'piano');
  assert.deepEqual(sc.parts.map((p) => [p.instrument, p.staves]), [['violin', 1], ['cello', 1], ['piano', 2]]);
  const back = round(sc);
  assert.equal(back.parts.length, 3);
  assert.equal(back.parts[1].measures[0].clefs[0].sign, 'F');                  // a cello reads bass clef
  assert.equal(back.parts[1].measures[0].key.fifths, 2);                       // in the score's key
  assert.equal(back.parts[2].staves, 2);
  sc = setPartInstrument(sc, 1, 'viola');
  assert.equal(round(sc).parts[1].measures[0].clefs[0].sign, 'C');
  sc = removePart(removePart(removePart(sc, 2), 1), 0);
  assert.equal(sc.parts.length, 1);                                             // one part always stays
});

test('key palette, dynamics and articulations are written into the MusicXML', () => {
  let sc = blankScore({ instrument: 'flute', bars: 4 });
  sc = writeAt(sc, { pi: 0, staff: 1, mi: 0, off: ZERO }, { midi: 72, len: q(1) }).score;
  sc = setKeySig(sc, -3, 2);
  const id = sc.parts[0].measures[0].notes.find((n) => !n.rest).id;
  sc = toggleArticulation(addDynamic(sc, 0, 0, ZERO, 'mf'), id, 'staccato');
  const xml = writeMusicXML(sc);
  assert.match(xml, /<dynamics><mf\/><\/dynamics>/);
  assert.match(xml, /<staccato\/>/);
  const back = parseMusicXML(xml);
  assert.equal(back.parts[0].measures[2].key.fifths, -3);
  assert.equal(back.parts[0].measures[0].directions.filter((d) => d.dyn === 'mf').length, 1);
  // a second dynamic at the same place replaces the first; the articulation toggles off
  sc = toggleArticulation(addDynamic(sc, 0, 0, ZERO, 'pp'), id, 'staccato');
  assert.equal(sc.parts[0].measures[0].directions.filter((d) => d.dyn).map((d) => d.dyn).join(), 'pp');
  assert.doesNotMatch(writeMusicXML(sc), /staccato/);
});

test('lead sheet: a chord per bar, chords that fit the key', () => {
  let sc = blankScore({ instrument: 'voice', bars: 3, key: 1 });
  sc = setChordSymbol(sc, 0, 'G');
  sc = setChordSymbol(sc, 2, 'D7');
  assert.deepEqual(barChords(round(sc)), ['G', '', 'D7']);
  assert.ok(chordsForKey(1).includes('Em') && chordsForKey(-1).includes('Bb'));
});

test('the mix: solo wins, mute silences, volume and pan reach the notes', () => {
  let sc = blankScore({ instrument: 'violin', bars: 1 });
  sc = writeAt(sc, { pi: 0, staff: 1, mi: 0, off: ZERO }, { midi: 76, len: q(1) }).score;
  sc = addPart(sc, 'cello');
  sc = writeAt(sc, { pi: 1, staff: 1, mi: 0, off: ZERO }, { midi: 48, len: q(1) }).score;
  const [vn, vc] = sc.parts.map((p) => p.id);
  assert.deepEqual(audibleParts(sc, {}), [true, true]);
  assert.deepEqual(audibleParts(sc, { [vn]: { mute: true } }), [false, true]);
  assert.deepEqual(audibleParts(sc, { [vn]: { mute: true }, [vc]: { solo: true } }), [false, true]);
  assert.deepEqual(audibleParts(sc, { [vn]: { solo: true }, [vc]: { solo: false } }), [true, false]);
  const { evs } = mixEvents(sc, { [vn]: { vol: 1, pan: -0.5 }, [vc]: { vol: 0.2, sound: 'piano' } });
  const hi = evs.find((e) => e.midi === 76), lo = evs.find((e) => e.midi === 48);
  assert.ok(hi.vel > lo.vel && hi.pan === -0.5 && lo.inst === 'piano' && hi.inst === 'strings');
  assert.equal(mixEvents(sc, { [vc]: { mute: true } }).evs.filter((e) => e.midi === 48).length, 0);
  assert.equal(stripOf({}, sc.parts[0]).vol, 0.8);
});
