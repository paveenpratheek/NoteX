/* The NoteX page: File Fabric's fabrics as the places NoteX makes of them.
 *
 * Everything it asks of ter-manager goes through plugin-host.js messages -
 * open a terminal, remember a preference, follow the theme, ask for its
 * data folder; everything about fabrics is the engine's, over loopback
 * (t-e1b1aaaa28). Names and text from fabrics are only ever set with
 * textContent, never written into HTML: a note can hold anything.
 */
import { Engine, EngineDown, EngineRefused } from './api.js';
import { followWallpaper } from './wallpaper.js';

const TM = window.TerManager;
const engine = new Engine('.');
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const S = {
  up: false, state: null, local: null, dataDir: null, startedAt: 0,
  fabrics: [], fabric: null, built: null, sections: new Map(), selected: null, view: 'place',
  tab: 'browse', inbox: null,
};

/* ------------------------------------------------------------ the host */

/* host.dataDir is on the host API but plugin-host.js has no helper for it,
 * so it is asked with the same message shape the helpers use. */
let seq = 1_000_000;
const waiting = new Map();
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  const m = e.data;
  if (!m || m.__tm !== 1 || typeof m.id !== 'number' || !waiting.has(m.id)) return;
  const w = waiting.get(m.id);
  waiting.delete(m.id);
  if (m.ok) w.resolve(m.result); else w.reject(new Error(m.error || 'refused'));
});
function hostCall(method, params = {}) {
  if (!TM || !TM.isHosted) return Promise.reject(new Error('not inside ter-manager'));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    window.parent.postMessage({ __tm: 1, id, method, params }, location.origin);
    setTimeout(() => { if (waiting.delete(id)) reject(new Error('ter-manager did not answer')); }, 10_000);
  });
}
const remember = (key, value) => TM && TM.storage.set(key, value).catch(() => {});
const recall = async (key, fallback) => { try { const v = TM && await TM.storage.get(key); return v ?? fallback; } catch (_) { return fallback; } };

function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3500);
}

/* ------------------------------------------------------- engine status */

function startCommand() {
  const node = S.local && S.local.node ? `"${S.local.node}"` : 'node';
  const cli = S.local ? `"${S.local.cli}"` : '"<NoteX folder>\\engine\\cli.js"';
  return `${node} ${cli} serve --data-dir "${S.dataDir || '<data folder>'}"`;
}

function setStatus(kind, text) {
  $('dot').className = 'dot' + (kind === 'up' ? ' up' : kind === 'wait' ? ' wait' : '');
  $('status').textContent = text;
}

function show(which) {
  for (const id of ['offline', 'workspace', 'browse', 'inbox', 'agents', 'phone']) $(id).hidden = id !== which;
  $('views').hidden = !['browse', 'inbox', 'agents', 'phone'].includes(which);
}

const TABS = ['browse', 'inbox', 'agents', 'phone'];
const markTab = (tab) => { for (const t of TABS) $(`view-${t}`).classList.toggle('on', t === tab); };

/* Canvases, the Inbox or Agent canvases, switched from the bar and remembered. */
async function showTab(tab) {
  S.tab = tab;
  remember('tab', tab);
  markTab(tab);
  show(tab);
  if (tab === 'inbox') await loadInbox();
  else if (tab === 'agents') await loadAgents();
  else if (tab === 'phone') await loadPhone();
  else if (!S.fabrics.length) await loadFabrics();
}

async function refresh() {
  let st = null;
  try { st = await engine.state(); } catch (e) { toast(e.message, true); }
  const was = S.up;
  S.up = Boolean(st);
  S.state = st;
  $('ws-change').hidden = !st || !st.workspace;
  $('ws-label').textContent = st && st.workspace ? st.workspace : '';
  if (!st) {
    const starting = Date.now() - S.startedAt < 60_000;
    setStatus(starting ? 'wait' : 'down', starting ? 'Starting the engine…' : 'Engine stopped');
    $('start-cmd').textContent = startCommand();
    $('data-dir').textContent = S.dataDir || 'not given yet';
    $('no-local').hidden = Boolean(S.local);
    $('start-btn').disabled = !S.local || !S.dataDir;
    show('offline');
    return;
  }
  if (!st.workspace || st.error) {
    setStatus('up', 'Engine running');
    $('ws-msg').textContent = st.error || '';
    if (st.workspace && !$('ws-path').value) $('ws-path').value = st.workspace;
    show('workspace');
    return;
  }
  setStatus('up', `Engine running · ${st.fabrics} fabric${st.fabrics === 1 ? '' : 's'}`);
  const waitingDrops = st.inbox ? st.inbox.waiting : 0;
  $('inbox-count').hidden = !waitingDrops;
  $('inbox-count').textContent = String(waitingDrops);
  $('inbox-count').title = `${waitingDrops} drop${waitingDrops === 1 ? '' : 's'} waiting for a canvas`;
  if (S.tab === 'inbox') { show('inbox'); await loadInbox(); return; }
  if (S.tab === 'agents') { show('agents'); await loadAgents(); return; }
  if (S.tab === 'phone') { show('phone'); if (!S.phoneBrowsing) renderPhone(st.phone); return; }
  show('browse');
  if (!was || !S.fabrics.length) await loadFabrics();
  else if (S.built) { renderSync((st.sync && st.sync[S.fabric]) || null); renderRules(st.rules); renderScripts(); } // a save in File Fabric starts a sync
  if (!was && st.reading && !st.reading.finished) followReading();
}

function schedule() {
  clearTimeout(schedule.timer);
  const ms = !S.up ? (Date.now() - S.startedAt < 60_000 ? 1500 : 5000) : 20_000;
  schedule.timer = setTimeout(async () => { await refresh(); schedule(); }, ms);
}

/* The engine runs in a terminal the user can see and stop, as RAGX's does. */
async function startEngine() {
  S.startedAt = Date.now();
  setStatus('wait', 'Starting the engine…');
  const cmd = startCommand();
  if (!TM || !TM.isHosted) { $('start-msg').textContent = 'Open a terminal and run the command above.'; schedule(); return; }
  $('start-msg').textContent = 'Started in a terminal - come back here from the sidebar; this page notices when the engine answers.';
  try { await TM.terminal.open({ cwd: S.local ? S.local.repo : undefined, cmd, title: 'NoteX engine' }); } catch (e) { toast(`Could not open a terminal: ${e.message}`, true); }
  schedule();
}

/* ------------------------------------------------------------ fabrics */

async function loadFabrics() {
  try {
    const r = await engine.fabrics();
    S.fabrics = r.fabrics;
  } catch (e) { toast(e.message, true); return; }
  const ul = $('fabric-list');
  ul.replaceChildren();
  for (const f of S.fabrics) {
    const b = el('button', null);
    // Under the name: when it was saved, then a chip for each thing worth knowing (t-a568290e5c).
    const when = el('span', 'when', `saved ${f.modified.slice(0, 10)}`);
    const chip = (text, kind = '') => when.append(el('span', `chip ${kind}`.trim(), text));
    // Where Read images still has work: "29 to read".
    if (f.images) chip(f.unread ? `${f.unread} to read` : `${f.images} image${f.images === 1 ? '' : 's'} read`, f.unread ? 'warn' : '');
    if (f.sync) chip('Kept in RAGX', 'acc');
    if (f.rules) chip('Rules canvas', 'warn');
    const waitingFor = S.state && S.state.scripts && S.state.scripts[f.name] ? S.state.scripts[f.name].waiting.length : 0;
    if (waitingFor) chip(`${waitingFor} script${waitingFor === 1 ? '' : 's'} waiting`, 'acc');
    b.append(el('span', 'name', f.name), when);
    b.dataset.name = f.name;
    b.addEventListener('click', () => openFabric(f.name));
    const li = el('li', null);
    li.append(b);
    ul.append(li);
  }
  const last = await recall('fabric', null);
  const pick = S.fabrics.find((f) => f.name === (S.fabric || last)) || S.fabrics[0];
  if (pick) openFabric(pick.name);
}

