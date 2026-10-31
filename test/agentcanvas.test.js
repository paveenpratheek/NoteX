/* Agent canvases: drawn from one script per totem, each kept with its
 * versions and last good copy, pinned in place, and placing what the user
 * dropped in the Inbox (t-3011840b7e, t-c42859ce48, t-0b88e8ea91,
 * t-b3ec8c9410, t-2fa309e6c8). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writer } from '../engine/lib/writer.js';
import { Bronze } from '../engine/lib/bronze.js';
import { AgentCanvases, scriptFile } from '../engine/lib/agentcanvas.js';
import { readFabric } from '../engine/lib/fabric.js';
import { buildPlaces } from '../engine/lib/places.js';
import { parseScript, ScriptError } from '../engine/lib/script.js';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-agent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws');
  const data = path.join(root, 'data');
  for (const name of ['Board', 'Notes']) {
    fs.mkdirSync(path.join(ws, name), { recursive: true });
    fs.writeFileSync(path.join(ws, name, 'fabric.json'), JSON.stringify({ drawings: [], areas: [], files: [], links: [], totems: [], tables: [], fabricColor: '#202020', camera: { x: 5, y: 6, zoom: 1 } }));
  }
  fs.writeFileSync(path.join(ws, 'Board', 'agent.json'), '{}');
  const logs = [];
  const writer = new Writer({ config: { workspace: ws }, dataDir: data, log: (m) => logs.push(m) });
  const bronze = new Bronze(data);
  const agent = new AgentCanvases({ dataDir: data, writer, bronze, log: (m) => logs.push(m) });
  writer.agent = agent;
  const board = path.join(ws, 'Board');
  const places = () => [...buildPlaces(readFabric(board)).places.values()].map((p) => p.address).filter(Boolean);
  const totemsAt = () => Object.fromEntries(readFabric(board).state.totems.map((x) => [x.name, x.x]));
  return { root, ws, data, writer, bronze, agent, board, places, totemsAt, logs };
}

const totem = (name, body, canvas = 'Board') => `<Canvas name="${canvas}"><Totem name="${name}">${body}</Totem></Canvas>`;

test('drop="d-..." is read by the parser: empty words, and path or drop on a File', () => {
  const p = parseScript(totem('T', '<Note name="Idea" drop="d-0123456789"/>'));
  assert.equal(p.totem.children[0].attrs.drop, 'd-0123456789');
  assert.equal(parseScript(totem('T', '<File drop="d-0123456789"/>')).totem.children[0].attrs.drop, 'd-0123456789');
  assert.throws(() => parseScript(totem('T', '<Note name="Idea" drop="d-0123456789">words</Note>')), /takes its words from the drop/);
  assert.throws(() => parseScript(totem('T', '<File/>')), /<File> needs path/);
  assert.throws(() => parseScript(totem('T', '<File path="a.pdf" drop="d-0123456789"/>')), /path or drop, not both/);
  assert.throws(() => parseScript(totem('T', '<Text drop="42"/>')), (e) => e instanceof ScriptError && /not a drop id/.test(e.message));
});

test('a totem script on an agent canvas is kept as that totem\'s file and drawn', async (t) => {
  const { writer, agent, data, board, places } = setup(t);
  const e = await writer.submit({ script: totem('Engine', '<Area name="Ingest"><Note name="Todo">- [ ] chunker</Note></Area>'), owner: 'claude' });
  assert.equal(e.status, 'written', JSON.stringify(e.result));
  assert.deepEqual(e.result.totems, [{ totem: 'Engine', drawn: 'new', errors: [] }]);
  assert.ok(places().includes('Engine (totem) > Ingest > Todo (note)'));
  const file = scriptFile('Engine');
  const dir = path.join(data, 'agent-canvases', 'Board');
  assert.match(fs.readFileSync(path.join(dir, file), 'utf8'), /chunker/);
  assert.equal(fs.readFileSync(path.join(dir, 'good', file), 'utf8'), fs.readFileSync(path.join(dir, file), 'utf8'));
  const st = readFabric(board).state;
  assert.equal(st.fabricColor, '#202020', 'the canvas keeps its own settings');
  assert.deepEqual(st.camera, { x: 5, y: 6, zoom: 1 });
  assert.equal(agent.scripts('Board')[0].owner, 'claude');
});

test('a new version replaces its totem, keeps the old among the versions, and leaves the others pinned', async (t) => {
  const { writer, data, places, totemsAt } = setup(t);
  await writer.submit({ script: totem('Engine', '<Area name="Ingest"><Note name="Todo">- [ ] chunker</Note></Area>'), owner: 'claude' });
  await writer.submit({ script: totem('Search', '<Area name="Hybrid"><Text>BM25 and vectors.</Text></Area>'), owner: 'claude' });
  const before = totemsAt();
  assert.ok(before.Search > before.Engine);
  // The same version again changes nothing on the canvas.
  await writer.submit({ script: totem('Search', '<Area name="Hybrid"><Text>BM25 and vectors.</Text></Area>'), owner: 'claude' });
  assert.deepEqual(totemsAt(), before);
  const r = await writer.submit({ script: totem('Engine', '<Area name="Ingest"><Note name="Todo">- [x] chunker</Note><Text>Done on Thursday.</Text></Area>'), owner: 'claude' });
  assert.equal(r.status, 'written', JSON.stringify(r.result));
  assert.ok(places().includes('Engine (totem) > Ingest > Todo (note)'));
  assert.ok(places().includes('Search (totem) > Hybrid'));
  assert.deepEqual(totemsAt(), before, 'a taller Engine pushes nothing sideways');
  const versions = path.join(data, 'agent-canvases', 'Board', 'versions', scriptFile('Engine').replace(/\.totem$/, ''));
  const kept = fs.readdirSync(versions);
  assert.equal(kept.length, 1);
  assert.match(fs.readFileSync(path.join(versions, kept[0]), 'utf8'), /\[ \] chunker/);
});

test('a totem that grows wider pushes the totem after it, never the one before', async (t) => {
  const { writer, totemsAt } = setup(t);
  await writer.submit({ script: totem('A', '<Area name="One"><Text>a</Text></Area>'), owner: 'claude' });
  await writer.submit({ script: totem('B', '<Area name="Two"><Text>b</Text></Area>'), owner: 'claude' });
  const was = totemsAt();
  const wide = '<Row>' + ['P', 'Q', 'R', 'S', 'U'].map((n) => `<Area name="${n}"><Text>wide</Text></Area>`).join('') + '</Row>';
  await writer.submit({ script: totem('A', wide), owner: 'claude' });
  const now = totemsAt();
  assert.ok(Math.abs(now.A - was.A) > 0, 'A is centred over its wider content');
  assert.ok(now.B > was.B, 'B moved right to stay clear of A');
});

test('<Add>, <Edit> and <Remove> are refused on an agent canvas, and a script that does not draw changes nothing', async (t) => {
  const { writer, board } = setup(t);
  await writer.submit({ script: totem('Engine', '<Area name="Ingest"><Text>x</Text></Area>'), owner: 'claude' });
  const before = fs.readFileSync(path.join(board, 'fabric.json'), 'utf8');
  const add = await writer.submit({ script: '<Add canvas="Board" at="Engine (totem) > Ingest"><Text>y</Text></Add>', owner: 'claude' });
  assert.equal(add.status, 'refused');
  assert.match(add.result.message, /send the whole <Totem> script again/);
  const bad = await writer.submit({ script: totem('Engine', '<File path="C:/no/such/file.pdf"/>'), owner: 'claude' });
  assert.equal(bad.status, 'refused');
  assert.match(bad.result.message, /no file at/);
  assert.equal(fs.readFileSync(path.join(board, 'fabric.json'), 'utf8'), before);
});

test('a script that no longer draws is drawn from its last good version, and the others are untouched', async (t) => {
  const { writer, agent, data, places, logs } = setup(t);
  await writer.submit({ script: totem('Engine', '<Area name="Ingest"><Text>x</Text></Area>'), owner: 'claude' });
  await writer.submit({ script: totem('Search', '<Area name="Hybrid"><Text>y</Text></Area>'), owner: 'claude' });
  // Someone edits the Engine script by hand and breaks it.
  fs.writeFileSync(path.join(data, 'agent-canvases', 'Board', scriptFile('Engine')), '<Canvas name="Board"><Totem name="Engine"><Area name="Ingest">');
  const r = await writer.serial(() => agent.render('Board'));
  assert.equal(r.totems.find((x) => x.totem === 'Engine').drawn, 'good');
  assert.match(r.totems.find((x) => x.totem === 'Engine').errors[0], /^current: /);
  assert.equal(r.totems.find((x) => x.totem === 'Search').drawn, 'current');
  assert.ok(places().includes('Engine (totem) > Ingest'));
  assert.ok(places().includes('Search (totem) > Hybrid'));
  assert.ok(logs.some((m) => /Engine drawn from its last good script/.test(m)));
  // With its good copy gone too, it is left out and the rest still draws.
  fs.rmSync(path.join(data, 'agent-canvases', 'Board', 'good', scriptFile('Engine')));
  const r2 = await writer.serial(() => agent.render('Board'));
  assert.equal(r2.totems.find((x) => x.totem === 'Engine').drawn, 'none');
  assert.ok(!places().some((a) => a.startsWith('Engine')));
  assert.ok(places().includes('Search (totem) > Hybrid'));
});

test('drops are placed from bronze: words into a note, a file under the name it was dropped with', async (t) => {
  const { writer, bronze, board, places } = setup(t);
  const words = bronze.land({ text: '- [ ] read the survey\n- [ ] list the gaps', canvas: 'Board' });
  const paper = bronze.land({ bytes: PDF, name: 'Lit survey.pdf', canvas: 'Board' });
  const r = await writer.submit({ script: totem('Reading', `<Area name="Papers"><Note name="Plan" drop="${words.id}"/><File drop="${paper.id}"/></Area>`), owner: 'claude' });
  assert.equal(r.status, 'written', JSON.stringify(r.result));
  const st = readFabric(board).state;
  assert.equal(st.areas.find((a) => a.name === 'Plan').textContent, '- [ ] read the survey\n- [ ] list the gaps');
  assert.equal(st.files[0].name, 'Lit survey.pdf');
  assert.deepEqual(fs.readFileSync(path.join(board, 'sources', 'Lit survey.pdf')), PDF);
  assert.ok(places().includes('Reading (totem) > Papers > Plan (note)'));
  assert.equal(bronze.get(words.id).status, 'placed');
  assert.equal(bronze.get(paper.id).status, 'placed');
  assert.deepEqual(r.result.placed.sort(), [words.id, paper.id].sort());
});

test('a drop is refused on a canvas the user did not choose for it, or in the wrong tag', async (t) => {
  const { writer, bronze } = setup(t);
  const waiting = bronze.land({ text: 'not yet' });
  const typed = bronze.land({ text: 'typed', canvas: 'Board' });
  const paper = bronze.land({ bytes: PDF, name: 'p.pdf', canvas: 'Board' });
  const r1 = await writer.submit({ script: totem('T', `<Note name="N" drop="${waiting.id}"/>`), owner: 'claude' });
  assert.match(r1.result.message, /has not chosen a canvas for it yet/);
  const r2 = await writer.submit({ script: totem('T', `<File drop="${typed.id}"/>`), owner: 'claude' });
  assert.match(r2.result.message, /is typed text - place it with <Note/);
  const r3 = await writer.submit({ script: totem('T', `<Note name="N" drop="${paper.id}"/>`), owner: 'claude' });
  assert.match(r3.result.message, /is a PDF - place it with <File drop=/);
  const r4 = await writer.submit({ script: totem('T', '<Note name="N" drop="d-0000000000"/>'), owner: 'claude' });
  assert.match(r4.result.message, /not in the Inbox/);
  assert.equal(bronze.get(typed.id).status, 'queued', 'nothing refused is marked placed');
});

test('a canvas not assigned to the agent is still written item by item', async (t) => {
  const { writer, ws, data } = setup(t);
  const e = await writer.submit({ script: totem('Mine', '<Area name="Box"><Text>x</Text></Area>', 'Notes'), owner: 'claude' });
  assert.equal(e.status, 'written');
  assert.equal(e.result.totems, undefined);
  assert.equal(fs.existsSync(path.join(data, 'agent-canvases', 'Notes')), false);
  assert.ok(readFabric(path.join(ws, 'Notes')).state.totems.some((x) => x.name === 'Mine'));
});

/* Every totem's items, by the totem NoteX drew them for, and whether
 * CanvasX's own grouping gives each item to that totem. */
