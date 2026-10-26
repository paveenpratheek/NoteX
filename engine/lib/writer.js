/* NoteX as the only writer of a canvas: agents send it totem scripts, and
 * it applies them one at a time, each on the canvas as it is then, never
 * while File Fabric has the canvas open (t-a80b904d43).
 *
 * File Fabric keeps an open canvas in memory and overwrites fabric.json on
 * every save, and refreshes the canvas's .fabric_lock every 10 s while it
 * is open; a lock 30 s old is the one File Fabric itself treats as stale.
 * So a script for an open canvas waits in a queue, persisted in the data
 * folder, and each write: waits for a stale lock; re-reads the file; lays
 * the script out on it; checks the file has not changed meanwhile; backs it
 * up; writes a temp file and renames it over fabric.json; and reads it
 * back through buildPlaces, confirming every address the script promised -
 * restoring the backup if one is missing.
 *
 * A ledger keeps each item as written. An item that differs later was
 * edited by the user: it is kept, and agent edits to it are refused
 * (t-ab2864c2a1). After File Fabric has drawn an agent's text and saved its
 * real height, boxes the text overflows are grown - only while the canvas
 * is closed (t-2afecbd70b). A write made in the 10 s before File Fabric's
 * first heartbeat on a canvas just opened may be lost to its next save, so
 * NoteX watches for that and sends the script again (t-b0d14bc40f).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readFabric, FabricError } from './fabric.js';
import { buildPlaces, plainText } from './places.js';
import { parseScript, ScriptError } from './script.js';
import { layoutTotem, layoutAdd, layoutEdits, growOverflows, Refusal, textHtml } from './layout.js';

export const LOCK_STALE_MS = 30_000;
const POLL_MS = 5_000;
const WATCH_MS = 20_000;
const KEEP_BACKUPS = 20;
const KEEP_DONE = 50;

/* How long ago File Fabric last refreshed a canvas's lock; Infinity with no lock. */
export function lockAge(dir, now = Date.now()) {
  const file = path.join(dir, '.fabric_lock');
  let st;
  try { st = fs.statSync(file); } catch (_) { return Infinity; }
  let at = st.mtimeMs;
  try { const t = JSON.parse(fs.readFileSync(file, 'utf8')).timestamp; if (Number.isFinite(t)) at = Math.max(t, at); } catch (_) { /* the file's time will do */ }
  return now - at;
}

/* What an item is, for telling later whether the user changed it: the
 * fields a person can change in File Fabric, never the ones it works out
 * for itself (_calculatedHeight, areaName, the links it re-finds)
 * (t-fcb7e2c892). */
export function fingerprint(item) {
  const r = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
  const pts = (ps) => (ps || []).map((p) => p && [r(p.x), r(p.y)]);
  const pick = {
    name: item.name, text: item.text, textContent: item.textContent, color: item.color,
    polygons: item.polygons ? item.polygons.map(pts) : undefined, points: item.points ? pts(item.points) : undefined,
    x: r(item.x), y: r(item.y), width: r(item.width), fontSize: item.fontSize,
    start: item.start ? pts([item.start]) : undefined, end: item.end ? pts([item.end]) : undefined,
    imageWidth: r(item.imageWidth), imageHeight: r(item.imageHeight), pages: item.pages ? item.pages.map((p) => p.id) : undefined,
    from: item.fromAreaId, to: item.toAreaId, corners: item.fromCorner ? [item.fromCorner, item.toCorner] : undefined,
  };
  return crypto.createHash('sha1').update(JSON.stringify(pick)).digest('hex').slice(0, 16);
}

// What an <Edit>/<Remove> script does, in a few words for the queue and the page.
const changesOf = (nodes) => {
  const n = (tag) => nodes.filter((x) => x.tag === tag).length;
  const say = (k, w) => (k ? `${k} ${w}${k === 1 ? '' : 's'}` : null);
  return [say(n('Edit'), 'edit'), say(n('Remove'), 'removal')].filter(Boolean).join(' and ');
};

