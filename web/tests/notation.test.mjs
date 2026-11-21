// Part 8: the studio's notation marks, bar tools, triplets, drums, chord boxes and auto fingering. Every mark
// must survive saving (MusicXML out) and opening again (MusicXML in).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { q, ZERO } from '../src/core/q.js';
import { blankScore, writeAt } from '../src/core/write.js';
import { writeMusicXML, parseMusicXML } from '../src/core/musicxml.js';
import { performance } from '../src/core/score.js';
import {
  MARKS, toggleMark, hasMark, toggleLink, toggleTie, setFingering, fingeringOf, putDynamic, toggleText, putTempo, putSpan, toggleJump, putRehearsal,
  setBarline, toggleEnding, insertBar, deleteBar, clearBar, copyBar, pasteBar, setTimeFrom, setClef, autoFingering, setLyric, lyricOf, fillGroove, GROOVES,
  drumFields, writeDrum, drumOf, withFrame, naturalize,
} from '../src/core/notation.js';
import { diagramFor, chordChoices, TUNINGS } from '../src/core/fretboard.js';
import { chordPcs, parseChord } from '../src/core/chords.js';
import { setChordSymbol } from '../src/core/write.js';

globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;
const roundTrip = (sc) => parseMusicXML(writeMusicXML(sc));
const melody = (inst = 'violin', notes = [60, 64, 67, 69, 72, 69, 67, 64]) => {
  let sc = blankScore({ instrument: inst, bars: 2 });
  let cur = { pi: 0, staff: 1, mi: 0, off: ZERO };
  for (const m of notes) { const r = writeAt(sc, cur, { midi: m, len: q(1) }); sc = r.score; cur = r.cur; }
  return sc;
};
const notesOf = (sc, mi = 0) => sc.parts[0].measures[mi].notes.filter((n) => !n.rest && !n.chord);

test('every note mark goes on, survives saving and opening, and comes off again', () => {
  const sc = melody();
  const id = notesOf(sc)[1].id;
  for (const k of Object.keys(MARKS)) {
    const on = toggleMark(sc, id, k);
    assert.ok(hasMark(notesOf(on)[1], k), `${k} on`);
    const xml = writeMusicXML(on);
    assert.ok(!/<notations><notations>/.test(xml), 'no nested notations');
    assert.ok(hasMark(notesOf(parseMusicXML(xml))[1], k), `${k} after saving`);
    assert.ok(!hasMark(notesOf(toggleMark(on, id, k))[1], k), `${k} off`);
  }
});

test('marks that exclude each other replace each other', () => {
  const sc = melody();
  const id = notesOf(sc)[0].id;
  const a = toggleMark(toggleMark(sc, id, 'upBow'), id, 'downBow');
  assert.ok(hasMark(notesOf(a)[0], 'downBow') && !hasMark(notesOf(a)[0], 'upBow'));
  const b = toggleMark(toggleMark(sc, id, 'trem1'), id, 'trem3');
  assert.ok(hasMark(notesOf(b)[0], 'trem3') && !hasMark(notesOf(b)[0], 'trem1'));
});

test('slurs, glissandos and hammer-ons join a note to the next one; ties need the same pitch', () => {
  const sc = melody();
  const [a, b] = notesOf(sc);
  const s = toggleLink(sc, a.id, 'slur');
  assert.match(notesOf(s)[0].notationsXml, /<slur type="start"/);
  assert.match(notesOf(s)[1].notationsXml, /<slur type="stop"/);
  assert.doesNotMatch(notesOf(toggleLink(s, a.id, 'slur'))[1].notationsXml, /<slur/);
  const h = toggleLink(sc, a.id, 'hammer');
  assert.match(notesOf(h)[0].notationsXml, /<hammer-on type="start">H<\/hammer-on>/);
  assert.match(notesOf(h)[0].notationsXml, /<slur type="start"/, 'a hammer-on is drawn with a slur');
  assert.equal(toggleTie(sc, a.id), sc, 'C to E cannot be tied');
  const same = melody('violin', [60, 60, 62, 64]);
  const tied = toggleTie(same, notesOf(same)[0].id);
  assert.ok(notesOf(tied)[0].tie.start && notesOf(tied)[1].tie.stop);
  assert.equal(performance(tied).events.length, 3, 'a tied note plays once');
  void b;
});

test('fingering, naturals and lyrics', () => {
  const sc = melody();
  const id = notesOf(sc)[0].id;
  const f = setFingering(sc, id, 3);
  assert.equal(fingeringOf(notesOf(roundTrip(f))[0]), '3');
  assert.equal(fingeringOf(notesOf(setFingering(f, id, ''))[0]), '');
  const sharp = melody('violin', [61]);
  assert.equal(notesOf(naturalize(sharp, notesOf(sharp)[0].id))[0].pitch.alter, 0);
  const l = setLyric(setLyric(sc, notesOf(sc)[0].id, 'Hap-'), notesOf(sc)[1].id, '-py');
  const back = roundTrip(l);
  assert.equal(lyricOf(notesOf(back)[0]), 'Hap-');
  assert.equal(lyricOf(notesOf(back)[1]), '-py');
});

