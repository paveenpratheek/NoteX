/* What links carry: a note's checklist, and the notes a chain of links
 * reaches. Progress is read from the notes themselves, never from progress
 * bars - a bar only shows what its notes hold (t-a4504d0c13). */
import { isPointInPolygon, areaSize, inArea } from './geometry.js';

/* The counts File Fabric's progress bars show, with its own patterns
 * (script.js L7518): "- [x]" done, "- [ ]" not, case and spacing loose. */
export function checklist(text) {
  const s = text || '';
  const done = (s.match(/-\s*\[x\]/gi) || []).length;
  const open = (s.match(/-\s*\[\s\]/gi) || []).length;
  return { done, total: done + open };
}

/* getLinkedNotesForProgressBar's walk, script.js L7101-7180, from one area:
 * the notes inside it (by their first corner), the areas a Line-tool line
 * leads to from it, and the areas its links join, outward until nothing new.
 * It reads only areas with polygons, so scroll boxes and dashboard boxes,
 * which store points, are never walked (t-c69c06b0c5). Notes come back
 * sorted by id, as File Fabric sorts them. */
export function reachedNotes(startId, state) {
  const areas = state.areas || [];
  const byId = new Map(areas.map((a) => [a.id, a]));
  const lines = (state.drawings || []).filter((d) => d.type === 'line' && d.start && d.end);
  const links = state.links || [];
  const notes = [];
  const visited = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const currentId = queue.shift();
    const current = byId.get(currentId);
    if (!current) continue;
    if (current.isNote && !notes.some((n) => n.id === currentId)) notes.push(current);
    if (current.polygons) {
      for (const inner of areas) {
        if (!inner.isNote || inner.id === currentId || visited.has(inner.id) || !inner.polygons) continue;
        if (current.polygons.some((p) => isPointInPolygon(inner.polygons[0][0], p))) {
          visited.add(inner.id);
          queue.push(inner.id);
        }
      }
    }
    for (const d of lines) {
      let startIn = false, endIn = false;
      if (current.polygons) {
        for (const p of current.polygons) {
          if (isPointInPolygon(d.start, p)) startIn = true;
          if (isPointInPolygon(d.end, p)) endIn = true;
        }
      }
      if (startIn === endIn) continue;
      const other = startIn ? d.end : d.start;
      for (const o of areas) {
        if (o.id === currentId || visited.has(o.id) || !o.polygons) continue;
        if (o.polygons.some((p) => isPointInPolygon(other, p))) { visited.add(o.id); queue.push(o.id); }
      }
    }
    for (const link of links) {
      const otherId = link.fromAreaId === currentId ? link.toAreaId : link.toAreaId === currentId ? link.fromAreaId : null;
      if (otherId && !visited.has(otherId)) { visited.add(otherId); queue.push(otherId); }
    }
  }
  return notes.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/* The notes a progress bar shows, as File Fabric picks them (script.js
 * L7931-7997): the walk from the smallest area under the bar's corner; the
 * note its targetNoteId names when the walk reaches it; else, alone in that
 * area, every note reached, or among several bars the note at its place
 * top to bottom. A read-out says which note each bar shows (t-abc2613a64). */
export function barNotes(bar, state) {
  const areas = (state.areas || []).filter((a) => a.polygons);
  const under = (pt) => areas.filter((a) => a.polygons.some((p) => isPointInPolygon(pt, p)));
  const hits = under({ x: bar.x, y: bar.y }).sort((a, b) => areaSize(a) - areaSize(b));
  const parent = hits[0];
  if (!parent) return { area: null, notes: [] };
  const reached = reachedNotes(parent.id, state);
  if (!reached.length) return { area: parent, notes: [] };
  const target = bar.targetNoteId && reached.find((n) => n.id === bar.targetNoteId);
  if (target) return { area: parent, notes: [target] };
  const peers = (state.drawings || []).filter((d) => d.type === 'progress_bar' && parent.polygons.some((p) => isPointInPolygon({ x: d.x, y: d.y }, p))).sort((a, b) => a.y - b.y);
  if (peers.length === 1) return { area: parent, notes: reached };
  const i = peers.findIndex((d) => d.id === bar.id);
  return { area: parent, notes: [i < reached.length ? reached[i] : reached[reached.length - 1]] };
}

/* The wires to write beside a place: every link, and every Line-tool line
 * whose ends sit in two different areas, neither holding the other end -
 * a line drawn inside one area is a drawing, not a wire. An end's area is
 * the smallest one under it. */
export function wiresOf(state, included) {
  const areas = (state.areas || []).filter((a) => included.has(a.id));
  const smallestAt = (pt) => {
    const hits = areas.filter((a) => inArea(pt, a));
    hits.sort((x, y) => areaSize(x) - areaSize(y));
    return hits[0] || null;
  };
  const wires = [];
  for (const link of state.links || []) {
    if (included.has(link.fromAreaId) && included.has(link.toAreaId) && link.fromAreaId !== link.toAreaId) {
      wires.push({ id: link.id, from: link.fromAreaId, to: link.toAreaId, via: 'link', fromCorner: link.fromCorner || null, toCorner: link.toCorner || null });
    }
  }
  for (const d of state.drawings || []) {
    if (d.type !== 'line' || !d.start || !d.end) continue;
    const a = smallestAt(d.start), b = smallestAt(d.end);
    if (!a || !b || a.id === b.id || inArea(d.end, a) || inArea(d.start, b)) continue;
    wires.push({ id: d.id, from: a.id, to: b.id, via: 'line' });
  }
  return wires;
}
