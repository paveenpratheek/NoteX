/* Phone sync: the workspace and CanvasXP's folder on the user's phone, kept
 * the same over the USB cable in File transfer mode (t-71306596ff,
 * t-76fdccd60b; CanvasXP's side is CanvasX t-3d7b88b6a1).
 *
 * CanvasXP keeps, in _canvasxp/ inside its target folder on the phone:
 *   device.json    written by its Setup: the phone's id and name;
 *   manifest.json  every file of every canvas with its SHA-256, refreshed
 *                  after each save, and the batches it has taken in;
 *   incoming/<id>/ what NoteX sends: files/<canvas>/<path>, chats/<canvas>.json
 *                  (an agent canvas's conversation) and, copied last,
 *                  changes.json saying what to write and delete;
 *   status/        NoteX's steps while it syncs, a new file at each, which
 *                  CanvasXP shows the user (t-2ff7b152e9).
 * and, where the user can read them, Queued messages/<canvas> - <date time>/:
 * a message written to the agent in CanvasXP's chat while away from the PC -
 * its attachments and, written last, message.md with the canvas, a
 * Description and a Prompt (CanvasX t-0b4e61bf2b). NoteX answers them at the
 * sync (t-e4196083e7).
 * NoteX never replaces or deletes anything on the phone - over File transfer
 * Windows asks before either - so it only adds batch folders, and CanvasXP,
 * which has full access to its folder, applies them once every hash checks.
 *
 * A sync compares, canvas by canvas, the PC's files, the phone's files (its
 * manifest, with batches sent but not yet taken in laid over it) and base:
 * the hashes both sides had when they last agreed. Hashes, not dates, so the
 * two clocks never matter.
 *
 * <data>/phone/state.json keeps base, the batches not yet taken in, and the
 * PC's files' hashes by size and modified time, so an unchanged image is not
 * read again. <data>/phone/backups/ keeps what a sync took off the PC.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const XP_DIR = '_canvasxp';
const LOCK = '.fabric_lock';
const HEARTBEAT_MS = 20_000; // a status at least this often while the agent works
const KEEP_HANDLED = 500; // ids of messages answered, so none is answered twice
const CANVAS_OPS = new Set(['copy', 'put', 'del', 'drop']);
export const QUEUE_DIR = 'Queued messages';

/* A queued message's message.md, as CanvasXP writes it: headings the user
 * can read - ## Description, ## Prompt, ## Attachments - and a closing
 * comment with its id, canvas, model and each attachment's hash. The words
 * are read from the headings, so an edit to them before the sync counts;
 * "(none)" is an empty field. Null when it is not one. */
export function parseQueued(md) {
  const m = /<!--\s*CanvasXP\s+(\{[\s\S]*?\})\s*-->/.exec(String(md || ''));
  if (!m) return null;
  let meta;
  try { meta = JSON.parse(m[1]); } catch (_) { return null; }
  const body = String(md).slice(0, m.index);
  const section = (name) => {
    const s = new RegExp(`^##\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'm').exec(body);
    const text = s ? s[1].trim() : '';
    return text === '(none)' ? '' : text;
  };
  return { meta, description: section('Description'), prompt: section('Prompt') };
}

/* What the agent is asked: the prompt, and what the user said the attachments are. */
export function queuedAsk({ prompt, description }) {
  return [prompt, description && `About what I attached: ${description}`].filter(Boolean).join('\n\n');
}

export class PhoneError extends Error {
  constructor(code, message) { super(message); this.name = 'PhoneError'; this.code = code; }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* A canvas name or a path segment that may come from the phone: nothing that
 * climbs out of the workspace, and nothing Windows cannot name. */
const BAD_SEG = /[\\/:*?"<>|\x00-\x1f]/;
export function safeSegment(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 200 && s !== '.' && s !== '..' && !BAD_SEG.test(s) && !/[. ]$/.test(s);
}
export function safeCanvas(name) { return safeSegment(name) && !name.startsWith('.') && name !== XP_DIR; }
// Chrome writes through a .crswap file beside the real one; it is never a canvas's own.
export function safeRel(rel) { return typeof rel === 'string' && rel.split('/').every(safeSegment) && rel.split('/').pop() !== LOCK && !rel.endsWith('.crswap'); }

/* --------------------------------------------------------- the PC's side */

/* Every canvas in the workspace - a folder holding fabric.json - with each
 * file's hash. cache keeps hashes by path, size and modified time. */
export function scanPc(workspace, cache = {}, isOpen = () => false) {
  const canvases = {};
  let entries = [];
  try { entries = fs.readdirSync(workspace, { withFileTypes: true }); } catch (e) {
    throw new PhoneError('no-workspace', `Cannot read the workspace ${workspace}: ${e.code || e.message}`);
  }
  const seen = new Set();
  for (const e of entries) {
    if (!e.isDirectory() || !safeCanvas(e.name)) continue;
    const dir = path.join(workspace, e.name);
    if (!fs.existsSync(path.join(dir, 'fabric.json'))) continue;
    const files = {};
    const walk = (d, prefix) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${f.name}` : f.name;
        if (f.isDirectory()) { if (safeSegment(f.name)) walk(path.join(d, f.name), rel); continue; }
        if (!f.isFile() || !safeRel(rel)) continue;
        const full = path.join(d, f.name);
        const st = fs.statSync(full);
        const key = `${e.name}/${rel}`;
        seen.add(key);
        const c = cache[key];
        if (c && c.size === st.size && c.mtime === st.mtimeMs) { files[rel] = c.sha; continue; }
        const sha = sha256(fs.readFileSync(full));
        cache[key] = { size: st.size, mtime: st.mtimeMs, sha };
        files[rel] = sha;
      }
    };
    walk(dir, '');
    canvases[e.name] = { files, agent: fs.existsSync(path.join(dir, 'agent.json')), open: isOpen(dir) };
  }
  for (const k of Object.keys(cache)) if (!seen.has(k)) delete cache[k];
  return canvases;
}

