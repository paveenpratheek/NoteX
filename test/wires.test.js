import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checklist, reachedNotes } from '../engine/lib/wires.js';
import { rect } from './fixtures.js';

test('checklists count as File Fabric counts them', () => {
  assert.deepEqual(checklist('- [x] a\n-[X] b\n- [ ] c\n-  [ ]d\n- [y] no'), { done: 2, total: 4 });
  assert.deepEqual(checklist(''), { done: 0, total: 0 });
});

/* The user's dashboard: one area joined by links to three notes, whose
 * totals File Fabric's bar showed as 7/21 (t-79b9f3b4b4). */
test('a chain of links reaches every note on it, sorted by id', () => {
  const state = {
    areas: [
      { id: 'dash', name: 'Spatial File Manager', polygons: [rect(0, 0, 300, 300)] },
      { id: 'n3', isNote: true, textContent: '- [x] a\n- [x] b\n- [x] c\n' + '- [ ] x\n'.repeat(6), polygons: [rect(1000, 0, 100, 100)] },
      { id: 'n1', isNote: true, textContent: '- [ ] x\n'.repeat(6), polygons: [rect(2000, 0, 100, 100)] },
      { id: 'n2', isNote: true, textContent: '- [x] a\n'.repeat(4) + '- [ ] x\n- [ ] y', polygons: [rect(3000, 0, 100, 100)] },
      { id: 'away', isNote: true, textContent: '- [x] a', polygons: [rect(9000, 0, 100, 100)] },
    ],
    links: [{ fromAreaId: 'dash', toAreaId: 'n3' }, { fromAreaId: 'n3', toAreaId: 'n1' }],
    drawings: [{ type: 'line', start: { x: 2050, y: 50 }, end: { x: 3050, y: 50 } }],
  };
  const notes = reachedNotes('dash', state);
  assert.deepEqual(notes.map((n) => n.id), ['n1', 'n2', 'n3']);
  const sum = notes.map((n) => checklist(n.textContent)).reduce((s, c) => ({ done: s.done + c.done, total: s.total + c.total }), { done: 0, total: 0 });
  assert.deepEqual(sum, { done: 7, total: 21 });
});

test('the walk never enters a scroll box, which stores points not polygons', () => {
  const state = {
    areas: [
      { id: 'a', polygons: [rect(0, 0, 100, 100)] },
      { id: 'box', isScrollBox: true, points: rect(500, 0, 300, 300) },
      { id: 'n', isNote: true, textContent: '- [ ] x', polygons: [rect(550, 50, 50, 50)] },
    ],
    links: [{ fromAreaId: 'a', toAreaId: 'box' }],
    drawings: [],
  };
  assert.deepEqual(reachedNotes('a', state).map((n) => n.id), []);
});