/* The document split back into its sections, keyed by the address each
 * heading holds; the overview is the fabric's own. */
function splitSections(markdown, fabricName) {
  const map = new Map();
  let key = null, buf = [];
  const flush = () => { if (key !== null) map.set(key, buf.join('\n').trim()); };
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      flush();
      const h = line.slice(3);
      key = h === `${fabricName} (fabric)` ? '' : h;
      buf = [];
    } else buf.push(line);
  }
  flush();
  return map;
}

async function openFabric(name) {
  S.fabric = name;
  remember('fabric', name);
  for (const b of $('fabric-list').querySelectorAll('button')) b.classList.toggle('on', b.dataset.name === name);
  $('places-title').textContent = name;
  $('built').textContent = 'reading…';
  try {
    S.built = await engine.fabric(name);
  } catch (e) {
    $('built').textContent = '';
    toast(e instanceof EngineRefused && e.code === 'bad-json' ? `${name} is being saved by File Fabric - try again in a moment.` : e.message, true);
    if (e instanceof EngineDown) refresh();
    return;
  }
  S.sections = splitSections(S.built.markdown, name);
  const n = S.built.images, unread = S.built.unread;
  const imgs = !n ? ' · no images' : unread ? ` · ${n} images, ${unread} not read` : ` · ${n} image${n === 1 ? '' : 's'}, all read`;
  $('built').textContent = `${S.built.map.places.length} places${imgs}`;
  const busy = Boolean(S.state && S.state.reading && !S.state.reading.finished);
  $('read-btn').disabled = !unread || busy;
  $('read-btn').title = busy ? `Reading the images of ${S.state.reading.fabric} - one canvas at a time`
    : !n ? 'This canvas has no images to read' : !unread ? 'Every image on this canvas is read' : `Have RAGX read ${unread} image${unread === 1 ? '' : 's'} with Haiku, two at a time`;
  renderSync(S.built.sync);
  renderRules(S.built.rules);
  renderScripts();
  // A finished job's line is about its own canvas, not this one.
  const job = S.state && S.state.reading;
  if (job && job.finished && job.fabric !== name) $('reading').hidden = true;
  $('doc').textContent = S.built.markdown;
  renderTree();
  select(S.built.map.places.some((p) => p.id === S.selected) ? S.selected : 'fabric');
}

const KIND_WORD = { totem: 'totem', note: 'note', scroll: 'scroll box', page: 'page', canvas: '' };

function renderTree() {
  const places = S.built.map.places;
  const byId = new Map(places.map((p) => [p.id, p]));
  const depth = (p) => { let d = 0; while (p.parent) { p = byId.get(p.parent); d++; } return d; };
  const q = $('filter').value.trim().toLowerCase();
  const ul = $('tree');
  ul.replaceChildren();
  for (const p of places) {
    if (q && !(p.address || p.label || '').toLowerCase().includes(q)) continue;
    const b = el('button', null);
    b.dataset.id = p.id;
    b.style.paddingLeft = `${8 + (q ? 0 : depth(p)) * 14}px`;
    b.title = p.address || p.label;
    // Found by a search, a place is shown with its parent: the whole address is in its tooltip.
    const parent = p.parent && byId.get(p.parent);
    const shown = p.kind === 'fabric' ? `${p.label} (fabric)`
      : q ? (parent && parent.kind !== 'fabric' ? `${parent.label} > ${p.label}` : p.label)
      : p.label.replace(/ \((totem|note|scroll box)\)$/, '');
    b.append(el('span', 'name', shown));
    const kind = p.kind === 'fabric' ? '' : KIND_WORD[p.kind] ?? '';
    if (p.owner && !q) b.append(el('span', 'kind agent', `totem · ${p.owner}`));
    else if (kind && !q) b.append(el('span', 'kind', kind));
    const n = p.files.length + p.texts + (p.pens ? 1 : 0);
    if (p.checklist && p.checklist.total) b.append(el('span', 'count', `${p.checklist.done}/${p.checklist.total}`));
    else if (n) b.append(el('span', 'count', String(n)));
    b.addEventListener('click', () => select(p.id));
    const li = el('li', null);
    li.append(b);
    ul.append(li);
  }
  for (const b of ul.querySelectorAll('button')) b.classList.toggle('on', b.dataset.id === S.selected);
}

function select(id) {
  S.selected = id;
  const p = S.built.map.places.find((x) => x.id === id);
  if (!p) return;
  for (const b of $('tree').querySelectorAll('button')) b.classList.toggle('on', b.dataset.id === id);
  $('address').textContent = p.kind === 'fabric' ? `${p.label} (fabric)` : p.address;
  const box = $('section');
  box.replaceChildren(el('div', 'head', p.kind === 'fabric' ? `${p.label} (fabric)` : p.address));
  box.append(el('div', null, S.sections.get(p.kind === 'fabric' ? '' : p.address) || ''));
  const kids = p.children.map((c) => S.built.map.places.find((x) => x.id === c)).filter(Boolean);
  if (kids.length) {
    const line = el('div', 'note', 'Open: ');
    kids.forEach((k, i) => {
      if (i) line.append(' · ');
      const a = el('span', 'jump', k.label);
      a.addEventListener('click', () => select(k.id));
      line.append(a);
    });
    box.append(el('div', null, '\n'), line);
  }
  showView(S.view);
}

function showView(v) {
  S.view = v;
  $('section').hidden = v !== 'place';
  $('doc').hidden = v !== 'doc';
  $('show-place').classList.toggle('on', v === 'place');
  $('show-doc').classList.toggle('on', v === 'doc');
}

/* ------------------------------------------------------- Read images */

/* RAGX reads the images with Haiku, two at a time (t-6b38e0dc27); the page
 * follows the job through /api/state and rebuilds the fabric when it ends. */
async function readImages() {
  if (!S.fabric) return;
  try { await engine.readImages(S.fabric); } catch (e) { toast(e.message, true); return; }
  $('read-btn').disabled = true;
  followReading();
}

async function followReading() {
  clearTimeout(followReading.timer);
  let st;
  try { st = await engine.state(); } catch (_) { st = null; }
  const job = st && st.reading;
  const line = $('reading');
  if (!job) { line.hidden = true; return; }
  line.hidden = false;
  if (!job.finished) {
    line.textContent = job.total == null ? `Reading the images of ${job.fabric}…` : `Reading the images of ${job.fabric}: ${job.done}/${job.total}${job.failed ? `, ${job.failed} failed` : ''}`;
    followReading.timer = setTimeout(followReading, 1500);
    return;
  }
  const r = job.result || {};
  line.textContent = r.error ? `Could not read the images: ${r.error}`
    : `${job.fabric}: ${r.read} image${r.read === 1 ? '' : 's'} read${r.toRead > r.read ? ` of ${r.toRead}` : ''}${r.failed && r.failed.length ? `, ${r.failed.length} failed` : ''}.${r.stopped ? ` Stopped: ${r.stopped}` : ''}`;
  line.classList.toggle('bad', Boolean(r.error || r.stopped));
  S.state = st;
  loadFabrics(); // the list's "to read" counts change; it opens the selected canvas again
}

