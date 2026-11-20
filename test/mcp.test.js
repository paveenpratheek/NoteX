/* NoteX's MCP server, end to end against a running engine: the three
 * tools, what notex_write reports, and the engine being down
 * (t-9533e56e40, t-a80b904d43, t-f953330fe9, t-ad316ec0c1). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../engine/lib/server.js';
import { sampleState } from './fixtures.js';

const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'mcp.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-mcp-'));
const workspace = path.join(tmp, 'ws');
const runtimeFile = path.join(tmp, 'plugin', 'runtime.json');
let s;

before(async () => {
  for (const name of ['Thesis', 'Rules']) {
    fs.mkdirSync(path.join(workspace, name), { recursive: true });
    fs.writeFileSync(path.join(workspace, name, 'fabric.json'), JSON.stringify(sampleState()));
  }
  // An empty canvas, to be the agent's, with its history kept.
  fs.mkdirSync(path.join(workspace, 'Plan'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'Plan', 'fabric.json'), JSON.stringify({ drawings: [], areas: [], files: [], links: [], totems: [], tables: [], fabricColor: '#202020', camera: { x: 0, y: 0, zoom: 1 } }));
  // File Fabric has Rules open right now.
  fs.writeFileSync(path.join(workspace, 'Rules', '.fabric_lock'), JSON.stringify({ timestamp: Date.now(), pid: 'tab' }));
  s = await startServer({ dataDir: path.join(tmp, 'data'), port: 0, runtimeFile, log: () => {}, signals: false });
  const put = (p, body) => fetch(s.url + p, { method: 'PUT', headers: { 'x-notex-token': s.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await put('/api/workspace', { path: workspace });
});
after(async () => { await s.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

/* One MCP session: messages in, answers by id out. */
function session(runtime = runtimeFile) {
  const child = spawn(process.execPath, [MCP, '--runtime', runtime], { stdio: ['pipe', 'pipe', 'pipe'] });
  const answers = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      const w = answers.get(msg.id);
      if (w) { answers.delete(msg.id); w(msg); }
    }
  });
  let id = 0;
  const ask = (method, params) => new Promise((resolve) => {
    const n = ++id;
    answers.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const tool = async (name, args) => (await ask('tools/call', { name, arguments: args })).result;
  return { ask, tool, close: () => child.stdin.end() };
}

test('four tools, the format taught in notex_write, and the rules-canvas rule', async () => {
  const m = session();
  try {
    const init = await m.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code', version: '9' } });
    assert.equal(init.result.serverInfo.name, 'notex');
    assert.match(init.result.instructions, /only when the user asks/);
    assert.match(init.result.instructions, /Never write on the rules canvas/);
    const { tools } = (await m.ask('tools/list', {})).result;
    assert.deepEqual(tools.map((t) => t.name), ['notex_canvases', 'notex_read', 'notex_history', 'notex_write']);
    const write = tools.find((t) => t.name === 'notex_write').description;
    for (const tag of ['<Canvas', '<Totem', '<Add canvas', '<Edit id', '<Area', '<Note', '<Text', '<File path', '<Row>', '<Column>', '<Line', '<Link', '<ScrollBox', '<Page>', '&lt;', 'CDATA']) assert.ok(write.includes(tag), tag);
    assert.match(write, /Never write on the rules canvas/);
    // Boxes are connected with Link; Line only draws (t-bc73ca3e6f).
    assert.match(write, /To connect two boxes, use <Link from to>/);
    assert.match(write, /<Line from to> only draws a line/);
    assert.ok(write.includes('<Link from="Collect" to="Read"/>'));
    assert.match(write, /<Remove id=/);
    // A box's items go in rows of up to three, a fourth below; note items are whole lines (t-657e827477, t-db21733ba6, t-c60e2fff9d).
    assert.match(write, /side by side in a <Row> of up to three, and a fourth below/);
    assert.match(write, /images, texts and notes in any mix/);
    assert.match(write, /stack the fourth in a <Column> under a shorter note/);
    assert.match(write, /Write each note item as one whole line/);
  } finally { m.close(); }
});

test('write, read back, see it listed; a refusal names the line; an open canvas queues', async () => {
  const m = session();
  try {
    await m.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code', version: '9' } });
    const script = '<Canvas name="Thesis"><Totem name="Pipeline"><Row><Area name="Collect"><Note name="Todo">- [ ] find</Note></Area><Area name="Read"><Text>survey</Text></Area></Row><Line from="Collect" to="Read"/></Totem></Canvas>';
    const w = await m.tool('notex_write', { script });
    assert.ok(!w.isError, w.content[0].text);
    assert.match(w.content[0].text, new RegExp(`^Written on Thesis as claude-code in ${path.basename(process.cwd()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: new totem Pipeline, 6 items\\. The places it made:\\n- Pipeline \\(totem\\)  \\(id [^)]+\\)\\n- Pipeline \\(totem\\) > Collect `));
    assert.match(w.content[0].text, /Overlap check: nothing it wrote overlaps anything/);
    const r = await m.tool('notex_read', { canvas: 'Thesis', at: 'Pipeline (totem)' });
    assert.match(r.content[0].text, /<Totem name="Pipeline" id="[^"]+" owner="claude-code in /);
    assert.match(r.content[0].text, /<Line from="Pipeline \(totem\) > Collect" to="Pipeline \(totem\) > Read" id=/);
    const named = await m.tool('notex_write', { script: '<Add canvas="Thesis" at="Pipeline (totem) > Read"><Text>more</Text></Add>', as: 'someone-else' });
    assert.ok(named.isError);
    assert.match(named.content[0].text, /^Refused - nothing was written\. Line 1, column 1: "Pipeline \(totem\) > Read" is in the totem Pipeline, which belongs to claude-code in /);
    const bad = await m.tool('notex_write', { script: '<Canvas name="Thesis">\n<Totem name="X"><Area name="A"></Totem></Canvas>' });
    assert.match(bad.content[0].text, /^Refused - nothing was written\. Line 2, column 32: <\/Totem> does not match <Area>/);
    const queued = await m.tool('notex_write', { script: '<Canvas name="Rules"><Totem name="Later"><Text>x</Text></Totem></Canvas>', as: 'agent-b' });
    assert.match(queued.content[0].text, /^Queued \(script [0-9a-f]+\): File Fabric has Rules open/);
    const list = await m.tool('notex_canvases', {});
    assert.match(list.content[0].text, /- Rules \(saved [^,]+, open in File Fabric now - scripts wait, 1 script waiting: new totem Later by agent-b\)/);
    assert.match(list.content[0].text, /- Thesis \(saved [^)]+\)\n {4}refused: add to Pipeline \(totem\) > Read by someone-else - Line 1/);
    assert.match(list.content[0].text, /\n {4}written: new totem Pipeline by claude-code in /);
  } finally { m.close(); }
});

