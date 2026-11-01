/* How NoteX reaches the phone (t-71306596ff). Both transports answer the
 * same five calls, with folders named as lists of names from the device's
 * top:
 *   devices()                      -> [{ name }]
 *   list(device, segs)             -> [{ name, folder, size, modified }]
 *   pull(device, segs, names, dir) copies those files from the phone into dir
 *   push(device, src, segs)        copies a file or folder on the PC into segs
 *   mkdir(device, segs, name)
 *
 * ShellTransport is the USB cable in File transfer mode, through Windows'
 * shell (mtp.ps1); FolderTransport is a plain folder standing in for a phone,
 * for the tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PhoneError } from './phone.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MTP_PS1 = path.join(HERE, 'mtp.ps1');

/* One helper answers a whole sync (t-2f21cca482): mtp.ps1 -Op serve, a JSON
 * request per line. Requests go one at a time - two shell copies to the
 * phone at once stalled each other - and the helper remembers the folders it
 * walked to. A request that outlasts its time is given up and the helper
 * started afresh for the next; one left idle closes itself. */
export class ShellTransport {
  constructor({ powershell = 'powershell.exe', script = MTP_PS1, timeoutMs = 3 * 60_000, perFileMs = 90_000, idleMs = 60_000 } = {}) {
    Object.assign(this, { powershell, script, timeoutMs, perFileMs, idleMs });
    this.proc = null;
    this.queue = Promise.resolve();
    this.seq = 0;
    this.idleTimer = null;
  }

  helper() {
    if (this.proc) return this.proc;
    const p = spawn(this.powershell, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-Op', 'serve'], { windowsHide: true });
    p.waiting = null; // { id, resolve, reject }
    let buf = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n).replace(/^﻿/, '').trim();
        buf = buf.slice(n + 1);
        if (!line) continue;
        let r;
        try { r = JSON.parse(line); } catch (_) { continue; }
        const w = p.waiting;
        if (!w || r.id !== w.id) continue;
        p.waiting = null;
        if (!r.ok) w.reject(new PhoneError('mtp', r.error || 'The phone helper failed.'));
        else w.resolve(r);
      }
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    const gone = (why) => {
      if (this.proc === p) this.proc = null;
      const w = p.waiting;
      p.waiting = null;
      if (w) w.reject(why);
    };
    p.on('error', (e) => gone(new PhoneError('no-powershell', `Could not start PowerShell: ${e.message}`)));
    p.on('close', () => gone(new PhoneError('mtp', `The phone helper stopped${err ? `: ${err.trim().slice(0, 300)}` : '.'}`)));
    this.proc = p;
    return p;
  }

  // How long a request may take: a pull is given time for each of its files.
  limitOf(op, args) {
    if (op === 'pull') return this.timeoutMs + this.perFileMs * ((args.names || []).length || 1);
    if (op === 'push') return this.timeoutMs * 4;
    return this.timeoutMs;
  }

  call(op, args = {}) {
    const run = () => new Promise((resolve, reject) => {
      if (process.platform !== 'win32') return reject(new PhoneError('no-windows', 'Phone sync over the cable needs Windows.'));
      clearTimeout(this.idleTimer);
      const p = this.helper();
      const id = ++this.seq;
      const timer = setTimeout(() => {
        // A request that outlasts its time: the helper may be stuck in the shell - start afresh.
        if (p.waiting && p.waiting.id === id) {
          p.waiting = null;
          if (this.proc === p) this.proc = null;
          try { p.kill(); } catch (_) { /* gone already */ }
          reject(new PhoneError('timeout', `The phone did not answer (${op}) - unplug it, plug it back in and sync again.`));
        }
      }, this.limitOf(op, args));
      p.waiting = {
        id,
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      p.stdin.write(`${JSON.stringify({ ...args, id, op })}\n`);
    });
    const done = this.queue.then(run, run);
    this.queue = done.catch(() => {}).then(() => {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.close(), this.idleMs);
      this.idleTimer.unref?.();
    });
    return done;
  }

  close() {
    clearTimeout(this.idleTimer);
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.stdin.end(); } catch (_) { /* gone already */ } }
  }

  async devices() { return (await this.call('devices')).devices || []; }
  async list(device, segs) { return (await this.call('list', { device, path: segs })).items || []; }
  async pull(device, segs, names, dest) { await this.call('pull', { device, path: segs, names, dest }); }
  async push(device, src, segs) { await this.call('push', { device, src, path: segs }); }
  async mkdir(device, segs, name) { await this.call('mkdir', { device, path: segs, name }); }
}

/* A folder standing in for a phone: devices maps each name to its folder. */
export class FolderTransport {
  constructor(devices) { this.map = devices; }
  dir(device, segs) {
    if (!(device in this.map)) throw new PhoneError('mtp', `${device} is not attached.`);
    const d = path.join(this.map[device], ...segs);
    if (!fs.existsSync(d)) throw new PhoneError('mtp', `No folder ${segs.join('/')} on ${device}.`);
    return d;
  }
  async devices() { return Object.keys(this.map).map((name) => ({ name })); }
  async list(device, segs) {
    const d = this.dir(device, segs);
    return fs.readdirSync(d, { withFileTypes: true }).map((e) => {
      const st = fs.statSync(path.join(d, e.name));
      return { name: e.name, folder: e.isDirectory(), size: e.isDirectory() ? 0 : st.size, modified: st.mtime.toISOString() };
    });
  }
  async pull(device, segs, names, dest) {
    const d = this.dir(device, segs);
    for (const n of names) fs.copyFileSync(path.join(d, n), path.join(dest, n));
  }
  async push(device, src, segs) { fs.cpSync(src, path.join(this.dir(device, segs), path.basename(src)), { recursive: true }); }
  async mkdir(device, segs, name) { fs.mkdirSync(path.join(this.dir(device, segs), name), { recursive: true }); }
}
