/* A canvas read out as a totem script, for an agent to see what is there
 * before it writes: every totem with its owner, every box, text, note and
 * file with its id - what <Edit id> and <Add at> name - nested as the
 * canvas nests them and in reading order, top to bottom then left to
 * right. No coordinates and no Row or Column: where things sit is NoteX's
 * to work out, and a Row guessed from positions would be a guess
 * (t-12859aa2fb, t-56e10f6d09).
 *
 * The ids and owners make it something to read, not to send back: a
 * script that carries them is refused (t-bb0a5fdf1f).
 */
import { buildPlaces, plainText } from './places.js';
import { escapeText, escapeAttr } from './script.js';
import { visualBox } from './measure.js';
import { fingerprint } from './writer.js';

const TAG = { totem: 'Totem', area: 'Area', note: 'Note', scroll: 'ScrollBox', page: 'Page' };
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/* A canvas, or with at one place in it, as a script. ledger, when given,
 * marks the agent's items the user has since edited. */
export function readOut(fabric, { at = null, ledger = null } = {}) {
  const model = buildPlaces(fabric);
  const state = fabric.state || {};
  const byId = new Map([...(state.areas || []), ...(state.drawings || []), ...(state.files || [])].map((x) => [x.id, x]));
  const P = (id) => model.places.get(id);
  let top = model.root;
  if (at) {
    top = [...model.places.values()].find((p) => p.address && norm(p.address) === norm(at));
    if (!top) return null;
  }

  // Whose each totem is; items inside an agent's totem say when they are not the agent's own (t-9b390c6f89).
  const ownerOf = (p) => (p.kind === 'totem' ? (p.totem.writtenBy === 'agent' && p.totem.owner ? p.totem.owner : 'user') : null);
  const totemOwner = (p) => {
    for (let q = p; q; q = q.parent ? P(q.parent) : null) if (q.kind === 'totem') return ownerOf(q);
    return null;
  };
  const marks = (item, p) => {
    const t = totemOwner(p);
    if (!t || t === 'user') return '';
    if (item.writtenBy !== 'agent') return ' owner="user"';
    const had = ledger && ledger.items[item.id];
    if (had && had.print !== fingerprint(item)) return ' edited="by the user"';
    return '';
  };

  const lines = [];
  const pad = (d) => '  '.repeat(d);
  const body = (text, d) => {
    const t = escapeText(text);
    return t.includes('\n') ? `\n${t.split('\n').map((l) => (l ? pad(d + 1) + l : l)).join('\n')}\n${pad(d)}` : t;
  };

  /* What a place holds, in reading order: its places, texts and files
   * by where they sit. */
  const contents = (p) => {
    const out = [];
    for (const id of p.children) {
      const c = P(id);
      out.push({ kind: 'place', p: c, box: c.bbox || null, page: c.page || 0 });
    }
    p.textIds.forEach((id) => { const d = byId.get(id); if (d) out.push({ kind: 'text', item: d, box: visualBox(d, 'drawing') }); });
    for (const f of p.files) { const it = byId.get(f.id); if (it) out.push({ kind: 'file', item: it, f, box: visualBox(it, 'file') }); }
    const rank = (x) => (x.kind === 'place' && x.p.kind === 'canvas' ? 1 : 0);
    return out.sort((a, b) => (a.page - b.page) || (rank(a) - rank(b)) || ((a.box?.minY ?? 0) - (b.box?.minY ?? 0)) || ((a.box?.minX ?? 0) - (b.box?.minX ?? 0)));
  };

  const place = (p, d) => {
    if (p.kind === 'canvas') {
      // The open canvas is no place of the script's: its things sit straight under <Canvas>.
      for (const x of contents(p)) item(x, d);
      return;
    }
    const tag = TAG[p.kind];
    const attrs = [];
    if (p.kind !== 'page') attrs.push(`name="${escapeAttr(p.name || '')}"`);
    attrs.push(`id="${escapeAttr(p.kind === 'totem' ? p.totem.id : p.kind === 'page' ? p.id.split(':')[2] : p.id)}"`);
    if (p.kind === 'totem') attrs.push(`owner="${escapeAttr(ownerOf(p))}"`);
    const own = p.area ? marks(p.area, p) : '';
    const open = `${pad(d)}<${tag} ${attrs.join(' ')}${own}`;
    if (p.kind === 'note') {
      const text = p.area.textContent || '';
      lines.push(text.trim() ? `${open}>${body(text, d)}</Note>` : `${open}/>`);
      return;
    }
    const inner = contents(p);
    const wires = p.kind === 'totem' || p === top ? wiresIn(p) : [];
    const pens = p.pens ? [`${pad(d + 1)}<!-- ${p.pens} pen stroke${p.pens === 1 ? '' : 's'}, not read -->`] : [];
    if (!inner.length && !wires.length && !pens.length) { lines.push(`${open}/>`); return; }
    lines.push(`${open}>`);
    for (const x of inner) item(x, d + 1);
    lines.push(...pens);
    for (const w of wires) lines.push(`${pad(d + 1)}${w}`);
    lines.push(`${pad(d)}</${tag}>`);
  };

  const item = (x, d) => {
    if (x.kind === 'place') return place(x.p, d);
    const holder = model.places.get(placeOf(x)) || top;
    if (x.kind === 'text') {
      const words = plainText(x.item.text);
      const size = x.item.fontSize && x.item.fontSize !== 18 ? ` size="${x.item.fontSize}"` : '';
      lines.push(`${pad(d)}<Text id="${escapeAttr(x.item.id)}"${size}${marks(x.item, holder)}>${body(words, d)}</Text>`);
      return;
    }
    const kind = x.f.kind === 'file' ? '' : ` kind="${x.f.kind}"`;
    lines.push(`${pad(d)}<File path="${escapeAttr(x.f.name || '')}" id="${escapeAttr(x.item.id)}"${kind}${marks(x.item, holder)}/>`);
  };
  // The place a text or file was filed in, for its marks.
  const holderOf = new Map();
  for (const p of model.places.values()) {
    for (const id of p.textIds) holderOf.set(id, p.id);
    for (const f of p.files) holderOf.set(f.id, p.id);
  }
  const placeOf = (x) => holderOf.get(x.item.id);

  /* Wires shown once, in the totem that holds both ends - or, read from
   * one place, every wire with an end inside it. */
  const inside = (id, under) => { for (let q = P(id); q; q = q.parent ? P(q.parent) : null) if (q === under) return true; return false; };
  const wiresIn = (p) => model.wires
    .filter((w) => (p === top && p.kind !== 'totem' && p.kind !== 'fabric' ? inside(w.from, p) || inside(w.to, p) : inside(w.from, p) && inside(w.to, p)))
    .map((w) => `<${w.via === 'link' ? 'Link' : 'Line'} from="${escapeAttr(P(w.from).address)}" to="${escapeAttr(P(w.to).address)}"${w.id ? ` id="${escapeAttr(w.id)}"` : ''}/>`);

  lines.push(`<Canvas name="${escapeAttr(fabric.name)}">`);
  if (top === model.root) {
    for (const x of contents(model.root)) item(x, 1);
    // Wires between totems, or outside every totem, at the end.
    const shown = new Set();
    for (const p of model.places.values()) if (p.kind === 'totem') for (const w of model.wires) if (inside(w.from, p) && inside(w.to, p)) shown.add(w);
    for (const w of model.wires) {
      if (shown.has(w)) continue;
      lines.push(`  <${w.via === 'link' ? 'Link' : 'Line'} from="${escapeAttr(P(w.from).address)}" to="${escapeAttr(P(w.to).address)}"${w.id ? ` id="${escapeAttr(w.id)}"` : ''}/>`);
    }
  } else place(top, 1);
  lines.push('</Canvas>');
  return lines.join('\n') + '\n';
}
