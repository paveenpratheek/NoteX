/* Laying out totem scripts: sizes from the inside out, Row and Column, a
 * new totem in free space, <Add> growing boxes without moving the user's
 * items, <Edit>, Lines and Links, and the overlap check every layout must
 * pass (t-12859aa2fb, t-56e10f6d09, t-a94b02f199, t-2afecbd70b). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseScript } from '../engine/lib/script.js';
import { layoutTotem, layoutAdd, layoutEdits, growOverflows, lineBetween, FREE, Refusal } from '../engine/lib/layout.js';
import { buildPlaces } from '../engine/lib/places.js';
import { checkCanvas, overlapsOf } from '../engine/lib/check.js';
import { M, imageSize, measureText, measureNote, fileBox } from '../engine/lib/measure.js';
import { areaBBox, bboxDistance } from '../engine/lib/geometry.js';
import { sampleState, rect } from './fixtures.js';

const EXAMPLE = `<Canvas name="Thesis"><Totem name="Pipeline">
  <Row>
    <Area name="Collect"><Note name="Collect todo">- [ ] find papers
- [x] read survey</Note></Area>
    <Area name="Read"><Note name="Read todo">- [ ] skim ten</Note></Area>
    <Area name="Write"><Note name="Write todo">- [ ] outline</Note></Area>
    <Area name="Check"><Note name="Check todo">- [ ] proofread</Note></Area>
  </Row>
  <Line from="Collect" to="Read"/>
  <Line from="Read" to="Write"/>
  <Line from="Write" to="Check"/>
</Totem></Canvas>`;

const model = (state) => buildPlaces({ name: 'Thesis', state });
const box = (state, name) => areaBBox(state.areas.find((a) => a.name === name));
const opts = { owner: 'agent-a' };

test("the user's example: a Row of four areas holding notes, joined by three Lines", () => {
  const state = sampleState();
  const out = layoutTotem(parseScript(EXAMPLE), state, opts);
  const m = model(state);
  // Every box has the address the layout promised, and every new item is an agent's.
  for (const b of out.boxes) assert.equal(m.places.get(b.id).address, b.address);
  for (const id of out.written) {
    const item = [...state.areas, ...state.drawings, ...state.totems].find((x) => x.id === id);
    assert.equal(item.writtenBy, 'agent', id);
  }
  // Side by side, tops aligned, in order, with room for the lines between.
  const [c, r, w, k] = ['Collect', 'Read', 'Write', 'Check'].map((n) => box(state, n));
  assert.ok(c.minY === r.minY && r.minY === w.minY && w.minY === k.minY);
  assert.ok(c.maxX + M.ROW_GAP === r.minX && r.maxX + M.ROW_GAP === w.minX && w.maxX + M.ROW_GAP === k.minX);
  // Notes sit at the user's margins: 39 px in, 75 px down for the area's name.
  const note = box(state, 'Collect todo');
  assert.equal(note.minX - c.minX, M.SIDE);
  assert.equal(note.minY - c.minY, M.TOP);
  // The three Lines are wires File Fabric's walk follows: the network reaches all four notes.
  const ids = Object.fromEntries(['Collect', 'Read', 'Write', 'Check'].map((n) => [n, state.areas.find((a) => a.name === n).id]));
  const wires = m.wires.filter((x) => out.written.includes(x.from));
  assert.deepEqual(wires.map((x) => [x.from, x.to, x.via]), [[ids.Collect, ids.Read, 'line'], [ids.Read, ids.Write, 'line'], [ids.Write, ids.Check, 'line']]);
  assert.deepEqual([m.places.get(ids.Collect).reach.done, m.places.get(ids.Collect).reach.total], [1, 5]);
  // Free space: more than 800 px beyond everything that was on the canvas.
  const totem = state.totems.find((t) => t.id === out.totemId);
  assert.equal(totem.owner, 'agent-a');
  assert.equal(m.places.get(ids.Collect).parent, `totem:${totem.id}`);
  const old = sampleState();
  const oldRight = Math.max(...old.areas.map((a) => areaBBox(a).maxX), ...old.drawings.filter((d) => d.x).map((d) => d.x + 100));
  assert.ok(c.minX - oldRight >= FREE, `${c.minX - oldRight} px clear`);
  // And the overlap check finds nothing of the layout's.
  assert.deepEqual(overlapsOf(checkCanvas(state, m), new Set(out.written)), []);
});

test('sizes from the inside out: text by its lines, notes by their items, areas by what they hold', () => {
  const one = measureText('short', { size: 18 });
  const long = measureText('word '.repeat(200), { size: 18 });
  assert.ok(one.w < 100 && one.h === Math.ceil(18 * 1.2));
  assert.equal(long.w, M.TEXT_WIDTH);
  assert.ok(long.h > 10 * 18 * 1.2);
  assert.ok(measureNote('- [ ] a\n'.repeat(20)).h > measureNote('- [ ] a').h + 18 * 19);
  const state = { areas: [], drawings: [], files: [], totems: [], links: [] };
  layoutTotem(parseScript('<Canvas name="X"><Totem name="T"><Area name="Outer"><Area name="Inner"><Text>hello</Text></Area><Column><Text>a</Text><Text>b</Text></Column></Area></Totem></Canvas>'), state, opts);
  const outer = box(state, 'Outer'), inner = box(state, 'Inner');
  assert.equal(inner.minX - outer.minX, M.SIDE);
  assert.equal(inner.minY - outer.minY, M.TOP);
  const [a, b] = state.drawings.filter((d) => d.type === 'text' && d.text.length === 1);
  assert.equal(a.x, b.x, 'a Column keeps left edges aligned');
  assert.equal(b.y - a.y, Math.ceil(18 * 1.2) + M.GAP);
  assert.ok(outer.maxY >= b.y + Math.ceil(18 * 1.2) + M.BOTTOM);
  // On an empty canvas the totem sits 100 px above its first box, centred.
  assert.deepEqual([state.totems[0].x, state.totems[0].y], [Math.round(outer.maxX / 2), -M.TOTEM_ABOVE]);
});

/* A real PNG of w x h, so the layout reads its size from its header. */
function png(file, w, h) {
  const chunk = (type, data) => {
    const b = Buffer.alloc(8 + data.length + 4);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, 'ascii'); data.copy(b, 8);
    return b;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(h))), chunk('IEND', Buffer.alloc(0))]));
}

