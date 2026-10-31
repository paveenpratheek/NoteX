/* Phone sync: the workspace and CanvasXP's folder on the user's phone, kept
 * the same over the USB cable in File transfer mode (t-71306596ff,
 * t-76fdccd60b; CanvasXP's side is CanvasX t-3d7b88b6a1).
 *
 * CanvasXP keeps, in _canvasxp/ inside its target folder on the phone:
 *   device.json    written by its Setup: the phone's id and name;
 *   manifest.json  every file of every canvas with its SHA-256, refreshed
 *                  after each save, and the batches it has taken in;
 *   incoming/<id>/ what NoteX sends: files/<canvas>/<path> and, copied last,
 *                  changes.json saying what to write and delete.
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
   * has a canvas open on the PC; keep(name) keeps a canvas in RAGX. */
  constructor({ config, saveConfig, dataDir, transport, isOpen = () => false, keep = () => {}, log = () => {}, now = Date.now, hostname = os.hostname() }) {
    Object.assign(this, { config, saveConfig, transport, isOpen, keep, log, now, hostname });
    this.dir = path.join(dataDir, 'phone');
    this.stateFile = path.join(this.dir, 'state.json');
    this.running = null;
    this.last = null;
    this.data = this.load();
  }

  load() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (_) { return { id: null, base: {}, batches: [], cache: {} }; }
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
    if (this.data.id !== d.id) this.data = { id: d.id, base: {}, batches: [], cache: this.data.cache || {} };
    this.config.phone = { device, path: segs, id: d.id, name: d.name || 'Phone', setAt: new Date(this.now()).toISOString() };
    this.saveConfig();
    this.save();
    return this.config.phone;
  }

  forget() {
    delete this.config.phone;
    this.saveConfig();
    this.data = { id: null, base: {}, batches: [], cache: this.data.cache || {} };
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
      for (const c of [op.canvas, op.to].filter(Boolean)) { if (listed[c]) this.data.base[c] = { ...listed[c] }; else delete this.data.base[c]; }
    }
    const F = overlay(listed, this.data.batches);

    this.progress = 'Reading the workspace';
    const pc = scanPc(ws, this.data.cache, this.isOpen);
    const base = this.data.base;
    const names = new Set([...Object.keys(pc), ...Object.keys(F), ...Object.keys(base)]);
    const taken = new Set([...Object.keys(pc), ...Object.keys(F)]);
    const result = { ok: true, at: null, pulled: [], pushed: [], conflicts: [], removed: [], open: [], stale: [], skipped };
    const ops = [];
    const sendFiles = []; // [canvas, rel]
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');

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

    // Always a batch, even an empty one: it tells CanvasXP when it last met this PC.
    const id = `b-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    this.progress = sendFiles.length ? `Sending ${sendFiles.length} file${sendFiles.length === 1 ? '' : 's'} to the phone` : 'Telling the phone it is up to date';
    await this.send(device, xp, id, ws, ops, sendFiles);
    if (ops.length) this.data.batches.push({ id, ops: ops.map((o) => (o.op === 'drop' ? { op: 'drop', canvas: o.canvas } : o)) });
    this.save();
    result.at = new Date(this.now()).toISOString();
    result.batch = id;
    this.log(`Phone sync: ${result.pulled.length} in, ${result.pushed.length} out, ${result.conflicts.length} side by side${result.open.length ? `, ${result.open.length} open in CanvasX` : ''}.`);
    return result;
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
   * CanvasXP waits for before it takes anything in. */
  async send(device, xp, id, ws, ops, files) {
    const t = this.tmp();
    try {
      const dir = path.join(t, id);
      fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
      for (const [canvas, rel] of files) {
        const target = path.join(dir, 'files', canvas, ...rel.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(ws, canvas, ...rel.split('/')), target);
      }
      const items = await this.transport.list(device, xp);
      if (!items.some((i) => i.folder && i.name === 'incoming')) await this.transport.mkdir(device, xp, 'incoming');
      await this.transport.push(device, dir, [...xp, 'incoming']);
      const changes = path.join(t, 'changes.json');
      fs.writeFileSync(changes, JSON.stringify({ id, at: new Date(this.now()).toISOString(), from: this.hostname, ops }, null, 2));
      await this.transport.push(device, changes, [...xp, 'incoming', id]);
    } finally { fs.rmSync(t, { recursive: true, force: true }); }
  }
}
