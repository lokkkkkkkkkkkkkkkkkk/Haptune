// Importing band scores and lead sheets: several instruments, a drum kit (MIDI channel 10 and MusicXML
// percussion parts written with pitches), chord symbols, TAB staves and rhythm slashes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { readMIDI } from '../src/core/midi.js';
import { parseMusicXML, writeMusicXML } from '../src/core/musicxml.js';
import { performance } from '../src/core/score.js';
import { drumOf } from '../src/core/drums.js';

globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;

// a tiny Standard MIDI File writer for tests: tracks of [tick, bytes]
const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
function smf(tracks, ppq = 480) {
  const chunk = (type, data) => [...type].map((c) => c.charCodeAt(0)).concat([(data.length >>> 24) & 255, (data.length >>> 16) & 255, (data.length >>> 8) & 255, data.length & 255], data);
  const out = chunk('MThd', [0, 1, 0, tracks.length, (ppq >> 8) & 255, ppq & 255]);
  for (const evs of tracks) {
    evs.sort((a, b) => a[0] - b[0]);
    let last = 0; const data = [];
    for (const [t, bytes] of evs) { data.push(...vlq(t - last), ...bytes); last = t; }
    data.push(0, 0xff, 0x2f, 0);
    out.push(...chunk('MTrk', data));
  }
  return new Uint8Array(out);
}
const name = (s) => [0xff, 0x03, s.length, ...[...s].map((c) => c.charCodeAt(0))];
const noteOn = (ch, n, v = 96) => [0x90 | ch, n, v];
const noteOff = (ch, n) => [0x80 | ch, n, 0];

test('a band MIDI file: melody, bass and drums become three parts, drums on a percussion staff', () => {
  const Q = 480;
  const melody = [[0, name('Lead Vocal')]], bass = [[0, name('Bass')], [0, [0xc1, 33]]], drums = [[0, name('Drum Kit')]];
  [67, 69, 71, 72, 74, 72, 71, 69].forEach((m, i) => { melody.push([i * Q, noteOn(0, m)], [(i + 1) * Q - 10, noteOff(0, m)]); });
  [43, 43, 47, 47].forEach((m, i) => { bass.push([i * 2 * Q, noteOn(1, m)], [(i + 1) * 2 * Q - 10, noteOff(1, m)]); });
  for (let i = 0; i < 16; i++) {
    const t = i * Q / 2;
    drums.push([t, noteOn(9, 42)], [t + 60, noteOff(9, 42)]);
    if (i % 4 === 0) drums.push([t, noteOn(9, 36)], [t + 60, noteOff(9, 36)]);
    if (i % 4 === 2) drums.push([t, noteOn(9, 38)], [t + 60, noteOff(9, 38)]);
  }
  const { score, report } = readMIDI(smf([melody, bass, drums]));
  assert.equal(score.parts.length, 3);
  const [mel, bs, dr] = score.parts;
  assert.equal(mel.instrument, 'voice', 'track names choose the instrument when there is no program');
  assert.equal(bs.instrument, 'bassguitar');
  assert.equal(dr.instrument, 'drums');
  assert.ok(dr.percussion);
  assert.equal(dr.measures[0].clefs[0].sign, 'percussion');
  const hits = dr.measures[0].notes.filter((n) => !n.rest);
  assert.ok(hits.every((n) => n.unpitched && !n.pitch));
  assert.ok(hits.some((n) => /x/.test(n.noteheadXml || '')), 'hi-hats have x noteheads');
  assert.equal(report.drumNotes, 24);
  const kinds = performance(score).events.filter((e) => e.drum).map((e) => e.drum);
  assert.equal(kinds.filter((k) => k === 'hat').length, 16);
  assert.equal(kinds.filter((k) => k === 'kick').length, 4);
  assert.equal(kinds.filter((k) => k === 'snare').length, 4);
  // and it survives saving as MusicXML
  const back = parseMusicXML(writeMusicXML(score));
  assert.equal(back.parts[2].instrument, 'drums');
  assert.equal(performance(back).events.filter((e) => e.drum === 'kick').length, 4);
});