async function spacing(board, agent) {
  const { magneticTotems } = await import('../engine/lib/rules.js');
  const st = readFabric(board).state;
  const by = new Map();
  for (const k of ['areas', 'drawings', 'files']) for (const it of st[k] || []) if (it.linkedTotemId) (by.get(it.linkedTotemId) || by.set(it.linkedTotemId, new Set()).get(it.linkedTotemId)).add(it.id);
  for (const t of st.totems) (by.get(t.id) || by.set(t.id, new Set()).get(t.id)).add(t.id);
  const reach = Object.fromEntries(st.totems.map((t) => [t.name, agent.reachOf(st, by.get(t.id))]));
  const wrong = [...magneticTotems(st)].filter(([item, totem]) => item.linkedTotemId && item.linkedTotemId !== totem.id).map(([item]) => item.name || item.id);
  return { reach, wrong };
}

test('totems stay TOTEM_GAP apart and CanvasX\'s grouping gives each only its own, as one grows (t-5c984630aa)', async (t) => {
  const { writer, board, agent } = setup(t);
  const { TOTEM_GAP } = await import('../engine/lib/agentcanvas.js');
  assert.equal(TOTEM_GAP, 1200);
  await writer.submit({ script: totem('A', '<Area name="One"><Text>a</Text></Area>'), owner: 'claude' });
  await writer.submit({ script: totem('B', '<Area name="Two"><Text>b</Text></Area>'), owner: 'claude' });
  for (const n of [2, 4, 6]) {
    const row = '<Row>' + Array.from({ length: n }, (_, i) => `<Area name="Box ${i}"><Text>wide</Text></Area>`).join('') + '</Row>';
    assert.equal((await writer.submit({ script: totem('A', row), owner: 'claude' })).status, 'written');
    const { reach, wrong } = await spacing(board, agent);
    assert.ok(reach.B.minX - reach.A.maxX >= TOTEM_GAP - 1, `A has ${n} boxes: B starts ${Math.round(reach.B.minX - reach.A.maxX)} right of A`);
    assert.deepEqual(wrong, []);
  }
  assert.ok(agent.activity('Board').some((a) => a.what === 'spaced' && a.totems.includes('B')), 'the move is in the activity');
});

