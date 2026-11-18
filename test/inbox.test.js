/* The Inbox over the engine: files as their bytes and typed text kept in
 * bronze, sent only to canvases assigned to the agent, and forgotten on
 * request (t-0f32cb63f2, t-52f040cf72, t-70d92dbfb0). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../engine/lib/server.js';
import { MODELS } from '../engine/lib/models.js';

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
  assert.match(one.totems[0].script, /<Totem id="tm-[0-9a-f]{10}" name="RAGX">/);
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

test("CanvasX Studio's page is let in by default, beside ter-manager's (t-8d7abac0f3)", async () => {
  for (const origin of ['http://127.0.0.1:7075', 'http://localhost:7075', 'http://localhost:7070']) {
    const r = await fetch(s.url + '/api/state', { headers: { 'x-notex-token': s.token, origin } });
    assert.equal(r.status, 200, origin);
    assert.equal(r.headers.get('access-control-allow-origin'), origin);
  }
  assert.equal((await fetch(s.url + '/api/state', { headers: { 'x-notex-token': s.token, origin: 'http://127.0.0.1:7076' } })).status, 403);
});

test('a send from the composer: files with the user\'s description and message, all of it or none (t-e0f8a22b3a, t-fe28f948b4)', async () => {
  const send = async (fields, files = []) => {
    const fd = new FormData();
    for (const [name, bytes] of files) fd.append('file', new Blob([bytes]), name);
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const res = await fetch(s.url + '/api/inbox/send', { method: 'POST', headers: { 'x-notex-token': s.token }, body: fd });
    return { status: res.status, body: await res.json() };
  };
  const count = async () => (await call('GET', '/api/inbox')).body.drops.length;

  const r = await send({ description: 'the March invoice and my notes on it', message: 'make a totem named Money', canvas: 'Harness' },
    [['March invoice.pdf', PDF], ['notes.md', Buffer.from('# Notes\n- paid late\n')]]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.send, /^s-[0-9a-f]{10}$/);
  assert.deepEqual(r.body.drops.map((d) => [d.name, d.send, d.note, d.ask, d.status, d.canvas]), [
    ['March invoice.pdf', r.body.send, 'the March invoice and my notes on it', 'make a totem named Money', 'queued', 'Harness'],
    ['notes.md', r.body.send, 'the March invoice and my notes on it', 'make a totem named Money', 'queued', 'Harness'],
  ]);

  // With no file, the description is what is kept.
  const words = await send({ description: 'just words', message: '', canvas: '' });
  assert.equal(words.body.drops.length, 1);
  assert.deepEqual([words.body.drops[0].kind, words.body.drops[0].note, words.body.drops[0].preview, words.body.drops[0].status], ['text', null, 'just words', 'waiting']);

  // One bad file and nothing of the send lands.
  const before = await count();
  const bad = await send({ description: 'two files' }, [['ok.pdf', PDF], ['fake.png', Buffer.from('not a picture')]]);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'not-kind');
  assert.equal(await count(), before);

  // "As my message says" needs a message; then the drop is queued with no canvas.
  assert.equal((await send({ description: 'x', byMessage: 'true' })).body.error.code, 'no-ask');
  const by = await send({ description: 'x', message: 'a new canvas named Bills', byMessage: 'true' });
  assert.deepEqual([by.body.drops[0].status, by.body.drops[0].canvas, by.body.drops[0].byMessage], ['queued', null, true]);
  assert.equal((await send({ description: '  ', message: 'hello' })).body.error.code, 'empty');
  assert.equal((await send({ description: 'x', canvas: 'Notes' })).status, 409);
  const later = await call('PUT', `/api/inbox/${words.body.drops[0].id}/canvas`, { body: { byMessage: true } });
  assert.equal(later.body.error.code, 'no-ask');
});

test('the placer\'s model is switched from the page, and an ask is refused before it reaches Claude (t-fe1817678b, t-a9198c414f)', async () => {
  assert.equal((await call('PUT', '/api/placer', { body: { model: 'gpt' } })).body.error.code, 'bad-model');
  const r = await call('PUT', '/api/placer', { body: { model: 'opus' } });
  assert.equal(r.body.placer.model, 'opus');
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).placer.model, 'opus');
  assert.deepEqual((await call('GET', '/api/inbox')).body.models, MODELS);
  const one = (await call('GET', '/api/agent-canvases/Harness')).body;
  assert.deepEqual([one.ask, one.model, one.models], [null, 'sonnet', MODELS]);
  // Every one of these is refused before any model is asked.
  assert.equal((await call('POST', '/api/agent-canvases/Harness/ask', { body: { ask: 'tidy', model: 'gpt' } })).body.error.code, 'bad-model');
  assert.equal((await call('POST', '/api/agent-canvases/Harness/ask', { body: {} })).status, 400);
  assert.match((await call('POST', '/api/agent-canvases/Harness/ask', { body: { ask: '   ' } })).body.error.message, /Write what the agent should do/);
  assert.match((await call('POST', '/api/agent-canvases/Notes/ask', { body: { ask: 'tidy', model: 'haiku' } })).body.error.message, /not assigned to the agent/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).arranger, undefined, 'a refused ask keeps no model');
});

test('CanvasX\'s link: written into the workspace, opening only an agent canvas\'s chat, from CanvasX\'s page (t-76dff4fffe)', async () => {
  const link = JSON.parse(fs.readFileSync(path.join(workspace, '.notex', 'link.json'), 'utf8'));
  assert.equal(link.url, s.url);
  assert.equal(link.token, s.linkToken);
  const viaLink = (method, p, { body, origin } = {}) => fetch(s.url + p, {
    method,
    headers: { 'x-notex-link': link.token, ...(origin ? { origin } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const chat = await viaLink('GET', '/api/link/canvases/Harness', { origin: 'http://localhost:9075' });
  assert.equal(chat.status, 200);
  assert.equal(chat.headers.get('access-control-allow-origin'), 'http://localhost:9075');
  const body = await chat.json();
  assert.deepEqual([body.name, Array.isArray(body.chat), body.models], ['Harness', true, MODELS]);
  // The link token opens nothing else, and CanvasX's page reaches nothing else.
  assert.equal((await viaLink('GET', '/api/state')).status, 401);
  assert.equal((await fetch(s.url + '/api/state', { headers: { 'x-notex-token': s.token, origin: 'http://localhost:9075' } })).status, 403);
  assert.equal((await fetch(s.url + '/api/link/canvases/Harness', { headers: { 'x-notex-link': 'wrong' } })).status, 401);
  assert.equal((await viaLink('GET', '/api/link/canvases/Notes')).status, 409);
  assert.equal((await viaLink('GET', '/api/link/canvases/Nowhere')).status, 404);
  // Refused before any model is asked.
  assert.equal((await viaLink('POST', '/api/link/canvases/Harness/ask', { body: { ask: 'tidy', model: 'gpt' } })).status, 400);
  assert.match((await (await viaLink('POST', '/api/link/canvases/Harness/ask', { body: { ask: ' ' } })).json()).error.message, /Write what the agent should do/);
  const pre = await fetch(s.url + '/api/link/canvases/Harness/ask', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:9075' } });
  assert.match(pre.headers.get('access-control-allow-headers'), /X-Notex-Link/);
});

test('the link goes when the engine stops, and only the engine\'s own', async () => {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-link-'));
  const ws2 = path.join(tmp2, 'ws');
  fs.mkdirSync(path.join(ws2, 'A'), { recursive: true });
  fs.writeFileSync(path.join(ws2, 'A', 'fabric.json'), '{}');
  fs.mkdirSync(path.join(tmp2, 'data'));
  fs.writeFileSync(path.join(tmp2, 'data', 'config.json'), JSON.stringify({ workspace: ws2, placing: false, ragx: path.join(tmp2, 'no-ragx') }));
  const s2 = await startServer({ dataDir: path.join(tmp2, 'data'), port: 0, runtimeFile: path.join(tmp2, 'plugin', 'runtime.json'), log: () => {}, signals: false });
  const file = path.join(ws2, '.notex', 'link.json');
  assert.ok(fs.existsSync(file));
  await s2.stop();
  assert.ok(!fs.existsSync(file));
  assert.ok(!fs.existsSync(path.dirname(file)), 'the empty .notex folder goes too');
  fs.rmSync(tmp2, { recursive: true, force: true });
});

test('an agent canvas is always kept in RAGX: switching it on changes nothing, off is refused (t-65a490ef80)', async () => {
  const off = await call('PUT', '/api/fabrics/Harness/sync', { body: { on: false } });
  assert.equal(off.status, 409);
  assert.match(off.body.error.message, /always kept in RAGX/);
  assert.equal((await call('PUT', '/api/fabrics/Harness/sync', { body: { on: true } })).status, 200);
  assert.ok((await call('GET', '/api/state')).body.sync.Harness, 'reported as kept');
});

test('CanvasX\'s chat sends attachments through the link: kept as drops of the canvas and placed by the chat agent (t-9bc7df3233)', async () => {
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-chatsend-'));
  const ws3 = path.join(tmp3, 'ws');
  for (const name of ['Board', 'Mine']) {
    fs.mkdirSync(path.join(ws3, name), { recursive: true });
    fs.writeFileSync(path.join(ws3, name, 'fabric.json'), JSON.stringify({ areas: [], drawings: [], files: [], links: [], totems: [] }));
  }
  fs.writeFileSync(path.join(ws3, 'Board', 'agent.json'), '{}');
  const data3 = path.join(tmp3, 'data');
  fs.mkdirSync(data3);
  fs.writeFileSync(path.join(data3, 'config.json'), JSON.stringify({ workspace: ws3, placing: false, ragx: path.join(tmp3, 'no-ragx') }));
  const asked = [];
  // A stand-in for Claude: it places whatever drops the prompt was given.
  const arrangerRun = async (req) => {
    asked.push(req);
    const ids = [...new Set([...req.prompt.matchAll(/- id: (d-[0-9a-f]{10})/g)].map((m) => m[1]))];
    return { text: `Placed.\n\`\`\`xml\n<Canvas name="Board"><Totem name="Inbox">${ids.map((id) => `<File drop="${id}"/>`).join('')}</Totem></Canvas>\n\`\`\`` };
  };
  const s3 = await startServer({ dataDir: data3, port: 0, runtimeFile: path.join(tmp3, 'plugin', 'runtime.json'), log: () => {}, signals: false, syncOptions: { arrangerRun } });
  try {
    const send = async (canvas, fields, files = []) => {
      const fd = new FormData();
      for (const [n, b] of files) fd.append('file', new Blob([b]), n);
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      const res = await fetch(`${s3.url}/api/link/canvases/${encodeURIComponent(canvas)}/send`, { method: 'POST', headers: { 'x-notex-link': s3.linkToken }, body: fd });
      return { status: res.status, body: await res.json() };
    };
    assert.equal((await send('Board', { message: 'hi' })).body.error.code, 'empty');
    assert.equal((await send('Board', { message: 'x', model: 'gpt' }, [['a.pdf', PDF]])).body.error.code, 'bad-model');
    assert.equal((await send('Mine', { message: 'x' }, [['a.pdf', PDF]])).status, 409);
    assert.equal((await send('Board', { message: 'x' }, [['fake.png', Buffer.from('nope')]])).body.error.code, 'not-kind');
    const r = await send('Board', { message: 'file the survey', model: 'haiku' }, [['survey.pdf', PDF]]);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const [id] = r.body.drops;
    for (let i = 0; i < 50 && (await (await fetch(`${s3.url}/api/link/canvases/Board`, { headers: { 'x-notex-link': s3.linkToken } })).json()).ask.status === 'working'; i++) await new Promise((res) => setTimeout(res, 50));
    const chat = (await (await fetch(`${s3.url}/api/link/canvases/Board`, { headers: { 'x-notex-link': s3.linkToken } })).json());
    assert.equal(chat.ask.status, 'done', chat.ask.detail);
    assert.equal(asked[0].model, 'haiku');
    assert.deepEqual(chat.chat[0].attachments, [{ id, name: 'survey.pdf', kind: 'pdf' }]);
    const drop = (await (await fetch(`${s3.url}/api/inbox`, { headers: { 'x-notex-token': s3.token } })).json()).drops.find((d) => d.id === id);
    assert.deepEqual([drop.status, drop.canvas, drop.ask, drop.via], ['placed', 'Board', 'file the survey', 'canvasx']);
  } finally {
    await s3.stop();
    fs.rmSync(tmp3, { recursive: true, force: true });
  }
});