test('a drums-only MIDI file opens (it used to be refused)', () => {
  const drums = [[0, name('Drums')]];
  for (let i = 0; i < 8; i++) drums.push([i * 240, noteOn(9, i % 2 ? 38 : 36)], [i * 240 + 50, noteOff(9, i % 2 ? 38 : 36)]);
  const { score } = readMIDI(smf([drums]));
  assert.equal(score.parts.length, 1);
  assert.equal(score.parts[0].instrument, 'drums');
});

const xmlHead = (parts) => `<?xml version="1.0"?><score-partwise version="4.0"><part-list>${parts}</part-list>`;
test('MusicXML drum parts written with pitches (MuseScore, the AI reader) play the right drums', () => {
  const xml = xmlHead(`<score-part id="P1"><part-name>Drumset</part-name><score-instrument id="P1-I36"><instrument-name>Bass Drum</instrument-name></score-instrument><score-instrument id="P1-I43"><instrument-name>Hi-Hat</instrument-name></score-instrument>
    <midi-instrument id="P1-I36"><midi-channel>10</midi-channel><midi-unpitched>37</midi-unpitched></midi-instrument><midi-instrument id="P1-I43"><midi-channel>10</midi-channel><midi-unpitched>43</midi-unpitched></midi-instrument></score-part>`)
    + `<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>percussion</sign></clef></attributes>
      <note><unpitched><display-step>F</display-step><display-octave>4</display-octave></unpitched><duration>1</duration><instrument id="P1-I36"/><voice>1</voice><type>quarter</type></note>
      <note><chord/><unpitched><display-step>G</display-step><display-octave>5</display-octave></unpitched><duration>1</duration><instrument id="P1-I43"/><voice>1</voice><type>quarter</type><notehead>x</notehead></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
    </measure></part></score-partwise>`;
  const sc = parseMusicXML(xml);
  assert.equal(sc.parts[0].instrument, 'drums');
  const notes = sc.parts[0].measures[0].notes;
  assert.deepEqual(notes.map(drumOf), ['kick', 'hat', 'snare']);
  assert.ok(notes.every((n) => !n.pitch), 'a pitch on a drum staff becomes a drum');
});

test('a lead sheet band score: chords stay on the melody, slashes are silent, TAB shows as guitar notation', () => {
  const xml = xmlHead('<score-part id="P1"><part-name>Voice</part-name></score-part><score-part id="P2"><part-name>Guitar</part-name></score-part><score-part id="P3"><part-name>Guitar TAB</part-name></score-part>')
    + `<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <harmony><root><root-step>C</root-step></root><kind>major</kind></harmony><note><pitch><step>E</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
      <harmony><root><root-step>G</root-step></root><kind>dominant</kind></harmony><note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note></measure></part>
    <part id="P2"><measure number="1"><attributes><divisions>1</divisions><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><notehead>slash</notehead></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><notehead>slash</notehead></note></measure></part>
    <part id="P3"><measure number="1"><attributes><divisions>1</divisions><clef><sign>TAB</sign><line>5</line></clef><staff-details><staff-lines>6</staff-lines></staff-details></attributes>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>half</type><notations><technical><string>1</string><fret>0</fret></technical></notations></note></measure></part></score-partwise>`;
  const sc = parseMusicXML(xml);
  assert.equal(sc.parts.length, 3);
  assert.equal(sc.parts[0].measures[0].harmonies.length, 2);
  const ev = performance(sc).events;
  assert.equal(ev.filter((e) => e.pi === 1).length, 0, 'slash noteheads do not play');
  assert.equal(ev.filter((e) => e.pi === 2).length, 1);
  assert.equal(sc.parts[2].measures[0].clefs[0].sign, 'G');
  assert.equal(sc.parts[2].measures[0].clefs[0].oct, -1);
});
