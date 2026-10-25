/* A fabric's images: found as files (sources/, or saved from a data URL),
 * read by RAGX two at a time and once each, and written under their
 * place as reading, link and path (t-a4bf938570, t-6b38e0dc27, t-a8841a0bee). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { buildFabric } from '../engine/lib/server.js';
import { readFabricImages } from '../engine/lib/read.js';
import { rect } from './fixtures.js';

// A 1x1 PNG, and a second one that differs by one byte of colour.
const PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PNG_B = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-images-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'Planner (2)');
  fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sources', 'pipeline (1).png'), PNG_A);
  fs.writeFileSync(path.join(dir, 'fabric.json'), JSON.stringify({
    totems: [{ id: 'T', name: 'Planner Screen', x: 0, y: -100, radius: 0 }],
    areas: [{ id: 'A', name: 'Images', polygons: [rect(0, 0, 800, 600)], parentAreaId: null, linkedTotemId: 'T' }],
    links: [],
    drawings: [],
    files: [
      { id: 'f1', name: 'pipeline (1).png', isImage: true, x: 10, y: 10, areaId: 'A', linkedTotemId: 'T' },
      // The same picture placed twice: read once.
      { id: 'f2', name: 'pipeline (1).png', isImage: true, x: 300, y: 10, areaId: 'A', linkedTotemId: 'T' },
      // Pasted: no copy in sources/, only the data URL.
      { id: 'f3', name: 'pasted.png', isImage: true, imageDataUrl: `data:image/png;base64,${PNG_B.toString('base64')}`, x: 10, y: 300, areaId: 'A', linkedTotemId: 'T' },
      { id: 'f4', name: 'talk', isImage: true, isYoutube: true, youtubeUrl: 'https://youtu.be/x', imageDataUrl: 'https://img.youtube.com/x.jpg', x: 400, y: 300, areaId: 'A', linkedTotemId: 'T' },
    ],
  }));
  return { root, dir, data: path.join(root, 'data') };
}

/* A stand-in for RAGX's read route: counts what it is asked, and how many at once. */
async function fakeRagx(t, { fail = null } = {}) {
  const seen = { calls: 0, now: 0, most: 0, names: [], ahead: [] };
  const server = http.createServer(async (req, res) => {
    if (req.headers['x-rag-token'] !== 'tok') { res.writeHead(401); return res.end(); }
    seen.calls++; seen.now++; seen.most = Math.max(seen.most, seen.now);
    seen.names.push(decodeURIComponent(req.headers['x-file-name']));
    seen.ahead.push(Number(req.headers['x-read-ahead']));
    for await (const _ of req);
    await new Promise((r) => setTimeout(r, 40));
    seen.now--;
    if (fail) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { code: fail, message: 'Claude is at a usage limit' } })); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ kind: 'diagram', text: 'Raw SAR\n# Step 2\nCrop and Wrap', description: 'A pipeline from raw SAR imagery to orthorectified tiles.', model: 'haiku', cached: false }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { runtime: { url: `http://127.0.0.1:${server.address().port}`, token: 'tok' }, seen };
}

test('images are files: from sources/, or saved once from their data URL', (t) => {
  const { dir, data } = workspace(t);
  const built = buildFabric(dir, { dataDir: data });
  assert.equal(built.images, 3);
  assert.equal(built.unread, 3);
  const md = built.markdown;
  assert.match(md, /^\*\*pipeline \(1\)\.png\*\* \(image, not read yet/m);
  assert.ok(md.includes(`File: ${path.join(dir, 'sources', 'pipeline (1).png')}`));
  // Brackets and spaces encoded, so the link survives Markdown.
  assert.ok(md.includes('Planner%20%282%29/sources/pipeline%20%281%29.png)'));
  const saved = fs.readdirSync(path.join(data, 'images'));
  assert.equal(saved.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(data, 'images', saved[0])), PNG_B);
  assert.match(md, /^- talk \(YouTube video, https:\/\/youtu\.be\/x\)$/m);
});

test('Read images asks RAGX once per picture, at most two at a time, saying how many are still to come', async (t) => {
  const { dir, data } = workspace(t);
  const { runtime, seen } = await fakeRagx(t);
  const r = await readFabricImages(dir, { dataDir: data, runtime });
  assert.deepEqual({ images: r.images, toRead: r.toRead, read: r.read, failed: r.failed, stopped: r.stopped }, { images: 3, toRead: 2, read: 2, failed: [], stopped: null });
  assert.equal(seen.calls, 2);
  assert.ok(seen.most <= 2);
  assert.deepEqual(seen.ahead.sort(), [0, 1], 'the first says one more is coming, so RAGX warms a reader for it');
  const again = await readFabricImages(dir, { dataDir: data, runtime });
  assert.equal(again.toRead, 0);
  assert.equal(seen.calls, 2);

  const md = buildFabric(dir, { dataDir: data }).markdown;
  assert.match(md, /^\*\*pasted\.png\*\* \(image, read by haiku - machine-read, may contain errors\)$/m);
  assert.match(md, /^Shows: A pipeline from raw SAR imagery to orthorectified tiles\.$/m);
  // A heading inside a reading must not cut the place's section.
  assert.match(md, /^Text in it:\nRaw SAR\n\*\*Step 2\*\*\nCrop and Wrap$/m);
});

test('reading stops at the first sign RAGX or Claude cannot go on', async (t) => {
  const { dir, data } = workspace(t);
  const { runtime } = await fakeRagx(t, { fail: 'limit' });
  const r = await readFabricImages(dir, { dataDir: data, runtime, atOnce: 1 });
  assert.equal(r.read, 0);
  assert.match(r.stopped, /usage limit/);
  await assert.rejects(readFabricImages(dir, { dataDir: data, ragx: path.join(os.tmpdir(), 'no-ragx-here') }), /RAGX's engine is not running/);
});
