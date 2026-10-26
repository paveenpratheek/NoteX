/* A canvas read out as a script: ids and owners, nested in reading order,
 * no coordinates, no Row or Column guessed (t-12859aa2fb, t-bb0a5fdf1f). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOut } from '../engine/lib/readout.js';
import { parseScript } from '../engine/lib/script.js';
import { layoutTotem } from '../engine/lib/layout.js';
import { fingerprint } from '../engine/lib/writer.js';
import { sampleFabric, sampleState } from './fixtures.js';

test("the user's canvas, totem by totem: ids, owners, nesting and reading order, wires by address", () => {
  const out = readOut(sampleFabric());
  assert.match(out, /^<Canvas name="Thesis">\n {2}<Totem name="RESEARCH" id="T1" owner="user">\n/);
  // GAP PAPERS holds the survey above the two METHODS boxes and the text below them, in that order.
  const gap = out.slice(out.indexOf('<Area name="GAP PAPERS"'), out.indexOf('<Area name="DATASETS"'));
  const order = ['LITERATURE SURVEY', 'name="METHODS" id="A3"', 'name="METHODS" id="A4"', '<Text id="D1">', 'OLD CORNER'].map((s) => gap.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((i) => i > 0));
  assert.match(out, /<Note name="SURVEY TODO" id="N1">\n {10}# Reading\n {10}- \[x\] SAR review/);
  assert.match(out, /<Text id="D1">\n {8}Need for orthorectification\n {8}&amp; more\n {6}<\/Text>/);
  assert.match(out, /<File path="survey-2024.pdf" id="F-a" kind="PDF"\/>/);
  assert.match(out, /<ScrollBox name="Dashboard" id="S1">\n {6}<Page id="P1">/);
  assert.match(out, / {2}<Link from="HOME \(totem\) > Progress" to="RESEARCH \(totem\) > GAP PAPERS" id="L1"\/>/);
  assert.match(out, / {2}<Text id="D8">loose words<\/Text>\n/, 'what is outside every totem sits under the canvas');
  assert.doesNotMatch(out, /\b[xy]="|Row|Column|polygons/);
});

test('one place with at; an unknown address gives nothing', () => {
  const one = readOut(sampleFabric(), { at: 'research (totem) >  gap papers > literature survey' });
  assert.match(one, /^<Canvas name="Thesis">\n {2}<Area name="LITERATURE SURVEY" id="A2">/);
  assert.match(one, /<Line from="HOME \(totem\) > Progress" to="RESEARCH \(totem\) > GAP PAPERS > LITERATURE SURVEY > SURVEY TODO \(note\)" id="D6"\/>/);
  assert.doesNotMatch(one, /METHODS/);
  assert.equal(readOut(sampleFabric(), { at: 'Nowhere' }), null);
});

test("an agent's totem says whose it is, what the user added and what the user edited", () => {
  const state = sampleState();
  const laid = layoutTotem(parseScript('<Canvas name="Thesis"><Totem name="Plan"><Area name="Top"><Text>first &amp; best</Text><Note name="Todo">- [ ] a</Note></Area></Totem></Canvas>'), state, { owner: 'agent-a' });
  const ledger = { items: {} };
  for (const x of [...state.areas, ...state.drawings]) if (laid.written.includes(x.id)) ledger.items[x.id] = { print: fingerprint(x) };
  const top = state.areas.find((a) => a.name === 'Top');
  const note = state.areas.find((a) => a.name === 'Todo');
  note.textContent = '- [x] a'; // the user ticked it
  state.drawings.push({ id: 'U1', type: 'text', text: 'mine', x: top.polygons[0][0].x + 39, y: top.polygons[0][2].y - 30, areaId: top.id, linkedTotemId: laid.totemId });
  const out = readOut({ name: 'Thesis', state }, { ledger });
  const plan = out.slice(out.indexOf('<Totem name="Plan"'));
  assert.match(plan, new RegExp(`^<Totem name="Plan" id="${laid.totemId}" owner="agent-a">`));
  assert.match(plan, new RegExp(`<Area name="Top" id="${top.id}">`));
  assert.match(plan, /<Text id="[^"]+">first &amp; best<\/Text>/);
  assert.match(plan, new RegExp(`<Note name="Todo" id="${note.id}" edited="by the user">- \\[x\\] a</Note>`));
  assert.match(plan, /<Text id="U1" owner="user">mine<\/Text>/);
  // What it reads can be sent back only once its ids and owners are gone (t-bb0a5fdf1f).
  assert.throws(() => parseScript(plan.slice(0, plan.indexOf('</Totem>') + 8).replace(/^/, '<Canvas name="X">') + '</Canvas>'), /takes no id/);
});
