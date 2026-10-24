import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../engine/lib/server.js';
import { sampleState } from './fixtures.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-server-'));
const workspace = path.join(tmp, 'workspace');
const data = path.join(tmp, 'data');
let s;

before(async () => {
  fs.mkdirSync(path.join(workspace, 'Thesis', 'sources'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'Thesis', 'fabric.json'), JSON.stringify(sampleState()));
  fs.mkdirSync(path.join(workspace, 'not a fabric'));
  s = await startServer({ dataDir: data, port: 0, runtimeFile: path.join(tmp, 'plugin', 'runtime.json'), log: () => {}, signals: false });
});
after(async () => { await s.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

const call = (method, p, { body, headers = {} } = {}) => fetch(s.url + p, {
  method,
  headers: { 'x-notex-token': s.token, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
});

/* fetch sets Host itself and tidies ".." out of a path; http.request sends
 * what it is given, as a hostile page or tool could. */
const raw = (p, headers = {}) => new Promise((resolve, reject) => {
  const u = new URL(s.url);
  const req = http.request({ host: u.hostname, port: u.port, path: p, headers: { 'x-notex-token': s.token, ...headers } }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject);
  req.end();
});

test('runtime.json names the engine and its token', () => {
  const rt = JSON.parse(fs.readFileSync(path.join(tmp, 'plugin', 'runtime.json'), 'utf8'));
  assert.equal(rt.url, s.url);
  assert.equal(rt.token, s.token);
  assert.ok(fs.existsSync(path.join(tmp, 'plugin', 'local.json')));
});

test('a request without the token, from another page, or to another host is refused', async () => {
  assert.equal((await fetch(s.url + '/api/state')).status, 401);
  assert.equal((await call('GET', '/api/state', { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal(await raw('/api/state', { host: `evil.example:${new URL(s.url).port}` }), 421);
  assert.equal(await raw('/api/state'), 200);
});

test('the workspace is set once and its fabrics listed and built', async () => {
  assert.equal((await call('GET', '/api/fabrics')).status, 409);
  assert.equal((await call('PUT', '/api/workspace', { body: { path: 'relative/folder' } })).status, 400);
  const set = await (await call('PUT', '/api/workspace', { body: { path: workspace } })).json();
  assert.equal(set.fabrics, 1);
  const st = await (await call('GET', '/api/state')).json();
  assert.equal(st.workspace, workspace);
  const list = await (await call('GET', '/api/fabrics')).json();
  assert.deepEqual(list.fabrics.map((f) => f.name), ['Thesis']);
  const built = await (await call('GET', '/api/fabrics/Thesis')).json();
  assert.match(built.markdown, /^## RESEARCH \(totem\) > GAP PAPERS > LITERATURE SURVEY$/m);
  assert.ok(built.map.places.length > 10);
  assert.ok(fs.existsSync(path.join(data, 'docs', 'Thesis.notex.md')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')), { workspace });
});

test('Read images runs in the background and the next build carries the readings', async () => {
  const ragx = http.createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ kind: 'photo', text: 'GAP', description: 'A whiteboard listing research gaps.', model: 'haiku' }));
  });
  await new Promise((r) => ragx.listen(0, '127.0.0.1', r));
  const folder = path.join(tmp, 'ragx-plugin');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'plugin.json'), '{}');
  fs.writeFileSync(path.join(folder, 'runtime.json'), JSON.stringify({ url: `http://127.0.0.1:${ragx.address().port}`, token: 't' }));
  try {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const state = sampleState();
    state.files.push({ id: 'img', name: 'board.png', isImage: true, imageDataUrl: `data:image/png;base64,${png}`, x: 200, y: 200, areaId: 'A2', linkedTotemId: 'T1' });
    fs.mkdirSync(path.join(workspace, 'Board'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'Board', 'fabric.json'), JSON.stringify(state));
    assert.equal((await call('PUT', '/api/ragx', { body: { path: folder } })).status, 200);
    assert.equal((await call('POST', '/api/fabrics/Board/read')).status, 202);
    let job;
    for (let i = 0; i < 50; i++) {
      job = (await (await call('GET', '/api/state')).json()).reading;
      if (job.finished) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(job.result.read, 1);
    const built = await (await call('GET', '/api/fabrics/Board')).json();
    assert.equal(built.unread, 0);
    assert.match(built.markdown, /^Shows: A whiteboard listing research gaps\.$/m);
    assert.ok(fs.readdirSync(path.join(data, 'images')).length === 1);
  } finally { ragx.close(); }
});

test('a fabric name cannot climb out of the workspace', async () => {
  // URL parsing folds an encoded ".." away before the route sees it.
  assert.equal(await raw('/api/fabrics/%2E%2E'), 404);
  assert.equal(await raw(`/api/fabrics/${encodeURIComponent('..\\data')}`), 400);
  assert.equal((await call('GET', '/api/fabrics/Missing')).status, 404);
});
