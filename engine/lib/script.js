/* The totem script: how an agent writes on a File Fabric canvas
 * (t-9533e56e40). Tags say what is inside what outright; NoteX works out
 * every size and position (t-12859aa2fb, t-56e10f6d09).
 *
 *   <Canvas name="Thesis">                  one new totem (t-a94b02f199)
 *     <Totem name="Reading plan">
 *       <Row>
 *         <Area name="Collect"><Note name="Todo">- [ ] find papers</Note></Area>
 *         <Area name="Read"><Text>Survey first.</Text></Area>
 *       </Row>
 *       <Line from="Collect" to="Read"/>
 *     </Totem>
 *   </Canvas>
 *
 *   <Add canvas="Thesis" at="Reading plan (totem) > Collect"> ... </Add>
 *   <Canvas name="Thesis"><Edit id="1793...">new words</Edit></Canvas>
 *
 * The two top-level forms are t-592a3e72ba. Parsing is by hand, with no
 * dependencies, and every refusal names its line and column: a script that
 * does not match is never half-applied.
 */

export class ScriptError extends Error {
  constructor(message, line = null, col = null) {
    super(line ? `Line ${line}, column ${col}: ${message}` : message);
    this.name = 'ScriptError';
    this.code = 'bad-script';
    this.line = line;
    this.col = col;
    this.reason = message;
  }
}

export const LIMITS = { bytes: 100_000, depth: 12, items: 300, name: 120, text: 20_000 };

/* What each tag takes: its attributes (true = required), and whether it
 * holds text, other tags, or nothing. */
const TAGS = {
  Canvas: { attrs: { name: true }, holds: 'tags' },
  Add: { attrs: { canvas: true, at: true }, holds: 'tags' },
  Edit: { attrs: { id: true, name: false }, holds: 'text' },
  Totem: { attrs: { name: true }, holds: 'tags' },
  Area: { attrs: { name: true }, holds: 'tags' },
  Note: { attrs: { name: true }, holds: 'text' },
  Text: { attrs: { size: false }, holds: 'text' },
  File: { attrs: { path: true }, holds: 'nothing' },
  Line: { attrs: { from: true, to: true }, holds: 'nothing' },
  Link: { attrs: { from: true, to: true }, holds: 'nothing' },
  Row: { attrs: {}, holds: 'tags' },
  Column: { attrs: {}, holds: 'tags' },
  ScrollBox: { attrs: { name: true }, holds: 'tags' },
  Page: { attrs: {}, holds: 'tags' },
};
const BY_LOWER = new Map(Object.keys(TAGS).map((t) => [t.toLowerCase(), t]));

const CONTENT = ['Area', 'Note', 'Text', 'File', 'Row', 'Column', 'ScrollBox'];
const WIRES = ['Line', 'Link'];
const INSIDE = {
  '': ['Canvas', 'Add'],
  Canvas: ['Totem', 'Edit'],
  Add: [...CONTENT, ...WIRES],
  Totem: [...CONTENT, ...WIRES],
  Area: [...CONTENT, ...WIRES],
  Page: [...CONTENT, ...WIRES],
  Row: CONTENT,
  Column: CONTENT,
  ScrollBox: ['Page'],
};
// Boxes are what a script names and a Line or Link joins.
export const BOXES = new Set(['Area', 'Note', 'ScrollBox']);

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

/* &lt; &amp; and their kin; an & that starts none of them is kept as it
 * is, so "R&D" needs no escaping. */
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/* A text body as the agent meant it: the blank lines that open and close
 * it and the indentation every line shares are the script's layout, not
 * the text's. */
export function dedent(s) {
  const lines = s.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut).replace(/[ \t]+$/, '')).join('\n');
}

/* ------------------------------------------------------------- reading */

