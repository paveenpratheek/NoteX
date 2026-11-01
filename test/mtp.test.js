// The phone helper (mtp.ps1 -Op serve) through ShellTransport, against plain
// folders standing in for a phone ("folder:<path>"); Windows only (t-2f21cca482).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShellTransport } from '../engine/lib/mtp.js';

const windows = process.platform === 'win32';

function phoneDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-mtp-'));
  const phone = path.join(tmp, 'phone');
  fs.mkdirSync(path.join(phone, 'New2', 'Board', 'sources'), { recursive: true });
  fs.writeFileSync(path.join(phone, 'New2', 'Board', 'fabric.json'), '{"totems":[]}');
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(phone, 'New2', 'Board', 'sources', `img ${i}.png`), Buffer.alloc(5000 + i, i));
  return { tmp, phone, dev: `folder:${phone}` };
}

test('one helper answers a whole sync, one request at a time', { skip: !windows }, async (t) => {
  const { tmp, phone, dev } = phoneDir();
  const shell = new ShellTransport({ idleMs: 2000 });
  t.after(() => { shell.close(); setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 500); });

  const items = await shell.list(dev, ['New2', 'Board']);
  assert.ok(items.some((i) => i.name === 'fabric.json' && !i.folder) && items.some((i) => i.name === 'sources' && i.folder));
  const pid = shell.proc.pid;
  await shell.mkdir(dev, ['New2'], 'status');
  assert.equal(shell.proc.pid, pid, 'the same helper answers the next request');

  // A status push and a pull fired together go one after the other, both whole.
  const status = path.join(tmp, 's-00001.json');
  fs.writeFileSync(status, '{"stage":"reading"}');
  const dest = path.join(tmp, 'pc');
  fs.mkdirSync(dest);
  const names = Array.from({ length: 6 }, (_, i) => `img ${i}.png`);
  await Promise.all([shell.push(dev, status, ['New2', 'status']), shell.pull(dev, ['New2', 'Board', 'sources'], names, dest)]);
  assert.ok(fs.existsSync(path.join(phone, 'New2', 'status', 's-00001.json')));
  names.forEach((n, i) => assert.equal(fs.statSync(path.join(dest, n)).size, 5000 + i));

  await assert.rejects(shell.list(dev, ['New2', 'Nope']), /No folder Nope/);
  assert.ok((await shell.list(dev, ['New2'])).some((i) => i.name === 'status'), 'it answers after an error');

  await new Promise((r) => setTimeout(r, 2600));
  assert.equal(shell.proc, null, 'an idle helper closes itself');
});

test('a request past its time is given up, and the next gets a fresh helper', { skip: !windows }, async (t) => {
  const { tmp, dev } = phoneDir();
  const shell = new ShellTransport({ timeoutMs: 1, perFileMs: 1, idleMs: 2000 });
  t.after(() => { shell.close(); setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 500); });
  await assert.rejects(shell.list(dev, ['New2']), (e) => e.code === 'timeout');
  shell.timeoutMs = 60_000;
  assert.ok((await shell.list(dev, ['New2'])).length > 0);
});