/* ------------------------------------------------------ the phone's side */

/* The phone's canvases from its manifest, unsafe names left out. */
export function phoneCanvases(manifest) {
  const out = {};
  const skipped = [];
  for (const [name, c] of Object.entries((manifest && manifest.canvases) || {})) {
    if (!safeCanvas(name) || !c || typeof c.files !== 'object') { skipped.push(name); continue; }
    const files = {};
    for (const [rel, f] of Object.entries(c.files)) {
      if (safeRel(rel) && f && /^[0-9a-f]{64}$/.test(f.sha)) files[rel] = f.sha; else skipped.push(`${name}/${rel}`);
    }
    out[name] = files;
  }
  return { canvases: out, skipped };
}

/* What the phone will hold once it takes in the batches still waiting. */
export function overlay(canvases, batches) {
  const out = Object.fromEntries(Object.entries(canvases).map(([n, f]) => [n, { ...f }]));
  for (const b of batches) {
    for (const op of b.ops) {
      if (op.op === 'copy' && out[op.canvas]) out[op.to] = { ...out[op.canvas] };
      else if (op.op === 'put') (out[op.canvas] ||= {})[op.path] = op.sha;
      else if (op.op === 'del' && out[op.canvas]) delete out[op.canvas][op.path];
      else if (op.op === 'drop') delete out[op.canvas];
    }
  }
  return out;
}

/* ------------------------------------------------------------- deciding */

