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
import { PhoneSync, decide, overlay, safeRel, safeCanvas, XP_DIR } from '../engine/lib/phone.js';
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
