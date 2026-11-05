// Melody variations keep the tune: anchors stay, bars keep their length, light only adds notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseABC } from '../src/core/abc.js';
import { parseMusicXML, writeMusicXML } from '../src/core/musicxml.js';
import { performance, measureLength, timeAt } from '../src/core/score.js';
import { midiOf } from '../src/core/pitch.js';
import { varyMelody, strongOffsets, scaleStep } from '../src/core/variation.js';
import { q } from '../src/core/q.js';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const ODE = `X:1\nT:Ode\nM:4/4\nL:1/4\nK:D\nF F G A | A G F E | D D E F | F3/2 E/2 E2 |\nF F G A | A G F E | D D E F | E3/2 D/2 D2 |\n`;
const MINUET = `X:1\nT:Minuet\nM:3/4\nL:1/8\nK:G\nd2 GA Bc | d2 G2 G2 | e2 cd ef | g2 G2 G2 | c2 dc BA | B2 cB AG | F2 GA BG | A6 |\n`;

const notesOf = (sc) => sc.parts[0].measures.flatMap((pm, mi) => pm.notes.filter((n) => !n.rest && !n.chord).map((n) => ({ mi, off: n.off, midi: midiOf(n.pitch), id: n.id, dur: n.dur })));

for (const [name, abc] of [['Ode to Joy', ODE], ['Minuet', MINUET]]) {
  for (const amount of ['light', 'balanced', 'free']) {
    test(`${name}, ${amount}: bars keep their length and every strong-beat note stays`, () => {
      const sc = parseABC(abc);
      for (let seed = 1; seed <= 6; seed++) {
        const v = varyMelody(sc, { amount, style: ['pop', 'jazz', 'baroque', 'blues'][seed % 4], seed });
        v.score.parts[0].measures.forEach((pm, mi) => {
          const len = pm.notes.filter((n) => !n.chord && !n.grace).reduce((s, n) => s.add(n.dur), q(0));
          assert.ok(len.eq(measureLength(timeAt(v.score, mi))), `bar ${mi + 1} length ${len}`);
        });
        const before = notesOf(sc), after = notesOf(v.score);
        for (const n of before) {
          const strong = strongOffsets(timeAt(sc, n.mi)).some((s) => s.eq(n.off));
          if (strong) assert.ok(after.some((x) => x.mi === n.mi && x.off.eq(n.off) && x.midi === n.midi), `anchor kept bar ${n.mi + 1}`);
          if (amount === 'light') assert.ok(after.some((x) => x.mi === n.mi && x.off.eq(n.off) && x.midi === n.midi), 'light keeps every original note');
        }
        // the result is a valid score the app can write, read back and play
        const back = parseMusicXML(writeMusicXML(v.score), { DOMParser, XMLSerializer });
        assert.equal(performance(back).length.num(), performance(sc).length.num());
        assert.ok(v.similarity > 0 && v.similarity <= 1);
      }
    });
  }
}

const CANON = `X:1\nT:Canon\nM:4/4\nL:1/4\nK:D\n|:"D"f2 "A"e2|"Bm"d2 "F#m"c2|"G"B2 "D"A2|"G"B2 "A"c2:|\n"D"d4|]\n`;

test('a tune of long strong-beat notes still gets varied, and every main note stays', () => {
  const sc = parseABC(CANON);
  for (const amount of ['light', 'balanced', 'free']) {
    let changed = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const v = varyMelody(sc, { amount, seed });
      changed += v.changed;
      const after = notesOf(v.score);
      for (const n of notesOf(sc)) assert.ok(after.some((x) => x.mi === n.mi && x.off.eq(n.off) && x.midi === n.midi), `${amount} bar ${n.mi + 1}`);
      const last = after.filter((x) => x.mi === sc.measures.length - 1);
      assert.equal(last.length, 1, 'the final note stays long');
    }
    assert.ok(changed > 0, `${amount} changed nothing`);
  }
});

test("arpeggios use the song's own chords", () => {
  const sc = parseABC(`X:1\nT:Arp\nM:4/4\nL:1/4\nK:C\n"C"c4|"F"c4|"G"d4|"C"c4|]\n`);
  const want = [[0, 4, 7], null, [7, 11, 2]];
  let seen = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const v = varyMelody(sc, { amount: 'free', seed });
    v.score.parts[0].measures.forEach((pm, mi) => {
      const ns = pm.notes.filter((n) => !n.rest);
      if (ns.length !== 8 || !want[mi]) return;           // eight eighths = an arpeggio over the whole bar
      seen++;
      for (const n of ns) assert.ok(want[mi].includes(midiOf(n.pitch) % 12), `bar ${mi + 1}: ${n.pitch.step}${n.pitch.octave}`);
    });
  }
  assert.ok(seen > 0, 'no arpeggio in 40 tries');
});

test('light never comes back empty when there is something to vary', () => {
  const sc = parseABC(CANON);
  for (let seed = 1; seed <= 12; seed++) assert.ok(varyMelody(sc, { amount: 'light', seed }).changed > 0, `seed ${seed}`);
});

test('more change = less like the original, on average', () => {
  const sc = parseABC(MINUET);
  const avg = (amount) => { let s = 0; for (let seed = 1; seed <= 20; seed++) s += varyMelody(sc, { amount, seed }).similarity; return s / 20; };
  const light = avg('light'), balanced = avg('balanced'), free = avg('free');
  assert.ok(light > balanced && balanced > free, `${light} ${balanced} ${free}`);
  assert.ok(light >= 0.8, `light ${light}`);
});

test('scale steps follow the key', () => {
  assert.deepEqual(scaleStep({ step: 'E', alter: 0, octave: 5 }, 1, 1), { step: 'F', alter: 1, octave: 5 });   // G major
  assert.deepEqual(scaleStep({ step: 'C', alter: 0, octave: 5 }, -1, -1), { step: 'B', alter: -1, octave: 4 }); // F major
});

const PIANO = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>1</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time><staves>2</staves>
<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
<direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type><staff>2</staff></direction>
<note><pitch><step>D</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
<note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
<note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
<backup><duration>3</duration></backup>
<note><pitch><step>G</step><octave>3</octave></pitch><duration>2</duration><voice>5</voice><type>half</type><staff>2</staff></note>
<note><pitch><step>A</step><octave>3</octave></pitch><duration>1</duration><voice>5</voice><type>quarter</type><staff>2</staff></note>
</measure></part></score-partwise>`;

test('a piano part splits into right and left hand', async () => {
  const { extractPart, partChoices } = await import('../src/core/score.js');
  const sc = parseMusicXML(PIANO, { DOMParser, XMLSerializer });
  assert.equal(sc.parts[0].staves, 2);
  assert.deepEqual(partChoices(sc).map((c) => c.hand), ['right', 'left']);
  const pitches = (s) => s.parts[0].measures[0].notes.filter((x) => !x.rest).map((x) => midiOf(x.pitch));
  assert.deepEqual(pitches(extractPart(sc, 0, 1)), [74, 67, 69]);
  assert.deepEqual(pitches(extractPart(sc, 0, 2)), [55, 57]);
  const lh = extractPart(sc, 0, 2);
  const xml = writeMusicXML(lh);
  assert.ok(!xml.includes('<staves>') && xml.includes('<sign>F</sign>') && xml.includes('<p/>'));
  const back = parseMusicXML(xml, { DOMParser, XMLSerializer });
  assert.deepEqual(pitches(back), [55, 57]);
  assert.equal(pitches(sc).length, 5);                          // the original is untouched
});
