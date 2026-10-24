import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlaces, inOrder, plainText } from '../engine/lib/places.js';
import { sampleFabric } from './fixtures.js';

const build = () => buildPlaces(sampleFabric());
const byAddress = (m) => new Map(inOrder(m).map((p) => [p.address, p]));

test('every place gets its whole address, totem at the top', () => {
  const at = byAddress(build());
  assert.ok(at.has('RESEARCH (totem) > GAP PAPERS > LITERATURE SURVEY'));
  assert.ok(at.has('RESEARCH (totem) > GAP PAPERS > LITERATURE SURVEY > SURVEY TODO (note)'));
  assert.equal(at.get('RESEARCH (totem) > GAP PAPERS > LITERATURE SURVEY').kind, 'area');
});

test('siblings with one name are told apart', () => {
  const at = byAddress(build());
  assert.ok(at.has('RESEARCH (totem) > GAP PAPERS > METHODS'));
  assert.ok(at.has('RESEARCH (totem) > GAP PAPERS > METHODS [2]'));
});

test('a missing parentAreaId is worked out with File Fabric\'s rule', () => {
  const at = byAddress(build());
  assert.ok(at.has('RESEARCH (totem) > GAP PAPERS > OLD CORNER'));
});

test('a place in the field and one joined through its neighbours', () => {
  const at = byAddress(build());
  assert.equal(at.get('RESEARCH (totem) > GAP PAPERS').totemVia, 'field');
  assert.equal(at.get('RESEARCH (totem) > DATASETS').totemVia, 'neighbours');
});

test('scroll-box pages are places, and what was on a deleted page is left out', () => {
  const m = build();
  const at = byAddress(m);
  const p1 = at.get('HOME (totem) > Dashboard (scroll box) > Page 1');
  const p2 = at.get('HOME (totem) > Dashboard (scroll box) > Page 2');
  assert.equal(p1.pens, 1);
  assert.deepEqual(p2.files.map((f) => f.name), ['week.png']);
  assert.ok(at.has('HOME (totem) > Dashboard (scroll box) > Page 2 > Week (note)'));
  assert.ok(![...at.keys()].some((a) => a.includes('Lost')));
  assert.equal(at.get('HOME (totem) > Dashboard (scroll box)').deletedPageItems, 1);
  assert.equal(m.left.deletedPages, 1);
});

test('books, folders, hidden files and drawings File Fabric never draws are left out', () => {
  const m = build();
  const names = inOrder(m).map((p) => p.name);
  for (const n of ['Shelf', 'Inside the shelf', 'Box']) assert.ok(!names.includes(n), n);
  assert.deepEqual(m.left, { deletedPages: 1, inBooksOrFolders: 3, hidden: 1, unshown: 2 });
});

test('files, text and pen strokes are filed where they sit', () => {
  const at = byAddress(build());
  const survey = at.get('RESEARCH (totem) > GAP PAPERS > LITERATURE SURVEY');
  assert.deepEqual(survey.files, [{ name: 'survey-2024.pdf', kind: 'PDF', url: null, inSources: true }]);
  assert.equal(survey.pens, 1);
  assert.deepEqual(at.get('RESEARCH (totem) > GAP PAPERS').texts, ['Need for orthorectification\n& more']);
  assert.deepEqual(at.get('RESEARCH (totem)').files.map((f) => f.name), ['near-totem.pdf']);
  assert.deepEqual(at.get('Open canvas').texts, ['loose words']);
});

test('links and drawn lines are wires, and carry the notes they reach', () => {
  const at = byAddress(build());
  const progress = at.get('HOME (totem) > Progress');
  assert.deepEqual(progress.wires.map((w) => [w.via, w.id]).sort(), [['line', 'N1'], ['link', 'A1']]);
  assert.deepEqual(progress.reach, { notes: [{ id: 'N1', done: 1, total: 2 }], done: 1, total: 2 });
});

test('neighbours say which way they lie', () => {
  const at = byAddress(build());
  const m1 = at.get('RESEARCH (totem) > GAP PAPERS > METHODS');
  assert.deepEqual(m1.neighbours.slice(0, 2), [
    { id: 'A2', dir: 'left', distance: 50 },
    { id: 'A4', dir: 'below', distance: 150 },
  ]);
});

test('text drawings lose their HTML', () => {
  assert.equal(plainText('<div>a&nbsp;b</div><div>c &lt;d&gt;</div>'), 'a b\nc <d>');
});
