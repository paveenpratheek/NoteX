/* A fabric's place tree as the two things NoteX hands on:
 *
 *   the address document - Markdown, one section per place, its heading the
 *   place's whole address on one line. RAGX embeds every chunk with its
 *   document name and heading path and never lets a chunk cross a heading,
 *   so each place's contents travel with exactly that address
 *   (t-70ef9e903d, t-015826b047).
 *
 *   the place map - the same tree as JSON, for walking from a place to its
 *   parent, children, neighbours and wires by name (t-1a4fa21364).
 */
import { pathToFileURL } from 'node:url';
import { inOrder } from './places.js';

const CORNER = { tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right' };
const SIDE = { right: 'to the right', left: 'to the left', above: 'above', below: 'below' };
const KIND = { area: 'An area', note: 'A note', scroll: 'A scroll box', page: 'A page', totem: 'A totem', canvas: 'The open canvas' };

const one = (s) => String(s).replace(/\s+/g, ' ').trim();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : /(x|s|ch)$/.test(word) ? 'es' : 's'}`;
const list = (xs) => xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/* Text from a note or a text drawing, made safe to sit under a heading.
 * A "# Title" line becomes bold, not a heading that would cut the text off
 * from its address (t-7ca4b882b0); a line of only = or - would turn the line
 * above it into a heading, and an opening ``` would swallow every section
 * after it, so neither is left as written. */
export function safeText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const atx = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) return atx[1].trim() ? `**${atx[1].trim()}**` : '';
    if (/^ {0,3}(=+|-+)\s*$/.test(line)) return '';
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) return `    ${line.trim()}`;
    return line;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* A file:/// URL RAGX reads as a linked image; brackets are encoded too,
 * which Node's pathToFileURL leaves as they are. */
export const fileUrl = (p) => pathToFileURL(p).href.replace(/\(/g, '%28').replace(/\)/g, '%29');

/* One image under its place: what Haiku read in it, for the agent, and
 * where the file is, for the agent to open and RAGX's page to show - never
 * the image itself (t-a4bf938570). */
function imageEntry(f) {
  const im = f.image;
  const r = im.reading;
  const name = one(f.name || 'image');
  const out = [`**${name}** (image, ${r ? `read by ${r.model || 'haiku'} - machine-read, may contain errors` : 'not read yet - Read images on the NoteX page reads it'})`];
  if (im.path) out.push(`![${name.replace(/[[\]]/g, '')}](${fileUrl(im.path)})`, `File: ${im.path}`);
  else out.push('File: only inside fabric.json until NoteX saves it to its data folder.');
  if (r && r.description) out.push(`Shows: ${one(r.description)}`);
  if (r && r.text) out.push('Text in it:', safeText(r.text));
  return out.join('\n');
}

function describe(p, model) {
  const at = (id) => model.places.get(id);
  const parent = p.parent ? at(p.parent) : null;
  const totem = p.totemId ? at(p.totemId) : null;
  const inTotem = totem ? ` in the totem ${totem.name}` : '';
  switch (p.kind) {
    case 'canvas': return 'Items on the open canvas, outside every area and every totem\'s field.';
    case 'totem': {
      const held = p.children.map((id) => at(id)).filter((c) => c.kind !== 'page');
      return `A totem. Its field holds ${held.length ? list(held.map((c) => c.label)) : 'no areas'}.`;
    }
    case 'page': {
      const box = parent;
      return `Page ${p.page} of ${p.of} of the scroll box ${box.name || box.label}${box.totemId ? ` in the totem ${at(box.totemId).name}` : ''}.`;
    }
    default: {
      let where;
      if (!parent || parent.kind === 'fabric') where = ' on the canvas, in no totem\'s field';
      else if (parent.kind === 'totem') where = p.totemVia === 'neighbours' ? ` in the totem ${parent.name}, joined to its field through the places beside it` : ` in the totem ${parent.name}'s field`;
      else if (parent.kind === 'page') where = ` on ${parent.label} of the scroll box ${at(parent.parent).label}${inTotem}`;
      else where = ` inside ${parent.label}${inTotem}`;
      const pages = p.kind === 'scroll' ? ` with ${plural(p.children.length, 'page')}` : '';
      return `${KIND[p.kind]}${pages}${where}.`;
    }
  }
}