function tokenize(src) {
  const tokens = [];
  let i = 0, line = 1, col = 1;
  const advance = (to) => {
    for (; i < to; i++) { if (src[i] === '\n') { line++; col = 1; } else col++; }
  };
  const fail = (msg, l = line, c = col) => { throw new ScriptError(msg, l, c); };
  while (i < src.length) {
    const at = { line, col };
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end < 0) fail('a comment <!-- is never closed with -->.');
      advance(end + 3);
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end < 0) fail('<![CDATA[ is never closed with ]]>.');
      tokens.push({ type: 'text', raw: src.slice(i + 9, end), cdata: true, ...at });
      advance(end + 3);
      continue;
    }
    if (src[i] === '<') {
      const m = /^<(\/?)([A-Za-z][\w-]*)/.exec(src.slice(i, i + 64));
      if (!m) fail('a "<" that starts no tag - write &lt; for a < in text, or put the text in <![CDATA[ ... ]]>.');
      const closing = m[1] === '/';
      const name = m[2];
      let j = i + m[0].length;
      const attrs = [];
      let selfClose = false;
      for (;;) {
        while (j < src.length && /\s/.test(src[j])) j++;
        if (j >= src.length) fail(`<${closing ? '/' : ''}${name}> is never finished with ">".`, at.line, at.col);
        if (src[j] === '>') { j++; break; }
        if (src.startsWith('/>', j)) {
          if (closing) fail(`</${name}/> is not a tag.`, at.line, at.col);
          selfClose = true; j += 2; break;
        }
        if (closing) fail(`a closing tag </${name}> takes no attributes.`, at.line, at.col);
        const a = /^([A-Za-z][\w-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(src.slice(j));
        if (!a) {
          const bare = /^[^\s>/]+/.exec(src.slice(j));
          fail(`in <${name}>, ${bare ? `"${bare[0]}"` : 'this'} is not an attribute - write them as name="value".`, at.line, at.col);
        }
        attrs.push({ name: a[1], value: decode(a[3] ?? a[4]) });
        j += a[0].length;
      }
      tokens.push({ type: closing ? 'close' : 'open', name, attrs, selfClose, ...at });
      advance(j);
      continue;
    }
    let end = src.indexOf('<', i);
    if (end < 0) end = src.length;
    tokens.push({ type: 'text', raw: src.slice(i, end), cdata: false, ...at });
    advance(end);
  }
  return tokens;
}

/* The tree of tags, checked: every tag known and closed by its own name,
 * where it may go, with the attributes it takes and nothing else. */