/* ------------------------------------------------------------ auto-sync */

const SYNC_WORD = {
  settling: 'waiting for File Fabric to finish saving', waiting: 'synced less than a minute ago - the next sync waits its turn',
  queued: 'waiting for Read images to finish', building: 'building the document', reading: 'reading new images',
  sending: 'sending to RAGX', 'waiting-ragx': "waiting for RAGX's engine", missing: 'its fabric.json is gone', error: 'could not sync',
};

function ago(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86_400 ? `${Math.round(s / 3600)} h ago` : iso.slice(0, 10);
}

/* The open canvas's switch and line: whether it is kept in RAGX, and where its sync is. */
function renderSync(sync) {
  // An agent canvas is always kept in RAGX; its switch stays on (t-65a490ef80).
  const agentOwned = Boolean((S.fabrics.find((f) => f.name === S.fabric) || {}).agent);
  const on = Boolean(sync) || agentOwned;
  const btn = $('sync-btn');
  btn.setAttribute('aria-checked', String(on));
  btn.disabled = agentOwned;
  btn.title = agentOwned ? 'Assigned to the agent, so always kept in RAGX: synced 15 s after each change. Take it back from the agent to stop.'
    : on ? 'Kept in RAGX: synced 15 s after each save. Press to stop.' : 'Keep this canvas in RAGX: synced now and after each save';
  if (!sync) { $('sync-line').hidden = true; return; }
  const line = $('sync-line');
  line.hidden = !on;
  if (!on) return;
  const word = sync.status === 'synced'
    ? (sync.at ? `In RAGX - synced ${ago(sync.at)}` : 'In RAGX') + (sync.detail ? ` (${sync.detail})` : '')
    : `Auto-sync: ${SYNC_WORD[sync.status] || sync.status}${sync.detail ? ` - ${sync.detail}` : ''}`;
  line.textContent = word;
  line.classList.toggle('bad', sync.status === 'error' || sync.status === 'missing');
  // While a sync is under way, follow it; a settled canvas is looked at with the rest.
  clearTimeout(renderSync.timer);
  if (sync.status !== 'synced' && sync.status !== 'error') renderSync.timer = setTimeout(followSync, 2500);
}

async function followSync() {
  let st;
  try { st = await engine.state(); } catch (_) { st = null; }
  if (!st || !S.fabric) return;
  S.state = st;
  const now = st.sync && st.sync[S.fabric];
  const was = $('sync-line').textContent;
  renderSync(now || null);
  // Synced: its document changed, so it is built again for the page.
  if (now && now.status === 'synced' && was && !was.startsWith('In RAGX')) loadFabrics();
}

async function toggleSync() {
  if (!S.fabric) return;
  const on = $('sync-btn').getAttribute('aria-checked') !== 'true';
  try {
    const r = await engine.setSync(S.fabric, on);
    renderSync(r.sync);
    toast(on ? `${S.fabric} is kept in RAGX - synced now and 15 s after each save.` : `${S.fabric} is no longer synced; what RAGX has stays.`);
    loadFabrics();
  } catch (e) { toast(e.message, true); }
}

/* ---------------------------------------------------------- rules canvas */

/* The open canvas's Rules canvas switch, and - on the rules canvas - what
 * rules.md holds: its size, since every agent reply reads it again, and the
 * line the user's CLAUDE.md imports it with (t-f93928ce0d, t-00728790ad). */
function renderRules(rules) {
  const on = Boolean(rules && rules.canvas && rules.canvas === S.fabric);
  const btn = $('rules-btn');
  btn.setAttribute('aria-checked', String(on));
  btn.title = on ? 'The rules canvas: its own words are written to rules.md after each save. Press to stop.'
    : rules && rules.canvas ? `${rules.canvas} is the rules canvas now - press to make this one it instead`
    : 'Make this the rules canvas: its own words become rules every agent loads';
  const line = $('rules-line');
  line.hidden = !on;
  if (!on) return;
  line.replaceChildren();
  const size = rules.tokens == null ? '' : ` · about ${rules.tokens.toLocaleString()} tokens${rules.warn ? ` - over ${rules.limit.toLocaleString()}, and read with every agent reply` : ''}`;
  // The canvas is the source; rules.md is what NoteX writes from it.
  const what = !rules.places
    ? `Nothing written on ${S.fabric} yet - rules.md holds only the two fixed lines. Add text or notes here in File Fabric; they go in after the next save`
    : `Rules for agents from ${rules.places} place${rules.places === 1 ? '' : 's'} on ${S.fabric}, copied to rules.md${size}${rules.at ? ` · updated ${ago(rules.at)}` : ''}`;
  line.append(`${what}${rules.error ? ` - ${rules.error}` : ''}`);
  line.classList.toggle('bad', Boolean(rules.warn || rules.error));
  const imp = el('code', 'import', rules.importLine);
  imp.title = 'The line your ~/.claude/CLAUDE.md loads it with';
  line.append(el('br'), 'Loaded by: ', imp);
}

async function toggleRules() {
  if (!S.fabric) return;
  const on = $('rules-btn').getAttribute('aria-checked') !== 'true';
  try {
    const r = await engine.setRules(S.fabric, on);
    renderRules(r.rules);
    toast(on ? `${S.fabric} is the rules canvas - its own words are in rules.md.` : `${S.fabric} is no longer the rules canvas; rules.md holds only the fixed lines.`);
    loadFabrics();
  } catch (e) { toast(e.message, true); }
}

/* ------------------------------------------------------ agent scripts */

/* Totem scripts agents sent for the open canvas: those waiting while File
 * Fabric has it open, which can be cancelled, and the last few written or
 * refused (t-a80b904d43). */
function renderScripts() {
  const line = $('scripts-line');
  const c = S.state && S.state.scripts && S.fabric ? S.state.scripts[S.fabric] : null;
  clearTimeout(renderScripts.timer);
  // A script waiting a moment ago has been written: the canvas is built again to show it.
  const was = renderScripts.waiting;
  renderScripts.waiting = { fabric: S.fabric, n: c ? c.waiting.length : 0 };
  if (was && was.fabric === S.fabric && was.n > renderScripts.waiting.n && S.built) { openFabric(S.fabric); return; }
  if (!c || (!c.waiting.length && !c.recent.length)) { line.hidden = true; return; }
  line.hidden = false;
  // Drawn again only when something changed, so a Cancel is never pulled from under a click.
  const key = JSON.stringify([S.fabric, c.open, c.waiting.map((w) => w.id), c.recent.map((r) => r.id + r.status)]);
  if (c.waiting.length) renderScripts.timer = setTimeout(refresh, 5000);
  if (key === renderScripts.key) return;
  renderScripts.key = key;
  line.replaceChildren();
  if (c.waiting.length) {
    line.append(el('span', 'script', `${c.waiting.length} agent script${c.waiting.length === 1 ? '' : 's'} waiting - ${c.open ? 'File Fabric has this canvas open; NoteX writes them 30 s after it is closed' : 'being written'}:`));
    for (const w of c.waiting) {
      const row = el('span', 'script', `· ${w.what}, from ${w.owner}, sent ${ago(w.at)} `);
      const cancel = el('span', 'jump', 'Cancel');
      cancel.addEventListener('click', async () => {
        try { await engine.cancelScript(w.id); toast(`Cancelled ${w.what} from ${w.owner}.`); await refresh(); } catch (e) { toast(e.message, true); }
      });
      row.append(cancel);
      line.append(row);
    }
  }
  const WORD = { written: 'Written', refused: 'Refused', failed: 'Could not write', cancelled: 'Cancelled' };
  for (const r of c.recent.slice(0, 3)) {
    const why = r.result && r.result.message && r.status !== 'written' ? ` - ${r.result.message}` : '';
    line.append(el('span', r.status === 'written' ? 'script' : 'script bad', `${WORD[r.status] || r.status}: ${r.what}, from ${r.owner}, ${ago(r.done || r.at)}${why}`));
  }
}

