/* Auto-sync: the canvases the user switched on are kept in RAGX by
 * themselves; every other canvas is left alone (t-0c1da1346d).
 *
 * Every 5 s the modified time of each watched fabric.json is looked at
 * (t-233e5561d1). A canvas is synced once it has been quiet for 15 s since
 * File Fabric's last save, and not again within a minute; a save caught
 * half-written is tried again at the next look, and a stopped RAGX is waited
 * for (t-a2853a8746). A sync builds the canvas's document, reads its new
 * images, writes docs/ again and hands the file to RAGX's NoteX Add - one
 * canvas at a time, never beside a Read images the user pressed
 * (t-c765aac21b).
 *
 * config.sync keeps, for each canvas switched on, the modified time it was
 * last synced at, so a save made while NoteX was stopped is caught up on the
 * next start (t-ccc6f4dcc0).
 */
import fs from 'node:fs';
import path from 'node:path';
import { FabricError } from './fabric.js';
import { readFabricImages } from './read.js';
import { ragxFolder, ragxRuntime, addToRagx, RagxError } from './ragx.js';

export const POLL_MS = 5_000;
export const SETTLE_MS = 15_000;
export const GAP_MS = 60_000;

export class AutoSync {
  /* build(name) builds the canvas and writes it to docs/; busy() says
   * whether a Read images the user pressed is running. */
  constructor({ config, saveConfig, dataDir, build, busy = () => false, runtime = null, log = () => {},
    pollMs = POLL_MS, settleMs = SETTLE_MS, gapMs = GAP_MS, now = Date.now } = {}) {
    Object.assign(this, { config, saveConfig, dataDir, build, busy, runtime, log, pollMs, settleMs, gapMs, now });
    this.mem = new Map(); // name -> what is known of it since this start
    this.running = null;
    this.timer = null;
  }

  start() {
    if (!this.timer) { this.timer = setInterval(() => this.tick(), this.pollMs); this.timer.unref?.(); }
    this.tick();
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running.catch(() => {});
  }

  file(name) { return path.join(this.config.workspace || '', name, 'fabric.json'); }
  mtime(name) { try { return fs.statSync(this.file(name)).mtimeMs; } catch (_) { return null; } }
  state(name) {
    if (!this.mem.has(name)) this.mem.set(name, { status: 'synced', detail: null, seen: null, quietFrom: 0, lastRun: 0, retry: false, holdUntil: 0 });
    return this.mem.get(name);
  }

  watched() { return Object.keys(this.config.sync || {}); }

  /* Switching on syncs the canvas as it is now, without waiting for its next edit. */
  set(name, on) {
    if (on) {
      this.config.sync ||= {};
      if (!this.config.sync[name]) this.config.sync[name] = { synced: null, at: null };
      Object.assign(this.state(name), { status: 'settling', detail: null, seen: this.mtime(name), quietFrom: -Infinity, retry: true, holdUntil: 0 });
    } else {
      if (this.config.sync) delete this.config.sync[name];
      this.mem.delete(name);
    }
    this.saveConfig();
    if (on) this.tick();
  }

  /* What the page shows for each canvas switched on. */
  report() {
    const out = {};
    for (const name of this.watched()) {
      const { synced, at } = this.config.sync[name];
      const st = this.state(name);
      out[name] = { status: st.status, detail: st.detail, at, upToDate: synced != null && synced === this.mtime(name) && st.status === 'synced' };
    }
    return out;
  }

  tick() {
    if (this.running || !this.config.workspace) return this.running;
    const t = this.now();
    for (const name of this.watched()) {
      const st = this.state(name);
      const m = this.mtime(name);
      if (m == null) { st.status = 'missing'; st.detail = `No fabric.json for ${name} in the workspace.`; continue; }
      if (m === this.config.sync[name].synced && !st.retry) { if (st.status !== 'error') st.status = 'synced'; continue; }
      if (m !== st.seen) { st.seen = m; st.quietFrom = t; st.status = 'settling'; st.detail = null; }
      if (t - st.quietFrom < this.settleMs) continue;
      if (st.holdUntil && t < st.holdUntil) continue;
      // A wait for RAGX or for a whole save goes again at once; anything else keeps the minute.
      if (!st.retry && t - st.lastRun < this.gapMs) { st.status = 'waiting'; continue; }
      if (this.busy()) { st.status = 'queued'; st.detail = 'After the Read images that is running.'; continue; }
      this.running = this.sync(name, m).finally(() => { this.running = null; });
      return this.running;
    }
    return null;
  }

  async sync(name, m) {
    const st = this.state(name);
    const was = st.lastRun;
    Object.assign(st, { lastRun: this.now(), retry: false, holdUntil: 0 });
    // retry: try at the next look, as if this run had not happened; else wait a minute.
    const wait = (status, detail, retry) => {
      Object.assign(st, { status, detail, retry, holdUntil: retry ? 0 : this.now() + this.gapMs });
      if (retry) st.lastRun = was;
      return { name, status, detail };
    };
    try {
      st.status = 'building'; st.detail = null;
      let built = this.build(name);
      if (built.unread) {
        st.status = 'reading'; st.detail = `0/${built.unread}`;
        const r = await readFabricImages(path.dirname(this.file(name)), {
          dataDir: this.dataDir, ragx: this.config.ragx, runtime: this.runtime,
          onProgress: (p) => { if (p.total != null) st.detail = `${p.done}/${p.total}`; },
        });
        // RAGX stopped is waited for; Claude out of use or logged out waits the minute.
        if (r.stopped) return wait(/not running|not answering/.test(r.stopped) ? 'waiting-ragx' : 'error', r.stopped, /not running|not answering/.test(r.stopped));
        built = this.build(name); // with the readings it now has
      }
      st.status = 'sending'; st.detail = null;
      const rt = this.runtime || ragxRuntime(ragxFolder(this.config.ragx));
      const sent = await addToRagx(rt, `${name}.notex.md`);
      // Switched off while this ran: it was sent, but nothing more is kept of it.
      if (!this.watched().includes(name)) return { name, status: 'off', queued: sent.queued || [] };
      this.config.sync[name] = { synced: m, at: new Date(this.now()).toISOString() };
      this.saveConfig();
      // A save made while this ran has another modified time: the next look syncs it.
      Object.assign(st, { status: 'synced', detail: sent.queued && sent.queued.length ? null : 'RAGX already had this version.' });
      this.log(`Synced ${name} to RAGX.`);
      return { name, status: 'synced', queued: sent.queued || [] };
    } catch (e) {
      if (e instanceof FabricError && e.code === 'bad-json') return wait('settling', 'File Fabric is saving it.', true);
      if (e instanceof RagxError && e.code === 'ragx-down') return wait('waiting-ragx', e.message, true);
      return wait('error', e.message, false);
    }
  }
}
