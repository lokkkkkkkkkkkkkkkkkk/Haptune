import test from 'node:test';
import assert from 'node:assert/strict';
import * as CB from '../src/core/chordbars.js';
import { comp, patternFor, voicing, bassNote, swingTime, RHYTHM_IDS } from '../src/core/rhythm.js';
import { parseChordSheet } from '../src/core/chordsheet.js';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
const DOM = { DOMParser, XMLSerializer };

const AMAZING = '{title: Amazing Grace}\n{key: G}\n{time: 3/4}\nA[G]mazing [G7]grace, how [C]sweet the [G]sound\nThat saved a wretch like [D]me';
const names = (bar) => bar.chords.map((c) => `${c.beat}:${c.name}`).join(' ');

test('a chord sheet becomes bars: each chord starts a bar, lyrics stay with their chord', () => {
  const song = CB.songFromSheet(parseChordSheet(AMAZING));
  assert.equal(song.title, 'Amazing Grace');
  assert.deepEqual(song.time, { beats: 3, beatType: 4 });
  assert.equal(song.style, 'waltz');
  const bars = song.sections[0].bars;
  assert.deepEqual(bars.map((b) => b.chords[0]?.name), ['G', 'G7', 'C', 'G', 'D']);
  assert.equal(bars[0].lyrics, 'A mazing'.replace(' ', ''));    // "A" before the first chord joins its bar
  assert.equal(bars[3].lyrics, 'sound That saved a wretch like');
  assert.equal(bars[4].lyrics, 'me');
});

test('plain lyrics get bars by length and suggested chords that can be edited', () => {
  const song = CB.songFromText('Verse 1\nAmazing grace how sweet the sound that saved a wretch like me\nI once was lost but now am found');
  const bars = song.sections[0].bars;
  assert.ok(bars.length >= 3 && bars.length <= 8, `bars: ${bars.length}`);
  assert.ok(bars.every((b) => b.chords.length === 1 && b.chords[0].auto));
  assert.equal(bars[0].chords[0].name, 'C');          // no key given: C major, verse starts on I
  const edited = CB.setChord(song, { s: 0, b: 0, beat: 0 }, 'Am7');
  assert.equal(edited.sections[0].bars[0].chords[0].name, 'Am7');
  assert.equal(song.sections[0].bars[0].chords[0].name, 'C', 'the original is not changed');
});

test('setChord validates names, places chords on beats and removes them', () => {
  let s = CB.newSong({ bars: 2 });
  s = CB.setChord(s, { s: 0, b: 0, beat: 2 }, 'D');
  s = CB.setChord(s, { s: 0, b: 0, beat: 0 }, 'G');
  assert.equal(names(s.sections[0].bars[0]), '0:G 2:D');
  s = CB.setChord(s, { s: 0, b: 0, beat: 9 }, 'C/E');           // past the last beat: lands on beat 3
  assert.equal(names(s.sections[0].bars[0]), '0:G 2:D 3:C/E');
  assert.throws(() => CB.setChord(s, { s: 0, b: 0, beat: 1 }, 'Hello'), /not a chord/);
  s = CB.setChord(s, { s: 0, b: 0, beat: 2 }, null);
  assert.equal(names(s.sections[0].bars[0]), '0:G 3:C/E');
  assert.equal(CB.chordName('bb'), null);
  assert.equal(CB.chordName('Bbsus4'), 'Bbsus4');
});

test('moving a chord to another beat and another bar', () => {
  let s = CB.setChord(CB.newSong({ bars: 2 }), { s: 0, b: 0, beat: 0 }, 'G');
  s = CB.setChord(s, { s: 0, b: 0, beat: 2 }, 'C');
  s = CB.moveChord(s, { s: 0, b: 0, beat: 2 }, { s: 0, b: 0, beat: 3 });
  assert.equal(names(s.sections[0].bars[0]), '0:G 3:C');
  s = CB.moveChord(s, { s: 0, b: 0, beat: 3 }, { s: 0, b: 1, beat: 0 });
  assert.equal(names(s.sections[0].bars[0]), '0:G');
  assert.equal(names(s.sections[0].bars[1]), '0:C');
  assert.equal(CB.moveChord(s, { s: 0, b: 0, beat: 1 }, { s: 0, b: 1, beat: 1 }), s, 'nothing to move: same song');
});

