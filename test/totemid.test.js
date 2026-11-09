/* A totem's lasting id on an agent canvas: a new totem's file is named from
 * it, its scripts carry it as <Totem id>, a script with it replaces that
 * totem so a new name renames it in the same file, and a totem made before
 * ids keeps its file (t-a484b5d0de, t-8464839f1d, t-1e19478c43,
 * t-6dd60cbf5f, t-eed42f9e1c, t-adc221f8f3). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Writer } from '../engine/lib/writer.js';
import { Bronze } from '../engine/lib/bronze.js';
import { AgentCanvases, scriptFile, TOTEM_ID } from '../engine/lib/agentcanvas.js';
import { History } from '../engine/lib/history.js';
import { checkArrangement } from '../engine/lib/arranger.js';
import { readFabric } from '../engine/lib/fabric.js';
import { buildPlaces } from '../engine/lib/places.js';
import { parseScript, ScriptError } from '../engine/lib/script.js';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-ids-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws');
  const data = path.join(root, 'data');
  for (const name of ['Board', 'Mine']) {
    fs.mkdirSync(path.join(ws, name), { recursive: true });
    fs.writeFileSync(path.join(ws, name, 'fabric.json'), JSON.stringify({ drawings: [], areas: [], files: [], links: [], totems: [], tables: [] }));
  }
  fs.writeFileSync(path.join(ws, 'Board', 'agent.json'), '{}');
  const config = { workspace: ws };
  let clock = Date.parse('2026-11-09T10:00:00.000Z');
  const now = () => (clock += 1); // a write and its activity entry come milliseconds apart, as in use
  const writer = new Writer({ config, dataDir: data, log: () => {} });
  const agent = new AgentCanvases({ dataDir: data, writer, bronze: new Bronze(data), log: () => {}, now });
  writer.agent = agent;
  const send = (script, owner = 'claude-a') => writer.submit({ script, owner });
  const dir = path.join(data, 'agent-canvases', 'Board');
  const layout = () => JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8')).totems;
  const places = (canvas = 'Board') => [...buildPlaces(readFabric(path.join(ws, canvas))).places.values()].map((p) => p.address).filter(Boolean);
  return { ws, data, config, writer, agent, send, dir, layout, places, now };
}
const totem = (name, body, id = null) => `<Canvas name="Board"><Totem${id ? ` id="${id}"` : ''} name="${name}">${body}</Totem></Canvas>`;
const BODY = '<Area name="Box"><Note name="N">- [ ] one</Note></Area>';

test('a new totem gets a lasting id, its file is named from it, and its scripts carry it', async (t) => {
  const { send, layout, dir, agent } = setup(t);
  assert.equal((await send(totem('Plan', BODY))).status, 'written');
  const [e] = layout();
  assert.match(e.id, TOTEM_ID);
  assert.equal(e.file, `${e.id}.totem`);
  const stored = fs.readFileSync(path.join(dir, e.file), 'utf8');
  assert.ok(stored.startsWith(`<Canvas name="Board"><Totem id="${e.id}" name="Plan">`));
  assert.equal(agent.scripts('Board')[0].id, e.id);
  assert.match(agent.scripts('Board')[0].script, new RegExp(`<Totem id="${e.id}" name="Plan">`));
  // An agent canvas's id goes back in through the parser; a read-out's File Fabric id still does not (t-bb0a5fdf1f).
  assert.equal(parseScript(totem('Plan', BODY, e.id)).totem.attrs.id, e.id);
  assert.throws(() => parseScript(totem('Plan', BODY, '17931171879780a4eafe')), (x) => x instanceof ScriptError && /takes no id/.test(x.message));
});

test('a script with the id and a new name renames the totem: one changed line in the same file', async (t) => {
  const { send, layout, dir, places, agent } = setup(t);
  await send(totem('Plan', BODY));
  const [{ id, file }] = layout();
  const r = await send(totem('Roadmap', BODY, id), 'claude-b');
  assert.equal(r.status, 'written', JSON.stringify(r.result));
  assert.deepEqual(layout().map((x) => [x.id, x.name, x.file]), [[id, 'Roadmap', file]]);
  assert.ok(places().includes('Roadmap (totem) > Box > N (note)'));
  assert.ok(!places().some((a) => a.startsWith('Plan (totem)')), 'no second totem beside it');
  // The old script is among the same file's versions, and differs by its <Totem> line only.
  const vdir = path.join(dir, 'versions', file.replace(/\.totem$/, ''));
  const [was] = fs.readdirSync(vdir).map((f) => fs.readFileSync(path.join(vdir, f), 'utf8'));
  const now = fs.readFileSync(path.join(dir, file), 'utf8');
  assert.equal(was.replace('name="Plan"', 'name="Roadmap"'), now);
  assert.deepEqual(agent.activity('Board').filter((a) => a.what === 'renamed').map((a) => [a.from, a.to, a.id]), [['Plan', 'Roadmap', id]]);
  // Without the id, a script still finds its totem by name, as before ids.
  await send(totem('Roadmap', '<Area name="Box"><Note name="N">- [x] one</Note></Area>'));
  assert.deepEqual(layout().map((x) => x.file), [file]);
});

test('a totem made before ids keeps its file, and its worked-out id renames it there', async (t) => {
  const { send, layout, dir, agent, writer } = setup(t);
  // As NoteX kept it before: a file named from the totem's name, no id anywhere.
  fs.mkdirSync(dir, { recursive: true });
  const old = scriptFile('Old plan');
  fs.writeFileSync(path.join(dir, old), totem('Old plan', BODY));
  fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify({ totems: [{ name: 'Old plan', file: old, owner: 'claude-a', at: null, drops: [] }] }));
  await writer.serial(() => agent.render('Board'));
  const id = agent.scripts('Board')[0].id;
  assert.match(id, TOTEM_ID);
  assert.equal(agent.scripts('Board')[0].id, id, 'the same id at every read');
  assert.equal(fs.readFileSync(path.join(dir, old), 'utf8'), totem('Old plan', BODY), 'its file is not touched by reading');
  assert.equal((await send(totem('New plan', BODY, id))).status, 'written');
  assert.deepEqual(layout().map((x) => [x.id, x.name, x.file]), [[id, 'New plan', old]]);
});

test('refused: an id that names no totem, a rename onto another totem\'s name, two scripts for one totem, and <Totem id> on the user\'s canvas', async (t) => {
  const { send, layout, writer, agent } = setup(t);
  await send(totem('Plan', BODY));
  await send(totem('Ideas', BODY));
  const [plan] = layout();
  const nobody = await send(totem('Plan', BODY, 'tm-0000000000'));
  assert.equal(nobody.status, 'refused');
  assert.match(nobody.result.message, /no totem on Board has the id tm-0000000000/);
  const clash = await send(totem('Ideas', BODY, plan.id));
  assert.equal(clash.status, 'refused');
  assert.match(clash.result.message, /cannot be renamed "Ideas": another totem on Board is called that/);
  await assert.rejects(() => writer.serial(() => agent.render('Board', { overrides: [{ name: 'Plan', id: plan.id, script: totem('Plan', BODY, plan.id), owner: 'a' }, { name: 'Plan', script: totem('Plan', BODY), owner: 'a' }] })), /came twice/);
  const mine = await writer.submit({ script: '<Canvas name="Mine"><Totem id="tm-0123456789" name="T"><Text>x</Text></Totem></Canvas>', owner: 'claude-a' });
  assert.equal(mine.status, 'refused');
  assert.match(mine.result.message, /<Totem id> is only for agent canvases/);
});

test('the chat agent may rename a totem by its id, and a rename cannot hide a lost note', () => {
  const before = [{ id: 'tm-aaaaaaaaaa', name: 'Bugs', script: '<Canvas name="Board"><Totem id="tm-aaaaaaaaaa" name="Bugs"><Note name="A">- [ ] one</Note><Note name="B">- [ ] two</Note></Totem></Canvas>' }];
  const renamed = '<Canvas name="Board"><Totem id="tm-aaaaaaaaaa" name="Issues"><Note name="A">- [ ] one</Note><Note name="B">- [ ] two</Note></Totem></Canvas>';
  const ok = checkArrangement([renamed], 'Board', before);
  assert.equal(ok.reason, undefined);
  assert.deepEqual(ok.overrides.map((o) => [o.id, o.name]), [['tm-aaaaaaaaaa', 'Issues']]);
  const lossy = '<Canvas name="Board"><Totem id="tm-aaaaaaaaaa" name="Issues"><Note name="A">- [ ] one</Note></Totem></Canvas>';
  assert.match(checkArrangement([lossy], 'Board', before).reason, /it lost the note "- \[ \] two"/);
  assert.match(checkArrangement([renamed.replace('aaaaaaaaaa', 'bbbbbbbbbb')], 'Board', before).reason, /names no totem on the canvas/);
});

test('in the history a rename is one file, said as renamed, and git follows it without rename detection', async (t) => {
  const { send, layout, data, config, agent } = setup(t);
  const history = new History({ dataDir: data, config });
  agent.history = history;
  await send(totem('Plan', BODY));
  history.set('Board', true, { replay: () => agent.replay('Board'), snapshot: () => agent.snapshot('Board') });
  const [{ id, file }] = layout();
  await send(totem('Roadmap', BODY, id), 'claude-b');
  const [last] = history.log('Board');
  assert.deepEqual(last.renamed, [{ from: 'Plan', to: 'Roadmap' }]);
  assert.deepEqual([last.added, last.deleted], [[], []]);
  const hdir = history.dir('Board');
  const git = (...a) => execFileSync('git', a, { cwd: hdir }).toString();
  assert.equal(git('log', '--format=%H', '--', file).trim().split('\n').length, history.log('Board').length, 'every commit is on the one file');
  const diff = git('diff', 'HEAD~1', 'HEAD', '--', file).split('\n').filter((l) => /^[-+](?![-+])/.test(l));
  assert.equal(diff.length, 2, 'one line out, one line in');
  assert.match(diff.join('\n'), /-.*name="Plan"[\s\S]*\+.*name="Roadmap"/);
});

test('a rename made before history was on is replayed under each version\'s own name, in one file', async (t) => {
  const { send, layout, data, config, agent } = setup(t);
  await send(totem('Plan', BODY), 'claude-a');
  const [{ id, file }] = layout();
  await send(totem('Roadmap', BODY, id), 'claude-b');
  const history = new History({ dataDir: data, config });
  agent.history = history;
  history.set('Board', true, { replay: () => agent.replay('Board'), snapshot: () => agent.snapshot('Board') });
  const log = history.log('Board').reverse();
  assert.deepEqual(log.map((c) => [c.who, c.added, c.renamed]), [
    ['claude-a', ['Plan'], []],
    ['claude-b', [], [{ from: 'Plan', to: 'Roadmap' }]],
  ]);
  assert.deepEqual(JSON.parse(execFileSync('git', ['show', `${log[0].commit}:totems.json`], { cwd: history.dir('Board') }).toString()).map((x) => [x.name, x.file]), [['Plan', file]]);
});
