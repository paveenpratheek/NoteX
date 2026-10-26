/* The NoteX page: File Fabric's fabrics as the places NoteX makes of them.
 *
 * Everything it asks of ter-manager goes through plugin-host.js messages -
 * open a terminal, remember a preference, follow the theme, ask for its
 * data folder; everything about fabrics is the engine's, over loopback
 * (t-e1b1aaaa28). Names and text from fabrics are only ever set with
 * textContent, never written into HTML: a note can hold anything.
 */
import { Engine, EngineDown, EngineRefused } from './api.js';

const TM = window.TerManager;
const engine = new Engine('.');
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const S = {
  up: false, state: null, local: null, dataDir: null, startedAt: 0,
  fabrics: [], fabric: null, built: null, sections: new Map(), selected: null, view: 'place',
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
  for (const id of ['offline', 'workspace', 'browse']) $(id).hidden = id !== which;
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
  show('browse');
  if (!was || !S.fabrics.length) await loadFabrics();
  else if (S.built) { renderSync((st.sync && st.sync[S.fabric]) || null); renderRules(st.rules); } // a save in File Fabric starts a sync
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
    // Where Read images still has work: "29 images to read".
    const imgs = !f.images ? '' : f.unread ? ` · ${f.unread} image${f.unread === 1 ? '' : 's'} to read` : ` · ${f.images} image${f.images === 1 ? '' : 's'} read`;
    const when = el('span', f.unread ? 'when todo' : 'when', `saved ${f.modified.slice(0, 10)}${imgs}`);
    if (f.sync) when.append(el('span', 'kept', ' · kept in RAGX'));
    if (f.rules) when.append(el('span', 'kept', ' · rules canvas'));
    b.append(el('span', null, f.name), when);
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
    if (kind && !q) b.append(el('span', 'kind', kind));
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
  const on = Boolean(sync);
  const btn = $('sync-btn');
  btn.setAttribute('aria-checked', String(on));
  btn.title = on ? 'Kept in RAGX: synced 15 s after each save. Press to stop.' : 'Keep this canvas in RAGX: synced now and after each save';
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

async function setRagxFolder() {
  $('menu').hidden = true;
  const now = S.state && S.state.ragx;
  const p = window.prompt('RAGX\'s plugin folder - the one holding its plugin.json:', now || '');
  if (!p) return;
  try { const r = await engine.setRagx(p); toast(`NoteX reads images through RAGX at ${r.ragx}.`); S.state.ragx = r.ragx; } catch (e) { toast(e.message, true); }
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

(async () => {
  if (TM && TM.ready) { try { await TM.ready; } catch (_) {} }
  try { S.dataDir = (await hostCall('host.dataDir')).dir; } catch (_) { S.dataDir = null; }
  S.local = await engine.local();
  await refresh();
  schedule();
})();
