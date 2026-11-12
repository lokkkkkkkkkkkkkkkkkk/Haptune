import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJianpu, isJianpu, jianpuModel, renderJianpu } from '../src/core/jianpu.js';
import { parseMusicXML, writeMusicXML } from '../src/core/musicxml.js';
import { performance } from '../src/core/score.js';
import { parseABC } from '../src/core/abc.js';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const midis = (score) => performance(score, { repeats: false }).events.map((e) => [e.t.num(), e.dur.num(), e.midi]);

test('簡譜 text becomes a score: degrees, octaves, lengths, ties and words', () => {
  const text = `title: 茉莉花
key: 1=F
time: 2/4
tempo: 72
---
3 3_ 5_ | 6_ 1'_ 1'_ 6_ | 5 5_ 6_ | 5 - |
w: 好 一 朵 美 丽 的 茉 莉 花`;
  assert.ok(isJianpu(text));
  const s = parseJianpu(text);
  assert.equal(s.title, '茉莉花');
  assert.equal(s.measures.length, 4);
  assert.deepEqual(s.parts[0].measures[0].key, { fifths: -1, mode: 'major' });
  // 1=F: 3 is A4 (69), 5 is C5 (72), 6 is D5 (74), 1' is F5 (77)
  assert.deepEqual(midis(s).map((x) => x[2]), [69, 69, 72, 74, 77, 77, 74, 72, 72, 74, 72]);
  assert.deepEqual(midis(s).slice(0, 3).map((x) => x[1]), [1, 0.5, 0.5]);
  assert.equal(midis(s).at(-1)[1], 2);                          // "5 -" is held for the bar
  const words = s.parts[0].measures.flatMap((m) => m.notes).filter((n) => n.lyrics.length).map((n) => n.lyrics[0].text);
  assert.deepEqual(words, ['好', '一', '朵', '美', '丽', '的', '茉', '莉', '花']);
  // it is ordinary MusicXML from here on
  const again = parseMusicXML(writeMusicXML(s), { DOMParser, XMLSerializer });
  assert.deepEqual(midis(again), midis(s));
});

test('簡譜: flats in the key are spelled as flats, bars fill up without bar lines, a hold crosses the bar', () => {
  const s = parseJianpu('1=bB 4/4\n4 #4 b7 0 5 - - - - 1, 5. 5_');
  const notes = s.parts[0].measures.flatMap((m) => m.notes).filter((n) => !n.rest);
  assert.deepEqual([notes[0].pitch.step, notes[0].pitch.alter], ['E', -1]);       // 4 in B flat major is E flat
  assert.deepEqual([notes[1].pitch.step, notes[1].pitch.alter], ['E', 0]);        // #4 is E natural
  assert.deepEqual([notes[2].pitch.step, notes[2].pitch.alter], ['A', -1]);       // b7 is A flat
  assert.equal(s.measures.length, 3);
  const ev = midis(s);
  assert.equal(ev.find((e) => e[0] === 4)[1], 5);                                  // 5 held four beats, then tied one beat into bar 3
  assert.equal(ev.at(-3)[2], 58);                                        // 1, is B flat 3
  assert.throws(() => parseJianpu('1=C\n1 2 x 4'), /isn't 簡譜/);
  assert.equal(isJianpu('[C]Twinkle twinkle [F]little [C]star'), false);
});

test('any score can be shown as 簡譜', () => {
  const score = parseABC('X:1\nT:Test\nM:3/4\nL:1/8\nK:D\n"D"F2 A2 d2|"A"c3 B A2|d6|]');
  const m = jianpuModel(score, 0);
  assert.equal(m.keyText, '1=D');
  assert.deepEqual(m.bars[0].items.map((x) => [x.degree, x.oct]), [[3, 0], [5, 0], [1, 1]]);
  assert.deepEqual(m.bars[1].items.map((x) => [x.degree, x.type, x.dots]), [[7, 'quarter', 1], [6, 'eighth', 0], [5, 'quarter', 0]]);
  const { svg } = renderJianpu(m, { width: 360 });
  assert.ok(svg.startsWith('<svg') && svg.includes('1=D') && svg.includes('3/4'));
  const ids = score.parts[0].measures.flatMap((pm) => pm.notes).map((n) => n.id);
  for (const id of ids) assert.ok(svg.includes(`id="jp-${id}"`), `note ${id} is drawn`);
  assert.equal((svg.match(/class="jp-dash"/g) || []).length, 2);                   // the dotted half: 1 - -
  assert.ok(svg.includes('class="jp-chord"'));
});
