/* Agent canvases: a canvas the user assigned to the agent in CanvasX, which
 * marks it with an agent.json in its folder (t-52f040cf72). There the totem
 * scripts are the true version and the canvas is drawn from them
 * (t-adc937459a):
 *
 *   <data>/agent-canvases/<canvas>/<totem>.<hash>.totem   the script now
 *   <data>/agent-canvases/<canvas>/versions/<totem>.<hash>/<time>.totem
 *   <data>/agent-canvases/<canvas>/good/<totem>.<hash>.totem   last that drew
 *   <data>/agent-canvases/<canvas>/layout.json   order, owners, pinned places
 *   (t-3011840b7e)
 *
 * An agent changes an agent canvas only by sending a whole <Totem> script,
 * which replaces the totem of that name, and only if it draws (t-c42859ce48).
 * Every render rebuilds the canvas's content from all its scripts in order,
 * each totem moved to its pinned place and pushed right only when it would
 * come within 800 px of one drawn before it (t-0b88e8ea91). A script that no
 * longer draws is drawn from its good version, or left out (t-b3ec8c9410).
 * Items get new ids on every render (t-d823364b84).
 *
 * A script names what the user dropped with drop="d-...", and takes it from
 * bronze - only on the canvas the user chose for it (t-2fa309e6c8).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseScript, ScriptError, LIMITS } from './script.js';
import { layoutTotem, Refusal, move } from './layout.js';
import { visualBox } from './measure.js';
import { bboxDistance } from './geometry.js';
import { magneticTotems, FIELD, CHAIN } from './rules.js';
import { FabricError } from './fabric.js';
import { BronzeError } from './bronze.js';
import { replaySteps } from './history.js';

export const isAgentCanvas = (dir) => fs.existsSync(path.join(dir, 'agent.json'));

/* How far apart totems stay on an agent canvas: past CanvasX's grouping
 * reach - 500 round a totem's marker and 300 between items - with 400 to
 * spare, so no two totems' fields touch (t-7cf455550f, t-5c984630aa). */
export const TOTEM_GAP = FIELD + CHAIN + 400;
const SPACING_ROUNDS = 20;

/* Where a script puts each drop it names, as NoteX addresses places: a
 * note's own address, or the box holding a text or file (t-b404914d8f). */
const LABEL = { Note: ' (note)', ScrollBox: ' (scroll box)' };
export function dropAddresses(parsed) {
  const out = [];
  const visit = (node, labels) => {
    let page = 0;
    for (const c of node.children || []) {
      if (c.tag === 'Page') { visit(c, [...labels, `Page ${++page}`]); continue; }
      if (c.tag === 'SubTotem') { visit(c, [...labels, `${c.attrs.name} (sub-totem)`]); continue; }
      const here = ['Area', 'Note', 'ScrollBox'].includes(c.tag) ? [...labels, c.attrs.name + (LABEL[c.tag] || '')] : labels;
      if (c.attrs && c.attrs.drop) out.push({ id: c.attrs.drop, address: (c.tag === 'Note' ? here : labels).join(' > ') });
      visit(c, here);
    }
  };
  visit(parsed.totem, [`${parsed.totem.attrs.name} (totem)`]);
  return out;
}

const CONTENT = ['drawings', 'areas', 'files', 'links', 'totems', 'tables'];
const KIND = { areas: 'area', drawings: 'drawing', files: 'file' };
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const union = (bs) => bs.filter(Boolean).reduce((u, b) => (u ? { minX: Math.min(u.minX, b.minX), minY: Math.min(u.minY, b.minY), maxX: Math.max(u.maxX, b.maxX), maxY: Math.max(u.maxY, b.maxY) } : { ...b }), null);

/* A script with a forgotten drop taken out: the empty tag that names it, and
 * any Line or Link to the note it was (t-985017e732). Attribute values may
 * hold '>' (a wire's path), so tags are matched attribute by attribute. */
