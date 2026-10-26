/* Laying out a totem script on a canvas: NoteX works out every size and
 * position from what is already there, the real sizes of images and files,
 * the user's margins and the overlap check; the script gives only content
 * and what is inside what (t-12859aa2fb, t-56e10f6d09).
 *
 * Sizes go from the inside out. Children stack top to bottom, left edges
 * aligned; <Row> sets them side by side with tops aligned; <Column> stacks
 * them inside a Row. A new totem goes into free space more than 800 px
 * beyond everything on the canvas, so File Fabric's 500 px field and 300 px
 * chain never join it to another (t-a94b02f199). <Add> places new items
 * below what a place already holds and grows the place and its parents,
 * pushing aside only the agent's own items - a user's item in the way
 * refuses the script, since NoteX never moves the user's items
 * (t-2afecbd70b).
 *
 * Every function here changes the state it is given - the writer hands it
 * a copy - and refuses with a Refusal naming the script line it was about.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildPlaces, kindOf } from './places.js';
import { polygonsOf, bboxDistance, distToBBox } from './geometry.js';
import { CHAIN, FIELD } from './rules.js';
import { M, measureText, measureNote, fileSize, imageSize, imageShown, isImageName, isPdfName, visualBox, textOf } from './measure.js';
import { checkCanvas, overlapsOf } from './check.js';

export const FREE = 800;

export class Refusal extends Error {
  constructor(message, node = null) {
    super(node ? `Line ${node.line}, column ${node.col}: ${message}` : message);
    this.name = 'Refusal';
    this.code = 'refused';
    this.line = node ? node.line : null;
    this.reason = message;
  }
}

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const union = (bs) => bs.filter(Boolean).reduce((u, b) => (u ? { minX: Math.min(u.minX, b.minX), minY: Math.min(u.minY, b.minY), maxX: Math.max(u.maxX, b.maxX), maxY: Math.max(u.maxY, b.maxY) } : { ...b }), null);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

export function newIds() {
  let n = 0;
  return () => `${Date.now()}${(n++).toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/* Words as a text drawing keeps them: File Fabric shows its text as HTML. */
export const textHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

/* --------------------------------------------------------------- scene */

/* A canvas as items with boxes and containers, for moving things without
 * losing what holds what. A container is an area's id, a scroll box's page
 * ("page:<box>:<page>"), a totem ("totem:<id>") or the canvas. */
export class Scene {
  constructor(state) {
    this.state = state;
    this.model = buildPlaces({ name: 'canvas', state });
    this.items = [];
    this.byId = new Map();
    for (const a of state.areas || []) if (!['book', 'folder'].includes(kindOf(a))) this.add(a, 'area');
    for (const d of state.drawings || []) this.add(d, 'drawing');
    for (const f of state.files || []) if (!f.isHidden) this.add(f, 'file');
    for (const t of state.totems || []) this.add(t, 'totem');
  }

  add(item, kind) { const e = { item, kind }; this.items.push(e); this.byId.set(item.id, e); return e; }

  box(e) { return visualBox(e.item, e.kind); }

  /* What holds an item: buildPlaces' answer for areas; the saved areaId
   * and page for drawings and files, else their totem. */
  containerOf(e) {
    if (e.kind === 'totem') return null;
    if (e.kind === 'area') {
      const p = this.model.places.get(e.item.id);
      return p ? p.parent : 'fabric';
    }
    const it = e.item;
    if (it.areaId && this.byId.has(it.areaId)) {
      const holder = this.byId.get(it.areaId).item;
      return holder.isScrollBox && it.scrollBoxPageId ? `page:${holder.id}:${it.scrollBoxPageId}` : holder.id;
    }
    return it.linkedTotemId ? `totem:${it.linkedTotemId}` : 'canvas';
  }

  /* The containers above an item, nearest first. */
  chain(e) {
    const out = [];
    let key = this.containerOf(e);
    while (key) {
      out.push(key);
      if (key.startsWith('page:')) key = key.split(':')[1];
      else if (key.startsWith('totem:') || key === 'fabric' || key === 'canvas') { if (key !== 'fabric') out.push('fabric'); break; }
      else { const c = this.byId.get(key); key = c ? this.containerOf(c) : null; }
    }
    return out;
  }

  totemOf(e) {
    if (e.kind === 'totem') return e.item;
    const t = this.chain(e).find((k) => k.startsWith('totem:'));
    return t ? this.byId.get(t.slice(6))?.item || null : null;
  }

  children(key) { return this.items.filter((e) => e.kind !== 'totem' && this.containerOf(e) === key); }

  /* The area (or scroll box) a container key draws as. */
  holder(key) {
    if (!key || key.startsWith('totem:') || key === 'fabric' || key === 'canvas') return null;
    return this.byId.get(key.startsWith('page:') ? key.split(':')[1] : key) || null;
  }

  /* Moves an item and, for an area, everything inside it. */
  shift(e, dx, dy) {
    const moved = [e];
    if (e.kind === 'area') for (const o of this.items) if (o !== e && this.chain(o).some((k) => k === e.item.id || k.startsWith(`page:${e.item.id}:`))) moved.push(o);
    for (const o of moved) move(o.item, dx, dy);
    return moved;
  }
}

