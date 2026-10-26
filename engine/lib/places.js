/* A fabric as a tree of places: fabric > totem > area > sub-area, with
 * scroll-box pages as places of their own, and every note, file, text and
 * pen stroke filed in the place that holds it. Each place gets one address,
 * the names from the top of the tree down to it, which is what the document
 * writes as its heading (t-015826b047).
 *
 * Nesting, pages and totems come from what File Fabric saved in fabric.json;
 * its rules are run only where a value is missing (t-819ff85db2).
 */
import path from 'node:path';
import { itemCenter, areaBBox, itemBBox, distToBBox, bboxDistance, direction } from './geometry.js';
import { parentAreaOf, assignedAreaOf, magneticTotems, FIELD } from './rules.js';
import { checklist, reachedNotes, wiresOf } from './wires.js';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function kindOf(area) {
  if (area.isBook) return 'book';
  if (area.isFolder || area.type === 'folder') return 'folder';
  if (area.isScrollBox) return 'scroll';
  if (area.isNote) return 'note';
  return 'area';
}

/* Text drawings hold HTML (t-73219962ab): line breaks kept, tags dropped. */
export function plainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fileKind(f) {
  if (f.isYoutube) return 'YouTube video';
  if (f.isPdf) return 'PDF';
  if (f.isImage) return 'image';
  return 'file';
}

/* Drawings File Fabric actually draws and NoteX reads (t-4290d1388a): text,
 * and pen strokes of two points or more. Shape drawings typed draw, select,
 * pan or delete, and one-point strokes, are never shown (t-25e97379de);
 * lines are wires, not contents. */
function readable(d) {
  if (d.type === 'text') return Boolean(plainText(d.text));
  if (d.type === 'path') return Array.isArray(d.points) && d.points.length >= 2;
  return false;
}

