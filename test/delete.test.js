/* The agent deletes on its own canvas what the user asks it to
 * (t-44045fd69e), and what goes stays recoverable (t-dbfe16a2b9). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writer } from '../engine/lib/writer.js';
import { Bronze } from '../engine/lib/bronze.js';
import { AgentCanvases } from '../engine/lib/agentcanvas.js';
import { Arranger, checkArrangement, extractScripts, extractDeletes, asksToDelete } from '../engine/lib/arranger.js';

const BUGS = '<Canvas name="Board"><Totem name="Bugs"><Area name="Open"><Note name="Ingest">- [ ] slow ingest</Note><Note name="Figures">- [ ] figures missed</Note></Area></Totem></Canvas>';
const IDEAS = '<Canvas name="Board"><Totem name="Ideas"><Note name="Search">time windows for search</Note><Text>Later, maybe.</Text></Totem></Canvas>';
const BUGS_NO_FIGURES = '<Canvas name="Board"><Totem name="Bugs"><Area name="Open"><Note name="Ingest">- [ ] slow ingest</Note></Area></Totem></Canvas>';
const fence = (...blocks) => `Done.\n${blocks.map((s) => '```xml\n' + s + '\n```').join('\n')}`;
const before = [{ name: 'Bugs', script: BUGS }, { name: 'Ideas', script: IDEAS }];

test('a <Delete> block is read apart from the scripts', () => {
  const answer = fence(BUGS_NO_FIGURES, '<Canvas name="Board"><Delete note="Figures"/><Delete totem=\'Ideas\'/><Delete text="Later &amp; maybe"/></Canvas>');
  assert.deepEqual(extractScripts(answer), [BUGS_NO_FIGURES]);
  assert.deepEqual(extractDeletes(answer, 'Board').deletes, [{ kind: 'note', value: 'Figures' }, { kind: 'totem', value: 'Ideas' }, { kind: 'text', value: 'Later & maybe' }]);
  assert.match(extractDeletes(fence('<Canvas name="Notes"><Delete note="x"/></Canvas>'), 'Board').reason, /for the canvas "Notes"/);
  assert.match(extractDeletes(fence('<Canvas name="Board"><Delete box="x"/></Canvas>'), 'Board').reason, /not one NoteX knows/);
  assert.match(extractDeletes(fence('<Canvas name="Board"><Totem name="T"/><Delete note="x"/></Canvas>'), 'Board').reason, /block of their own/);
  assert.deepEqual(extractDeletes('No blocks here.', 'Board').deletes, []);
});

test('the user\'s words must ask for something to go', () => {
  for (const s of ['delete the ideas totem', 'Remove Figures', 'please clear out the old notes', 'get rid of that', 'clean up the bugs box', 'take them off the canvas', 'erase it']) assert.equal(asksToDelete(s), true, s);
  for (const s of ['arrange this by topic', 'tidy it', 'move Figures to Ideas', 'what is on the board?', 'make the boxes bigger']) assert.equal(asksToDelete(s), false, s);
});

test('a deletion is taken only when named and asked for; anything else lost is still refused', () => {
  // A note left out and named, the user having asked: taken.
  const ok = checkArrangement([BUGS_NO_FIGURES], 'Board', before, [{ kind: 'note', value: 'Figures' }], true);
  assert.equal(ok.reason, undefined);
  assert.deepEqual(ok.deleted, ['the note "- [ ] figures missed"']);
  assert.deepEqual(ok.removeTotems, []);
  // The same, named by its first words.
  assert.equal(checkArrangement([BUGS_NO_FIGURES], 'Board', before, [{ kind: 'note', value: '- [ ] figures' }], true).reason, undefined);
  // Not asked for: refused, whatever was named.
  assert.match(checkArrangement([BUGS_NO_FIGURES], 'Board', before, [{ kind: 'note', value: 'Figures' }], false).reason, /the user did not ask/);
  // Left out but not named: refused as before.
  assert.match(checkArrangement([BUGS_NO_FIGURES], 'Board', before, [], true).reason, /it lost the note "- \[ \] figures missed".*name each in a <Delete> tag/);
  // Named the wrong thing: refused.
  assert.match(checkArrangement([BUGS_NO_FIGURES], 'Board', before, [{ kind: 'note', value: 'Ingest' }], true).reason, /it lost the note "- \[ \] figures missed"/);
  // A whole totem: everything in it goes, and no script is needed.
  const t = checkArrangement([], 'Board', before, [{ kind: 'totem', value: 'ideas' }], true);
  assert.equal(t.reason, undefined);
  assert.deepEqual(t.removeTotems, ['Ideas']);
  assert.deepEqual(t.deleted, ['the note "time windows for search"', 'the text "Later, maybe."']);
  assert.match(checkArrangement([], 'Board', before, [{ kind: 'totem', value: 'Nope' }], true).reason, /names no totem on the canvas - the totems are "Bugs", "Ideas"/);
  assert.match(checkArrangement([IDEAS], 'Board', before, [{ kind: 'totem', value: 'Ideas' }], true).reason, /both deleted and sent/);
  // Moving things still needs no <Delete>: a note moved to another totem is not lost.
  const moved = '<Canvas name="Board"><Totem name="Ideas"><Note name="Search">time windows for search</Note><Text>Later, maybe.</Text><Note name="Figures">- [ ] figures missed</Note></Totem></Canvas>';
  assert.equal(checkArrangement([BUGS_NO_FIGURES, moved], 'Board', before, [], false).reason, undefined);
});

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-delete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws'), data = path.join(root, 'data');
  fs.mkdirSync(path.join(ws, 'Board'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'Board', 'fabric.json'), JSON.stringify({ drawings: [], areas: [], files: [], links: [], totems: [] }));
  fs.writeFileSync(path.join(ws, 'Board', 'agent.json'), '{}');
  const config = { workspace: ws };
  const writer = new Writer({ config, dataDir: data });
  const bronze = new Bronze(data);
  writer.agent = new AgentCanvases({ dataDir: data, writer, bronze });
  for (const script of [BUGS, IDEAS]) assert.equal((await writer.submit({ script, owner: 'NoteX placer' })).status, 'written');
  const answers = [];
  const arranger = new Arranger({ config, dataDir: data, writer, run: async () => ({ text: answers.shift() }) });
  const ask = async (words, drops = []) => { arranger.ask('Board', words, null, { drops }); await arranger.running.done; return arranger.report('Board'); };
  const fabric = () => JSON.parse(fs.readFileSync(path.join(ws, 'Board', 'fabric.json'), 'utf8'));
  return { ws, data, writer, bronze, arranger, answers, ask, fabric };
}

test('deleting a whole totem: gone from the canvas, its script kept among its versions', async (t) => {
  const s = await setup(t);
  s.answers.push(fence('<Canvas name="Board"><Delete totem="Ideas"/></Canvas>'));
  const r = await s.ask('Delete the Ideas totem, I do not need it.');
  assert.equal(r.status, 'done');
  assert.deepEqual(r.totems, ['Ideas (deleted)']);
  assert.deepEqual(s.writer.agent.scripts('Board').map((x) => x.name), ['Bugs']);
  assert.deepEqual(s.fabric().totems.map((x) => x.name), ['Bugs']);
  assert.equal(JSON.stringify(s.fabric()).includes('time windows for search'), false);
  const vdir = path.join(s.writer.agent.dir('Board'), 'versions');
  const kept = fs.readdirSync(vdir).flatMap((d) => fs.readdirSync(path.join(vdir, d)).map((f) => fs.readFileSync(path.join(vdir, d, f), 'utf8')));
  assert.ok(kept.map((k) => k.replace(/ id="tm-[0-9a-f]{10}"/g, '')).includes(IDEAS), 'the deleted script is kept');
  assert.ok(s.writer.agent.activity('Board').some((a) => a.what === 'deleted'));
});

test('deleting a note inside a totem, and refusing what was not asked for', async (t) => {
  const s = await setup(t);
  s.answers.push(fence(BUGS_NO_FIGURES, '<Canvas name="Board"><Delete note="Figures"/></Canvas>'));
  assert.equal((await s.ask('Remove the Figures note.')).status, 'done');
  assert.equal(JSON.stringify(s.fabric()).includes('figures missed'), false);
  assert.equal(JSON.stringify(s.fabric()).includes('slow ingest'), true);
  // "Tidy" asks for no deleting: the same kind of answer is refused, twice, and nothing changes.
  const NO_INGEST = '<Canvas name="Board"><Totem name="Bugs"><Area name="Open"></Area></Totem></Canvas>';
  s.answers.push(fence(NO_INGEST, '<Canvas name="Board"><Delete note="Ingest"/></Canvas>'), fence(NO_INGEST, '<Canvas name="Board"><Delete note="Ingest"/></Canvas>'));
  const r = await s.ask('Tidy the bugs.');
  assert.equal(r.status, 'failed');
  assert.match(r.detail, /the user did not ask for anything to be deleted/);
  assert.equal(JSON.stringify(s.fabric()).includes('slow ingest'), true);
});

test('a deleted drop goes back to the Inbox, waiting, never erased', async (t) => {
  const s = await setup(t);
  const d = s.bronze.land({ text: 'call the plumber', canvas: 'Board', via: 'canvasx' });
  s.bronze.mark(d.id, 'placing');
  const WITH = `<Canvas name="Board"><Totem name="Ideas"><Note name="Search">time windows for search</Note><Text>Later, maybe.</Text><Note name="Todo" drop="${d.id}"/></Totem></Canvas>`;
  s.answers.push(fence(WITH));
  assert.equal((await s.ask('Put this in Ideas.', [d.id])).status, 'done');
  assert.equal(s.bronze.get(d.id).status, 'placed');
  s.answers.push(fence(IDEAS, `<Canvas name="Board"><Delete drop="${d.id}"/></Canvas>`));
  assert.equal((await s.ask('Delete the plumber note.')).status, 'done');
  const back = s.bronze.get(d.id);
  assert.equal(back.status, 'waiting');
  assert.match(back.detail, /Deleted from Board by the agent, as you asked/);
  assert.equal(fs.readFileSync(s.bronze.file(d.id), 'utf8'), 'call the plumber');
  assert.equal(JSON.stringify(s.fabric()).includes('call the plumber'), false);
});
