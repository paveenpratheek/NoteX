/* Phase 4 on NoteX's side: each file on a canvas gets a File: path under its
 * place, and the files RAGX can read are listed with their places. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFabric, writeBuilt } from '../engine/lib/server.js';
import { sampleState } from './fixtures.js';

function canvas(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'Thesis');
  fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
  const state = sampleState();
  // Beside the survey PDF: a Word file in the same area, and one placed with no copy in sources/.
  const survey = state.files.find((f) => f.name === 'survey-2024.pdf');
  state.files.push({ ...survey, id: 'F-w', name: 'notes.docx', isPdf: false }, { ...survey, id: 'F-x', name: 'missing.pdf' });
  fs.writeFileSync(path.join(dir, 'fabric.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(dir, 'sources', 'survey-2024.pdf'), '%PDF-1.4 survey');
  fs.writeFileSync(path.join(dir, 'sources', 'notes.docx'), 'PK word');
  return { root, dir };
}

test('a file with a copy in sources/ gets its File: path under its place', (t) => {
  const { dir } = canvas(t);
  const md = buildFabric(dir).markdown;
  assert.ok(md.includes(`- survey-2024.pdf (PDF) - File: ${path.join(dir, 'sources', 'survey-2024.pdf')}`));
  assert.match(md, /- missing\.pdf \(PDF\)\n/, 'no copy, no path');
});

test('the files RAGX can read are listed with their hash and address; images and missing copies are not', (t) => {
  const { dir } = canvas(t);
  const { files } = buildFabric(dir);
  assert.equal(files.canvas, 'Thesis');
  const sha = crypto.createHash('sha256').update('%PDF-1.4 survey').digest('hex');
  const pdf = files.files.find((f) => f.name === 'survey-2024.pdf');
  assert.deepEqual(pdf, { name: 'survey-2024.pdf', sha256: sha, address: 'RESEARCH (totem) > GAP PAPERS > LITERATURE SURVEY', path: path.join(dir, 'sources', 'survey-2024.pdf'), kind: 'PDF' });
  assert.ok(files.files.some((f) => f.name === 'notes.docx'));
  assert.ok(!files.files.some((f) => f.name === 'missing.pdf'));
  assert.ok(files.files.every((f) => !/\.(png|jpe?g|webp|gif)$/i.test(f.name)));
});

test('a changed file gets its new hash on the next build', (t) => {
  const { dir } = canvas(t);
  const before = buildFabric(dir).files.files.find((f) => f.name === 'survey-2024.pdf').sha256;
  fs.writeFileSync(path.join(dir, 'sources', 'survey-2024.pdf'), '%PDF-1.4 survey, second edition');
  const after = buildFabric(dir).files.files.find((f) => f.name === 'survey-2024.pdf').sha256;
  assert.notEqual(after, before);
});

test('a build leaves the file list beside the document and its place map', (t) => {
  const { root, dir } = canvas(t);
  const out = path.join(root, 'docs');
  writeBuilt(out, 'Thesis', buildFabric(dir));
  for (const f of ['Thesis.files.json', 'Thesis.notex.md', 'Thesis.places.json']) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'Thesis.files.json'), 'utf8')).files.length, 2);
});
