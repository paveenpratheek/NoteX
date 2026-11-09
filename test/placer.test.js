/* The placer: queued drops placed by a model's totem script, which must
 * only add to a totem; asked once more on a refusal, then failed; held
 * when Claude cannot answer (t-c24e0494a2, t-bd40bbaa6b, t-c7193766ab).
 * The model here is a fake, so nothing reaches Claude. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writer } from '../engine/lib/writer.js';
import { Bronze } from '../engine/lib/bronze.js';
import { AgentCanvases } from '../engine/lib/agentcanvas.js';
import { Placer, extractScript, checkAnswer, HOLD_MS } from '../engine/lib/placer.js';
import { ClaudeError } from '../engine/lib/claude.js';
import { readFabric } from '../engine/lib/fabric.js';
import { buildPlaces } from '../engine/lib/places.js';

function setup(t, answers) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-placer-'));
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
  const clock = { t: Date.parse('2026-10-30T10:00:00Z') };
  const bronze = new Bronze(data, { now: () => clock.t }); // drops land in the order the test says
  writer.agent = new AgentCanvases({ dataDir: data, writer, bronze });
  const asked = [];
  const run = async (req) => {
    asked.push(req);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return { text: typeof a === 'function' ? a(req) : a };
  };
  const placer = new Placer({ config, dataDir: data, bronze, writer, run, now: () => clock.t });
  const places = () => [...buildPlaces(readFabric(path.join(ws, 'Board'))).places.values()].map((p) => p.address).filter(Boolean);
  return { root, ws, data, writer, bronze, placer, asked, clock, places, config };
}

const fence = (s) => `Here it is:\n\`\`\`xml\n${s}\n\`\`\`\nIt goes under Bugs.`;
const ENGINE = '<Canvas name="Board"><Totem name="RAGX"><Area name="Bugs"><Note name="Known">- [ ] slow ingest</Note></Area></Totem></Canvas>';

test('the script is taken from a fenced block, or from <Canvas> to </Canvas>', () => {
  assert.equal(extractScript(fence('<Canvas name="B"></Canvas>')), '<Canvas name="B"></Canvas>');
  assert.equal(extractScript('Sure. <Canvas name="B"><Totem name="T"></Totem></Canvas> Done.'), '<Canvas name="B"><Totem name="T"></Totem></Canvas>');
  assert.equal(extractScript('I could not decide.'), null);
});

test('an answer must name the drop and keep everything its totem held', () => {
  const drop = { id: 'd-0123456789' };
  const scripts = [{ name: 'RAGX', script: ENGINE }];
  const good = '<Canvas name="Board"><Totem name="RAGX"><Area name="Bugs"><Note name="Known">- [ ] slow ingest</Note><Note name="Figures" drop="d-0123456789"/></Area></Totem></Canvas>';
  assert.equal(checkAnswer(good, drop, 'Board', scripts), null);
  assert.match(checkAnswer(ENGINE, drop, 'Board', scripts), /does not place the drop/);
  const lost = '<Canvas name="Board"><Totem name="RAGX"><Area name="Bugs"><Note name="Figures" drop="d-0123456789"/></Area></Totem></Canvas>';
  assert.match(checkAnswer(lost, drop, 'Board', scripts), /lost or changed what it held: the note Bugs > Known \(- \[ \] slow ingest\)/);
  const reworded = good.replace('slow ingest', 'ingest is slow');
  assert.match(checkAnswer(reworded, drop, 'Board', scripts), /lost or changed/);
  assert.match(checkAnswer(good.replace('name="Board"', 'name="Other"'), drop, 'Board', scripts), /goes on "Board"/);
  assert.match(checkAnswer('<Canvas name="Board">', drop, 'Board', scripts), /never closed/);
});

test('a queued drop is placed into the totem the model chose, and the model saw the canvas and the drop', async (t) => {
  const s = setup(t, []);
  await s.writer.submit({ script: ENGINE, owner: 'claude' });
  const d = s.bronze.land({ text: 'Figures on scanned pages are missed', note: 'from Thursday', canvas: 'Board' });
  const added = ENGINE.replace('</Note></Area>', `</Note><Note name="Figures" drop="${d.id}"/></Area>`);
  s.asked.length = 0;
  const answers = [fence(added)];
  s.placer.run = async (req) => { s.asked.push(req); return { text: answers.shift() }; };
  const r = await s.placer.tick();
  assert.equal(r.status, 'placed');
  assert.equal(s.bronze.get(d.id).status, 'placed');
  assert.ok(s.places().includes('RAGX (totem) > Bugs > Figures (note)'));
  const { prompt, model } = s.asked[0];
  assert.equal(model, 'sonnet');
  assert.ok(prompt.replace(/ id="tm-[0-9a-f]{10}"/g, '').includes(ENGINE), 'the canvas as its scripts');
  assert.ok(prompt.includes('Figures on scanned pages are missed') && prompt.includes('from Thursday'), 'the drop\'s words and note');
  assert.equal(s.placer.tick(), null, 'nothing more to place');
});

test('a new totem is started on an empty canvas, and the oldest drop goes first', async (t) => {
  const s = setup(t, []);
  const first = s.bronze.land({ text: 'first idea', canvas: 'Board' });
  s.clock.t += 1000;
  s.bronze.land({ text: 'second idea', canvas: 'Board' });
  s.placer.run = async (req) => ({ text: fence(`<Canvas name="Board"><Totem name="Ideas"><Note name="One" drop="${/id: (d-[0-9a-f]+)/.exec(req.prompt)[1]}"/></Totem></Canvas>`) });
  const r = await s.placer.tick();
  assert.equal(r.status, 'placed');
  assert.equal(s.bronze.get(first.id).status, 'placed');
  assert.ok(s.places().includes('Ideas (totem) > One (note)'));
});

test('an answer that drops what was there is asked for again with the reason, then placed', async (t) => {
  const s = setup(t, []);
  await s.writer.submit({ script: ENGINE, owner: 'claude' });
  const d = s.bronze.land({ text: 'a bug', canvas: 'Board' });
  const lost = `<Canvas name="Board"><Totem name="RAGX"><Area name="Bugs"><Note name="New" drop="${d.id}"/></Area></Totem></Canvas>`;
  const kept = ENGINE.replace('</Note></Area>', `</Note><Note name="New" drop="${d.id}"/></Area>`);
  const answers = [fence(lost), fence(kept)];
  const asked = [];
  s.placer.run = async (req) => { asked.push(req); return { text: answers.shift() }; };
  const r = await s.placer.tick();
  assert.equal(r.status, 'placed');
  assert.equal(asked.length, 2);
  assert.match(asked[1].prompt, /Your last answer was not taken: the new "RAGX" script lost or changed/);
  assert.ok(s.places().includes('RAGX (totem) > Bugs > Known (note)'), 'what was there is still there');
});

test('two answers NoteX cannot take mark the drop failed, and choosing its canvas again queues it', async (t) => {
  const s = setup(t, []);
  const d = s.bronze.land({ text: 'x', canvas: 'Board' });
  s.placer.run = async () => ({ text: 'I am not sure where this goes.' });
  const r = await s.placer.tick();
  assert.equal(r.status, 'failed');
  const now = s.bronze.get(d.id);
  assert.equal(now.status, 'failed');
  assert.match(now.detail, /The agent could not place it: the answer held no <Canvas> script/);
  assert.equal(s.bronze.choose(d.id, 'Board').status, 'queued');
});

test('a refused script is asked for again with NoteX\'s reason', async (t) => {
  const s = setup(t, []);
  const d = s.bronze.land({ text: 'x', canvas: 'Board' });
  const answers = [
    fence(`<Canvas name="Board"><Totem name="T"><File path="C:/nowhere/x.pdf"/><Note name="N" drop="${d.id}"/></Totem></Canvas>`),
    fence(`<Canvas name="Board"><Totem name="T"><Note name="N" drop="${d.id}"/></Totem></Canvas>`),
  ];
  const asked = [];
  s.placer.run = async (req) => { asked.push(req); return { text: answers.shift() }; };
  assert.equal((await s.placer.tick()).status, 'placed');
  assert.match(asked[1].prompt, /not taken: .*no file at C:\/nowhere\/x\.pdf/);
});

test('Claude at a limit puts the drop back and holds the placer for 10 minutes', async (t) => {
  const s = setup(t, []);
  const d = s.bronze.land({ text: 'x', canvas: 'Board' });
  let calls = 0;
  s.placer.run = async () => { calls++; throw new ClaudeError('limit', 'Claude is at a usage limit: try later'); };
  assert.equal((await s.placer.tick()).status, 'held');
  assert.equal(s.bronze.get(d.id).status, 'queued');
  assert.match(s.bronze.get(d.id).detail, /usage limit/);
  assert.match(s.placer.report().held, /usage limit/);
  assert.equal(s.placer.tick(), null);
  assert.equal(calls, 1, 'nothing asked while held');
  s.clock.t += HOLD_MS + 1;
  s.placer.run = async (req) => ({ text: fence(`<Canvas name="Board"><Totem name="T"><Note name="N" drop="${d.id}"/></Totem></Canvas>`) });
  assert.equal((await s.placer.tick()).status, 'placed');
});

test('only drops for agent canvases are placed, none while placing is off, and a cut-short one goes again', async (t) => {
  const s = setup(t, []);
  // A drop whose canvas was later taken back from the agent stays queued.
  const d = s.bronze.land({ text: 'x', canvas: 'Board' });
  fs.rmSync(path.join(s.ws, 'Board', 'agent.json'));
  assert.equal(s.placer.tick(), null);
  fs.writeFileSync(path.join(s.ws, 'Board', 'agent.json'), '{}');
  s.config.placing = false;
  assert.equal(s.placer.tick(), null);
  s.config.placing = true;
  s.bronze.mark(d.id, 'placing');
  s.placer.run = async () => ({ text: fence(`<Canvas name="Board"><Totem name="T"><Note name="N" drop="${d.id}"/></Totem></Canvas>`) });
  await s.placer.start();
  await s.placer.running;
  await s.placer.stop();
  assert.equal(s.bronze.get(d.id).status, 'placed');
});

test('drops sent together are placed together in one script, the model shown their description and the user\'s message (t-8a49895e07, t-319d8470cb)', async (t) => {
  const s = setup(t, []);
  const send = 's-0123456789';
  const ask = 'put these in a totem named Money';
  const one = s.bronze.land({ text: 'receipt one', note: 'March receipts', ask, send, canvas: 'Board' });
  const two = s.bronze.land({ text: 'receipt two', note: 'March receipts', ask, send, canvas: 'Board' });
  const half = `<Canvas name="Board"><Totem name="Money"><Note name="One" drop="${one.id}"/></Totem></Canvas>`;
  const both = `<Canvas name="Board"><Totem name="Money"><Note name="One" drop="${one.id}"/><Note name="Two" drop="${two.id}"/></Totem></Canvas>`;
  const answers = [fence(half), fence(both)];
  const asked = [];
  s.placer.run = async (req) => { asked.push(req); return { text: answers.shift() }; };
  assert.equal((await s.placer.tick()).status, 'placed');
  assert.equal(asked.length, 2);
  const first = asked[0].prompt;
  assert.ok(first.includes('2 drops the user sent together') && first.includes(ask) && first.includes('March receipts'));
  assert.match(asked[1].prompt, new RegExp(`does not place ${two.id} - every drop sent together`));
  assert.deepEqual([one.id, two.id].map((id) => s.bronze.get(id).status), ['placed', 'placed']);
  assert.equal(s.placer.tick(), null);
});

test('a send left to its message goes on the new canvas it asks for, made an agent canvas (t-8c4e28b7b4)', async (t) => {
  const s = setup(t, []);
  const d = s.bronze.land({ text: 'scan of the invoice', ask: 'create a new canvas named Bills and put this in a totem named March', send: 's-0000000001', byMessage: true });
  assert.equal(d.status, 'queued');
  assert.equal(d.canvas, null);
  const asked = [];
  s.placer.run = async (req) => { asked.push(req); return { text: fence(`<Canvas name="Bills"><Totem name="March"><Note name="Invoice" drop="${d.id}"/></Totem></Canvas>`) }; };
  const r = await s.placer.tick();
  assert.equal(r.status, 'placed');
  assert.equal(r.canvas, 'Bills');
  assert.ok(asked[0].prompt.includes('=== Canvas "Board" ===') && asked[0].prompt.includes('create a new canvas named Bills'));
  assert.ok(fs.existsSync(path.join(s.ws, 'Bills', 'agent.json')));
  const now = s.bronze.get(d.id);
  assert.equal(now.canvas, 'Bills');
  assert.equal(now.status, 'placed');
  assert.ok(s.writer.agent.activity('Bills').some((a) => a.what === 'created'));
});

test('a message cannot send drops onto the user\'s own canvas, nor move a drop the user sent to a canvas', async (t) => {
  const s = setup(t, []);
  assert.throws(() => s.bronze.land({ text: 'x', byMessage: true }), /Write the agent a message/);
  const d = s.bronze.land({ text: 'a note', ask: 'put it on Notes' });
  assert.equal(d.status, 'waiting');
  assert.equal(s.bronze.choose(d.id, null, { byMessage: true }).byMessage, true);
  const answers = [
    fence(`<Canvas name="Notes"><Totem name="T"><Note name="N" drop="${d.id}"/></Totem></Canvas>`),
    fence(`<Canvas name="Board"><Totem name="T"><Note name="N" drop="${d.id}"/></Totem></Canvas>`),
  ];
  const asked = [];
  s.placer.run = async (req) => { asked.push(req); return { text: answers.shift() }; };
  assert.equal((await s.placer.tick()).status, 'placed');
  assert.match(asked[1].prompt, /"Notes" is the user's own canvas/);
  assert.ok(!fs.existsSync(path.join(s.ws, 'Notes', 'agent.json')));
  assert.equal(s.bronze.get(d.id).canvas, 'Board');
  const mine = s.bronze.land({ text: 'mine', canvas: 'Board' });
  assert.throws(() => s.bronze.settle(mine.id, 'Bills'), /which the user chose/);
  const plain = s.bronze.land({ text: 'no message' });
  assert.throws(() => s.bronze.choose(plain.id, null, { byMessage: true }), /no message for the agent/);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a picture of a car')]);

test('the agent sees an image drop itself, labelled by its id, and Claude gets it as an image block (t-76e54ab623)', async (t) => {
  const { imageInput, resultOf } = await import('../engine/lib/claude.js');
  const msg = JSON.parse(imageInput('Place it.', [{ label: 'The image of drop d-1:', mediaType: 'image/png', data: PNG }]));
  assert.deepEqual(msg.message.content.map((c) => c.type), ['text', 'image', 'text']);
  assert.equal(msg.message.content[1].source.media_type, 'image/png');
  assert.equal(Buffer.from(msg.message.content[1].source.data, 'base64').toString('latin1'), PNG.toString('latin1'));
  assert.equal(resultOf('{"type":"system"}\n{"type":"assistant"}\n{"type":"result","result":"ok"}\n').result, 'ok');
  assert.equal(resultOf('{"result":"plain"}').result, 'plain');

  const s = setup(t, []);
  const d = s.bronze.land({ bytes: PNG, name: 'forza.png', note: 'my best lap', canvas: 'Board' });
  const asked = [];
  s.placer.run = async (req) => { asked.push(req); return { text: fence(`<Canvas name="Board"><Totem name="Cars"><File drop="${d.id}"/></Totem></Canvas>`) }; };
  assert.equal((await s.placer.tick()).status, 'placed');
  const { images, prompt } = asked[0];
  assert.equal(images.length, 1);
  assert.equal(images[0].label, `The image of drop ${d.id} (forza.png):`);
  assert.equal(images[0].mediaType, 'image/png');
  assert.ok(images[0].data.equals(PNG));
  assert.match(prompt, new RegExp(`the image itself is attached above, labelled "drop ${d.id}"`));
  assert.ok(prompt.includes('my best lap'));
});

test('an image too large for Claude is named as not attached (t-480e539f30)', async (t) => {
  const { dropImages, IMAGE_BYTES } = await import('../engine/lib/placer.js');
  const s = setup(t, []);
  const big = s.bronze.land({ bytes: Buffer.concat([PNG, Buffer.alloc(IMAGE_BYTES)]), name: 'huge.png' });
  const r = dropImages([s.bronze.get(big.id)], (id) => s.bronze.file(id));
  assert.deepEqual(r.images, []);
  assert.deepEqual(r.skipped, [`${big.id} (over 3.75 MB)`]);
});