test('split and merge bars keep every chord and the lyrics', () => {
  let s = CB.newSong({ bars: 1 });
  s = CB.setChord(CB.setChord(s, { s: 0, b: 0, beat: 0 }, 'G'), { s: 0, b: 0, beat: 2 }, 'D');
  s = CB.setLyrics(s, 0, 0, 'one two three four');
  const split = CB.splitBar(s, 0, 0, 2);
  assert.equal(split.sections[0].bars.length, 2);
  assert.equal(names(split.sections[0].bars[0]), '0:G');
  assert.equal(names(split.sections[0].bars[1]), '0:D');
  assert.deepEqual(split.sections[0].bars.map((b) => b.lyrics), ['one two', 'three four']);
  const merged = CB.mergeBars(split, 0, 0);
  assert.equal(merged.sections[0].bars.length, 1);
  assert.equal(names(merged.sections[0].bars[0]), '0:G 2:D');
  assert.equal(merged.sections[0].bars[0].lyrics, 'one two three four');
  assert.equal(CB.mergeBars(merged, 0, 0), merged, 'the last bar has nothing to merge with');
});

test('beats per bar can change per section; chords past the end move onto the last beat', () => {
  let s = CB.addSection(CB.newSong({ bars: 1 }), 'bridge', { bars: 1 });
  s = CB.setChord(s, { s: 1, b: 0, beat: 3 }, 'Em');
  s = CB.setSectionTime(s, 1, 3, 4);
  assert.deepEqual(s.sections[1].time, { beats: 3, beatType: 4 });
  assert.equal(CB.beatsOf(s, 1), 3);
  assert.equal(CB.beatsOf(s, 0), 4);
  assert.equal(names(s.sections[1].bars[0]), '2:Em');
  assert.equal(CB.setSectionTime(s, 1, 4, 4).sections[1].time, null, 'back to the song time');
  const lay = CB.barLayout(s);
  assert.deepEqual(lay.map((b) => [b.t, b.len]), [[0, 4], [4, 3]]);
});

test('transposition round trip and key changes re-spell every chord', () => {
  const song = CB.songFromSheet(parseChordSheet(AMAZING));
  const up = CB.transposeSong(song, 3);
  assert.equal(up.key.fifths, -2);                    // G -> Bb
  assert.deepEqual(up.sections[0].bars.map((b) => b.chords[0].name), ['Bb', 'Bb7', 'Eb', 'Bb', 'F']);
  assert.deepEqual(CB.transposeSong(up, -3), song);
  const d = CB.setSongKey(song, { fifths: 2, mode: 'major' });
  assert.deepEqual(d.sections[0].bars.map((b) => b.chords[0].name), ['D', 'D7', 'G', 'D', 'A']);
  const rel = CB.setSongKey(song, { fifths: 1, mode: 'minor' });
  assert.deepEqual(rel.sections[0].bars.map((b) => b.chords[0].name), ['G', 'G7', 'C', 'G', 'D'], 'relative minor: same chords');
  assert.equal(rel.key.mode, 'minor');
});

