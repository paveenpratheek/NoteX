/* Phone sync over the cable: the workspace and CanvasXP's folder kept the
 * same canvas by canvas, by hashes, with the PC's version kept and the
 * phone's beside it when both changed (t-71306596ff, t-76fdccd60b). A plain
 * folder stands in for the phone, and the helpers below do what CanvasXP
 * does there: list its canvases in manifest.json and take in NoteX's
 * batches (CanvasX t-3d7b88b6a1). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PhoneSync, decide, overlay, safeRel, safeCanvas, XP_DIR, QUEUE_DIR, parseQueued } from '../engine/lib/phone.js';
import { FolderTransport } from '../engine/lib/mtp.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DEVICE = 'Galaxy';
const ROOT = ['Internal storage', 'Documents', 'NEW2'];

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-phone-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const phoneTop = path.join(tmp, 'phone');
  const phone = path.join(phoneTop, ...ROOT);
  const ws = path.join(tmp, 'ws');
  const data = path.join(tmp, 'data');
  fs.mkdirSync(phone, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  const config = { workspace: ws };
  const kept = [];
  const open = new Set();
  const transport = new FolderTransport({ [DEVICE]: phoneTop });
  const make = () => new PhoneSync({ config, saveConfig: () => {}, dataDir: data, transport, isOpen: (d) => open.has(path.basename(d)), keep: (n) => kept.push(n), hostname: 'DESK' });
  return { tmp, phone, ws, data, config, kept, open, transport, make };
}

const write = (dir, rel, text) => {
  const f = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');

/* CanvasXP's Setup and manifest. */
function xpSetup(phone, id = 'phone-1') { write(phone, `${XP_DIR}/device.json`, JSON.stringify({ id, name: 'My phone' })); }
function xpManifest(phone, applied = []) {
  const canvases = {};
  for (const e of fs.readdirSync(phone, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === XP_DIR || !fs.existsSync(path.join(phone, e.name, 'fabric.json'))) continue;
    const files = {};
    const walk = (d, pre) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const rel = pre ? `${pre}/${f.name}` : f.name;
        if (f.isDirectory()) walk(path.join(d, f.name), rel);
        else if (f.name !== '.fabric_lock') { const b = fs.readFileSync(path.join(d, f.name)); files[rel] = { size: b.length, sha: sha(b) }; }
      }
    };
    walk(path.join(phone, e.name), '');
    canvases[e.name] = { files };
  }
  let prev = {};
  try { prev = JSON.parse(read(phone, `${XP_DIR}/manifest.json`)); } catch (_) {}
  write(phone, `${XP_DIR}/manifest.json`, JSON.stringify({ canvases, applied: [...(prev.applied || []), ...applied] }));
}
/* CanvasXP taking in every waiting batch, as its xp.js does. */
function xpApply(phone) {
  const inc = path.join(phone, XP_DIR, 'incoming');
  if (!fs.existsSync(inc)) return [];
  const ids = fs.readdirSync(inc).sort();
  for (const id of ids) {
    const b = path.join(inc, id);
    const ch = JSON.parse(fs.readFileSync(path.join(b, 'changes.json'), 'utf8'));
    for (const op of ch.ops) {
      if (op.op === 'copy') fs.cpSync(path.join(phone, op.canvas), path.join(phone, op.to), { recursive: true });
      if (op.op === 'put') { fs.mkdirSync(path.dirname(path.join(phone, op.canvas, op.path)), { recursive: true }); fs.copyFileSync(path.join(b, 'files', op.canvas, op.path), path.join(phone, op.canvas, op.path)); }
      if (op.op === 'del') fs.rmSync(path.join(phone, op.canvas, op.path), { force: true });
      if (op.op === 'drop') fs.rmSync(path.join(phone, op.canvas), { recursive: true, force: true });
      if (op.op === 'chat') write(phone, `${XP_DIR}/chats/${op.canvas}.json`, fs.readFileSync(path.join(b, 'chats', `${op.canvas}.json`)));
      if (op.op === 'answered') for (const it of op.items) fs.rmSync(path.join(phone, QUEUE_DIR, it.dir), { recursive: true, force: true });
      if (op.op === 'unanswered' && fs.existsSync(path.join(phone, QUEUE_DIR, op.dir))) write(phone, `${QUEUE_DIR}/${op.dir}/Not answered.txt`, op.error);
    }
    fs.rmSync(b, { recursive: true });
  }
  xpManifest(phone, ids);
  return ids;
}

