/* The totem script as notex_write teaches it to agents, and as the placer
 * teaches it to the model that places a drop (t-c24e0494a2). */

export const FORMAT = [
  'A script is tags. Either a new totem:',
  '<Canvas name="Thesis">',
  '  <Totem name="Reading plan">',
  '    <Text>Why this plan exists.</Text>',
  '    <Row>',
  '      <Area name="Collect"><Note name="Todo">- [ ] find papers\n- [x] read the survey</Note></Area>',
  '      <Area name="Read"><File path="C:\\papers\\survey.pdf"/></Area>',
  '    </Row>',
  '    <Link from="Collect" to="Read"/>',
  '  </Totem>',
  '</Canvas>',
  'or new contents for a place already in your own totem, by its address as notex_read shows it:',
  '<Add canvas="Thesis" at="Reading plan (totem) > Collect"><Note name="More">- [ ] one</Note></Add>',
  'or changes to items you wrote, by the ids notex_read shows - new words, a new name, or taking one off the canvas:',
  '<Canvas name="Thesis"><Edit id="1793...">new words</Edit><Edit id="1794..." name="New name"/><Remove id="1795..."/></Canvas>',
  '<Remove id> takes off only what you wrote: a box or totem goes with everything inside it and the wires joining it, and nothing is removed if any of that is the user\'s or was edited by the user.',
  'Tags: <Totem name>, <Area name> (a box), <Note name> (a note; a checklist is "- [ ] item" lines), <Text size?> (words; size 10-72 px, default 18),',
  '<File path> (a full path on this machine, copied onto the canvas, or a file name already on it), <ScrollBox name> holding <Page>s,',
  '<Row> (side by side, tops aligned), <Column> (stacked, inside a Row).',
  '<SubTotem name> goes straight inside <Totem>, one level only: a group of its own under the totem, such as the chapters of a book or the cars of a game, holding boxes as a totem does.',
  'NoteX lays out the totem\'s own content first and its sub-totems side by side below it; their places read "Book (totem) > Chapter 1 (sub-totem) > ...".',
  'To connect two boxes, use <Link from to>: File Fabric\'s link between the boxes\' corner dots (such as bottom-left to top-left), which is what a connection is on a canvas.',
  '<Line from to> only draws a line between two boxes with File Fabric\'s Line tool - a drawing, not a connection; use it only when the user asks for a drawn line.',
  'Both name their boxes by name, by a path such as "Collect > Todo" when two share a name, or in an <Add> by a full address.',
  'Children stack top to bottom. Give no sizes or positions: NoteX lays everything out, in free space far from the other totems.',
  // Stacked items made the user's totems thin and long; rows of three spread them across (t-657e827477, t-fd28968487).
  'Stacked, a totem grows long: put a box\'s items - images, texts and notes in any mix - side by side in a <Row> of up to three, and a fourth below.',
  // Four notes: the fourth goes under a shorter one, keeping reading order, so the row stays even (t-4aa052e2fc, t-db21733ba6).
  'With four notes, stack the fourth in a <Column> under a shorter note of the three.',
  // A note is at most 420 px, so lines broken by hand break again (t-c60e2fff9d).
  'Write each note item as one whole line and let File Fabric wrap it: a note is at most 420 px wide, so a line broken by hand breaks again.',
  'Write < as &lt; and & as &amp; in text, or wrap text in <![CDATA[ ... ]]>. Two boxes side by side need different names.',
  // An agent canvas is drawn from one script per totem (t-c42859ce48); drops come from the Inbox (t-2fa309e6c8).
  'On an agent canvas (notex_canvases marks them) the scripts are the canvas: notex_read gives each totem\'s whole script. To change a totem, send its whole <Canvas><Totem> script again with your change - it replaces the old one; <Add>, <Edit> and <Remove> are refused there.',
  'Something the user dropped in NoteX\'s Inbox is placed by its drop id: <Note name="..." drop="d-..."/> or <Text drop="d-..."/> for typed text and Markdown, <File drop="d-..."/> for a PDF, Word file or image - only on the agent canvas the user chose for that drop.',
].join('\n');