test('dynamics, text, tempo marks, lines and jumps are written where they belong', () => {
  let sc = melody();
  sc = putDynamic(sc, 0, 0, ZERO, 1, 'sfz');
  sc = putDynamic(sc, 0, 0, ZERO, 1, 'p');
  assert.equal(sc.parts[0].measures[0].directions.filter((d) => d.dyn).length, 1, 'one dynamic per place');
  sc = toggleText(sc, 0, 0, q(1), 1, 'pizz.', 'technique');
  sc = putTempo(sc, 1, 'Allegro', 126);
  assert.equal(sc.measures[1].tempo, 126);
  sc = putSpan(sc, 0, 0, ZERO, 1, 'cresc', 2);
  sc = putSpan(sc, 0, 0, ZERO, 1, 'pedal', 1);
  sc = putRehearsal(sc, 1);
  sc = toggleJump(sc, 1, 'dcFine');
  const xml = writeMusicXML(sc);
  for (const s of ['<p/>', 'pizz.', 'Allegro', '<per-minute>126', '<wedge type="crescendo"/>', '<wedge type="stop"/>', '<pedal type="start"', '<rehearsal>A</rehearsal>', 'D.C. al Fine', 'dacapo="yes"']) assert.ok(xml.includes(s), s);
  assert.ok(!xml.includes('<sfz/>'));
  const back = parseMusicXML(xml);
  assert.ok(back.measures[1].jumps.dacapo, 'D.C. is followed when it plays');
  assert.ok(!toggleText(sc, 0, 0, q(1), 1, 'pizz.').parts[0].measures[0].directions.some((d) => d.text === 'pizz.'), 'the same text again removes it');
});

test('bars: barlines, repeats, endings, insert, delete, clear, copy and paste', () => {
  let sc = melody();
  sc = setBarline(sc, 0, 'repeatStart');
  sc = setBarline(sc, 1, 'repeatEnd');
  sc = toggleEnding(sc, 1, 1);
  let xml = writeMusicXML(sc);
  assert.ok(xml.includes('<repeat direction="forward"/>') && xml.includes('<repeat direction="backward"/>') && xml.includes('<ending number="1"'));
  const n = sc.measures.length;
  const ins = insertBar(sc, 1);
  assert.equal(ins.measures.length, n + 1);
  assert.deepEqual(ins.measures.map((m) => m.number), ins.measures.map((_, i) => String(i + 1)));
  assert.ok(ins.parts[0].measures[1].notes.every((x) => x.rest));
  const first = insertBar(sc, 0);
  assert.equal(first.parts[0].measures[0].key?.fifths, 0, 'the key moves to the new first bar');
  assert.ok(first.measures[0].time, 'the time signature too');
  assert.equal(deleteBar(ins, 1).measures.length, n);
  assert.ok(clearBar(sc, 0, 0).parts[0].measures[0].notes.every((x) => x.rest));
  const clip = copyBar(sc, 0, 0);
  const pasted = pasteBar(sc, 0, 1, clip);
  assert.deepEqual(notesOf(pasted, 1).map((x) => x.pitch.step), notesOf(sc, 0).map((x) => x.pitch.step));
  assert.notEqual(notesOf(pasted, 1)[0].id, notesOf(sc, 0)[0].id, 'pasted notes get new ids');
  xml = writeMusicXML(setClef(sc, 0, 1, 1, 'bass'));
  assert.ok(xml.includes('<sign>F</sign>'));
});

test('a new time signature only goes on empty bars', () => {
  const sc = melody('violin', [60, 62, 64, 65]);
  assert.equal(setTimeFrom(sc, 0, [3, 4]), null);
  const t = setTimeFrom(sc, 1, [3, 4]);
  assert.ok(t.measures[1].dur.eq(q(3)) && t.measures[1].time.beats === 3);
  const back = roundTrip(t);
  assert.ok(back.measures[1].dur.eq(q(3)));
});

