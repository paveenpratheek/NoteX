/* The arranger: the user asks the agent about one of its canvases, and the
 * agent's new totem scripts are taken only if everything the canvas held is
 * still on it, drawn together or not at all (t-a9198c414f, t-b5d4a34951,
 * t-6077adde73). The model here is a fake, so nothing reaches Claude. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writer } from '../engine/lib/writer.js';
import { Bronze } from '../engine/lib/bronze.js';
import { AgentCanvases } from '../engine/lib/agentcanvas.js';
import { Arranger, checkArrangement, extractScripts, OWNER } from '../engine/lib/arranger.js';
import { ClaudeError } from '../engine/lib/claude.js';
import { parseScript } from '../engine/lib/script.js';

const BUGS = '<Canvas name="Board"><Totem name="Bugs"><Area name="Open"><Note name="Ingest">- [ ] slow ingest</Note><Note name="Figures">- [ ] figures missed</Note></Area></Totem></Canvas>';
const IDEAS = '<Canvas name="Board"><Totem name="Ideas"><Note name="Search">time windows for search</Note></Totem></Canvas>';
const fence = (...scripts) => `Here:\n${scripts.map((s) => '```xml\n' + s + '\n```').join('\nand\n')}`;

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-arranger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws');
  const data = path.join(root, 'data');
  for (const name of ['Board', 'Notes']) {
    fs.mkdirSync(path.join(ws, name), { recursive: true });
    fs.writeFileSync(path.join(ws, name, 'fabric.json'), JSON.stringify({ drawings: [], areas: [], files: [], links: [], totems: [] }));
  }
  fs.writeFileSync(path.join(ws, 'Board', 'agent.json'), '{}');
  const config = { workspace: ws };
  const writer = new Writer({ config, dataDir: data });
  writer.agent = new AgentCanvases({ dataDir: data, writer, bronze: new Bronze(data) });
  for (const script of [BUGS, IDEAS]) assert.equal((await writer.submit({ script, owner: 'NoteX placer' })).status, 'written');
  const asked = [];
  const answers = [];
  const run = async (req) => { asked.push(req); const a = answers.shift(); if (a instanceof Error) throw a; return { text: a }; };
  const arranger = new Arranger({ config, dataDir: data, writer, run });
  const script = (name) => writer.agent.scripts('Board').find((s) => s.name === name).script;
  return { ws, data, config, writer, arranger, asked, answers, script };
}

const asked = async (s, words, model) => { s.arranger.ask('Board', words, model); await s.arranger.running.done; return s.arranger.report('Board'); };

test('every script of an answer is read, and an arrangement must keep all the canvas held, wherever it moves', () => {
  assert.deepEqual(extractScripts(fence(BUGS, IDEAS)), [BUGS, IDEAS]);
  const before = [{ name: 'Bugs', script: BUGS }, { name: 'Ideas', script: IDEAS }];
  // Figures moves from Bugs to Ideas, its box renamed: taken.
  const bugs = '<Canvas name="Board"><Totem name="Bugs"><Area name="Ingest bugs"><Note name="Ingest">- [ ] slow ingest</Note></Area></Totem></Canvas>';
  const ideas = '<Canvas name="Board"><Totem name="Ideas"><Note name="Search">time windows for search</Note><Area name="From bugs"><Note name="Figures, again">- [ ] figures missed</Note></Area></Totem></Canvas>';
  const ok = checkArrangement([bugs, ideas], 'Board', before);
  assert.equal(ok.reason, undefined);
  assert.deepEqual(ok.overrides.map((o) => [o.name, o.owner]), [['Bugs', OWNER], ['Ideas', OWNER]]);
  // Moved out of Bugs and into nowhere: refused, naming what was lost.
  assert.match(checkArrangement([bugs], 'Board', before).reason, /it lost the note "- \[ \] figures missed"/);
  assert.match(checkArrangement([bugs, bugs], 'Board', before).reason, /came twice/);
  assert.match(checkArrangement([IDEAS.replace('"Board"', '"Notes"')], 'Board', before).reason, /for the canvas "Notes"/);
  assert.match(checkArrangement([], 'Board', before).reason, /no ```xml block/);
  // A drop is kept by its id, whatever box holds it.
  const withDrop = [{ name: 'T', script: '<Canvas name="Board"><Totem name="T"><Area name="A"><Note name="N" drop="d-0123456789"/></Area></Totem></Canvas>' }];
  assert.equal(checkArrangement(['<Canvas name="Board"><Totem name="T"><Area name="B"><Note name="M" drop="d-0123456789"/></Area></Totem></Canvas>'], 'Board', withDrop).reason, undefined);
});

test('an ask rewrites the totems it names in one render, and the model saw the canvas and the user\'s words', async (t) => {
  const s = await setup(t);
  const bugs = '<Canvas name="Board"><Totem name="Bugs"><Area name="Ingest"><Note name="Ingest">- [ ] slow ingest</Note></Area></Totem></Canvas>';
  const ideas = '<Canvas name="Board"><Totem name="Ideas"><Note name="Search">time windows for search</Note><Note name="Figures">- [ ] figures missed</Note></Totem></Canvas>';
  s.answers.push(fence(bugs, ideas));
  const r = await asked(s, 'move the figures bug to ideas', 'opus');
  assert.equal(r.status, 'done', r.detail);
  assert.deepEqual(r.totems, ['Bugs', 'Ideas']);
  assert.equal(s.asked[0].model, 'opus');
  assert.ok(s.asked[0].prompt.includes(BUGS) && s.asked[0].prompt.includes('move the figures bug to ideas'));
  assert.equal(s.script('Bugs'), bugs);
  assert.equal(s.script('Ideas'), ideas);
  const act = s.writer.agent.activity('Board');
  assert.equal(act.filter((a) => a.what === 'render').length, 3, 'two placements, then one render for the whole ask');
  assert.deepEqual(act.filter((a) => a.what === 'asked' || a.what === 'answered').map((a) => [a.what, a.status || null]), [['answered', 'done'], ['asked', null]]);
});

test('an answer that loses something is asked for again with the reason', async (t) => {
  const s = await setup(t);
  const lost = '<Canvas name="Board"><Totem name="Bugs"><Note name="Ingest">- [ ] slow ingest</Note></Totem></Canvas>';
  const kept = '<Canvas name="Board"><Totem name="Bugs"><Note name="Ingest">- [ ] slow ingest</Note><Note name="Figures">- [ ] figures missed</Note></Totem></Canvas>';
  s.answers.push(fence(lost), fence(kept));
  const r = await asked(s, 'flatten the bugs');
  assert.equal(r.status, 'done');
  assert.equal(r.model, 'sonnet');
  assert.match(s.asked[1].prompt, /Your last answer was not taken: it lost the note "- \[ \] figures missed"/);
  assert.equal(s.script('Bugs'), kept);
});

test('scripts that do not all draw are taken none of them, and two refusals fail the ask', async (t) => {
  const s = await setup(t);
  const bugs = '<Canvas name="Board"><Totem name="Bugs"><Note name="Ingest">- [ ] slow ingest</Note></Totem></Canvas>';
  const ideas = '<Canvas name="Board"><Totem name="Ideas"><Note name="Search">time windows for search</Note><Note name="Figures">- [ ] figures missed</Note><File path="C:/nowhere/x.pdf"/></Totem></Canvas>';
  s.answers.push(fence(bugs, ideas), fence(bugs, ideas));
  const r = await asked(s, 'move figures');
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /The agent could not do it: .*no file at C:\/nowhere\/x\.pdf/);
  assert.equal(s.script('Bugs'), BUGS, 'Bugs kept its old script, since Ideas could not be drawn');
  assert.equal(s.script('Ideas'), IDEAS);
});

test('only an agent canvas, one ask at a time, a known model; Claude at a limit fails the ask', async (t) => {
  const s = await setup(t);
  assert.throws(() => s.arranger.ask('Notes', 'tidy'), /not assigned to the agent/);
  assert.throws(() => s.arranger.ask('Board', '  '), /Write what the agent should do/);
  assert.throws(() => s.arranger.ask('Board', 'tidy', 'gpt'), /not a model NoteX offers/);
  let release;
  s.arranger.run = () => new Promise((r) => { release = r; });
  s.arranger.ask('Board', 'tidy');
  assert.equal(s.arranger.report('Board').status, 'working');
  assert.throws(() => s.arranger.ask('Board', 'again'), /still working on Board/);
  s.arranger.run = async () => ({ text: 'no scripts' }); // the retry answers at once
  release({ text: 'no scripts' });
  await s.arranger.running.done;
  s.arranger.run = async () => { throw new ClaudeError('limit', 'Claude is at a usage limit: try later'); };
  const r = await asked(s, 'tidy');
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /usage limit/);
  s.config.arranger = { model: 'haiku' };
  assert.equal(s.arranger.model(), 'haiku');
  assert.ok(parseScript(s.script('Bugs')));
});