const EMPTY_CANVAS = () => ({ drawings: [], areas: [], files: [], links: [], totems: [], tables: [] });

export class Writer {
  constructor({ config, dataDir, log = () => {}, now = Date.now, pollMs = POLL_MS, lockStaleMs = LOCK_STALE_MS, watchMs = WATCH_MS }) {
    Object.assign(this, { config, log, now, pollMs, lockStaleMs, watchMs });
    this.dir = path.join(dataDir, 'scripts');
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'queue.json');
    this.data = { entries: [], watches: [], upkeep: {} };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (_) { /* first start */ }
    this.chain = Promise.resolve();
    this.timer = null;
  }

  start() {
    if (!this.timer) { this.timer = setInterval(() => { this.tick(); }, this.pollMs); this.timer.unref?.(); }
    return this.tick();
  }

  stop() { clearInterval(this.timer); this.timer = null; return this.chain; }

  save() {
    const done = this.data.entries.filter((e) => e.status !== 'waiting');
    const keep = new Set(done.slice(-KEEP_DONE));
    this.data.entries = this.data.entries.filter((e) => e.status === 'waiting' || keep.has(e));
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /* One thing at a time: every write and every look runs in turn. */
  serial(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  canvasDir(name) {
    if (!this.config.workspace) throw new Refusal("NoteX has no File Fabric workspace yet - the user sets it on NoteX's page.");
    if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) throw new Refusal(`"${name}" cannot be a canvas name.`);
    return path.join(this.config.workspace, name);
  }

  isOpen(dir) { return lockAge(dir, this.now()) < this.lockStaleMs; }

  /* ------------------------------------------------------------ ledger */

  ledgerFile(canvas) { return path.join(this.dir, `ledger-${canvas}.json`); }
  ledger(canvas) {
    try { return JSON.parse(fs.readFileSync(this.ledgerFile(canvas), 'utf8')); } catch (_) { return { items: {} }; }
  }
  saveLedger(canvas, l) { fs.writeFileSync(this.ledgerFile(canvas), JSON.stringify(l, null, 2)); }

  /* Whether NoteX may change an item for an agent: null when it may, else
   * why not, in words that finish "... which ...". */
  mayChange(ledger) {
    return (item) => {
      if (item.writtenBy !== 'agent') return "is the user's";
      const had = ledger.items[item.id];
      if (!had) return 'NoteX did not write, so it cannot tell whether the user changed it';
      if (had.print !== fingerprint(item)) return 'was edited by the user since it was written';
      return null;
    };
  }

  /* --------------------------------------------------------- submitting */

  /* A script from an agent: refused at once if it does not parse; written
   * now if its canvas is closed and nothing waits before it; else queued
   * (t-b1b3017007). */
  async submit({ script, owner }) {
    const who = String(owner || '').trim().slice(0, 120) || 'an agent';
    let parsed;
    try {
      parsed = parseScript(script);
      this.canvasDir(parsed.canvas);
      // The rules canvas takes only the user's own words; a script is always an agent's (t-ad316ec0c1).
      if (this.config.rules && parsed.canvas.toLowerCase() === String(this.config.rules).toLowerCase()) {
        throw new Refusal(`${parsed.canvas} is the rules canvas, which holds only the user's own words - agents never write on it. If the user wants words of yours there, they write them themselves.`);
      }
    } catch (e) {
      if (!(e instanceof ScriptError || e instanceof Refusal)) throw e;
      // Never queued: a script that does not read is the agent's to fix now.
      return { id: null, canvas: parsed ? parsed.canvas : null, owner: who, status: 'refused', result: { message: e.message, line: e.line || null } };
    }
    const entry = {
      id: crypto.randomBytes(5).toString('hex'), canvas: parsed.canvas, owner: who, kind: parsed.kind,
      what: parsed.kind === 'totem' ? `new totem ${parsed.totem.attrs.name}` : parsed.kind === 'add' ? `add to ${parsed.at}` : changesOf(parsed.edits),
      script, at: new Date(this.now()).toISOString(), status: 'waiting', result: null,
    };
    this.data.entries.push(entry);
    this.save();
    await this.serial(() => this.drain(entry.canvas));
    return entry;
  }

  cancel(id) {
    const e = this.data.entries.find((x) => x.id === id);
    if (!e || e.status !== 'waiting') return null;
    e.status = 'cancelled';
    e.result = { message: 'Cancelled on NoteX\'s page.' };
    this.save();
    return e;
  }

  /* Every waiting script for a canvas, oldest first, while it is closed. */
  drain(canvas) {
    for (;;) {
      const next = this.data.entries.find((e) => e.status === 'waiting' && e.canvas === canvas);
      if (!next) return;
      if (!this.apply(next)) return;
    }
  }

  tick() {
    return this.serial(() => {
      for (const c of new Set(this.data.entries.filter((e) => e.status === 'waiting').map((e) => e.canvas))) {
        try { this.drain(c); } catch (e) { this.log(`Writing to ${c} failed: ${e.message}`); }
      }
      this.watchLostWrites();
      this.upkeep();
    });
  }

  /* --------------------------------------------------------------- write */

  /* One script, applied - or left waiting while File Fabric has the canvas
   * open. true when it is finished either way. */
  apply(entry) {
    let dir;
    try { dir = this.canvasDir(entry.canvas); } catch (e) { return this.finish(entry, 'refused', { message: e.message }); }
    if (this.config.rules && entry.canvas.toLowerCase() === String(this.config.rules).toLowerCase()) {
      return this.finish(entry, 'refused', { message: `${entry.canvas} became the rules canvas while this waited - agents never write on it.` });
    }
    const parsed = parseScript(entry.script);
    if (!fs.existsSync(path.join(dir, 'fabric.json'))) {
      if (parsed.kind !== 'totem') return this.finish(entry, 'refused', { message: `There is no canvas called ${entry.canvas} in File Fabric's workspace.` });
      // A new canvas: a folder with an empty fabric.json and sources/, as File Fabric makes one.
      fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'fabric.json'), JSON.stringify(EMPTY_CANVAS()));
      this.log(`Made a new canvas ${entry.canvas} for ${entry.owner}.`);
    }
    if (this.isOpen(dir)) return false;
    try {
      const result = this.write(dir, entry.canvas, (state, ledger) => {
        const opts = { owner: entry.owner, fabricDir: dir, mayChange: this.mayChange(ledger) };
        if (parsed.kind === 'totem') return layoutTotem(parsed, state, opts);
        if (parsed.kind === 'add') return layoutAdd(parsed, state, opts);
        return layoutEdits(parsed, state, opts);
      }, entry.owner);
      if (result === null) return false; // opened, or saved, while it was being laid out
      if (result.written.length) this.data.watches.push({ canvas: entry.canvas, entry: entry.id, writtenAt: this.now(), ids: result.written, suspect: false });
      return this.finish(entry, 'written', result.report);
    } catch (e) {
      if (e instanceof Refusal || e instanceof ScriptError) return this.finish(entry, 'refused', { message: e.message, line: e.line || null });
      if (e instanceof FabricError && e.code === 'bad-json') return false; // caught mid-save: next look
      this.log(`Writing ${entry.id} to ${entry.canvas} failed: ${e.stack || e.message}`);
      return this.finish(entry, 'failed', { message: e.message });
    }
  }

  finish(entry, status, result) {
    entry.status = status;
    entry.result = result;
    entry.done = new Date(this.now()).toISOString();
    this.save();
    this.log(`${status === 'written' ? 'Wrote' : status === 'refused' ? 'Refused' : 'Could not write'} ${entry.what} on ${entry.canvas} for ${entry.owner}${result && result.message ? `: ${result.message}` : ''}.`);
    return true;
  }

  /* The safe write itself. change(state, ledger) lays out on a copy of the
   * canvas and returns what it wrote; null back means try again later. */
  write(dir, canvas, change, owner = null) {
    const file = path.join(dir, 'fabric.json');
    const text = fs.readFileSync(file, 'utf8');
    let root;
    try { root = JSON.parse(text); } catch (e) { throw new FabricError('bad-json', e.message); }
    const state = root.data ? root.data : root;
    const ledger = this.ledger(canvas);
    const out = change(state, ledger);
    if (!out) return null;
    // Nothing may have changed while it was laid out: not the file, not the lock.
    if (this.isOpen(dir) || fs.readFileSync(file, 'utf8') !== text) return null;

    const backups = path.join(this.dir, 'backups', canvas);
    fs.mkdirSync(backups, { recursive: true });
    const backup = path.join(backups, `${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backup, text);
    const old = fs.readdirSync(backups).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.rmSync(path.join(backups, f), { force: true });

    for (const c of out.copies || []) {
      const to = path.join(dir, 'sources', c.name);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (!fs.existsSync(to)) fs.copyFileSync(c.from, to);
    }
    const tmp = path.join(dir, 'fabric.json.notex-tmp');
    fs.writeFileSync(tmp, JSON.stringify(root));
    fs.renameSync(tmp, file);

    // Read back as RAGX will: every promised address there, every text in its place.
    const back = readFabric(dir);
    const model = buildPlaces(back);
    const missing = [];
    // And everything a <Remove> took off is gone (t-1ca15af044).
    const left = new Set(['areas', 'drawings', 'files', 'totems', 'links'].flatMap((k) => (back.state[k] || []).map((x) => x.id)));
    for (const id of out.removed || []) if (left.has(id)) missing.push(`the removal of ${id}`);
    for (const b of out.boxes || []) if (model.places.get(b.id)?.address !== b.address) missing.push(b.address);
    const byAddress = new Map([...model.places.values()].map((p) => [p.address, p]));
    for (const t of out.texts || []) if (!(byAddress.get(t.address)?.texts || []).includes(plainText(textHtml(t.text)))) missing.push(`the text "${t.text.slice(0, 40)}" in ${t.address}`);
    if (missing.length) {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
      throw new Error(`after writing, NoteX could not find ${missing.join('; ')} - the canvas was put back as it was`);
    }

    const changed = new Set([...out.written, ...out.touched]);
    const all = [...state.areas, ...state.drawings, ...state.files, ...state.totems, ...(state.links || [])];
    for (const item of all) {
      if (!changed.has(item.id)) continue;
      ledger.items[item.id] = { print: fingerprint(item), totem: out.totemId || ledger.items[item.id]?.totem || null, owner: owner || ledger.items[item.id]?.owner || null };
    }
    for (const id of out.removed || []) delete ledger.items[id];
    this.saveLedger(canvas, ledger);
    this.data.upkeep[canvas] = fs.statSync(file).mtimeMs;

    const boxes = (out.boxes || []).map((b) => ({ address: b.address, id: b.id.replace(/^totem:/, '') }));
    return {
      written: out.written,
      report: {
        boxes, written: out.written.length, removed: (out.removed || []).length, moved: [...out.touched].filter((id) => !out.written.includes(id)).length,
        check: out.check || null, copies: (out.copies || []).map((c) => c.name), backup,
      },
    };
  }

  /* ------------------------------------------------- after File Fabric */

  /* A write File Fabric may not have loaded: if its lock was refreshed in
   * the moments after the write, it may have opened the old file, so once
   * it saves, the written items must still be there - else the script goes
   * back in the queue (t-b0d14bc40f). */
  watchLostWrites() {
    if (!this.data.watches.length) return;
    const keep = [];
    for (const w of this.data.watches) {
      let dir;
      try { dir = this.canvasDir(w.canvas); } catch (_) { continue; }
      const age = lockAge(dir, this.now());
      const lockAt = this.now() - age;
      if (Number.isFinite(age) && lockAt > w.writtenAt && lockAt <= w.writtenAt + 15_000) w.suspect = true;
      if (!w.suspect) { if (this.now() - w.writtenAt < this.watchMs) keep.push(w); continue; }
      let st;
      try { st = fs.statSync(path.join(dir, 'fabric.json')); } catch (_) { continue; }
      if (st.mtimeMs <= w.writtenAt + 1000) { if (this.isOpen(dir)) keep.push(w); continue; }
      let state;
      try { state = readFabric(dir).state; } catch (_) { keep.push(w); continue; }
      const d = state.data || state;
      const there = new Set([...(d.areas || []), ...(d.drawings || []), ...(d.files || []), ...(d.totems || []), ...(d.links || [])].map((x) => x.id));
      if (w.ids.some((id) => !there.has(id))) {
        const was = this.data.entries.find((e) => e.id === w.entry);
        if (was) {
          this.data.entries.push({ ...was, id: crypto.randomBytes(5).toString('hex'), status: 'waiting', result: null, at: new Date(this.now()).toISOString(), resent: was.id });
          this.log(`File Fabric opened ${w.canvas} as NoteX wrote it and saved over it - sending ${was.what} again.`);
        }
      }
    }
    this.data.watches = keep;
    this.save();
  }

  /* Agent texts File Fabric has drawn taller than estimated: their boxes
   * grow, as for an <Add>, while the canvas is closed (t-2afecbd70b). */
  upkeep() {
    if (!this.config.workspace) return;
    const was = JSON.stringify(this.data.upkeep);
    for (const f of fs.readdirSync(this.dir).filter((n) => /^ledger-.*\.json$/.test(n))) {
      const canvas = f.slice(7, -5);
      let dir, st;
      try { dir = this.canvasDir(canvas); st = fs.statSync(path.join(dir, 'fabric.json')); } catch (_) { continue; }
      if (this.data.upkeep[canvas] === st.mtimeMs || this.isOpen(dir)) continue;
      if (this.data.entries.some((e) => e.status === 'waiting' && e.canvas === canvas)) continue;
      try {
        const r = this.write(dir, canvas, (state, ledger) => {
          const may = this.mayChange(ledger);
          const ids = (state.drawings || []).filter((d) => d.type === 'text' && d._calculatedHeight != null && ledger.items[d.id] && !may(d)).map((d) => d.id);
          const out = growOverflows(state, { mayChange: may }, ids);
          return out.touched.size ? out : false;
        });
        if (r) this.log(`Grew the boxes around ${canvas}'s agent texts that File Fabric drew taller.`);
        this.data.upkeep[canvas] = fs.statSync(path.join(dir, 'fabric.json')).mtimeMs;
      } catch (e) {
        if (e instanceof Refusal) { this.data.upkeep[canvas] = st.mtimeMs; this.log(`Could not grow ${canvas}'s boxes: ${e.message}`); } else if (!(e instanceof FabricError)) this.log(`Upkeep of ${canvas} failed: ${e.message}`);
      }
    }
    if (JSON.stringify(this.data.upkeep) !== was) this.save();
  }

  /* ------------------------------------------------------------- report */

  report() {
    const canvases = {};
    for (const e of this.data.entries) {
      const c = canvases[e.canvas] || (canvases[e.canvas] = { waiting: [], recent: [] });
      const row = { id: e.id, owner: e.owner, what: e.what, at: e.at, status: e.status, done: e.done || null, result: e.result };
      if (e.status === 'waiting') c.waiting.push(row); else c.recent.unshift(row);
    }
    for (const [name, c] of Object.entries(canvases)) {
      c.recent = c.recent.slice(0, 5);
      try { c.open = this.isOpen(this.canvasDir(name)); } catch (_) { c.open = null; }
    }
    return canvases;
  }

  entry(id) { return this.data.entries.find((e) => e.id === id) || null; }
}