/* ------------------------------------------------------------- inbox */

/* What the user drops is kept as it arrived until it goes to a canvas
 * assigned to the agent - picked now or later (t-85f3ec23ef, t-0f32cb63f2).
 * Only canvases CanvasX has assigned are offered (t-52f040cf72).
 *
 * The composer sends like a chat prompt: files attached, what they are, and
 * a message to the agent, with one Send (t-e0f8a22b3a, t-319d8470cb). With a
 * message, the canvas can be left to it (t-8c4e28b7b4). */
const KIND_LABEL = { text: 'Text', md: 'Markdown', pdf: 'PDF', docx: 'Word', image: 'Image' };
const DROP_STATUS = { waiting: 'Waiting for a canvas', queued: 'Queued', placing: 'Being placed', placed: 'Placed', failed: 'Could not place' };
const BY_MESSAGE = '*message';
const DROP_EXT = { txt: 'TXT', md: 'MD', markdown: 'MD', pdf: 'PDF', docx: 'DOCX', png: 'IMG', jpg: 'IMG', jpeg: 'IMG', webp: 'IMG', gif: 'IMG' };
const extOf = (name) => ((/\.([^.]+)$/.exec(name) || [])[1] || '').toLowerCase();

/* byMessage adds "As my message says": true offers it, 'off' shows it greyed. */
function canvasSelect(sel, canvases, current, later, byMessage = false) {
  sel.replaceChildren();
  if (later) sel.append(new Option(canvases.length || byMessage ? 'Choose the canvas later' : 'No canvas is assigned to the agent yet', ''));
  for (const c of canvases) sel.append(new Option(c, c));
  if (byMessage) {
    const o = new Option('As my message says', BY_MESSAGE);
    o.disabled = byMessage === 'off';
    sel.append(o);
  }
  sel.value = current === BY_MESSAGE && byMessage === true ? BY_MESSAGE : current && canvases.includes(current) ? current : '';
  sel.disabled = !canvases.length && !byMessage;
}

async function loadInbox() {
  let r;
  try { r = await engine.inbox(); } catch (e) { toast(e.message, true); return; }
  S.inbox = r;
  canvasSelect($('drop-canvas'), r.canvases, $('drop-canvas').value, true, $('drop-ask').value.trim() ? true : 'off');
  $('drop-help').textContent = r.canvases.length
    ? 'Everything you send is kept as it is. With a canvas, the agent places it there; "As my message says" lets your message name the canvas, or ask for a new one. With neither, it waits here.'
    : 'No canvas is assigned to the agent yet. Tell the agent in your message - "a new canvas named Bills" - and pick "As my message says", or assign one in CanvasX. Until then, what you send waits here.';
  renderPlacer(r.placer, r.drops);
  renderDrops();
  // While the agent has drops to place, the list follows it.
  clearTimeout(loadInbox.timer);
  if (S.tab === 'inbox' && r.drops.some((d) => d.status === 'queued' || d.status === 'placing')) loadInbox.timer = setTimeout(loadInbox, 4000);
}

/* The agent places queued drops with Claude, one at a time (t-c24e0494a2);
 * the switch stops it, and the line says what it is doing or why it waits. */
/* Sonnet, Opus or Haiku, for placing and for asks (t-fe1817678b), and Gemini
 * through Antigravity, apart (t-bdcb28547b). */
const MODEL_LABEL = {
  sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku',
  'gemini-3.8-flash-high': 'Gemini 3.8 Flash (High)', 'gemini-3.8-flash-medium': 'Gemini 3.8 Flash (Medium)', 'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
};
function modelSelect(sel, models, current) {
  const keep = sel.value;
  // An engine older than this page sends no models: no empty picker then.
  sel.hidden = !(models && models.length);
  const opt = (m) => new Option(MODEL_LABEL[m] || m, m);
  const group = (label, list) => { const g = document.createElement('optgroup'); g.label = label; g.append(...list.map(opt)); return g; };
  const gemini = (models || []).filter((m) => m.startsWith('gemini-'));
  const claude = (models || []).filter((m) => !m.startsWith('gemini-'));
  sel.replaceChildren(...(gemini.length ? [group('Claude', claude), group('Gemini · Antigravity', gemini)] : claude.map(opt)));
  sel.value = current || keep;
}

function renderPlacer(p, drops) {
  modelSelect($('placer-model'), S.inbox && S.inbox.models, p.model);
  const btn = $('placing-btn');
  btn.setAttribute('aria-checked', String(p.on));
  btn.title = p.on ? `The agent places each queued drop on its canvas, with Claude (${p.model}). Press to stop.` : 'Queued drops wait. Press to let the agent place them.';
  const line = $('placer-line');
  const doing = p.placing && drops.find((d) => d.id === p.placing);
  const text = !p.on ? (drops.some((d) => d.status === 'queued') ? 'Placing is off: queued drops wait until you switch it on.' : '')
    : p.held ? `Placing is paused for a few minutes: ${p.held}`
      : doing ? `The agent is placing ${doing.name || 'your text'}${doing.send && drops.filter((d) => d.send === doing.send).length > 1 ? ' and what was sent with it' : ''} on ${doing.canvas || 'the canvas its message names'}…` : '';
  line.hidden = !text;
  line.textContent = text;
  line.classList.toggle('bad', Boolean(p.on && p.held));
}

async function setPlacerModel() {
  const model = $('placer-model').value;
  try { await engine.setPlacerModel(model); toast(`The agent places drops with ${MODEL_LABEL[model] || model}.`); await loadInbox(); } catch (e) { toast(e.message, true); }
}

async function togglePlacing() {
  const on = $('placing-btn').getAttribute('aria-checked') !== 'true';
  try { await engine.setPlacing(on); toast(on ? 'The agent places queued drops again.' : 'Placing is off - queued drops wait.'); await loadInbox(); } catch (e) { toast(e.message, true); }
}