test('files: images at their real size up to 480 px, other files as cards, copied into sources', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-layout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fabricDir = path.join(dir, 'Canvas');
  fs.mkdirSync(path.join(fabricDir, 'sources'), { recursive: true });
  png(path.join(dir, 'wide.png'), 1200, 600);
  png(path.join(dir, 'small.png'), 100, 50);
  fs.writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-1.4');
  fs.writeFileSync(path.join(fabricDir, 'sources', 'kept.pdf'), '%PDF-1.4');
  assert.deepEqual(imageSize(path.join(dir, 'wide.png')), { w: 1200, h: 600 });
  const state = { areas: [], drawings: [], files: [], totems: [], links: [] };
  const script = `<Canvas name="Canvas"><Totem name="Files"><Area name="Shelf">
    <File path="${path.join(dir, 'wide.png')}"/><Row><File path="${path.join(dir, 'small.png')}"/><File path="${path.join(dir, 'paper.pdf')}"/><File path="kept.pdf"/></Row>
  </Area></Totem></Canvas>`;
  const out = layoutTotem(parseScript(script), state, { ...opts, fabricDir });
  const [wide, small, pdf, kept] = state.files;
  assert.deepEqual([wide.imageWidth, wide.imageHeight, small.imageWidth, small.imageHeight], [480, 240, 100, 50]);
  assert.ok(wide.isImage && pdf.isPdf && !pdf.isImage);
  assert.deepEqual(out.copies.map((c) => c.name), ['wide.png', 'small.png', 'paper.pdf']);
  // Centred on x, y as File Fabric draws them, inside the shelf, not touching each other.
  const shelf = box(state, 'Shelf');
  for (const f of state.files) {
    const b = fileBox(f);
    assert.ok(b.minX >= shelf.minX + M.SIDE - 0.5 && b.maxX <= shelf.maxX && b.maxY <= shelf.maxY, f.name);
    assert.equal(f.areaId, state.areas[0].id);
  }
  assert.deepEqual(state.areas[0].containedFiles, state.files.map((f) => f.id));
  assert.ok(bboxDistance(fileBox(wide), fileBox(small)) >= M.GAP - 0.5);
  const m = buildPlaces({ name: 'Canvas', state, dir: fabricDir, sources: new Set(['kept.pdf']) });
  assert.deepEqual(m.places.get(state.areas[0].id).files.map((f) => f.name), ['wide.png', 'small.png', 'paper.pdf', 'kept.pdf']);
  // A different file with a name already in sources is refused, not overwritten.
  fs.writeFileSync(path.join(dir, 'kept.pdf'), 'another');
  assert.throws(() => layoutTotem(parseScript(`<Canvas name="Canvas"><Totem name="More"><File path="${path.join(dir, 'kept.pdf')}"/></Totem></Canvas>`), state, { ...opts, fabricDir }), /a different file called kept.pdf/);
  assert.throws(() => layoutTotem(parseScript('<Canvas name="Canvas"><Totem name="More"><File path="nowhere.pdf"/></Totem></Canvas>'), state, { ...opts, fabricDir }), /neither a full path/);
});

