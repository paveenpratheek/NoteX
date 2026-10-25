/* Read images: the step that asks RAGX what a fabric's images say. It is a
 * step of its own, pressed by the user, so opening a fabric never waits on
 * readings and building works with RAGX stopped (t-6b38e0dc27). Each image
 * is asked about once - by its sha256, however many times it is placed -
 * and two go at a time, as many as RAGX reads at once. Each says how many
 * are still to come, so RAGX starts a spare reader for the next while one
 * is read (RAGX's t-df9b7a8cf6). */
import fs from 'node:fs';
import { readFabric } from './fabric.js';
import { buildPlaces } from './places.js';
import { fabricImages, Readings } from './images.js';
import { ragxFolder, ragxRuntime, readImage } from './ragx.js';

export const READ_AT_ONCE = 2;

export async function readFabricImages(dir, { dataDir, ragx = null, atOnce = READ_AT_ONCE, onProgress = () => {}, runtime = null } = {}) {
  const fabric = readFabric(dir);
  const model = buildPlaces(fabric);
  const readings = new Readings(dataDir);
  const images = fabricImages(model, fabric, { dataDir, readings });
  const todo = [];
  const seen = new Set();
  for (const im of images) {
    if (seen.has(im.sha) || readings.get(im.sha)) continue;
    seen.add(im.sha);
    todo.push(im);
  }
  const result = { fabric: fabric.name, images: images.length, toRead: todo.length, read: 0, failed: [], stopped: null };
  if (!todo.length) return result;

  const rt = runtime || ragxRuntime(ragxFolder(ragx));
  let next = 0;
  onProgress({ done: 0, total: todo.length, failed: 0 });
  const worker = async () => {
    while (next < todo.length && !result.stopped) {
      const im = todo[next++];
      const name = im.file.name || 'image';
      try {
        const buf = im.path ? fs.readFileSync(im.path) : im.buf;
        readings.put(im.sha, await readImage(rt, buf, name, { ahead: todo.length - next }));
        result.read++;
      } catch (e) {
        // RAGX gone or out of Claude: the rest would fail the same way, so stop asking.
        if (['ragx-down', 'limit', 'not-logged-in'].includes(e.code) || /usage limit|not logged in/i.test(e.message)) result.stopped = e.message;
        else result.failed.push({ name, error: e.message });
      }
      onProgress({ done: result.read, total: todo.length, failed: result.failed.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, todo.length) }, worker));
  return result;
}