test('triplets: three notes in the time of two, the bar stays full', () => {
  let sc = blankScore({ instrument: 'flute', bars: 1 });
  let cur = { pi: 0, staff: 1, mi: 0, off: ZERO };
  for (const m of [72, 74, 76]) { const r = writeAt(sc, cur, { midi: m, len: q(1, 2), tuplet: true }); sc = r.score; cur = r.cur; }
  const notes = sc.parts[0].measures[0].notes.filter((x) => !x.chord);
  const trip = notes.filter((x) => x.tm);
  assert.equal(trip.length, 3);
  assert.ok(trip.every((x) => x.dur.eq(q(1, 3)) && x.type === 'eighth'));
  assert.ok(trip[0].tuplet.start && trip[2].tuplet.stop);
  assert.ok(notes.reduce((a, x) => a.add(x.dur), ZERO).eq(q(4)), 'the bar is exactly full');
  assert.ok(cur.off.eq(q(1)));
  const xml = writeMusicXML(sc);
  assert.ok(xml.includes('<actual-notes>3</actual-notes>') && xml.includes('<tuplet type="start"'));
  // one triplet note alone: the rest of its group is triplet rests
  const one = writeAt(blankScore({ instrument: 'flute', bars: 1 }), { pi: 0, staff: 1, mi: 0, off: ZERO }, { midi: 72, len: q(1, 2), tuplet: true }).score;
  const g = one.parts[0].measures[0].notes.filter((x) => x.tm);
  assert.equal(g.length, 3);
  assert.equal(g.filter((x) => x.rest).length, 2);
});

test('drums: kit notes, hits together, grooves, and the right sound for each', () => {
  let sc = blankScore({ instrument: 'drums', bars: 2 });
  assert.ok(sc.parts[0].percussion);
  assert.ok(writeMusicXML(sc).includes('<sign>percussion</sign>'));
  let r = writeAt(sc, { pi: 0, staff: 1, mi: 0, off: ZERO }, { midi: null, len: q(1), drum: drumFields('kick') });
  r = writeDrum(r.score, r.cur, 'hihat', q(1), true);
  const first = r.score.parts[0].measures[0].notes.filter((x) => x.off.isZero() && !x.rest);
  assert.deepEqual(first.map(drumOf).sort(), ['hat', 'kick']);
  for (const g of Object.keys(GROOVES)) {
    const f = fillGroove(sc, 0, 1, g);
    const heads = f.parts[0].measures[1].notes.filter((x) => !x.chord);
    assert.ok(heads.reduce((a, x) => a.add(x.dur), ZERO).eq(q(4)), `${g} fills the bar`);
  }
  const rock = roundTrip(fillGroove(sc, 0, 0, 'rock'));
  const drums = performance(rock).events.map((e) => e.drum);
  assert.ok(drums.includes('kick') && drums.includes('snare') && drums.includes('hat'), 'the groove plays kick, snare and hi-hat after saving');
});

test('chord boxes: every string that sounds plays a chord note, for guitar and ukulele', () => {
  const names = ['C', 'G', 'D', 'A', 'E', 'Am', 'Em', 'Dm', 'F', 'Bm', 'Bb', 'F#m', 'C#m', 'Ab', 'Eb', 'G7', 'Cmaj7', 'Fmaj7', 'Asus4', 'Gm', 'Cm', 'B7', 'F#7', 'Abm7', 'Dsus2'];
  for (const set of ['guitar', 'ukulele']) {
    for (const nm of names) {
      const d = diagramFor(nm, set);
      if (!d) { assert.equal(set, 'ukulele', `${nm} on guitar`); continue; }
      const pcs = new Set(chordPcs(parseChord(nm)));
      d.frets.forEach((f, i) => { if (f >= 0) assert.ok(pcs.has((TUNINGS[set].midi[i] + f) % 12), `${nm} ${set} string ${i}`); });
      assert.equal(d.strings, TUNINGS[set].midi.length);
    }
  }
  assert.deepEqual(diagramFor('C').frets, [-1, 3, 2, 0, 1, 0], 'open C');
  assert.ok(diagramFor('F').barre, 'F is a barre chord');
  assert.ok(chordChoices(0).includes('Am'));
  // a chord with its box is saved as <frame> and read back
  let sc = melody('guitar');
  sc = withFrame(setChordSymbol(sc, 0, 'Am', ZERO), 0, ZERO, diagramFor('Am'));
  const xml = writeMusicXML(sc);
  assert.ok(xml.includes('<frame><frame-strings>6</frame-strings>'));
  assert.deepEqual(parseMusicXML(xml).parts[0].measures[0].harmonies[0].frame.frets, [-1, 0, 2, 2, 1, 0]);
});

test('auto fingering: violin in first position, piano by hand position', () => {
  const v = autoFingering(melody('violin', [55, 57, 59, 60, 62, 64, 66, 67]), 0);
  assert.equal(v.count, 8);
  const f = (sc, mi) => notesOf(sc, mi).map(fingeringOf).join('');
  assert.equal(f(v.score, 0) + f(v.score, 1), '01230123', 'G major scale: G string then D string');
  const p = autoFingering(melody('piano', [60, 62, 64, 65, 67, 69, 71, 72]), 0);
  const pf = (f(p.score, 0) + f(p.score, 1)).split('').map(Number);
  assert.ok(pf.every((x) => x >= 1 && x <= 5));
  assert.equal(pf[0], 1, 'the right hand starts on the thumb');
  assert.equal(autoFingering(melody('flute'), 0).count, 0, 'no fingering for a flute');
});
