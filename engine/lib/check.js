/* The overlap check: on one canvas, which boxes, texts, files and pen
 * strokes cross each other or run out of the box that holds them. Ported
 * from the scratch script the layout review used, so every layout NoteX
 * makes passes the same test the user's canvases were read with
 * (t-12859aa2fb). Files use the centred box File Fabric draws
 * (t-8ba8064e60), and a file running out of its box is checked as text is.
 *
 * Each finding names the items it is about by id, so the writer can refuse
 * a layout whose own items are in one and leave the user's alone
 * (t-2afecbd70b).
 */
import { kindOf, plainText } from './places.js';
import { areaBBox, polygonsOf, isPointInPolygon } from './geometry.js';
import { textBox, fileBox } from './measure.js';

const SLACK = 4; // touching edges, or a few pixels, is not an overlap

export const inter = (a, b) => {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return w > SLACK && h > SLACK ? { w: Math.round(w), h: Math.round(h) } : null;
};
export const holds = (outer, inner) => inner.minX >= outer.minX - SLACK && inner.maxX <= outer.maxX + SLACK && inner.minY >= outer.minY - SLACK && inner.maxY <= outer.maxY + SLACK;
// For drawn outlines that are not rectangles: every corner of the box inside the outline.
const cornersIn = (area, b) => [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]]
  .every(([x, y]) => polygonsOf(area).some((p) => isPointInPolygon({ x, y }, p)));

export const LABEL = {
  boxes: 'Boxes crossing each other', textText: 'Texts overlapping texts', textSpills: 'Text spilling out of its box',
  textOver: "Text running over another box's edge", fileText: 'Images/files covering text', fileFile: 'Images/files overlapping',
  fileSpills: 'Images/files running out of their box', fileOver: "Images/files running over another box's edge",
  penText: 'Pen strokes crossing text', penSpills: 'Pen strokes running out of their box', empty: 'Empty boxes', unnamed: 'Boxes with no name',
};
// Empty and unnamed boxes are worth saying, but are not overlaps a layout must avoid.
export const LAYOUT_KINDS = Object.keys(LABEL).filter((k) => k !== 'empty' && k !== 'unnamed');

/* Every finding on a canvas: [{ kind, ids, say }]. model is buildPlaces' tree. */
export function checkCanvas(state, model) {
  const where = (id) => model.places.get(id)?.address || null;
  const areas = (state.areas || []).filter((a) => !['book', 'folder'].includes(kindOf(a)) && polygonsOf(a).length);
  const ab = new Map(areas.map((a) => [a.id, areaBBox(a)]));
  // Things on different pages of one scroll box share the same spot on purpose.
  const pageOf = (x) => (x.scrollBoxPageId ? `${x.parentAreaId || x.areaId}:${x.scrollBoxPageId}` : null);
  const samePage = (x, y) => !pageOf(x) || !pageOf(y) || pageOf(x) === pageOf(y);
  const name = (a) => where(a.id) || `${a.name || 'unnamed'}`;
  const texts = (state.drawings || []).filter((d) => d.type === 'text' && plainText(d.text)).map((d) => ({ d, b: textBox(d), say: plainText(d.text).split('\n')[0].slice(0, 50) }));
  const files = (state.files || []).filter((f) => !f.isHidden).map((f) => ({ f, b: fileBox(f) }));
  const pens = (state.drawings || []).filter((d) => d.type === 'path' && (d.points || []).length >= 2).map((d) => {
    const xs = d.points.map((p) => p.x), ys = d.points.map((p) => p.y);
    return { d, b: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } };
  });
  const out = [];
  const find = (kind, ids, say) => out.push({ kind, ids, say });

  for (const p of pens) {
    for (const t of texts) if (samePage(p.d, t.d) && inter(p.b, t.b)) find('penText', [p.d.id, t.d.id], `a pen stroke crosses "${t.say}"`);
    const own = areas.find((a) => a.id === p.d.areaId);
    if (own && !holds(ab.get(own.id), p.b)) find('penSpills', [p.d.id, own.id], `a pen stroke runs out of its box "${name(own)}"`);
  }
  for (const a of areas) {
    const p = model.places.get(a.id);
    if (!p) continue;
    if (!String(a.name || '').trim() && !a.isScrollBox) find('unnamed', [a.id], `a ${kindOf(a)} with no name at ${where(a.id)}`);
    const nothing = !p.children.length && !p.files.length && !p.texts.length && !p.pens && !(a.isNote && String(a.textContent || '').trim());
    if (nothing) find('empty', [a.id], `"${name(a)}" has nothing in it`);
  }
  for (let i = 0; i < areas.length; i++) for (let j = i + 1; j < areas.length; j++) {
    const a = areas[i], b = areas[j];
    if (!samePage(a, b)) continue;
    const A = ab.get(a.id), B = ab.get(b.id);
    const x = inter(A, B);
    if (!x) continue;
    if ((holds(A, B) && cornersIn(a, B)) || (holds(B, A) && cornersIn(b, A))) continue; // one inside the other
    find('boxes', [a.id, b.id], `"${name(a)}" and "${name(b)}" cross by ${x.w}×${x.h}`);
  }
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    if (!samePage(texts[i].d, texts[j].d)) continue;
    const x = inter(texts[i].b, texts[j].b);
    if (x) find('textText', [texts[i].d.id, texts[j].d.id], `"${texts[i].say}" and "${texts[j].say}" by ${x.w}×${x.h}`);
  }
  /* Something with a box of its own - a text or a file - against every
   * area: inside it is fine, spilling out of its own is one finding, and
   * running over another's edge is another. */
  const against = (item, b, say, spills, over) => {
    for (const a of areas) {
      const A = ab.get(a.id);
      if (!inter(A, b) || !samePage(item, a.isScrollBox ? { scrollBoxPageId: item.scrollBoxPageId } : a)) continue;
      if (holds(A, b) && cornersIn(a, b)) continue;
      if (item.areaId === a.id) find(spills, [item.id, a.id], `${say} spills out of its own box "${name(a)}"`);
      else if (!holds(b, A)) find(over, [item.id, a.id], `${say} runs over the edge of "${name(a)}"`);
    }
  };
  for (const t of texts) against(t.d, t.b, `"${t.say}"${t.b.measured ? '' : ' (height estimated)'}`, 'textSpills', 'textOver');
  for (const { f, b } of files) against(f, b, f.name, 'fileSpills', 'fileOver');
  for (const { f, b } of files) for (const t of texts) {
    if (!samePage(f, t.d)) continue;
    const x = inter(b, t.b);
    if (x) find('fileText', [f.id, t.d.id], `${f.name} covers "${t.say}" by ${x.w}×${x.h}`);
  }
  for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
    if (!samePage(files[i].f, files[j].f)) continue;
    const x = inter(files[i].b, files[j].b);
    if (x) find('fileFile', [files[i].f.id, files[j].f.id], `${files[i].f.name} and ${files[j].f.name} by ${x.w}×${x.h}`);
  }
  return out;
}

/* The overlaps a layout made: findings about any of its own items that the
 * canvas did not have before - a crossing the user already lives with is
 * theirs, not the layout's. */
export function overlapsOf(findings, ids, before = []) {
  const had = new Set(before.map((f) => `${f.kind}:${[...f.ids].sort().join(',')}`));
  return findings.filter((f) => LAYOUT_KINDS.includes(f.kind) && f.ids.some((id) => ids.has(id)) && !had.has(`${f.kind}:${[...f.ids].sort().join(',')}`));
}