function move(it, dx, dy) {
  const p = (pt) => { pt.x += dx; pt.y += dy; };
  if (it.polygons) it.polygons.forEach((poly) => poly && poly.forEach(p));
  if (it.points) it.points.forEach(p);
  if (it.start) p(it.start);
  if (it.end) p(it.end);
  if (typeof it.x === 'number' && !it.points) { it.x += dx; it.y += dy; }
}

/* A box NoteX can grow: one rectangle, as NoteX draws them. */
function setRect(item, b) {
  const pts = rect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
  if (item.points) item.points = pts; else item.polygons = [pts];
}
function isRect(item) {
  const polys = polygonsOf(item);
  if (polys.length !== 1 || polys[0].length !== 4) return false;
  const xs = new Set(polys[0].map((p) => p.x)), ys = new Set(polys[0].map((p) => p.y));
  return xs.size === 2 && ys.size === 2;
}

const describe = (scene, e) => {
  const p = scene.model.places.get(e.item.id);
  if (p) return `"${p.address}"`;
  if (e.kind === 'file') return `the file ${e.item.name}`;
  if (e.item.type === 'text') return `the text "${textOf(e.item).split('\n')[0].slice(0, 40)}"`;
  if (e.kind === 'totem') return `the totem ${e.item.name}`;
  return `a ${e.item.type || e.kind}`;
};

/* Makes room for an item whose box grew from old to what it is now: the
 * things beside it in the same container that it now crowds are pushed
 * right or down to keep their gap, and its container grows to hold them,
 * up to the totem. Only what may change is pushed (t-2afecbd70b,
 * t-bfe8ec5d8f). */
export function settle(scene, e, old, opts, touched) {
  const queue = [{ e, old }];
  const key = scene.containerOf(e);
  const sibs = scene.children(key).filter((s) => !(s.kind === 'drawing' && s.item.type === 'line'));
  while (queue.length) {
    const { e: m, old: mOld } = queue.shift();
    const mb = scene.box(m);
    const grewX = mb.maxX > mOld.maxX + 0.5, grewY = mb.maxY > mOld.maxY + 0.5 || mb.minY !== mOld.minY;
    for (const s of sibs) {
      if (s === m) continue;
      const sb = scene.box(s);
      if (!sb) continue;
      const before = bboxDistance(mOld, sb);
      if (bboxDistance(mb, sb) >= Math.min(before, M.ROW_GAP) - 0.5) continue;
      const toRight = sb.minX >= mOld.maxX - 4, below = sb.minY >= mOld.maxY - 4;
      const right = grewX && toRight && (!below || !grewY);
      // The gap they had, up to a Row's: a totem's 60 px between boxes stays 60 px.
      const g = Math.min(M.ROW_GAP, right ? sb.minX - mOld.maxX : sb.minY - mOld.maxY);
      const gap = Math.max(g, 4);
      const dx = right ? mb.maxX + gap - sb.minX : 0;
      const dy = right ? 0 : mb.maxY + gap - sb.minY;
      if (dx <= 0 && dy <= 0) continue;
      const why = opts.mayChange(s.item, s.kind);
      if (why) throw new Refusal(`making room for ${describe(scene, e)} would push ${describe(scene, s)}, which ${why}. NoteX never moves the user's items.`, opts.node);
      const sOld = { ...sb };
      for (const o of scene.shift(s, dx, dy)) touched.add(o.item.id);
      queue.push({ e: s, old: sOld });
    }
  }
  const holder = scene.holder(key);
  if (holder) {
    const hb = scene.box(holder);
    const need = union(scene.children(key).map((c) => scene.box(c)));
    const grown = { ...hb, maxX: Math.max(hb.maxX, need.maxX + M.SIDE), maxY: Math.max(hb.maxY, need.maxY + M.BOTTOM) };
    if (grown.maxX > hb.maxX + 0.5 || grown.maxY > hb.maxY + 0.5) {
      const why = opts.mayChange(holder.item, holder.kind);
      if (why) throw new Refusal(`${describe(scene, holder)} would have to grow to hold it, and it ${why}.`, opts.node);
      if (!isRect(holder.item)) throw new Refusal(`${describe(scene, holder)} is not a rectangle NoteX can grow.`, opts.node);
      setRect(holder.item, grown);
      touched.add(holder.item.id);
      settle(scene, holder, hb, opts, touched);
    }
  } else if (key && key.startsWith('totem:')) {
    keepApart(scene, key.slice(6), touched, opts);
  }
}

/* What an agent's totem grew into must stay clear of every other totem:
 * outside the 500 px field of another totem and the 300 px chain of its
 * items, so File Fabric never counts one totem's things as another's
 * (t-d65b7d40dc). */
function keepApart(scene, totemId, ids, opts) {
  const mine = (e) => e.item.id === totemId || scene.totemOf(e)?.id === totemId;
  const others = scene.items.filter((e) => !mine(e));
  for (const id of ids) {
    const e = scene.byId.get(id);
    if (!e || !mine(e)) continue;
    const b = scene.box(e);
    if (!b) continue;
    for (const o of others) {
      const ob = scene.box(o);
      if (!ob) continue;
      const close = o.kind === 'totem' ? distToBBox(o.item.x, o.item.y, b) <= FIELD : bboxDistance(b, ob) <= CHAIN;
      if (close) throw new Refusal(`it would bring ${describe(scene, e)} within File Fabric's ${o.kind === 'totem' ? `${FIELD} px field of` : `${CHAIN} px of`} ${describe(scene, o)}, outside this totem. NoteX never moves the user's items.`, opts.node);
    }
  }
}

