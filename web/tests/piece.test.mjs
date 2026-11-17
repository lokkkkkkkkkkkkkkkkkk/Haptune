import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLink, linkFor, shareURL, nextSteps, fromLibrary, fromCatalog, fromPost, fromAssignment, typeOf } from '../src/core/piece.js';

test('deep links: the new forms and the old ones', () => {
  assert.deepEqual(parseLink('#piece/p1abc/practise'), { route: 'piece', id: 'p1abc', action: 'practise' });
  assert.deepEqual(parseLink('#piece/mutopia-123/practice'), { route: 'piece', id: 'mutopia-123', action: 'practise' });
  assert.deepEqual(parseLink('#piece/p1abc/create'), { route: 'piece', id: 'p1abc', action: 'create' });
  assert.deepEqual(parseLink('#piece/p1abc'), { route: 'piece', id: 'p1abc', action: null });
  assert.deepEqual(parseLink('#class/c9/assignment/a7'), { route: 'assignment', classId: 'c9', id: 'a7' });
  assert.deepEqual(parseLink('#class/c9'), { route: 'class', id: 'c9' });
  assert.deepEqual(parseLink('#stage/post/0123abcd'), { route: 'post', id: '0123abcd' });
  assert.deepEqual(parseLink('#post/0123abcd'), { route: 'post', id: '0123abcd' });
  assert.deepEqual(parseLink('#sound/s42'), { route: 'sound', id: 's42' });
  assert.deepEqual(parseLink('#u/ms_tan'), { route: 'person', id: 'ms_tan' });
  for (const bad of ['#piece/', '#piece/a/b/c', '#class/x/y', '#stage', '#join/ABC123', '', '#piece/<script>']) assert.equal(parseLink(bad), null, bad);
});

test('links round-trip through every item type', () => {
  const items = [fromLibrary({ id: 'p1', title: 'Ode', composer: 'B' }), fromCatalog({ id: 'mutopia-9', title: 'Minuet' }),
    fromPost({ id: 'ab12cd', type: 'request', title: 'Let it go' }), fromAssignment({ id: 'a1', class_id: 'c1', title: 'Scales' })];
  for (const it of items) { const l = linkFor(it); assert.ok(parseLink(l), l); }
  assert.equal(linkFor(items[0], 'practise'), '#piece/p1/practise');
  // a library piece that came from the free library links by its catalogue id, so it opens on any device
  assert.equal(linkFor(fromLibrary({ id: 'p1', catalogId: 'mutopia-9', title: 'x' })), '#piece/mutopia-9');
  assert.equal(shareURL('https://haptune.name.my/', items[2]), 'https://haptune.name.my/app/#stage/post/ab12cd');
  assert.deepEqual(items.map(typeOf), ['pieces', 'pieces', 'pieces', 'classes']);
});

test('what next: every flow has a first choice, and handing in comes first for homework', () => {
  for (const f of ['take', 'create', 'handIn', 'post', 'request', 'sound', 'join']) {
    const n = nextSteps(f, { online: true });
    assert.ok(n.length >= 2, f);
    assert.equal(n.filter((x) => x.primary).length, 1, `${f} has one primary chip`);
  }
  assert.equal(nextSteps('take', { assignment: true, accuracy: 0.9 })[0].id, 'handIn');
  assert.equal(nextSteps('take', { accuracy: 0.95, speed: 1 })[0].id, 'faster');
  assert.equal(nextSteps('take', { accuracy: 0.5, tricky: true })[0].id, 'loopTricky');
  assert.ok(!nextSteps('take', { accuracy: 0.9, online: false }).some((x) => x.id === 'shareStage'));
  assert.equal(nextSteps('handIn', { nextAssignment: { id: 'a2' } })[0].id, 'nextAssignment');
});