function section(p, model) {
  const at = (id) => model.places.get(id);
  const lines = [`## ${one(p.address)}`, '', describe(p, model)];

  const kids = p.children.map(at).filter((c) => c.kind !== 'page');
  if (kids.length && p.kind !== 'totem') lines.push(`Inside it: ${list(kids.map((c) => c.label))}.`);
  if (p.kind === 'scroll' && p.deletedPageItems) lines.push(`${plural(p.deletedPageItems, 'item')} from deleted pages, which File Fabric no longer shows, are left out.`);
  if (p.neighbours.length) lines.push(`Next to it: ${p.neighbours.map((n) => `${at(n.id).label} ${SIDE[n.dir]}`).join('; ')}.`);
  if (p.wires.length) {
    const ws = p.wires.map((w) => {
      const how = w.via === 'link' ? `a link${w.corner && CORNER[w.corner] ? ` from its ${CORNER[w.corner]} corner` : ''}` : 'a drawn line';
      return `${at(w.id).address} by ${how}`;
    });
    lines.push(`Wired to: ${list(ws)}.`);
  }

  if (p.kind === 'note') {
    const c = p.checklist;
    if (c.total) lines.push(`Checklist: ${c.done} of ${c.total} done.`);
    const body = safeText(p.area.textContent);
    if (body) lines.push('', body);
  }
  if (p.reach && !(p.kind === 'note' && model.reachShown.has(reachKey(p.reach)))) {
    const each = p.reach.notes.map((n) => `${at(n.id).address} ${n.done}/${n.total}`);
    lines.push('', `Through its wires it reaches ${plural(p.reach.notes.length, 'note')}: ${list(each)}; together ${p.reach.done} of ${p.reach.total} done.`);
  }
  if (p.texts.length) {
    lines.push('', 'Written on it:');
    for (const t of p.texts) lines.push('', safeText(t));
  }
  const images = p.files.filter((f) => f.image);
  const others = p.files.filter((f) => !f.image);
  if (others.length) {
    lines.push('', 'Files:');
    for (const f of others) lines.push(`- ${one(f.name || 'unnamed')} (${f.kind}${f.url ? `, ${f.url}` : ''})`);
  }
  for (const f of images) lines.push('', imageEntry(f));
  if (p.pens) lines.push('', `Handwriting: ${plural(p.pens, 'pen stroke')}, not read yet.`);
  return lines.join('\n');
}

function overview(model) {
  const all = inOrder(model).slice(1);
  const count = (k) => all.filter((p) => p.kind === k).length;
  const totems = all.filter((p) => p.kind === 'totem');
  const lines = [`## ${one(model.fabric.name)} (fabric)`, ''];
  lines.push(`The File Fabric canvas ${model.fabric.name}${model.fabric.modified ? `, saved ${model.fabric.modified.slice(0, 10)}` : ''}. It holds ${plural(totems.length, 'totem')}, ${plural(count('area'), 'area')}, ${plural(count('note'), 'note')} and ${plural(count('scroll'), 'scroll box', )}.`);
  for (const t of totems) {
    const held = t.children.map((id) => model.places.get(id).label);
    lines.push(`- ${t.label}: ${held.length ? list(held) : 'nothing in its field'}`);
  }
  const loose = model.root.children.map((id) => model.places.get(id)).filter((p) => p.kind !== 'totem' && p.kind !== 'canvas');
  if (loose.length) lines.push(`- In no totem's field: ${list(loose.map((p) => p.label))}`);
  const l = model.left;
  const out = [];
  if (l.deletedPages) out.push(`${plural(l.deletedPages, 'item')} on deleted scroll-box pages`);
  if (l.inBooksOrFolders) out.push(`${plural(l.inBooksOrFolders, 'thing')} in books or folders`);
  if (l.hidden) out.push(`${plural(l.hidden, 'hidden file')}`);
  if (l.unshown) out.push(`${plural(l.unshown, 'drawing')} File Fabric never draws`);
  if (out.length) lines.push('', `Left out: ${list(out)}.`);
  return lines.join('\n');
}

const reachKey = (r) => r.notes.map((n) => n.id).join(',');

export function toMarkdown(model) {
  /* A wired network's total is written on the areas it joins; a note in
   * the same network has its own checklist and would only repeat the
   * total, so it says it only when no area does. */
  model.reachShown = new Set(inOrder(model).filter((p) => p.reach && p.kind !== 'note').map((p) => reachKey(p.reach)));
  const parts = [overview(model)];
  for (const p of inOrder(model).slice(1)) parts.push(section(p, model));
  return parts.join('\n\n') + '\n';
}

export function toPlaceMap(model) {
  return {
    fabric: model.fabric,
    left: model.left,
    places: inOrder(model).map((p) => ({
      id: p.id, kind: p.kind, name: p.name ?? null, label: p.label, address: p.address,
      parent: p.parent, children: p.children,
      totem: p.totemId || null, totemVia: p.totemVia || null,
      page: p.page || null,
      neighbours: p.neighbours, wires: p.wires, reach: p.reach,
      checklist: p.checklist || null,
      files: p.files, texts: p.texts.length, pens: p.pens,
      ...(p.kind === 'scroll' ? { deletedPageItems: p.deletedPageItems } : {}),
    })),
  };
}