test('a folder names, from the phone, only what stays inside the workspace', () => {
  assert.ok(safeCanvas('Trip notes') && safeRel('sources/photo 1.jpg'));
  for (const bad of ['..', '.', '', 'a/b', 'a\\b', 'C:', 'x?', '.notex', XP_DIR, 'trailing.']) assert.ok(!safeCanvas(bad), bad);
  for (const bad of ['../x', 'sources/../../x', '/abs', 'a//b', 'sources/.fabric_lock', 'fabric.json.crswap']) assert.ok(!safeRel(bad), bad);
});

test('deciding one canvas: one side changed goes across, both changed sit side by side', () => {
  const A = { 'fabric.json': '1' }, B2 = { 'fabric.json': '2' }, C = { 'fabric.json': '3' };
  assert.equal(decide({ P: A, F: A, B: A }), 'none');
  assert.equal(decide({ P: B2, F: A, B: A }), 'push');
  assert.equal(decide({ P: A, F: B2, B: A }), 'pull');
  assert.equal(decide({ P: B2, F: C, B: A }), 'conflict');
  assert.equal(decide({ P: B2, F: B2, B: A }), 'agree');
  assert.equal(decide({ P: undefined, F: A, B: A }), 'drop-phone');
  assert.equal(decide({ P: A, F: undefined, B: A }), 'drop-pc');
  assert.equal(decide({ P: undefined, F: B2, B: A }), 'pull', 'deleted on the PC but changed on the phone comes back');
  assert.equal(decide({ P: B2, F: undefined, B: A }), 'push', 'deleted on the phone but changed on the PC goes back');
  assert.equal(decide({ P: A, F: undefined, B: undefined }), 'push');
  assert.equal(decide({ P: undefined, F: A, B: undefined }), 'pull');
  assert.equal(decide({ P: B2, F: C, B: A, open: true }), 'open');
  assert.equal(decide({ P: A, F: B2, B: A, agent: true }), 'push', 'an agent canvas is the PC\'s');
});

test('overlay: what the phone holds once it takes in the batches still waiting', () => {
  const o = overlay({ X: { a: '1', b: '2' } }, [{ ops: [{ op: 'copy', canvas: 'X', to: 'X (phone)' }, { op: 'put', canvas: 'X', path: 'a', sha: '9' }, { op: 'del', canvas: 'X', path: 'b' }, { op: 'put', canvas: 'Y', path: 'fabric.json', sha: '5' }] }]);
  assert.deepEqual(o, { X: { a: '9' }, 'X (phone)': { a: '1', b: '2' }, Y: { 'fabric.json': '5' } });
});

test('setup needs the folder CanvasXP set up, and browsing finds it', async (t) => {
  const s = setup(t);
  const sync = s.make();
  await assert.rejects(sync.setup(DEVICE, ROOT), /not set up by CanvasXP/);
  xpSetup(s.phone);
  const b = await sync.browse(DEVICE, ROOT.slice(0, 2));
  assert.deepEqual(b.folders, ['NEW2']);
  assert.equal(b.canvasxp, null);
  const here = await sync.browse(DEVICE, ROOT);
  assert.deepEqual(here.canvasxp, { id: 'phone-1', name: 'My phone' });
  const p = await sync.setup(DEVICE, ROOT);
  assert.equal(p.id, 'phone-1');
  assert.deepEqual(s.config.phone.path, ROOT);
});