/* ------------------------------------------------------- script nodes */

/* A <File>: a full path on this machine, copied into the canvas's
 * sources/ - or a name already there. File Fabric loads images and PDFs
 * from sources/ by name, so fabric.json carries no image data
 * (t-348b2f13f4). */
function resolveFile(node, opts) {
  const given = node.attrs.path;
  const sources = opts.fabricDir ? path.join(opts.fabricDir, 'sources') : null;
  let src = null, name;
  if (path.isAbsolute(given)) {
    if (!fs.existsSync(given) || !fs.statSync(given).isFile()) throw new Refusal(`no file at ${given}.`, node);
    src = given;
    name = path.basename(given);
  } else {
    name = given;
    if (/[\\/]/.test(given) || !sources || !fs.existsSync(path.join(sources, given))) {
      throw new Refusal(`"${given}" is neither a full path to a file nor a file already in the canvas's sources folder.`, node);
    }
  }
  let copy = null;
  if (src && sources) {
    const there = path.join(sources, name);
    if (fs.existsSync(there)) {
      const same = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      if (same(there) !== same(src)) throw new Refusal(`a different file called ${name} is already on this canvas - rename yours.`, node);
    } else copy = { from: src, name };
  }
  const file = src || path.join(sources, name);
  const isImage = isImageName(name), isPdf = isPdfName(name);
  const shown = isImage ? imageShown(imageSize(file)) : null;
  return { name, isImage, isPdf, shown, copy };
}

function measure(node, ctx) {
  const content = node.children ? node.children.filter((c) => c.tag !== 'Line' && c.tag !== 'Link') : [];
  switch (node.tag) {
    case 'Text': node.size = measureText(node.text, { size: node.attrs.size || M.FONT, maxWidth: ctx.textMax }); break;
    case 'Note': node.size = measureNote(node.text); break;
    case 'File': {
      node.file = resolveFile(node, ctx.opts);
      const f = node.file;
      node.size = fileSize({ name: f.name, isImage: f.isImage, imageWidth: f.isImage ? f.shown.w : 200, imageHeight: f.isImage ? f.shown.h : null });
      break;
    }
    case 'Row': {
      const sizes = content.map((c) => measure(c, ctx));
      node.size = { w: sizes.reduce((s, z) => s + z.w, 0) + M.ROW_GAP * Math.max(0, sizes.length - 1), h: Math.max(0, ...sizes.map((z) => z.h)) };
      break;
    }
    case 'Area': case 'Page': case 'Column': case 'Totem': case 'Add': {
      const gap = node.tag === 'Totem' ? M.TOTEM_GAP : M.GAP;
      const sizes = content.map((c) => measure(c, ctx));
      const inner = { w: Math.max(0, ...sizes.map((z) => z.w)), h: sizes.reduce((s, z) => s + z.h, 0) + gap * Math.max(0, sizes.length - 1) };
      node.inner = inner;
      node.size = node.tag === 'Area'
        ? { w: Math.max(M.AREA_MIN_W, inner.w + 2 * M.SIDE), h: Math.max(M.AREA_MIN_H, M.TOP + inner.h + M.BOTTOM) }
        : inner;
      break;
    }
    case 'ScrollBox': {
      const pages = node.children.map((p) => measure(p, ctx));
      node.size = { w: Math.max(M.SCROLL_MIN_W, Math.max(0, ...pages.map((z) => z.w)) + 2 * M.SIDE), h: Math.max(M.SCROLL_MIN_H, M.TOP + Math.max(0, ...pages.map((z) => z.h)) + M.BOTTOM) };
      break;
    }
    default: node.size = { w: 0, h: 0 };
  }
  return node.size;
}

function place(node, x, y) {
  node.at = { x, y };
  const content = node.children ? node.children.filter((c) => c.tag !== 'Line' && c.tag !== 'Link') : [];
  if (node.tag === 'Row') {
    let cx = x;
    for (const c of content) { place(c, cx, y); cx += c.size.w + M.ROW_GAP; }
  } else if (['Column', 'Totem', 'Add', 'Page'].includes(node.tag)) {
    const gap = node.tag === 'Totem' ? M.TOTEM_GAP : M.GAP;
    let cy = y;
    for (const c of content) { place(c, x, cy); cy += c.size.h + gap; }
  } else if (node.tag === 'Area') {
    let cy = y + M.TOP;
    for (const c of content) { place(c, x + M.SIDE, cy); cy += c.size.h + M.GAP; }
  } else if (node.tag === 'ScrollBox') {
    for (const p of node.children) place(p, x + M.SIDE, y + M.TOP);
  }
}

/* The items a placed node writes, into the state: ctx says what holds them
 * (an area's id, a scroll box's page) and whose totem they are in. Every
 * item is marked as an agent's (t-1c8f677839). */