function build(tokens) {
  const root = { tag: '', children: [], line: 1, col: 1 };
  const stack = [root];
  let count = 0;
  for (const t of tokens) {
    const parent = stack[stack.length - 1];
    if (t.type === 'text') {
      if (TAGS[parent.tag]?.holds === 'text') { parent.parts.push(t.cdata ? t.raw : decode(t.raw)); continue; }
      if (!t.cdata && !t.raw.trim()) continue;
      const where = parent.tag ? `directly inside <${parent.tag}>` : 'outside every tag';
      const hint = parent.tag && TAGS[parent.tag].holds === 'tags' ? ' - put words in a <Text> or a <Note>' : '';
      const first = t.raw.trim().split('\n')[0].slice(0, 40);
      // The line the words start on, not where the whitespace before them did.
      const lead = /^\s*/.exec(t.raw)[0];
      const nl = lead.split('\n').length - 1;
      throw new ScriptError(`text "${first}" ${where}${hint}.`, t.line + nl, nl ? lead.length - lead.lastIndexOf('\n') : t.col + lead.length);
    }
    const tag = BY_LOWER.get(t.name.toLowerCase());
    if (t.type === 'close') {
      if (!tag) throw new ScriptError(`</${t.name}> is not a tag NoteX knows.`, t.line, t.col);
      if (parent === root) throw new ScriptError(`</${tag}> closes nothing - no <${tag}> is open here.`, t.line, t.col);
      if (parent.tag !== tag) {
        throw new ScriptError(`</${tag}> does not match <${parent.tag}> opened on line ${parent.line}, column ${parent.col} - close that one first.`, t.line, t.col);
      }
      finish(parent);
      stack.pop();
      continue;
    }
    if (!tag) {
      throw new ScriptError(`<${t.name}> is not a tag NoteX knows. The tags are ${Object.keys(TAGS).map((n) => `<${n}>`).join(', ')}.`, t.line, t.col);
    }
    if (TAGS[parent.tag]?.holds === 'text') {
      throw new ScriptError(`<${tag}> cannot go inside <${parent.tag}>, which holds only text - write &lt; for a < in text.`, t.line, t.col);
    }
    const allowed = INSIDE[parent.tag] || [];
    if (!allowed.includes(tag)) {
      const where = parent.tag ? `inside <${parent.tag}>` : 'at the top of a script';
      const can = allowed.length ? ` Only ${allowed.map((n) => `<${n}>`).join(', ')} can go there.` : '';
      throw new ScriptError(`<${tag}> cannot go ${where}.${can}`, t.line, t.col);
    }
    if (stack.length > LIMITS.depth) throw new ScriptError(`tags are nested more than ${LIMITS.depth} deep.`, t.line, t.col);
    const spec = TAGS[tag];
    const attrs = {};
    for (const a of t.attrs) {
      const name = a.name.toLowerCase();
      if ((name === 'id' && tag !== 'Edit') || name === 'owner') {
        // A read-out's ids and owners are never written back (t-bb0a5fdf1f).
        throw new ScriptError(`<${tag}> takes no ${name} - ids and owners come from NoteX. To change something already written, use <Edit id="..."> inside <Canvas>.`, t.line, t.col);
      }
      if (!(name in spec.attrs)) {
        const takes = Object.keys(spec.attrs);
        throw new ScriptError(`<${tag}> takes no attribute "${a.name}".${takes.length ? ` It takes ${takes.join(', ')}.` : ' It takes none.'}`, t.line, t.col);
      }
      if (name in attrs) throw new ScriptError(`<${tag}> has ${name} twice.`, t.line, t.col);
      attrs[name] = a.value;
    }
    for (const [name, required] of Object.entries(spec.attrs)) {
      if (required && !String(attrs[name] ?? '').trim()) throw new ScriptError(`<${tag}> needs ${name}="...".`, t.line, t.col);
    }
    for (const k of ['name', 'canvas', 'from', 'to']) {
      if (attrs[k] !== undefined) {
        attrs[k] = attrs[k].replace(/\s+/g, ' ').trim();
        if (attrs[k].length > LIMITS.name) throw new ScriptError(`${k} is longer than ${LIMITS.name} characters.`, t.line, t.col);
      }
    }
    if (++count > LIMITS.items) throw new ScriptError(`a script holds at most ${LIMITS.items} tags - split it into several.`, t.line, t.col);
    const node = { tag, attrs, children: [], parts: [], line: t.line, col: t.col };
    parent.children.push(node);
    // An empty tag may be written <File ...></File> as well as <File .../>.
    if (t.selfClose) finish(node);
    else stack.push(node);
  }
  if (stack.length > 1) {
    const open = stack[stack.length - 1];
    throw new ScriptError(`<${open.tag}> is never closed - add </${open.tag}>.`, open.line, open.col);
  }
  return root;
}

function finish(node) {
  const spec = TAGS[node.tag];
  if (spec.holds === 'text') {
    node.text = dedent(node.parts.join(''));
    if (node.text.length > LIMITS.text) throw new ScriptError(`<${node.tag}> holds more than ${LIMITS.text} characters.`, node.line, node.col);
    if (node.tag !== 'Edit' && !node.text.trim()) throw new ScriptError(`<${node.tag}> is empty.`, node.line, node.col);
  }
  delete node.parts;
  if (node.tag === 'Text' && node.attrs.size !== undefined) {
    const n = Number(node.attrs.size);
    if (!Number.isInteger(n) || n < 10 || n > 72) throw new ScriptError('size is a whole number of pixels from 10 to 72.', node.line, node.col);
    node.attrs.size = n;
  }
}

/* ------------------------------------------------------------ checking */

/* Boxes with their paths inside the script, for naming the ends of Lines
 * and Links. Row and Column hold no place of their own, so a box in a Row
 * is a sibling of the boxes beside the Row. */
function collectBoxes(top) {
  const boxes = [];
  const visit = (node, path, siblings) => {
    for (const c of node.children) {
      if (BOXES.has(c.tag)) {
        const name = c.attrs.name;
        const prev = siblings.get(name.toLowerCase());
        if (prev) throw new ScriptError(`two boxes here are both called "${name}" (the other is on line ${prev.line}) - give each its own name.`, c.line, c.col);
        siblings.set(name.toLowerCase(), c);
        c.path = [...path, name];
        boxes.push(c);
        visit(c, c.path, new Map());
      } else if (c.tag === 'Page') {
        visit(c, path, new Map());
      } else if (c.tag === 'Row' || c.tag === 'Column') {
        visit(c, path, siblings);
      }
    }
  };
  visit(top, [], new Map());
  return boxes;
}

