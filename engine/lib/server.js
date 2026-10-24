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
 * <data>/config.json keeps the workspace folder; <data>/docs/ keeps the
 * last address document and place map built for each fabric.
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8')).version;
export const DEFAULT_PORT = 7781;
export const DEFAULT_ORIGINS = ['http://127.0.0.1:7070', 'http://localhost:7070'];
export const DEFAULT_RUNTIME = path.join(HERE, '..', '..', 'plugin', 'runtime.json');
const MAX_JSON = 64 * 1024;

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function statusOf(e) {
  if (e instanceof HttpError) return e.status;
  if (e instanceof FabricError) return e.code === 'not-found' || e.code === 'no-workspace' ? 404 : e.code === 'bad-json' ? 409 : 500;
  return 500;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON) { reject(new HttpError(413, 'too-large', 'The request is too large.')); req.destroy(); return; }
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

/* A fabric's name is a folder directly inside the workspace, nothing else -
 * never a path that climbs out of it. */
export function fabricDir(workspace, name) {
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) throw new HttpError(400, 'bad-name', `"${name}" is not a fabric name.`);
  return path.join(workspace, name);
}

export function buildFabric(dir) {
  const started = Date.now();
  const model = buildPlaces(readFabric(dir));
  return { markdown: toMarkdown(model), map: toPlaceMap(model), ms: Date.now() - started };
}

export async function startServer({
  dataDir, port = DEFAULT_PORT, origins = DEFAULT_ORIGINS, runtimeFile = DEFAULT_RUNTIME, log = console.log, signals = true, onStopped = null,
} = {}) {
  const dir = path.resolve(dataDir);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  const configFile = path.join(dir, 'config.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (_) { /* first start */ }
  const saveConfig = () => fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

  const workspaceState = () => {
    if (!config.workspace) return { workspace: null, fabrics: 0, error: null };
    try { return { workspace: config.workspace, fabrics: listFabrics(config.workspace).length, error: null }; } catch (e) { return { workspace: config.workspace, fabrics: 0, error: e.message }; }
  };
  const needWorkspace = () => {
    if (!config.workspace) throw new HttpError(409, 'no-workspace', 'Say which folder is File Fabric\'s workspace first.');
    return config.workspace;
  };

  let stopping = false;
  let actualPort = port;
  const token = crypto.randomBytes(24).toString('base64url');
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
      return json(200, { version: VERSION, pid: process.pid, dataDir: dir, ...workspaceState() });
    }
    if (m('PUT', /^\/api\/workspace$/)) {
      const body = await readJson(req);
      const ws = typeof body.path === 'string' ? body.path.trim().replace(/^"(.*)"$/, '$1') : '';
      if (!ws || !path.isAbsolute(ws)) throw new HttpError(400, 'bad-path', 'Give the workspace as a full path, e.g. E:\\FILES\\my workspace.');
      const fabrics = listFabrics(ws);
      config.workspace = path.resolve(ws);
      saveConfig();
      return json(200, { workspace: config.workspace, fabrics: fabrics.length });
    }
    if (m('GET', /^\/api\/fabrics$/)) {
      return json(200, { workspace: needWorkspace(), fabrics: listFabrics(needWorkspace()).map(({ name, modified, size }) => ({ name, modified, size })) });
    }
    if ((p = m('GET', /^\/api\/fabrics\/([^/]+)$/))) {
      const name = decodeURIComponent(p[0]);
      const built = buildFabric(fabricDir(needWorkspace(), name));
      // The last build is kept, so what NoteX made can be read outside the page.
      fs.writeFileSync(path.join(dir, 'docs', `${name}.notex.md`), built.markdown);
      fs.writeFileSync(path.join(dir, 'docs', `${name}.places.json`), JSON.stringify(built.map, null, 2));
      return json(200, { name, ...built });
    }
    if (m('POST', /^\/api\/shutdown$/)) {
      json(202, { stopping: true });
      setImmediate(() => stop('asked by the page').then(() => onStopped && onStopped()));
      return;
    }
    throw new HttpError(404, 'no-route', `No ${req.method} ${url.pathname}.`);
  };

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowedOrigin = origin && origins.includes(origin) ? origin : null;
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
        'access-control-allow-headers': 'X-Notex-Token, Content-Type',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    const given = Buffer.from(String(req.headers['x-notex-token'] || ''));
    const want = Buffer.from(token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return refuse(401, 'bad-token', 'Missing or wrong X-Notex-Token.');
    if (stopping) return refuse(503, 'stopping', 'The engine is stopping.');
    try {
      await routes(req, res, new URL(req.url, `http://${req.headers.host}`));
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
  writeLocal(path.join(path.dirname(runtimeFile), 'local.json'));

  let stopped = null;
  function stop(reason = 'stopped') {
    if (stopped) return stopped;
    stopping = true;
    stopped = (async () => {
      log(`Stopping (${reason})...`);
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      removeRuntime();
      log('Stopped.');
    })();
    return stopped;
  }

  if (signals) {
    const onSignal = () => stop('Ctrl+C').then(() => process.exit(0));
    for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(s, onSignal);
  }

  return { url, port: actualPort, token, dataDir: dir, stop, runtimeFile, config: () => ({ ...config }) };
}
