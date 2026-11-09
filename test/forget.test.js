/* Forgetting a drop everywhere NoteX keeps it: its script lines and the
 * wires to its note, the canvas, its copy in sources/, the backups holding
 * it, an image's reading, bronze - and, through the drop list, RAGX
 * (t-985017e732, t-2598836a0f, t-983bfb918b). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writer } from '../engine/lib/writer.js';
import { Bronze, BronzeError } from '../engine/lib/bronze.js';
import { AgentCanvases, withoutDrop } from '../engine/lib/agentcanvas.js';

// A totem's file, from layout.json: named from its id since t-a484b5d0de.
const fileOf = (data, name, canvas = 'Board') => JSON.parse(fs.readFileSync(path.join(data, 'agent-canvases', canvas, 'layout.json'), 'utf8')).totems.find((x) => x.name === name).file;
import { DropSync } from '../engine/lib/dropsync.js';
import { Readings } from '../engine/lib/images.js';
import { forgetDrop } from '../engine/lib/forget.js';
import { parseScript } from '../engine/lib/script.js';
import { readFabric } from '../engine/lib/fabric.js';
import { buildPlaces } from '../engine/lib/places.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-forget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws');
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(ws, 'Board'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'Board', 'fabric.json'), JSON.stringify({ drawings: [], areas: [], files: [], links: [], totems: [] }));
  fs.writeFileSync(path.join(ws, 'Board', 'agent.json'), '{}');
  const config = { workspace: ws, ragx: path.join(root, 'no-ragx') };
  const writer = new Writer({ config, dataDir: data });
  const bronze = new Bronze(data);
  const agent = new AgentCanvases({ dataDir: data, writer, bronze });
  writer.agent = agent;
  const sync = new DropSync({ dataDir: data, config, agent, bronze });
  const sent = [];
  agent.onRendered = (c) => { sent.push(sync.queue(c)); };
  const board = path.join(ws, 'Board');
  const places = () => [...buildPlaces(readFabric(board)).places.values()].map((p) => p.address).filter(Boolean);
  const forget = async (id) => { const r = await forgetDrop(id, { bronze, writer, agent, dataDir: data }); await Promise.all(sent.splice(0)); return r; };
  const list = () => JSON.parse(fs.readFileSync(path.join(data, 'docs', 'Board.drops.json'), 'utf8')).files.map((f) => f.drop.id);
  return { data, board, writer, bronze, agent, places, forget, list };
}

test('a drop\'s tag and the wires to its note come out of a script, the rest stays as written', () => {
  const s = '<Canvas name="B"><Totem name="T"><Row><Area name="A"><Note name="Gone" drop="d-0000000001"/><Note name="Kept">x</Note></Area>'
    + '<Area name="Z"><File drop="d-0000000002"></File><Text drop="d-0000000001"/></Area></Row>'
    + '<Link from="A > Gone" to="Z"/><Line from="Kept" to="Z"/></Totem></Canvas>';
  const out = withoutDrop(s, 'd-0000000001');
  assert.equal(out, '<Canvas name="B"><Totem name="T"><Row><Area name="A"><Note name="Kept">x</Note></Area>'
    + '<Area name="Z"><File drop="d-0000000002"></File></Area></Row><Line from="Kept" to="Z"/></Totem></Canvas>');
  assert.doesNotThrow(() => parseScript(out));
  assert.equal(withoutDrop(s, 'd-0000000009'), s);
});

test('a forgotten note leaves its script, the canvas, the backups, the drop list and bronze', async (t) => {
  const s = setup(t);
  const secret = s.bronze.land({ text: 'My landlord owes me 400', canvas: 'Board' });
  const kept = s.bronze.land({ text: 'Keep this one', canvas: 'Board' });
  const script = `<Canvas name="Board"><Totem name="Life"><Area name="Money"><Note name="Rent" drop="${secret.id}"/><Note name="Other" drop="${kept.id}"/></Area><Link from="Rent" to="Other"/></Totem></Canvas>`;
  assert.equal((await s.writer.submit({ script, owner: 'claude' })).status, 'written');
  // A second render leaves a backup holding the note's words.
  await s.writer.serial(() => s.agent.render('Board'));
  assert.deepEqual(s.list().sort(), [secret.id, kept.id].sort());
  const backups = path.join(s.data, 'scripts', 'backups', 'Board');
  assert.ok(fs.readdirSync(backups).some((n) => fs.readFileSync(path.join(backups, n), 'utf8').includes('My landlord owes me 400')));

  const r = await s.forget(secret.id);
  assert.deepEqual(r.totems, ['Life']);
  assert.ok(r.backups >= 1);
  assert.equal(r.blob, 'deleted');
  assert.ok(!s.places().includes('Life (totem) > Money > Rent (note)'));
  assert.ok(s.places().includes('Life (totem) > Money > Other (note)'), 'the rest of the totem stays');
  assert.ok(!fs.readFileSync(path.join(s.board, 'fabric.json'), 'utf8').includes('landlord'));
  for (const n of fs.readdirSync(backups)) assert.ok(!fs.readFileSync(path.join(backups, n), 'utf8').includes('landlord'), `backup ${n}`);
  for (const which of ['', 'good']) {
    const text = fs.readFileSync(path.join(s.data, 'agent-canvases', 'Board', which, fileOf(s.data, 'Life')), 'utf8');
    assert.ok(!text.includes(secret.id) && !text.includes('Rent'), `${which || 'current'} script`);
  }
  assert.deepEqual(s.list(), [kept.id], 'RAGX is told it is gone');
  assert.throws(() => s.bronze.get(secret.id), BronzeError);
});

test('a forgotten file leaves sources/ unless another item shows that name; an image\'s reading goes too', async (t) => {
  const s = setup(t);
  const paper = s.bronze.land({ bytes: PDF, name: 'survey.pdf', canvas: 'Board' });
  const pic = s.bronze.land({ bytes: PNG, name: 'board.png', canvas: 'Board' });
  const sha = path.basename(s.bronze.file(pic.id)).replace(/\.png$/, '');
  new Readings(s.data).put(sha, { kind: 'photo', text: '', description: 'A whiteboard.' });
  await s.writer.submit({ script: `<Canvas name="Board"><Totem name="Papers"><File drop="${paper.id}"/><File drop="${pic.id}"/></Totem></Canvas>`, owner: 'claude' });
  assert.ok(fs.existsSync(path.join(s.board, 'sources', 'survey.pdf')));
  const r1 = await s.forget(paper.id);
  assert.deepEqual(r1.sources, ['survey.pdf']);
  assert.ok(!fs.existsSync(path.join(s.board, 'sources', 'survey.pdf')));
  const r2 = await s.forget(pic.id);
  assert.equal(r2.reading, true);
  assert.equal(new Readings(s.data).get(sha), null);
  assert.deepEqual(readFabric(s.board).state.files, []);
});

test('a drop being placed cannot be forgotten yet; one never placed is forgotten from bronze alone', async (t) => {
  const s = setup(t);
  const d = s.bronze.land({ text: 'in the works', canvas: 'Board' });
  s.bronze.mark(d.id, 'placing');
  await assert.rejects(s.forget(d.id), (e) => e instanceof BronzeError && e.code === 'placing');
  const waiting = s.bronze.land({ text: 'never placed' });
  const r = await s.forget(waiting.id);
  assert.deepEqual(r.totems, []);
  assert.equal(r.blob, 'deleted');
});

test('earlier versions keep the forgotten drop\'s id only, and are left as they were', async (t) => {
  const s = setup(t);
  const a = s.bronze.land({ text: 'first words', canvas: 'Board' });
  const b = s.bronze.land({ text: 'second words', canvas: 'Board' });
  await s.writer.submit({ script: `<Canvas name="Board"><Totem name="T"><Note name="A" drop="${a.id}"/></Totem></Canvas>`, owner: 'claude' });
  await s.writer.submit({ script: `<Canvas name="Board"><Totem name="T"><Note name="A" drop="${a.id}"/><Note name="B" drop="${b.id}"/></Totem></Canvas>`, owner: 'claude' });
  await s.forget(a.id);
  const vdir = path.join(s.data, 'agent-canvases', 'Board', 'versions', fileOf(s.data, 'T').replace(/\.totem$/, ''));
  const old = fs.readdirSync(vdir).map((n) => fs.readFileSync(path.join(vdir, n), 'utf8'));
  assert.ok(old.some((v) => v.includes(a.id)), 'the id is still in the history');
  assert.ok(!old.some((v) => v.includes('first words')), 'its words never were');
  assert.ok(s.places().includes('T (totem) > B (note)'));
});
