/* A <Link> into another totem, by the box's full address: on the user's
 * canvases and on agent canvases, where it is drawn once every totem is
 * (t-0fcfbf7f54, t-d26992551e, t-495f823875, t-10924e08dd). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseScript, ScriptError } from '../engine/lib/script.js';
import { layoutTotem, layoutAdd, layoutEdits, Refusal } from '../engine/lib/layout.js';
import { buildPlaces } from '../engine/lib/places.js';
import { readOut } from '../engine/lib/readout.js';
import { Writer } from '../engine/lib/writer.js';
import { Bronze } from '../engine/lib/bronze.js';
import { AgentCanvases } from '../engine/lib/agentcanvas.js';
import { readFabric } from '../engine/lib/fabric.js';
import { sampleState } from './fixtures.js';

const opts = { owner: 'agent-a' };
const placeId = (state, address) => [...buildPlaces({ name: 'T', state }).places.values()].find((p) => p.address === address).id;
const PARTS = (to) => `<Canvas name="T"><Totem name="Parts"><Area name="Binding a repository"><Text>how a repo is bound</Text></Area><Link from="Binding a repository" to="${to}"/></Totem></Canvas>`;

test('the script: a <Link> end outside the script must be a full address; a <Line> one is not taken', () => {
  assert.doesNotThrow(() => parseScript(PARTS('RESEARCH (totem) > DATASETS')));
  assert.throws(() => parseScript(PARTS('DATASETS')), (e) => e instanceof ScriptError && /in this script - a box in another totem is named by its full address/.test(e.message));
  assert.throws(() => parseScript('<Canvas name="T"><Totem name="P"><Area name="A"/><Line from="A" to="RESEARCH (totem) > DATASETS"/></Totem></Canvas>'), /names no <Area>, <Note> or <ScrollBox> in this script\./);
});

test('on the user\'s canvas a totem links its box to a box in the user\'s totem, which is left as it was', () => {
  const state = sampleState();
  const datasets = placeId(state, 'RESEARCH (totem) > DATASETS');
  const was = JSON.stringify(state.areas.find((a) => a.id === datasets));
  const out = layoutTotem(parseScript(PARTS('RESEARCH (totem) > DATASETS')), state, opts);
  const box = placeId(state, 'Parts (totem) > Binding a repository');
  const link = state.links.find((l) => l.writtenBy === 'agent');
  assert.deepEqual([link.fromAreaId, link.toAreaId], [box, datasets]);
  assert.ok(out.written.includes(link.id));
  assert.equal(JSON.stringify(state.areas.find((a) => a.id === datasets)), was, 'the user\'s box is not changed');
  // The labels may be left out; a note is a box too.
  const s2 = sampleState();
  layoutTotem(parseScript(PARTS('RESEARCH > GAP PAPERS > LITERATURE SURVEY > SURVEY TODO')), s2, opts);
  assert.equal(s2.links.find((l) => l.writtenBy === 'agent').toAreaId, placeId(s2, 'RESEARCH (totem) > GAP PAPERS > LITERATURE SURVEY > SURVEY TODO (note)'));
  // notex_read shows the link beside the box, by the other end's address.
  assert.match(readOut({ name: 'T', state }), /RESEARCH \(totem\) > DATASETS/);
});

test('refused: an address that names nothing, and a <Line> into another totem; <Add> takes a link', () => {
  assert.throws(() => layoutTotem(parseScript(PARTS('RESEARCH (totem) > NOWHERE')), sampleState(), opts), (e) => e instanceof Refusal && /names no box in this script and no area/.test(e.message));
  // Two boxes of one name are told apart by the address notex_read gives each.
  const twin = sampleState();
  layoutTotem(parseScript(PARTS('RESEARCH > GAP PAPERS > METHODS [2]')), twin, opts);
  assert.equal(twin.links.find((l) => l.writtenBy === 'agent').toAreaId, placeId(twin, 'RESEARCH (totem) > GAP PAPERS > METHODS [2]'));
  const state = sampleState();
  layoutTotem(parseScript('<Canvas name="T"><Totem name="Parts"><Area name="A"><Text>x</Text></Area></Totem></Canvas>'), state, opts);
  assert.throws(() => layoutAdd(parseScript('<Add canvas="T" at="Parts (totem)"><Area name="B"><Text>y</Text></Area><Line from="B" to="RESEARCH (totem) > DATASETS"/></Add>'), state, opts),
    (e) => e instanceof Refusal && /a <Line> is drawn inside one totem; join a box in another totem with <Link>/.test(e.message));
  // <Add> takes a link into another totem too.
  layoutAdd(parseScript('<Add canvas="T" at="Parts (totem)"><Area name="C"><Text>z</Text></Area><Link from="C" to="RESEARCH (totem) > DATASETS"/></Add>'), state, opts);
  assert.equal(state.links.filter((l) => l.writtenBy === 'agent').length, 1);
});

test('<Remove> takes the agent\'s link from either end it owns; the user\'s box stays', () => {
  const state = sampleState();
  layoutTotem(parseScript('<Canvas name="T"><Totem name="Parts"><Area name="A"><Text>x</Text></Area><Link from="RESEARCH (totem) > DATASETS" to="A"/></Totem></Canvas>'), state, opts);
  const link = state.links.find((l) => l.writtenBy === 'agent');
  const out = layoutEdits(parseScript(`<Canvas name="T"><Remove id="${link.id}"/></Canvas>`), state, opts);
  assert.deepEqual(out.removed, [link.id]);
  assert.ok(placeId(state, 'RESEARCH (totem) > DATASETS'));
  // Removing the agent's box takes the link joining it.
  layoutTotem(parseScript(PARTS('RESEARCH (totem) > DATASETS').replace('"Parts"', '"Parts B"')), state, { owner: 'agent-b' });
  const b = state.links.find((l) => l.writtenBy === 'agent');
  const r = layoutEdits(parseScript(`<Canvas name="T"><Remove id="${placeId(state, 'Parts B (totem) > Binding a repository')}"/></Canvas>`), state, { owner: 'agent-b' });
  assert.ok(r.removed.includes(b.id));
});

function agentSetup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-cross-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws');
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(ws, 'Board'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'Board', 'fabric.json'), JSON.stringify({ drawings: [], areas: [], files: [], links: [], totems: [], tables: [] }));
  fs.writeFileSync(path.join(ws, 'Board', 'agent.json'), '{}');
  const writer = new Writer({ config: { workspace: ws }, dataDir: data, log: () => {} });
  const agent = new AgentCanvases({ dataDir: data, writer, bronze: new Bronze(data), log: () => {} });
  writer.agent = agent;
  const send = (script) => writer.submit({ script, owner: 'claude-a' });
  const state = () => readFabric(path.join(ws, 'Board')).state;
  const id = (address) => placeId(state(), address);
  return { send, state, id, writer, agent };
}
const T = (name, body) => `<Canvas name="Board"><Totem name="${name}">${body}</Totem></Canvas>`;

test('on an agent canvas a totem links to one drawn before it, and to one drawn after it', async (t) => {
  const { send, state, id, agent } = agentSetup(t);
  assert.equal((await send(T('Plan', '<Area name="1. Sources"><Text>where things come from</Text></Area>'))).status, 'written');
  const parts = await send(T('Parts', '<Area name="Binding a repository"><Text>bind it</Text></Area><Link from="Binding a repository" to="Plan (totem) > 1. Sources"/>'));
  assert.equal(parts.status, 'written', JSON.stringify(parts.result));
  const link = () => state().links.find((l) => l.fromAreaId === id('Parts (totem) > Binding a repository'));
  assert.equal(link().toAreaId, id('Plan (totem) > 1. Sources'));
  // Plan is drawn first; a link from it to Parts, drawn after it, is joined once both are drawn.
  const plan = await send(agent.scripts('Board')[0].script.replace('</Totem>', '<Link from="1. Sources" to="Parts (totem) > Binding a repository"/></Totem>'));
  assert.equal(plan.status, 'written', JSON.stringify(plan.result));
  assert.equal(state().links.length, 2);
  assert.ok(link(), 'every render draws them again');
});

test('on an agent canvas a link whose other end is gone: a new script is refused, a kept one draws without it', async (t) => {
  const { send, state, agent } = agentSetup(t);
  await send(T('Plan', '<Area name="1. Sources"><Text>s</Text></Area>'));
  const missing = await send(T('Parts', '<Area name="A"><Text>a</Text></Area><Link from="A" to="Plan (totem) > 9. Nowhere"/>'));
  assert.equal(missing.status, 'refused');
  assert.match(missing.result.message, /names no box in this script and no area/);
  await send(T('Parts', '<Area name="A"><Text>a</Text></Area><Link from="A" to="Plan (totem) > 1. Sources"/>'));
  // Plan's box is renamed: Parts still draws, without its link, and says so.
  const plan = agent.scripts('Board').find((s) => s.name === 'Plan').script.replace('1. Sources', '1. Inputs');
  const r = await send(plan);
  assert.equal(r.status, 'written', JSON.stringify(r.result));
  const parts = r.result.totems.find((x) => x.totem === 'Parts');
  assert.equal(parts.drawn, 'current');
  assert.match(parts.errors.join(' '), /a link was left out: .*Plan \(totem\) > 1\. Sources/);
  assert.equal(state().links.length, 0);
});
