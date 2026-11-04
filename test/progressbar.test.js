/* <ProgressBarLink>: a progress bar written in a box, aimed at a note, with
 * the box linked to the note when nothing joins them yet (t-abc2613a64,
 * t-276c70f71d). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, ScriptError } from '../engine/lib/script.js';
import { layoutTotem, layoutAdd, layoutEdits, Refusal } from '../engine/lib/layout.js';
import { barNotes, reachedNotes, checklist } from '../engine/lib/wires.js';
import { readOut } from '../engine/lib/readout.js';
import { buildPlaces } from '../engine/lib/places.js';
import { visualBox, M } from '../engine/lib/measure.js';
import { areaBBox } from '../engine/lib/geometry.js';
import { sampleState } from './fixtures.js';

const opts = { owner: 'agent-a' };
const area = (state, name) => state.areas.find((a) => a.name === name);
const bars = (state) => state.drawings.filter((d) => d.type === 'progress_bar' && d.writtenBy === 'agent');
const inside = (inner, outer) => inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;

const PLAN = `<Canvas name="Thesis"><Totem name="Plan">
  <Row>
    <Area name="Work"><Note name="Todo">- [x] find papers
- [ ] read them
- [ ] write</Note></Area>
    <Area name="Status"><ProgressBarLink>Todo</ProgressBarLink></Area>
  </Row>
</Totem></Canvas>`;

test('the script: a bar goes in a box and names a note in the script', () => {
  const p = parseScript(PLAN);
  const bar = p.totem.children[0].children[1].children[0];
  assert.equal(bar.tag, 'ProgressBarLink');
  assert.equal(bar.note.attrs.name, 'Todo');
  // The closing tag's case does not matter, as the user wrote it.
  assert.doesNotThrow(() => parseScript('<Canvas name="T"><Totem name="P"><Area name="S"><ProgressBarLink>N</ProgressbarLink></Area><Note name="N">- [ ] a</Note></Totem></Canvas>'));
  const refused = (src, re) => assert.throws(() => parseScript(src), (e) => e instanceof ScriptError && re.test(e.message));
  refused('<Canvas name="T"><Totem name="P"><ProgressBarLink>N</ProgressBarLink><Note name="N">- [ ] a</Note></Totem></Canvas>', /cannot go inside <Totem> - put it inside the <Area> it should show in/);
  refused('<Canvas name="T"><Totem name="P"><Area name="S"><ProgressBarLink>Nope</ProgressBarLink></Area></Totem></Canvas>', /"Nope" names no <Note> in this script/);
  refused('<Canvas name="T"><Totem name="P"><Area name="S"><ProgressBarLink>W</ProgressBarLink></Area><Area name="W"/></Totem></Canvas>', /"W" is an <Area>, not a <Note>/);
  refused('<Canvas name="T"><Totem name="P"><Area name="S"><ProgressBarLink>N</ProgressBarLink></Area><Area name="A"><Note name="N">- [ ] a</Note></Area><Area name="B"><Note name="N">- [ ] b</Note></Area></Totem></Canvas>', /fits 2 notes .* name it by its path, e.g. "A > N"/);
  refused('<Canvas name="T"><Totem name="P"><Area name="S"><ProgressBarLink> </ProgressBarLink></Area></Totem></Canvas>', /<ProgressBarLink> is empty/);
  // A path, or a read-out's full address, picks one of two.
  assert.doesNotThrow(() => parseScript('<Canvas name="T"><Totem name="P"><Area name="S"><ProgressBarLink>P (totem) > B > N (note)</ProgressBarLink></Area><Area name="A"><Note name="N">- [ ] a</Note></Area><Area name="B"><Note name="N">- [ ] b</Note></Area></Totem></Canvas>'));
});

test("a bar in its box, aimed at the note, and the box linked to it - what File Fabric's bar then shows", () => {
  const state = sampleState();
  const userLinks = state.links.length;
  const out = layoutTotem(parseScript(PLAN), state, opts);
  const [bar] = bars(state);
  const status = area(state, 'Status'), todo = area(state, 'Todo');
  assert.equal(bar.width, M.BAR_W);
  assert.equal(bar.areaId, status.id);
  assert.equal(bar.targetNoteId, todo.id);
  assert.ok(inside(visualBox(bar, 'drawing'), areaBBox(status)), 'the bar and the line above it sit inside Status');
  // The link the user would have drawn by hand.
  const link = state.links.find((l) => l.id === bar.linkId);
  assert.ok(link && link.fromAreaId === status.id && link.toAreaId === todo.id && link.writtenBy === 'agent');
  assert.equal(state.links.length, userLinks + 1);
  assert.ok(out.written.includes(bar.id) && out.written.includes(link.id));
  // File Fabric's own pick: the walk from Status reaches Todo, and the bar shows 1 of 3.
  const shown = barNotes(bar, state);
  assert.equal(shown.area.id, status.id);
  assert.deepEqual(shown.notes.map((n) => n.id), [todo.id]);
  assert.deepEqual(checklist(shown.notes[0].textContent), { done: 1, total: 3 });
});

test('no extra link when the box already reaches the note: the note inside it, or a Link the script wrote', () => {
  const a = sampleState();
  layoutTotem(parseScript('<Canvas name="T"><Totem name="P"><Area name="Box"><Note name="Todo">- [ ] a</Note><ProgressBarLink>Todo</ProgressBarLink></Area></Totem></Canvas>'), a, opts);
  assert.equal(bars(a)[0].linkId, undefined);
  assert.equal(a.links.filter((l) => l.writtenBy === 'agent').length, 0);
  assert.deepEqual(barNotes(bars(a)[0], a).notes.map((n) => n.name), ['Todo']);

  const b = sampleState();
  layoutTotem(parseScript('<Canvas name="T"><Totem name="P"><Row><Area name="Work"><Note name="Todo">- [ ] a</Note></Area><Area name="Status"><ProgressBarLink>Todo</ProgressBarLink></Area></Row><Link from="Status" to="Work"/></Totem></Canvas>'), b, opts);
  assert.equal(bars(b)[0].linkId, undefined);
  assert.equal(b.links.filter((l) => l.writtenBy === 'agent').length, 1, 'only the Link the script wrote');
  assert.ok(reachedNotes(area(b, 'Status').id, b).some((n) => n.name === 'Todo'));
});

test('two bars in one box, each showing its own note', () => {
  const state = sampleState();
  layoutTotem(parseScript(`<Canvas name="T"><Totem name="P"><Row>
    <Area name="Read"><Note name="Reading">- [x] a
- [ ] b</Note></Area>
    <Area name="Write"><Note name="Writing">- [ ] c</Note></Area>
    <Area name="Status"><ProgressBarLink>Writing</ProgressBarLink><ProgressBarLink>Reading</ProgressBarLink></Area>
  </Row></Totem></Canvas>`), state, opts);
  const [first, second] = bars(state);
  assert.ok(second.y > first.y + M.BAR_H, 'stacked');
  // By targetNoteId, not File Fabric's top-to-bottom guess, which would swap them.
  assert.deepEqual(barNotes(first, state).notes.map((n) => n.name), ['Writing']);
  assert.deepEqual(barNotes(second, state).notes.map((n) => n.name), ['Reading']);
  assert.equal(state.links.filter((l) => l.writtenBy === 'agent').length, 2);
});

test('Add: a bar for a note already on the canvas, by name or address', () => {
  const state = sampleState();
  layoutTotem(parseScript('<Canvas name="Thesis"><Totem name="Plan"><Row><Area name="Work"><Note name="Todo">- [ ] a</Note></Area><Area name="Status"><Text>How it goes</Text></Area></Row></Totem></Canvas>'), state, opts);
  layoutAdd(parseScript('<Add canvas="Thesis" at="Plan (totem) > Status"><ProgressBarLink>Plan (totem) > Work > Todo (note)</ProgressBarLink></Add>'), state, opts);
  const [bar] = bars(state);
  assert.equal(bar.targetNoteId, area(state, 'Todo').id);
  assert.ok(inside(visualBox(bar, 'drawing'), areaBBox(area(state, 'Status'))), 'Status grew to hold it');
  assert.deepEqual(barNotes(bar, state).notes.map((n) => n.name), ['Todo']);
  assert.throws(() => layoutAdd(parseScript('<Add canvas="Thesis" at="Plan (totem) > Status"><ProgressBarLink>Missing</ProgressBarLink></Add>'), state, opts),
    (e) => e instanceof Refusal && /"Missing" names no note in this script or on the canvas/.test(e.message));
  // A note in the user's totem is not the agent's to link.
  assert.throws(() => layoutAdd(parseScript('<Add canvas="Thesis" at="Plan (totem) > Status"><ProgressBarLink>LITERATURE SURVEY</ProgressBarLink></Add>'), state, opts),
    (e) => e instanceof Refusal && /no note|another totem/.test(e.message));
  // Straight in a totem, a bar has no box to find its notes from.
  assert.throws(() => layoutAdd(parseScript('<Add canvas="Thesis" at="Plan (totem)"><ProgressBarLink>Todo</ProgressBarLink></Add>'), state, opts),
    (e) => e instanceof Refusal && /goes inside an <Area>/.test(e.message));
});

test('Remove: the bar takes its link; the note takes its bars; Edit says what to do instead', () => {
  const state = sampleState();
  layoutTotem(parseScript(PLAN), state, opts);
  let [bar] = bars(state);
  assert.throws(() => layoutEdits(parseScript(`<Canvas name="Thesis"><Edit id="${bar.id}">Other</Edit></Canvas>`), state, opts),
    (e) => e instanceof Refusal && /<Remove> it and <Add> a new <ProgressBarLink>/.test(e.message));
  const out = layoutEdits(parseScript(`<Canvas name="Thesis"><Remove id="${bar.id}"/></Canvas>`), state, opts);
  assert.deepEqual(out.removed.sort(), [bar.id, bar.linkId].sort());
  assert.ok(area(state, 'Todo') && area(state, 'Status'), 'the boxes stay');

  const s2 = sampleState();
  layoutTotem(parseScript(PLAN), s2, opts);
  [bar] = bars(s2);
  layoutEdits(parseScript(`<Canvas name="Thesis"><Remove id="${area(s2, 'Todo').id}"/></Canvas>`), s2, opts);
  assert.equal(bars(s2).length, 0, 'a bar left showing nothing goes with its note');
  assert.ok(!s2.links.some((l) => l.id === bar.linkId));
});

test('notex_read shows each bar in its box with the note File Fabric shows on it', () => {
  const state = sampleState();
  layoutTotem(parseScript(PLAN), state, opts);
  const [bar] = bars(state);
  const text = readOut({ name: 'Thesis', state });
  assert.match(text, new RegExp(`<Area name="Status" id="${area(state, 'Status').id}">\\s*<ProgressBarLink id="${bar.id}">Plan \\(totem\\) > Work > Todo \\(note\\)</ProgressBarLink>\\s*</Area>`));
  // What it reads out goes back in as a script.
  const again = text.replace(/ id="[^"]*"| owner="[^"]*"/g, '').replace(/<Totem name="RESEARCH"[\s\S]*?<\/Totem>\n/, '');
  assert.match(again, /<ProgressBarLink>Plan \(totem\) > Work > Todo \(note\)<\/ProgressBarLink>/);
  // A bar of the user's that reaches nothing says so.
  state.drawings.push({ id: 'ub', type: 'progress_bar', x: 99999, y: 99999, width: 300, height: 20 });
  assert.match(readOut({ name: 'Thesis', state }), /<ProgressBarLink id="ub"\/> <!-- reaches no note/);
  // A box holding only a bar is not an empty box.
  assert.ok(buildPlaces({ name: 'Thesis', state }).places.get(area(state, 'Status').id).bars.includes(bar.id));
});
