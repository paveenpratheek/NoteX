/* Bronze: what the user drops, kept exactly as it arrived (t-1c0fff1756).
 *
 *   <data>/bronze/blobs/<kind>/<ab>/<sha256><ext>   the bytes, once per content
 *   <data>/bronze/drops.jsonl                        what happened to each drop
 *   <data>/bronze/erasures.jsonl                     what the user had forgotten
 *
 * A drop is text, Markdown, a PDF, a Word file or an image, checked at the
 * door to be what its name says (t-dbb33d26b4). Its bytes are stored once by
 * sha256: the same content dropped again is a second drop sharing the blob
 * (t-48e622a449). A drop waits until the user picks the agent canvas it goes
 * to; there the agent places it (t-85f3ec23ef).
 *
 * drops.jsonl only grows - landed, canvas chosen, status - and a drop's state
 * is its lines folded in order (t-b631349744). Forgetting is the one
 * exception: the drop's lines are removed and its blob deleted unless another
 * drop shares it, and erasures.jsonl keeps the id, the kind and the two times,
 * never a name, a note or a hash (t-8017606f01, t-72e36660e5).
 *
 * Every call reads the log again, so the engine and the command line see the
 * same drops.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { IMAGE_EXT } from './images.js';

export const KINDS = ['text', 'md', 'pdf', 'docx', 'image'];
export const STATUSES = ['waiting', 'queued', 'placing', 'placed', 'failed'];

const BY_EXT = { '.txt': 'text', '.md': 'md', '.markdown': 'md', '.pdf': 'pdf', '.docx': 'docx' };
for (const e of IMAGE_EXT) BY_EXT[e] = 'image';

export class BronzeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* A drop's kind by its file name, or null for a kind bronze does not take. */
export function kindOf(name) { return BY_EXT[path.extname(name || '').toLowerCase()] || null; }

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ascii = (buf, from, to) => buf.subarray(from, to).toString('latin1');

/* The extension the blob is kept under when buf really is that kind, else
 * null. An image's extension comes from its bytes, not its name, so one
 * picture named .jpg and .jpeg is one blob. */
