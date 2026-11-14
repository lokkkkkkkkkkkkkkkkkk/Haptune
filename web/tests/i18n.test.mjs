import test from 'node:test';
import assert from 'node:assert/strict';
import { V4 } from '../src/core/i18n-v4.js';
import { MORE } from '../src/core/i18n-community.js';
import { V2 } from '../src/core/i18n-v2.js';
import { V3 } from '../src/core/i18n-v3.js';
import { t, setLang } from '../src/core/i18n.js';

const ph = (x) => (x.match(/\{\w+\}/g) || []).sort().join();

test('v4 text: every entry in English, Malay, Simplified and Traditional Chinese with the same placeholders', () => {
  for (const [k, v] of Object.entries(V4)) {
    assert.equal(v.length, 4, k);
    assert.ok(v.every((x) => typeof x === 'string' && x.trim().length), `empty text in ${k}`);
    assert.equal(new Set(v.map(ph)).size, 1, `placeholders differ in ${k}`);
  }
});

test('v4 text does not overwrite an older key', () => {
  const older = new Set([...Object.keys(MORE), ...Object.keys(V2), ...Object.keys(V3)]);
  assert.deepEqual(Object.keys(V4).filter((k) => older.has(k)), []);
});

test('t() uses the v4 table in each language', () => {
  setLang('zh-Hant'); assert.equal(t('moreTools'), '更多工具');
  setLang('ms'); assert.equal(t('homeHelloName', { name: 'Ali' }), 'Hai Ali');
  setLang('en'); assert.equal(t('tilePractice'), 'Practice');
});

test('every t() key used in the app has a translation', async () => {
  const { missingKeys } = await import('../tools/i18n-check.mjs');
  assert.deepEqual(missingKeys, []);
});
