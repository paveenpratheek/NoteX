/* The Inbox over the engine: files as their bytes and typed text kept in
 * bronze, sent only to canvases assigned to the agent, and forgotten on
 * request (t-0f32cb63f2, t-52f040cf72, t-70d92dbfb0). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../engine/lib/server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-inbox-'));
const workspace = path.join(tmp, 'workspace');
const data = path.join(tmp, 'data');
let s;

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

before(async () => {
  for (const name of ['Harness', 'Notes']) {
    fs.mkdirSync(path.join(workspace, name), { recursive: true });
    fs.writeFileSync(path.join(workspace, name, 'fabric.json'), JSON.stringify({ areas: [], drawings: [], files: [], links: [], totems: [] }));
  }
  // Harness is assigned to the agent the way CanvasX marks it; Notes is the user's.
  fs.writeFileSync(path.join(workspace, 'Harness', 'agent.json'), JSON.stringify({ assignedAt: '2026-10-30T10:00:00Z' }));
  fs.mkdirSync(data, { recursive: true });
  // Placing stays off here: these tests queue drops, and nothing may reach Claude.
  // And RAGX is a folder with no engine in it, so no drop list reaches the user's own RAGX.
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspace, placing: false, ragx: path.join(tmp, 'no-ragx') }));
  s = await startServer({ dataDir: data, port: 0, runtimeFile: path.join(tmp, 'plugin', 'runtime.json'), log: () => {}, signals: false });
});
after(async () => { await s.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

const call = async (method, p, { body, bytes, headers = {} } = {}) => {
  const res = await fetch(s.url + p, {
    method,
    headers: { 'x-notex-token': s.token, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : bytes,
  });
  return { status: res.status, body: await res.json() };
};
const file = (bytes, name, extra = {}) => call('POST', '/api/inbox/file', { bytes, headers: { 'x-drop-name': encodeURIComponent(name), ...extra } });

test('the inbox offers only the canvases assigned to the agent', async () => {
  const r = await call('GET', '/api/inbox');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.drops, []);
  assert.deepEqual(r.body.canvases, ['Harness']);
  assert.equal(r.body.placer.on, false);
});

test('a file comes as its bytes, with its name and note in headers, and waits for a canvas', async () => {
  const r = await file(PDF, 'Lit survey (draft) — v2.pdf', { 'x-drop-note': encodeURIComponent('read first, then the café notes') });
  assert.equal(r.status, 200);
  assert.equal(r.body.drop.name, 'Lit survey (draft) — v2.pdf');
  assert.equal(r.body.drop.note, 'read first, then the café notes');
  assert.equal(r.body.drop.status, 'waiting');
  const st = (await call('GET', '/api/state')).body;
  assert.deepEqual(st.inbox, { drops: 1, waiting: 1 });

  const chosen = await call('PUT', `/api/inbox/${r.body.drop.id}/canvas`, { body: { canvas: 'Harness' } });
  assert.equal(chosen.body.drop.status, 'queued');
  assert.equal(chosen.body.drop.canvas, 'Harness');
  assert.equal((await call('GET', '/api/state')).body.inbox.waiting, 0);
});

test('typed text is kept, shown by its first words, and can go straight to a canvas', async () => {
  const r = await call('POST', '/api/inbox/text', { body: { text: 'RAGX misses figures\n  on scanned pages', note: '', canvas: 'Harness' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.drop.kind, 'text');
  assert.equal(r.body.drop.preview, 'RAGX misses figures on scanned pages');
  assert.equal(r.body.drop.status, 'queued');
  assert.equal(r.body.drop.note, null);
});

test('a canvas not assigned to the agent, a bad file and a missing name are refused', async () => {
  const notAgent = await call('POST', '/api/inbox/text', { body: { text: 'hello', canvas: 'Notes' } });
  assert.equal(notAgent.status, 409);
  assert.equal(notAgent.body.error.code, 'not-agent');
  assert.equal((await call('POST', '/api/inbox/text', { body: { text: 'hello', canvas: '../Notes' } })).status, 400);
  const renamed = await file(Buffer.from('MZ not really a pdf'), 'setup.pdf');
  assert.equal(renamed.status, 400);
  assert.equal(renamed.body.error.code, 'not-kind');
  assert.equal((await file(PDF, 'page.html')).body.error.code, 'kind');
  assert.equal((await call('POST', '/api/inbox/file', { bytes: PDF })).body.error.code, 'no-name');
  assert.equal((await call('PUT', '/api/inbox/d-0123456789/canvas', { body: { canvas: 'Harness' } })).status, 404);
  const { drops } = (await call('GET', '/api/inbox')).body;
  const one = drops[0];
  assert.equal((await call('PUT', `/api/inbox/${one.id}/canvas`, { body: { canvas: 'Notes' } })).status, 409);
});

test('a drop forgotten from the page is gone for good', async () => {
  const before = (await call('GET', '/api/inbox')).body.drops;
  const pdf = before.find((d) => d.kind === 'pdf');
  const r = await call('POST', `/api/inbox/${pdf.id}/forget`);
  assert.equal(r.body.id, pdf.id);
  assert.equal(r.body.blob, 'deleted');
  const after = (await call('GET', '/api/inbox')).body.drops;
  assert.equal(after.length, before.length - 1);
  assert.ok(!fs.readFileSync(path.join(data, 'bronze', 'drops.jsonl'), 'utf8').includes('Lit survey'));
  assert.equal((await call('POST', `/api/inbox/${pdf.id}/forget`)).status, 404);
});

test('an agent canvas is written by whole totem scripts, read back as its scripts, and drawn again on request', async () => {
  const words = (await call('POST', '/api/inbox/text', { body: { text: 'Check the reader on page renders', canvas: 'Harness' } })).body.drop;
  const script = `<Canvas name="Harness"><Totem name="RAGX"><Area name="Bugs"><Note name="Figures" drop="${words.id}"/></Area></Totem></Canvas>`;
  const w = await call('POST', '/api/scripts', { body: { script, owner: 'claude' } });
  assert.equal(w.body.entry.status, 'written', JSON.stringify(w.body.entry.result));
  assert.deepEqual(w.body.entry.result.placed, [words.id]);
  const read = (await call('GET', '/api/fabrics/Harness/script')).body;
  assert.equal(read.agent, true);
  assert.match(read.script, /^<!-- Harness is an agent canvas/);
  assert.ok(read.script.includes(`<Note name="Figures" drop="${words.id}"/>`), 'the script as sent, not a read-out with ids');
  assert.equal((await call('GET', '/api/fabrics/Harness/script?at=' + encodeURIComponent('Nothing (totem)'))).status, 404);
  const list = (await call('GET', '/api/fabrics')).body.fabrics;
  assert.deepEqual(list.map((f) => [f.name, f.agent]).sort(), [['Harness', true], ['Notes', false]]);
  const r = await call('POST', '/api/fabrics/Harness/render');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.totems, [{ totem: 'RAGX', drawn: 'current', errors: [] }]);
  assert.equal((await call('POST', '/api/fabrics/Notes/render')).status, 409);
});

test('the Agent canvases view: every canvas, an agent canvas\'s scripts and activity, and assigning (t-a9a33794bd, t-d798b625e5, t-16d16a4f85)', async () => {
  const list = (await call('GET', '/api/agent-canvases')).body.canvases;
  const harness = list.find((c) => c.name === 'Harness');
  assert.equal(harness.agent, true);
  assert.equal(harness.totems, 1);
  assert.equal(list.find((c) => c.name === 'Notes').agent, false);

  const one = (await call('GET', '/api/agent-canvases/Harness')).body;
  assert.equal(one.totems[0].name, 'RAGX');
  assert.equal(one.totems[0].drawn, 'current');
  assert.equal(one.totems[0].drops, 1);
  assert.match(one.totems[0].script, /<Totem name="RAGX">/);
  const kinds = one.activity.map((a) => a.what);
  assert.ok(kinds.includes('render') && kinds.includes('script'));
  assert.equal(one.activity.find((a) => a.what === 'script').change, 'totem RAGX');
  assert.equal((await call('GET', '/api/agent-canvases/Nowhere')).status, 404);

  // Notes is empty: it can be assigned, and taken back - but not while CanvasX has it open.
  const lock = path.join(workspace, 'Notes', '.fabric_lock');
  fs.writeFileSync(lock, JSON.stringify({ timestamp: Date.now(), pid: 'tab' }));
  const open = await call('PUT', '/api/fabrics/Notes/agent', { body: { on: true } });
  assert.equal(open.status, 409);
  assert.match(open.body.error.message, /open in CanvasX/);
  fs.rmSync(lock);
  assert.equal((await call('PUT', '/api/fabrics/Notes/agent', { body: { on: true } })).body.changed, true);
  assert.ok(fs.existsSync(path.join(workspace, 'Notes', 'agent.json')));
  assert.deepEqual((await call('GET', '/api/agent-canvases/Notes')).body.activity.map((a) => a.what), ['assigned']);
  assert.equal((await call('PUT', '/api/fabrics/Notes/agent', { body: { on: false } })).body.changed, true);
  assert.ok(!fs.existsSync(path.join(workspace, 'Notes', 'agent.json')));
  // A canvas holding anything is refused.
  fs.writeFileSync(path.join(workspace, 'Notes', 'fabric.json'), JSON.stringify({ areas: [{ id: 'a', name: 'Mine', polygons: [] }], drawings: [], files: [], links: [], totems: [] }));
  const full = await call('PUT', '/api/fabrics/Notes/agent', { body: { on: true } });
  assert.equal(full.status, 409);
  assert.match(full.body.error.message, /already holds items/);
  fs.writeFileSync(path.join(workspace, 'Notes', 'fabric.json'), JSON.stringify({ areas: [], drawings: [], files: [], links: [], totems: [] }));
});

test('placing is switched on and off from the page, and kept in the config', async () => {
  assert.equal((await call('PUT', '/api/placer', { body: { on: 'yes' } })).status, 400);
  const r = await call('PUT', '/api/placer', { body: { on: false } });
  assert.equal(r.body.placer.on, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).placing, false);
  assert.equal((await call('GET', '/api/state')).body.placer.on, false);
});

test('the page may send the drop headers across origins', async () => {
  const res = await fetch(s.url + '/api/inbox/file', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:7070' } });
  assert.match(res.headers.get('access-control-allow-headers'), /X-Drop-Name, X-Drop-Note, X-Drop-Canvas/);
});
