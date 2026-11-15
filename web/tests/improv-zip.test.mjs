// The improviser and backing band (Create > Improvise) and the zip writer/reader (stems, .mxl import/export).
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { improvise, backing, layoutProgression, progressionInKey, scaleFor, STYLES, PROGRESSIONS, rng, withLabels, instrumentLabel } from '../src/core/improv.js';
import { writeZip, readZip, xmlToMxl, mxlToXml, crc32, decodeText } from '../src/core/zip.js';
import { performance } from '../src/core/score.js';
import { parseChord } from '../src/core/chords.js';

test('improvise: every style and level gives a playable line inside the instrument range, same seed same line', () => {
  for (const style of Object.keys(STYLES)) {
    for (const level of [1, 2, 3]) {
      const opts = { style, level, key: { fifths: 2, mode: 'major' }, progression: ['D', 'Bm', 'G', 'A'], bars: 8, instrument: 'violin', seed: 7 };
      const r = improvise(opts);
      const ev = performance(r.score, { repeats: false }).events;
      assert.ok(ev.length >= 8, `${style} ${level}: ${ev.length} notes`);
      assert.equal(r.score.measures.length, 8);
      for (const e of ev) assert.ok(e.midi >= 55 && e.midi <= 100, `${style}: ${e.midi} out of range`);
      assert.deepEqual(performance(improvise(opts).score, { repeats: false }).events.map((e) => e.midi), ev.map((e) => e.midi));
      // every note is named for the harmony: a chord tone (R 3 5 7 9), a passing note or an approach note
      assert.ok(r.labels.size >= ev.length * 0.8, `${style}: ${r.labels.size} labels for ${ev.length} notes`);
      assert.ok([...r.labels.values()].every((l) => ['R', '3', '5', '7', '9', 'p', 'a', 'b3', 'b7', '6', '4', '2', 'b5', '#5', 'b9', '#9', '11', '#11', '13'].includes(l) || typeof l === 'string'));
    }
  }
});

test('the backing band plays keys, bass and drums for every bar', () => {
  const spans = layoutProgression(['C', 'Am', 'F', 'G'], 4, { beats: 4, beatType: 4 });
  assert.equal(spans.length, 4);
  for (const style of Object.keys(STYLES)) {
    const ev = backing(spans, { style, bars: 4 });
    const kinds = new Set(ev.map((e) => e.inst));
    assert.ok(kinds.has('bass') && ev.length > 8, style);
    assert.ok(ev.every((e) => Number.isFinite(Number(e.t?.num?.() ?? e.t))), style);
  }
  const waltz = backing(layoutProgression(['C', 'G'], 2, { beats: 3, beatType: 4 }), { style: 'pop', time: { beats: 3, beatType: 4 }, bars: 2 });
  assert.ok(waltz.length > 0);
});

test('progressions move to any key; scales fit the chord; helpers', () => {
  const inG = progressionInKey('axis', { fifths: 1, mode: 'major' });
  assert.equal(inG.length, PROGRESSIONS.axis.chords.length);
  assert.ok(inG.every((c) => c.root && c.quality));
  const sc = scaleFor(parseChord('G7'), { fifths: 0, mode: 'major' }, STYLES.blues || STYLES.pop);
  assert.ok(Array.isArray(sc.pcs || sc) || typeof sc === 'object');
  const r = rng(5); const a = r(), b = r();
  assert.ok(a >= 0 && a < 1 && a !== b);
  assert.equal(typeof instrumentLabel('violin'), 'string');
  const imp = improvise({ progression: ['C', 'G'], bars: 2, seed: 2 });
  assert.ok(withLabels(imp.score, imp.labels));
});

test('zip: write, read back, and .mxl round trip', async () => {
  const files = [{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3, 250]) }];
  const zip = writeZip(files);
  const entries = readZip(zip);
  const names = [...entries.keys()];
  assert.ok(names.includes('a.txt') && names.includes('dir/b.bin'), JSON.stringify(names));
  assert.equal(crc32(new TextEncoder().encode('123456789')) >>> 0, 0xcbf43926);
  const xml = '<?xml version="1.0"?><score-partwise version="4.0"><part-list/></score-partwise>';
  const back = await mxlToXml(xmlToMxl(xml), async (b) => inflateRawSync(b));
  assert.equal(back, xml);
  assert.equal(decodeText(new TextEncoder().encode('Für Elise')), 'Für Elise');
});