function emit(node, ctx, out) {
  const { state, opts } = ctx;
  const base = { writtenBy: 'agent' };
  const holder = { parentAreaId: ctx.areaId, scrollBoxPageId: ctx.pageId, linkedTotemId: ctx.totemId };
  const { x, y } = node.at || {};
  switch (node.tag) {
    case 'Area': case 'Note': case 'ScrollBox': {
      const id = opts.newId();
      let item;
      if (node.tag === 'ScrollBox') {
        node.pageIds = node.children.map(() => opts.newId());
        item = { id, name: node.attrs.name, type: 'scroll_box', isScrollBox: true, points: rect(x, y, node.size.w, node.size.h), layout: 'horizontal', pages: node.pageIds.map((pid) => ({ id: pid })), currentPageIndex: 0, ...holder, ...base };
      } else if (node.tag === 'Note') {
        item = { id, name: node.attrs.name, color: '#fff3c4', polygons: [rect(x, y, node.size.w, node.size.h)], containedFiles: [], isBook: false, isNote: true, textContent: node.text, ...holder, ...base };
      } else {
        item = { id, name: node.attrs.name, color: state.areaColor || '#4f46e5', polygons: [rect(x, y, node.size.w, node.size.h)], containedFiles: [], isBook: false, ...holder, ...base };
      }
      state.areas.push(item);
      node.id = id;
      node.chain = [...ctx.chain, id];
      node.labels = [...ctx.labels, node.attrs.name + (SUFFIX[node.tag] || '')];
      out.written.push(id);
      out.boxes.push({ id, address: node.labels.join(' > ') });
      if (node.tag === 'Area') for (const c of node.children) emit(c, { ...ctx, areaId: id, pageId: null, areaName: node.attrs.name, chain: node.chain, labels: node.labels }, out);
      if (node.tag === 'ScrollBox') {
        node.children.forEach((p, i) => {
          const key = `page:${id}:${node.pageIds[i]}`;
          for (const c of p.children) emit(c, { ...ctx, areaId: id, pageId: node.pageIds[i], areaName: node.attrs.name, chain: [...node.chain, key], labels: [...node.labels, `Page ${i + 1}`] }, out);
        });
      }
      return;
    }
    case 'Text': {
      const id = opts.newId();
      const light = String(state.fabricColor || '').toLowerCase() === '#ffffff';
      state.drawings.push({
        id, type: 'text', text: textHtml(node.text), color: light ? '#111111' : '#f8f9fa', fontFamily: 'Inter, sans-serif', fontSize: node.attrs.size || M.FONT,
        width: node.size.w, highlightColor: 'transparent', isBold: false, isItalic: false, textAlign: 'left', hasBorder: false,
        x, y, areaId: ctx.areaId, scrollBoxPageId: ctx.pageId, linkedTotemId: ctx.totemId, ...base,
      });
      out.written.push(id);
      out.texts.push({ id, text: node.text, address: ctx.labels.join(' > ') });
      return;
    }
    case 'File': {
      const id = opts.newId();
      const f = node.file;
      state.files.push({
        id, name: f.name, isImage: f.isImage, isPdf: f.isPdf, imageDataUrl: null,
        imageWidth: f.isImage ? f.shown.w : 200, imageHeight: f.isImage ? f.shown.h : null, pdfBlobUrl: null,
        areaId: ctx.areaId, areaName: ctx.areaName || 'Unassigned', scrollBoxPageId: ctx.pageId,
        x: x + node.size.w / 2, y: y + node.size.h / 2, linkedTotemId: ctx.totemId, ...base,
      });
      const holderArea = ctx.areaId && state.areas.find((a) => a.id === ctx.areaId);
      if (holderArea && Array.isArray(holderArea.containedFiles)) holderArea.containedFiles.push(id);
      if (f.copy) out.copies.push(f.copy);
      out.written.push(id);
      return;
    }
    case 'Row': case 'Column': case 'Totem': case 'Add': case 'Page':
      for (const c of node.children) if (c.tag !== 'Line' && c.tag !== 'Link') emit(c, ctx, out);
      return;
    default:
  }
}

// The labels buildPlaces gives a box in its address.
const SUFFIX = { Note: ' (note)', ScrollBox: ' (scroll box)' };

/* ---------------------------------------------------------------- wires */

/* Where a <Line> runs: from the edge of one box that faces the other, a
 * few pixels inside each, so File Fabric and NoteX both find its ends in
 * their boxes - in the side or bottom margin, never in a box inside. */
export function lineBetween(a, b) {
  const midY = (p) => (p.minY + p.maxY) / 2, midX = (p) => (p.minX + p.maxX) / 2;
  const IN = 3;
  const oy = [Math.max(a.minY, b.minY), Math.min(a.maxY, b.maxY)];
  const ox = [Math.max(a.minX, b.minX), Math.min(a.maxX, b.maxX)];
  const y = oy[0] < oy[1] ? (oy[0] + oy[1]) / 2 : null;
  const x = ox[0] < ox[1] ? (ox[0] + ox[1]) / 2 : null;
  if (b.minX >= a.maxX) return { start: { x: a.maxX - IN, y: y ?? midY(a) }, end: { x: b.minX + IN, y: y ?? midY(b) }, dir: 'right' };
  if (a.minX >= b.maxX) return { start: { x: a.minX + IN, y: y ?? midY(a) }, end: { x: b.maxX - IN, y: y ?? midY(b) }, dir: 'left' };
  if (b.minY >= a.maxY) return { start: { x: x ?? midX(a), y: a.maxY - IN }, end: { x: x ?? midX(b), y: b.minY + IN }, dir: 'below' };
  if (a.minY >= b.maxY) return { start: { x: x ?? midX(a), y: a.minY + IN }, end: { x: x ?? midX(b), y: b.maxY - IN }, dir: 'above' };
  return null;
}
const CORNERS = { right: ['tr', 'tl'], left: ['tl', 'tr'], below: ['bl', 'tl'], above: ['tl', 'bl'] };