const same = (a, b) => {
  if (!a || !b) return !a && !b;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/* What to do with one canvas: P the PC's files, F the phone's, B base -
 * each undefined where that side has no such canvas. */
export function decide({ P, F, B, agent = false, open = false }) {
  const pcChanged = !same(P, B);
  const phoneChanged = !same(F, B);
  if (!pcChanged && !phoneChanged) return 'none';
  if (same(P, F)) return 'agree';
  if (open) return 'open';
  if (agent && P) return 'push'; // drawn on the PC from its scripts, view-only on the phone
  if (!phoneChanged) return P ? 'push' : 'drop-phone';
  if (!pcChanged) return F ? 'pull' : 'drop-pc';
  if (!P) return 'pull'; // deleted on the PC, changed on the phone: the phone's comes back
  if (!F) return 'push';
  return 'conflict';
}

export function uniqueName(base, taken) {
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base} (phone)` : `${base} (phone ${i})`;
    if (!taken.has(name)) return name;
  }
}

/* -------------------------------------------------------------- the sync */

export class PhoneSync {
  /* transport talks to the phone (mtp.js); isOpen(dir) says whether CanvasX
   * has a canvas open on the PC; keep(name) keeps a canvas in RAGX;
   * ask({canvas, text, model, files}) answers a message queued in CanvasXP's
   * chat and resolves once the agent has (t-e4196083e7); chat(name) is an
   * agent canvas's conversation, for CanvasXP to show. */
  constructor({ config, saveConfig, dataDir, transport, isOpen = () => false, keep = () => {}, ask = null, chat = null, log = () => {}, now = Date.now, hostname = os.hostname(), heartbeatMs = HEARTBEAT_MS }) {
    Object.assign(this, { config, saveConfig, transport, isOpen, keep, ask, chat, log, now, hostname, heartbeatMs });
    this.dir = path.join(dataDir, 'phone');
    this.stateFile = path.join(this.dir, 'state.json');
    this.running = null;
    this.last = null;
    this.statusing = null;
    this.data = this.load();
  }

  fresh(cache = {}) { return { id: null, base: {}, batches: [], cache, handled: [], chatSent: {} }; }

  load() {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (_) { /* first sync */ }
    return { ...this.fresh(), ...d };
  }
  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.stateFile);
  }

  report() {
    return { setup: this.config.phone || null, running: Boolean(this.running), progress: this.progress || null, last: this.last, waiting: this.data.batches.length };
  }

  devices() { return this.transport.devices(); }

  tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'notex-phone-')); }

  /* A small file from the phone, read through a fresh temporary folder. */
  async readJson(device, segs, name) {
    const t = this.tmp();
    try {
      await this.transport.pull(device, segs, [name], t);
      return JSON.parse(fs.readFileSync(path.join(t, name), 'utf8'));
    } catch (_) { return null; } finally { fs.rmSync(t, { recursive: true, force: true }); }
  }

  /* One folder on the phone: its folders, and whether it is CanvasXP's. */
  async browse(device, segs = []) {
    const items = await this.transport.list(device, segs);
    const folders = items.filter((i) => i.folder && i.name !== XP_DIR).map((i) => i.name).sort((a, b) => a.localeCompare(b));
    let canvasxp = null;
    if (items.some((i) => i.folder && i.name === XP_DIR)) {
      const d = await this.readJson(device, [...segs, XP_DIR], 'device.json');
      if (d && d.id) canvasxp = { id: d.id, name: d.name || 'Phone' };
    }
    return { device, path: segs, folders, canvasxp };
  }

  /* The phone's folder, chosen in NoteX after CanvasXP's own Setup. */
  async setup(device, segs) {
    if (!Array.isArray(segs) || !segs.every((s) => typeof s === 'string' && s)) throw new PhoneError('bad-path', 'Give the folder on the phone as a list of folder names.');
    const d = await this.readJson(device, [...segs, XP_DIR], 'device.json');
    if (!d || !d.id) throw new PhoneError('not-canvasxp', 'That folder is not set up by CanvasXP - open CanvasXP on the phone, pick this folder and press Set up USB sync there first.');
    if (this.data.id !== d.id) this.data = { ...this.fresh(this.data.cache || {}), id: d.id };
    this.config.phone = { device, path: segs, id: d.id, name: d.name || 'Phone', setAt: new Date(this.now()).toISOString() };
    this.saveConfig();
    this.save();
    return this.config.phone;
  }

  forget() {
    delete this.config.phone;
    this.saveConfig();
    this.data = this.fresh(this.data.cache || {});
    this.save();
    this.last = null;
  }

  sync() {
    if (this.running) return this.running;
    this.running = this.run()
      .then((r) => { this.last = r; return r; }, (e) => { this.last = { ok: false, at: new Date(this.now()).toISOString(), error: e.message, code: e.code || null }; return this.last; })
      .finally(() => { this.running = null; this.progress = null; });
    return this.running;
  }

  /* A status file for CanvasXP, which shows the user what the sync is doing
   * (t-2ff7b152e9): a new file at every step, never one rewritten, since
   * Windows asks before replacing a file on the phone (t-87e7049e0f). With
   * no fields it repeats the last step - the heartbeat while the agent
   * works. A status that cannot be written never stops the sync. */
  status(fields = null) {
    const s = this.statusing;
    if (!s) return Promise.resolve();
    if (fields) s.fields = fields;
    const seq = ++s.seq;
    const body = { sync: s.id, seq, at: new Date(this.now()).toISOString(), from: this.hostname, ...s.fields };
    s.chain = s.chain.then(async () => {
      const t = this.tmp();
      try {
        const f = path.join(t, `${s.id}-${String(seq).padStart(5, '0')}.json`);
        fs.writeFileSync(f, JSON.stringify(body));
        await this.transport.push(s.device, f, [...s.xp, 'status']);
      } catch (e) { this.log(`Could not tell the phone how the sync goes: ${e.message}`); } finally { fs.rmSync(t, { recursive: true, force: true }); }
    });
    return s.chain;
  }

  async run() {
    const phone = this.config.phone;
    if (!phone) throw new PhoneError('no-phone', 'Set up the phone first.');
    const ws = this.config.workspace;
    if (!ws) throw new PhoneError('no-workspace', 'Say which folder is the workspace first.');
    const { device } = phone;
    const root = phone.path;
    const xp = [...root, XP_DIR];
    this.progress = 'Looking for the phone';
    const devices = await this.transport.devices();
    if (!devices.some((d) => d.name === device)) throw new PhoneError('no-device', `${phone.name} (${device}) is not attached - plug it in and pick File transfer on the phone.`);

    this.progress = 'Reading what the phone has';
    const dev = await this.readJson(device, xp, 'device.json');
    if (!dev || dev.id !== phone.id) throw new PhoneError('not-canvasxp', `The folder ${root.join(' > ')} on the phone is not the CanvasXP folder NoteX was set up with - set the phone up again.`);
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const top = await this.transport.list(device, xp);
    for (const f of ['incoming', 'status']) if (!top.some((i) => i.folder && i.name === f)) await this.transport.mkdir(device, xp, f);
    this.statusing = { id: `s-${stamp}`, seq: 0, device, xp, chain: Promise.resolve(), fields: null };
    this.status({ stage: 'reading', text: 'NoteX is reading your canvases' });
    try {
      const result = await this.exchange({ device, root, xp, ws, stamp, top });
      await this.status({ stage: 'done', text: summaryOf(result), batch: result.batch });
      return result;
    } catch (e) {
      await this.status({ stage: 'failed', text: e.message });
      throw e;
    } finally { this.statusing = null; }
  }

  async exchange({ device, root, xp, ws, stamp, top }) {
    const manifest = await this.readJson(device, xp, 'manifest.json');
    if (!manifest) throw new PhoneError('no-manifest', 'CanvasXP has not listed its canvases yet - open CanvasXP on the phone once, then sync again.');
    const { canvases: listed, skipped } = phoneCanvases(manifest);

    // Batches the phone has taken in are done; one gone without being taken in is sent again.
    const applied = new Set(Array.isArray(manifest.applied) ? manifest.applied : []);
    let present = new Set();
    try { present = new Set((await this.transport.list(device, [...xp, 'incoming'])).filter((i) => i.folder).map((i) => i.name)); } catch (_) { /* no incoming folder yet */ }
    const lost = [];
    this.data.batches = this.data.batches.filter((b) => {
      if (applied.has(b.id)) return false;
      if (present.has(b.id)) return true;
      lost.push(b);
      return false;
    });
    for (const b of lost) for (const op of b.ops) {
      if (op.op === 'chat') { delete this.data.chatSent[op.canvas]; continue; }
      if (!CANVAS_OPS.has(op.op)) continue;
      for (const c of [op.canvas, op.to].filter(Boolean)) { if (listed[c]) this.data.base[c] = { ...listed[c] }; else delete this.data.base[c]; }
    }
    const F = overlay(listed, this.data.batches);
    const result = { ok: true, at: null, pulled: [], pushed: [], conflicts: [], removed: [], open: [], stale: [], skipped, answered: [], unanswered: [] };
    const ops = [];

    // Messages queued in CanvasXP's chat go to the agent first, so what it changes goes back in this batch.
    const queue = await this.readQueue(device, root);
    await this.answer(device, root, queue, result, ops);

    this.progress = 'Reading the workspace';
    this.status({ stage: 'reading', text: 'NoteX is comparing the canvases' });
    const pc = scanPc(ws, this.data.cache, this.isOpen);
    const base = this.data.base;
    const names = new Set([...Object.keys(pc), ...Object.keys(F), ...Object.keys(base)]);
    const taken = new Set([...Object.keys(pc), ...Object.keys(F)]);
    const sendFiles = []; // [canvas, rel]

    const push = (name, P, Fc) => {
      for (const [rel, sha] of Object.entries(P)) {
        if (Fc && Fc[rel] === sha) continue;
        ops.push({ op: 'put', canvas: name, path: rel, sha, was: (Fc && Fc[rel]) || null });
        sendFiles.push([name, rel]);
      }
      for (const [rel, sha] of Object.entries(Fc || {})) if (!(rel in P)) ops.push({ op: 'del', canvas: name, path: rel, was: sha });
    };

    for (const name of [...names].sort()) {
      const P = pc[name] ? pc[name].files : undefined;
      const Fc = F[name];
      const action = decide({ P, F: Fc, B: base[name], agent: Boolean(pc[name] && pc[name].agent), open: Boolean(pc[name] && pc[name].open) });
      if (action === 'none') continue;
      if (action === 'agree') { base[name] = { ...P }; continue; }
      if (action === 'open') { result.open.push(name); continue; }
      if (action === 'push') { push(name, P, Fc); base[name] = { ...P }; result.pushed.push(name); continue; }
      if (action === 'drop-phone') { ops.push({ op: 'drop', canvas: name, files: Fc }); delete base[name]; result.removed.push({ name, from: 'phone' }); continue; }
      if (action === 'drop-pc') {
        this.backup(ws, name, stamp);
        fs.rmSync(path.join(ws, name), { recursive: true, force: true });
        delete base[name];
        result.removed.push({ name, from: 'pc' });
        continue;
      }
      if (action === 'pull') {
        this.progress = `Copying ${name} from the phone`;
        try { await this.pull(device, root, ws, name, name, Fc, P || {}, stamp); } catch (e) {
          if (e instanceof PhoneError && e.code === 'stale') { result.stale.push(name); continue; }
          throw e;
        }
        base[name] = { ...Fc };
        result.pulled.push(name);
        this.keepIt(name, pc[name]);
        continue;
      }
      // conflict: the PC keeps its version; the phone's comes in beside it, on both sides.
      const copy = uniqueName(name, taken);
      taken.add(copy);
      this.progress = `Copying the phone's ${name} as ${copy}`;
      try { await this.pull(device, root, ws, name, copy, Fc, {}, stamp); } catch (e) {
        if (e instanceof PhoneError && e.code === 'stale') { result.stale.push(name); continue; }
        throw e;
      }
      ops.push({ op: 'copy', canvas: name, to: copy });
      push(name, P, Fc);
      base[name] = { ...P };
      base[copy] = { ...Fc };
      result.conflicts.push({ name, copy });
      this.keepIt(copy, null);
    }

    // Each agent canvas the phone has goes with its conversation, when that changed.
    const extras = []; // [path in the batch, text]
    if (this.chat) {
      for (const [name, c] of Object.entries(pc)) {
        if (!c.agent || !(F[name] || result.pushed.includes(name))) continue;
        let body;
        try { body = JSON.stringify(this.chat(name)); } catch (e) { this.log(`Could not read ${name}'s chat: ${e.message}`); continue; }
        const sha = sha256(Buffer.from(body));
        if (this.data.chatSent[name] === sha) continue;
        ops.push({ op: 'chat', canvas: name, sha });
        extras.push([`chats/${name}.json`, body]);
        this.data.chatSent[name] = sha;
      }
    }

    // Always a batch, even an empty one: it tells CanvasXP when it last met this PC.
    const id = `b-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    this.progress = sendFiles.length ? `Sending ${sendFiles.length} file${sendFiles.length === 1 ? '' : 's'} to the phone` : 'Telling the phone it is up to date';
    this.status({ stage: 'sending', text: sendFiles.length ? `NoteX is sending ${sendFiles.length} file${sendFiles.length === 1 ? '' : 's'} from the PC` : 'NoteX is finishing up' });
    await this.send(device, xp, id, ws, ops, sendFiles, extras);
    if (ops.length) this.data.batches.push({ id, ops: ops.map((o) => (o.op === 'drop' ? { op: 'drop', canvas: o.canvas } : o)) });
    this.save();
    result.at = new Date(this.now()).toISOString();
    result.batch = id;
    this.log(`Phone sync: ${result.pulled.length} in, ${result.pushed.length} out, ${result.conflicts.length} side by side${result.answered.length ? `, ${result.answered.length} message${result.answered.length === 1 ? '' : 's'} answered` : ''}${result.open.length ? `, ${result.open.length} open in CanvasX` : ''}.`);
    return result;
  }

  /* The phone's queued messages (CanvasX t-0b4e61bf2b), oldest first: each a
   * folder in Queued messages holding its attachments and, written last,
   * message.md - one without it is still being written and waits. */
  async readQueue(device, root) {
    let dirs = [];
    try { dirs = (await this.transport.list(device, [...root, QUEUE_DIR])).filter((i) => i.folder && safeSegment(i.name)).map((i) => i.name); } catch (_) { return []; }
    const out = [];
    for (const dir of dirs) {
      const q = parseQueued(await this.readText(device, [...root, QUEUE_DIR, dir], 'message.md'));
      if (!q) continue;
      const { meta } = q;
      const files = Array.isArray(meta.files) ? meta.files : [];
      const id = typeof meta.id === 'string' && safeSegment(meta.id) ? meta.id : `dir:${dir}`;
      const ok = safeCanvas(meta.canvas) && files.every((f) => f && safeSegment(f.name) && /^[0-9a-f]{64}$/.test(f.sha));
      out.push({ id, dir, ok, canvas: meta.canvas, at: String(meta.at || ''), text: queuedAsk(q), model: typeof meta.model === 'string' ? meta.model : null, files: ok ? files : [] });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at) || a.dir.localeCompare(b.dir));
  }

  /* A small text file from the phone, or null. */
  async readText(device, segs, name) {
    const t = this.tmp();
    try {
      await this.transport.pull(device, segs, [name], t);
      return fs.readFileSync(path.join(t, name), 'utf8');
    } catch (_) { return null; } finally { fs.rmSync(t, { recursive: true, force: true }); }
  }

  /* Each queued message not yet answered goes to the agent, one after
   * another (t-e4196083e7). One the agent saw is handled, whatever it
   * answered; one refused before it - not the agent's canvas, a file it
   * cannot take - stays queued with the reason (t-957b09f2fe). */
  async answer(device, root, queue, result, ops) {
    const handled = new Set(this.data.handled);
    const todo = queue.filter((m) => !handled.has(m.id));
    const refuse = (m, error) => { result.unanswered.push({ id: m.id, canvas: m.canvas, error }); ops.push({ op: 'unanswered', id: m.id, dir: m.dir, error }); };
    if (todo.length && !this.ask) for (const m of todo) refuse(m, 'NoteX here cannot run the agent.');
    else if (todo.length) {
      const beat = setInterval(() => this.status(), this.heartbeatMs);
      try {
        for (let i = 0; i < todo.length; i++) {
          const m = todo[i];
          const step = { stage: 'agent', text: `The agent is answering your message${todo.length === 1 ? '' : 's'}`, done: i, total: todo.length, current: m.id, canvas: m.canvas };
          this.progress = `The agent is answering message ${i + 1} of ${todo.length} from the phone (${m.canvas})`;
          this.status(step);
          if (!m.ok) { refuse(m, 'NoteX could not read this message.'); continue; }
          let files;
          try { files = await this.messageFiles(device, root, m); } catch (e) {
            if (e instanceof PhoneError && e.code === 'stale') { refuse(m, e.message); continue; }
            throw e; // the cable, not the message
          }
          let r;
          try { r = await this.ask({ canvas: m.canvas, text: m.text, model: m.model, files }); } catch (e) { refuse(m, e.message); continue; }
          this.data.handled = [...this.data.handled, m.id].slice(-KEEP_HANDLED);
          this.save();
          result.answered.push({ id: m.id, canvas: m.canvas, status: (r && r.status) || 'answered' });
        }
        this.status({ stage: 'agent', text: `The agent answered your message${todo.length === 1 ? '' : 's'}`, done: todo.length, total: todo.length });
      } finally { clearInterval(beat); }
    }
    // CanvasXP removes what was answered - NoteX cannot delete on the phone - told in every batch until it has.
    const done = new Set(this.data.handled);
    const items = queue.filter((m) => done.has(m.id)).map((m) => ({ id: m.id, dir: m.dir }));
    if (items.length) ops.push({ op: 'answered', items });
  }

  /* A message's attachments, each checked against the hash message.md gives. */
  async messageFiles(device, root, m) {
    if (!m.files.length) return [];
    const t = this.tmp();
    try {
      await this.transport.pull(device, [...root, QUEUE_DIR, m.dir], m.files.map((f) => f.name), t);
      return m.files.map((f) => {
        let bytes = null;
        try { bytes = fs.readFileSync(path.join(t, f.name)); } catch (_) { /* missing */ }
        if (!bytes || sha256(bytes) !== f.sha) throw new PhoneError('stale', `${f.name} on the phone is not whole yet - it is tried again at the next sync.`);
        return { name: f.name, bytes };
      });
    } finally { fs.rmSync(t, { recursive: true, force: true }); }
  }

  keepIt(name, pcCanvas) {
    if (pcCanvas && pcCanvas.agent) return;
    try { this.keep(name); } catch (e) { this.log(`Could not keep ${name} in RAGX: ${e.message}`); }
  }

  backup(ws, name, stamp) {
    const src = path.join(ws, name);
    if (!fs.existsSync(src)) return;
    const dest = path.join(this.dir, 'backups', stamp, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }

  /* The phone's canvas `from` onto the PC as `to`: only the files that
   * differ from have, each checked against the manifest, swapped in whole;
   * files the phone no longer has are backed up and removed. */
  async pull(device, root, ws, from, to, files, have, stamp) {
    const t = this.tmp();
    try {
      const want = Object.entries(files).filter(([rel, sha]) => have[rel] !== sha);
      const byDir = new Map();
      for (const [rel] of want) {
        const parts = rel.split('/');
        const name = parts.pop();
        const key = parts.join('/');
        if (!byDir.has(key)) byDir.set(key, []);
        byDir.get(key).push(name);
      }
      for (const [dir, names] of byDir) {
        const segs = dir ? dir.split('/') : [];
        const dest = path.join(t, ...segs);
        fs.mkdirSync(dest, { recursive: true });
        await this.transport.pull(device, [...root, from, ...segs], names, dest);
      }
      for (const [rel, sha] of want) {
        let got = null;
        try { got = sha256(fs.readFileSync(path.join(t, ...rel.split('/')))); } catch (_) { /* missing */ }
        if (got !== sha) throw new PhoneError('stale', `${from}/${rel} on the phone is not what CanvasXP listed.`);
      }
      const dest = path.join(ws, to);
      const gone = Object.keys(have).filter((rel) => !(rel in files));
      if (gone.length) this.backup(ws, to, stamp);
      for (const [rel] of want) {
        const target = path.join(dest, ...rel.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmpTarget = `${target}.notex-phone`;
        fs.copyFileSync(path.join(t, ...rel.split('/')), tmpTarget);
        fs.renameSync(tmpTarget, target);
      }
      for (const rel of gone) fs.rmSync(path.join(dest, ...rel.split('/')), { force: true });
    } finally { fs.rmSync(t, { recursive: true, force: true }); }
  }

  /* A batch onto the phone: its files first, then changes.json, which
   * CanvasXP waits for before it takes anything in. extras are files of the
   * batch itself, such as an agent canvas's chat. */
  async send(device, xp, id, ws, ops, files, extras = []) {
    const t = this.tmp();
    try {
      const dir = path.join(t, id);
      fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
      for (const [canvas, rel] of files) {
        const target = path.join(dir, 'files', canvas, ...rel.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(ws, canvas, ...rel.split('/')), target);
      }
      for (const [rel, text] of extras) {
        const target = path.join(dir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
      }
      await this.transport.push(device, dir, [...xp, 'incoming']);
      const changes = path.join(t, 'changes.json');
      fs.writeFileSync(changes, JSON.stringify({ id, at: new Date(this.now()).toISOString(), from: this.hostname, ops }, null, 2));
      await this.transport.push(device, changes, [...xp, 'incoming', id]);
    } finally { fs.rmSync(t, { recursive: true, force: true }); }
  }
}

/* What CanvasXP's popup says once a sync is done. */
export function summaryOf(r) {
  const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const parts = [];
  if (r.answered.length) parts.push(`${n(r.answered.length, 'message')} answered`);
  if (r.unanswered.length) parts.push(`${n(r.unanswered.length, 'message')} not answered`);
  if (r.pulled.length) parts.push(`${n(r.pulled.length, 'canvas', 'canvases')} to the PC`);
  if (r.pushed.length) parts.push(`${n(r.pushed.length, 'canvas', 'canvases')} from the PC`);
  if (r.conflicts.length) parts.push(`${n(r.conflicts.length, 'canvas', 'canvases')} changed on both, both kept`);
  if (r.removed.length) parts.push(`${n(r.removed.length, 'canvas', 'canvases')} deleted`);
  return parts.length ? parts.join(' · ') : 'Already up to date';
}