test('a first sync brings the phone\'s canvases in, sends the PC\'s out, and a second finds nothing to do', async (t) => {
  const s = setup(t);
  xpSetup(s.phone);
  write(s.phone, 'Trip/fabric.json', '{"phone":1}');
  write(s.phone, 'Trip/sources/beach.jpg', 'JPEG');
  write(s.phone, 'Trip/.fabric_lock', 'lock');
  xpManifest(s.phone);
  write(s.ws, 'Thesis/fabric.json', '{"pc":1}');
  write(s.ws, 'Thesis/sources/plan.pdf', 'PDF');
  write(s.ws, 'Not a canvas/readme.txt', 'x');
  const sync = s.make();
  await sync.setup(DEVICE, ROOT);

  const r = await sync.sync();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.pulled, ['Trip']);
  assert.deepEqual(r.pushed, ['Thesis']);
  assert.equal(read(s.ws, 'Trip/sources/beach.jpg'), 'JPEG');
  assert.ok(!fs.existsSync(path.join(s.ws, 'Trip', '.fabric_lock')), 'a lock never travels');
  assert.deepEqual(s.kept, ['Trip'], 'what comes from the phone is kept in RAGX');
  const batch = path.join(s.phone, XP_DIR, 'incoming', r.batch);
  const ch = JSON.parse(fs.readFileSync(path.join(batch, 'changes.json'), 'utf8'));
  assert.equal(ch.from, 'DESK');
  assert.deepEqual(ch.ops.map((o) => `${o.op} ${o.canvas}/${o.path}`).sort(), ['put Thesis/fabric.json', 'put Thesis/sources/plan.pdf']);
  assert.equal(fs.readFileSync(path.join(batch, 'files', 'Thesis', 'sources', 'plan.pdf'), 'utf8'), 'PDF');
  assert.ok(!fs.existsSync(path.join(s.phone, 'Not a canvas')));

  // Synced again before the phone took it in: nothing is sent twice.
  const again = await sync.sync();
  assert.deepEqual([again.pulled, again.pushed, again.conflicts], [[], [], []]);
  assert.equal(sync.report().waiting, 1);

  xpApply(s.phone);
  assert.equal(read(s.phone, 'Thesis/sources/plan.pdf'), 'PDF');
  const third = await sync.sync();
  assert.deepEqual([third.pulled, third.pushed, third.conflicts, third.removed], [[], [], [], []]);
  assert.equal(sync.report().waiting, 0, 'the batch the phone took in is done');
});

test('an edit on either side goes across; an edit on both keeps the PC\'s and brings the phone\'s in beside it', async (t) => {
  const s = setup(t);
  xpSetup(s.phone);
  write(s.ws, 'Plan/fabric.json', 'v1');
  write(s.ws, 'Notes/fabric.json', 'n1');
  write(s.ws, 'Both/fabric.json', 'b1');
  xpManifest(s.phone);
  const sync = s.make();
  await sync.setup(DEVICE, ROOT);
  await sync.sync();
  xpApply(s.phone);

  write(s.ws, 'Plan/fabric.json', 'v2-pc');
  write(s.phone, 'Notes/fabric.json', 'n2-phone');
  write(s.phone, 'Notes/sources/new.png', 'PNG');
  write(s.ws, 'Both/fabric.json', 'b2-pc');
  write(s.phone, 'Both/fabric.json', 'b2-phone');
  xpManifest(s.phone);
  const r = await sync.sync();
  assert.deepEqual(r.pushed, ['Plan']);
  assert.deepEqual(r.pulled, ['Notes']);
  assert.deepEqual(r.conflicts, [{ name: 'Both', copy: 'Both (phone)' }]);
  assert.equal(read(s.ws, 'Notes/sources/new.png'), 'PNG');
  assert.equal(read(s.ws, 'Both/fabric.json'), 'b2-pc');
  assert.equal(read(s.ws, 'Both (phone)/fabric.json'), 'b2-phone');
  const ch = JSON.parse(read(path.join(s.phone, XP_DIR, 'incoming', r.batch), 'changes.json'));
  const both = ch.ops.filter((o) => o.canvas === 'Both');
  assert.deepEqual(both.map((o) => o.op), ['copy', 'put'], 'the phone copies its own version aside before it takes the PC\'s');
  assert.equal(both[1].was, sha('b2-phone'));

  xpApply(s.phone);
  assert.equal(read(s.phone, 'Both/fabric.json'), 'b2-pc');
  assert.equal(read(s.phone, 'Both (phone)/fabric.json'), 'b2-phone');
  assert.equal(read(s.phone, 'Plan/fabric.json'), 'v2-pc');
  const after = await sync.sync();
  assert.deepEqual([after.pulled, after.pushed, after.conflicts], [[], [], []]);
});