export function sniff(kind, buf) {
  switch (kind) {
    case 'image':
      if (buf.subarray(0, 8).equals(PNG)) return '.png';
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
      if (ascii(buf, 0, 4) === 'GIF8') return '.gif';
      if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return '.webp';
      return null;
    case 'pdf': return buf.subarray(0, 1024).includes('%PDF-') ? '.pdf' : null;
    // A Word file is a ZIP whose central directory names word/document.xml.
    case 'docx': return buf.subarray(0, 4).equals(ZIP) && buf.includes('word/document.xml') ? '.docx' : null;
    case 'text': case 'md':
      if (buf.includes(0)) return null;
      try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { return null; }
      return kind === 'md' ? '.md' : '.txt';
    default: return null;
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function readLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* a line cut short by a crash */ }
  }
  return out;
}

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class Bronze {
  constructor(dataDir, { now = Date.now } = {}) {
    if (!dataDir) throw new BronzeError('no-data-dir', 'Bronze needs the data folder.');
    this.dir = path.join(dataDir, 'bronze');
    this.log = path.join(this.dir, 'drops.jsonl');
    this.erasures = path.join(this.dir, 'erasures.jsonl');
    this.now = now;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  at() { return new Date(this.now()).toISOString(); }

  append(file, rec) {
    // A last line cut short by a crash is ended first, so it never swallows this one.
    try {
      const st = fs.statSync(file);
      if (st.size) {
        const fd = fs.openSync(file, 'r');
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, st.size - 1);
        fs.closeSync(fd);
        if (last[0] !== 0x0a) fs.appendFileSync(file, '\n');
      }
    } catch (_) { /* no file yet */ }
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  }

  /* Every drop's state, by id, with any forget cut short finished first. */
  state() {
    const drops = new Map();
    for (const e of readLines(this.log)) {
      if (e.ev === 'landed') drops.set(e.id, { id: e.id, kind: e.kind, blob: e.blob, bytes: e.bytes, name: e.name, via: e.via, note: e.note, canvas: null, status: 'waiting', detail: null, landedAt: e.at, updatedAt: e.at });
      const d = drops.get(e.id);
      if (!d) continue;
      if (e.ev === 'canvas') Object.assign(d, { canvas: e.canvas, status: 'queued', detail: null, updatedAt: e.at });
      if (e.ev === 'status') Object.assign(d, { status: e.status, detail: e.detail, updatedAt: e.at });
    }
    // The erasure is written before anything is removed (t-0057e4703e).
    const unfinished = readLines(this.erasures).filter((r) => drops.has(r.id));
    for (const r of unfinished) this.erase(drops, r.id);
    return drops;
  }

  need(drops, id) {
    const d = drops.get(id);
    if (!d) throw new BronzeError('no-drop', `No drop ${id} in the inbox.`);
    return d;
  }

  /* Takes one drop: a file's bytes and its name, or text the user typed. */
  land({ bytes = null, name = null, text = null, via = 'drop', note = null, canvas = null } = {}) {
    let kind;
    if (text != null) {
      if (bytes != null) throw new BronzeError('two-things', 'A drop is a file or text, not both.');
      bytes = Buffer.from(String(text), 'utf8');
      kind = 'text';
      name = null;
    } else {
      if (!Buffer.isBuffer(bytes)) throw new BronzeError('no-bytes', 'A file drop needs its bytes.');
      kind = kindOf(name);
      if (!kind) throw new BronzeError('kind', `${name || 'This file'} is not text, Markdown, a PDF, a Word file or a PNG, JPEG, WebP or GIF image.`);
    }
    if (!bytes.length || (kind === 'text' && !bytes.toString('utf8').trim())) throw new BronzeError('empty', `${name || 'The text'} is empty.`);
    const ext = sniff(kind, bytes);
    if (!ext) throw new BronzeError('not-kind', `${name || 'The text'} is not what its name says: its bytes are not ${kind === 'md' ? 'Markdown' : kind === 'docx' ? 'a Word file' : kind === 'pdf' ? 'a PDF' : kind === 'image' ? 'an image' : 'text'}.`);

    const sha = sha256(bytes);
    const blob = `blobs/${kind}/${sha.slice(0, 2)}/${sha}${ext}`;
    const abs = path.join(this.dir, blob);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      writeAtomic(abs, bytes);
    }
    const id = 'd-' + crypto.randomBytes(5).toString('hex');
    const at = this.at();
    this.append(this.log, { ev: 'landed', id, at, kind, blob, bytes: bytes.length, name: name ? path.basename(name) : null, via, note: note || null });
    if (canvas) this.append(this.log, { ev: 'canvas', id, at, canvas });
    return this.get(id);
  }

  /* Every drop, newest first. */
  list() { return [...this.state().values()].sort((a, b) => b.landedAt.localeCompare(a.landedAt) || a.id.localeCompare(b.id)); }

  get(id) { return { ...this.need(this.state(), id) }; }

  /* Where a drop's bytes are on disk. */
  file(id) { return path.join(this.dir, this.need(this.state(), id).blob); }

  /* The user picks the canvas a drop goes to: now, or later for one waiting.
   * A drop being placed or already placed keeps its canvas. */
  choose(id, canvas) {
    const d = this.need(this.state(), id);
    if (!canvas) throw new BronzeError('no-canvas', 'Pick the canvas the drop goes to.');
    if (d.status === 'placing' || d.status === 'placed') throw new BronzeError('placed', `${id} is ${d.status} on ${d.canvas}; it keeps that canvas.`);
    this.append(this.log, { ev: 'canvas', id, at: this.at(), canvas });
    return this.get(id);
  }

  /* Placement reports how a drop is getting on. */
  mark(id, status, detail = null) {
    const d = this.need(this.state(), id);
    if (!STATUSES.includes(status)) throw new BronzeError('status', `"${status}" is not a drop status.`);
    if (status !== 'waiting' && !d.canvas) throw new BronzeError('no-canvas', `${id} has no canvas yet.`);
    this.append(this.log, { ev: 'status', id, at: this.at(), status, detail });
    return this.get(id);
  }

  /* The user forgets a drop: it leaves bronze for good. */
  forget(id) {
    const drops = this.state();
    const d = this.need(drops, id);
    this.append(this.erasures, { id, kind: d.kind, landedAt: d.landedAt, erasedAt: this.at() });
    return this.erase(drops, id);
  }

  erase(drops, id) {
    const d = drops.get(id);
    drops.delete(id);
    const kept = readLines(this.log).filter((e) => e.id !== id);
    writeAtomic(this.log, kept.map((e) => JSON.stringify(e) + '\n').join(''));
    const shared = [...drops.values()].some((x) => x.blob === d.blob);
    if (!shared) fs.rmSync(path.join(this.dir, d.blob), { force: true });
    return { id, blob: shared ? 'shared' : 'deleted' };
  }
}
