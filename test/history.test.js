/* An agent canvas's history: a git repository of its totem scripts, one
 * commit per write, by who wrote and when, started from the versions NoteX
 * already kept (t-732b681a32, t-b3d20f5afa, t-57a020ecce, t-c20021da28,
 * t-9dbb490caa). Everything runs in a temp folder. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Writer } from '../engine/lib/writer.js';
import { Bronze } from '../engine/lib/bronze.js';
import { AgentCanvases, scriptFile } from '../engine/lib/agentcanvas.js';
import { History, HistoryError } from '../engine/lib/history.js';
import { startServer } from '../engine/lib/server.js';

function setup(t, { git } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws');
  const data = path.join(root, 'data');
  for (const name of ['Board', 'Mine']) {
    fs.mkdirSync(path.join(ws, name), { recursive: true });
    fs.writeFileSync(path.join(ws, name, 'fabric.json'), JSON.stringify({ drawings: [], areas: [], files: [], links: [], totems: [], tables: [] }));
  }
  fs.writeFileSync(path.join(ws, 'Board', 'agent.json'), JSON.stringify({ assignedAt: '2026-11-08T10:00:00.000Z' }));
  const logs = [];
  const config = { workspace: ws };
  let clock = Date.parse('2026-11-08T12:00:00.000Z');
  const now = () => clock;
  const writer = new Writer({ config, dataDir: data, log: (m) => logs.push(m) });
  const agent = new AgentCanvases({ dataDir: data, writer, bronze: new Bronze(data), log: (m) => logs.push(m), now });
  writer.agent = agent;
  const history = new History({ dataDir: data, config, log: (m) => logs.push(m), now, ...(git ? { git } : {}) });
  agent.history = history;
  const at = (iso) => { clock = Date.parse(iso); };
  const write = async (name, body, owner = 'claude-a') => {
    const e = await writer.submit({ script: `<Canvas name="Board"><Totem name="${name}">${body}</Totem></Canvas>`, owner });
    assert.equal(e.status, 'written', JSON.stringify(e.result));
  };
  const on = () => history.set('Board', true, { replay: () => agent.replay('Board'), snapshot: () => agent.snapshot('Board') });
  return { root, ws, data, writer, agent, history, at, write, on, logs, config };
}

const note = (words) => `<Area name="Box"><Note name="N">${words}</Note></Area>`;

test('switched on, the history starts with the versions NoteX already kept, in order, by who wrote them', async (t) => {
  const { at, write, on, history, agent } = setup(t);
  at('2026-11-08T12:00:00.000Z'); await write('Plan', note('- [ ] one'), 'claude-automatu-builder');
  at('2026-11-08T12:30:00.000Z'); await write('Rules', note('- [ ] be kind'), 'claude-rules');
  at('2026-11-08T13:00:00.000Z'); await write('Plan', note('- [ ] one\n- [ ] two'), 'claude-automatu-builder');
  at('2026-11-08T14:00:00.000Z'); await write('Plan', note('- [ ] three'), 'claude-other');
  at('2026-11-09T09:00:00.000Z');
  const r = on();
  assert.equal(r.on, true);
  assert.equal(r.replayed, 4, 'one commit for each write NoteX kept');
  const log = history.log('Board');
  assert.deepEqual(log.map((c) => [c.at, c.who]).reverse(), [
    ['2026-11-08T12:00:00.000Z', 'claude-automatu-builder'],
    ['2026-11-08T12:30:00.000Z', 'claude-rules'],
    ['2026-11-08T13:00:00.000Z', 'claude-automatu-builder'],
    ['2026-11-08T14:00:00.000Z', 'claude-other'],
  ]);
  assert.deepEqual(log[0].changed, ['Plan']);
  assert.deepEqual(log[3].added, ['Plan']);
  // An earlier time gives the scripts as they stood then.
  const then = history.at('Board', '2026-11-08T13:30:00Z');
  assert.deepEqual(then.totems.map((x) => x.name), ['Plan', 'Rules']);
  assert.match(then.totems[0].script, /- \[ \] two/);
  assert.equal(history.at('Board', '2026-11-08T12:10:00Z').totems.length, 1);
  assert.equal(history.at('Board', '2026-11-08T11:00:00Z'), null, 'nothing before the first write');
  // The newest is the canvas now, byte for byte.
  const nowScripts = history.at('Board', Date.now() + 1e9).totems;
  for (const x of nowScripts) assert.equal(x.script, agent.read('Board', x.file));
});

test('with history on, each write is one commit by its writer at its time, and a write that changes nothing adds none', async (t) => {
  const { at, write, on, history, writer } = setup(t);
  at('2026-11-08T12:00:00.000Z'); await write('Plan', note('- [ ] one'));
  on();
  const first = history.log('Board').length;
  at('2026-11-09T08:15:30.123Z'); await write('Plan', note('- [x] one'), 'claude-b');
  const [last] = history.log('Board');
  assert.equal(history.log('Board').length, first + 1);
  assert.deepEqual([last.at, last.who, last.changed], ['2026-11-09T08:15:30.123Z', 'claude-b', ['Plan']]);
  // Two writes within one second stay apart: times are kept to the millisecond.
  at('2026-11-09T08:15:30.500Z'); await write('Plan', note('- [x] one\n- [ ] two'), 'claude-c');
  assert.match(history.at('Board', '2026-11-09T08:15:30.200Z').totems[0].script, /- \[x\] one<\/Note>/);
  assert.match(history.at('Board', '2026-11-09T08:15:30.600Z').totems[0].script, /two/);
  // Draw again changes no script, so the history is as it was.
  const n = history.log('Board').length;
  await writer.serial(() => writer.agent.render('Board'));
  assert.equal(history.log('Board').length, n);
  // The repository is NoteX's alone: no hooks ran, nothing to push to.
  const dir = history.dir('Board');
  assert.equal(execFileSync('git', ['remote'], { cwd: dir }).toString().trim(), '');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString().trim(), '');
});

test('a deleted totem is in the history up to its deletion, from before history was on and after', async (t) => {
  const { at, write, on, history, agent, writer } = setup(t);
  at('2026-11-08T12:00:00.000Z'); await write('Old', note('- [ ] gone soon'));
  at('2026-11-08T12:05:00.000Z'); await write('Keep', note('- [ ] stays'));
  at('2026-11-08T13:00:00.000Z');
  await writer.serial(() => agent.render('Board', { remove: ['Old'] }));
  agent.note('Board', 'deleted', { totems: ['Old'], items: [] }); // as the chat's agent says it
  at('2026-11-09T09:00:00.000Z'); on();
  assert.deepEqual(history.at('Board', '2026-11-08T12:30:00Z').totems.map((x) => x.name), ['Old', 'Keep']);
  assert.deepEqual(history.at('Board', '2026-11-08T13:30:00Z').totems.map((x) => x.name), ['Keep']);
  const gone = history.log('Board').find((c) => c.deleted.includes('Old'));
  assert.equal(gone.at, '2026-11-08T13:00:00.000Z');
  assert.equal(gone.who, 'NoteX agent');
  // Deleted with history on: one commit saying so.
  at('2026-11-09T10:00:00.000Z');
  await writer.serial(() => agent.render('Board', { remove: ['Keep'] }));
  assert.deepEqual(history.log('Board')[0].deleted, ['Keep']);
  assert.equal(history.at('Board', '2026-11-09T09:30:00Z').totems.length, 1);
  assert.equal(history.at('Board', '2026-11-09T10:30:00Z').totems.length, 0);
});

test('off, nothing more is kept and what was kept stays; a write never fails for the history', async (t) => {
  const { at, write, on, history, config } = setup(t);
  at('2026-11-08T12:00:00.000Z'); await write('Plan', note('- [ ] one'));
  on();
  at('2026-11-08T13:00:00.000Z');
  assert.equal(history.set('Board', false).on, false);
  assert.ok(config.history.Board.off);
  const n = history.log('Board').length;
  await write('Plan', note('- [ ] two'));
  assert.equal(history.log('Board').length, n, 'no commit while off');
  assert.ok(history.exists('Board'));

  // Git missing: switching on says so, and a write still goes through.
  const b = setup(t, { git: path.join(b0(t), 'no-git-here.exe') });
  await assert.rejects(async () => b.on(), (e) => e instanceof HistoryError && e.code === 'no-git');
  b.config.history = { Board: { on: true } };
  await b.write('Plan', note('- [ ] still written'));
  assert.ok(b.logs.some((l) => /Keeping Board's history failed: Git was not found/.test(l)));
});
const b0 = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-nogit-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('a data folder inside a git repository is refused, so history never lands among code', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-history-repo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const h = new History({ dataDir: path.join(root, 'data'), config: {} });
  assert.throws(() => h.set('Board', true, { snapshot: () => [] }), (e) => e instanceof HistoryError && e.code === 'unsafe-folder');
  assert.ok(!fs.existsSync(path.join(root, 'data', 'history')));
});

test('the routes: Keep history only for an agent canvas, the commits, and the scripts at a time', async (t) => {
  const { ws, data, root } = setup(t);
  const s = await startServer({ dataDir: data, port: 0, runtimeFile: path.join(root, 'plugin', 'runtime.json'), log: () => {}, signals: false });
  t.after(() => s.stop());
  const call = (method, p, body) => fetch(s.url + p, { method, headers: { 'x-notex-token': s.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await call('PUT', '/api/workspace', { path: ws })).status, 200);
  const sent = await (await call('POST', '/api/scripts', { script: `<Canvas name="Board"><Totem name="Plan">${note('- [ ] one')}</Totem></Canvas>`, owner: 'claude-a' })).json();
  assert.ok(sent);
  for (let i = 0; i < 50 && !fs.existsSync(path.join(data, 'agent-canvases', 'Board', scriptFile('Plan'))); i++) await new Promise((r) => setTimeout(r, 50));

  const mine = await call('PUT', '/api/fabrics/Mine/history', { on: true });
  assert.equal(mine.status, 409);
  assert.equal((await mine.json()).error.code, 'not-agent');
  assert.equal((await call('GET', '/api/fabrics/Board/script?when=2026-11-08T12:00:00Z')).status, 404, 'no history yet');

  const r = await (await call('PUT', '/api/fabrics/Board/history', { on: true })).json();
  assert.equal(r.history.on, true);
  assert.equal(r.latest.length, 1);
  const h = await (await call('GET', '/api/fabrics/Board/history')).json();
  assert.deepEqual(h.commits[0].added, ['Plan']);
  const then = await (await call('GET', `/api/fabrics/Board/script?when=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).json();
  assert.match(then.script, /<Totem name="Plan">/);
  assert.equal(then.by, 'claude-a');
  assert.equal((await call('GET', '/api/fabrics/Board/script?when=yesterday')).status, 400);
  const view = await (await call('GET', '/api/agent-canvases/Board')).json();
  assert.equal(view.history.on, true);
  assert.equal(view.history.latest.length, 1);
});
