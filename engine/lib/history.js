/* An agent canvas's history: when the user switches it on for a canvas,
 * every accepted write of its totem scripts becomes a commit in a git
 * repository of the canvas's own, so the scripts can be had as they stood
 * at any moment (t-732b681a32):
 *
 *   <data>/history/<canvas>/            a git repository, never pushed
 *   <data>/history/<canvas>/totems.json the totems in drawing order: name, file, owner
 *   <data>/history/<canvas>/<file>.totem each totem's script, as agentcanvas.js names it
 *
 * Each commit's author is whoever wrote, its date the write's time, and its
 * message holds the exact time (At:) and what changed (Change:), since git's
 * dates stop at the second (t-57a020ecce). The canvas and its scripts stay
 * the true version (t-adc937459a); this is a copy for looking back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export class HistoryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const EMAIL = 'notex@localhost';
const ADDED = 'Added', CHANGED = 'Changed', DELETED = 'Deleted';

/* What changed between two snapshots, by totem name. */
function changes(before, after) {
  const was = new Map(before.map((t) => [t.file, t]));
  const now = new Map(after.map((t) => [t.file, t]));
  const added = after.filter((t) => !was.has(t.file)).map((t) => t.name);
  const changed = after.filter((t) => was.has(t.file) && was.get(t.file).script !== t.script).map((t) => t.name);
  const deleted = before.filter((t) => !now.has(t.file)).map((t) => t.name);
  // A totem keeps its file when renamed (t-a484b5d0de), so a rename is the same file under a new name (t-adc221f8f3).
  const renamed = after.filter((t) => was.has(t.file) && was.get(t.file).name !== t.name).map((t) => ({ from: was.get(t.file).name, to: t.name }));
  const order = (s) => JSON.stringify(s.map((t) => [t.file, t.name, t.owner || null]));
  return { added, changed, deleted, renamed, same: !added.length && !changed.length && !deleted.length && order(before) === order(after) };
}

function headline(who, c) {
  const part = (word, names) => (names.length ? `${word.toLowerCase()} ${names.join(', ')}` : null);
  const what = [...c.renamed.map((r) => `renamed ${r.from} to ${r.to}`), part(ADDED, c.added), part(CHANGED, c.changed), part(DELETED, c.deleted)].filter(Boolean).join('; ');
  return `${who}: ${what || 'the totems in a new order'}`.slice(0, 200);
}

export class History {
  constructor({ dataDir, config, saveConfig = () => {}, log = () => {}, git = 'git', now = Date.now }) {
    Object.assign(this, { config, saveConfig, say: log, gitBin: git, now });
    this.root = path.join(path.resolve(dataDir), 'history');
  }

  dir(canvas) { return path.join(this.root, canvas); }
  exists(canvas) { return fs.existsSync(path.join(this.dir(canvas), '.git')); }
  on(canvas) { return Boolean(this.config.history && this.config.history[canvas] && this.config.history[canvas].on); }

  report(canvas) {
    const h = (this.config.history && this.config.history[canvas]) || {};
    return { on: Boolean(h.on), since: h.since || null, off: h.off || null, kept: this.exists(canvas) };
  }

  /* ----------------------------------------------------------------- git */