/* The box a Line or Link names: its name, or a path ending in it, that fits
 * exactly one box (t-ed2c86d7d9). null when nothing in the script fits -
 * which an <Add> may still find on the canvas. */
export function findBox(boxes, ref) {
  const want = ref.split('>').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const fits = boxes.filter((b) => {
    const p = b.path.map((s) => s.toLowerCase());
    return p.length >= want.length && want.every((w, i) => p[p.length - want.length + i] === w);
  });
  if (fits.length > 1) return { many: fits };
  return fits[0] ? { box: fits[0] } : null;
}

function checkWires(top, boxes, { allowOutside }) {
  const visit = (node) => {
    for (const c of node.children) {
      if (WIRES.includes(c.tag)) {
        const ends = {};
        for (const k of ['from', 'to']) {
          const f = findBox(boxes, c.attrs[k]);
          if (f && f.many) {
            throw new ScriptError(`${k}="${c.attrs[k]}" fits ${f.many.length} boxes (${f.many.map((b) => b.path.join(' > ')).join('; ')}) - name it by its path, e.g. "${f.many[0].path.join(' > ')}".`, c.line, c.col);
          }
          if (!f && !allowOutside) throw new ScriptError(`${k}="${c.attrs[k]}" names no <Area>, <Note> or <ScrollBox> in this script.`, c.line, c.col);
          ends[k] = f ? f.box : null;
        }
        if (ends.from && ends.from === ends.to) throw new ScriptError(`<${c.tag}> joins "${c.attrs.from}" to itself.`, c.line, c.col);
        c.ends = ends;
      } else visit(c);
    }
  };
  visit(top);
}

/* A script as a checked tree, or a ScriptError naming the line. */
export function parseScript(src) {
  if (typeof src !== 'string' || !src.trim()) throw new ScriptError('The script is empty.');
  if (Buffer.byteLength(src, 'utf8') > LIMITS.bytes) throw new ScriptError(`The script is over ${LIMITS.bytes / 1000} KB - write one totem at a time.`);
  const root = build(tokenize(src));
  if (root.children.length !== 1) {
    const second = root.children[1];
    throw new ScriptError(root.children.length ? 'a script holds one <Canvas> or one <Add> - send the next one as a script of its own.' : 'The script holds no <Canvas> or <Add>.',
      second?.line ?? null, second?.col ?? null);
  }
  const top = root.children[0];
  if (top.tag === 'Canvas') {
    const totems = top.children.filter((c) => c.tag === 'Totem');
    const edits = top.children.filter((c) => c.tag === 'Edit');
    if (!top.children.length) throw new ScriptError('<Canvas> holds nothing - give it one <Totem>, or <Edit> tags.', top.line, top.col);
    if (totems.length > 1) throw new ScriptError('a script writes one totem - send the next <Totem> as a script of its own.', totems[1].line, totems[1].col);
    if (totems.length && edits.length) throw new ScriptError('<Edit> and a new <Totem> go in separate scripts.', edits[0].line, edits[0].col);
    if (totems.length) {
      const boxes = collectBoxes(totems[0]);
      checkWires(totems[0], boxes, { allowOutside: false });
      return { kind: 'totem', canvas: top.attrs.name, totem: totems[0], boxes };
    }
    const seen = new Map();
    for (const e of edits) {
      if (seen.has(e.attrs.id)) throw new ScriptError(`id ${e.attrs.id} is edited twice (also on line ${seen.get(e.attrs.id).line}).`, e.line, e.col);
      seen.set(e.attrs.id, e);
      if (!e.text && e.attrs.name === undefined) throw new ScriptError('<Edit> changes nothing - give it new text, or name="..." to rename.', e.line, e.col);
    }
    return { kind: 'edit', canvas: top.attrs.name, edits };
  }
  if (!top.children.length) throw new ScriptError('<Add> holds nothing to add.', top.line, top.col);
  const boxes = collectBoxes(top);
  checkWires(top, boxes, { allowOutside: true });
  return { kind: 'add', canvas: top.attrs.canvas, at: top.attrs.at, node: top, boxes };
}

/* Text made safe to sit in a script: what a read-out writes. */
export function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}
export function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}
