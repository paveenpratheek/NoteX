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

  json(method, path, body) {
    return this.send(method, path, body === undefined ? undefined : JSON.stringify(body), body !== undefined ? { 'content-type': 'application/json' } : {});
  }

  async send(method, path, body, headers = {}) {
    if (!this.rt) throw new EngineDown('The engine is not running.');
    let res;
    try {
      res = await fetch(this.rt.url + path, { method, headers: { 'x-notex-token': this.rt.token, ...headers }, body, cache: 'no-store' });
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
  readImages(name) { return this.json('POST', `/api/fabrics/${encodeURIComponent(name)}/read`); }
  setRagx(p) { return this.json('PUT', '/api/ragx', { path: p }); }
  setSync(name, on) { return this.json('PUT', `/api/fabrics/${encodeURIComponent(name)}/sync`, { on }); }
  setRules(name, on) { return this.json('PUT', `/api/fabrics/${encodeURIComponent(name)}/rules`, { on }); }
  cancelScript(id) { return this.json('POST', `/api/scripts/${encodeURIComponent(id)}/cancel`); }
  inbox() { return this.json('GET', '/api/inbox'); }
  /* A send goes whole, as one multipart body - its files, the description,
   * the message to the agent and the canvas - so it lands all or none
   * (t-fe28f948b4). The browser sets the multipart content type. */
  sendDrop({ files = [], description = '', ask = '', canvas = '', byMessage = false } = {}) {
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    fd.append('description', description);
    fd.append('message', ask);
    fd.append('canvas', canvas);
    if (byMessage) fd.append('byMessage', 'true');
    return this.send('POST', '/api/inbox/send', fd);
  }
  chooseCanvas(id, canvas) { return this.json('PUT', `/api/inbox/${encodeURIComponent(id)}/canvas`, { canvas }); }
  leaveToMessage(id) { return this.json('PUT', `/api/inbox/${encodeURIComponent(id)}/canvas`, { byMessage: true }); }
  forgetDrop(id) { return this.json('POST', `/api/inbox/${encodeURIComponent(id)}/forget`); }
  setPlacing(on) { return this.json('PUT', '/api/placer', { on }); }
  setPlacerModel(model) { return this.json('PUT', '/api/placer', { model }); }
  askAgent(name, ask, model) { return this.json('POST', `/api/agent-canvases/${encodeURIComponent(name)}/ask`, { ask, model }); }
  agentCanvases() { return this.json('GET', '/api/agent-canvases'); }
  agentCanvas(name) { return this.json('GET', `/api/agent-canvases/${encodeURIComponent(name)}`); }
  setAgent(name, on) { return this.json('PUT', `/api/fabrics/${encodeURIComponent(name)}/agent`, { on }); }
  render(name) { return this.json('POST', `/api/fabrics/${encodeURIComponent(name)}/render`); }
  // The phone over the USB cable (t-71306596ff).
  phone() { return this.json('GET', '/api/phone'); }
  phoneDevices() { return this.json('GET', '/api/phone/devices'); }
  phoneBrowse(device, segs) { return this.json('GET', `/api/phone/browse?device=${encodeURIComponent(device)}&path=${encodeURIComponent(JSON.stringify(segs))}`); }
  setPhone(device, segs) { return this.json('PUT', '/api/phone', { device, path: segs }); }
  forgetPhone() { return this.json('DELETE', '/api/phone'); }
  syncPhone() { return this.json('POST', '/api/phone/sync'); }
}
