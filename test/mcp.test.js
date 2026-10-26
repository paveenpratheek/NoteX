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

test('three tools, the format taught in notex_write, and the rules-canvas rule', async () => {
  const m = session();
  try {
    const init = await m.ask('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code', version: '9' } });
    assert.equal(init.result.serverInfo.name, 'notex');
    assert.match(init.result.instructions, /only when the user asks/);
    assert.match(init.result.instructions, /Never write on the rules canvas/);
    const { tools } = (await m.ask('tools/list', {})).result;
    assert.deepEqual(tools.map((t) => t.name), ['notex_canvases', 'notex_read', 'notex_write']);
    const write = tools.find((t) => t.name === 'notex_write').description;
    for (const tag of ['<Canvas', '<Totem', '<Add canvas', '<Edit id', '<Area', '<Note', '<Text', '<File path', '<Row>', '<Column>', '<Line', '<Link', '<ScrollBox', '<Page>', '&lt;', 'CDATA']) assert.ok(write.includes(tag), tag);
    assert.match(write, /Never write on the rules canvas/);
    // Boxes are connected with Link; Line only draws (t-bc73ca3e6f).
    assert.match(write, /To connect two boxes, use <Link from to>/);
    assert.match(write, /<Line from to> only draws a line/);
    assert.ok(write.includes('<Link from="Collect" to="Read"/>'));
    assert.match(write, /<Remove id=/);
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