test('a scroll box: each page laid out in the same box, its items on their page', () => {
  const state = { areas: [], drawings: [], files: [], totems: [], links: [] };
  const out = layoutTotem(parseScript('<Canvas name="X"><Totem name="T"><ScrollBox name="Weeks"><Page><Note name="Mon">- [ ] a</Note></Page><Page><Text>Tuesday</Text></Page></ScrollBox></Totem></Canvas>'), state, opts);
  const m = buildPlaces({ name: 'X', state });
  const sb = state.areas.find((a) => a.isScrollBox);
  assert.equal(sb.pages.length, 2);
  assert.ok(out.boxes.some((b) => b.address === 'T (totem) > Weeks (scroll box) > Page 1 > Mon (note)'));
  for (const b of out.boxes) assert.equal(m.places.get(b.id).address, b.address);
  assert.deepEqual(m.places.get(`page:${sb.id}:${sb.pages[1].id}`).texts, ['Tuesday']);
});

test('Add puts new items below what a place holds, grows it and pushes only the agent\'s own items aside', () => {
  const state = sampleState();
  layoutTotem(parseScript(`<Canvas name="Thesis"><Totem name="Plan"><Area name="Top"><Text>first</Text></Area><Area name="Below"><Text>under it</Text></Area></Totem></Canvas>`), state, opts);
  const before = { top: box(state, 'Top'), below: box(state, 'Below') };
  const out = layoutAdd(parseScript('<Add canvas="Thesis" at="Plan (totem) > Top"><Note name="Todo">- [ ] one\n- [ ] two\n- [ ] three\n- [ ] four</Note><Line from="Todo" to="Plan (totem) > Below"/></Add>'), state, opts);
  const top = box(state, 'Top'), below = box(state, 'Below'), note = box(state, 'Todo');
  const first = state.drawings.find((d) => d.text === 'first');
  assert.ok(note.minY >= first.y + 21 + M.GAP - 1, 'below the text already there');
  assert.ok(top.maxY > before.top.maxY && top.maxY >= note.maxY + M.BOTTOM, 'Top grew to hold it');
  assert.equal(below.minY - top.maxY, before.below.minY - before.top.maxY, 'Below was pushed down, keeping its gap');
  assert.equal(state.drawings.find((d) => d.text === 'under it').y - below.minY, M.TOP, 'with its text');
  assert.equal(out.boxes[0].address, 'Plan (totem) > Top > Todo (note)');
  const m = buildPlaces({ name: 'Thesis', state });
  assert.equal(m.places.get(out.boxes[0].id).address, out.boxes[0].address);
  assert.ok(m.wires.some((w) => w.from === out.boxes[0].id && w.to === state.areas.find((a) => a.name === 'Below').id), 'the Line reaches a box already on the canvas');

  // A box of the user's in the way: refused, and nothing is moved.
  const s2 = sampleState();
  layoutTotem(parseScript('<Canvas name="Thesis"><Totem name="Plan"><Area name="Top"><Text>first</Text></Area></Totem></Canvas>'), s2, opts);
  const t2 = box(s2, 'Top');
  s2.areas.push({ id: 'U', name: 'Mine', polygons: [rect(t2.minX, t2.maxY + 40, 200, 150)], parentAreaId: null, linkedTotemId: s2.totems.at(-1).id });
  assert.throws(() => layoutAdd(parseScript('<Add canvas="Thesis" at="Plan (totem) > Top"><Note name="Todo">- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d</Note></Add>'), s2, opts),
    (e) => e instanceof Refusal && /would push "Plan \(totem\) > Mine", which is the user's\. NoteX never moves the user's items/.test(e.message));
});

