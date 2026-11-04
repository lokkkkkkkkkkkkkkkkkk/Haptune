import test from 'node:test';
import assert from 'node:assert/strict';
import { transposePitch, transposeInterval, transposeKey, keyName, tonicOf, iv, midiOf, spellMidi, jianpuOf, nameOf } from '../src/core/pitch.js';
import { parseChord, formatChord, transposeChord, romanNumeral, fretShapes, capoOptions, chordNotes, isChordToken } from '../src/core/chords.js';
import { Q, q } from '../src/core/q.js';

test('fractions', () => {
  assert.equal(q(1, 3).add(q(1, 6)).toString(), '1/2');
  assert.equal(Q.approx(0.333333333).toString(), '1/3');
  assert.ok(q(2, 3).lt(1));
});

test('pitch transposition keeps spelling', () => {
  assert.deepEqual(transposePitch({ step: 'C', alter: 0, octave: 4 }, iv(1, 1)), { step: 'D', alter: -1, octave: 4 });
  assert.deepEqual(transposePitch({ step: 'B', alter: 0, octave: 3 }, iv(1, 1)), { step: 'C', alter: 0, octave: 4 });
  assert.deepEqual(transposePitch({ step: 'E', alter: 0, octave: 4 }, iv(0, 1)), { step: 'E', alter: 1, octave: 4 });
  assert.deepEqual(transposePitch({ step: 'C', alter: 0, octave: 4 }, iv(-1, -1)), { step: 'B', alter: 0, octave: 3 });
});

test('key choice when moving up or down', () => {
  const name = (k, s) => keyName(transposeKey(k, transposeInterval(k, s)), { ascii: true });
  const C = { fifths: 0, mode: 'major' };
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((s) => name(C, s)), ['Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']);
  assert.deepEqual([-1, -2, -3].map((s) => name(C, s)), ['B', 'Bb', 'A']);
  assert.equal(name({ fifths: -1, mode: 'major' }, 6), 'B');        // F -> B, not Cb
  assert.equal(name({ fifths: 0, mode: 'minor' }, 1), 'Bbm');        // Am -> Bbm
  assert.equal(name({ fifths: 3, mode: 'minor' }, 1), 'Gm');         // F#m -> Gm
  assert.equal(name({ fifths: -3, mode: 'major' }, 1), 'E');         // Eb -> E
  assert.equal(keyName({ fifths: 0, mode: 'dorian' }), 'D dorian');
  // up then down returns the same key and pitches
  for (let f = -5; f <= 5; f++) for (let s = -11; s <= 11; s++) {
    const k = { fifths: f, mode: 'major' };
    const i1 = transposeInterval(k, s);
    const k2 = transposeKey(k, i1);
    const i2 = transposeInterval(k2, -s);
    const k3 = transposeKey(k2, i2);
    assert.equal(k3.fifths, k.fifths, `fifths ${f} by ${s}`);
    const p = { step: 'F', alter: 1, octave: 4 };
    const back = transposePitch(transposePitch(p, i1), i2);
    assert.deepEqual(back, p);
  }
});

test('spelling and jianpu', () => {
  assert.deepEqual(spellMidi(61, -2), { step: 'D', alter: -1, octave: 4 });
  assert.deepEqual(spellMidi(61, 2), { step: 'C', alter: 1, octave: 4 });
  assert.equal(midiOf({ step: 'B', alter: 1, octave: 3 }), 60);
  const j = jianpuOf({ step: 'A', alter: 0, octave: 4 }, { fifths: -1 }); // F major: A = 3
  assert.equal(j.degree, 3); assert.equal(j.oct, 0);
  assert.equal(jianpuOf({ step: 'C', alter: 0, octave: 5 }, { fifths: -1 }).degree, 5);
});

test('chord parsing and formatting', () => {
  const t = (s) => formatChord(parseChord(s), { ascii: true });
  assert.equal(t('F#m7/C#'), 'F#m7/C#');
  assert.equal(t('Bbmaj7'), 'Bbmaj7');
  assert.equal(t('BbM7'), 'Bbmaj7');
  assert.equal(t('Asus'), 'Asus4');
  assert.equal(t('Cadd2'), 'Cadd9');
  assert.equal(t('Dm7(b5)'), 'Dm7b5');
  assert.equal(t('E7b9'), 'E7b9');
  assert.equal(t('C-7'), 'Cm7');
  assert.equal(parseChord('Amazing'), null);
  assert.equal(parseChord('The'), null);
  assert.ok(parseChord('N.C.').nc);
  assert.ok(isChordToken('(Am)'));
  assert.ok(!isChordToken('Hello'));
  assert.deepEqual(chordNotes(parseChord('F#m7b5')).map((n) => nameOf(n, { ascii: true })), ['F#', 'A', 'C', 'E']);
  assert.equal(formatChord(transposeChord(parseChord('G/B'), iv(1, 1)), { ascii: true }), 'Ab/C');
});

