/* Bronze: drops kept as they arrived, checked at the door, stored once by
 * content, and forgotten for good when the user asks (t-1c0fff1756,
 * t-48e622a449, t-dbb33d26b4, t-b631349744, t-0057e4703e). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bronze, BronzeError, kindOf, sniff } from '../engine/lib/bronze.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....[Content_Types].xml....word/document.xml....')]);

function setup(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-bronze-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const clock = { t: Date.parse('2026-10-30T09:00:00Z') };
  const make = () => new Bronze(data, { now: () => (clock.t += 1000) });
  return { data, make, dir: path.join(data, 'bronze') };
}

const refused = (fn, code) => assert.throws(fn, (e) => e instanceof BronzeError && e.code === code);

test('kinds come from the name, and the bytes must agree', () => {
  assert.equal(kindOf('notes.MD'), 'md');
  assert.equal(kindOf('scan.jpeg'), 'image');
  assert.equal(kindOf('report.docx'), 'docx');
  assert.equal(kindOf('page.html'), null);
  assert.equal(sniff('image', PNG), '.png');
  assert.equal(sniff('image', JPEG), '.jpg');
  assert.equal(sniff('pdf', PDF), '.pdf');
  assert.equal(sniff('docx', DOCX), '.docx');
  assert.equal(sniff('docx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('xl/workbook.xml')])), null, 'a spreadsheet is a ZIP too');
  assert.equal(sniff('pdf', PNG), null);
  assert.equal(sniff('text', Buffer.from([0x68, 0xc3, 0x28])), null, 'not UTF-8');
  assert.equal(sniff('md', Buffer.from('a\0b')), null, 'a NUL byte is not text');
});

test('a drop lands with its kind, bytes, name and note, waiting for a canvas', (t) => {
  const { make, dir } = setup(t);
  const b = make();
  const d = b.land({ bytes: PDF, name: 'C:/papers/survey.pdf', note: 'read first' });
  assert.match(d.id, /^d-[0-9a-f]{10}$/);
  assert.equal(d.kind, 'pdf');
  assert.equal(d.name, 'survey.pdf', 'the name, never the folder it came from');
  assert.equal(d.note, 'read first');
  assert.equal(d.status, 'waiting');
  assert.equal(d.canvas, null);
  assert.deepEqual(fs.readFileSync(b.file(d.id)), PDF);
  assert.ok(b.file(d.id).startsWith(path.join(dir, 'blobs', 'pdf')));

  const typed = b.land({ text: 'RAGX ingest drops figures on scanned pages', canvas: 'Harness' });
  assert.equal(typed.kind, 'text');
  assert.equal(typed.name, null);
  assert.equal(typed.status, 'queued');
  assert.equal(typed.canvas, 'Harness');
  assert.deepEqual(make().list().map((x) => x.id), [typed.id, d.id], 'newest first, from any Bronze on the folder');
});

test('a drop that is not what its name says is refused at the door', (t) => {
  const { make, dir } = setup(t);
  const b = make();
  refused(() => b.land({ bytes: PNG, name: 'page.html' }), 'kind');
  refused(() => b.land({ bytes: PNG, name: 'renamed.pdf' }), 'not-kind');
  refused(() => b.land({ bytes: Buffer.alloc(0), name: 'empty.md' }), 'empty');
  refused(() => b.land({ text: '   \n' }), 'empty');
  refused(() => b.land({ bytes: PNG, name: 'a.png', text: 'both' }), 'two-things');
  assert.deepEqual(b.list(), []);
  assert.equal(fs.existsSync(path.join(dir, 'blobs')), false, 'nothing refused is kept');
});

test('the same content dropped twice is two drops sharing one blob', (t) => {
  const { make } = setup(t);
  const b = make();
  const one = b.land({ bytes: JPEG, name: 'board.jpeg' });
  const two = b.land({ bytes: JPEG, name: 'board copy.jpg' });
  assert.notEqual(one.id, two.id);
  assert.equal(one.blob, two.blob);
  assert.match(one.blob, /\.jpg$/, 'the extension comes from the bytes');
});

test('a canvas is chosen now or later, and a drop being placed keeps it', (t) => {
  const { make } = setup(t);
  const b = make();
  const d = b.land({ bytes: PNG, name: 'diagram.png' });
  refused(() => b.mark(d.id, 'placing'), 'no-canvas');
  assert.equal(b.choose(d.id, 'Harness').status, 'queued');
  assert.equal(b.choose(d.id, 'NoteX').canvas, 'NoteX', 'changed before it is placed');
  assert.equal(b.mark(d.id, 'placing').status, 'placing');
  refused(() => b.choose(d.id, 'Harness'), 'placed');
  const failed = b.mark(d.id, 'failed', 'the agent could not read it');
  assert.equal(failed.detail, 'the agent could not read it');
  assert.equal(b.choose(d.id, 'Harness').status, 'queued', 'a failed drop can go again');
  refused(() => b.mark(d.id, 'lost'), 'status');
  refused(() => b.get('d-0000000000'), 'no-drop');
});

test('forgetting a drop removes its lines and its blob, and the erasure keeps no content', (t) => {
  const { make, dir } = setup(t);
  const b = make();
  const keep = b.land({ text: 'keep me' });
  const d = b.land({ bytes: PDF, name: 'private-letter.pdf', note: 'my landlord', canvas: 'Harness' });
  const blob = b.file(d.id);
  assert.deepEqual(b.forget(d.id), { id: d.id, blob: 'deleted' });

  assert.equal(fs.existsSync(blob), false);
  const log = fs.readFileSync(path.join(dir, 'drops.jsonl'), 'utf8');
  assert.ok(!log.includes(d.id) && !log.includes('private-letter') && !log.includes('landlord'));
  const erasures = fs.readFileSync(path.join(dir, 'erasures.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(erasures[0]).sort(), ['erasedAt', 'id', 'kind', 'landedAt']);
  assert.ok(!JSON.stringify(erasures).includes(path.basename(blob, '.pdf')), 'no hash of what was forgotten');
  assert.deepEqual(b.list().map((x) => x.id), [keep.id]);
  refused(() => b.forget(d.id), 'no-drop');
});

test('a blob two drops share is deleted with the last of them', (t) => {
  const { make } = setup(t);
  const b = make();
  const one = b.land({ bytes: PNG, name: 'a.png' });
  const two = b.land({ bytes: PNG, name: 'b.png' });
  const blob = b.file(one.id);
  assert.equal(b.forget(one.id).blob, 'shared');
  assert.ok(fs.existsSync(blob));
  assert.equal(b.forget(two.id).blob, 'deleted');
  assert.equal(fs.existsSync(blob), false);
});

test('a forget cut short by a crash is finished the next time bronze is read', (t) => {
  const { make, dir } = setup(t);
  const b = make();
  const d = b.land({ text: 'half forgotten' });
  const blob = b.file(d.id);
  // The crash: the erasure was recorded, nothing else happened.
  fs.appendFileSync(path.join(dir, 'erasures.jsonl'), JSON.stringify({ id: d.id, kind: 'text', landedAt: d.landedAt, erasedAt: d.landedAt }) + '\n');
  assert.deepEqual(make().list(), []);
  assert.equal(fs.existsSync(blob), false);
  assert.ok(!fs.readFileSync(path.join(dir, 'drops.jsonl'), 'utf8').includes(d.id));
});

test('a line cut short by a crash is skipped and never swallows the next one', (t) => {
  const { make, dir } = setup(t);
  const b = make();
  const one = b.land({ text: 'before the crash' });
  fs.appendFileSync(path.join(dir, 'drops.jsonl'), '{"ev":"landed","id":"d-torn');
  const two = b.land({ text: 'after the crash' });
  assert.deepEqual(make().list().map((x) => x.id), [two.id, one.id]);
});
