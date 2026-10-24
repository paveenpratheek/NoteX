/* Talking to the engine.
 *
 * The engine writes runtime.json beside this page each time it starts - its
 * address and a fresh token - and removes it when it stops; ter-manager
 * serves it from the plugin folder. A runtime.json left behind by a hard
 * kill names an engine that no longer answers, so "running" means
 * /api/state answered, never that the file exists.
 */

export class EngineDown extends Error {
  constructor(message) { super(message); this.name = 'EngineDown'; }
}

export class EngineRefused extends Error {
  constructor(status, code, message) { super(message); this.name = 'EngineRefused'; this.status = status; this.code = code; }
}

async function readJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
}

export class Engine {
  constructor(base = '.') {
    this.base = base;
    this.rt = null;
  }

  async locate() { this.rt = await readJson(`${this.base}/runtime.json`); return this.rt; }

  local() { return readJson(`${this.base}/local.json`); }

  async json(method, path, body) {
    if (!this.rt) throw new EngineDown('The engine is not running.');
    let res;
    try {
      res = await fetch(this.rt.url + path, {
        method,
        headers: { 'x-notex-token': this.rt.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch (_) {
      throw new EngineDown(`The engine at ${this.rt.url} is not answering.`);
    }
    if (!res.ok) {
      let err = {};
      try { err = (await res.json()).error || {}; } catch (_) {}
      throw new EngineRefused(res.status, err.code || String(res.status), err.message || `The engine answered ${res.status}.`);
    }
    return res.json();
  }

  /* Running means answering, not runtime.json existing. */
  async state() {
    await this.locate();
    if (!this.rt) return null;
    try { return await this.json('GET', '/api/state'); } catch (e) {
      if (e instanceof EngineDown) return null;
      throw e;
    }
  }

  setWorkspace(p) { return this.json('PUT', '/api/workspace', { path: p }); }
  fabrics() { return this.json('GET', '/api/fabrics'); }
  fabric(name) { return this.json('GET', `/api/fabrics/${encodeURIComponent(name)}`); }
  shutdown() { return this.json('POST', '/api/shutdown'); }
}
