/* The engine as a server for the NoteX page in ter-manager.
 *
 *   node engine/cli.js --data-dir <folder> serve [--port 7781]
 *
 * The page cannot read File Fabric's workspace from disk, so the engine
 * reads it and answers on loopback only, with RAGX's three checks
 * (t-e1b1aaaa28): X-Notex-Token matches the token in plugin/runtime.json
 * (a custom header needs a CORS preflight, which another page cannot pass);
 * Origin, when sent, is ter-manager's own page; Host is 127.0.0.1 or
 * localhost on this port, so a re-pointed domain is refused.
 *
 * <data>/config.json keeps the workspace folder and RAGX's plugin folder;
 * <data>/docs/ keeps the last address document and place map built for each
 * fabric; <data>/readings.json and <data>/images/ keep what Read images
 * found and the images that had no file of their own; config.json also
 * keeps which canvases auto-sync keeps in RAGX (t-0c1da1346d).
 * <data>/scripts/ keeps the totem scripts agents send, waiting or done, the
 * ledger of what each wrote and the backups taken before every write
 * (t-a80b904d43). <data>/bronze/ is the Inbox: what the user drops, kept as
 * it arrived until it is placed on an agent canvas (t-1c0fff1756).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { listFabrics, readFabric, FabricError } from './fabric.js';
import { buildPlaces } from './places.js';
import { toMarkdown, toPlaceMap } from './document.js';
import { writeRuntime, writeLocal } from './lifecycle.js';
import { fabricImages, Readings } from './images.js';
import { readFabricImages } from './read.js';
import { ragxFolder, RagxError } from './ragx.js';
import { AutoSync } from './sync.js';
import { canvasFiles } from './files.js';
import { RulesFile } from './agentrules.js';
import { Writer } from './writer.js';
import { readOut } from './readout.js';
import { Bronze, BronzeError } from './bronze.js';
import { AgentCanvases, isAgentCanvas } from './agentcanvas.js';
import { Refusal } from './layout.js';
import { Placer } from './placer.js';
import { Arranger, MODELS } from './arranger.js';
import { DropSync } from './dropsync.js';
import { forgetDrop } from './forget.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8')).version;
export const DEFAULT_PORT = 7781;
export const DEFAULT_ORIGINS = ['http://127.0.0.1:7070', 'http://localhost:7070'];
// CanvasX's own page, which talks to the agent through the link (t-76dff4fffe).
export const CANVASX_ORIGINS = ['http://localhost:9075', 'http://127.0.0.1:9075'];
export const LINK_FILE = path.join('.notex', 'link.json');
export const DEFAULT_RUNTIME = path.join(HERE, '..', '..', 'plugin', 'runtime.json');
const MAX_JSON = 64 * 1024;
const MAX_SCRIPT_JSON = 256 * 1024; // a script may be 100 KB, escaped once more as JSON
// A dropped file comes as its bytes, typed text as JSON (t-70d92dbfb0).
const MAX_DROP = 100 * 1024 * 1024;
const MAX_TEXT_JSON = 2 * 1024 * 1024; // 1 MB of text, escaped once more as JSON
const MAX_SEND = 200 * 1024 * 1024; // a send's files together
const MAX_TEXT = 1024 * 1024;
const MAX_ASK = 8 * 1024;

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function statusOf(e) {
  if (e instanceof HttpError) return e.status;
  if (e instanceof BronzeError) return e.code === 'no-drop' ? 404 : ['placed', 'placing', 'busy'].includes(e.code) ? 409 : 400;
  if (e instanceof Refusal) return 409;
  if (e instanceof FabricError) return e.code === 'not-found' || e.code === 'no-workspace' ? 404 : e.code === 'bad-json' ? 409 : 500;
  if (e instanceof RagxError) return 503;
  return 500;
}

function readJson(req, max = MAX_JSON) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, 'too-large', 'The request is too large.')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(parts).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (_) { reject(new HttpError(400, 'bad-json', 'The request body is not JSON.')); }
    });
    req.on('error', reject);
  });
}

function readBytes(req, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, 'too-large', `A drop can be at most ${Math.round(max / 1024 / 1024)} MB.`)); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/* A fabric's name is a folder directly inside the workspace, nothing else -
 * never a path that climbs out of it. */
export function fabricDir(workspace, name) {
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) throw new HttpError(400, 'bad-name', `"${name}" is not a fabric name.`);
  return path.join(workspace, name);
}

/* A fabric's document, with its images' files and kept readings when there
 * is a data folder to keep them in. */