function renderDrops() {
  const { drops, canvases } = S.inbox;
  const waitingN = drops.filter((d) => d.status === 'waiting').length;
  $('drops-count').textContent = drops.length ? `${drops.length} drop${drops.length === 1 ? '' : 's'}${waitingN ? ` · ${waitingN} waiting` : ''}` : '';
  const ul = $('drop-list');
  ul.replaceChildren();
  if (!drops.length) { ul.append(el('li', 'note empty', 'Nothing in the inbox yet.')); return; }
  for (const d of drops) {
    const li = el('li', 'drop card');
    const top = el('div', 'top');
    top.append(el('span', 'chip', KIND_LABEL[d.kind] || d.kind), el('span', 'what', d.name || d.preview || '(empty)'));
    if (d.name && d.preview) top.title = d.preview;
    const meta = el('div', 'meta');
    meta.append(el('span', null, ago(d.landedAt)));
    const kind = d.status === 'waiting' ? 'warn' : d.status === 'failed' ? 'bad' : d.status === 'placed' ? '' : 'acc';
    const target = d.status === 'waiting' ? null : d.canvas || (d.byMessage ? 'as its message says' : null);
    meta.append(el('span', `chip ${kind}`.trim(), target ? `${DROP_STATUS[d.status]} · ${target}` : DROP_STATUS[d.status] || d.status));
    if (d.detail) meta.append(el('span', d.status === 'failed' ? 'bad' : null, d.detail));
    li.append(top, meta);
    if (d.note) li.append(el('div', 'drop-note', d.note));
    if (d.ask) {
      const ask = el('div', 'drop-ask');
      ask.append(el('b', null, 'To the agent: '), document.createTextNode(d.ask));
      li.append(ask);
    }
    const acts = el('div', 'acts');
    // Its canvas can change until the agent starts placing it.
    if (d.status === 'waiting' || d.status === 'queued' || d.status === 'failed') {
      const sel = el('select');
      sel.setAttribute('aria-label', 'Agent canvas');
      canvasSelect(sel, canvases, d.byMessage ? BY_MESSAGE : d.canvas, !d.canvas && !d.byMessage, Boolean(d.ask));
      sel.addEventListener('change', async () => {
        if (!sel.value) return;
        try {
          if (sel.value === BY_MESSAGE) { await engine.leaveToMessage(d.id); toast('Queued - the agent places it as your message says.'); } else { await engine.chooseCanvas(d.id, sel.value); toast(`Queued for ${sel.value}.`); }
          await loadInbox();
          refresh();
        } catch (e) { toast(e.message, true); }
      });
      acts.append(sel);
    }
    const forget = el('button', 'danger', 'Forget');
    forget.title = 'Remove this drop for good: from the Inbox, its canvas and RAGX';
    // Out of its scripts, the canvas, the backups, RAGX and bronze (t-985017e732).
    forget.addEventListener('click', async () => {
      const where = d.status === 'placed' ? ` It comes off ${d.canvas} and out of RAGX too.` : '';
      if (!window.confirm(`Forget ${d.name || 'this text'}? It is removed for good.${where}`)) return;
      try { await engine.forgetDrop(d.id); toast('Forgotten.'); await loadInbox(); refresh(); } catch (e) { toast(e.message, true); }
    });
    acts.append(forget);
    li.append(acts);
    ul.append(li);
  }
}

/* Files wait above the description until Send, each with a way to take it off. */
function attach(files) {
  const refused = files.filter((f) => !DROP_EXT[extOf(f.name)]).map((f) => f.name);
  if (refused.length) toast(`${refused.join(', ')}: not text, Markdown, a PDF, a Word file or a PNG, JPEG, WebP or GIF image.`, true);
  S.attached = [...(S.attached || []), ...files.filter((f) => DROP_EXT[extOf(f.name)])];
  renderAttached();
}

function renderAttached() {
  const ul = $('drop-attached');
  for (const img of ul.querySelectorAll('img')) URL.revokeObjectURL(img.src);
  ul.replaceChildren();
  const files = S.attached || [];
  ul.hidden = !files.length;
  files.forEach((f, i) => {
    const li = el('li');
    li.title = f.name;
    if (DROP_EXT[extOf(f.name)] === 'IMG') {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(f);
      img.alt = '';
      li.append(img);
    } else li.append(el('span', 'kind', DROP_EXT[extOf(f.name)]));
    const off = el('button', null, '×');
    off.title = `Take ${f.name} off`;
    off.setAttribute('aria-label', `Take ${f.name} off`);
    off.addEventListener('click', () => { S.attached.splice(i, 1); renderAttached(); });
    li.append(el('span', 'name', f.name), off);
    ul.append(li);
  });
  $('drop-text').placeholder = files.length
    ? `What ${files.length === 1 ? 'this is' : 'these are'} - what you want remembered about ${files.length === 1 ? 'it' : 'them'}`
    : "Describe what you're dropping - or, with no file, type what to keep";
}

/* "As my message says" follows the message box until the user picks a canvas themselves. */
function askChanged() {
  const sel = $('drop-canvas');
  const has = Boolean($('drop-ask').value.trim());
  const opt = [...sel.options].find((o) => o.value === BY_MESSAGE);
  if (opt) opt.disabled = !has;
  if (!S.canvasPicked) sel.value = has ? BY_MESSAGE : '';
  else if (!has && sel.value === BY_MESSAGE) sel.value = '';
}

async function sendDrop() {
  const files = S.attached || [];
  const description = $('drop-text').value;
  const ask = $('drop-ask').value.trim();
  const to = $('drop-canvas').value;
  if (!files.length && !description.trim()) { toast('Attach a file or write what to keep first.', true); return; }
  if (to === BY_MESSAGE && !ask) { toast('Tell the agent where it goes, or pick a canvas.', true); return; }
  const btn = $('drop-send');
  btn.disabled = true;
  try {
    await engine.sendDrop({ files, description, ask, canvas: to === BY_MESSAGE ? '' : to, byMessage: to === BY_MESSAGE });
    S.attached = [];
    renderAttached();
    $('drop-text').value = '';
    $('drop-ask').value = '';
    S.canvasPicked = false;
    askChanged();
    const what = files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'your text';
    toast(`Kept ${what}${to === BY_MESSAGE ? ' - the agent places it as your message says' : to ? ` for ${to}` : ''}.`);
  } catch (e) { toast(e.message, true); return; } finally { btn.disabled = false; }
  await loadInbox();
  refresh();
}

/* ---------------------------------------------------- agent canvases */

/* ter-manager's view of CanvasX: every canvas, whose it is, whether CanvasX
 * has it open; an agent canvas's totem scripts and what happened to it
 * (t-a9a33794bd). CanvasX itself stays the app canvases are drawn in. */
const DRAWN = { new: 'drawn from its script', current: 'drawn from its script', good: 'drawn from its last good script', none: 'left out' };

async function loadAgents() {
  let r;
  try { r = await engine.agentCanvases(); } catch (e) { toast(e.message, true); return; }
  const ul = $('agent-list');
  ul.replaceChildren();
  for (const c of r.canvases) {
    const b = el('button', null);
    b.dataset.name = c.name;
    const when = el('span', 'when', `saved ${c.modified.slice(0, 10)}`);
    const chip = (text, kind = '') => when.append(el('span', `chip ${kind}`.trim(), text));
    if (c.agent) chip(`Agent · ${c.totems} totem${c.totems === 1 ? '' : 's'}`, 'acc');
    if (c.trouble) chip(`${c.trouble} not drawn as sent`, 'warn');
    if (c.open) chip('open in CanvasX');
    b.append(el('span', 'name', c.name), when);
    b.addEventListener('click', () => openAgentCanvas(c.name));
    const li = el('li', null);
    li.append(b);
    ul.append(li);
  }
  const pick = r.canvases.find((c) => c.name === S.agentCanvas) || r.canvases.find((c) => c.agent) || r.canvases[0];
  if (pick) await openAgentCanvas(pick.name);
}