/* Redraws a Line NoteX wrote between the two boxes it joins, after either moved. */
export function redrawLine(scene, line) {
  const [a, b] = (line.joins || []).map((id) => scene.byId.get(id));
  if (!a || !b) return false;
  const l = lineBetween(scene.box(a), scene.box(b));
  if (!l) return false;
  line.start = l.start;
  line.end = l.end;
  return true;
}

/* An end of a wire: a box in the script, or in an <Add> a place on the
 * canvas by its full address. Its chain is the containers from the totem
 * down to it, for finding what holds the wire. */
function wireEnd(node, k, ctx) {
  const box = node.ends[k];
  if (box) return { id: box.id, chain: box.chain, name: box.path.join(' > ') };
  const want = norm(node.attrs[k]);
  const p = [...ctx.scene.model.places.values()].find((q) => norm(q.address) === want && q.area);
  if (!p) throw new Refusal(`${k}="${node.attrs[k]}" names no box in this script and no area, note or scroll box on the canvas - give a box's name, or a place's full address.`, node);
  if (ctx.scene.totemOf(ctx.scene.byId.get(p.id))?.id !== ctx.totemId) throw new Refusal(`${k}="${node.attrs[k]}" is in another totem - wires join boxes inside one totem.`, node);
  const chain = [];
  for (let q = p; q && q.kind !== 'totem' && q.kind !== 'fabric'; q = ctx.scene.model.places.get(q.parent)) chain.unshift(q.id);
  return { id: p.id, chain: [`totem:${ctx.totemId}`, ...chain], name: p.address };
}

function emitWires(root, ctx, out) {
  const visit = (node) => {
    for (const c of node.children || []) {
      if (c.tag !== 'Line' && c.tag !== 'Link') { visit(c); continue; }
      const from = wireEnd(c, 'from', ctx), to = wireEnd(c, 'to', ctx);
      if (from.chain.includes(to.id) || to.chain.includes(from.id)) throw new Refusal(`<${c.tag}> joins "${from.name}" to a box inside it - a wire joins boxes side by side.`, c);
      let common = 0;
      while (common < from.chain.length - 1 && common < to.chain.length - 1 && from.chain[common] === to.chain[common]) common++;
      const holderKey = from.chain[common - 1];
      const pageOf = (ch) => ch.find((k) => k.startsWith('page:'));
      const pf = pageOf(from.chain.slice(common)), pt = pageOf(to.chain.slice(common));
      if (pf || pt) throw new Refusal(`<${c.tag}> joins a box on a scroll-box page to one outside that page.`, c);
      const fe = ctx.scene.byId.get(from.id), te = ctx.scene.byId.get(to.id);
      const fb = ctx.scene.box(fe), tb = ctx.scene.box(te);
      const l = lineBetween(fb, tb);
      if (!l) throw new Refusal(`<${c.tag}> joins "${from.name}" and "${to.name}", which overlap.`, c);
      const id = ctx.opts.newId();
      if (c.tag === 'Line') {
        let areaId = null, pageId = null;
        if (holderKey && holderKey.startsWith('page:')) [, areaId, pageId] = holderKey.split(':');
        else if (holderKey && !holderKey.startsWith('totem:')) areaId = holderKey;
        ctx.state.drawings.push({ id, type: 'line', color: ctx.state.areaColor || '#4f46e5', start: l.start, end: l.end, areaId, scrollBoxPageId: pageId, linkedTotemId: ctx.totemId, joins: [from.id, to.id], writtenBy: 'agent' });
      } else {
        const [fc, tc] = CORNERS[l.dir];
        ctx.state.links.push({ id, fromAreaId: from.id, fromCorner: fc, toAreaId: to.id, toCorner: tc, color: fe.item.color || ctx.state.areaColor || '#4f46e5', writtenBy: 'agent' });
      }
      out.written.push(id);
      out.wires.push({ id, via: c.tag === 'Line' ? 'line' : 'link', from: from.id, to: to.id });
    }
  };
  visit(root);
}

/* ------------------------------------------------------------ the forms */

function prepare(state) {
  for (const k of ['areas', 'drawings', 'files', 'links', 'totems']) if (!Array.isArray(state[k])) state[k] = [];
}

/* Without a ledger to ask, what an agent wrote may change and nothing else. */
const withDefaults = (opts = {}) => ({
  mayChange: (item) => (item.writtenBy === 'agent' ? null : "is the user's"),
  ...opts,
  newId: opts.newId || newIds(),
});

const output = () => ({ written: [], touched: new Set(), removed: [], boxes: [], texts: [], copies: [], wires: [], totemId: null });

/* The canvas before and after, through the overlap check: the layout's own
 * items - new, moved or grown - must be in no overlap the canvas did not
 * already have. */