export function buildFabric(dir, { dataDir = null } = {}) {
  const started = Date.now();
  const fabric = readFabric(dir);
  const model = buildPlaces(fabric);
  const images = fabricImages(model, fabric, { dataDir, readings: new Readings(dataDir) });
  const unread = images.filter((im) => !im.file.image.reading).length;
  return { markdown: toMarkdown(model), map: toPlaceMap(model), files: canvasFiles(model), images: images.length, unread, ms: Date.now() - started };
}

/* What a build leaves in a docs folder: the document, its place map and the
 * files RAGX reads with their places (t-99b4d2b864). The file list goes
 * first, so RAGX never takes a document newer than its list. */
export function writeBuilt(out, name, built) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${name}.files.json`), JSON.stringify(built.files, null, 2));
  fs.writeFileSync(path.join(out, `${name}.notex.md`), built.markdown);
  fs.writeFileSync(path.join(out, `${name}.places.json`), JSON.stringify(built.map, null, 2));
}

export async function startServer({
  dataDir, port = DEFAULT_PORT, origins = DEFAULT_ORIGINS, runtimeFile = DEFAULT_RUNTIME, log = console.log, signals = true, onStopped = null, ragx = null,
  syncOptions = {},
} = {}) {
  const dir = path.resolve(dataDir);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const configFile = path.join(dir, 'config.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (_) { /* first start */ }
  if (ragx) config.ragx = ragx; // tests and --ragx point it elsewhere for this run
  const saveConfig = () => fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

  const workspaceState = () => {
    if (!config.workspace) return { workspace: null, fabrics: 0, error: null };
    try { return { workspace: config.workspace, fabrics: listFabrics(config.workspace).length, error: null }; } catch (e) { return { workspace: config.workspace, fabrics: 0, error: e.message }; }
  };
  const needWorkspace = () => {
    if (!config.workspace) throw new HttpError(409, 'no-workspace', 'Say which folder is File Fabric\'s workspace first.');
    return config.workspace;
  };

  // The last build is kept, so what NoteX made can be read outside the page - and by RAGX.
  const buildAndKeep = (name) => {
    const built = buildFabric(fabricDir(needWorkspace(), name), { dataDir: dir });
    writeBuilt(path.join(dir, 'docs'), name, built);
    return built;
  };

  let reading = null; // the Read images job, while it runs and once it is done
  const sync = new AutoSync({ config, saveConfig, dataDir: dir, build: buildAndKeep, busy: () => Boolean(reading && !reading.finished), log, ...syncOptions });
  const rules = new RulesFile({ config, saveConfig, dataDir: dir, log, ...(syncOptions.pollMs ? { pollMs: syncOptions.pollMs } : {}) });
  const writer = new Writer({ config, dataDir: dir, log, ...(syncOptions.pollMs ? { pollMs: syncOptions.pollMs } : {}) });
  const bronze = new Bronze(dir);
  // Canvases assigned to the agent are drawn from their scripts (t-0b88e8ea91).
  const agent = new AgentCanvases({ dataDir: dir, writer, bronze, log });
  writer.agent = agent;
  // What is on an agent canvas goes on to RAGX after each render (t-7513cdd783).
  const dropSync = new DropSync({ dataDir: dir, config, agent, bronze, log, ...(syncOptions.runtime ? { runtime: syncOptions.runtime } : {}) });
  agent.onRendered = (canvas) => { dropSync.queue(canvas).catch((e) => log(`Sending ${canvas}'s drops failed: ${e.message}`)); };
  // Queued drops are placed by the agent, one at a time (t-c24e0494a2).
  const placer = new Placer({ config, dataDir: dir, bronze, writer, log, ...(syncOptions.placerRun ? { run: syncOptions.placerRun } : {}), ...(syncOptions.pollMs ? { pollMs: syncOptions.pollMs } : {}) });
  // The user asks the agent about one of its canvases (t-a9198c414f).
  const arranger = new Arranger({ config, dataDir: dir, writer, log, ...(syncOptions.arrangerRun ? { run: syncOptions.arrangerRun } : {}) });

  /* The canvases assigned to the agent: those whose folder holds the
   * agent.json CanvasX writes. Only they take drops (t-52f040cf72). */
  const agentCanvases = () => {
    if (!config.workspace) return [];
    try { return listFabrics(config.workspace).filter((f) => fs.existsSync(path.join(f.dir, 'agent.json'))).map((f) => f.name); } catch (_) { return []; }
  };
  const agentCanvas = (name) => {
    if (name == null || name === '') return null;
    fabricDir(needWorkspace(), name);
    if (!agentCanvases().includes(name)) throw new HttpError(409, 'not-agent', `${name} is not assigned to the agent - assign it in CanvasX first.`);
    return name;
  };
  // What the Inbox shows of a drop: typed text and Markdown by their first words.
  const shown = (d) => {
    if (d.kind !== 'text' && d.kind !== 'md') return d;
    let preview = '';
    try { preview = fs.readFileSync(path.join(bronze.dir, d.blob), 'utf8').slice(0, 400).replace(/\s+/g, ' ').trim().slice(0, 160); } catch (_) { /* forgotten meanwhile */ }
    return { ...d, preview };
  };
  const header = (req, name) => { const v = req.headers[name]; try { return v ? decodeURIComponent(String(v)) : null; } catch (_) { throw new HttpError(400, 'bad-header', `${name} is not URI-encoded.`); } };

  let stopping = false;
  let actualPort = port;
  const token = crypto.randomBytes(24).toString('base64url');
  /* CanvasX's way in: a second token, written with the engine's address into
   * the workspace CanvasX already has open, that opens only /api/link/ -
   * an agent canvas's chat and sending it a message (t-76dff4fffe). */
  const linkToken = crypto.randomBytes(24).toString('base64url');
  const canvasxOrigins = () => (Array.isArray(config.canvasxOrigins) ? config.canvasxOrigins : CANVASX_ORIGINS);
  const linkFile = (ws = config.workspace) => (ws ? path.join(ws, LINK_FILE) : null);
  const writeLink = () => {
    const f = linkFile();
    if (!f || !fs.existsSync(config.workspace)) return;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ url: `http://127.0.0.1:${actualPort}`, token: linkToken, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
    } catch (e) { log(`Could not write ${f} for CanvasX: ${e.message}`); }
  };
  // Only our own link is removed: another engine may have written it since.
  const removeLink = (ws = config.workspace) => {
    const f = linkFile(ws);
    try { if (f && JSON.parse(fs.readFileSync(f, 'utf8')).token === linkToken) fs.rmSync(f); } catch (_) { /* none, or another's */ }
    try { if (f) fs.rmdirSync(path.dirname(f)); } catch (_) { /* not empty, or gone */ }
  };
  const allowedHosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);

  const routes = async (req, res, url) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const m = (method, pattern) => {
      if (req.method !== method) return null;
      const r = pattern.exec(url.pathname);
      return r ? r.slice(1) : null;
    };
    let p;

    if (m('GET', /^\/api\/state$/)) {
      const drops = bronze.list();
      const inbox = { drops: drops.length, waiting: drops.filter((d) => d.status === 'waiting').length };
      return json(200, { version: VERSION, pid: process.pid, dataDir: dir, ragx: ragxFolder(config.ragx), reading, sync: sync.report(), rules: rules.report(), scripts: writer.report(), inbox, placer: placer.report(), ...workspaceState() });
    }
    /* Whether the agent places queued drops by itself - off, they wait in
     * the queue - and with which Claude model (t-fe1817678b). */
    if (m('PUT', /^\/api\/placer$/)) {
      const { on, model } = await readJson(req);
      if (on === undefined && model === undefined) throw new HttpError(400, 'bad-body', 'Send {"on": true|false} and/or {"model": "sonnet"|"opus"|"haiku"}.');
      if (on !== undefined && typeof on !== 'boolean') throw new HttpError(400, 'bad-body', 'Send {"on": true} or {"on": false}.');
      if (model !== undefined && !MODELS.includes(model)) throw new HttpError(400, 'bad-model', `Pick a model of ${MODELS.join(', ')}.`);
      if (on !== undefined) config.placing = on;
      if (model !== undefined) config.placer = { ...(config.placer || {}), model };
      saveConfig();
      if (on) placer.tick();
      return json(200, { placer: placer.report() });
    }
    /* The Inbox: drops kept in bronze until the user picks an agent canvas
     * for them (t-85f3ec23ef, t-0f32cb63f2). */
    if (m('GET', /^\/api\/inbox$/)) return json(200, { drops: bronze.list().map(shown), canvases: agentCanvases(), placer: placer.report(), models: MODELS });
    if (m('POST', /^\/api\/inbox\/text$/)) {
      const body = await readJson(req, MAX_TEXT_JSON);
      if (typeof body.text !== 'string') throw new HttpError(400, 'bad-body', 'Send {"text": "...", "note": "...", "canvas": "..."}.');
      if (Buffer.byteLength(body.text) > 1024 * 1024) throw new HttpError(413, 'too-large', 'Typed text can be at most 1 MB - drop it as a file.');
      const canvas = agentCanvas(body.canvas);
      return json(200, { drop: shown(bronze.land({ text: body.text, note: typeof body.note === 'string' ? body.note.trim() : null, canvas, via: 'page' })) });
    }
    if (m('POST', /^\/api\/inbox\/file$/)) {
      const name = header(req, 'x-drop-name');
      if (!name) throw new HttpError(400, 'no-name', 'Send the file\'s name in X-Drop-Name.');
      const canvas = agentCanvas(header(req, 'x-drop-canvas'));
      const bytes = await readBytes(req, MAX_DROP);
      return json(200, { drop: shown(bronze.land({ bytes, name, note: header(req, 'x-drop-note'), canvas, via: 'page' })) });
    }
    /* A send from the composer: its files, the user's description of them
     * and their message to the agent, in one multipart request - all of it
     * checked before any lands, so the placer never sees half a send
     * (t-e0f8a22b3a, t-fe28f948b4). With no file, the description is the drop. */
    if (m('POST', /^\/api\/inbox\/send$/)) {
      const { field, parts, files } = await readSend(req);
      const description = field('description');
      const ask = field('message');
      const byMessage = field('byMessage') === 'true';
      if (byMessage && !ask) throw new HttpError(400, 'no-ask', 'Write the agent a message saying where it goes, or pick a canvas.');
      if (Buffer.byteLength(description) > MAX_TEXT) throw new HttpError(413, 'too-large', 'A description can be at most 1 MB - drop it as a file.');
      if (ask.length > MAX_ASK) throw new HttpError(413, 'too-large', `A message to the agent can be at most ${MAX_ASK} characters.`);
      const canvas = byMessage ? null : agentCanvas(field('canvas'));
      if (!files.length && !description) throw new HttpError(400, 'empty', 'Nothing to keep: attach a file or write a description.');
      if (!parts.length) parts.push({ text: description });
      const send = 's-' + crypto.randomBytes(5).toString('hex');
      const note = files.length ? description || null : null;
      const drops = parts.map((part) => shown(bronze.land({ ...part, note, ask: ask || null, send, canvas, byMessage, via: 'page' })));
      return json(200, { send, drops });
    }
    if ((p = m('PUT', /^\/api\/inbox\/(d-[0-9a-f]{10})\/canvas$/))) {
      const { canvas, byMessage } = await readJson(req);
      if (byMessage === true) return json(200, { drop: shown(bronze.choose(p[0], null, { byMessage: true })) });
      if (typeof canvas !== 'string' || !canvas) throw new HttpError(400, 'bad-body', 'Send {"canvas": "<an agent canvas>"} or {"byMessage": true}.');
      return json(200, { drop: shown(bronze.choose(p[0], agentCanvas(canvas))) });
    }
    // Out of its scripts, the canvas, backups, RAGX and bronze (t-985017e732).
    if ((p = m('POST', /^\/api\/inbox\/(d-[0-9a-f]{10})\/forget$/))) return json(200, await forgetDrop(p[0], { bronze, writer, agent, dataDir: dir }));
    if (m('PUT', /^\/api\/ragx$/)) {
      const body = await readJson(req);
      const folder = typeof body.path === 'string' ? body.path.trim().replace(/^"(.*)"$/, '$1') : '';
      if (!folder || !path.isAbsolute(folder) || !fs.existsSync(path.join(folder, 'plugin.json'))) throw new HttpError(400, 'bad-path', 'Give RAGX\'s plugin folder as a full path - the one holding its plugin.json.');
      config.ragx = path.resolve(folder);
      saveConfig();
      return json(200, { ragx: config.ragx });
    }
    /* Read images: one fabric at a time, in the background; the page follows
     * it through /api/state (t-6b38e0dc27). */
    if ((p = m('POST', /^\/api\/fabrics\/([^/]+)\/read$/))) {
      const name = decodeURIComponent(p[0]);
      const fdir = fabricDir(needWorkspace(), name);
      if (reading && !reading.finished) throw new HttpError(409, 'busy', `Already reading the images of ${reading.fabric}.`);
      if (sync.running) throw new HttpError(409, 'busy', 'Auto-sync is bringing a canvas up to date - try again when it is done.');
      reading = { fabric: name, done: 0, total: null, failed: 0, finished: false, result: null };
      const job = reading;
      readFabricImages(fdir, { dataDir: dir, ragx: config.ragx, onProgress: (pr) => Object.assign(job, pr) })
        .then((r) => Object.assign(job, { finished: true, result: r }), (e) => Object.assign(job, { finished: true, result: { error: e.message } }));
      return json(202, { reading: name });
    }
    if (m('PUT', /^\/api\/workspace$/)) {
      const body = await readJson(req);
      const ws = typeof body.path === 'string' ? body.path.trim().replace(/^"(.*)"$/, '$1') : '';
      if (!ws || !path.isAbsolute(ws)) throw new HttpError(400, 'bad-path', 'Give the workspace as a full path, e.g. E:\\FILES\\my workspace.');
      const fabrics = listFabrics(ws);
      // Canvases switched on belong to the workspace they were switched on in.
      if (config.workspace && path.resolve(ws) !== config.workspace) { delete config.sync; delete config.rules; }
      removeLink();
      config.workspace = path.resolve(ws);
      saveConfig();
      writeLink();
      rules.tick();
      return json(200, { workspace: config.workspace, fabrics: fabrics.length });
    }
    /* Each fabric with how many images it has and how many are not read yet,
     * so the page can say where Read images still has work (about 0.1 s a
     * fabric; a fabric that cannot be read is listed without counts). */
    if (m('GET', /^\/api\/fabrics$/)) {
      const synced = sync.report();
      const fabrics = listFabrics(needWorkspace()).map(({ name, dir: fdir, modified, size }) => {
        let counts = { images: null, unread: null };
        try { const b = buildFabric(fdir, { dataDir: dir }); counts = { images: b.images, unread: b.unread }; } catch (_) { /* shown without counts */ }
        // Whether File Fabric has it open: a script for it waits until it is closed (t-a80b904d43).
        return { name, modified, size, ...counts, sync: synced[name] || null, rules: config.rules === name, open: writer.isOpen(fdir), agent: isAgentCanvas(fdir) };
      });
      return json(200, { workspace: needWorkspace(), fabrics });
    }
    /* A canvas, or one place on it with ?at=, read out as a totem script
     * with ids and owners, for an agent to read before it writes. */
    if ((p = m('GET', /^\/api\/fabrics\/([^/]+)\/script$/))) {
      const name = decodeURIComponent(p[0]);
      const fdir = fabricDir(needWorkspace(), name);
      const at = url.searchParams.get('at') || null;
      if (isAgentCanvas(fdir)) {
        // An agent canvas is its scripts: they are what an agent reads and sends back changed (t-c42859ce48).
        const want = at ? at.split('>')[0].replace(/\(totem\)/i, '').trim().toLowerCase() : null;
        const all = agent.scripts(name).filter((s) => s.script && (!want || s.name.toLowerCase() === want));
        if (at && !all.length) throw new HttpError(404, 'no-place', `No totem on ${name} matches "${at}".`);
        const head = `<!-- ${name} is an agent canvas, drawn from one script per totem. To change a totem, send its whole script again. -->`;
        return json(200, { name, at, agent: true, script: [head, ...all.map((s) => s.script.trim())].join('\n\n') || head, open: false, waiting: 0 });
      }
      const script = readOut(readFabric(fdir), { at, ledger: writer.ledger(name) });
      if (script === null) throw new HttpError(404, 'no-place', `No place on ${name} has the address "${at}".`);
      const waiting = (writer.report()[name] || { waiting: [] }).waiting.length;
      return json(200, { name, at, script, open: writer.isOpen(fdir), waiting });
    }
    if ((p = m('GET', /^\/api\/fabrics\/([^/]+)$/))) {
      const name = decodeURIComponent(p[0]);
      return json(200, { name, ...buildAndKeep(name), sync: sync.report()[name] || null, rules: rules.report() });
    }
    /* The Agent canvases view: every canvas, whose it is and whether CanvasX
     * has it open; an agent canvas with its totem scripts and activity
     * (t-a9a33794bd). */
    if (m('GET', /^\/api\/agent-canvases$/)) {
      const canvases = listFabrics(needWorkspace()).map(({ name, dir: fdir, modified }) => {
        const mine = isAgentCanvas(fdir);
        const totems = mine ? agent.totems(name) : [];
        const last = mine ? agent.lastRender(name) : null;
        return { name, modified, agent: mine, open: writer.isOpen(fdir), totems: totems.length,
          drops: totems.reduce((n, t) => n + t.drops, 0), lastRender: last ? last.at : null,
          trouble: totems.filter((t) => t.drawn === 'good' || t.drawn === 'none').length };
      });
      return json(200, { workspace: needWorkspace(), canvases, placer: placer.report() });
    }
    if ((p = m('GET', /^\/api\/agent-canvases\/([^/]+)$/))) {
      const name = decodeURIComponent(p[0]);
      const fdir = fabricDir(needWorkspace(), name);
      if (!fs.existsSync(path.join(fdir, 'fabric.json'))) throw new HttpError(404, 'not-found', `No canvas ${name} in the workspace.`);
      const mine = isAgentCanvas(fdir);
      return json(200, { name, agent: mine, open: writer.isOpen(fdir), totems: mine ? agent.totems(name) : [], activity: agent.activity(name), lastRender: agent.lastRender(name), ask: arranger.report(name), chat: agent.chat(name, 100), model: arranger.model(), models: MODELS });
    }
    /* Ask the agent to arrange one of its canvases, in the user's words
     * (t-a9198c414f); the answer comes in the canvas's ask and activity. */
    if ((p = m('POST', /^\/api\/agent-canvases\/([^/]+)\/ask$/))) {
      const name = decodeURIComponent(p[0]);
      const fdir = fabricDir(needWorkspace(), name);
      if (!fs.existsSync(path.join(fdir, 'fabric.json'))) throw new HttpError(404, 'not-found', `No canvas ${name} in the workspace.`);
      const { ask, model } = await readJson(req);
      if (typeof ask !== 'string') throw new HttpError(400, 'bad-body', 'Send {"ask": "...", "model": "sonnet"|"opus"|"haiku"}.');
      if (model !== undefined && !MODELS.includes(model)) throw new HttpError(400, 'bad-model', `Pick a model of ${MODELS.join(', ')}.`);
      const job = arranger.ask(name, ask, model);
      if (model !== undefined) { config.arranger = { ...(config.arranger || {}), model }; saveConfig(); }
      return json(202, { ask: job });
    }
    /* Assign a canvas to the agent, or take it back (t-d798b625e5). */
    if ((p = m('PUT', /^\/api\/fabrics\/([^/]+)\/agent$/))) {
      const name = decodeURIComponent(p[0]);
      fabricDir(needWorkspace(), name);
      const { on } = await readJson(req);
      if (typeof on !== 'boolean') throw new HttpError(400, 'bad-body', 'Send {"on": true} or {"on": false}.');
      // Assigned, it is kept in RAGX by itself from the next look (t-65a490ef80).
      return json(200, { name, agent: on, changed: agent.assign(name, on) });
    }
    /* An agent canvas drawn again from its scripts, e.g. after a script file was mended by hand. */
    if ((p = m('POST', /^\/api\/fabrics\/([^/]+)\/render$/))) {
      const name = decodeURIComponent(p[0]);
      fabricDir(needWorkspace(), name);
      const r = await writer.serial(() => agent.render(name));
      if (r === null) throw new HttpError(409, 'busy', `${name} changed while it was being drawn - try again.`);
      return json(200, { name, ...r });
    }
    /* The rules canvas: marked, it is written to rules.md now and after each save. */
    if ((p = m('PUT', /^\/api\/fabrics\/([^/]+)\/rules$/))) {
      const name = decodeURIComponent(p[0]);
      const fdir = fabricDir(needWorkspace(), name);
      const { on } = await readJson(req);
      if (typeof on !== 'boolean') throw new HttpError(400, 'bad-body', 'Send {"on": true} or {"on": false}.');
      if (on && !fs.existsSync(path.join(fdir, 'fabric.json'))) throw new HttpError(404, 'not-found', `No fabric ${name} in the workspace.`);
      rules.set(name, on);
      return json(200, { name, on, rules: rules.report() });
    }
    /* Keep in RAGX: switched on, the canvas is synced now and after each save. */
    if ((p = m('PUT', /^\/api\/fabrics\/([^/]+)\/sync$/))) {
      const name = decodeURIComponent(p[0]);
      const fdir = fabricDir(needWorkspace(), name);
      const { on } = await readJson(req);
      if (typeof on !== 'boolean') throw new HttpError(400, 'bad-body', 'Send {"on": true} or {"on": false}.');
      if (on && !fs.existsSync(path.join(fdir, 'fabric.json'))) throw new HttpError(404, 'not-found', `No fabric ${name} in the workspace.`);
      // An agent canvas is always kept: switching it on changes nothing, off is refused (t-65a490ef80).
      if (isAgentCanvas(fdir)) {
        if (!on) throw new HttpError(409, 'agent-canvas', `${name} is assigned to the agent, so it is always kept in RAGX - take it back from the agent to stop that.`);
        return json(200, { name, on, sync: sync.report()[name] || null });
      }
      sync.set(name, on);
      return json(200, { name, on, sync: sync.report()[name] || null });
    }
    /* Totem scripts from agents: written now if the canvas is closed, else
     * queued until File Fabric lets go of it (t-a80b904d43). */
    if (m('POST', /^\/api\/scripts$/)) {
      const body = await readJson(req, MAX_SCRIPT_JSON);
      if (typeof body.script !== 'string') throw new HttpError(400, 'bad-body', 'Send {"script": "<Canvas ...>", "owner": "..."}.');
      return json(200, { entry: await writer.submit({ script: body.script, owner: body.owner }) });
    }
    if (m('GET', /^\/api\/scripts$/)) return json(200, { canvases: writer.report() });
    if ((p = m('GET', /^\/api\/scripts\/([0-9a-f]+)$/))) {
      const e = writer.entry(p[0]);
      if (!e) throw new HttpError(404, 'not-found', `No script ${p[0]}.`);
      return json(200, { entry: e });
    }
    if ((p = m('POST', /^\/api\/scripts\/([0-9a-f]+)\/cancel$/))) {
      const e = writer.cancel(p[0]);
      if (!e) throw new HttpError(409, 'not-waiting', 'Only a script still waiting can be cancelled.');
      return json(200, { entry: e });
    }
    if (m('POST', /^\/api\/shutdown$/)) {
      json(202, { stopping: true });
      setImmediate(() => stop('asked by the page').then(() => onStopped && onStopped()));
      return;
    }
    throw new HttpError(404, 'no-route', `No ${req.method} ${url.pathname}.`);
  };

  /* A multipart send read whole: its fields, and its files each checked to
   * be what its name says before any lands (t-fe28f948b4). */
  const readSend = async (req) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.startsWith('multipart/form-data')) throw new HttpError(400, 'bad-body', 'Send the drop as multipart/form-data.');
    const raw = await readBytes(req, MAX_SEND);
    let form;
    try { form = await new Response(raw, { headers: { 'content-type': type } }).formData(); } catch (_) { throw new HttpError(400, 'bad-body', 'The send is not readable multipart/form-data.'); }
    const field = (k) => { const v = form.get(k); return typeof v === 'string' ? v.trim() : ''; };
    const files = form.getAll('file').filter((f) => typeof f !== 'string');
    const parts = [];
    for (const f of files) {
      if (f.size > MAX_DROP) throw new HttpError(413, 'too-large', `${f.name} is over ${Math.round(MAX_DROP / 1024 / 1024)} MB.`);
      const bytes = Buffer.from(await f.arrayBuffer());
      bronze.prepare({ bytes, name: f.name });
      parts.push({ bytes, name: f.name });
    }
    return { field, parts, files };
  };

  /* CanvasX's chat beside an agent canvas (t-2ffa1ff1de): only these, and
   * only for a canvas assigned to the agent. */
  const linkRoutes = async (req, res, url) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const r = /^\/api\/link\/canvases\/([^/]+)(\/ask|\/send)?$/.exec(url.pathname);
    if (!r) throw new HttpError(404, 'no-route', `No ${req.method} ${url.pathname}.`);
    const name = decodeURIComponent(r[1]);
    const fdir = fabricDir(needWorkspace(), name);
    if (!fs.existsSync(path.join(fdir, 'fabric.json'))) throw new HttpError(404, 'not-found', `No canvas ${name} in the workspace.`);
    if (!isAgentCanvas(fdir)) throw new HttpError(409, 'not-agent', `${name} is not assigned to the agent.`);
    if (req.method === 'GET' && !r[2]) return json(200, { name, chat: agent.chat(name, 100), ask: arranger.report(name), model: arranger.model(), models: MODELS });
    /* Files and images attached in the chat: drops of this canvas, landed as
     * placing so the placer leaves them to the chat agent, which places them
     * as the message says (t-79ac13d22a, t-291d7e41be, t-9bc7df3233). */
    if (req.method === 'POST' && r[2] === '/send') {
      if (arranger.running) throw new HttpError(409, 'busy', `The agent is still working on ${arranger.running.canvas} - send again once it is done.`);
      const { field, parts } = await readSend(req);
      const ask = field('message');
      const model = field('model') || undefined;
      if (!parts.length) throw new HttpError(400, 'empty', 'Attach a file or an image - words alone go with the chat\'s Send.');
      if (ask.length > MAX_ASK) throw new HttpError(413, 'too-large', `A message to the agent can be at most ${MAX_ASK} characters.`);
      if (model !== undefined && !MODELS.includes(model)) throw new HttpError(400, 'bad-model', `Pick a model of ${MODELS.join(', ')}.`);
      const send = 's-' + crypto.randomBytes(5).toString('hex');
      const ids = parts.map((part) => {
        const d = bronze.land({ ...part, ask: ask || null, send, canvas: name, via: 'canvasx' });
        bronze.mark(d.id, 'placing', 'The agent in the chat is placing it.');
        return d.id;
      });
      const job = arranger.ask(name, ask, model, { source: 'canvasx', drops: ids });
      if (model !== undefined) { config.arranger = { ...(config.arranger || {}), model }; saveConfig(); }
      return json(202, { ask: job, drops: ids });
    }
    if (req.method === 'POST' && r[2] === '/ask') {
      const { ask, model } = await readJson(req);
      if (typeof ask !== 'string') throw new HttpError(400, 'bad-body', 'Send {"ask": "...", "model": "sonnet"|"opus"|"haiku"}.');
      if (model !== undefined && !MODELS.includes(model)) throw new HttpError(400, 'bad-model', `Pick a model of ${MODELS.join(', ')}.`);
      const job = arranger.ask(name, ask, model, { source: 'canvasx' });
      if (model !== undefined) { config.arranger = { ...(config.arranger || {}), model }; saveConfig(); }
      return json(202, { ask: job });
    }
    throw new HttpError(404, 'no-route', `No ${req.method} ${url.pathname}.`);
  };

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const isLink = String(req.url || '').startsWith('/api/link/');
    const allowedOrigin = origin && (origins.includes(origin) || (isLink && canvasxOrigins().includes(origin))) ? origin : null;
    if (allowedOrigin) { res.setHeader('access-control-allow-origin', allowedOrigin); res.setHeader('vary', 'Origin'); }
    const refuse = (status, code, message) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code, message } }));
    };
    if (!allowedHosts().has(String(req.headers.host || '').toLowerCase())) return refuse(421, 'bad-host', 'This engine answers only on 127.0.0.1 or localhost.');
    if (origin && !allowedOrigin) return refuse(403, 'bad-origin', `Requests from ${origin} are not accepted.`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
        'access-control-allow-headers': 'X-Notex-Token, X-Notex-Link, Content-Type, X-Drop-Name, X-Drop-Note, X-Drop-Canvas',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    const same = (header, want) => {
      const given = Buffer.from(String(req.headers[header] || ''));
      return given.length === want.length && crypto.timingSafeEqual(given, want);
    };
    // The link token opens only the link routes; the engine's token, everything.
    if (isLink ? !(same('x-notex-link', Buffer.from(linkToken)) || same('x-notex-token', Buffer.from(token))) : !same('x-notex-token', Buffer.from(token))) {
      return isLink ? refuse(401, 'bad-link', 'Missing or wrong X-Notex-Link - NoteX may have restarted; read .notex/link.json again.') : refuse(401, 'bad-token', 'Missing or wrong X-Notex-Token.');
    }
    if (stopping) return refuse(503, 'stopping', 'The engine is stopping.');
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (isLink) return await linkRoutes(req, res, url);
      await routes(req, res, url);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch (_) {} return; }
      refuse(statusOf(e), e.code || 'failed', e.message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE'
      ? new Error(`Port ${port} is already in use - stop what holds it, or start with --port <another>.`) : e));
    server.listen(port, '127.0.0.1', resolve);
  });
  actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}`;
  const removeRuntime = writeRuntime(runtimeFile, { url, port: actualPort, token, pid: process.pid, dataDir: dir, version: VERSION, startedAt: new Date().toISOString() });
  writeLink();
  writeLocal(path.join(path.dirname(runtimeFile), 'local.json'));
  sync.start();
  rules.start();
  writer.start();
  placer.start();
  dropSync.start().catch((e) => log(`Sending drops failed: ${e.message}`));

  let stopped = null;
  function stop(reason = 'stopped') {
    if (stopped) return stopped;
    stopping = true;
    stopped = (async () => {
      log(`Stopping (${reason})...`);
      await sync.stop();
      rules.stop();
      await placer.stop();
      await arranger.stop();
      await dropSync.stop();
      await writer.stop();
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      removeRuntime();
      removeLink();
      log('Stopped.');
    })();
    return stopped;
  }

  if (signals) {
    const onSignal = () => stop('Ctrl+C').then(() => process.exit(0));
    for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(s, onSignal);
  }

  return { url, port: actualPort, token, linkToken, dataDir: dir, stop, runtimeFile, sync, rules, writer, config: () => ({ ...config }) };
}
