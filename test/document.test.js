import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlaces } from '../engine/lib/places.js';
import { toMarkdown, toPlaceMap, safeText } from '../engine/lib/document.js';
import { sampleFabric } from './fixtures.js';

let extractMarkdown = null;
try { ({ extractMarkdown } = await import('../../Project Harness/engine/lib/extract/markdown.js')); } catch (_) { /* RAGX not beside this repo */ }

const md = () => toMarkdown(buildPlaces(sampleFabric()));

test('each place is one section headed by its whole address', () => {
  const text = md();
  assert.match(text, /^## RESEARCH \(totem\) > GAP PAPERS > LITERATURE SURVEY$/m);
  assert.match(text, /^An area inside GAP PAPERS in the totem RESEARCH\.$/m);
  assert.match(text, /^## HOME \(totem\) > Dashboard \(scroll box\) > Page 2 > Week \(note\)$/m);
  assert.match(text, /^Checklist: 2 of 3 done\.$/m);
});

test('a note\'s own headings and fences cannot break the sections', () => {
  assert.equal(safeText('# Reading\n- [x] a\n---\n```js'), '**Reading**\n- [x] a\n\n    ```js');
});

/* What RAGX will see: every heading it reads is a place's address, and the
 * note's text stays under its own. Read with RAGX's own Markdown reader,
 * when Project Harness sits beside this repository. */
test('RAGX reads one heading per place and keeps note text under it', { skip: !extractMarkdown && 'Project Harness is not beside this repository' }, () => {
  const { blocks } = extractMarkdown(md());
  const headings = blocks.filter((b) => b.kind === 'heading');
  assert.ok(headings.every((h) => h.level === 2));
  const i = blocks.findIndex((b) => b.kind === 'heading' && b.text.endsWith('SURVEY TODO (note)'));
  const until = blocks.findIndex((b, j) => j > i && b.kind === 'heading');
  const under = blocks.slice(i + 1, until).map((b) => b.text).join('\n');
  assert.match(under, /SAR review/);
  assert.match(under, /\*\*Reading\*\*/);
});

test('the overview names the totems and what was left out', () => {
  const text = md();
  assert.match(text, /^## Thesis \(fabric\)$/m);
  assert.match(text, /^- RESEARCH \(totem\): GAP PAPERS and DATASETS$/m);
  assert.match(text, /^Left out: 1 item on deleted scroll-box pages, 3 things in books or folders, 1 hidden file and 2 drawings File Fabric never draws\.$/m);
});

test('the place map holds the same tree', () => {
  const map = toPlaceMap(buildPlaces(sampleFabric()));
  const survey = map.places.find((p) => p.address === 'RESEARCH (totem) > GAP PAPERS > LITERATURE SURVEY');
  assert.equal(survey.parent, 'A1');
  assert.deepEqual(survey.children, ['N1']);
  assert.equal(survey.totem, 'totem:T1');
});