function gate(before, state, out) {
  const after = checkCanvas(state, buildPlaces({ name: 'canvas', state }));
  const ids = new Set([...out.written, ...out.touched]);
  const bad = overlapsOf(after, ids, before);
  if (bad.length) throw new Refusal(`the layout would overlap: ${bad.map((f) => f.say).join('; ')}.`);
  // What the canvas already had is the user's to look at, not this layout's.
  out.check = { overlaps: 0, already: overlapsOf(after, new Set(after.flatMap((f) => f.ids)), []).length };
}

/* A new totem, in free space 800 px right of everything on the canvas
 * (t-a94b02f199, t-d65b7d40dc); a name already used is refused so every
 * address is the one promised, never a [2] (t-dcaabfd5f7). */
export function layoutTotem(parsed, state, opts) {
  opts = withDefaults(opts);
  prepare(state);
  const before = checkCanvas(state, buildPlaces({ name: 'canvas', state }));
  const name = parsed.totem.attrs.name;
  if ((state.totems || []).some((t) => norm(t.name) === norm(name))) throw new Refusal(`a totem called "${name}" is already on this canvas - give yours another name, or <Add> to it.`, parsed.totem);
  const scene = new Scene(state);
  const ctx = { state, opts, textMax: M.TEXT_WIDTH };
  const size = measure(parsed.totem, ctx);
  const all = union(scene.items.map((e) => scene.box(e)));
  const x = all ? all.maxX + FREE : 0;
  const y = all ? all.minY + M.TOTEM_ABOVE : 0;
  place(parsed.totem, x, y);
  const totemId = ctx.opts.newId();
  state.totems.push({ id: totemId, name, color: '#3b5a76', radius: 0, x: Math.round(x + Math.max(size.w, 1) / 2), y: y - M.TOTEM_ABOVE, isLocked: false, owner: opts.owner, writtenBy: 'agent' });
  const out = output();
  out.totemId = totemId;
  out.written.push(totemId);
  out.boxes.push({ id: `totem:${totemId}`, address: `${name} (totem)` });
  emit(parsed.totem, { state, opts: ctx.opts, areaId: null, pageId: null, totemId, chain: [`totem:${totemId}`], labels: [`${name} (totem)`] }, out);
  emitWires(parsed.totem, { state, opts: ctx.opts, totemId, scene: new Scene(state) }, out);
  gate(before, state, out);
  return out;
}


/* The place an <Add> names, checked: a totem, area or scroll-box page in
 * the agent's own totem, unedited by the user (t-ab2864c2a1). */
function findTarget(scene, parsed, opts) {
  const want = norm(parsed.at);
  const p = [...scene.model.places.values()].find((q) => norm(q.address) === want);
  if (!p) {
    const mine = [...scene.model.places.values()].filter((q) => q.kind === 'totem' && q.totem.owner === opts.owner).map((q) => `"${q.address}"`);
    throw new Refusal(`no place on ${parsed.canvas} has the address "${parsed.at}".${mine.length ? ` Your totems there: ${mine.join(', ')}.` : ''} notex_read shows every address.`, parsed.node);
  }
  if (p.kind === 'note') throw new Refusal(`"${p.address}" is a note, which holds text only - change its text with <Edit id>.`, parsed.node);
  if (p.kind === 'scroll') throw new Refusal(`"${p.address}" is a scroll box - add to one of its pages, e.g. "${p.address} > Page 1".`, parsed.node);
  if (!['totem', 'area', 'page'].includes(p.kind)) throw new Refusal(`"${p.address}" is not a place NoteX can add to.`, parsed.node);
  const totem = p.kind === 'totem' ? p.totem : scene.totemOf(scene.byId.get(p.kind === 'page' ? p.parent : p.id));
  if (!totem) throw new Refusal(`"${p.address}" is in no totem.`, parsed.node);
  if (totem.writtenBy !== 'agent' || !totem.owner) throw new Refusal(`"${p.address}" is in the user's totem ${totem.name} - an agent writes only in its own totem. Ask the user, or write a totem of your own.`, parsed.node);
  if (totem.owner !== opts.owner) throw new Refusal(`"${p.address}" is in the totem ${totem.name}, which belongs to ${totem.owner} - an agent changes only its own totem.`, parsed.node);
  return { p, totem };
}