test("the engine down: the agent is told to ask the user to start NoteX", async () => {
  const m = session(path.join(tmp, 'nowhere', 'runtime.json'));
  try {
    await m.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'x', version: '1' } });
    const r = await m.tool('notex_canvases', {});
    assert.ok(r.isError);
    assert.match(r.content[0].text, /NoteX's engine is not running\. Ask the user to open NoteX in ter-manager/);
  } finally { m.close(); }
});

test('an agent sees a canvas keeps its history, lists it, and reads an earlier version (t-a26cad59c8)', async () => {
  const put = (p, body) => fetch(s.url + p, { method: 'PUT', headers: { 'x-notex-token': s.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put('/api/fabrics/Plan/agent', { on: true })).status, 200);
  const m = session();
  try {
    const text = (r) => r.content.map((c) => c.text).join('\n');
    const none = await m.tool('notex_history', { canvas: 'Plan' });
    assert.match(text(none), /Plan has no history\. The user can switch Keep history on/);
    const first = '<Canvas name="Plan"><Totem name="Steps"><Area name="Now"><Note name="One">- [ ] first</Note></Area></Totem></Canvas>';
    assert.ok(!(await m.tool('notex_write', { script: first, as: 'claude-test' })).isError);
    assert.equal((await put('/api/fabrics/Plan/history', { on: true })).status, 200);
    await new Promise((r) => setTimeout(r, 20));
    const added = await m.tool('notex_write', { script: '<Add canvas="Plan" at="Steps (totem) > Now"><Note name="Two">- [ ] second</Note></Add>', as: 'claude-test' });
    assert.ok(!added.isError, text(added));

    const list = text(await m.tool('notex_canvases', {}));
    assert.match(list, /- Plan \(.*history kept: \d+ commits?, last .* by claude-test - notex_history lists them, notex_read with when reads an earlier version/);
    assert.doesNotMatch(list.split('\n').find((l) => l.startsWith('- Thesis')), /history/);

    const h = text(await m.tool('notex_history', { canvas: 'Plan' }));
    assert.match(h, /Plan's history, kept: \d+ commits, newest first/);
    const lines = h.split('\n').filter((l) => l.startsWith('- '));
    assert.match(lines[0], /by claude-test: changed Steps \(commit [0-9a-f]{7}\)/);
    assert.match(lines[lines.length - 1], /by claude-test: added Steps/);

    // The first version, read at its own time: Two is not in it yet.
    const at = /^- (\S+) by/.exec(lines[lines.length - 1])[1];
    const then = text(await m.tool('notex_read', { canvas: 'Plan', when: at }));
    assert.match(then, /<Note name="One">/);
    assert.doesNotMatch(then, /<Note name="Two">/);
    assert.match(then, /An earlier version, from Plan's history \(commit [0-9a-f]{7}\)\. To bring it back, send the totem's script with notex_write/);
    const now = text(await m.tool('notex_read', { canvas: 'Plan' }));
    assert.match(now, /<Note name="Two">/);
    assert.match(text(await m.tool('notex_read', { canvas: 'Plan', when: 'yesterday-ish' })), /is not a time/);
  } finally { m.close(); }
});