const ATTRS = '(?:[^>"]|"[^"]*")*';
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function withoutDrop(text, id) {
  const notes = [];
  const tag = new RegExp(`<(Note|Text|File)\\b(${ATTRS})\\bdrop="${reEsc(id)}"(${ATTRS})(?:/>|>\\s*</\\1\\s*>)`, 'gi');
  let out = text.replace(tag, (m, t, a, b) => {
    const name = /\bname="([^"]*)"/.exec(a + b);
    if (/^note$/i.test(t) && name) notes.push(name[1]);
    return '';
  });
  for (const n of notes) {
    const wire = new RegExp(`<(Line|Link)\\b${ATTRS}\\b(?:from|to)="(?:[^"]*>\\s*)?${reEsc(n)}"${ATTRS}(?:/>|>\\s*</\\1\\s*>)`, 'gi');
    out = out.replace(wire, '');
  }
  return out;
}

/* A totem's file: its name made safe, with a hash so two names that make
 * the same safe name stay apart. */
export function scriptFile(name) {
  const safe = String(name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'totem';
  return `${safe}.${crypto.createHash('sha1').update(norm(name)).digest('hex').slice(0, 8)}.totem`;
}

export class AgentCanvases {
  constructor({ dataDir, writer, bronze, log = () => {}, now = Date.now }) {
    Object.assign(this, { writer, bronze, log, now });
    this.root = path.join(dataDir, 'agent-canvases');
    this.onRendered = null; // told the canvas's name after each render
    this.history = null; // the canvases' history, where the user keeps one (t-732b681a32)
  }

  /* Every drop on the canvas now, with its address. */
  placedDrops(canvas) { return this.layout(canvas).totems.flatMap((t) => t.drops || []); }

  /* ------------------------------------------------------------ activity */

  /* What happened to an agent canvas, one line each, for the Agent
   * canvases view (t-16d16a4f85); the newest 500 are kept. */
  note(canvas, what, detail = {}) {
    const file = path.join(this.dir(canvas), 'activity.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date(this.now()).toISOString(), what, ...detail }) + '\n');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 1000) fs.writeFileSync(file, lines.slice(-500).join('\n') + '\n');
  }

  activity(canvas, n = 50) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(this.dir(canvas), 'activity.jsonl'), 'utf8').split('\n').filter(Boolean); } catch (_) { /* none yet */ }
    return lines.slice(-n).reverse().map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  }

  /* The conversation with the agent about the canvas, from CanvasX's chat
   * or NoteX's page: kept whole, oldest first (t-2ffa1ff1de). */
  say(canvas, turn) {
    const file = path.join(this.dir(canvas), 'chat.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry = { at: new Date(this.now()).toISOString(), ...turn };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    return entry;
  }

  chat(canvas, n = 100) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(this.dir(canvas), 'chat.jsonl'), 'utf8').split('\n').filter(Boolean); } catch (_) { /* none yet */ }
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  }

  lastRender(canvas) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir(canvas), 'last-render.json'), 'utf8')); } catch (_) { return null; }
  }

  /* Each totem's script with what the view shows of it: owner, versions
   * kept, what the last render drew it from, its errors, its drops. */
  totems(canvas) {
    const last = this.lastRender(canvas);
    return this.layout(canvas).totems.map((t) => {
      let versions = 0;
      try { versions = fs.readdirSync(path.join(this.dir(canvas), 'versions', t.file.replace(/\.totem$/, ''))).length; } catch (_) { /* none */ }
      const r = last && last.totems.find((x) => x.totem === t.name);
      return { name: t.name, owner: t.owner || null, script: this.read(canvas, t.file), versions, good: this.read(canvas, t.file, 'good') !== null,
        drawn: r ? r.drawn : null, errors: r ? r.errors : [], drops: (t.drops || []).length };
    });
  }

  /* --------------------------------------------------------- assignment */

  /* The user assigns a canvas to the agent from NoteX, as from CanvasX: only
   * an empty one, and not while CanvasX has it open - it learns of
   * agent.json only when it opens a canvas (t-d798b625e5). */
  assign(canvas, on) {
    const dir = this.writer.canvasDir(canvas);
    const file = path.join(dir, 'fabric.json');
    if (!fs.existsSync(file)) throw new Refusal(`No canvas ${canvas} in the workspace.`);
    if (!on) {
      if (!isAgentCanvas(dir)) return false;
      fs.rmSync(path.join(dir, 'agent.json'));
      this.note(canvas, 'taken back');
      return true;
    }
    if (isAgentCanvas(dir)) return false;
    if (this.writer.isOpen(dir)) throw new Refusal(`${canvas} is open in CanvasX - close it there first, so CanvasX does not keep saving it.`);
    let empty = false;
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      const d = s.data ? s.data : s;
      empty = ['drawings', 'areas', 'files', 'links', 'totems', 'tables', 'sidebarWidgets'].every((k) => !(d[k] && d[k].length));
    } catch (_) { /* unreadable is not known to be empty */ }
    if (!empty) throw new Refusal(`${canvas} already holds items, so it cannot be assigned to the agent: NoteX would draw over them from the agent's scripts. Create a new canvas in CanvasX for the agent instead.`);
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ assignedAt: new Date(this.now()).toISOString(), by: 'NoteX' }, null, 2));
    this.note(canvas, 'assigned');
    return true;
  }

  /* A new canvas the user's message asked the agent for: an empty canvas
   * marked for the agent from the start, so it never held anything of the
   * user's (t-8c4e28b7b4, t-52f040cf72). */
  create(canvas, detail = {}) {
    const dir = this.writer.canvasDir(canvas);
    if (fs.existsSync(dir)) throw new Refusal(`${canvas} is already in the workspace.`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fabric.json'), JSON.stringify({ areas: [], drawings: [], files: [], links: [], totems: [] }));
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ assignedAt: new Date(this.now()).toISOString(), by: 'NoteX placer' }, null, 2));
    this.note(canvas, 'created', detail);
    return dir;
  }

  /* A forgotten drop out of every script that names it, now and its good
   * copy; earlier versions keep only its id and stay as they are
   * (t-983bfb918b). The totems changed, by name. */
  removeDrop(canvas, id) {
    const changed = [];
    for (const t of this.layout(canvas).totems) {
      for (const which of ['current', 'good']) {
        const text = this.read(canvas, t.file, which);
        if (text == null || !text.includes(`drop="${id}"`)) continue;
        fs.writeFileSync(path.join(this.dir(canvas), which === 'good' ? 'good' : '', t.file), withoutDrop(text, id));
        if (!changed.includes(t.name)) changed.push(t.name);
      }
    }
    return changed;
  }

  dir(canvas) { return path.join(this.root, canvas); }

  layout(canvas) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir(canvas), 'layout.json'), 'utf8')); } catch (_) { return { totems: [] }; }
  }

  read(canvas, file, which = 'current') {
    try { return fs.readFileSync(path.join(this.dir(canvas), which === 'good' ? 'good' : '', file), 'utf8'); } catch (_) { return null; }
  }

  /* Every totem's script file now, as the history keeps it. */
  snapshot(canvas) {
    return this.layout(canvas).totems.map((t) => ({ name: t.name, file: t.file, owner: t.owner || null, script: this.read(canvas, t.file) }));
  }

  /* What the canvas was at each write NoteX kept before its history was
   * switched on, oldest first (t-9dbb490caa). */
  replay(canvas) {
    let activity = [];
    try { activity = fs.readFileSync(path.join(this.dir(canvas), 'activity.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { /* none */ }
    let assignedAt = null;
    try { assignedAt = JSON.parse(fs.readFileSync(path.join(this.writer.canvasDir(canvas), 'agent.json'), 'utf8')).assignedAt || null; } catch (_) { /* not known */ }
    const first = activity.find((a) => a.what === 'assigned' || a.what === 'created');
    return replaySteps({ dir: this.dir(canvas), layout: this.layout(canvas).totems, activity, assignedAt: assignedAt || (first && first.at) || null });
  }

  /* Every totem's script now, in the order they are drawn. */
  scripts(canvas) {
    return this.layout(canvas).totems.map((t) => ({ name: t.name, owner: t.owner || null, script: this.read(canvas, t.file) }));
  }

  /* --------------------------------------------------------------- drops */

  /* What drop="d-..." names, taken from bronze: words for a <Note> or
   * <Text>, a file under the name it was dropped with for a <File>. */
  resolveDrops(parsed, canvas) {
    const used = [];
    const visit = (node) => {
      const id = node.attrs && node.attrs.drop;
      if (id) {
        let d;
        try { d = this.bronze.get(id); } catch (e) {
          if (e instanceof BronzeError) throw new Refusal(`drop ${id} is not in the Inbox - it may have been forgotten.`, node);
          throw e;
        }
        if (d.canvas !== canvas) throw new Refusal(`drop ${id} is not for ${canvas}: ${d.canvas ? `the user chose ${d.canvas} for it` : 'the user has not chosen a canvas for it yet'}.`, node);
        const file = this.bronze.file(id);
        if (node.tag === 'File') {
          if (d.kind === 'text') throw new Refusal(`drop ${id} is typed text - place it with <Note name="..." drop="${id}"/> or <Text drop="${id}"/>.`, node);
          node.attrs.path = file;
          node.as = d.name;
        } else {
          if (d.kind !== 'text' && d.kind !== 'md') throw new Refusal(`drop ${id} is ${d.kind === 'image' ? 'an image' : `a ${d.kind === 'docx' ? 'Word file' : 'PDF'}`} - place it with <File drop="${id}"/>.`, node);
          node.text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').trim();
          if (node.text.length > LIMITS.text) throw new Refusal(`drop ${id} is longer than ${LIMITS.text} characters - place it with <File drop="${id}"/>${d.kind === 'text' ? ' after dropping it as a .md file' : ''}.`, node);
        }
        used.push(id);
      }
      for (const c of node.children || []) visit(c);
    };
    visit(parsed.totem);
    return used;
  }

  /* -------------------------------------------------------------- render */

  /* What CanvasX groups a totem by: its items' boxes and its marker, a
   * point. An empty totem is its marker alone. */
  reachOf(state, mine) {
    const items = Object.entries(KIND).flatMap(([k, kind]) => (state[k] || []).filter((x) => mine.has(x.id)).map((x) => visualBox(x, kind)));
    const marker = (state.totems || []).find((x) => mine.has(x.id));
    return union([...items, marker ? { minX: marker.x, minY: marker.y, maxX: marker.x, maxY: marker.y } : null]);
  }

  /* One totem drawn onto the state: laid out where NoteX puts a new totem,
   * then moved to its pin, clear of the totems drawn before it. */
  drawOne(canvas, fabricDir, state, text, entry, drawn) {
    const parsed = parseScript(text);
    if (parsed.kind !== 'totem') throw new Refusal(`${canvas} is an agent canvas, drawn from whole totem scripts.`);
    if (norm(parsed.canvas) !== norm(canvas)) throw new Refusal(`the script is for ${parsed.canvas}, not ${canvas}.`, parsed.totem);
    if (norm(parsed.totem.attrs.name) !== norm(entry.name)) throw new Refusal(`the script's totem is "${parsed.totem.attrs.name}", but it is kept as "${entry.name}".`, parsed.totem);
    const drops = this.resolveDrops(parsed, canvas);
    const out = layoutTotem(parsed, state, { owner: entry.owner || 'agent', fabricDir });
    const mine = new Set(out.written);
    const items = Object.entries(KIND).flatMap(([k, kind]) => (state[k] || []).filter((x) => mine.has(x.id)).map((x) => ({ x, kind })));
    // The pin is the corner of the totem's items; an empty totem, until now
    // never measured and so never kept clear, is pinned by its marker.
    const reach = this.reachOf(state, mine);
    const box = union(items.map(({ x, kind }) => visualBox(x, kind))) || reach;
    let at = entry.at || (box ? { x: box.minX, y: box.minY } : { x: 0, y: 0 });
    const shifted = (p) => (reach ? { minX: reach.minX + p.x - box.minX, minY: reach.minY + p.y - box.minY, maxX: reach.maxX + p.x - box.minX, maxY: reach.maxY + p.y - box.minY } : null);
    // A totem that grew pushes the ones after it, never the other way round,
    // until its items and marker are TOTEM_GAP clear of every earlier one.
    for (let clash; reach && (clash = drawn.find((d) => bboxDistance(d, shifted(at)) < TOTEM_GAP));) at = { x: clash.maxX + TOTEM_GAP + box.minX - reach.minX, y: at.y };
    if (box) {
      const dx = at.x - box.minX, dy = at.y - box.minY;
      for (const k of ['areas', 'drawings', 'files', 'totems']) for (const it of state[k] || []) if (mine.has(it.id)) move(it, dx, dy);
      for (const b of out.boxes) b.at = at;
      drawn.push(shifted(at));
    }
    return { out, at, drops, mine };
  }

  /* The canvas's content rebuilt from its scripts, on the state the writer
   * hands over; overrides are new scripts for totems, tried as sent - one
   * from notex_write or the placer, or all of an ask's at once
   * (t-b5d4a34951). */
  build(canvas, fabricDir, state, overrides = [], remove = []) {
    const old = CONTENT.flatMap((k) => (state[k] || []).map((x) => x.id));
    for (const k of CONTENT) state[k] = [];
    // A totem the agent deleted, as the user asked (t-44045fd69e), is not drawn again.
    const gone = new Set(remove.map(norm));
    const all = this.layout(canvas).totems.map((t) => ({ ...t }));
    const entries = all.filter((t) => !gone.has(norm(t.name)));
    const deleted = all.filter((t) => gone.has(norm(t.name)));
    const fresh = new Map(overrides.map((o) => [norm(o.name), o]));
    for (const o of overrides) if (!entries.some((e) => norm(e.name) === norm(o.name))) entries.push({ name: o.name, file: scriptFile(o.name), owner: o.owner, at: null });
    const out = { written: [], touched: new Set(), removed: old, boxes: [], texts: [], copies: [], wires: [], totemId: null, check: null };
    const totems = [], drawn = [], placed = [], pushed = [];
    for (const e of entries) {
      const override = fresh.get(norm(e.name));
      const isNew = Boolean(override);
      if (isNew) e.owner = override.owner;
      const tries = isNew ? [['new', override.script]] : [['current', this.read(canvas, e.file)], ['good', this.read(canvas, e.file, 'good')]];
      const errors = [];
      let done = null;
      for (const [which, text] of tries) {
        if (text == null) { errors.push(`${which}: no script`); continue; }
        const before = JSON.stringify(Object.fromEntries(CONTENT.map((k) => [k, state[k]])));
        try {
          done = { which, text, ...this.drawOne(canvas, fabricDir, state, text, e, drawn) };
          break;
        } catch (err) {
          if (!(err instanceof ScriptError || err instanceof Refusal)) throw err;
          // A totem that failed leaves nothing half-drawn.
          Object.assign(state, JSON.parse(before));
          if (isNew) throw err;
          errors.push(`${which}: ${err.message}`);
        }
      }
      if (!done) { totems.push({ totem: e.name, drawn: 'none', errors }); continue; }
      if (e.at && done.at.x !== e.at.x) pushed.push(e.name);
      e.at = done.at;
      e.mine = done.mine;
      e.drawnFrom = done.which;
      e.text = done.text;
      e.drops = dropAddresses(parseScript(done.text));
      out.written.push(...done.out.written);
      out.boxes.push(...done.out.boxes);
      out.texts.push(...done.out.texts);
      out.copies.push(...done.out.copies);
      placed.push(...done.drops);
      totems.push({ totem: e.name, drawn: done.which, errors });
    }
    const spaced = [...new Set([...pushed, ...this.spaceOut(entries, state)])];
    return { out, entries, totems, placed, spaced, deleted };
  }

  /* The drawn canvas grouped the way CanvasX groups it (magneticTotems): a
   * totem whose items another totem's marker or items would take is moved
   * right, the later of the two, TOTEM_GAP clear, until every totem holds
   * only its own. Run at every render, so every change is checked
   * (t-5c984630aa). The names of the totems moved. */
  spaceOut(entries, state) {
    const moved = new Set();
    for (let round = 0; round < SPACING_ROUNDS; round++) {
      const owner = new Map();
      entries.forEach((e, i) => { for (const id of e.mine || []) owner.set(id, i); });
      let pair = null;
      for (const [item, totem] of magneticTotems(state)) {
        const a = owner.get(item.id), b = owner.get(totem.id);
        if (a !== undefined && b !== undefined && a !== b) { pair = [Math.min(a, b), Math.max(a, b)]; break; }
      }
      if (!pair) break;
      const [first, later] = pair.map((i) => entries[i]);
      const a = this.reachOf(state, first.mine), b = this.reachOf(state, later.mine);
      const dx = Math.max(a.maxX + TOTEM_GAP - b.minX, TOTEM_GAP);
      for (const k of ['areas', 'drawings', 'files', 'totems']) for (const it of state[k] || []) if (later.mine.has(it.id)) move(it, dx, 0);
      later.at = { x: later.at.x + dx, y: later.at.y };
      moved.add(later.name);
    }
    return [...moved];
  }

  /* Draws the canvas from its scripts, through the writer's safe write
   * (backup, temp file, read-back); with override (one totem) or overrides
   * (several), new scripts kept only if the whole canvas draws with all of
   * them. null when the canvas changed under the write - try again. */
  render(canvas, { override = null, overrides = null, remove = [] } = {}) {
    const fabricDir = this.writer.canvasDir(canvas);
    if (!isAgentCanvas(fabricDir)) throw new Refusal(`${canvas} is not assigned to the agent - the user assigns it in CanvasX.`);
    const tried = overrides || (override ? [override] : []);
    let built = null;
    const result = this.writer.write(fabricDir, canvas, (state) => {
      built = this.build(canvas, fabricDir, state, tried, remove);
      return built.out;
    }, tried.length ? tried[0].owner : (remove.length ? 'NoteX agent' : null));
    if (result === null) return null;

    const dir = this.dir(canvas);
    fs.mkdirSync(path.join(dir, 'good'), { recursive: true });
    const when = this.now();
    const stamp = new Date(when).toISOString().replace(/[:.]/g, '-');
    for (const e of built.entries) {
      if (e.drawnFrom === 'new') {
        // The script it replaces is kept among the versions before the new one takes its place.
        const was = this.read(canvas, e.file);
        if (was != null && was !== e.text) {
          const vdir = path.join(dir, 'versions', e.file.replace(/\.totem$/, ''));
          fs.mkdirSync(vdir, { recursive: true });
          fs.writeFileSync(path.join(vdir, `${stamp}.totem`), was);
        }
        fs.writeFileSync(path.join(dir, e.file), e.text);
      }
      if (e.drawnFrom === 'new' || e.drawnFrom === 'current') fs.writeFileSync(path.join(dir, 'good', e.file), e.text);
    }
    // A deleted totem's script is kept among its versions, then goes (t-dbfe16a2b9).
    for (const e of built.deleted) {
      const was = this.read(canvas, e.file) ?? this.read(canvas, e.file, 'good');
      if (was != null) {
        const vdir = path.join(dir, 'versions', e.file.replace(/\.totem$/, ''));
        fs.mkdirSync(vdir, { recursive: true });
        fs.writeFileSync(path.join(vdir, `${stamp}-deleted.totem`), was);
      }
      for (const f of [path.join(dir, e.file), path.join(dir, 'good', e.file)]) fs.rmSync(f, { force: true });
    }
    // A totem left out holds none of its drops on the canvas now.
    const layout = { totems: built.entries.map(({ name, file, owner, at, drops }) => ({ name, file, owner: owner || null, at: at || null, drops: drops || [] })) };
    fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify(layout, null, 2));
    /* Kept in the canvas's history, once its scripts are all written: one
     * commit per write that changed them, by whoever wrote. A failing commit
     * is said, never a failed write (t-b3d20f5afa, t-6281cf4449). */
    if (this.history && this.history.on(canvas)) {
      const who = [...new Set(tried.map((o) => o.owner).filter(Boolean))].join(', ') || (remove.length ? 'NoteX agent' : 'NoteX');
      try { this.history.commit(canvas, this.snapshot(canvas), { who, at: when }); } catch (e) { this.log(`Keeping ${canvas}'s history failed: ${e.message}`); }
    }
    for (const id of new Set(built.placed)) {
      try { if (this.bronze.get(id).status !== 'placed') this.bronze.mark(id, 'placed'); } catch (_) { /* forgotten meanwhile */ }
    }
    const left = built.totems.filter((t) => t.drawn !== 'current' && t.drawn !== 'new');
    if (left.length) this.log(`${canvas}: ${left.map((t) => `${t.totem} drawn from ${t.drawn === 'good' ? 'its last good script' : 'nothing'}`).join('; ')}.`);
    const totemsSaid = built.totems.map(({ totem, drawn, errors }) => ({ totem, drawn, errors }));
    fs.writeFileSync(path.join(dir, 'last-render.json'), JSON.stringify({ at: new Date(this.now()).toISOString(), totems: totemsSaid, placed: [...new Set(built.placed)] }, null, 2));
    this.note(canvas, 'render', { totems: totemsSaid.map((t) => `${t.totem}: ${t.drawn}`), placed: [...new Set(built.placed)] });
    if (built.spaced.length) {
      this.note(canvas, 'spaced', { totems: built.spaced });
      this.log(`${canvas}: moved ${built.spaced.join(', ')} clear of the totems beside ${built.spaced.length === 1 ? 'it' : 'them'}.`);
    }
    // What is on the canvas now goes on to RAGX (t-7513cdd783).
    if (this.onRendered) this.onRendered(canvas);
    return { ...result.report, totems: built.totems, placed: [...new Set(built.placed)], spaced: built.spaced };
  }

  /* A script the writer queued for an agent canvas. true when finished. */
  apply(entry) {
    // Every script that reaches an agent canvas is in its activity, kept or not (t-16d16a4f85).
    const finish = (status, result) => {
      this.note(entry.canvas, 'script', { status, owner: entry.owner, change: entry.what, message: status === 'written' ? null : result.message || null });
      return this.writer.finish(entry, status, result);
    };
    const parsed = parseScript(entry.script);
    if (parsed.kind !== 'totem') {
      const tag = parsed.kind === 'add' ? '<Add>' : '<Edit> and <Remove>';
      return finish('refused', { message: `${entry.canvas} is an agent canvas, drawn from whole totem scripts - ${tag} cannot change it. Read the totem's script, change it, and send the whole <Totem> script again; it replaces the old one.` });
    }
    try {
      const r = this.render(entry.canvas, { override: { name: parsed.totem.attrs.name, script: entry.script, owner: entry.owner } });
      if (r === null) return false;
      return finish('written', r);
    } catch (e) {
      if (e instanceof Refusal || e instanceof ScriptError) return finish('refused', { message: e.message, line: e.line || null });
      if (e instanceof FabricError && e.code === 'bad-json') return false;
      this.log(`Drawing ${entry.canvas} for ${entry.owner} failed: ${e.stack || e.message}`);
      return finish('failed', { message: e.message });
    }
  }
}
