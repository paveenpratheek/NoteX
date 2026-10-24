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

test('a fabric name cannot climb out of the workspace', async () => {
  // URL parsing folds an encoded ".." away before the route sees it.
  assert.equal(await raw('/api/fabrics/%2E%2E'), 404);
  assert.equal(await raw(`/api/fabrics/${encodeURIComponent('..\\data')}`), 400);
  assert.equal((await call('GET', '/api/fabrics/Missing')).status, 404);
});
