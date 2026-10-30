/* Forgetting a drop everywhere NoteX keeps it (t-8017606f01, t-985017e732):
 *
 *   1. out of every totem script that names it, now and its good copy;
 *   2. the canvas drawn again, so fabric.json no longer holds it - and the
 *      render's drop list takes it out of RAGX (t-7513cdd783);
 *   3. its copy in the canvas's sources/, unless another item uses that name;
 *   4. the writer's backups of that canvas that hold its words or its name;
 *   5. NoteX's reading of it, if it is an image;
 *   6. bronze: its blob (unless another drop shares it) and its log lines,
 *      with an erasure record that keeps nothing of it.
 *
 * Bronze goes last, so a forget cut short can be run again. A drop being
 * placed at that moment waits (t-2598836a0f). What RAGX keeps in its own
 * caches is not reached yet (t-46b2ef9539).
 */
import fs from 'node:fs';
import path from 'node:path';
import { isAgentCanvas } from './agentcanvas.js';
import { Readings } from './images.js';
import { BronzeError } from './bronze.js';
import { textHtml } from './layout.js';

export async function forgetDrop(id, { bronze, writer, agent, dataDir }) {
  const d = bronze.get(id);
  if (d.status === 'placing') throw new BronzeError('placing', `${d.name || 'This drop'} is being placed by the agent right now - forget it once it is placed.`);
  const report = { id, canvas: d.canvas, totems: [], sources: [], backups: 0, reading: false, blob: null };
  const file = bronze.file(id);
  const words = d.kind === 'text' || d.kind === 'md' ? fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').trim() : null;

  let fabricDir = null;
  try { fabricDir = d.canvas ? writer.canvasDir(d.canvas) : null; } catch (_) { /* no workspace */ }
  if (fabricDir && isAgentCanvas(fabricDir)) {
    report.totems = agent.removeDrop(d.canvas, id);
    if (report.totems.length) {
      const r = await writer.serial(() => agent.render(d.canvas));
      if (r === null) throw new BronzeError('busy', `${d.canvas} changed while it was being drawn - forget ${d.name || 'the drop'} again.`);
      // Its copy in sources/, once nothing on the canvas shows a file of that name.
      const st = JSON.parse(fs.readFileSync(path.join(fabricDir, 'fabric.json'), 'utf8'));
      const used = new Set(((st.data || st).files || []).map((f) => f.name));
      if (d.name && !used.has(d.name)) {
        const copy = path.join(fabricDir, 'sources', d.name);
        if (fs.existsSync(copy)) { fs.rmSync(copy); report.sources.push(d.name); }
      }
    }
    // The writer's backups that hold it: its words as fabric.json stores them, or its file's name.
    const backups = path.join(dataDir, 'scripts', 'backups', d.canvas);
    // A note keeps the words as they are, a text as HTML.
    const marks = [words && JSON.stringify(words).slice(1, -1), words && JSON.stringify(textHtml(words)).slice(1, -1), d.name && JSON.stringify(d.name)].filter(Boolean);
    let names = [];
    try { names = fs.readdirSync(backups); } catch (_) { /* none */ }
    for (const n of names) {
      const f = path.join(backups, n);
      if (marks.some((m) => fs.readFileSync(f, 'utf8').includes(m))) { fs.rmSync(f); report.backups++; }
    }
  }
  if (d.kind === 'image') report.reading = new Readings(dataDir).delete(path.basename(file).replace(/\.[^.]+$/, ''));
  report.blob = bronze.forget(id).blob;
  return report;
}
