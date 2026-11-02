/* Gemini, headless, through Antigravity's CLI (agy) - the agent beside
 * Claude, chosen per canvas in the chat (t-bdcb28547b).
 *
 * How it is run (t-fa99d45f2d):
 * - In a home folder of its own, <data>/gemini-home: the user's Google login
 *   still works (Windows keeps it), but none of the user's Antigravity MCP
 *   servers, skills, rules or settings load. Run with the user's own home, a
 *   one-word answer waited ~90 s for their MCP servers (t-4aee488ba0).
 * - In a fresh, empty work folder per ask, removed afterwards, with access
 *   outside it off, and deny rules for writing files, commands, fetching
 *   web pages and MCP tools (t-36e26b3286, t-e77c0975ee): it can only read what is in
 *   its folder and answer. Web search has no rule to turn it off; it goes to
 *   Google, which already has the prompt. NoteX does the writing.
 * - A command it tries anyway is refused, and agy then ends the turn with no
 *   answer: the prompt says to open the images by name and run nothing, and
 *   an empty answer is a failure the arranger asks again about.
 * - The prompt goes on stdin as a stream-json text message, past Windows'
 *   32,767-character command line; Claude's system prompt goes ahead of it.
 * - Images cannot go in the stream (agy takes text blocks only): each is a
 *   file in the work folder, and the prompt names it for the model to open.
 * - No shell, API keys taken out of the environment, and after the time-out
 *   the whole process tree is ended - as for Claude.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { ClaudeError } from './claude.js';

/* The Gemini models NoteX offers, as agy names them (agy models). */
export const GEMINI_MODELS = ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'];
export const isGemini = (model) => GEMINI_MODELS.includes(model);

/* The same class as Claude's, so the arranger and placer treat a logged-out or limited Gemini alike. */
export class GeminiError extends ClaudeError {
  constructor(code, message) { super(code, message); this.name = 'GeminiError'; }
}

const SCRUBBED = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
// What the model may not do, as agy's permission rules (its own help names these kinds).
const DENY = ['write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'];
const SETTINGS = JSON.stringify({ allowNonWorkspaceAccess: false, permissions: { deny: DENY } });
const RULES = 'Answer in your reply only. Do not run commands, list folders, write or change files, or fetch web pages: none of that is allowed here, and trying ends your turn with no answer.';
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

export function findAgy() {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  const known = [path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin')];
  for (const dir of [...String(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...known]) {
    for (const ext of exts) {
      const f = path.join(dir, 'agy' + ext);
      try { if (fs.statSync(f).isFile()) return f; } catch (_) { /* not here */ }
    }
  }
  throw new GeminiError('not-found', 'Antigravity\'s CLI (agy) was not found - install Antigravity and sign in once.');
}

// A folder of NoteX's own, never inside a git repository, where GitX's hooks would record answers.
function ownFolder(dataDir, name) {
  const dir = path.join(dataDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) throw new GeminiError('unsafe-folder', `NoteX's folder ${dir} is inside the git repository at ${d}; use a data folder outside any repository.`);
    if (path.dirname(d) === d) return dir;
  }
}

function classify(message) {
  if (/not authenticated|log ?in|sign ?in|auth|credential/i.test(message)) return new GeminiError('not-logged-in', `Antigravity is not signed in - open Antigravity, or run "agy" once in a terminal, and sign in. (${message})`);
  if (/limit|quota|rate|exhausted|overloaded|credits/i.test(message)) return new GeminiError('limit', `Gemini is at a usage limit: ${message}`);
  if (/unknown model|model .*not (found|available)|invalid model/i.test(message)) return new GeminiError('failed', `Antigravity does not offer that model now (agy models lists what it has): ${message}`);
  return new GeminiError('failed', `Gemini did not answer: ${message}`);
}

const killTree = (pid) => {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGTERM'); } catch (_) { /* gone */ } }
};

/* The text the model is given: the system prompt, the images by file name, the prompt. */
export function geminiInput({ prompt, system = null, images = [] }) {
  const files = images.map((im, i) => ({ name: `image-${i + 1}${EXT[im.mediaType] || '.png'}`, label: im.label, data: im.data }));
  const text = [
    ...(system ? [system, ''] : []),
    RULES,
    '',
    ...(files.length ? ['The images below are files in your current folder. Open each with view_file by the exact name given - they are all there is, so do not list the folder - and look at it before you answer:', ...files.map((f) => `- ${f.name}: ${f.label}`), ''] : []),
    prompt,
  ].join('\n');
  return { files, line: JSON.stringify({ event: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n' };
}

/* The result event of agy's stream-json output. */
export function geminiResult(out) {
  const lines = String(out).trim().split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e && e.event === 'result' && e.result) return e.result;
    } catch (_) { /* not JSON */ }
  }
  return null;
}

/* One prompt, one answer; images, when given, go along as files. */
export function runGemini({ prompt, images = [], system = null, model = GEMINI_MODELS[0], dataDir, timeoutMs = 240_000, executable = null, args: pre = [] }) {
  const exe = executable || findAgy();
  const home = ownFolder(dataDir, 'gemini-home');
  const work = path.join(ownFolder(dataDir, 'gemini-runs'), crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(work, { recursive: true });
  const { files, line } = geminiInput({ prompt, system, images });
  for (const f of files) fs.writeFileSync(path.join(work, f.name), f.data);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUBBED.includes(k.toUpperCase())));
  Object.assign(env, { USERPROFILE: home, HOME: home });
  const args = [...pre, '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model, '--settings', SETTINGS, '-p', ''];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let out = '', err = '', done = false;
    const end = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* gone, or held a moment longer */ }
      fn(v);
    };
    const timer = setTimeout(() => { killTree(child.pid); end(reject, new GeminiError('timeout', `Gemini did not answer within ${Math.round(timeoutMs / 1000)} s.`)); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s) => { out += s; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => { err = (err + s).slice(-4000); });
    child.stdin.on('error', () => { /* it exited before reading; its exit says why */ });
    child.on('error', (e) => end(reject, new GeminiError('not-found', `Could not start ${exe}: ${e.message}`)));
    child.on('close', (code) => {
      const r = geminiResult(out);
      if (!r) return end(reject, classify(err.trim() || `agy exited with code ${code} and no answer`));
      if (r.status !== 'SUCCESS' || r.finished_reason) return end(reject, classify(String(r.error || r.finished_reason || r.status)));
      if (!String(r.response || '').trim()) {
        const tried = (r.denied_actions || []).map((a) => a.display_name || a.action).join(', ');
        return end(reject, new GeminiError('failed', `Gemini gave no answer${tried ? ` - it tried ${tried}, which it may not do here` : ''}. Answer in words and scripts only, without tools.`));
      }
      end(resolve, { text: String(r.response || ''), model, cost: null, ms: Date.now() - started });
    });
    child.stdin.end(line);
  });
}
