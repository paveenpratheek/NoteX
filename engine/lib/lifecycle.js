/* What the engine leaves beside the plugin page while it serves, as RAGX's
 * engine does (t-e1b1aaaa28):
 *
 *   plugin/runtime.json   where the page finds the engine and its token
 *   plugin/local.json     where this copy of the engine lives, so the page
 *                         can start it - a page served at /plugins/notex/
 *                         cannot learn its own folder
 *
 * Both are git-ignored and served by ter-manager from the plugin folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname, which keeps %20 for spaces.
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function writeLocal(file) {
  const info = { repo: REPO, cli: path.join(REPO, 'engine', 'cli.js'), node: process.execPath, writtenAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(info, null, 2));
  return info;
}

/* Written at start, removed at stop - but only if it still names this
 * process, so a second engine's file is never removed by the first. */
export function writeRuntime(file, info) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(info, null, 2));
  return () => {
    try {
      const now = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (now.pid === info.pid) fs.rmSync(file, { force: true });
    } catch (_) { /* gone already */ }
  };
}