test('a canvas deleted on one side goes from the other, the PC\'s backed up first', async (t) => {
  const s = setup(t);
  xpSetup(s.phone);
  write(s.ws, 'Old/fabric.json', 'old');
  write(s.ws, 'Gone/fabric.json', 'gone');
  xpManifest(s.phone);
  const sync = s.make();
  await sync.setup(DEVICE, ROOT);
  await sync.sync();
  xpApply(s.phone);

  fs.rmSync(path.join(s.phone, 'Old'), { recursive: true });
  fs.rmSync(path.join(s.ws, 'Gone'), { recursive: true });
  xpManifest(s.phone);
  const r = await sync.sync();
  assert.deepEqual(r.removed.sort((a, b) => a.name.localeCompare(b.name)), [{ name: 'Gone', from: 'phone' }, { name: 'Old', from: 'pc' }]);
  assert.ok(!fs.existsSync(path.join(s.ws, 'Old')));
  const backups = path.join(s.data, 'phone', 'backups');
  assert.equal(read(path.join(backups, fs.readdirSync(backups)[0]), 'Old/fabric.json'), 'old');
  xpApply(s.phone);
  assert.ok(!fs.existsSync(path.join(s.phone, 'Gone')));
});

test('a canvas open in CanvasX waits; an agent canvas is the PC\'s; a stale manifest writes nothing', async (t) => {
  const s = setup(t);
  xpSetup(s.phone);
  write(s.ws, 'Open/fabric.json', 'o1');
  write(s.ws, 'Agent/fabric.json', 'a1');
  write(s.ws, 'Agent/agent.json', '{}');
  write(s.ws, 'Stale/fabric.json', 's1');
  xpManifest(s.phone);
  const sync = s.make();
  await sync.setup(DEVICE, ROOT);
  await sync.sync();
  xpApply(s.phone);

  write(s.ws, 'Open/fabric.json', 'o2-pc');
  write(s.phone, 'Open/fabric.json', 'o2-phone');
  s.open.add('Open');
  write(s.phone, 'Agent/fabric.json', 'a2-phone');
  write(s.phone, 'Stale/fabric.json', 's2-phone');
  xpManifest(s.phone);
  write(s.phone, 'Stale/fabric.json', 's3-not-listed'); // changed after CanvasXP listed it
  const r = await sync.sync();
  assert.deepEqual(r.open, ['Open']);
  assert.deepEqual(r.pushed, ['Agent']);
  assert.deepEqual(r.stale, ['Stale']);
  assert.equal(read(s.ws, 'Stale/fabric.json'), 's1');
  assert.equal(read(s.ws, 'Open/fabric.json'), 'o2-pc');
  assert.equal(s.kept.length, 0);
});

test('names from the phone that would leave the workspace are skipped', async (t) => {
  const s = setup(t);
  xpSetup(s.phone);
  write(s.phone, 'Fine/fabric.json', 'f');
  xpManifest(s.phone);
  const m = JSON.parse(read(s.phone, `${XP_DIR}/manifest.json`));
  m.canvases['..'] = { files: { 'fabric.json': { sha: sha('x') } } };
  m.canvases.Fine.files['../../evil.txt'] = { sha: sha('x') };
  write(s.phone, `${XP_DIR}/manifest.json`, JSON.stringify(m));
  const sync = s.make();
  await sync.setup(DEVICE, ROOT);
  const r = await sync.sync();
  assert.deepEqual(r.pulled, ['Fine']);
  assert.deepEqual(r.skipped.sort(), ['..', 'Fine/../../evil.txt']);
  assert.ok(!fs.existsSync(path.join(s.tmp, 'evil.txt')));
});

test('a batch that vanished from the phone before it was taken in is sent again', async (t) => {
  const s = setup(t);
  xpSetup(s.phone);
  xpManifest(s.phone);
  write(s.ws, 'Book/fabric.json', 'b1');
  const sync = s.make();
  await sync.setup(DEVICE, ROOT);
  const first = await sync.sync();
  assert.deepEqual(first.pushed, ['Book']);
  fs.rmSync(path.join(s.phone, XP_DIR, 'incoming'), { recursive: true });
  const again = await sync.sync();
  assert.deepEqual(again.pushed, ['Book']);
  xpApply(s.phone);
  assert.equal(read(s.phone, 'Book/fabric.json'), 'b1');
});

