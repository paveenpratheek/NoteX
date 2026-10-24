/* Reading File Fabric's workspace from disk. A workspace is a folder of
 * fabrics; a fabric is a folder holding fabric.json (the whole canvas, as
 * File Fabric's state), thumbnail.jpg and sources/ (copies of the files
 * dropped on it). NoteX only reads them - File Fabric is never changed
 * (t-f483d80a4d). */
import fs from 'node:fs';
import path from 'node:path';

export class FabricError extends Error {
  constructor(code, message) { super(message); this.name = 'FabricError'; this.code = code; }
}

export function isFabric(dir) {
  try { return fs.statSync(path.join(dir, 'fabric.json')).isFile(); } catch (_) { return false; }
}

/* The fabrics in a workspace, newest first. */
export function listFabrics(workspace) {
  let entries;
  try { entries = fs.readdirSync(workspace, { withFileTypes: true }); } catch (e) {
    throw new FabricError('no-workspace', `Cannot read the workspace folder ${workspace}: ${e.code || e.message}`);
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(workspace, e.name);
    let st;
    try { st = fs.statSync(path.join(dir, 'fabric.json')); } catch (_) { continue; }
    out.push({ name: e.name, dir, modified: st.mtime.toISOString(), size: st.size });
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

export function readFabric(dir) {
  const file = path.join(dir, 'fabric.json');
  let text, st;
  try { text = fs.readFileSync(file, 'utf8'); st = fs.statSync(file); } catch (e) {
    throw new FabricError('not-found', `No fabric at ${dir}: ${e.code || e.message}`);
  }
  let state;
  // File Fabric saves on a timer, so a read can land mid-write; say so plainly.
  try { state = JSON.parse(text); } catch (e) {
    throw new FabricError('bad-json', `${file} is not whole JSON (File Fabric may be saving it): ${e.message}`);
  }
  let sources = null;
  try { sources = new Set(fs.readdirSync(path.join(dir, 'sources'))); } catch (_) { /* a fabric with no files */ }
  return { name: path.basename(dir), dir, modified: st.mtime.toISOString(), state, sources };
}