test('an empty totem - just its marker - is kept clear too, and a canvas spaced at 800 is re-spaced at its next render', async (t) => {
  const { writer, board, agent, data } = setup(t);
  const { TOTEM_GAP } = await import('../engine/lib/agentcanvas.js');
  await writer.submit({ script: totem('Forza 6', '<Row><Area name="McLaren"><Text>m</Text></Area><Area name="Nissan"><Text>n</Text></Area></Row>'), owner: 'claude' });
  await writer.submit({ script: totem('Screenshots', ''), owner: 'claude' });
  // As TEST NOTEX was: the empty totem pinned only 800 right of Forza 6.
  const file = path.join(data, 'agent-canvases', 'Board', 'layout.json');
  const layout = JSON.parse(fs.readFileSync(file, 'utf8'));
  const forza = (await spacing(board, agent)).reach['Forza 6'];
  layout.totems.find((x) => x.name === 'Screenshots').at = { x: Math.round(forza.maxX + 800), y: 0 };
  fs.writeFileSync(file, JSON.stringify(layout));
  agent.render('Board');
  let s = await spacing(board, agent);
  assert.ok(s.reach.Screenshots.minX - s.reach['Forza 6'].maxX >= TOTEM_GAP - 1, 're-spaced at the next render');
  // Forza 6 gains a third image box: the empty Screenshots moves on, and takes none of it.
  await writer.submit({ script: totem('Forza 6', '<Row><Area name="McLaren"><Text>m</Text></Area><Area name="Nissan"><Text>n</Text></Area><Area name="Ferrari"><Text>f</Text></Area></Row>'), owner: 'claude' });
  s = await spacing(board, agent);
  assert.ok(s.reach.Screenshots.minX - s.reach['Forza 6'].maxX >= TOTEM_GAP - 1);
  assert.deepEqual(s.wrong, []);
});

