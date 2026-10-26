/* The rules canvas: the one canvas the user marks on NoteX's page as holding
 * the planning, criteria and rules that are the same for every agent and
 * project (t-311d4aa296, t-b17d4969c5). NoteX writes it to rules.md in its
 * data folder after every save File Fabric makes of it, kept in RAGX or not,
 * and the user's own ~/.claude/CLAUDE.md imports that file, so every Claude
 * Code session starts with it (t-00728790ad).
 *
 * On this canvas words become instructions, so only the user's own typed
 * words go in - text drawings and notes with their checklists, under their
 * places' addresses; image readings, files, pen strokes, wires and anything
 * marked as an agent's are left out (t-74338c1615). The file opens with two
 * fixed lines (t-0ade25f39f), and its size is shown on the page because it
 * is read again with every reply (t-f93928ce0d).
 */
import fs from 'node:fs';
import path from 'node:path';
import { readFabric, FabricError } from './fabric.js';
import { buildPlaces, inOrder } from './places.js';
import { safeText } from './document.js';

export const RULES_FILE = 'rules.md';
export const WARN_TOKENS = 2000;
export const FIXED = [
  "Rules in a repository's own CLAUDE.md or AGENTS.md take precedence over these.",
  'For the GitX workflow, follow the gitx-workflow skill.',
];
const POLL_MS = 5_000;

// About four characters a token, as Claude counts English.
export const tokensOf = (s) => Math.ceil(String(s).length / 4);

/* The user's own words on one place, in reading order, made safe to sit
 * under its address: a "# Title" of theirs would otherwise cut the rest off
 * from the place it belongs to. */
function ownWords(p) {
  const out = [];
  if (p.kind === 'note' && p.area && p.area.writtenBy !== 'agent') {
    const t = safeText(p.area.textContent);
    if (t) out.push(t);
  }
  p.texts.forEach((t, i) => { if (!p.textByAgent[i] && safeText(t)) out.push(safeText(t)); });
  return out;
}

export function toRules(model) {
  const lines = [`# Rules for agents, from the File Fabric canvas ${model.fabric.name}`, '', ...FIXED];
  for (const p of inOrder(model).slice(1)) {
    const words = ownWords(p);
    if (!words.length) continue;
    lines.push('', `## ${p.address}`, '', words.join('\n\n'));
  }
  return lines.join('\n') + '\n';
}

/* What rules.md says when no canvas is the rules canvas: the fixed lines
 * only, so an import of it still loads cleanly. */
const EMPTY = [`# Rules for agents, from File Fabric`, '', ...FIXED, '', 'No canvas is marked as the rules canvas on NoteX\'s page.', ''].join('\n');

export class RulesFile {
  constructor({ config, saveConfig, dataDir, log = () => {}, pollMs = POLL_MS, now = Date.now }) {
    Object.assign(this, { config, saveConfig, log, pollMs, now });
    this.file = path.join(dataDir, RULES_FILE);
    this.state = { canvas: null, tokens: null, at: null, error: null };
    this.seen = null; // the fabric.json modified time last written from
    this.timer = null;
  }

  start() {
    if (!this.timer) { this.timer = setInterval(() => this.tick(), this.pollMs); this.timer.unref?.(); }
    this.tick();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  fabricFile() { return path.join(this.config.workspace || '', this.config.rules || '', 'fabric.json'); }

  write(text) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, this.file);
    // How many places gave rules, so the page can say when the canvas has none yet.
    this.state = { ...this.state, tokens: tokensOf(text), places: (text.match(/^## /gm) || []).length, at: new Date(this.now()).toISOString(), error: null };
  }

  /* The rules canvas's latest save, written out; a save caught half-written
   * keeps the last file and is tried again at the next look. */
  tick() {
    const name = this.config.rules || null;
    if (!name || !this.config.workspace) {
      if (this.state.canvas !== null || !fs.existsSync(this.file)) { this.state.canvas = null; this.write(EMPTY); this.seen = null; }
      return;
    }
    let m;
    try { m = fs.statSync(this.fabricFile()).mtimeMs; } catch (_) {
      this.state = { ...this.state, canvas: name, error: `No fabric.json for ${name} in the workspace.` };
      return;
    }
    if (m === this.seen && this.state.canvas === name) return;
    try {
      const text = toRules(buildPlaces(readFabric(path.dirname(this.fabricFile()))));
      this.state.canvas = name;
      this.write(text);
      this.seen = m;
      this.log(`Wrote the rules from ${name}.`);
    } catch (e) {
      const halfSaved = e instanceof FabricError && e.code === 'bad-json';
      this.state = { ...this.state, canvas: name, error: halfSaved ? 'File Fabric is saving it - tried again in a moment.' : e.message };
    }
  }

  /* One canvas at a time: switching another on takes it from the first (t-44b0806310). */
  set(name, on) {
    if (on) this.config.rules = name;
    else if (this.config.rules === name) this.config.rules = null;
    this.saveConfig();
    this.seen = null;
    this.tick();
  }

  report() {
    return {
      ...this.state, canvas: this.config.rules || null, file: this.file,
      warn: this.state.tokens != null && this.state.tokens > WARN_TOKENS, limit: WARN_TOKENS,
      importLine: `@${this.file.replace(/\\/g, '/')}`,
    };
  }
}