test('a sync says plainly when the phone is not there or is another CanvasXP folder', async (t) => {
  const s = setup(t);
  xpSetup(s.phone);
  xpManifest(s.phone);
  const sync = s.make();
  await sync.setup(DEVICE, ROOT);
  xpSetup(s.phone, 'another-phone');
  assert.match((await sync.sync()).error, /not the CanvasXP folder/);
  s.config.phone.device = 'Pixel';
  const r = await sync.sync();
  assert.equal(r.ok, false);
  assert.match(r.error, /not attached/);
});

test('the engine: browse to the phone\'s folder, set it up, sync, and the canvas from the phone is kept in RAGX', async (t) => {
  const { startServer } = await import('../engine/lib/server.js');
  const s = setup(t);
  xpSetup(s.phone);
  write(s.phone, 'Trip/fabric.json', JSON.stringify({ areas: [], files: [], drawings: [], totems: [], links: [] }));
  xpManifest(s.phone);
  const srv = await startServer({ dataDir: s.data, port: 0, runtimeFile: path.join(s.tmp, 'plugin', 'runtime.json'), log: () => {}, signals: false, syncOptions: { phoneTransport: s.transport } });
  t.after(() => srv.stop());
  const call = async (method, p, body) => {
    const r = await fetch(srv.url + p, { method, headers: { 'x-notex-token': srv.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await call('PUT', '/api/workspace', { path: s.ws })).status, 200);
  assert.deepEqual((await call('GET', '/api/phone/devices')).body.devices, [{ name: DEVICE }]);
  const b = await call('GET', `/api/phone/browse?device=${DEVICE}&path=${encodeURIComponent(JSON.stringify(ROOT))}`);
  assert.equal(b.body.canvasxp.name, 'My phone');
  assert.equal((await call('POST', '/api/phone/sync')).status, 409, 'not set up yet');
  assert.equal((await call('PUT', '/api/phone', { device: DEVICE, path: ROOT.slice(0, 2) })).status, 409, 'not CanvasXP\'s folder');
  assert.equal((await call('PUT', '/api/phone', { device: DEVICE, path: ROOT })).status, 200);
  assert.equal((await call('POST', '/api/phone/sync')).status, 202);
  let rep;
  for (let i = 0; i < 100; i++) { rep = (await call('GET', '/api/phone')).body; if (!rep.running && rep.last) break; await new Promise((r) => setTimeout(r, 20)); }
  assert.deepEqual(rep.last.pulled, ['Trip'], rep.last.error);
  assert.ok(fs.existsSync(path.join(s.ws, 'Trip', 'fabric.json')));
  const st = (await call('GET', '/api/state')).body;
  assert.ok(st.sync.Trip, 'Trip is kept in RAGX');
  assert.equal(st.phone.setup.name, 'My phone');
  assert.equal((await call('DELETE', '/api/phone')).body.setup, null);
});

/* CanvasXP's chat on an agent canvas: a queued message in the target folder, attachments first. */
function xpQueue(phone, id, canvas, prompt, files = [], description = '') {
  const dir = `${canvas} - 2026-11-01 10.0${id.slice(-1)}`;
  for (const [name, bytes] of files) write(phone, `${QUEUE_DIR}/${dir}/${name}`, bytes);
  const meta = { id, canvas, model: 'haiku', at: `2026-11-01T10:0${id.slice(-1)}:00Z`, files: files.map(([name, bytes]) => ({ name, size: bytes.length, sha: sha(bytes) })) };
  write(phone, `${QUEUE_DIR}/${dir}/message.md`, `# Queued message\n\nCanvas: ${canvas}\nQueued: 2026-11-01 10:00\n\n## Description\n\n${description || '(none)'}\n\n## Prompt\n\n${prompt || '(none)'}\n\n## Attachments\n\n${files.map(([n]) => `- ${n}`).join('\n') || '(none)'}\n\n<!-- CanvasXP ${JSON.stringify(meta)} -->\n`);
  return dir;
}
const statuses = (phone) => {
  const d = path.join(phone, XP_DIR, 'status');
  return fs.existsSync(d) ? fs.readdirSync(d).sort().map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))) : [];
};
const lastBatch = (phone) => {
  const inc = path.join(phone, XP_DIR, 'incoming');
  const id = fs.readdirSync(inc).sort().pop();
  return JSON.parse(fs.readFileSync(path.join(inc, id, 'changes.json'), 'utf8'));
};