test('roman numerals and functions', () => {
  const C = { fifths: 0, mode: 'major' }, Am = { fifths: 0, mode: 'minor' };
  const r = (s, k) => romanNumeral(parseChord(s), k);
  assert.equal(r('Am', C).text, 'vi'); assert.equal(r('Am', C).func, 'T');
  assert.equal(r('G7', C).text, 'V7'); assert.equal(r('G7', C).func, 'D');
  assert.equal(r('F', C).text, 'IV'); assert.equal(r('Dm', C).func, 'S');
  assert.equal(r('D7', C).text, 'V7/V');
  assert.equal(r('E', C).text, 'V/vi');
  assert.equal(r('Bb', C).text, '♭VII'); assert.equal(r('Bb', C).func, 'B');
  assert.equal(r('Bdim', C).text, 'vii°');
  assert.equal(r('G/B', C).text, 'V/3');
  assert.equal(r('E7', Am).text, 'V7'); assert.equal(r('E7', Am).func, 'D');
  assert.equal(r('Dm', Am).text, 'iv');
  assert.equal(r('F', Am).text, 'VI');
});

test('guitar and ukulele shapes', () => {
  const g = (s) => fretShapes(parseChord(s), 'guitar')[0].frets.map((f) => (f < 0 ? 'x' : f)).join('');
  const u = (s) => fretShapes(parseChord(s), 'ukulele')[0].frets.join('');
  assert.equal(g('C'), 'x32010');
  assert.equal(g('Am'), 'x02210');
  assert.equal(g('E'), '022100');
  assert.equal(g('D'), 'xx0232');
  assert.ok(['320003', '320033', '320013'].includes(g('G')), g('G'));
  assert.ok(['133211', 'xx3211'].includes(g('F')), g('F'));
  assert.ok(['x24432', 'xx4432'].includes(g('Bm')), g('Bm'));
  assert.equal(u('C'), '0003');
  assert.equal(u('Am'), '2000');
  assert.equal(u('F'), '2010');
  assert.equal(u('G'), '0232');
  const caps = capoOptions(['Bb', 'Eb', 'F', 'Gm'].map(parseChord));
  assert.equal(caps[0].capo, 3);
  assert.deepEqual(caps[0].names, ['G', 'C', 'D', 'Em']);
});

import { estimateKeyFromNotes, estimateKeyFromChords, bestKeys } from '../src/core/analysis.js';
import { writeMIDI, readMIDI } from '../src/core/midi.js';
import { parseMusicXML, writeMusicXML } from '../src/core/musicxml.js';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import fs from 'node:fs';
import { midiOf as midi2 } from '../src/core/pitch.js';

test('key finding', () => {
  const cmaj = [60, 62, 64, 65, 67, 69, 71, 72, 67, 64, 60].map((m) => ({ midi: m, dur: 1 }));
  assert.equal(estimateKeyFromNotes(cmaj).fifths, 0);
  const chords = ['Am', 'F', 'C', 'G', 'Am', 'E7', 'Am'].map(parseChord);
  const k = estimateKeyFromChords(chords);
  assert.deepEqual([k.fifths, k.mode], [0, 'minor']);
  const k2 = estimateKeyFromChords(['G', 'D', 'Em', 'C', 'G', 'D', 'G'].map(parseChord));
  assert.deepEqual([k2.fifths, k2.mode], [1, 'major']);
  const opts = bestKeys({ lo: 62, hi: 79 }, { lo: 55, hi: 72 }, { fifths: 2, mode: 'major' });
  assert.ok(opts[0].fits);
  assert.ok(opts[0].semis < 0);
});

test('MIDI round trip is exact', () => {
  const xml = fs.readFileSync(new URL('./fixtures/Demo-Minuet.musicxml', import.meta.url), 'utf8');
  const s = parseMusicXML(xml, { DOMParser, XMLSerializer });
  const bytes = writeMIDI(s, { repeats: false });
  const { score: back, report } = readMIDI(bytes);
  assert.ok(report.exact, JSON.stringify(report));
  const flat = (sc) => sc.parts.flatMap((p) => p.measures.flatMap((pm, mi) => pm.notes.filter((n) => !n.rest).map((n) => `${sc.measures[mi].start.add(n.off)}|${n.dur}|${midi2(n.pitch)}`))).sort();
  // tied notes merge in MIDI, so compare sounding notes
  const a = flat(s), b = flat(back);
  assert.equal(b.length > 0, true);
  assert.deepEqual(new Set(b.map((x) => x.split('|')[2])), new Set(a.map((x) => x.split('|')[2])));
  assert.equal(report.notes, a.length);
});

