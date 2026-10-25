/* Auto-sync: only the canvases switched on are kept in RAGX - synced at
 * once when switched on, then 15 s after the last save and not again within
 * a minute; a half-written save and a stopped RAGX are tried again at the
 * next look (t-0c1da1346d, t-a2853a8746, t-233e5561d1, t-ccc6f4dcc0,
 * t-c765aac21b). The clock is the test's, so nothing waits. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { AutoSync } from '../engine/lib/sync.js';
import { buildFabric } from '../engine/lib/server.js';
import { rect } from './fixtures.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const canvas = (note) => ({
  totems: [{ id: 'T', name: 'Research', x: 0, y: -100, radius: 0 }],
  areas: [{ id: 'A', name: 'Gap papers', polygons: [rect(0, 0, 800, 600)], parentAreaId: null, linkedTotemId: 'T' },
    { id: 'N', name: 'Plan', isNote: true, textContent: note, polygons: [rect(20, 20, 200, 200)], parentAreaId: 'A', linkedTotemId: 'T' }],
  links: [],
  drawings: [],
  files: [{ id: 'f', name: 'board.png', isImage: true, imageDataUrl: `data:image/png;base64,${PNG.toString('base64')}`, x: 400, y: 300, areaId: 'A', linkedTotemId: 'T' }],
});

/* RAGX's read and NoteX Add routes, counted. */
async function fakeRagx(t) {
  const seen = { reads: 0, adds: [] };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/api/read-image') { seen.reads++; return res.end(JSON.stringify({ kind: 'photo', text: '', description: 'A whiteboard.', model: 'haiku' })); }
    seen.adds.push(JSON.parse(body).names);
    res.end(JSON.stringify({ queued: JSON.parse(body).names }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { runtime: { url: `http://127.0.0.1:${server.address().port}`, token: 'tok' }, seen };
}

function setup(t, runtime) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'workspace');
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'docs'), { recursive: true });
  let stamp = Date.parse('2026-10-25T10:00:00Z');
  const save = (name, state, raw = null) => {
    fs.mkdirSync(path.join(ws, name), { recursive: true });
    const f = path.join(ws, name, 'fabric.json');
    fs.writeFileSync(f, raw ?? JSON.stringify(state));
    stamp += 1000;
    fs.utimesSync(f, new Date(stamp), new Date(stamp)); // every save a new modified time
  };
  const clock = { t: 1_000_000 }; // NoteX's clock, well after its start
  const config = { workspace: ws };
  const saves = { n: 0 };
  const make = (rt = runtime) => new AutoSync({
    config, saveConfig: () => { saves.n++; }, dataDir: data, runtime: rt, now: () => clock.t,
    build: (name) => {
      const b = buildFabric(path.join(ws, name), { dataDir: data });
      fs.writeFileSync(path.join(data, 'docs', `${name}.notex.md`), b.markdown);
      return b;
    },
  });
  return { ws, data, save, clock, config, make, saves };
}

test('only a canvas switched on is synced, at once, with its images read first', async (t) => {
  const ragx = await fakeRagx(t);
  const { save, clock, config, make, data } = setup(t, ragx.runtime);
  save('Thesis', canvas('- [ ] read'));
  save('Other', canvas('- [ ] untouched'));
  const sync = make();
  assert.equal(await sync.tick(), null, 'nothing is switched on');
  sync.set('Thesis', true);
  const r = await sync.running;
  assert.equal(r.status, 'synced');
  assert.equal(ragx.seen.reads, 1);
  assert.deepEqual(ragx.seen.adds, [['Thesis.notex.md']]);
  assert.match(fs.readFileSync(path.join(data, 'docs', 'Thesis.notex.md'), 'utf8'), /A whiteboard\./);
  assert.ok(config.sync.Thesis.synced > 0);
  assert.equal(sync.report().Thesis.upToDate, true);
  assert.equal(sync.report().Other, undefined);

  clock.t += 120_000;
  assert.equal(await sync.tick(), null, 'unchanged since the sync');
  assert.equal(ragx.seen.adds.length, 1);
});

test('a save waits 15 s of quiet, and a canvas is not synced twice within a minute', async (t) => {
  const ragx = await fakeRagx(t);
  const { save, clock, make } = setup(t, ragx.runtime);
  save('Thesis', canvas('- [ ] one'));
  const sync = make();
  sync.set('Thesis', true);
  await sync.running;

  clock.t += 5_000;
  save('Thesis', canvas('- [x] one'));
  assert.equal(await sync.tick(), null);
  assert.equal(sync.report().Thesis.status, 'settling');
  clock.t += 10_000;
  save('Thesis', canvas('- [x] one\n- [ ] two')); // still editing: the quiet starts again
  assert.equal(await sync.tick(), null);
  clock.t += 15_000;
  assert.equal(await sync.tick(), null, 'quiet for 15 s, but the last sync was 30 s ago');
  assert.equal(sync.report().Thesis.status, 'waiting');
  clock.t += 30_000;
  const r = await sync.tick();
  assert.equal(r.status, 'synced');
  assert.equal(ragx.seen.adds.length, 2);
  assert.equal(ragx.seen.reads, 1, 'the image was read once, by its bytes');
});

test('a half-written save and a stopped RAGX are tried again at the next look', async (t) => {
  const ragx = await fakeRagx(t);
  const { save, clock, make } = setup(t, ragx.runtime);
  save('Thesis', null, '{"totems": [');
  const down = make({ url: 'http://127.0.0.1:1', token: 'x' });
  down.set('Thesis', true);
  assert.equal((await down.running).status, 'settling');
  assert.equal(down.report().Thesis.detail, 'File Fabric is saving it.');

  save('Thesis', canvas('- [ ] whole'));
  assert.equal(await down.tick(), null, 'the quiet runs from the look that sees the save');
  clock.t += 15_000;
  const r = await down.tick();
  assert.equal(r.status, 'waiting-ragx', 'RAGX is not answering');
  assert.equal(ragx.seen.adds.length, 0);

  // RAGX is back: the next look syncs, without waiting out the minute.
  down.runtime = ragx.runtime;
  clock.t += 5_000;
  assert.equal((await down.tick()).status, 'synced');
  assert.deepEqual(ragx.seen.adds, [['Thesis.notex.md']]);
});

test('a save made while NoteX was stopped is synced on the next start; switching off forgets the canvas', async (t) => {
  const ragx = await fakeRagx(t);
  const { save, clock, config, make } = setup(t, ragx.runtime);
  save('Thesis', canvas('- [ ] one'));
  const first = make();
  first.set('Thesis', true);
  await first.running;
  await first.stop();

  save('Thesis', canvas('- [x] one'));
  const again = make();
  clock.t += 1_000;
  assert.equal(await again.tick(), null, 'it may still be being edited');
  clock.t += 15_000;
  assert.equal((await again.tick()).status, 'synced');
  assert.equal(ragx.seen.adds.length, 2);

  let busy = true;
  again.busy = () => busy;
  save('Thesis', canvas('- [x] one\n- [ ] two'));
  clock.t += 120_000;
  await again.tick();
  clock.t += 15_000;
  assert.equal(await again.tick(), null);
  assert.equal(again.report().Thesis.status, 'queued', 'behind the Read images the user pressed');
  busy = false;

  again.set('Thesis', false);
  assert.deepEqual(config.sync, {});
  clock.t += 120_000;
  assert.equal(await again.tick(), null);
  assert.equal(ragx.seen.adds.length, 2);
});
