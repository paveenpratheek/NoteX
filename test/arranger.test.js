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
  assert.match(s.asked[1].prompt, /Your last answer's scripts were not taken: it lost the note "- \[ \] figures missed"/);
  assert.equal(s.script('Bugs'), kept);
});

test('scripts that do not all draw are taken none of them, and two refusals fail the ask', async (t) => {
  const s = await setup(t);
  const bugs = '<Canvas name="Board"><Totem name="Bugs"><Note name="Ingest">- [ ] slow ingest</Note></Totem></Canvas>';
  const ideas = '<Canvas name="Board"><Totem name="Ideas"><Note name="Search">time windows for search</Note><Note name="Figures">- [ ] figures missed</Note><File path="C:/nowhere/x.pdf"/></Totem></Canvas>';
  s.answers.push(fence(bugs, ideas), fence(bugs, ideas));
  const r = await asked(s, 'move figures');
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /The canvas was not changed: .*no file at C:\/nowhere\/x\.pdf/);
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

test('an ask shows what each drop on the canvas is and attaches its images (t-1b478f9e6b, t-76e54ab623)', async (t) => {
  const s = await setup(t);
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('lap')]);
  const bronze = s.writer.agent.bronze;
  const img = bronze.land({ bytes: PNG, name: 'lap.png', note: 'Forza 6, Spa', canvas: 'Board' });
  const words = bronze.land({ text: 'tune the gearbox before Spa', canvas: 'Board' });
  const shots = `<Canvas name="Board"><Totem name="Shots"><File drop="${img.id}"/><Note name="Tune" drop="${words.id}"/></Totem></Canvas>`;
  assert.equal((await s.writer.submit({ script: shots, owner: 'NoteX placer' })).status, 'written');
  s.answers.push(fence(shots));
  const r = await asked(s, 'look at the screenshots and regroup them');
  assert.equal(r.status, 'done', r.detail);
  const { images, prompt } = s.asked[0];
  assert.deepEqual(images.map((im) => im.label), [`The image of drop ${img.id} (lap.png):`]);
  assert.ok(prompt.includes('Forza 6, Spa') && prompt.includes('tune the gearbox before Spa'));
  assert.match(prompt, new RegExp(`the image itself is attached above, labelled "drop ${img.id}"`));
});

test('a chat turn answers in words, changes the canvas only when asked, and every turn is logged (t-2ffa1ff1de, t-e49cda284a)', async (t) => {
  const s = await setup(t);
  s.answers.push('You have two totems: Bugs, with two open bugs, and Ideas, with one idea.');
  const q = await asked(s, 'what is on this canvas?');
  assert.equal(q.status, 'answered');
  assert.equal(q.reply, 'You have two totems: Bugs, with two open bugs, and Ideas, with one idea.');
  assert.equal(s.script('Bugs'), BUGS, 'a question changes nothing');

  const flat = '<Canvas name="Board"><Totem name="Bugs"><Note name="Ingest">- [ ] slow ingest</Note><Note name="Figures">- [ ] figures missed</Note></Totem></Canvas>';
  s.answers.push(`Done - the two bugs now sit straight in the totem.\n\`\`\`xml\n${flat}\n\`\`\``);
  s.arranger.ask('Board', 'take them out of the Open box', null, { source: 'canvasx' });
  await s.arranger.running.done;
  const r = s.arranger.report('Board');
  assert.deepEqual([r.status, r.reply, r.totems, r.source], ['done', 'Done - the two bugs now sit straight in the totem.', ['Bugs'], 'canvasx']);
  assert.match(s.asked[1].prompt, /The conversation so far, oldest first:\nUser: what is on this canvas\?\nYou: You have two totems/);
  assert.equal(s.script('Bugs'), flat);

  const chat = s.writer.agent.chat('Board');
  assert.deepEqual(chat.map((c) => [c.who, c.status || null, c.source || null]), [
    ['user', null, 'notex'], ['agent', 'answered', null], ['user', null, 'canvasx'], ['agent', 'done', null],
  ]);
  assert.equal(chat[3].text, 'Done - the two bugs now sit straight in the totem.');
  assert.deepEqual(chat[3].totems, ['Bugs']);
});

test('a chat turn with attachments places every one of them, the images shown to the agent (t-79ac13d22a, t-291d7e41be)', async (t) => {
  const s = await setup(t);
  const bronze = s.writer.agent.bronze;
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('gtr')]);
  const img = bronze.land({ bytes: PNG, name: 'gtr.png', ask: 'put this under Ideas', send: 's-0000000009', canvas: 'Board' });
  const txt = bronze.land({ text: 'grip tune for Spa', send: 's-0000000009', canvas: 'Board' });
  for (const d of [img, txt]) bronze.mark(d.id, 'placing');
  const ideas = `<Canvas name="Board"><Totem name="Ideas"><Note name="Search">time windows for search</Note><File drop="${img.id}"/><Note name="Tune" drop="${txt.id}"/></Totem></Canvas>`;
  s.answers.push('Done, both are under Ideas.', `Done, both are under Ideas.\n\`\`\`xml\n${ideas}\n\`\`\``);
  s.arranger.ask('Board', 'put this under Ideas', null, { source: 'canvasx', drops: [img.id, txt.id] });
  await s.arranger.running.done;
  const r = s.arranger.report('Board');
  assert.equal(r.status, 'done', r.detail);
  // A first answer of words only was asked for again: the attachments must be placed.
  assert.match(s.asked[1].prompt, new RegExp(`do not place ${img.id}, ${txt.id}, which the user attached`));
  assert.ok(s.asked[0].prompt.includes('The user attached these with the message') && s.asked[0].prompt.includes('grip tune for Spa'));
  assert.deepEqual(s.asked[0].images.map((im) => im.id), [img.id]);
  assert.deepEqual([img.id, txt.id].map((id) => bronze.get(id).status), ['placed', 'placed']);
  const turn = s.writer.agent.chat('Board').find((c) => c.who === 'user');
  assert.deepEqual(turn.attachments, [{ id: img.id, name: 'gtr.png', kind: 'image' }, { id: txt.id, name: 'typed text', kind: 'text' }]);
});

test('attachments a chat turn could not place are marked failed, to be sent again from the Inbox', async (t) => {
  const s = await setup(t);
  const bronze = s.writer.agent.bronze;
  const d = bronze.land({ text: 'a stray idea', canvas: 'Board' });
  bronze.mark(d.id, 'placing');
  s.answers.push('Sorry.', 'Still sorry.');
  s.arranger.ask('Board', '', null, { drops: [d.id] });
  await s.arranger.running.done;
  assert.equal(s.arranger.report('Board').ask, 'Place what I attached where it fits.');
  assert.equal(s.arranger.report('Board').status, 'failed');
  assert.equal(bronze.get(d.id).status, 'failed');
  assert.match(bronze.get(d.id).detail, /could not place it from the chat/);
});
