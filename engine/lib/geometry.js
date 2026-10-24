/* File Fabric's own geometry, ported from its script.js so NoteX places
 * things exactly where the canvas shows them (t-819ff85db2). Each function
 * keeps the original's behaviour, odd corners included - a "fix" here would
 * put NoteX and File Fabric out of step. The script.js line each one comes
 * from is beside it. */

// isPointInPolygon, script.js L3471 - even-odd ray cast.
export function isPointInPolygon(point, vs) {
  const x = point.x, y = point.y;
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i].x, yi = vs[i].y;
    const xj = vs[j].x, yj = vs[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// getPolygonArea, script.js L682 - shoelace; under three points is 0.
export function polygonArea(polygon) {
  if (!polygon || polygon.length < 3) return 0;
  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += (polygon[j].x * polygon[i].y) - (polygon[i].x * polygon[j].y);
  }
  return Math.abs(area / 2);
}

/* An area's outline as File Fabric keeps it: drawn areas hold polygons (one
 * area can be several), scroll boxes and dashboard boxes hold points. */
export function polygonsOf(area) {
  if (area.polygons) return area.polygons.filter(Boolean);
  if (area.points) return [area.points];
  return [];
}

// getAreaSize, script.js L691.
export function areaSize(area) {
  let total = 0;
  for (const p of polygonsOf(area)) total += polygonArea(p);
  return total;
}

// getAreaBBox, script.js L702.
export function areaBBox(area) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polygonsOf(area)) {
    for (const pt of poly) {
      if (pt.x < minX) minX = pt.x; if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x; if (pt.y > maxY) maxY = pt.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

// getItemBBox, script.js L6473 - areas, sized items, files, radius, points.
export function itemBBox(item) {
  if (item.polygons || item.points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const poly of item.polygons || [item.points]) {
      if (!poly) continue;
      for (const pt of poly) {
        if (pt.x < minX) minX = pt.x; if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x; if (pt.y > maxY) maxY = pt.y;
      }
    }
    return { minX, minY, maxX, maxY };
  }
  if (item.w !== undefined && item.h !== undefined) {
    return { minX: item.x, minY: item.y, maxX: item.x + item.w, maxY: item.y + item.h };
  }
  if (item.fileName !== undefined || item.isYoutube) {
    const w = item.imageWidth || 150;
    const h = item.imageHeight || 150;
    return { minX: item.x, minY: item.y, maxX: item.x + w, maxY: item.y + h };
  }
  if (item.radius !== undefined) {
    return { minX: item.x - item.radius, minY: item.y - item.radius, maxX: item.x + item.radius, maxY: item.y + item.radius };
  }
  if (item.x !== undefined && item.y !== undefined) {
    return { minX: item.x, minY: item.y, maxX: item.x + 100, maxY: item.y + 50 };
  }
  return null;
}

// getItemCenter, script.js L3090 - a file's "centre" is its x, y; a pen
// stroke's is its first point, so a stroke belongs where it was started.
export function itemCenter(item, isDrawing = false) {
  if (!isDrawing) return { x: item.x, y: item.y };
  if (item.x !== undefined && item.y !== undefined) return { x: item.x, y: item.y };
  if (item.start && item.end) return { x: (item.start.x + item.end.x) / 2, y: (item.start.y + item.end.y) / 2 };
  if (item.points && item.points.length > 0) return { x: item.points[0].x, y: item.points[0].y };
  return { x: 0, y: 0 };
}

// distToBBox, script.js L6505.
export function distToBBox(px, py, bbox) {
  if (!bbox) return Infinity;
  const dx = Math.max(bbox.minX - px, 0, px - bbox.maxX);
  const dy = Math.max(bbox.minY - py, 0, py - bbox.maxY);
  return Math.hypot(dx, dy);
}

// bboxDistance, script.js L6512.
export function bboxDistance(b1, b2) {
  if (!b1 || !b2) return Infinity;
  const dx = Math.max(b1.minX - b2.maxX, 0, b2.minX - b1.maxX);
  const dy = Math.max(b1.minY - b2.maxY, 0, b2.minY - b1.maxY);
  return Math.hypot(dx, dy);
}

export function inArea(point, area) {
  for (const p of polygonsOf(area)) if (isPointInPolygon(point, p)) return true;
  return false;
}

export function bboxCenter(b) {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/* Which way b lies from a, in the words a person would use looking at the
 * canvas: File Fabric's y grows downward, so a smaller y is "above". */
export function direction(a, b) {
  const ca = bboxCenter(a), cb = bboxCenter(b);
  const dx = cb.x - ca.x, dy = cb.y - ca.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'below' : 'above';
}
