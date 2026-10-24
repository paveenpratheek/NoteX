/* NoteX asking RAGX to read an image. RAGX's engine runs beside NoteX's;
 * where it listens and its token are in RAGX's plugin/runtime.json, written
 * each time it starts. A request from Node sends no Origin, and RAGX takes
 * one without; its read route is RAGX's own decision, on record in Project
 * Harness's GitX. */
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './lifecycle.js';

export class RagxError extends Error {
  constructor(code, message) { super(message); this.name = 'RagxError'; this.code = code; }
}

/* RAGX's plugin folder: the one given, else Project Harness beside NoteX. */
export function ragxFolder(given = null) {
  return path.resolve(given || path.join(REPO, '..', 'Project Harness', 'plugin'));
}

export function ragxRuntime(folder) {
  const file = path.join(folder, 'runtime.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {
    throw new RagxError('ragx-down', `RAGX's engine is not running (no ${file}) - start it from the RAGX page, then read the images again.`);
  }
}

export async function readImage(rt, buf, name) {
  let res;
  try {
    res = await fetch(rt.url + '/api/read-image', {
      method: 'POST',
      headers: { 'x-rag-token': rt.token, 'x-rag-client': 'notex', 'x-file-name': encodeURIComponent(name), 'content-type': 'application/octet-stream' },
      body: buf,
    });
  } catch (_) {
    throw new RagxError('ragx-down', `RAGX's engine at ${rt.url} is not answering - start it from the RAGX page.`);
  }
  if (!res.ok) {
    let err = {};
    try { err = (await res.json()).error || {}; } catch (_) {}
    throw new RagxError(err.code || String(res.status), `RAGX could not read ${name}: ${err.message || res.status}`);
  }
  return res.json();
}