export function buildPlaces(fabric) {
  const state = fabric.state || {};
  const areas = state.areas || [];
  const areaById = new Map(areas.map((a) => [a.id, a]));
  const totemById = new Map((state.totems || []).map((t) => [t.id, t]));
  const boxes = new Map();
  let magnets = null;
  const left = { deletedPages: 0, inBooksOrFolders: 0, hidden: 0, unshown: 0 };

  /* The totem File Fabric saved on an item, or the one its field rule gives
   * when nothing was saved. */
  const totemOf = (item) => {
    if (has(item, 'linkedTotemId')) return totemById.get(item.linkedTotemId) || null;
    magnets = magnets || magneticTotems(state);
    return magnets.get(item) || null;
  };

  const places = new Map();
  const add = (p) => {
    places.set(p.id, { children: [], files: [], texts: [], textByAgent: [], textIds: [], pens: 0, neighbours: [], wires: [], reach: null, ...p });
    return places.get(p.id);
  };
  const root = add({ id: 'fabric', kind: 'fabric', name: fabric.name, parent: null });
  let canvas = null;
  const canvasPlace = () => canvas || (canvas = add({ id: 'canvas', kind: 'canvas', name: 'Open canvas', parent: root.id }));
  for (const t of state.totems || []) add({ id: `totem:${t.id}`, kind: 'totem', name: t.name, parent: root.id, totem: t, bbox: itemBBox(t) });

  /* A scroll box's page as a place, numbered by its position: pages have
   * only an id (t-99b50f0667). null when the page was deleted - File Fabric
   * never shows what was on it again, so neither does NoteX (t-2bd2129505). */
  const pagePlace = (box, pageId) => {
    const i = (box.pages || []).findIndex((p) => p.id === pageId);
    if (i < 0) return null;
    return `page:${box.id}:${box.pages[i].id}`;
  };

  // Which place each area hangs from, settled once per area.
  const settled = new Map(); // area id -> place id | null (left out)
  const settling = new Set();
  const settle = (a) => {
    if (settled.has(a.id)) return settled.get(a.id);
    if (settling.has(a.id)) return null; // a parent cycle: leave it out
    settling.add(a.id);
    const result = (() => {
      const kind = kindOf(a);
      if (kind === 'book' || kind === 'folder') { left.inBooksOrFolders++; return null; }
      let parent;
      if (has(a, 'parentAreaId')) parent = a.parentAreaId ? areaById.get(a.parentAreaId) || null : null;
      else parent = parentAreaOf(a, areas, boxes);
      let under;
      if (!parent) {
        const t = totemOf(a);
        under = t ? `totem:${t.id}` : root.id;
      } else {
        const pk = kindOf(parent);
        if (pk === 'book' || pk === 'folder') { left.inBooksOrFolders++; return null; }
        if (settle(parent) === null) return null;
        if (pk === 'scroll') {
          under = pagePlace(parent, a.scrollBoxPageId);
          if (!under) { left.deletedPages++; places.get(parent.id).deletedPageItems++; return null; }
        } else under = parent.id;
      }
      const bbox = areaBBox(a);
      const p = add({ id: a.id, kind, name: a.name, parent: under, area: a, bbox });
      if (kind === 'scroll') {
        p.deletedPageItems = 0;
        p.layout = a.layout || null;
        (a.pages || []).forEach((pg, i) => add({ id: `page:${a.id}:${pg.id}`, kind: 'page', name: `Page ${i + 1}`, parent: a.id, page: i + 1, of: a.pages.length, bbox }));
      }
      if (kind === 'note') p.checklist = checklist(a.textContent);
      return p.id;
    })();
    settling.delete(a.id);
    settled.set(a.id, result);
    return result;
  };
  for (const a of areas) settle(a);

  /* Where an item sits: the area File Fabric saved on it, or the smallest
   * area under it; a scroll box's page by its saved page id; outside every
   * area, its totem's field or the open canvas. */
  const placeFor = (item, isDrawing) => {
    let area;
    if (has(item, 'areaId')) area = item.areaId ? areaById.get(item.areaId) || null : null;
    else area = assignedAreaOf(itemCenter(item, isDrawing), item, areas, boxes);
    if (!area) {
      const t = totemOf(item);
      return t ? `totem:${t.id}` : canvasPlace().id;
    }
    const at = settle(area);
    if (at === null) { left.inBooksOrFolders++; return null; }
    if (kindOf(area) === 'scroll') {
      const pg = pagePlace(area, item.scrollBoxPageId);
      if (!pg) { left.deletedPages++; places.get(area.id).deletedPageItems++; return null; }
      return pg;
    }
    return at;
  };

  for (const f of state.files || []) {
    if (f.isHidden) { left.hidden++; continue; }
    const at = placeFor(f, false);
    if (!at) continue;
    const inSources = fabric.sources ? fabric.sources.has(f.name) : null;
    // Where File Fabric keeps its copy, so an agent can open the file where it sits (t-f6bb073bcf).
    const copy = inSources && fabric.dir ? path.join(fabric.dir, 'sources', f.name) : null;
    places.get(at).files.push({ id: f.id, name: f.name, kind: fileKind(f), url: f.isYoutube ? f.youtubeUrl || null : null, inSources, path: copy });
  }
  const NEVER_DRAWN = new Set(['path', 'draw', 'select', 'pan', 'delete']);
  for (const d of state.drawings || []) {
    if (!readable(d)) { if (NEVER_DRAWN.has(d.type)) left.unshown++; continue; }
    const at = placeFor(d, true);
    if (!at) continue;
    if (d.type === 'text') {
      places.get(at).texts.push(plainText(d.text));
      // Which texts an agent wrote, so the rules file can leave them out (t-74338c1615).
      places.get(at).textByAgent.push(d.writtenBy === 'agent');
      // Which drawing each text is, so a read-out can name it for <Edit id>.
      places.get(at).textIds.push(d.id);
    } else places.get(at).pens++;
  }

  // The tree, children in reading order: top to bottom, then left to right.
  for (const p of places.values()) if (p.parent) places.get(p.parent).children.push(p.id);
  const order = (ids) => ids.sort((x, y) => {
    const a = places.get(x), b = places.get(y);
    if (a.kind === 'page' && b.kind === 'page') return a.page - b.page;
    if ((a.kind === 'canvas') !== (b.kind === 'canvas')) return a.kind === 'canvas' ? 1 : -1;
    if ((a.kind === 'totem') !== (b.kind === 'totem')) return a.kind === 'totem' ? -1 : 1;
    const ab = a.bbox, bb = b.bbox;
    if (!ab || !bb) return 0;
    return (ab.minY - bb.minY) || (ab.minX - bb.minX);
  });

  /* Labels and addresses, from the top down. Siblings with one name get
   * [2], [3] so every address names one place (t-7ca4b882b0). */
  const SUFFIX = { totem: ' (totem)', note: ' (note)', scroll: ' (scroll box)' };
  const labelBase = (p) => {
    const name = String(p.name || '').replace(/\s+/g, ' ').trim();
    if (p.kind === 'page' || p.kind === 'canvas') return name;
    const fallback = p.kind === 'note' ? 'Untitled' : p.kind === 'totem' ? 'Unnamed' : 'Unnamed area';
    return (name || fallback) + (SUFFIX[p.kind] || '');
  };
  const walk = (p, parts) => {
    order(p.children);
    const seen = new Map();
    for (const id of p.children) {
      const c = places.get(id);
      const base = labelBase(c);
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      c.label = n > 1 ? `${base} [${n}]` : base;
      c.parts = [...parts, c.label];
      c.address = c.parts.join(' > ');
      walk(c, c.parts);
    }
  };
  root.label = root.name;
  root.parts = [];
  root.address = '';
  walk(root, []);

  // Totem: the outermost place's, in its field or reached through neighbours (t-626487dfe8).
  for (const p of places.values()) {
    if (p.kind === 'fabric' || p.kind === 'totem' || p.kind === 'canvas') continue;
    let top = p;
    while (top.parent && places.get(top.parent).kind !== 'totem' && places.get(top.parent).kind !== 'fabric') top = places.get(top.parent);
    const owner = top.parent && places.get(top.parent).kind === 'totem' ? places.get(top.parent) : null;
    p.totemId = owner ? owner.id : null;
    if (owner && top === p && p.bbox) p.totemVia = distToBBox(owner.totem.x, owner.totem.y, p.bbox) <= FIELD ? 'field' : 'neighbours';
  }

  // Neighbours: the nearest three places beside it under the same parent.
  const AREAISH = new Set(['area', 'note', 'scroll']);
  for (const p of places.values()) {
    if (!AREAISH.has(p.kind)) continue;
    const sibs = places.get(p.parent).children.map((id) => places.get(id)).filter((s) => s !== p && AREAISH.has(s.kind));
    p.neighbours = sibs
      .map((s) => ({ id: s.id, distance: bboxDistance(p.bbox, s.bbox), dir: direction(p.bbox, s.bbox) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3)
      .map(({ id, dir, distance }) => ({ id, dir, distance: Math.round(distance) }));
  }

  // Wires, and the notes each wired place reaches along them (t-a4504d0c13).
  const included = new Set([...places.values()].filter((p) => p.area).map((p) => p.id));
  const wires = wiresOf(state, included);
  for (const w of wires) {
    places.get(w.from).wires.push({ id: w.to, via: w.via, corner: w.fromCorner || null, otherCorner: w.toCorner || null });
    places.get(w.to).wires.push({ id: w.from, via: w.via, corner: w.toCorner || null, otherCorner: w.fromCorner || null });
  }
  for (const p of places.values()) {
    if (!p.wires.length || !p.area || !p.area.polygons) continue;
    const notes = reachedNotes(p.id, state).filter((n) => places.has(n.id));
    if (!notes.length || (notes.length === 1 && notes[0].id === p.id)) continue;
    const each = notes.map((n) => ({ id: n.id, ...places.get(n.id).checklist }));
    p.reach = { notes: each, done: each.reduce((s, n) => s + n.done, 0), total: each.reduce((s, n) => s + n.total, 0) };
  }

  return { fabric: { name: fabric.name, dir: fabric.dir || null, modified: fabric.modified || null }, root, places, wires, left };
}

/* The places in document order: depth first from the top. */
export function inOrder(model) {
  const out = [];
  const visit = (p) => { out.push(p); for (const id of p.children) visit(model.places.get(id)); };
  visit(model.root);
  return out;
}
