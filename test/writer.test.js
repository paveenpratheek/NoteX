/* NoteX as the only writer: scripts wait while File Fabric has the canvas
 * open, each write is backed up and read back, the ledger tells the user's
 * edits from the agent's, lost writes are sent again, and overflowing text
 * grows its box (t-a80b904d43, t-ab2864c2a1, t-b0d14bc40f, t-2afecbd70b). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writer, lockAge, fingerprint } from '../engine/lib/writer.js';
import { readFabric } from '../engine/lib/fabric.js';
import { buildPlaces } from '../engine/lib/places.js';
import { areaBBox } from '../engine/lib/geometry.js';
import { sampleState } from './fixtures.js';

const EXAMPLE = `<Canvas name="Thesis"><Totem name="Pipeline">
  <Text>How the thesis gets written &amp; checked.</Text>
  <Row>
    <Area name="Collect"><Note name="Collect todo">- [ ] find papers
- [x] read survey</Note></Area>
    <Area name="Read"><Note name="Read todo">- [ ] skim ten</Note><Text>Survey first,
then the rest.</Text></Area>
    <Area name="Write"><Note name="Write todo">- [ ] outline</Note></Area>
    <Area name="Check"><Note name="Check todo">- [ ] proofread</Note><File path="notes.pdf"/></Area>
  </Row>
  <Line from="Collect" to="Read"/>
  <Line from="Read" to="Write"/>
  <Line from="Write" to="Check"/>
</Totem></Canvas>`;

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-writer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws');
  const dir = path.join(ws, 'Thesis');
  fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sources', 'notes.pdf'), '%PDF-1.4');
  fs.writeFileSync(path.join(dir, 'fabric.json'), JSON.stringify(sampleState()));
  const logs = [];
  const writer = new Writer({ config: { workspace: ws }, dataDir: path.join(root, 'data'), log: (m) => logs.push(m) });
  return { root, ws, dir, writer, logs };
}

// File Fabric's heartbeat, as it writes it: fresh now, or as old as asked.
function lock(dir, ageMs = 0) {
  const at = Date.now() - ageMs;
  const f = path.join(dir, '.fabric_lock');
  fs.writeFileSync(f, JSON.stringify({ timestamp: at, pid: 'tab' }));
  fs.utimesSync(f, at / 1000, at / 1000);
}
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'fabric.json'), 'utf8'));
const save = (dir, state, later = 0) => {
  const f = path.join(dir, 'fabric.json');
  fs.writeFileSync(f, JSON.stringify(state));
  if (later) fs.utimesSync(f, (Date.now() + later) / 1000, (Date.now() + later) / 1000);
};

test('round trip: script, then canvas, then buildPlaces - every address and text as written', async (t) => {
  const { dir, writer, root } = setup(t);
  lock(dir, 31_000); // File Fabric closed it half a minute ago
  const e = await writer.submit({ script: EXAMPLE, owner: 'agent-a' });
  assert.equal(e.status, 'written', JSON.stringify(e.result));
  const model = buildPlaces(readFabric(dir));
  const at = (address) => [...model.places.values()].find((p) => p.address === address);
  for (const b of e.result.boxes) assert.ok(at(b.address), b.address);
  assert.deepEqual(e.result.boxes.map((b) => b.address).slice(0, 4), ['Pipeline (totem)', 'Pipeline (totem) > Collect', 'Pipeline (totem) > Collect > Collect todo (note)', 'Pipeline (totem) > Read']);
  assert.deepEqual(at('Pipeline (totem)').texts, ['How the thesis gets written & checked.']);
  assert.deepEqual(at('Pipeline (totem) > Read').texts, ['Survey first,\nthen the rest.']);
  assert.equal(at('Pipeline (totem) > Collect > Collect todo (note)').area.textContent, '- [ ] find papers\n- [x] read survey');
  assert.deepEqual(at('Pipeline (totem) > Check').files.map((f) => [f.name, f.inSources]), [['notes.pdf', true]]);
  assert.equal(at('Pipeline (totem) > Collect').reach.total, 5);
  // The user's own canvas is untouched around it.
  const before = buildPlaces({ name: 'Thesis', state: sampleState() });
  for (const p of before.places.values()) assert.equal(at(p.address)?.id, p.id, p.address);
  // Backed up, and every item written is in the ledger as written.
  assert.equal(fs.readFileSync(e.result.backup, 'utf8'), JSON.stringify(sampleState()));
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'data', 'scripts', 'ledger-Thesis.json'), 'utf8'));
  const state = read(dir);
  const totem = state.totems.find((x) => x.name === 'Pipeline');
  assert.deepEqual([totem.owner, totem.writtenBy], ['agent-a', 'agent']);
  for (const item of [...state.areas, ...state.drawings, ...state.files, ...state.totems].filter((x) => x.writtenBy === 'agent')) {
    assert.equal(ledger.items[item.id].print, fingerprint(item), item.id);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'fabric.json.notex-tmp')));
});

test('a script for an open canvas waits until File Fabric has let go of it for 30 s', async (t) => {
  const { dir, writer } = setup(t);
  lock(dir, 5_000);
  assert.ok(lockAge(dir) < 30_000);
  const e = await writer.submit({ script: EXAMPLE, owner: 'agent-a' });
  assert.equal(e.status, 'waiting');
  assert.equal(read(dir).totems.length, 2, 'nothing written while it is open');
  assert.deepEqual(writer.report().Thesis.waiting.map((w) => w.what), ['new totem Pipeline']);
  assert.equal(writer.report().Thesis.open, true);
  // A second script waits behind the first.
  const e2 = await writer.submit({ script: '<Add canvas="Thesis" at="Pipeline (totem) > Write"><Text>later</Text></Add>', owner: 'agent-a' });
  assert.equal(e2.status, 'waiting');
  lock(dir, 31_000);
  await writer.tick();
  assert.equal(writer.entry(e.id).status, 'written');
  assert.equal(writer.entry(e2.id).status, 'written', JSON.stringify(writer.entry(e2.id).result));
  assert.ok(read(dir).drawings.some((d) => d.text === 'later'));
  // Kept across a restart: the queue lives in the data folder.
  const again = new Writer({ config: writer.config, dataDir: path.dirname(writer.dir) });
  assert.equal(again.entry(e2.id).status, 'written');
});

test('refused: a script that does not read, the user\'s totem, and an item the user edited', async (t) => {
  const { dir, writer } = setup(t);
  const bad = await writer.submit({ script: '<Canvas name="Thesis"><Totem name="T"><Area name="A"></Totem></Canvas>', owner: 'a' });
  assert.equal(bad.status, 'refused');
  assert.equal(bad.result.line, 1);
  assert.match(bad.result.message, /does not match <Area>/);
  assert.equal(writer.report().Thesis, undefined, 'never queued');
  const theirs = await writer.submit({ script: '<Add canvas="Thesis" at="RESEARCH (totem) > GAP PAPERS"><Text>x</Text></Add>', owner: 'a' });
  assert.equal(theirs.status, 'refused');
  assert.match(theirs.result.message, /in the user's totem RESEARCH/);
  const ok = await writer.submit({ script: EXAMPLE, owner: 'agent-a' });
  assert.equal(ok.status, 'written');
  // The user rewords one of the agent's texts in File Fabric.
  const state = read(dir);
  const text = state.drawings.find((d) => d.text && d.text.startsWith('Survey first'));
  text.text = 'Survey first - I changed this.';
  save(dir, state);
  const edit = await writer.submit({ script: `<Canvas name="Thesis"><Edit id="${text.id}">agent words</Edit></Canvas>`, owner: 'agent-a' });
  assert.equal(edit.status, 'refused');
  assert.match(edit.result.message, /was edited by the user since it was written/);
  assert.equal(read(dir).drawings.find((d) => d.id === text.id).text, 'Survey first - I changed this.', 'the user\'s words are kept');
  // Another agent cannot edit this agent's totem.
  const other = await writer.submit({ script: '<Add canvas="Thesis" at="Pipeline (totem) > Write"><Text>mine</Text></Add>', owner: 'agent-b' });
  assert.match(other.result.message, /belongs to agent-a/);
});

test('an Add the user\'s edit stands in the way of is refused; an untouched one is written', async (t) => {
  const { dir, writer } = setup(t);
  await writer.submit({ script: '<Canvas name="Thesis"><Totem name="Plan"><Area name="Top"><Text>first</Text></Area><Area name="Below"><Text>second</Text></Area></Totem></Canvas>', owner: 'a' });
  const state = read(dir);
  const below = state.areas.find((a) => a.name === 'Below');
  below.color = '#ff0000'; // the user recoloured the box under the one that will grow
  save(dir, state);
  const grow = await writer.submit({ script: '<Add canvas="Thesis" at="Plan (totem) > Top"><Note name="Todo">- [ ] 1\n- [ ] 2\n- [ ] 3\n- [ ] 4\n- [ ] 5</Note></Add>', owner: 'a' });
  assert.equal(grow.status, 'refused');
  assert.match(grow.result.message, /would push "Plan \(totem\) > Below", which was edited by the user/);
  const fine = await writer.submit({ script: '<Add canvas="Thesis" at="Plan (totem) > Below"><Note name="Todo">- [ ] 1\n- [ ] 2</Note></Add>', owner: 'a' });
  assert.equal(fine.status, 'refused', 'Below itself was edited, so it is not grown either');
  const top = await writer.submit({ script: '<Add canvas="Thesis" at="Plan (totem) > Top"><Text>short</Text></Add>', owner: 'a' });
  assert.equal(top.status, 'refused', 'Top grows into the gap above Below, which must move');
});

test('a write File Fabric may have missed is sent again after it saves over it', async (t) => {
  const { dir, writer, logs } = setup(t);
  const e = await writer.submit({ script: EXAMPLE, owner: 'agent-a' });
  assert.equal(e.status, 'written');
  // File Fabric had opened the old file just before: its first heartbeat comes now...
  lock(dir, 0);
  await writer.tick();
  // ...and its next save writes back the canvas without the agent's totem.
  save(dir, sampleState(), 5_000);
  await writer.tick();
  const resent = writer.data.entries.find((x) => x.resent === e.id);
  assert.ok(resent, logs.join('\n'));
  assert.equal(resent.status, 'waiting', 'it waits while the canvas is open');
  lock(dir, 31_000);
  await writer.tick();
  assert.equal(writer.entry(resent.id).status, 'written');
  assert.ok(read(dir).totems.some((x) => x.name === 'Pipeline'));
});

test('once File Fabric saves a taller real height, the agent\'s box grows to hold its text', async (t) => {
  const { dir, writer } = setup(t);
  await writer.submit({ script: '<Canvas name="Thesis"><Totem name="Plan"><Area name="Top"><Text>one line</Text><Text>two</Text></Area></Totem></Canvas>', owner: 'a' });
  const state = read(dir);
  const first = state.drawings.find((d) => d.text === 'one line');
  first._calculatedHeight = 400;
  first._calculatedWidth = 70;
  save(dir, state, 2_000);
  lock(dir, 31_000);
  await writer.tick();
  const after = read(dir);
  const top = areaBBox(after.areas.find((a) => a.name === 'Top'));
  const two = after.drawings.find((d) => d.text === 'two');
  assert.ok(two.y >= first.y + 400, 'the text below moved down');
  assert.ok(top.maxY >= two.y + 21, 'the box grew around both');
  // Upkeep's own write is in the ledger, so the agent may still edit there.
  const edit = await writer.submit({ script: `<Canvas name="Thesis"><Edit id="${two.id}">three</Edit></Canvas>`, owner: 'a' });
  assert.equal(edit.status, 'written', JSON.stringify(edit.result));
});

test('a totem for a canvas that does not exist yet makes the canvas', async (t) => {
  const { ws, writer } = setup(t);
  const e = await writer.submit({ script: '<Canvas name="Fresh"><Totem name="Start"><Area name="Box"><Text>hello</Text></Area></Totem></Canvas>', owner: 'a' });
  assert.equal(e.status, 'written', JSON.stringify(e.result));
  const model = buildPlaces(readFabric(path.join(ws, 'Fresh')));
  assert.deepEqual([...model.places.values()].map((p) => p.address).filter(Boolean), ['Start (totem)', 'Start (totem) > Box']);
  assert.ok(fs.existsSync(path.join(ws, 'Fresh', 'sources')));
  const add = await writer.submit({ script: '<Add canvas="Nowhere" at="X"><Text>a</Text></Add>', owner: 'a' });
  assert.match(add.result.message, /no canvas called Nowhere/);
});

test('the rules canvas is never written by an agent', async (t) => {
  const { dir, writer } = setup(t);
  writer.config.rules = 'Thesis';
  const e = await writer.submit({ script: EXAMPLE, owner: 'a' });
  assert.equal(e.status, 'refused');
  assert.match(e.result.message, /Thesis is the rules canvas, which holds only the user's own words/);
  assert.equal(read(dir).totems.length, 2);
});

test('Remove through the writer: gone from the canvas and the ledger; refused once the user edited it', async (t) => {
  const { dir, writer, root } = setup(t);
  await writer.submit({ script: EXAMPLE, owner: 'agent-a' });
  const ledgerOf = () => JSON.parse(fs.readFileSync(path.join(root, 'data', 'scripts', 'ledger-Thesis.json'), 'utf8')).items;
  const lines = read(dir).drawings.filter((d) => d.type === 'line' && d.writtenBy === 'agent');
  assert.equal(lines.length, 3);
  const e = await writer.submit({ script: `<Canvas name="Thesis">${lines.map((l) => `<Remove id="${l.id}"/>`).join('')}</Canvas>`, owner: 'agent-a' });
  assert.equal(e.status, 'written', JSON.stringify(e.result));
  assert.equal(e.what, '3 removals');
  assert.equal(e.result.removed, 3);
  assert.equal(read(dir).drawings.filter((d) => d.type === 'line' && d.writtenBy === 'agent').length, 0);
  for (const l of lines) assert.equal(ledgerOf()[l.id], undefined);
  // The user ticks a checklist item in File Fabric: that note, and the box around it, stay.
  const state = read(dir);
  const note = state.areas.find((a) => a.name === 'Read todo');
  note.textContent = '- [x] skim ten';
  save(dir, state);
  const box = state.areas.find((a) => a.name === 'Read');
  const r = await writer.submit({ script: `<Canvas name="Thesis"><Remove id="${box.id}"/></Canvas>`, owner: 'agent-a' });
  assert.equal(r.status, 'refused');
  assert.match(r.result.message, /would take "Pipeline \(totem\) > Read > Read todo \(note\)" with it, which was edited by the user since it was written/);
  assert.ok(read(dir).areas.some((a) => a.id === box.id));
});