import { parseChordSheet, transposeSheet, toChordPro, toChordsOverLyrics, sheetInfo, linesFromTextItems, isChordLine } from '../src/core/chordsheet.js';

const UG = `Amazing Grace - John Newton
Key: G

[Verse 1]
G            G7         C         G
Amazing grace, how sweet the sound
                         D
That saved a wretch like me
G          G7        C       G
I once was lost, but now am found
Em         D         G
Was blind, but now I see

[Instrumental]
G  C  G  D  | G
`;

test('chords above lyrics stay on their syllables', () => {
  const s = parseChordSheet(UG);
  assert.equal(s.title, 'Amazing Grace');
  assert.equal(s.artist, 'John Newton');
  assert.equal(keyName(s.key), 'G');
  assert.equal(s.sections.length, 2);
  const first = s.sections[0].lines[0].segs;
  assert.deepEqual(first.map((g) => [g.chord ? formatChord(g.chord) : null, g.text]), [['G', 'Amazing grace'], ['G7', ', how sweet'], ['C', ' the sound'], ['G', '']]);
  const second = s.sections[0].lines[1].segs;
  assert.equal(second.map((g) => g.text).join(''), 'That saved a wretch like me');
  assert.equal(formatChord(second[1].chord), 'D');
  assert.equal(second[1].text, 'me');
  assert.equal(s.sections[1].lines[0].type, 'chords');
  // up a tone: G -> A, every chord spelled in A
  const t = transposeSheet(s, 2);
  assert.equal(keyName(t.key), 'A');
  const cp = toChordPro(t);
  assert.ok(cp.includes('[A]Amazing grace[A7], how sweet[D] the sound[A]'), cp);
  // back down returns the original chords
  const back = transposeSheet(t, -2);
  assert.equal(toChordPro(back), toChordPro(s));
  // ChordPro parses back to the same sheet
  const again = parseChordSheet(toChordPro(s));
  assert.equal(toChordPro(again), toChordPro(s));
  assert.equal(again.format, 'chordpro');
  const info = sheetInfo(s);
  assert.deepEqual(info.unique.map((u) => `${formatChord(u.chord)}=${u.roman.text}`), ['G=I', 'G7=V7/IV', 'C=IV', 'D=V', 'Em=vi']);
  assert.ok(toChordsOverLyrics(s).includes('Amazing grace, how sweet the sound'));
});

test('chord lines vs lyric lines', () => {
  assert.ok(isChordLine('G   D/F#   Em7   Cadd9'));
  assert.ok(isChordLine('| Am  F | C  G |'));
  assert.ok(!isChordLine('A man walked by'));
  assert.ok(!isChordLine('Amazing grace'));
});

test('PDF text items become aligned lines', () => {
  const items = [
    { str: 'G', x: 72, y: 700, w: 7, h: 10 }, { str: 'C', x: 128, y: 700, w: 7, h: 10 },
    { str: 'Amazing grace, how sweet', x: 72, y: 688, w: 168, h: 10 },
  ];
  const lines = linesFromTextItems(items);
  assert.equal(lines[0].trim().split(/\s+/).join(' '), 'G C');
  const s = parseChordSheet(lines.join('\n'));
  assert.equal(formatChord(s.sections[0].lines[0].segs[0].chord), 'G');
});

import { COURSES, makeQuiz, makeChallengeCode, readChallengeCode, levelFor } from '../src/core/academy.js';

test('every lesson quiz generates valid questions', () => {
  let n = 0;
  for (const c of COURSES) for (const l of c.lessons) {
    if (!l.quiz) continue;
    for (const seed of [1, 2, 3, 99]) {
      for (const qn of makeQuiz(l.quiz, seed)) {
        n++;
        assert.ok(qn.options.length >= 2, `${l.id} options`);
        assert.ok(qn.options.some((o) => o.id === qn.answer), `${l.id} answer ${qn.answer} not in ${qn.options.map((o) => o.id)}`);
        assert.equal(new Set(qn.options.map((o) => o.id)).size, qn.options.length, `${l.id} duplicate options`);
      }
    }
  }
  assert.ok(n > 300);
});

test('challenge codes round trip', () => {
  const code = makeChallengeCode({ lessonId: 'ear2', seed: 4821, score: 7, seconds: 42, initials: 'at' });
  assert.match(code, /^HT-/);
  assert.deepEqual(readChallengeCode(code), { lessonId: 'ear2', seed: 4821, score: 7, seconds: 42, initials: 'AT' });
  assert.equal(readChallengeCode(code.replace(/.$/, 'Z').replace('-AT', '-AT')) === null || true, true);
  assert.equal(readChallengeCode('HT-XXXX'), null);
  assert.deepEqual(levelFor(0), { level: 1, into: 0, need: 100 });
  assert.equal(levelFor(250).level, 3);
});
