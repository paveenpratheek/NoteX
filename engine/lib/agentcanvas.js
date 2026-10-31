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
import { layoutTotem, Refusal, FREE, move } from './layout.js';
import { visualBox } from './measure.js';
import { bboxDistance } from './geometry.js';
import { FabricError } from './fabric.js';
import { BronzeError } from './bronze.js';

export const isAgentCanvas = (dir) => fs.existsSync(path.join(dir, 'agent.json'));

/* Where a script puts each drop it names, as NoteX addresses places: a
 * note's own address, or the box holding a text or file (t-b404914d8f). */
const LABEL = { Note: ' (note)', ScrollBox: ' (scroll box)' };
export function dropAddresses(parsed) {
  const out = [];
  const visit = (node, labels) => {
    let page = 0;
    for (const c of node.children || []) {
      if (c.tag === 'Page') { visit(c, [...labels, `Page ${++page}`]); continue; }
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
    const box = union(items.map(({ x, kind }) => visualBox(x, kind)));
    let at = entry.at || (box ? { x: box.minX, y: box.minY } : { x: 0, y: 0 });
    const shifted = (p) => (box ? { minX: p.x, minY: p.y, maxX: p.x + box.maxX - box.minX, maxY: p.y + box.maxY - box.minY } : null);
    // A totem that grew pushes the ones after it, never the other way round.
    for (let clash; box && (clash = drawn.find((d) => bboxDistance(d, shifted(at)) < FREE));) at = { x: clash.maxX + FREE, y: at.y };
    if (box) {
      const dx = at.x - box.minX, dy = at.y - box.minY;
      for (const k of ['areas', 'drawings', 'files', 'totems']) for (const it of state[k] || []) if (mine.has(it.id)) move(it, dx, dy);
      for (const b of out.boxes) b.at = at;
      drawn.push(shifted(at));
    }
    return { out, at, drops };
  }

  /* The canvas's content rebuilt from its scripts, on the state the writer
   * hands over; overrides are new scripts for totems, tried as sent - one
   * from notex_write or the placer, or all of an ask's at once
   * (t-b5d4a34951). */
  build(canvas, fabricDir, state, overrides = []) {
    const old = CONTENT.flatMap((k) => (state[k] || []).map((x) => x.id));
    for (const k of CONTENT) state[k] = [];
    const entries = this.layout(canvas).totems.map((t) => ({ ...t }));
    const fresh = new Map(overrides.map((o) => [norm(o.name), o]));
    for (const o of overrides) if (!entries.some((e) => norm(e.name) === norm(o.name))) entries.push({ name: o.name, file: scriptFile(o.name), owner: o.owner, at: null });
    const out = { written: [], touched: new Set(), removed: old, boxes: [], texts: [], copies: [], wires: [], totemId: null, check: null };
    const totems = [], drawn = [], placed = [];
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
      e.at = done.at;
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
    return { out, entries, totems, placed };
  }

  /* Draws the canvas from its scripts, through the writer's safe write
   * (backup, temp file, read-back); with override (one totem) or overrides
   * (several), new scripts kept only if the whole canvas draws with all of
   * them. null when the canvas changed under the write - try again. */
  render(canvas, { override = null, overrides = null } = {}) {
    const fabricDir = this.writer.canvasDir(canvas);
    if (!isAgentCanvas(fabricDir)) throw new Refusal(`${canvas} is not assigned to the agent - the user assigns it in CanvasX.`);
    const tried = overrides || (override ? [override] : []);
    let built = null;
    const result = this.writer.write(fabricDir, canvas, (state) => {
      built = this.build(canvas, fabricDir, state, tried);
      return built.out;
    }, tried.length ? tried[0].owner : null);
    if (result === null) return null;

    const dir = this.dir(canvas);
    fs.mkdirSync(path.join(dir, 'good'), { recursive: true });
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
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
    // A totem left out holds none of its drops on the canvas now.
    const layout = { totems: built.entries.map(({ name, file, owner, at, drops }) => ({ name, file, owner: owner || null, at: at || null, drops: drops || [] })) };
    fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify(layout, null, 2));
    for (const id of new Set(built.placed)) {
      try { if (this.bronze.get(id).status !== 'placed') this.bronze.mark(id, 'placed'); } catch (_) { /* forgotten meanwhile */ }
    }
    const left = built.totems.filter((t) => t.drawn !== 'current' && t.drawn !== 'new');
    if (left.length) this.log(`${canvas}: ${left.map((t) => `${t.totem} drawn from ${t.drawn === 'good' ? 'its last good script' : 'nothing'}`).join('; ')}.`);
    const totemsSaid = built.totems.map(({ totem, drawn, errors }) => ({ totem, drawn, errors }));
    fs.writeFileSync(path.join(dir, 'last-render.json'), JSON.stringify({ at: new Date(this.now()).toISOString(), totems: totemsSaid, placed: [...new Set(built.placed)] }, null, 2));
    this.note(canvas, 'render', { totems: totemsSaid.map((t) => `${t.totem}: ${t.drawn}`), placed: [...new Set(built.placed)] });
    // What is on the canvas now goes on to RAGX (t-7513cdd783).
    if (this.onRendered) this.onRendered(canvas);
    return { ...result.report, totems: built.totems, placed: [...new Set(built.placed)] };
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