export function layoutAdd(parsed, state, opts) {
  opts = withDefaults(opts);
  prepare(state);
  const before = checkCanvas(state, buildPlaces({ name: 'canvas', state }));
  const scene = new Scene(state);
  const { p, totem } = findTarget(scene, parsed, opts);
  const nopts = { ...opts, node: parsed.node };
  let key, holderE = null;
  if (p.kind === 'totem') key = `totem:${totem.id}`;
  else if (p.kind === 'page') { key = p.id; holderE = scene.byId.get(p.parent); } else { key = p.id; holderE = scene.byId.get(p.id); }
  if (holderE) {
    const why = opts.mayChange(holderE.item, holderE.kind);
    if (why) throw new Refusal(`"${p.address}" ${why}.`, parsed.node);
  }
  // New names beside the old must still give one address each (t-dcaabfd5f7).
  const existing = new Set(p.children.map((id) => scene.model.places.get(id)).filter((c) => c.kind !== 'page').map((c) => norm(c.name)));
  for (const b of parsed.boxes) if (b.path.length === 1 && existing.has(norm(b.attrs.name))) throw new Refusal(`"${p.address}" already holds something called "${b.attrs.name}" - give yours another name.`, b);

  const kids = scene.children(key);
  const kb = union(kids.map((e) => scene.box(e)));
  let x, y, textMax = M.TEXT_WIDTH;
  if (holderE) {
    const hb = scene.box(holderE);
    x = hb.minX + M.SIDE;
    y = kb ? kb.maxY + M.GAP : hb.minY + M.TOP;
    const room = hb.maxX - hb.minX - 2 * M.SIDE;
    if (room >= 200) textMax = Math.min(M.TEXT_WIDTH, room);
  } else {
    x = kb ? kb.minX : totem.x;
    y = kb ? kb.maxY + M.TOTEM_GAP : totem.y + M.TOTEM_ABOVE;
  }
  const ctx = { state, opts: nopts, textMax };
  measure(parsed.node, ctx);
  place(parsed.node, x, y);
  const out = output();
  const chain = p.kind === 'totem' ? [`totem:${totem.id}`] : [`totem:${totem.id}`, ...placeChain(scene, p)];
  const areaId = p.kind === 'totem' ? null : p.kind === 'page' ? p.parent : p.id;
  const pageId = p.kind === 'page' ? p.id.split(':')[2] : null;
  const areaName = areaId ? scene.byId.get(areaId).item.name : null;
  emit(parsed.node, { state, opts: nopts, areaId, pageId, areaName, totemId: totem.id, chain, labels: [p.address] }, out);
  out.totemId = totem.id;
  out.base = p.address;

  // Make room: the new items as one block that grew out of the place's old contents.
  const grown = new Scene(state);
  const newItems = out.written.map((id) => grown.byId.get(id)).filter((e) => e && grown.containerOf(e) === key);
  if (holderE) {
    const he = grown.byId.get(holderE.item.id);
    const hb = grown.box(he);
    const need = union(grown.children(key).map((e) => grown.box(e)));
    const target = { ...hb, maxX: Math.max(hb.maxX, need.maxX + M.SIDE), maxY: Math.max(hb.maxY, need.maxY + M.BOTTOM) };
    if (target.maxX > hb.maxX + 0.5 || target.maxY > hb.maxY + 0.5) {
      if (!isRect(he.item)) throw new Refusal(`"${p.address}" is not a rectangle NoteX can grow.`, parsed.node);
      setRect(he.item, target);
      out.touched.add(he.item.id);
      settle(grown, he, hb, nopts, out.touched);
    }
  } else keepApart(grown, totem.id, new Set(newItems.map((e) => e.item.id)), nopts);

  emitWires(parsed.node, { state, opts: nopts, totemId: totem.id, scene: new Scene(state) }, out);
  redrawLines(new Scene(state), out);
  gate(before, state, out);
  return out;
}

/* The containers from a totem down to a place, as Scene keys. */
function placeChain(scene, p) {
  const out = [];
  for (let q = p; q && q.kind !== 'totem' && q.kind !== 'fabric'; q = scene.model.places.get(q.parent)) out.unshift(q.id);
  return out;
}

/* Lines NoteX wrote follow the boxes they join when those moved. */
function redrawLines(scene, out) {
  for (const e of scene.items) {
    const l = e.item;
    if (l.type !== 'line' || !l.joins || l.writtenBy !== 'agent') continue;
    if (l.joins.some((id) => out.touched.has(id)) && redrawLine(scene, l)) out.touched.add(l.id);
  }
}

/* <Remove id>: an agent's own item off the canvas - a box or totem with
 * everything inside it, and every wire joining what goes. Refused whole if
 * any of it is the user's, edited by the user since it was written, or
 * another agent's (t-1ca15af044). Boxes left behind keep their size, and a
 * file's copy stays in sources/ (t-5d426facf3). */
