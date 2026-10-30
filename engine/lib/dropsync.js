/* The drops on agent canvases, on to RAGX: gold in the medallion pipeline
 * (t-7513cdd783).
 *
 * After every render of an agent canvas, NoteX writes <canvas>.drops.json
 * in its docs folder - each drop on the canvas now with its name, its file
 * in bronze, its sha256, its address and when it was dropped - and asks
 * RAGX to take it. RAGX checks every entry itself (Project Harness
 * t-a3a1000832). A list RAGX has not taken - it was stopped, or did not
 * answer - is sent again every minute, also after a restart, from
 * docs/drops-pending.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ragxFolder, ragxRuntime, sendDrops, RagxError } from './ragx.js';
import { BronzeError } from './bronze.js';

export const RETRY_MS = 60_000;

/* Typed text has no name: its first words and its drop id stand for one (t-b404914d8f). */
export function dropName(d, words = '') {
  if (d.name) return d.name;
  const all = String(words).replace(/[\\/:*?"<>|\s]+/g, ' ').trim();
  // Up to 40 characters, ending on a whole word.
  let first = all.slice(0, 41);
  if (all.length > 40) first = first.slice(0, first.lastIndexOf(' ')).trim() || all.slice(0, 40);
  return `${first || 'Typed text'} (${d.id}).txt`;
}

export class DropSync {
  constructor({ dataDir, config, agent, bronze, runtime = null, log = () => {}, retryMs = RETRY_MS }) {
    Object.assign(this, { config, agent, bronze, runtime, log, retryMs });
    this.docs = path.join(dataDir, 'docs');
    this.pendingFile = path.join(this.docs, 'drops-pending.json');
    this.timer = null;
    this.sending = null;
    this.warned = false;
  }

  pending() { try { return new Set(JSON.parse(fs.readFileSync(this.pendingFile, 'utf8'))); } catch (_) { return new Set(); } }
  savePending(set) { fs.mkdirSync(this.docs, { recursive: true }); fs.writeFileSync(this.pendingFile, JSON.stringify([...set])); }

  /* The canvas's drop list as RAGX reads it: placed drops on it now. */
  list(canvas) {
    const files = [];
    for (const { id, address } of this.agent.placedDrops(canvas)) {
      let d, file;
      try { d = this.bronze.get(id); file = this.bronze.file(id); } catch (e) { if (e instanceof BronzeError) continue; throw e; }
      if (d.canvas !== canvas || d.status !== 'placed') continue;
      const words = d.name ? '' : fs.readFileSync(file, 'utf8');
      files.push({ name: dropName(d, words), path: file, sha256: path.basename(file).replace(/\.[^.]+$/, ''), address, kind: d.kind, drop: { id, at: d.landedAt } });
    }
    return { canvas, files };
  }

  /* Writes the list; true when it differs from the one there. */
  write(canvas) {
    fs.mkdirSync(this.docs, { recursive: true });
    const file = path.join(this.docs, `${canvas}.drops.json`);
    const text = JSON.stringify(this.list(canvas), null, 2);
    let was = null;
    try { was = fs.readFileSync(file, 'utf8'); } catch (_) { /* first time */ }
    if (was === text) return false;
    fs.writeFileSync(file, text);
    return true;
  }

  /* After a render: the list written, and sent if it changed. */
  queue(canvas) {
    const set = this.pending();
    if (this.write(canvas) || set.has(canvas)) { set.add(canvas); this.savePending(set); }
    return this.flush();
  }

  flush() {
    if (this.sending) return this.sending.then(() => this.flush());
    const set = this.pending();
    if (!set.size) return Promise.resolve([]);
    this.sending = (async () => {
      const done = [];
      for (const canvas of set) {
        try {
          const rt = this.runtime || ragxRuntime(ragxFolder(this.config.ragx));
          await sendDrops(rt, canvas);
          set.delete(canvas);
          done.push(canvas);
          this.warned = false;
        } catch (e) {
          if (!(e instanceof RagxError)) throw e;
          // Said once until RAGX answers again, not every minute.
          if (!this.warned) this.log(`${canvas}'s drops wait for RAGX: ${e.message}`);
          this.warned = true;
          if (e.code !== 'ragx-down') { set.delete(canvas); this.log(`RAGX refused ${canvas}'s drops: ${e.message}`); }
        }
      }
      this.savePending(set);
      return done;
    })().finally(() => { this.sending = null; });
    return this.sending;
  }

  start() {
    if (!this.timer) { this.timer = setInterval(() => { this.flush().catch((e) => this.log(`Sending drops failed: ${e.message}`)); }, this.retryMs); this.timer.unref?.(); }
    return this.flush();
  }

  async stop() { clearInterval(this.timer); this.timer = null; if (this.sending) await this.sending.catch(() => {}); }
}
