/* File Fabric's placement rules, ported for the one case NoteX needs them:
 * a value fabric.json is missing. Everywhere else NoteX takes what File
 * Fabric saved, because its placement depends on things never written down
 * - the page showing when an item was dropped, the dashboard being edited,
 * locked items it skips (t-819ff85db2). These run as File Fabric would with
 * no dashboard open. */
import { areaBBox, areaSize, itemBBox, distToBBox, bboxDistance, isPointInPolygon, polygonsOf } from './geometry.js';

/* recalculateItemLinks' area pass, script.js L3107: the parent is the
 * smallest other area holding every one of this area's points. A dashboard
 * box is a parent only of what already names it. */
export function parentAreaOf(a, areas, boxes = new Map()) {
  const box = (x) => { if (!boxes.has(x)) boxes.set(x, areaBBox(x)); return boxes.get(x); };
  const pts = polygonsOf(a).flat();
  if (!pts.length) return null;
  const aBB = box(a);
  const hits = [];
  for (const other of areas) {
    if (other.id === a.id) continue;
    if (other.type === 'dashboard_box' && a.parentAreaId !== other.id) continue;
    const oBB = box(other);
    if (aBB.minX < oBB.minX || aBB.maxX > oBB.maxX || aBB.minY < oBB.minY || aBB.maxY > oBB.maxY) continue;
    const polys = polygonsOf(other);
    if (pts.every((pt) => polys.some((p) => isPointInPolygon(pt, p)))) hits.push(other);
  }
  hits.sort((x, y) => areaSize(x) - areaSize(y));
  return hits[0] || null;
}

/* findAssignedArea, script.js L3223: the smallest area under a point. It
 * does not look at scroll-box pages - see t-4ae2f0da80. */
export function assignedAreaOf(point, item, areas, boxes = new Map()) {
  const hits = [];
  for (const area of areas) {
    if (area.type === 'dashboard_box' && (!item || item.areaId !== area.id)) continue;
    if (!boxes.has(area)) boxes.set(area, areaBBox(area));
    const bb = boxes.get(area);
    if (point.x < bb.minX || point.x > bb.maxX || point.y < bb.minY || point.y > bb.maxY) continue;
    if (polygonsOf(area).some((p) => isPointInPolygon(point, p))) hits.push(area);
  }
  hits.sort((a, b) => areaSize(a) - areaSize(b));
  return hits[0] || null;
}

export const FIELD = 500;
export const CHAIN = 300;

/* computeMagneticClusters, script.js L6659: everything within 500 of a
 * totem joins it, the first totem in the list first; then anything within
 * 300 of a member joins that member's totem, outward like a flood.
 * Returns item -> totem for every item that joined one. */
export function magneticTotems(state) {
  const items = [...(state.areas || []), ...(state.drawings || []), ...(state.files || [])];
  const datas = items.map((item) => ({ item, bbox: itemBBox(item), totem: null })).filter((d) => d.bbox !== null);
  const queue = [];
  for (const totem of state.totems || []) {
    for (const d of datas) {
      if (d.totem) continue;
      if (distToBBox(totem.x, totem.y, d.bbox) <= FIELD) { d.totem = totem; queue.push(d); }
    }
  }
  while (queue.length) {
    const current = queue.shift();
    for (const d of datas) {
      if (d.totem) continue;
      if (bboxDistance(current.bbox, d.bbox) <= CHAIN) { d.totem = current.totem; queue.push(d); }
    }
  }
  const out = new Map();
  for (const d of datas) if (d.totem) out.set(d.item, d.totem);
  return out;
}