/* ------------------------------------------------------------ sub-totems */

const BOOK = '<Note name="Intro">What the book is about</Note>'
  + '<SubTotem name="Chapter 1"><Area name="Notes"><Note name="Key idea">first idea</Note></Area></SubTotem>'
  + '<SubTotem name="Chapter 2"><Area name="Notes"><Note name="Key idea">second idea</Note></Area><Text>Read twice.</Text></SubTotem>';

test('<SubTotem> goes straight inside <Totem>, one level, with names of its own (t-64e1acbf09)', () => {
  const p = parseScript(totem('Book', BOOK));
  assert.deepEqual(p.totem.children.map((c) => c.tag), ['Note', 'SubTotem', 'SubTotem']);
  // Boxes are named under their sub-totem, so two chapters may both hold "Notes".
  assert.deepEqual(p.boxes.map((b) => b.path.join(' > ')).filter((x) => x.endsWith('Notes')), ['Chapter 1 > Notes', 'Chapter 2 > Notes']);
  assert.throws(() => parseScript(totem('Book', '<Area name="A"><SubTotem name="X"><Text>x</Text></SubTotem></Area>')), /cannot go inside <Area>|<SubTotem>/);
  assert.throws(() => parseScript(totem('Book', '<SubTotem name="X"><SubTotem name="Y"><Text>y</Text></SubTotem></SubTotem>')), /<SubTotem>/);
  assert.throws(() => parseScript(totem('Book', '<SubTotem name="X"><Text>a</Text></SubTotem><SubTotem name="x"><Text>b</Text></SubTotem>')), /two sub-totems here are both called "x"/);
});