async function openAgentCanvas(name) {
  S.agentCanvas = name;
  for (const b of $('agent-list').querySelectorAll('button')) b.classList.toggle('on', b.dataset.name === name);
  let c;
  try { c = await engine.agentCanvas(name); } catch (e) { toast(e.message, true); return; }
  $('agent-title').textContent = name;
  $('agent-sub').textContent = c.agent ? `${c.totems.length} totem${c.totems.length === 1 ? '' : 's'}${c.lastRender ? ` · drawn ${ago(c.lastRender.at)}` : ''}` : 'your canvas';
  const assign = $('assign-btn');
  assign.hidden = false;
  assign.setAttribute('aria-checked', String(c.agent));
  assign.title = c.agent ? 'Take it back: it becomes your canvas again, holding what NoteX last drew' : 'Assign it to the agent: NoteX draws it from the agent\'s scripts, and CanvasX shows it view-only';
  $('render-btn').hidden = !c.agent;
  renderHistory(c);
  $('agent-help').textContent = c.agent
    ? 'NoteX draws this canvas from the scripts below; CanvasX shows it view-only. Drops you send it from the Inbox are placed into these scripts.'
    : `Only an empty canvas can be assigned, and not while CanvasX has it open${c.open ? ' - it is open now' : ''}. Make a new canvas in CanvasX for the agent.`;
  renderAsk(name, c);
  $('agent-body').hidden = !c.agent && !c.activity.length;
  const ul = $('totem-list');
  ul.replaceChildren();
  $('totem-script').hidden = true;
  if (c.agent && !c.totems.length) ul.append(el('li', 'note', 'No totem scripts yet - the agent writes the first when it places a drop.'));
  for (const t of c.totems) {
    const li = el('li', 'totem card');
    const top = el('div', 'top');
    top.append(el('span', 'what', t.name), el('span', `chip ${t.drawn === 'good' || t.drawn === 'none' ? 'warn' : ''}`.trim(), DRAWN[t.drawn] || 'not drawn yet'));
    const meta = el('div', 'meta');
    meta.append(el('span', null, `${t.drops} drop${t.drops === 1 ? '' : 's'}`), el('span', null, `${t.versions} earlier version${t.versions === 1 ? '' : 's'}`));
    if (t.owner) meta.append(el('span', null, `by ${t.owner}`));
    li.append(top, meta);
    for (const err of t.errors) li.append(el('div', 'bad', err));
    li.addEventListener('click', () => {
      const pre = $('totem-script');
      const same = !pre.hidden && pre.dataset.totem === t.name;
      pre.hidden = same;
      pre.dataset.totem = t.name;
      pre.textContent = t.script || '(no script file)';
    });
    ul.append(li);
  }
  const act = $('activity-list');
  act.replaceChildren();
  if (!c.activity.length) act.append(el('li', 'note', 'Nothing has happened here yet.'));
  for (const a of c.activity) {
    const say = a.what === 'script' ? `${a.change} from ${a.owner}: ${a.status === 'written' ? 'kept' : a.status}${a.message ? ` - ${a.message}` : ''}`
      : a.what === 'render' ? `Drawn - ${a.totems.join(', ') || 'no totems'}${a.placed && a.placed.length ? ` · placed ${a.placed.length}` : ''}`
        : a.what === 'asked' ? `Asked (${MODEL_LABEL[a.model] || a.model}): ${a.ask}`
          : a.what === 'answered' ? (a.status === 'done' ? `Arranged as asked - ${a.totems.join(', ')}` : a.status === 'answered' ? 'Answered in the chat' : a.detail || 'Could not arrange it')
            : a.what === 'spaced' ? `Moved ${a.totems.join(', ')} clear of the totems beside ${a.totems.length === 1 ? 'it' : 'them'}`
              : a.what === 'forgot' ? `Forgot drop ${a.drop}` : a.what === 'assigned' ? 'Assigned to the agent' : a.what === 'taken back' ? 'Taken back from the agent' : a.what;
    const li = el('li', a.status && !['written', 'done', 'answered'].includes(a.status) ? 'bad' : null);
    li.append(el('span', 'when', ago(a.at)), el('span', null, say));
    act.append(li);
  }
}

/* The user asks the agent about this canvas in their own words; the agent
 * rewrites its totem scripts, keeping everything on it (t-a9198c414f,
 * t-b5d4a34951). The line follows the ask until it is answered. */
function renderAsk(name, c) {
  $('ask-box').hidden = !c.agent;
  if (!c.agent) return;
  const sel = $('ask-model');
  if (sel.dataset.canvas !== name || !sel.options.length) modelSelect(sel, c.models, c.model);
  sel.dataset.canvas = name;
  const a = c.ask;
  const working = Boolean(a && a.status === 'working');
  const line = $('ask-line');
  // The page is served from the plugin folder, so it can be newer than the engine running.
  if (!c.models) {
    sel.hidden = true;
    delete sel.dataset.canvas; // filled again once the engine answers with its models
    $('ask-btn').disabled = true;
    line.hidden = false;
    line.classList.add('bad');
    line.textContent = 'NoteX\'s engine is older than this page. Restart it from the ⋯ menu (Stop engine, then Start engine) to ask the agent.';
    return;
  }
  $('ask-btn').disabled = working;
  line.hidden = !a;
  line.classList.toggle('bad', Boolean(a && a.status === 'failed'));
  if (a) {
    line.textContent = working ? `The agent (${MODEL_LABEL[a.model] || a.model}) is thinking…`
      : a.status === 'done' ? `Changed ${ago(a.doneAt)}: ${a.totems.join(', ')}.` : a.status === 'failed' ? a.detail || 'The agent could not do it.' : '';
    line.hidden = !line.textContent;
  }
  renderChat($('ask-chat'), c.chat || []);
  clearTimeout(renderAsk.timer);
  if (working) renderAsk.timer = setTimeout(() => { if (S.tab === 'agents' && S.agentCanvas === name) openAgentCanvas(name); }, 3000);
}

/* The conversation NoteX keeps for the canvas - from here or from CanvasX's
 * chat beside the canvas (t-2ffa1ff1de). */
function renderChat(ul, chat) {
  const atEnd = ul.scrollHeight - ul.scrollTop - ul.clientHeight < 40;
  ul.replaceChildren();
  ul.hidden = !chat.length;
  for (const t of chat) {
    const li = el('li', `${t.who === 'user' ? 'user' : 'agent'}${t.status === 'failed' ? ' bad' : ''}`);
    const who = t.who === 'user' ? `You${t.source === 'canvasx' ? ', in CanvasX' : ''}` : `Agent (${MODEL_LABEL[t.model] || t.model})${t.totems && t.totems.length ? ` · changed ${t.totems.join(', ')}` : ''}`;
    li.append(el('span', 'who', `${who} · ${ago(t.at)}`), document.createTextNode(t.text || ''));
    // Files attached in CanvasX's chat (t-79ac13d22a).
    if (t.attachments && t.attachments.length) li.append(el('span', 'attached', `📎 ${t.attachments.map((a) => a.name).join(', ')}`));
    ul.append(li);
  }
  if (atEnd || ul.dataset.count !== String(chat.length)) ul.scrollTop = ul.scrollHeight;
  ul.dataset.count = String(chat.length);
}

async function askAgent() {
  const name = S.agentCanvas;
  const ask = $('ask-text').value.trim();
  if (!ask) { toast('Write what the agent should do with the canvas.', true); return; }
  const model = $('ask-model').value;
  try {
    await engine.askAgent(name, ask, model);
    $('ask-text').value = '';
    toast(`Asked the agent (${MODEL_LABEL[model] || model}) about ${name}.`);
  } catch (e) { toast(e.message, true); return; }
  await openAgentCanvas(name);
}

