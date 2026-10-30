/* What is on an agent canvas goes on to RAGX as a drop list after every
 * render, sent again while RAGX is not answering; an agent canvas is never
 * auto-synced as a canvas document (t-7513cdd783, t-083eed1f9f,
 * t-b404914d8f). RAGX here is a fake that counts what it is asked. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { Writer } from '../engine/lib/writer.js';
import { Bronze } from '../engine/lib/bronze.js';
import { AgentCanvases, dropAddresses } from '../engine/lib/agentcanvas.js';
import { DropSync, dropName } from '../engine/lib/dropsync.js';
import { AutoSync } from '../engine/lib/sync.js';
import { parseScript } from '../engine/lib/script.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

async function fakeRagx(t) {
  const asked = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    asked.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ queued: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { runtime: { url: `http://127.0.0.1:${server.address().port}`, token: 't' }, asked };
}

function setup(t, runtime) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-dropsync-'));
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
  const logs = [];
  const sync = new DropSync({ dataDir: data, config, agent, bronze, runtime, log: (m) => logs.push(m) });
  const sent = [];
  agent.onRendered = (c) => { sent.push(sync.queue(c)); };
  const settle = () => Promise.all(sent.splice(0));
  const list = () => JSON.parse(fs.readFileSync(path.join(data, 'docs', 'Board.drops.json'), 'utf8'));
  return { root, ws, data, writer, bronze, agent, sync, settle, list, logs, config };
}

test('a drop\'s address is its note\'s own, or the box that holds its text or file', () => {
  const p = parseScript('<Canvas name="B"><Totem name="RAGX"><Area name="Bugs"><Note name="Figures" drop="d-0000000001"/><File drop="d-0000000002"/></Area><ScrollBox name="Log"><Page><Text drop="d-0000000003"/></Page></ScrollBox></Totem></Canvas>');
  assert.deepEqual(dropAddresses(p), [
    { id: 'd-0000000001', address: 'RAGX (totem) > Bugs > Figures (note)' },
    { id: 'd-0000000002', address: 'RAGX (totem) > Bugs' },
    { id: 'd-0000000003', address: 'RAGX (totem) > Log (scroll box) > Page 1' },
  ]);
  assert.equal(dropName({ id: 'd-0000000001', name: null }, 'RAGX misses: figures on\nscanned pages, and more besides that'), 'RAGX misses figures on scanned pages, (d-0000000001).txt');
  assert.equal(dropName({ id: 'd-0000000001', name: null }, 'short note'), 'short note (d-0000000001).txt');
  assert.equal(dropName({ id: 'd-0000000001', name: 'survey.pdf' }), 'survey.pdf');
});

test('after a render the canvas\'s placed drops are listed with place, file and time, and RAGX is asked once', async (t) => {
  const ragx = await fakeRagx(t);
  const s = setup(t, ragx.runtime);
  const words = s.bronze.land({ text: 'Figures on scanned pages are missed', canvas: 'Board' });
  const paper = s.bronze.land({ bytes: PDF, name: 'Lit survey.pdf', canvas: 'Board' });
  const r = await s.writer.submit({ script: `<Canvas name="Board"><Totem name="Reading"><Area name="Papers"><Note name="Plan" drop="${words.id}"/><File drop="${paper.id}"/></Area></Totem></Canvas>`, owner: 'claude' });
  assert.equal(r.status, 'written', JSON.stringify(r.result));
  await s.settle();
  const l = s.list();
  assert.equal(l.canvas, 'Board');
  const byId = Object.fromEntries(l.files.map((f) => [f.drop.id, f]));
  assert.deepEqual(byId[words.id], {
    name: `Figures on scanned pages are missed (${words.id}).txt`, path: s.bronze.file(words.id),
    sha256: crypto.createHash('sha256').update('Figures on scanned pages are missed').digest('hex'),
    address: 'Reading (totem) > Papers > Plan (note)', kind: 'text', drop: { id: words.id, at: words.landedAt },
  });
  assert.equal(byId[paper.id].name, 'Lit survey.pdf');
  assert.equal(byId[paper.id].address, 'Reading (totem) > Papers');
  assert.equal(byId[paper.id].sha256, crypto.createHash('sha256').update(PDF).digest('hex'));
  assert.deepEqual(ragx.asked, [{ url: '/api/notex/drops', body: { canvas: 'Board' } }]);
  // Drawn again with nothing changed: no new request.
  await s.writer.serial(() => s.agent.render('Board'));
  await s.settle();
  assert.equal(ragx.asked.length, 1);
});

test('a drop the script no longer holds leaves the list, and RAGX is asked again', async (t) => {
  const ragx = await fakeRagx(t);
  const s = setup(t, ragx.runtime);
  const a = s.bronze.land({ text: 'one', canvas: 'Board' });
  const b = s.bronze.land({ text: 'two', canvas: 'Board' });
  await s.writer.submit({ script: `<Canvas name="Board"><Totem name="T"><Note name="A" drop="${a.id}"/><Note name="B" drop="${b.id}"/></Totem></Canvas>`, owner: 'claude' });
  await s.settle();
  await s.writer.submit({ script: `<Canvas name="Board"><Totem name="T"><Note name="A" drop="${a.id}"/></Totem></Canvas>`, owner: 'claude' });
  await s.settle();
  assert.deepEqual(s.list().files.map((f) => f.drop.id), [a.id]);
  assert.equal(ragx.asked.length, 2);
});

test('while RAGX is not answering the list waits, survives a restart, and goes when RAGX is back', async (t) => {
  const s = setup(t, null); // RAGX's folder holds no runtime.json: not running
  const a = s.bronze.land({ text: 'one', canvas: 'Board' });
  await s.writer.submit({ script: `<Canvas name="Board"><Totem name="T"><Note name="A" drop="${a.id}"/></Totem></Canvas>`, owner: 'claude' });
  await s.settle();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.data, 'docs', 'drops-pending.json'), 'utf8')), ['Board']);
  assert.equal(s.logs.filter((m) => /wait for RAGX/.test(m)).length, 1);
  await s.sync.flush();
  assert.equal(s.logs.filter((m) => /wait for RAGX/.test(m)).length, 1, 'said once, not on every try');
  const ragx = await fakeRagx(t);
  const later = new DropSync({ dataDir: s.data, config: s.config, agent: s.agent, bronze: s.bronze, runtime: ragx.runtime });
  assert.deepEqual(await later.start(), ['Board']);
  await later.stop();
  assert.deepEqual(ragx.asked, [{ url: '/api/notex/drops', body: { canvas: 'Board' } }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.data, 'docs', 'drops-pending.json'), 'utf8')), []);
});

test('auto-sync never takes an agent canvas, even when switched on before it was assigned', (t) => {
  const s = setup(t, null);
  fs.mkdirSync(path.join(s.ws, 'Notes'), { recursive: true });
  fs.writeFileSync(path.join(s.ws, 'Notes', 'fabric.json'), '{}');
  s.config.sync = { Board: { synced: null, at: null }, Notes: { synced: null, at: null } };
  const auto = new AutoSync({ config: s.config, saveConfig: () => {}, dataDir: s.data, build: () => ({}) });
  assert.deepEqual(auto.watched(), ['Notes']);
});
