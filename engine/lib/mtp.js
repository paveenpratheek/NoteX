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

export class ShellTransport {
  constructor({ powershell = 'powershell.exe', script = MTP_PS1, timeoutMs = 30 * 60_000 } = {}) {
    Object.assign(this, { powershell, script, timeoutMs });
  }

  call(op, args = {}) {
    return new Promise((resolve, reject) => {
      if (process.platform !== 'win32') return reject(new PhoneError('no-windows', 'Phone sync over the cable needs Windows.'));
      const p = spawn(this.powershell, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-Op', op], { windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => { p.kill(); reject(new PhoneError('timeout', `The phone did not answer (${op}).`)); }, this.timeoutMs);
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => { clearTimeout(timer); reject(new PhoneError('no-powershell', `Could not start PowerShell: ${e.message}`)); });
      p.on('close', () => {
        clearTimeout(timer);
        let r;
        try { r = JSON.parse(out.replace(/^﻿/, '')); } catch (_) { return reject(new PhoneError('mtp', `The phone helper answered nothing readable${err ? `: ${err.trim().slice(0, 300)}` : '.'}`)); }
        if (!r.ok) return reject(new PhoneError('mtp', r.error || 'The phone helper failed.'));
        resolve(r);
      });
      p.stdin.end(JSON.stringify(args));
    });
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