async function toggleAssign() {
  const name = S.agentCanvas;
  const on = $('assign-btn').getAttribute('aria-checked') !== 'true';
  if (!on && !window.confirm(`Take ${name} back from the agent? It becomes your canvas again, holding what NoteX last drew, and NoteX stops drawing it.`)) return;
  try { await engine.setAgent(name, on); toast(on ? `${name} is the agent's now.` : `${name} is yours again.`); await loadAgents(); } catch (e) { toast(e.message, true); }
}

/* Keep history: the canvas's scripts kept at every write, so they can be
 * had as they stood at any time (t-732b681a32). Times show in this
 * browser's own time zone; the records keep UTC. */
function renderHistory(c) {
  const h = c.history;
  const btn = $('history-btn');
  // An engine older than this page sends no history.
  btn.hidden = !h || (!c.agent && !h.kept);
  $('history-box').hidden = !h || (!h.on && !h.kept);
  if (!h) return;
  btn.setAttribute('aria-checked', String(h.on));
  btn.disabled = !c.agent && !h.on;
  btn.title = h.on ? 'Stop keeping history: what was kept stays, nothing more is added'
    : 'Keep history: every write of these scripts is kept, with who wrote it and when, starting with the versions NoteX already has';
  const local = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  $('history-line').textContent = h.error ? h.error
    : h.on ? `Kept since ${local(h.since)}, in NoteX's data folder - never pushed anywhere.`
      : h.kept ? `Not kept since ${local(h.off)}; what was kept stays.` : '';
  const ul = $('history-list');
  ul.replaceChildren();
  for (const e of h.latest || []) {
    const what = [e.added.length ? `added ${e.added.join(', ')}` : '', e.changed.length ? `changed ${e.changed.join(', ')}` : '', e.deleted.length ? `deleted ${e.deleted.join(', ')}` : ''].filter(Boolean).join('; ') || 'the totems in a new order';
    const li = el('li', null);
    li.append(el('span', 'when', local(e.at)), el('span', null, `${e.who}: ${what}`));
    ul.append(li);
  }
}

async function toggleHistory() {
  const name = S.agentCanvas;
  const on = $('history-btn').getAttribute('aria-checked') !== 'true';
  try {
    const r = await engine.setHistory(name, on);
    toast(on ? `${name}'s history is kept${r.history.replayed ? `, starting with ${r.history.replayed} earlier write${r.history.replayed === 1 ? '' : 's'}` : ''}.` : `${name}'s history is no longer kept; what was kept stays.`);
  } catch (e) { toast(e.message, true); }
  await openAgentCanvas(name);
}

async function drawAgain() {
  try { const r = await engine.render(S.agentCanvas); toast(`Drawn: ${r.totems.length} totem${r.totems.length === 1 ? '' : 's'}.`); await openAgentCanvas(S.agentCanvas); } catch (e) { toast(e.message, true); }
}

async function setRagxFolder() {
  $('menu').hidden = true;
  const now = S.state && S.state.ragx;
  const p = window.prompt('RAGX\'s plugin folder - the one holding its plugin.json:', now || '');
  if (!p) return;
  try { const r = await engine.setRagx(p); toast(`NoteX reads images through RAGX at ${r.ragx}.`); S.state.ragx = r.ragx; } catch (e) { toast(e.message, true); }
}

/* -------------------------------------------------------------- phone */

/* The phone over the USB cable: set up once by browsing to CanvasXP's
 * folder on it, then synced whenever the user says it is attached
 * (t-71306596ff, t-76fdccd60b). */
async function loadPhone() {
  let r;
  try { r = await engine.phone(); } catch (e) { toast(e.message, true); return; }
  if (!r.setup) return startPhoneSetup();
  renderPhone(r);
}

const list = (names) => names.map((n) => (typeof n === 'string' ? n : n.copy ? `${n.name} → ${n.copy}` : `${n.name} (from the ${n.from === 'pc' ? 'PC' : 'phone'})`)).join(', ');

function renderPhone(r) {
  if (!r || S.phoneBrowsing) return;
  if (!r.setup) { startPhoneSetup(); return; }
  $('phone-setup').hidden = true;
  $('phone-ready').hidden = false;
  $('phone-title').textContent = r.setup.name;
  $('phone-sub').textContent = `${r.setup.device} · ${r.setup.path.join(' › ')}`;
  $('phone-sync').disabled = r.running;
  $('phone-sync').textContent = r.running ? 'Syncing…' : 'Phone attached - sync';
  const line = $('phone-line');
  const ul = $('phone-result');
  ul.replaceChildren();
  if (r.running) {
    line.hidden = false;
    line.textContent = `${r.progress || 'Working'}…`;
    clearTimeout(renderPhone.timer);
    renderPhone.timer = setTimeout(loadPhone, 1000);
    return;
  }
  const last = r.last;
  line.hidden = !last && !r.waiting;
  if (!last) line.textContent = '';
  else if (!last.ok) line.textContent = last.error;
  else line.textContent = `Synced ${ago(last.at)}.`;
  if (r.waiting) line.textContent += ` ${r.waiting} change${r.waiting === 1 ? '' : 's'} sent to the phone ${r.waiting === 1 ? 'waits' : 'wait'} for CanvasXP - open it on the phone to take ${r.waiting === 1 ? 'it' : 'them'} in.`;
  line.classList.toggle('bad', Boolean(last && !last.ok));
  if (!last || !last.ok) return;
  const row = (label, names, bad = false) => {
    if (!names || !names.length) return;
    const li = el('li', bad ? 'bad' : null);
    li.append(el('span', 'when', label), el('span', null, list(names)));
    ul.append(li);
  };
  // Messages queued in CanvasXP's chat, answered by the agent at this sync (t-e4196083e7).
  const perCanvas = (ms) => Object.entries((ms || []).reduce((m, a) => ({ ...m, [a.canvas]: (m[a.canvas] || 0) + 1 }), {})).map(([c, k]) => (k > 1 ? `${c} (${k})` : c));
  row('Answered from the phone', perCanvas(last.answered));
  row('Not answered', (last.unanswered || []).map((u) => `${u.canvas}: ${u.error}`), true);
  row('In from the phone', last.pulled);
  row('Out to the phone', last.pushed);
  row('Changed on both', last.conflicts);
  row('Deleted', last.removed);
  row('Open in CanvasX', last.open, true);
  row('Changed after listing', last.stale, true);
  row('Names left out', last.skipped, true);
  if (!ul.children.length) ul.append(el('li', null, 'Nothing to do: the phone and the PC already agree.'));
  if (last.open && last.open.length) ul.append(el('li', 'note', 'Canvases open in CanvasX on the PC wait for the next sync - go to CanvasX\'s home screen and sync again.'));
  if (last.stale && last.stale.length) ul.append(el('li', 'note', 'Those changed on the phone after CanvasXP listed them: open CanvasXP on the phone once, then sync again.'));
  if (last.unanswered && last.unanswered.length) ul.append(el('li', 'note', 'Those stay queued on the phone and are tried again at the next sync - or remove them in the chat in CanvasXP.'));
  if (last.conflicts && last.conflicts.length) ul.append(el('li', 'note', 'Both kept: the PC\'s version under its own name, the phone\'s beside it, on the PC and on the phone.'));
}

async function syncPhone() {
  try { renderPhone(await engine.syncPhone()); } catch (e) { toast(e.message, true); }
}

async function startPhoneSetup() {
  S.phoneBrowsing = true;
  $('phone-ready').hidden = true;
  $('phone-setup').hidden = false;
  $('phone-title').textContent = 'Set up the phone';
  $('phone-sub').textContent = '';
  $('phone-cancel').hidden = !(S.state && S.state.phone && S.state.phone.setup);
  await lookForPhones();
}

