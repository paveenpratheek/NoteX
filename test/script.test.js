/* The totem script's parser: what it reads, and every refusal naming its
 * line and column (t-9533e56e40, t-592a3e72ba, t-bb0a5fdf1f, t-ed2c86d7d9). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, ScriptError, LIMITS, dedent, escapeText } from '../engine/lib/script.js';

const EXAMPLE = `<Canvas name="Thesis">
  <Totem name="Reading plan">
    <Row>
      <Area name="Collect">
        <Note name="Todo">
          - [ ] find papers
          - [x] read the survey
        </Note>
      </Area>
      <Area name="Read"><Text size="20">Survey &lt;first&gt; &amp; then R&D.</Text></Area>
      <Area name="Write"><Text><![CDATA[a <b> stays & so does this]]></Text></Area>
      <Area name="Check"><File path="C:\\papers\\survey.pdf"/></Area>
    </Row>
    <Line from="Collect" to="Read"/>
    <Line from="Read" to="Write"/>
    <Link from="Write" to="Check"></Link>
  </Totem>
</Canvas>`;

const refuses = (src, line, col, pattern) => {
  assert.throws(() => parseScript(src), (e) => {
    assert.ok(e instanceof ScriptError, e.message);
    if (line !== null) assert.equal(e.line, line, e.message);
    if (col !== null) assert.equal(e.col, col, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
};

test('a totem script reads into a tree: text decoded and dedented, wires joined to their boxes', () => {
  const s = parseScript(EXAMPLE);
  assert.equal(s.kind, 'totem');
  assert.equal(s.canvas, 'Thesis');
  assert.equal(s.totem.attrs.name, 'Reading plan');
  const row = s.totem.children[0];
  assert.equal(row.tag, 'Row');
  assert.deepEqual(row.children.map((c) => c.attrs.name), ['Collect', 'Read', 'Write', 'Check']);
  assert.equal(row.children[0].children[0].text, '- [ ] find papers\n- [x] read the survey');
  const text = row.children[1].children[0];
  assert.equal(text.text, 'Survey <first> & then R&D.');
  assert.equal(text.attrs.size, 20);
  assert.equal(row.children[2].children[0].text, 'a <b> stays & so does this');
  assert.equal(row.children[3].children[0].attrs.path, 'C:\\papers\\survey.pdf');
  const wires = s.totem.children.slice(1);
  assert.deepEqual(wires.map((w) => [w.tag, w.ends.from.attrs.name, w.ends.to.attrs.name]), [['Line', 'Collect', 'Read'], ['Line', 'Read', 'Write'], ['Link', 'Write', 'Check']]);
  assert.deepEqual(s.boxes.map((b) => b.path.join(' > ')), ['Collect', 'Collect > Todo', 'Read', 'Write', 'Check']);
});

test('the Add and Edit forms', () => {
  const add = parseScript('<Add canvas="Thesis" at="Reading plan (totem) > Collect">\n  <Note name="More">- [ ] one</Note>\n  <Line from="More" to="Reading plan (totem) > Read"/>\n</Add>');
  assert.equal(add.kind, 'add');
  assert.equal(add.at, 'Reading plan (totem) > Collect');
  const wire = add.node.children[1];
  assert.equal(wire.ends.from.attrs.name, 'More');
  assert.equal(wire.ends.to, null, 'an address outside the script is left for the canvas to settle');
  const edit = parseScript('<Canvas name="Thesis"><Edit id="171">new words</Edit><Edit id="172" name="Renamed"/></Canvas>');
  assert.equal(edit.kind, 'edit');
  assert.deepEqual(edit.edits.map((e) => [e.attrs.id, e.text, e.attrs.name]), [['171', 'new words', undefined], ['172', '', 'Renamed']]);
});

test('tags that do not match are refused at the line and column that broke', () => {
  refuses('<Canvas name="X">\n  <Totem name="T">\n    <Area name="A">\n  </Totem>\n</Canvas>', 4, 3, /<\/Totem> does not match <Area> opened on line 3, column 5/);
  refuses('<Canvas name="X">\n  <Totem name="T">\n    <Area name="A">', 3, 5, /<Area> is never closed - add <\/Area>/);
  refuses('<Canvas name="X"></Canvas>\n</Area>', 2, 1, /<\/Area> closes nothing/);
  refuses('<Canvas name="X">\n  <Totem name="T"><Box name="A"/></Totem></Canvas>', 2, 19, /<Box> is not a tag NoteX knows/);
  refuses('<Canvas name="X">\n  <Totem name="T" colour="red"></Totem></Canvas>', 2, 3, /takes no attribute "colour". It takes name/);
  refuses('<Canvas name="X"><Totem name="T"><Area></Area></Totem></Canvas>', 1, 34, /<Area> needs name=/);
  refuses('<Canvas name="X"><Area name="A"></Area></Canvas>', 1, 18, /<Area> cannot go inside <Canvas>. Only <Totem>, <Edit> can go there/);
  refuses('<Canvas name="X"><Totem name="T"><Note name="N">a <b>c</b></Note></Totem></Canvas>', 1, 51, /<b> is not a tag/);
  refuses('<Canvas name="X"><Totem name="T"><Note name="N">a <Area name="B"/></Note></Totem></Canvas>', 1, 51, /cannot go inside <Note>, which holds only text - write &lt;/);
  refuses('<Canvas name="X"><Totem name="T"><Text>1 < 2</Text></Totem></Canvas>', 1, 42, /a "<" that starts no tag - write &lt;/);
  refuses('<Canvas name="X"><Totem name="T">\n  loose words\n</Totem></Canvas>', 2, 3, /text "loose words" directly inside <Totem> - put words in a <Text>/);
  refuses('<Canvas name="X"><Totem name="T"><Row><Line from="a" to="b"/></Row></Totem></Canvas>', 1, 39, /<Line> cannot go inside <Row>/);
  refuses('<Canvas name="X"><Totem name="T"><File path="a.pdf">words</File></Totem></Canvas>', 1, 53, /directly inside <File>/);
});

test('names, wires, ids and the one-totem rule', () => {
  refuses('<Canvas name="X"><Totem name="T">\n<Area name="A"/>\n<Row><Area name="a"/></Row></Totem></Canvas>', 3, 6, /both called "a" \(the other is on line 2\)/);
  // One name in two different areas is fine, and a path tells them apart.
  const s = parseScript('<Canvas name="X"><Totem name="T"><Area name="A"><Note name="N">x</Note></Area><Area name="B"><Note name="N">y</Note></Area>\n<Line from="A > N" to="B > N"/></Totem></Canvas>');
  assert.deepEqual(s.totem.children[2].ends.from.path, ['A', 'N']);
  refuses('<Canvas name="X"><Totem name="T"><Area name="A"><Note name="N">x</Note></Area><Area name="B"><Note name="N">y</Note></Area>\n<Line from="N" to="A"/></Totem></Canvas>', 2, 1, /from="N" fits 2 boxes \(A > N; B > N\)/);
  refuses('<Canvas name="X"><Totem name="T"><Area name="A"/>\n<Link from="A" to="Nowhere"/></Totem></Canvas>', 2, 1, /to="Nowhere" names no <Area>/);
  refuses('<Canvas name="X"><Totem name="T"><Area name="A"/><Line from="A" to="a"/></Totem></Canvas>', 1, 50, /joins "A" to itself/);
  refuses('<Canvas name="X"><Totem name="T" id="17"></Totem></Canvas>', 1, 18, /takes no id - ids and owners come from NoteX. To change something already written, use <Edit id/);
  refuses('<Canvas name="X"><Totem name="T"/><Totem name="U"/></Canvas>', 1, 35, /writes one totem/);
  refuses('<Canvas name="X"/>\n<Canvas name="Y"/>', 2, 1, /one <Canvas> or one <Add>/);
  refuses('<Canvas name="X"><Edit id="1"/></Canvas>', 1, 18, /<Edit> changes nothing/);
  refuses('<Canvas name="X"><Totem name="T"><Text size="9">a</Text></Totem></Canvas>', 1, 34, /size is a whole number/);
  refuses('<Canvas name="X"><Totem name="T"><Note name="N">\n   \n</Note></Totem></Canvas>', 1, 34, /<Note> is empty/);
});

test('size, depth and count over the limits are refused', () => {
  refuses('<Canvas name="X">' + 'x'.repeat(LIMITS.bytes) + '</Canvas>', null, null, /over 100 KB/);
  let deep = '<Canvas name="X"><Totem name="T">';
  for (let i = 0; i < LIMITS.depth; i++) deep += `<Area name="A${i}">`;
  refuses(deep, 1, null, /nested more than 12 deep/);
  let many = '<Canvas name="X"><Totem name="T">';
  for (let i = 0; i < LIMITS.items; i++) many += `<Area name="A${i}"/>`;
  refuses(many + '</Totem></Canvas>', 1, null, /at most 300 tags/);
  refuses('', null, null, /empty/);
});

test('dedent and escaping', () => {
  assert.equal(dedent('\n    a\n      b\n\n    c\n  '), 'a\n  b\n\nc');
  assert.equal(escapeText('a < b & c'), 'a &lt; b &amp; c');
  assert.equal(parseScript(`<Canvas name="X"><Totem name="T"><Text>${escapeText('1 < 2 && <b>')}</Text></Totem></Canvas>`).totem.children[0].text, '1 < 2 && <b>');
});