test('messages queued in CanvasXP\'s chat are answered at the sync, the agent\'s changes and the chat go back, and status files say how it goes (t-e4196083e7, t-957b09f2fe, t-2ff7b152e9)', async (t) => {
  const s = setup(t);
  xpSetup(s.phone);
  write(s.ws, 'Board/fabric.json', '{"v":1}');
  write(s.ws, 'Board/agent.json', '{}');
  write(s.ws, 'Notes/fabric.json', '{"n":1}');
  xpManifest(s.phone);
  const turns = [];
  const asked = [];
  const ask = async (m) => {
    asked.push(m);
    if (m.canvas !== 'Board') throw new Error(`${m.canvas} is not assigned to the agent on the PC any more.`);
    await new Promise((r) => setTimeout(r, 60)); // the agent at work: heartbeats go out meanwhile
    write(s.ws, 'Board/fabric.json', `{"v":${asked.length + 1}}`);
    turns.push({ who: 'user', text: m.text }, { who: 'agent', text: 'Placed.' });
    return { status: 'done' };
  };
  const sync = new PhoneSync({ config: s.config, saveConfig: () => {}, dataDir: s.data, transport: s.transport, keep: () => {}, hostname: 'DESK', ask, chat: (name) => ({ name, chat: turns, model: 'sonnet', models: ['sonnet'] }), heartbeatMs: 15 });
  await sync.setup(DEVICE, ROOT);
  let r = await sync.sync();
  assert.deepEqual(r.pushed, ['Board', 'Notes'], r.error);
  xpApply(s.phone);
  assert.deepEqual(JSON.parse(read(s.phone, `${XP_DIR}/chats/Board.json`)).chat, [], 'the agent canvas went with its chat');

  const PNG = Buffer.from('\x89PNG fake');
  const d1 = xpQueue(s.phone, 'm-1', 'Board', 'put the photo by the plan', [['beach.png', PNG]], 'the beach on day one');
  const d2 = xpQueue(s.phone, 'm-2', 'Notes', 'tidy this');
  write(s.phone, `${QUEUE_DIR}/Board - 2026-11-01 10.03/half.jpg`, 'still writing'); // no message.md yet
  fs.rmSync(path.join(s.phone, XP_DIR, 'status'), { recursive: true, force: true });
  r = await sync.sync();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.answered, [{ id: 'm-1', canvas: 'Board', status: 'done' }]);
  assert.deepEqual(r.unanswered.map((u) => [u.id, u.error]), [['m-2', 'Notes is not assigned to the agent on the PC any more.']]);
  assert.equal(asked[0].text, 'put the photo by the plan\n\nAbout what I attached: the beach on day one');
  assert.equal(asked[0].model, 'haiku');
  assert.deepEqual(asked[0].files.map((f) => [f.name, f.bytes.equals(PNG)]), [['beach.png', true]]);
  assert.deepEqual(r.pushed, ['Board'], 'what the agent changed goes back in the same sync');
  const b = lastBatch(s.phone);
  assert.deepEqual(b.ops.find((o) => o.op === 'answered'), { op: 'answered', items: [{ id: 'm-1', dir: d1 }] });
  assert.ok(b.ops.some((o) => o.op === 'unanswered' && o.id === 'm-2' && o.dir === d2));
  assert.ok(b.ops.some((o) => o.op === 'chat' && o.canvas === 'Board'));
  const st = statuses(s.phone);
  assert.ok(st.every((x) => x.sync === st[0].sync) && st.map((x) => x.seq).join() === st.map((_, i) => i + 1).join(), 'one sync, numbered in order');
  assert.equal(st[0].stage, 'reading');
  const agent = st.filter((x) => x.stage === 'agent');
  assert.deepEqual([agent[0].done, agent[0].total, agent[0].current], [0, 2, 'm-1']);
  assert.ok(agent.filter((x) => x.current === 'm-1').length >= 2, 'heartbeats while the agent worked');
  assert.deepEqual([agent.at(-1).done, agent.at(-1).total], [2, 2]);
  assert.deepEqual([st.at(-1).stage, st.at(-1).batch, st.at(-1).text], ['done', r.batch, '1 message answered · 1 message not answered · 1 canvas from the PC']);

  // Not taken in yet: the next sync does not answer m-1 again, and still tells the phone to remove it.
  r = await sync.sync();
  assert.equal(asked.filter((m) => m.canvas === 'Board').length, 1, 'answered once');
  assert.deepEqual(lastBatch(s.phone).ops.find((o) => o.op === 'answered'), { op: 'answered', items: [{ id: 'm-1', dir: d1 }] });
  xpApply(s.phone);
  assert.ok(!fs.existsSync(path.join(s.phone, QUEUE_DIR, d1)), 'the answered message is gone from the phone');
  assert.match(read(s.phone, `${QUEUE_DIR}/${d2}/Not answered.txt`), /not assigned/);
  assert.ok(fs.existsSync(path.join(s.phone, QUEUE_DIR, 'Board - 2026-11-01 10.03')), 'half a message waits');
  assert.ok(!r.pushed.includes(QUEUE_DIR) && !fs.existsSync(path.join(s.ws, QUEUE_DIR)), 'the queue is never taken for a canvas');
  assert.equal(JSON.parse(read(s.phone, `${XP_DIR}/chats/Board.json`)).chat.length, 2);
  assert.equal(read(s.phone, 'Board/fabric.json'), '{"v":2}');
  r = await sync.sync();
  assert.ok(!lastBatch(s.phone).ops.some((o) => o.op === 'chat' || o.op === 'answered'), 'nothing new to say');
});