function removeItem(state, node, parsed, opts, out) {
  const scene = new Scene(state);
  const id = node.attrs.id;
  const e = scene.byId.get(id);
  const link = e ? null : state.links.find((l) => l.id === id);
  if (!e && !link) throw new Refusal(`nothing on ${parsed.canvas} has the id ${id} - notex_read shows the ids.`, node);
  const address = (areaId) => scene.model.places.get(areaId)?.address || areaId;
  const say = (item) => (state.links.includes(item) ? `the link from "${address(item.fromAreaId)}" to "${address(item.toAreaId)}"` : describe(scene, scene.byId.get(item.id)));
  const anchor = e || scene.byId.get(link.fromAreaId);
  const totem = anchor ? scene.totemOf(anchor) : null;
  if (!totem || totem.writtenBy !== 'agent' || totem.owner !== opts.owner) {
    throw new Refusal(`${say(e ? e.item : link)} is ${totem && totem.owner ? `in ${totem.owner}'s totem ${totem.name}` : "the user's"} - an agent removes only from its own totem.`, node);
  }
  const going = new Set([id]);
  if (e && e.kind === 'totem') for (const o of scene.items) if (o !== e && scene.totemOf(o)?.id === id) going.add(o.item.id);
  if (e && e.kind === 'area') for (const o of scene.items) if (scene.chain(o).some((k) => k === id || k.startsWith(`page:${id}:`))) going.add(o.item.id);
  // The wires joining what goes would be left joining nothing.
  for (const l of state.links) if (going.has(l.fromAreaId) || going.has(l.toAreaId)) going.add(l.id);
  for (const d of state.drawings) if (d.type === 'line' && Array.isArray(d.joins) && d.joins.some((j) => going.has(j))) going.add(d.id);
  const all = [...state.areas, ...state.drawings, ...state.files, ...state.totems, ...state.links];
  for (const item of all) {
    if (!going.has(item.id)) continue;
    const why = opts.mayChange(item, scene.byId.get(item.id)?.kind || 'link');
    if (why) {
      const what = say(e ? e.item : link);
      throw new Refusal(item.id === id ? `${what} ${why} - it is not removed.` : `removing ${what} would take ${say(item)} with it, which ${why}. Nothing was removed.`, node);
    }
  }
  for (const k of ['areas', 'drawings', 'files', 'totems', 'links']) state[k] = state[k].filter((x) => !going.has(x.id));
  for (const a of state.areas) if (Array.isArray(a.containedFiles)) a.containedFiles = a.containedFiles.filter((f) => !going.has(f));
  for (const g of going) { out.removed.push(g); out.touched.delete(g); }
}

/* <Edit id>: new words for a text or note, or a new name for a box or
 * totem - only the agent's own, unedited by the user (t-ab2864c2a1). */
export function layoutEdits(parsed, state, opts) {
  opts = withDefaults(opts);
  prepare(state);
  const before = checkCanvas(state, buildPlaces({ name: 'canvas', state }));
  const out = output();
  for (const node of parsed.edits) {
    if (node.tag === 'Remove') { removeItem(state, node, parsed, opts, out); continue; }
    const scene = new Scene(state);
    const e = scene.byId.get(node.attrs.id);
    if (!e) throw new Refusal(`nothing on ${parsed.canvas} has the id ${node.attrs.id} - notex_read shows the ids.`, node);
    const totem = scene.totemOf(e);
    if (!totem || totem.writtenBy !== 'agent' || totem.owner !== opts.owner) {
      throw new Refusal(`${describe(scene, e)} is ${totem && totem.owner ? `in ${totem.owner}'s totem ${totem.name}` : "the user's"} - an agent changes only its own totem.`, node);
    }
    const why = opts.mayChange(e.item, e.kind);
    if (why) throw new Refusal(`${describe(scene, e)} ${why}.`, node);
    const it = e.item;
    if (node.attrs.name !== undefined) {
      if (!(e.kind === 'totem' || e.kind === 'area')) throw new Refusal(`${describe(scene, e)} has no name to change.`, node);
      if (!node.attrs.name) throw new Refusal('name="" leaves it without a name.', node);
      it.name = node.attrs.name;
      if (e.kind === 'area') for (const f of state.files) if (f.areaId === it.id) f.areaName = it.name;
      out.touched.add(it.id);
    }
    if (node.text) {
      const old = scene.box(e);
      if (it.type === 'text') {
        it.text = textHtml(node.text);
        delete it._calculatedHeight;
        delete it._calculatedWidth;
        const m = measureText(node.text, { size: it.fontSize || M.FONT, maxWidth: M.TEXT_WIDTH });
        it.width = Math.max(it.width || 0, m.w);
      } else if (e.kind === 'area' && it.isNote) {
        it.textContent = node.text;
        const m = measureNote(node.text, { width: old.maxX - old.minX });
        setRect(it, { ...old, maxY: Math.max(old.maxY, old.minY + m.h) });
      } else throw new Refusal(`${describe(scene, e)} holds no text of its own - <Add> a <Text> to it instead.`, node);
      out.touched.add(it.id);
      settle(scene, e, old, { ...opts, node }, out.touched);
      redrawLines(new Scene(state), out);
    }
  }
  gate(before, state, out);
  return out;
}

/* After File Fabric has drawn an agent's text and saved its real height:
 * where the text runs past what the estimate gave it, the boxes around it
 * grow, as for an <Add> (t-2afecbd70b). Returns the ids it changed. */
export function growOverflows(state, opts, ids) {
  opts = withDefaults(opts);
  const out = output();
  const before = checkCanvas(state, buildPlaces({ name: 'canvas', state }));
  for (const id of ids) {
    const scene = new Scene(state);
    const e = scene.byId.get(id);
    if (!e || e.item.type !== 'text' || e.item._calculatedHeight == null) continue;
    const real = scene.box(e);
    const est = { ...real, maxY: real.minY + measureText(textOf(e.item), { size: e.item.fontSize || M.FONT, maxWidth: e.item.width || M.TEXT_WIDTH }).h };
    const holder = scene.holder(scene.containerOf(e));
    if (!holder) continue;
    const hb = scene.box(holder);
    if (real.maxY + M.BOTTOM <= hb.maxY + 0.5 && real.maxX + M.SIDE <= hb.maxX + 0.5) continue;
    settle(scene, e, real.maxY > est.maxY ? est : real, { ...opts, node: null }, out.touched);
    redrawLines(new Scene(state), out);
  }
  if (out.touched.size) gate(before, state, out);
  return out;
}