  /* git for the history, apart from the user's own git setup: no hooks
   * (GitX's among them), no templates, no signing, no line-ending
   * conversion, so a script comes back byte for byte (t-c20021da28). */
  git(dir, args, { author = null, at = null, input = undefined, raw = false } = {}) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (author) {
      const date = `@${Math.floor(at / 1000)} +0000`;
      Object.assign(env, { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: EMAIL, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: 'NoteX', GIT_COMMITTER_EMAIL: EMAIL, GIT_COMMITTER_DATE: date });
    }
    const fixed = ['-c', `core.hooksPath=${path.join(dir, '.git', 'no-hooks')}`, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=false', '-c', 'gc.auto=0'];
    try {
      const out = execFileSync(this.gitBin, [...fixed, ...args], { cwd: dir, env, input, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
      return raw ? out : out.toString('utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw new HistoryError('no-git', 'Git was not found on PATH - install Git to keep a canvas\'s history.');
      throw new HistoryError('git-failed', `git ${args[0]} failed: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
    }
  }

  /* The history never lands inside a code repository, where its commits
   * would mix with code - the check NoteX makes for its agent folders. */
  safeRoot() {
    for (let d = path.dirname(this.root); ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, '.git'))) throw new HistoryError('unsafe-folder', `NoteX's history folder ${this.root} would be inside the git repository at ${d}; use a data folder outside any repository.`);
      if (path.dirname(d) === d) return this.root;
    }
  }

  init(canvas) {
    const dir = this.dir(canvas);
    if (this.exists(canvas)) return dir;
    this.safeRoot();
    fs.mkdirSync(dir, { recursive: true });
    this.git(dir, ['init', '-q', '--template=', '-b', 'main']);
    return dir;
  }

  /* ------------------------------------------------------------- writing */

  /* The snapshot in the working tree: what the last commit holds. */
  current(canvas) {
    const dir = this.dir(canvas);
    let totems = [];
    try { totems = JSON.parse(fs.readFileSync(path.join(dir, 'totems.json'), 'utf8')); } catch (_) { return []; }
    return totems.map((t) => {
      let script = null;
      try { script = fs.readFileSync(path.join(dir, t.file), 'utf8'); } catch (_) { /* missing */ }
      return { ...t, script };
    });
  }

  /* One commit of the canvas's scripts as they are after a write: by who,
   * at the write's time. Nothing when nothing changed. */
  commit(canvas, totems, { who, at = this.now() } = {}) {
    const dir = this.init(canvas);
    const snap = totems.filter((t) => t.script != null).map((t) => ({ name: t.name, file: t.file, owner: t.owner || null, script: t.script }));
    const before = this.current(canvas);
    const c = changes(before, snap);
    if (c.same && fs.existsSync(path.join(dir, 'totems.json'))) return null;
    for (const t of before) if (!snap.some((s) => s.file === t.file)) fs.rmSync(path.join(dir, t.file), { force: true });
    for (const t of snap) fs.writeFileSync(path.join(dir, t.file), t.script);
    fs.writeFileSync(path.join(dir, 'totems.json'), JSON.stringify(snap.map(({ name, file, owner }) => ({ name, file, owner })), null, 2) + '\n');
    const author = String(who || 'NoteX').replace(/[<>\n]/g, ' ').trim() || 'NoteX';
    const iso = new Date(at).toISOString();
    const message = `${headline(author, c)}\n\nAt: ${iso}\nChange: ${JSON.stringify({ added: c.added, changed: c.changed, deleted: c.deleted, renamed: c.renamed })}\n`;
    this.git(dir, ['add', '-A']);
    this.git(dir, ['commit', '-q', '--allow-empty', '-F', '-'], { author, at, input: message });
    return { at: iso, who: author, added: c.added, changed: c.changed, deleted: c.deleted, renamed: c.renamed };
  }

  /* ------------------------------------------------------------- reading */

  /* Every commit, newest first: when, who, which totems changed. */
  log(canvas, limit = 0) {
    if (!this.exists(canvas)) return [];
    let out;
    try { out = this.git(this.dir(canvas), ['log', '--format=%x1e%H%x1f%an%x1f%B', ...(limit ? [`-n${limit}`] : [])]); } catch (e) {
      if (/does not have any commits|bad default revision/i.test(e.message)) return [];
      throw e;
    }
    return out.split('\x1e').filter((s) => s.trim()).map((rec) => {
      const [commit, who, body] = rec.split('\x1f');
      const at = /^At: (.+)$/m.exec(body || '');
      let change = { added: [], changed: [], deleted: [], renamed: [] };
      const m = /^Change: (.+)$/m.exec(body || '');
      if (m) { try { change = { ...change, ...JSON.parse(m[1]) }; } catch (_) { /* kept as none */ } }
      return { commit: commit.trim(), at: at ? at[1].trim() : null, who, ...change };
    });
  }

  /* The scripts as they stood at a time: the last commit at or before it,
   * by the exact times its messages keep. null before the first. */
  at(canvas, when) {
    const t = typeof when === 'number' ? when : Date.parse(when);
    if (!Number.isFinite(t)) throw new HistoryError('bad-time', `"${when}" is not a time - give an ISO time such as 2026-11-08T12:36:01Z.`);
    if (!this.exists(canvas)) throw new HistoryError('no-history', `${canvas} has no history - switch Keep history on for it first.`);
    const hit = this.log(canvas).find((c) => c.at && Date.parse(c.at) <= t);
    if (!hit) return null;
    const dir = this.dir(canvas);
    const totems = JSON.parse(this.git(dir, ['show', `${hit.commit}:totems.json`]));
    const blobs = this.blobs(dir, totems.map((x) => `${hit.commit}:${x.file}`));
    return { commit: hit.commit, at: hit.at, who: hit.who, totems: totems.map((x, i) => ({ ...x, script: blobs[i] })) };
  }

  /* Several files of a commit in one git call. */
  blobs(dir, refs) {
    if (!refs.length) return [];
    const out = this.git(dir, ['cat-file', '--batch'], { input: refs.join('\n') + '\n', raw: true });
    const texts = [];
    let i = 0;
    for (let k = 0; k < refs.length; k++) {
      const nl = out.indexOf(0x0a, i);
      const head = out.subarray(i, nl).toString('utf8');
      if (/ missing$/.test(head)) { texts.push(null); i = nl + 1; continue; }
      const size = Number(head.split(' ')[2]);
      texts.push(out.subarray(nl + 1, nl + 1 + size).toString('utf8'));
      i = nl + 1 + size + 1;
    }
    return texts;
  }

  /* ----------------------------------------------------------- switching */

  /* Switched on, the history starts with what NoteX already kept (replay),
   * then the scripts as they are; off, nothing more is committed and what
   * was kept stays. */
  set(canvas, on, { replay = null, snapshot = null } = {}) {
    const all = (this.config.history = this.config.history || {});
    const was = all[canvas] || {};
    if (!on) {
      if (!was.on) return this.report(canvas);
      all[canvas] = { ...was, on: false, off: new Date(this.now()).toISOString() };
      this.saveConfig();
      return this.report(canvas);
    }
    if (was.on) return this.report(canvas);
    this.safeRoot();
    this.git(path.dirname(this.root), ['--version']); // says plainly when Git is missing
    const fresh = !this.exists(canvas);
    let replayed = 0;
    if (fresh && replay) {
      for (const step of replay()) if (this.commit(canvas, step.totems, { who: step.who, at: step.at })) replayed++;
    }
    if (snapshot) this.commit(canvas, snapshot(), { who: 'NoteX', at: this.now() });
    all[canvas] = { on: true, since: new Date(this.now()).toISOString() };
    this.saveConfig();
    return { ...this.report(canvas), replayed };
  }
}

/* ---------------------------------------------------------------- replay */

const stampTime = (file) => {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z/.exec(file);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
};
const totemName = (script) => { const m = /<Totem\b[^>]*\bname="([^"]*)"/.exec(script || ''); return m ? m[1] : null; };

/* What an agent canvas looked like at each write NoteX kept before history
 * was on, oldest first, from its scripts folder (t-9dbb490caa): a file in
 * versions/<totem>/ holds the script that stood until its stamp, a
 * -deleted one ends its totem, and the scripts now stand from the last
 * stamp. Each write's author is the activity's script entry for that totem
 * within two seconds of the stamp. */
export function replaySteps({ dir, layout, activity = [], assignedAt = null }) {
  // A script kept from an agent, an ask the chat's agent carried out, a totem it deleted.
  const writes = activity.filter((a) => a.at && ((a.what === 'script' && a.status === 'written') || (a.what === 'answered' && a.status === 'done') || a.what === 'deleted'))
    .map((a) => ({ at: Date.parse(a.at), who: a.what === 'script' ? a.owner : 'NoteX agent', totems: a.what === 'script' ? [String(a.change || '').replace(/^(new )?totem /, '')] : (a.totems || []) }));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const writer = (name, t) => {
    const w = writes.find((x) => x.at >= t - 100 && x.at - t <= 2000 && x.totems.some((n) => norm(n) === norm(name)));
    return w ? w.who : null;
  };
  const firstWrite = (name, after, before) => {
    const w = writes.find((x) => x.at > after && x.at < before && x.totems.some((n) => norm(n) === norm(name)));
    return w || null;
  };
  const origin = Number.isFinite(Date.parse(assignedAt)) ? Date.parse(assignedAt) : null;

  const live = new Map(layout.map((t) => [t.file, t]));
  const vroot = path.join(dir, 'versions');
  let kept = [];
  try { kept = fs.readdirSync(vroot); } catch (_) { /* none */ }
  const files = new Set([...layout.map((t) => t.file), ...kept.map((k) => `${k}.totem`)]);
  const events = []; // { at, file, name, owner, script|null, who }
  for (const file of files) {
    let names = [];
    try { names = fs.readdirSync(path.join(vroot, file.replace(/\.totem$/, ''))).filter((f) => f.endsWith('.totem')); } catch (_) { /* none */ }
    const versions = names.map((f) => ({ at: stampTime(f), deleted: f.endsWith('-deleted.totem'), text: fs.readFileSync(path.join(vroot, file.replace(/\.totem$/, ''), f), 'utf8') }))
      .filter((v) => Number.isFinite(v.at)).sort((a, b) => a.at - b.at);
    const now = live.get(file);
    if (!versions.length && !now) continue;
    const name = (now && now.name) || totemName(versions[versions.length - 1].text) || file;
    const owner = now ? now.owner || null : null;
    let nowText = null;
    if (now) { try { nowText = fs.readFileSync(path.join(dir, file), 'utf8'); } catch (_) { /* no file */ } }
    // Each version under the name its own script gives, so a renamed totem is one file all along (t-adc221f8f3).
    const put = (at, script, who) => events.push({ at, file, name: (script && totemName(script)) || name, owner, script, who });
    const nameOf = (script) => (script && totemName(script)) || name;
    // A script that follows nothing - the first, or one after a deletion -
    // starts at its first write, else just after what came before it.
    const begin = (from, until, script) => {
      const w = firstWrite(nameOf(script), from, until);
      const t0 = w ? w.at : from > -Infinity ? from + 1 : origin != null && origin < until ? origin : until - 1;
      if (Number.isFinite(t0)) put(t0, script, w ? w.who : null);
    };
    // A totem never rewritten: its one script, from its first write.
    if (!versions.length) { if (nowText != null) begin(-Infinity, Infinity, nowText); continue; }
    versions.forEach((v, i) => {
      // v.text stood until v.at.
      if (i === 0 || versions[i - 1].deleted) begin(i === 0 ? -Infinity : versions[i - 1].at, v.at, v.text);
      const next = versions[i + 1];
      if (v.deleted) put(v.at, null, writer(nameOf(v.text), v.at));
      else if (next) put(v.at, next.text, writer(nameOf(next.text), v.at));
      else put(v.at, nowText, writer(nameOf(nowText || v.text), v.at)); // the script now, or gone with nothing kept
    });
    // Made again after its last deletion: the script now, from its first write after it.
    const last = versions[versions.length - 1];
    if (last.deleted && nowText != null) begin(last.at, Infinity, nowText);
  }
  events.sort((a, b) => a.at - b.at);
  const steps = [];
  const state = new Map(); // file -> totem, in the order they appeared
  for (let i = 0; i < events.length;) {
    const at = events[i].at;
    const who = new Set();
    for (; i < events.length && events[i].at === at; i++) {
      const e = events[i];
      if (e.script === null) state.delete(e.file);
      else state.set(e.file, { name: e.name, file: e.file, owner: e.owner, script: e.script });
      who.add(e.who || 'NoteX\'s saved versions');
    }
    steps.push({ at, who: [...who].join(', '), totems: [...state.values()] });
  }
  return steps;
}