async function lookForPhones() {
  const sel = $('phone-device');
  $('phone-found').textContent = 'Looking for phones…';
  $('phone-folders').replaceChildren();
  $('phone-crumbs').replaceChildren();
  $('phone-use').disabled = true;
  let devices = [];
  try { devices = (await engine.phoneDevices()).devices; } catch (e) { $('phone-found').textContent = e.message; return; }
  sel.replaceChildren(...devices.map((d) => { const o = el('option', null, d.name); o.value = d.name; return o; }));
  if (!devices.length) {
    $('phone-found').textContent = 'No phone found. Plug it in, unlock it, and pick File transfer in the USB notification - then look again.';
    return;
  }
  // Looking again keeps the folder already open, since a replugged phone may now show what it lacked (t-48d69dba14).
  const at = S.phoneAt && devices.some((d) => d.name === S.phoneAt.device) ? S.phoneAt : null;
  sel.value = at ? at.device : devices[0].name;
  if (at && at.segs.length && await browsePhone(at.device, at.segs)) return;
  await browsePhone(sel.value, []);
}

async function browsePhone(device, segs) {
  S.phoneAt = { device, segs };
  $('phone-found').textContent = 'Reading the phone…';
  $('phone-use').disabled = true;
  let r;
  try { r = await engine.phoneBrowse(device, segs); } catch (e) { $('phone-found').textContent = e.message; return false; }
  if (S.phoneAt.device !== device || S.phoneAt.segs !== segs) return true; // another folder was opened meanwhile
  const crumbs = $('phone-crumbs');
  crumbs.replaceChildren();
  const crumb = (label, to) => { const b = el('button', null, label); b.addEventListener('click', () => browsePhone(device, to)); crumbs.append(b); };
  crumb(device, []);
  segs.forEach((s, i) => { crumbs.append(el('span', null, '›')); crumb(s, segs.slice(0, i + 1)); });
  const ul = $('phone-folders');
  ul.replaceChildren();
  for (const f of r.folders) {
    const b = el('button', null);
    b.append(el('span', 'name', f));
    b.addEventListener('click', () => browsePhone(device, [...segs, f]));
    const li = el('li', null);
    li.append(b);
    ul.append(li);
  }
  if (r.canvasxp) {
    $('phone-found').textContent = `This is CanvasXP's folder on "${r.canvasxp.name}".`;
    $('phone-use').disabled = false;
  } else if (segs.length <= 1) { // the phone, or its storage: not a folder anyone picks
    $('phone-found').textContent = 'Open the folder you picked as the target folder in CanvasXP.';
  } else {
    // Why Use this folder is off, said where the button is (t-48d69dba14).
    $('phone-found').textContent = `${r.folders.length ? '' : 'Windows sees nothing in this folder. '}Use this folder turns on once Windows can see CanvasXP's set-up here. `
      + 'If this is your target folder: on the phone, open it in CanvasXP and press Set up USB sync. Already done? Unplug the phone, plug it back in, pick File transfer, then press Look again.';
  }
  return true;
}

async function usePhoneFolder() {
  const { device, segs } = S.phoneAt || {};
  if (!device) return;
  try {
    const r = await engine.setPhone(device, segs);
    S.phoneBrowsing = false;
    toast(`${r.phone.name} is set up - syncing now.`);
    await syncPhone();
  } catch (e) { toast(e.message, true); }
}

/* ------------------------------------------------------------- wiring */

$('start-btn').addEventListener('click', startEngine);
$('refresh-btn').addEventListener('click', () => { $('menu').hidden = true; refresh(); });
$('stop-btn').addEventListener('click', async () => {
  $('menu').hidden = true;
  try { await engine.shutdown(); toast('The engine is stopping.'); } catch (e) { toast(e.message, true); }
  setTimeout(refresh, 800);
});
$('menu-btn').addEventListener('click', () => {
  const m = $('menu');
  m.hidden = !m.hidden;
  $('menu-btn').setAttribute('aria-expanded', String(!m.hidden));
});
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) $('menu').hidden = true; });
$('ws-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('ws-msg').textContent = '';
  try {
    const r = await engine.setWorkspace($('ws-path').value);
    toast(`${r.fabrics} fabric${r.fabrics === 1 ? '' : 's'} found.`);
    S.fabrics = [];
    await refresh();
  } catch (err) { $('ws-msg').textContent = err.message; }
});
$('ws-change').addEventListener('click', () => { $('ws-path').value = S.state.workspace || ''; show('workspace'); });
$('reload').addEventListener('click', loadFabrics);
$('read-btn').addEventListener('click', readImages);
$('sync-btn').addEventListener('click', toggleSync);
$('rules-btn').addEventListener('click', toggleRules);
$('ragx-btn').addEventListener('click', setRagxFolder);
$('filter').addEventListener('input', () => S.built && renderTree());
$('show-place').addEventListener('click', () => showView('place'));
$('show-doc').addEventListener('click', () => showView('doc'));
$('view-browse').addEventListener('click', () => showTab('browse'));
$('view-inbox').addEventListener('click', () => showTab('inbox'));
$('view-agents').addEventListener('click', () => showTab('agents'));
$('view-phone').addEventListener('click', () => showTab('phone'));
$('phone-sync').addEventListener('click', syncPhone);
$('phone-again').addEventListener('click', startPhoneSetup);
$('phone-forget').addEventListener('click', async () => {
  if (!confirm('Forget this phone? Its canvases stay where they are; setting it up again starts afresh, and canvases that differ then are kept side by side.')) return;
  try { await engine.forgetPhone(); S.phoneBrowsing = false; await loadPhone(); } catch (e) { toast(e.message, true); }
});
$('phone-look').addEventListener('click', lookForPhones);
$('phone-device').addEventListener('change', (e) => browsePhone(e.target.value, []));
$('phone-use').addEventListener('click', usePhoneFolder);
$('phone-cancel').addEventListener('click', () => { S.phoneBrowsing = false; loadPhone(); });
$('agents-reload').addEventListener('click', loadAgents);
$('assign-btn').addEventListener('click', toggleAssign);
$('history-btn').addEventListener('click', toggleHistory);
$('render-btn').addEventListener('click', drawAgain);
$('drop-files').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; attach(files); });
$('drop-send').addEventListener('click', sendDrop);
$('placing-btn').addEventListener('click', togglePlacing);
$('placer-model').addEventListener('change', setPlacerModel);
$('ask-btn').addEventListener('click', askAgent);
$('ask-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) askAgent(); });
for (const id of ['drop-text', 'drop-ask']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendDrop(); });
$('drop-ask').addEventListener('input', askChanged);
$('drop-canvas').addEventListener('change', () => { S.canvasPicked = true; });
const zone = $('drop-zone');
zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
zone.addEventListener('dragleave', () => zone.classList.remove('over'));
zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); attach([...e.dataTransfer.files]); });
// A file let go anywhere else is not opened in place of the page.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

(async () => {
  followWallpaper();
  if (TM && TM.ready) { try { await TM.ready; } catch (_) {} }
  try { S.dataDir = (await hostCall('host.dataDir')).dir; } catch (_) { S.dataDir = null; }
  S.local = await engine.local();
  const tab = await recall('tab', 'browse');
  S.tab = TABS.includes(tab) ? tab : 'browse';
  markTab(S.tab);
  await refresh();
  schedule();
})();