test('a totem with sub-totems is drawn with each sub-totem\'s marker over its own boxes, and CanvasX\'s grouping agrees (t-5f45cfc21a)', async (t) => {
  const { writer, board, places } = setup(t);
  const { magneticTotems } = await import('../engine/lib/rules.js');
  const { readOut } = await import('../engine/lib/readout.js');
  const { dropAddresses } = await import('../engine/lib/agentcanvas.js');
  const e = await writer.submit({ script: totem('Book', BOOK), owner: 'claude' });
  assert.equal(e.status, 'written', JSON.stringify(e.result));
  const fabric = readFabric(board);
  const st = fabric.state;
  const book = st.totems.find((x) => x.name === 'Book');
  const subs = st.totems.filter((x) => x.parentTotemId === book.id).map((x) => x.name);
  assert.deepEqual(subs, ['Chapter 1', 'Chapter 2']);
  const all = places();
  assert.ok(all.includes('Book (totem) > Intro (note)'));
  assert.ok(all.includes('Book (totem) > Chapter 1 (sub-totem) > Notes > Key idea (note)'));
  assert.ok(all.includes('Book (totem) > Chapter 2 (sub-totem) > Notes > Key idea (note)'));
  // CanvasX, grouping by nearness, gives every box to the totem or sub-totem NoteX drew it for.
  const groups = magneticTotems(st);
  const wrong = [...st.areas, ...st.drawings].filter((item) => item.linkedTotemId && (groups.get(item) || {}).id !== item.linkedTotemId).map((item) => item.name || item.id);
  assert.deepEqual(wrong, [], 'every box is claimed, and by its own totem or sub-totem');
  const ch1 = st.totems.find((x) => x.name === 'Chapter 1');
  assert.ok(st.areas.some((a) => a.linkedTotemId === ch1.id && a.name === 'Notes'));
  // notex_read reads it back as written.
  const out = readOut(fabric);
  assert.match(out, /<Totem name="Book"[^>]*>[\s\S]*<SubTotem name="Chapter 1"[\s\S]*<SubTotem name="Chapter 2"/);
  assert.deepEqual(dropAddresses(parseScript(totem('Book', '<SubTotem name="Cars"><Area name="GTR"><File drop="d-0123456789"/></Area></SubTotem>'))), [{ id: 'd-0123456789', address: 'Book (totem) > Cars (sub-totem) > GTR' }]);
});

test('a totem of sub-totems only keeps them clear of its own marker', async (t) => {
  const { writer, board } = setup(t);
  const { magneticTotems } = await import('../engine/lib/rules.js');
  const { SUB_GAP } = await import('../engine/lib/layout.js');
  const cars = '<SubTotem name="Nissan GTR"><Row><Area name="Front"><Text>f</Text></Area><Area name="Back"><Text>b</Text></Area><Area name="Side"><Text>s</Text></Area></Row></SubTotem>'
    + '<SubTotem name="Ferrari 296"><Area name="Track"><Text>t</Text></Area></SubTotem>';
  assert.equal((await writer.submit({ script: totem('Forza 6', cars), owner: 'claude' })).status, 'written');
  const st = readFabric(board).state;
  const top = st.totems.find((x) => !x.parentTotemId);
  for (const s of st.totems.filter((x) => x.parentTotemId)) assert.ok(s.y - top.y >= SUB_GAP, `${s.name} is ${s.y - top.y} below the totem's marker`);
  const groups = magneticTotems(st);
  assert.deepEqual([...st.areas, ...st.drawings].filter((item) => item.linkedTotemId && (groups.get(item) || {}).id !== item.linkedTotemId).map((item) => item.name || item.id), []);
});