test('suggestions give 2-3 diatonic alternatives with Roman numerals, not the chord already there', () => {
  let s = CB.newSong({ key: { fifths: 1, mode: 'major' }, bars: 3 });
  s = CB.setChord(CB.setChord(s, { s: 0, b: 0, beat: 0 }, 'G'), { s: 0, b: 1, beat: 0 }, 'C');
  const sug = CB.suggestionsFor(s, 0, 1);
  assert.ok(sug.length >= 2 && sug.length <= 3);
  assert.ok(!sug.some((x) => x.name === 'C'));
  assert.ok(sug.every((x) => x.roman));
  assert.equal(CB.roman('D7', s.key), 'V7');
  const pal = CB.chordPalette({ fifths: 0, mode: 'major' });
  assert.deepEqual(pal.diatonic, ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim']);
  assert.ok(pal.borrowed.includes('Bb') && pal.borrowed.includes('Fm'));
  assert.ok(pal.slash.includes('C/E'));
  assert.ok(pal.colour.includes('Csus4'));
});

test('sections: add, duplicate, move, delete', () => {
  let s = CB.newSong({ bars: 2 });
  s = CB.addSection(s, 'chorus');
  assert.equal(s.sections[1].label, 'Chorus');
  s = CB.duplicateSection(s, 1);
  assert.equal(s.sections.length, 3);
  assert.notEqual(s.sections[1].id, s.sections[2].id);
  s = CB.moveSection(s, 0, 1);
  assert.equal(s.sections[0].kind, 'chorus');
  s = CB.deleteSection(CB.deleteSection(CB.deleteSection(s, 0), 0), 0);
  assert.equal(s.sections.length, 1, 'the last section stays');
});

test('undo and redo', () => {
  let h = CB.history.start(CB.newSong());
  const a = CB.setChord(h.now, { s: 0, b: 0, beat: 0 }, 'G');
  h = CB.history.push(h, a);
  h = CB.history.push(h, CB.setChord(h.now, { s: 0, b: 1, beat: 0 }, 'C'));
  h = CB.history.undo(h);
  assert.equal(h.now, a);
  h = CB.history.redo(h);
  assert.equal(h.now.sections[0].bars[1].chords[0].name, 'C');
  assert.equal(CB.history.undo(CB.history.undo(CB.history.undo(h))).past.length, 0);
});

test('exports: ChordPro, chords over lyrics, a bar grid and MusicXML with chords and lyrics', () => {
  const song = CB.songFromSheet(parseChordSheet(AMAZING));
  const cp = CB.songToChordPro(song);
  assert.match(cp, /\{title: Amazing Grace\}/);
  assert.match(cp, /\[G\]Amazing \[G7\]grace/);
  const back = CB.songFromSheet(parseChordSheet(cp));
  assert.deepEqual(back.sections[0].bars.map((b) => b.chords[0]?.name), ['G', 'G7', 'C', 'G', 'D'], 'ChordPro round trip');
  assert.match(CB.songToChordsOverLyrics(song), /G\s+G7\s+C/);
  assert.match(CB.songToGrid(song), /\| G \. \. \| G7 \. \. \|/);
  const score = CB.songToScore(song, DOM);
  assert.equal(score.measures.length, 5);
  assert.equal(score.parts[0].measures[0].harmonies[0].chord.root.step, 'G');
  const notes = score.parts[0].measures[0].notes.filter((n) => !n.rest);
  assert.equal(notes.length, 3, 'a G triad');
  assert.ok(notes[0].lyrics.length, 'the bar\'s lyrics are on its first note');
  assert.match(CB.songToMusicXML(song), /<time><beats>3<\/beats>/);
});

test('a chord held over the bar line is carried into the next bar\'s notes', () => {
  let s = CB.setChord(CB.newSong({ bars: 2 }), { s: 0, b: 0, beat: 0 }, 'F');
  const score = CB.songToScore(s, DOM);
  assert.equal(score.parts[0].measures[1].harmonies.length, 0);
  assert.ok(score.parts[0].measures[1].notes.some((n) => !n.rest), 'F still sounds in bar 2');
});

test('rhythm patterns: every style fits its metre and plays the chord\'s notes', () => {
  for (const id of RHYTHM_IDS) {
    for (const [b, bt] of [[4, 4], [3, 4], [6, 8], [5, 4]]) {
      const p = patternFor(id, b, bt);
      assert.equal(p.comp.length, bt === 8 ? b : b * 2, `${id} ${b}/${bt}`);
    }
  }
  assert.deepEqual(voicing('C'), [52, 55, 60]);
  assert.deepEqual(voicing('C', { voices: 4, low: 55 }), [55, 60, 64, 67]);
  assert.equal(bassNote('G/B'), 47);
  const song = CB.setChord(CB.newSong({ bars: 1 }), { s: 0, b: 0, beat: 0 }, 'C');
  const hymn = CB.songAccompaniment({ ...song, style: 'hymn' }).events;
  assert.equal(hymn.filter((e) => e.inst === 'keys').length, 16, 'four voices on each of four beats');
  const pop = CB.songAccompaniment({ ...song, style: 'pop' });
  assert.ok(pop.events.some((e) => e.inst === 'drums') && pop.events.some((e) => e.inst === 'bass'));
  assert.equal(pop.length, 4);
  assert.ok(pop.events.every((e) => e.t >= 0 && e.t < 4));
  const waltz = CB.songAccompaniment({ ...CB.setSongTime(song, 3, 4), style: 'waltz' });
  assert.equal(waltz.length, 3);
  assert.deepEqual(comp([], [{ t: 0, len: 4, beats: 4, beatType: 4 }]), []);
  assert.equal(swingTime(0.5, 0.66), 0.66);
  assert.equal(swingTime(1, 0.66), 1);
});
