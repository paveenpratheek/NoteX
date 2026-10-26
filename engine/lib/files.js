/* The files on a canvas RAGX can read as documents of their own, each with
 * the place it sits at (phase 4, t-b4cbaafd49).
 *
 * NoteX lists them in <canvas>.files.json beside the canvas's document -
 * name, content hash, address and the path of File Fabric's copy in
 * sources/ - and RAGX reads each one where it is, nothing copied
 * (t-99b4d2b864). Images are not listed: they are read by Haiku and written
 * into the document itself (t-a4bf938570).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inOrder } from './places.js';

// What RAGX's extractors read, images aside.
export const READABLE = ['.pdf', '.docx', '.md', '.markdown', '.txt', '.text'];

/* A file's hash, worked out again only when its size or modified time
 * changed: a canvas is built after every save, and a PDF can be large. */
const hashes = new Map(); // path -> { size, mtimeMs, sha256 }
function hashOf(file) {
  const st = fs.statSync(file);
  const known = hashes.get(file);
  if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) return known.sha256;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  hashes.set(file, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
  return sha256;
}

export function canvasFiles(model) {
  const files = [];
  for (const p of inOrder(model)) {
    for (const f of p.files) {
      if (!f.path || !READABLE.includes(path.extname(f.name || '').toLowerCase())) continue;
      let sha256;
      try { sha256 = hashOf(f.path); } catch (_) { continue; } // gone since the fabric was read
      files.push({ name: f.name, sha256, address: p.address || '', path: f.path, kind: f.kind });
    }
  }
  return { canvas: model.fabric.name, files };
}
