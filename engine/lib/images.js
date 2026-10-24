/* A fabric's images as files with their readings.
 *
 * Every image NoteX writes into a document is a file an agent can open and
 * RAGX's page can show: the copy File Fabric keeps in the fabric's sources/,
 * or - for an image that exists only as a data URL inside fabric.json -
 * a copy NoteX saves once to <data>/images/<sha256>.<ext> (t-a8841a0bee).
 *
 * What each image says is read by RAGX (Haiku) through its read route and
 * kept in <data>/readings.json by the image's sha256, so an image is asked
 * about once; building a document only uses kept readings (t-6b38e0dc27).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* Where one image on a fabric is, and its bytes' sha256 - or null for one
 * with no file and no data (a YouTube thumbnail is a web address). */
export function resolveImage(fabric, file, dataDir = null) {
  const f = (fabric.state.files || []).find((x) => x.id === file.id) || {};
  const name = file.name || f.name || 'image';
  if (fabric.dir && fabric.sources && fabric.sources.has(name) && IMAGE_EXT.includes(path.extname(name).toLowerCase())) {
    const p = path.join(fabric.dir, 'sources', name);
    try { return { path: p, sha: sha(fs.readFileSync(p)), saved: false }; } catch (_) { /* gone since the fabric was read */ }
  }
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(f.imageDataUrl || '');
  if (!m || !EXT[m[1]]) return null;
  const buf = Buffer.from(m[2], 'base64');
  const key = sha(buf);
  if (!dataDir) return { path: null, sha: key, saved: false, buf };
  const p = path.join(dataDir, 'images', key + EXT[m[1]]);
  if (!fs.existsSync(p)) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
  return { path: p, sha: key, saved: true };
}

export class Readings {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, 'readings.json') : null;
    this.map = {};
    if (this.file) { try { this.map = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { /* none yet */ } }
  }
  get(key) { return this.map[key] || null; }
  put(key, r) {
    this.map[key] = { kind: r.kind || null, text: r.text || '', description: r.description || '', model: r.model || null, at: new Date().toISOString() };
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.map, null, 1));
      fs.renameSync(tmp, this.file);
    }
  }
}

/* Every image placed on the fabric, with where it is and its reading. */
export function fabricImages(model, fabric, { dataDir = null, readings = null } = {}) {
  const out = [];
  for (const p of model.places.values()) {
    for (const file of p.files) {
      if (file.kind !== 'image') continue;
      const at = resolveImage(fabric, file, dataDir);
      file.image = at ? { path: at.path, sha: at.sha, reading: readings ? readings.get(at.sha) : null } : null;
      if (at) out.push({ place: p, file, ...at });
    }
  }
  return out;
}