test('a sync that fails tells the phone so', async (t) => {
  const s = setup(t);
  xpSetup(s.phone);
  const sync = s.make();
  await sync.setup(DEVICE, ROOT);
  const r = await sync.sync(); // no manifest yet
  assert.equal(r.ok, false);
  const st = statuses(s.phone);
  assert.deepEqual(st.map((x) => x.stage), ['reading', 'failed']);
  assert.match(st[1].text, /has not listed its canvases/);
});

test('the engine answers a queued message through the arranger, with its files kept as drops of the canvas and placed', async (t) => {
  const { startServer } = await import('../engine/lib/server.js');
  const s = setup(t);
  xpSetup(s.phone);
  write(s.ws, 'Board/fabric.json', JSON.stringify({ areas: [], files: [], drawings: [], totems: [], links: [] }));
  write(s.ws, 'Board/agent.json', '{}');
  write(s.data, 'config.json', JSON.stringify({ workspace: s.ws, placing: false, ragx: path.join(s.tmp, 'no-ragx') }));
  xpManifest(s.phone);
  const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
  xpQueue(s.phone, 'm-1', 'Board', 'file the survey', [['survey.pdf', PDF]], 'the 2024 survey');
  const prompts = [];
  const arrangerRun = async (req) => {
    prompts.push(req);
    const ids = [...new Set([...req.prompt.matchAll(/- id: (d-[0-9a-f]{10})/g)].map((m) => m[1]))];
    return { text: `Filed it.\n\`\`\`xml\n<Canvas name="Board"><Totem name="Inbox">${ids.map((id) => `<File drop="${id}"/>`).join('')}</Totem></Canvas>\n\`\`\`` };
  };
  const srv = await startServer({ dataDir: s.data, port: 0, runtimeFile: path.join(s.tmp, 'plugin', 'runtime.json'), log: () => {}, signals: false, syncOptions: { phoneTransport: s.transport, arrangerRun } });
  t.after(() => srv.stop());
  const call = async (method, p, body) => {
    const r = await fetch(srv.url + p, { method, headers: { 'x-notex-token': srv.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await call('PUT', '/api/phone', { device: DEVICE, path: ROOT })).status, 200);
  assert.equal((await call('POST', '/api/phone/sync')).status, 202);
  let rep;
  for (let i = 0; i < 200; i++) { rep = (await call('GET', '/api/phone')).body; if (!rep.running && rep.last) break; await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(rep.last.ok, true, rep.last.error);
  assert.deepEqual(rep.last.answered, [{ id: 'm-1', canvas: 'Board', status: 'done' }]);
  assert.equal(prompts[0].model, 'haiku');
  const drop = (await call('GET', '/api/inbox')).body.drops.find((d) => d.name === 'survey.pdf');
  assert.deepEqual([drop.status, drop.canvas, drop.ask, drop.via], ['placed', 'Board', 'file the survey\n\nAbout what I attached: the 2024 survey', 'canvasxp']);
  const chat = JSON.parse(fs.readFileSync(path.join(s.phone, XP_DIR, 'incoming', rep.last.batch, 'chats', 'Board.json'), 'utf8'));
  assert.deepEqual(chat.chat.map((c) => [c.who, c.source || null]), [['user', 'canvasxp'], ['agent', null]]);
  assert.equal(chat.chat[1].text, 'Filed it.');
  assert.ok(rep.last.pushed.includes('Board'), 'the canvas the agent drew goes to the phone');
});

test('a queued message.md is read from its headings, so an edit before the sync counts, and its comment gives id, canvas and hashes', () => {
  const meta = { id: 'm-9', canvas: 'Board', files: [] };
  const md = `# Queued message\n\nCanvas: Board\n\n## Description\n\nTwo photos\nof the beach\n\n## Prompt\n\n(none)\n\n## Attachments\n\n(none)\n\n<!-- CanvasXP ${JSON.stringify(meta)} -->\n`;
  const q = parseQueued(md);
  assert.deepEqual([q.meta.id, q.description, q.prompt], ['m-9', 'Two photos\nof the beach', '']);
  assert.equal(parseQueued('# just notes'), null);
  assert.equal(parseQueued('<!-- CanvasXP {broken -->'), null);
});

test('a canvas made and given to the agent on the phone gets its queued message answered in its first sync (t-c71788f1f1, t-24d421e17d)', async (t) => {
  const s = setup(t);
  xpSetup(s.phone);
  write(s.ws, 'Notes/fabric.json', '{"n":1}');
  xpManifest(s.phone);
  const asked = [];
  // The engine's own check: only a canvas the PC holds as the agent's is asked.
  const ask = async (m) => {
    if (!fs.existsSync(path.join(s.ws, m.canvas, 'agent.json'))) throw new Error(`${m.canvas} is not on the PC yet.`);
    asked.push(m);
    write(s.ws, `${m.canvas}/fabric.json`, '{"drawn":true}');
    return { status: 'done' };
  };
  const sync = new PhoneSync({ config: s.config, saveConfig: () => {}, dataDir: s.data, transport: s.transport, keep: () => {}, hostname: 'DESK', ask, chat: (name) => ({ name, chat: [], model: 'sonnet', models: ['sonnet'] }), heartbeatMs: 15 });
  await sync.setup(DEVICE, ROOT);
  let r = await sync.sync();
  assert.equal(r.ok, true, r.error);
  xpApply(s.phone);

  // Away from the PC: a new canvas, assigned to the agent, and a message for it.
  write(s.phone, 'Brainstorming/fabric.json', '{}');
  write(s.phone, 'Brainstorming/agent.json', '{}');
  xpManifest(s.phone);
  const dir = xpQueue(s.phone, 'm-7', 'Brainstorming', 'Make 3 totems');
  r = await sync.sync();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.unanswered, [], 'nothing refused');
  assert.deepEqual(r.answered.map((a) => a.canvas), ['Brainstorming']);
  assert.equal(asked[0].text, 'Make 3 totems');
  assert.ok(r.pulled.includes('Brainstorming'), 'the canvas came over first');
  assert.ok(r.pushed.includes('Brainstorming'), 'what the agent drew goes back in the same sync');
  xpApply(s.phone);
  assert.ok(!fs.existsSync(path.join(s.phone, QUEUE_DIR, dir)), 'the message is gone from the phone');
  assert.equal(read(s.phone, 'Brainstorming/fabric.json'), '{"drawn":true}');
  r = await sync.sync();
  assert.deepEqual([r.pulled, r.pushed, r.answered], [[], [], []], 'a second sync finds nothing to do');
});
