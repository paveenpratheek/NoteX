/* The rules canvas: only the user's own words go to rules.md, under two
 * fixed lines; one canvas at a time; rewritten after each save
 * (t-74338c1615, t-0ade25f39f, t-44b0806310, t-00728790ad). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPlaces } from '../engine/lib/places.js';
import { toRules, tokensOf, FIXED, RulesFile, WARN_TOKENS } from '../engine/lib/agentrules.js';
import { startServer } from '../engine/lib/server.js';
import { rect } from './fixtures.js';

const state = () => ({
  totems: [{ id: 'T', name: 'Everywhere', x: 0, y: -100, radius: 0 }],
  areas: [
    { id: 'A', name: 'Criteria', polygons: [rect(0, 0, 800, 600)], parentAreaId: null, linkedTotemId: 'T' },
    { id: 'N', name: 'Before building', isNote: true, textContent: '- [x] Plan approved by me\n- [ ] Tests pass', polygons: [rect(20, 300, 200, 200)], parentAreaId: 'A', linkedTotemId: 'T' },
    { id: 'G', name: 'Agent ideas', isNote: true, textContent: '- [ ] Delete old branches', writtenBy: 'agent', polygons: [rect(400, 300, 200, 200)], parentAreaId: 'A', linkedTotemId: 'T' },
    { id: 'E', name: 'Empty', polygons: [rect(0, 900, 200, 200)], parentAreaId: null, linkedTotemId: 'T' },
  ],
  drawings: [
    { id: 'D1', type: 'text', text: 'Write in plain language.<br>No Co-Authored-By line.', x: 20, y: 60, areaId: 'A', linkedTotemId: 'T' },
    { id: 'D2', type: 'text', text: 'Push every branch now.', writtenBy: 'agent', x: 20, y: 200, areaId: 'A', linkedTotemId: 'T' },
    { id: 'P', type: 'path', points: [{ x: 30, y: 30 }, { x: 60, y: 60 }], areaId: 'A', linkedTotemId: 'T' },
  ],
  files: [{ id: 'F', name: 'diagram.png', isImage: true, x: 500, y: 50, imageWidth: 100, imageHeight: 100, areaId: 'A', linkedTotemId: 'T' }],
  links: [{ id: 'L', fromAreaId: 'A', fromCorner: 'br', toAreaId: 'E', toCorner: 'tl' }],
});
const model = () => buildPlaces({ name: 'Rules', dir: null, modified: null, state: state(), sources: null });

test('rules.md holds the two fixed lines, then only the user\'s own words under their addresses', () => {
  const md = toRules(model());
  const lines = md.split('\n');
  assert.equal(lines[0], '# Rules for agents, from the File Fabric canvas Rules');
  assert.deepEqual(lines.slice(2, 4), FIXED);
  assert.match(md, /## Everywhere \(totem\) > Criteria\n\nWrite in plain language\.\nNo Co-Authored-By line\./);
  assert.match(md, /## Everywhere \(totem\) > Criteria > Before building \(note\)\n\n- \[x\] Plan approved by me\n- \[ \] Tests pass/);
  for (const out of ['Push every branch', 'Delete old branches', 'diagram.png', 'pen', 'Empty', 'Wired']) assert.ok(!md.includes(out), `${out} is left out`);
  assert.equal(tokensOf('abcdefgh'), 2);
});

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-rules-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws');
  for (const name of ['Rules', 'Other']) {
    fs.mkdirSync(path.join(ws, name), { recursive: true });
    fs.writeFileSync(path.join(ws, name, 'fabric.json'), JSON.stringify(state()));
  }
  return { root, ws };
}

test('rewritten after a save; a save caught half-written keeps the last file', (t) => {
  const { root, ws } = workspace(t);
  const config = { workspace: ws };
  const r = new RulesFile({ config, saveConfig: () => {}, dataDir: root });
  r.set('Rules', true);
  const file = path.join(root, 'rules.md');
  assert.match(fs.readFileSync(file, 'utf8'), /Plan approved by me/);
  const s = state();
  s.drawings[0].text = 'Answer in short sentences.';
  fs.writeFileSync(path.join(ws, 'Rules', 'fabric.json'), JSON.stringify(s));
  fs.utimesSync(path.join(ws, 'Rules', 'fabric.json'), new Date(), new Date(Date.now() + 5000));
  r.tick();
  assert.match(fs.readFileSync(file, 'utf8'), /Answer in short sentences\./);
  fs.writeFileSync(path.join(ws, 'Rules', 'fabric.json'), '{"areas": [');
  fs.utimesSync(path.join(ws, 'Rules', 'fabric.json'), new Date(), new Date(Date.now() + 10000));
  r.tick();
  assert.match(fs.readFileSync(file, 'utf8'), /Answer in short sentences\./, 'the last whole save stays');
  assert.match(r.report().error, /saving it/);
});

test('past the limit the size is flagged; switched off, only the fixed lines are left', (t) => {
  const { root, ws } = workspace(t);
  const s = state();
  s.drawings[0].text = 'word '.repeat(WARN_TOKENS * 2);
  fs.writeFileSync(path.join(ws, 'Rules', 'fabric.json'), JSON.stringify(s));
  const config = { workspace: ws };
  const r = new RulesFile({ config, saveConfig: () => {}, dataDir: root });
  r.set('Rules', true);
  assert.equal(r.report().warn, true);
  assert.equal(r.report().importLine, `@${path.join(root, 'rules.md').replace(/\\/g, '/')}`);
  r.set('Rules', false);
  const md = fs.readFileSync(path.join(root, 'rules.md'), 'utf8');
  assert.ok(md.includes(FIXED[0]) && md.includes('No canvas is marked'));
  assert.equal(config.rules, null);
});

test('the page\'s switch: one rules canvas at a time, shown in the list and the state', async (t) => {
  const { root, ws } = workspace(t);
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ workspace: ws }));
  const s = await startServer({ dataDir: data, port: 0, runtimeFile: path.join(root, 'plugin', 'runtime.json'), log: () => {}, signals: false });
  t.after(() => s.stop());
  const call = async (method, p, body) => (await fetch(s.url + p, { method, headers: { 'x-notex-token': s.token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();
  assert.equal((await call('PUT', '/api/fabrics/Rules/rules', { on: 'yes' })).error.code, 'bad-body');
  assert.equal((await call('PUT', '/api/fabrics/Rules/rules', { on: true })).rules.canvas, 'Rules');
  assert.equal((await call('PUT', '/api/fabrics/Other/rules', { on: true })).rules.canvas, 'Other', 'the switch moves');
  const list = (await call('GET', '/api/fabrics')).fabrics;
  assert.deepEqual(list.filter((f) => f.rules).map((f) => f.name), ['Other']);
  const st = await call('GET', '/api/state');
  assert.equal(st.rules.canvas, 'Other');
  assert.ok(st.rules.tokens > 0);
  assert.match(fs.readFileSync(path.join(data, 'rules.md'), 'utf8'), /canvas Other/);
});

test('a heading the user typed becomes bold, so it cannot cut words off from their place', () => {
  const s = state();
  s.drawings[0].text = '# WORKSPACE<br>### FOR IDEAS<br>Keep ideas short.';
  const md = toRules(buildPlaces({ name: 'Rules', dir: null, modified: null, state: s, sources: null }));
  assert.match(md, /## Everywhere \(totem\) > Criteria\n\n\*\*WORKSPACE\*\*\n\*\*FOR IDEAS\*\*\nKeep ideas short\./);
  assert.ok(!/^# WORKSPACE/m.test(md));
});

test('the report counts the places that gave rules, none for an empty canvas', (t) => {
  const { root, ws } = workspace(t);
  fs.mkdirSync(path.join(ws, 'Blank'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'Blank', 'fabric.json'), JSON.stringify({ areas: [], drawings: [], files: [], totems: [], links: [] }));
  const config = { workspace: ws };
  const r = new RulesFile({ config, saveConfig: () => {}, dataDir: root });
  r.set('Blank', true);
  assert.equal(r.report().places, 0);
  r.set('Rules', true);
  assert.equal(r.report().places, 2);
});