test('Add and Edit are refused outside the agent\'s own totem', () => {
  const state = sampleState();
  layoutTotem(parseScript('<Canvas name="Thesis"><Totem name="Plan"><Area name="Top"><Text>first</Text></Area></Totem></Canvas>'), state, opts);
  const add = (at) => () => layoutAdd(parseScript(`<Add canvas="Thesis" at="${at}"><Text>x</Text></Add>`), state, opts);
  assert.throws(add('RESEARCH (totem) > GAP PAPERS'), /in the user's totem RESEARCH - an agent writes only in its own totem/);
  assert.throws(add('Plan (totem) > Nowhere'), /no place on Thesis has the address "Plan \(totem\) > Nowhere". Your totems there: "Plan \(totem\)"/);
  assert.throws(() => layoutAdd(parseScript('<Add canvas="Thesis" at="Plan (totem) > Top"><Text>x</Text></Add>'), state, { owner: 'agent-b' }), /belongs to agent-a - an agent changes only its own totem/);
  assert.throws(() => layoutAdd(parseScript('<Add canvas="Thesis" at="Plan (totem)"><Area name="Top"/></Add>'), state, opts), /already holds something called "Top"/);
  assert.throws(() => layoutTotem(parseScript('<Canvas name="Thesis"><Totem name="plan"/></Canvas>'), state, opts), /a totem called "plan" is already on this canvas/);
  const edit = (id, by = opts) => () => layoutEdits(parseScript(`<Canvas name="Thesis"><Edit id="${id}">new</Edit></Canvas>`), state, by);
  assert.throws(edit('D1'), /is the user's - an agent changes only its own totem/);
  assert.throws(edit('nope'), /nothing on Thesis has the id nope/);
  // Added to the totem itself: below its boxes, clear of every other totem.
  const out = layoutAdd(parseScript('<Add canvas="Thesis" at="Plan (totem)"><Area name="Next"><Text>more</Text></Area></Add>'), state, opts);
  assert.ok(box(state, 'Next').minY >= box(state, 'Top').maxY + M.TOTEM_GAP);
  assert.equal(out.boxes[0].address, 'Plan (totem) > Next');
});

test("keeping totems apart goes by File Fabric's chain box: a 'draw' record it never shows refuses nothing (t-2c4db2d540)", () => {
  const plan = () => {
    const s = sampleState();
    layoutTotem(parseScript('<Canvas name="Thesis"><Totem name="Plan"><Area name="Top"><Text>first</Text></Area></Totem></Canvas>'), s, opts);
    return s;
  };
  const add = (s) => layoutAdd(parseScript('<Add canvas="Thesis" at="Plan (totem)"><Area name="Next"><Text>more</Text></Area></Add>'), s, opts);
  // Where Next lands, from a dry run.
  const dry = plan();
  add(dry);
  const nb = box(dry, 'Next'), top = box(dry, 'Top');
  const y = nb.maxY + 150;
  assert.ok(y - top.maxY > 300, 'the stroke is past the chain of what the totem already holds');

  // File Fabric's leftover from a drag in draw mode: start and end only, never drawn, never chained.
  const s1 = plan();
  s1.drawings.push({ id: 'GHOST', type: 'draw', start: { x: nb.minX, y }, end: { x: nb.maxX, y: y + 10 }, linkedTotemId: null, areaId: null });
  add(s1);
  assert.ok(box(s1, 'Next'), 'written beside the record');

  // A pencil stroke there is the user's, File Fabric chains it, so the Add is still refused.
  const s2 = plan();
  s2.drawings.push({ id: 'PEN', type: 'path', points: [{ x: nb.minX, y }, { x: nb.maxX, y: y + 10 }], linkedTotemId: null, areaId: null });
  assert.throws(() => add(s2), (e) => e instanceof Refusal && /within File Fabric's 300 px of/.test(e.message));
});

test('Edit: new words grow the boxes around them; a rename; a user-edited item is refused', () => {
  const state = sampleState();
  layoutTotem(parseScript('<Canvas name="Thesis"><Totem name="Plan"><Area name="Top"><Text>short</Text><Note name="Todo">- [ ] a</Note></Area></Totem></Canvas>'), state, opts);
  const text = state.drawings.find((d) => d.text === 'short');
  const note = state.areas.find((a) => a.name === 'Todo');
  const before = { top: box(state, 'Top'), note: box(state, 'Todo') };
  layoutEdits(parseScript(`<Canvas name="Thesis"><Edit id="${text.id}">${'many words here '.repeat(60)}</Edit><Edit id="${note.id}" name="Todo list">- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n- [ ] e\n- [ ] f\n- [ ] g</Edit></Canvas>`), state, opts);
  assert.match(text.text, /^many words here/);
  assert.equal(note.name, 'Todo list');
  assert.ok(box(state, 'Todo list').minY > before.note.minY, 'the note moved down for the longer text');
  assert.ok(box(state, 'Todo list').maxY - box(state, 'Todo list').minY > before.note.maxY - before.note.minY, 'and grew for its items');
  assert.ok(box(state, 'Top').maxY > before.top.maxY);
  assert.deepEqual(overlapsOf(checkCanvas(state, model(state)), new Set(state.areas.concat(state.drawings).filter((x) => x.writtenBy).map((x) => x.id))), []);
  const ledger = (item) => (item.id === text.id ? 'was edited by the user since it was written' : null);
  assert.throws(() => layoutEdits(parseScript(`<Canvas name="Thesis"><Edit id="${text.id}">again</Edit></Canvas>`), state, { ...opts, mayChange: ledger }), /was edited by the user since it was written/);
});

test('once File Fabric saves a real height, an overflowing text grows its box', () => {
  const state = sampleState();
  layoutTotem(parseScript('<Canvas name="Thesis"><Totem name="Plan"><Area name="Top"><Text>one line</Text><Text>second</Text></Area></Totem></Canvas>'), state, opts);
  const [a, b] = state.drawings.filter((d) => d.writtenBy === 'agent' && d.type === 'text');
  a._calculatedHeight = 300;
  const out = growOverflows(state, opts, [a.id]);
  assert.ok(out.touched.has(b.id), 'the text below moved');
  assert.ok(b.y >= a.y + 300 + M.GAP - 1);
  assert.ok(box(state, 'Top').maxY >= b.y + 21 + M.BOTTOM);
});

test('the overlap check: crossings, spills and files centred on x, y', () => {
  const state = {
    totems: [], links: [],
    areas: [
      { id: 'A', name: 'A', polygons: [rect(0, 0, 300, 300)] },
      { id: 'B', name: 'B', polygons: [rect(200, 200, 300, 300)] },
      { id: 'C', name: 'C', polygons: [rect(1000, 0, 300, 300)] },
    ],
    drawings: [
      { id: 'T1', type: 'text', text: 'spills out', x: 250, y: 20, width: 200, fontSize: 18, areaId: 'A' },
      { id: 'T2', type: 'text', text: 'inside C', x: 1040, y: 40, width: 100, fontSize: 18, areaId: 'C' },
    ],
    files: [{ id: 'F', name: 'pic.png', isImage: true, imageWidth: 100, imageHeight: 100, x: 1100, y: 70, areaId: 'C' }],
  };
  const found = checkCanvas(state, buildPlaces({ name: 'X', state }));
  const kinds = found.map((f) => `${f.kind}:${f.ids.join(',')}`).sort();
  assert.deepEqual(kinds, ['boxes:A,B', 'empty:B', 'fileText:F,T2', 'textSpills:T1,A'].sort());
  // Only what a layout touched counts against it; what was there before does not.
  assert.deepEqual(overlapsOf(found, new Set(['F'])).map((f) => f.kind), ['fileText']);
  assert.deepEqual(overlapsOf(found, new Set(['F']), found), []);
  assert.equal(lineBetween({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, { minX: 200, minY: 50, maxX: 300, maxY: 150 }).start.y, 75);
});

test('Remove takes off an agent\'s own item, with what is inside it and the wires joining it', () => {
  const state = sampleState();
  layoutTotem(parseScript(`<Canvas name="Thesis"><Totem name="Plan"><Row><Area name="A"><Note name="Na">- [ ] a</Note></Area><Area name="B"><Text>b</Text></Area><Area name="C"/></Row>
    <Line from="A" to="B"/><Link from="B" to="C"/></Totem></Canvas>`), state, opts);
  const id = (name) => state.areas.find((a) => a.name === name).id;
  const line = state.drawings.find((d) => d.type === 'line' && d.writtenBy === 'agent');
  const sizes = { A: box(state, 'A'), C: box(state, 'C') };
  // A Line alone - even after File Fabric's save has cleared its totem (t-3bfb83748d).
  line.linkedTotemId = null;
  layoutEdits(parseScript(`<Canvas name="Thesis"><Remove id="${line.id}"/></Canvas>`), state, opts);
  assert.ok(!state.drawings.includes(line));
  assert.ok(state.areas.some((a) => a.name === 'B'), 'the boxes it joined stay');
  // A box: its text and the Link to C go with it; the boxes left keep their size.
  const out = layoutEdits(parseScript(`<Canvas name="Thesis"><Remove id="${id('B')}"/></Canvas>`), state, opts);
  assert.equal(out.removed.length, 3);
  assert.ok(!state.areas.some((a) => a.name === 'B'));
  assert.ok(!state.drawings.some((d) => d.text === 'b'));
  assert.equal(state.links.filter((l) => l.writtenBy === 'agent').length, 0);
  assert.deepEqual([box(state, 'A'), box(state, 'C')], [sizes.A, sizes.C]);
  assert.equal(state.links.length, 1, "the user's link stays");
  // The whole totem.
  const totem = state.totems.find((t) => t.name === 'Plan');
  layoutEdits(parseScript(`<Canvas name="Thesis"><Remove id="${totem.id}"/></Canvas>`), state, opts);
  assert.ok(!state.totems.includes(totem));
  assert.equal([...state.areas, ...state.drawings].filter((x) => x.writtenBy === 'agent').length, 0);
  assert.deepEqual(model(state).places.get('A1').address, 'RESEARCH (totem) > GAP PAPERS', "the user's canvas is as it was");
});

test("Remove is refused for the user's items, what the user edited or added, and another agent's", () => {
  const state = sampleState();
  const laid = layoutTotem(parseScript('<Canvas name="Thesis"><Totem name="Plan"><Area name="A"><Note name="Na">- [ ] a</Note></Area><Area name="B"/></Totem></Canvas>'), state, opts);
  const remove = (id, by = opts) => () => layoutEdits(parseScript(`<Canvas name="Thesis"><Remove id="${id}"/></Canvas>`), state, by);
  const a = state.areas.find((x) => x.name === 'A'), na = state.areas.find((x) => x.name === 'Na'), b = state.areas.find((x) => x.name === 'B');
  assert.throws(remove('A1'), /is the user's - an agent removes only from its own totem/);
  assert.throws(remove('L1'), /the link from "HOME \(totem\) > Progress" to "RESEARCH \(totem\) > GAP PAPERS" is the user's/);
  assert.throws(remove(a.id, { owner: 'agent-b' }), /in agent-a's totem Plan - an agent removes only from its own totem/);
  // The user ticked the note: the note is kept, and so is the box holding it.
  const edited = { ...opts, mayChange: (item) => (item.id === na.id ? 'was edited by the user since it was written' : item.writtenBy === 'agent' ? null : "is the user's") };
  assert.throws(remove(na.id, edited), /"Plan \(totem\) > A > Na \(note\)" was edited by the user since it was written - it is not removed/);
  assert.throws(remove(a.id, edited), /removing "Plan \(totem\) > A" would take "Plan \(totem\) > A > Na \(note\)" with it, which was edited by the user since it was written\. Nothing was removed/);
  // The user wrote in the agent's box B.
  const bb = box(state, 'B');
  state.drawings.push({ id: 'U1', type: 'text', text: 'mine', x: bb.minX + 39, y: bb.minY + 80, areaId: b.id, linkedTotemId: laid.totemId });
  assert.throws(remove(b.id), /would take the text "mine" with it, which is the user's/);
  assert.equal(state.areas.length, sampleState().areas.length + 3, 'nothing was removed');
  assert.throws(remove('nope'), /nothing on Thesis has the id nope/);
});
