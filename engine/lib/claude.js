/* Claude Code, headless, for the placer: a prompt in, text out, on the
 * user's own subscription - the way RAGX runs it (t-1cdecf6985).
 *
 * - No shell: nothing in a prompt or a path is read as a command; the
 *   prompt goes on stdin, past Windows' 32,767-character command line.
 * - API keys are taken out of its environment, so Claude Code uses the
 *   login and never bills an API key.
 * - --safe-mode turns off CLAUDE.md, skills, plugins, hooks and MCP servers
 *   but keeps the login; --tools "" leaves it nothing to call. NoteX does
 *   the writing; the model can change nothing on its own.
 * - It runs in <data>/agent, which must sit outside any git repository,
 *   where GitX's hooks would record its answers.
 * - After the time-out its whole process tree is ended.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export class ClaudeError extends Error {
  constructor(code, message) { super(message); this.name = 'ClaudeError'; this.code = code; } // not-found | not-logged-in | limit | timeout | unsafe-folder | failed
}

const SCRUBBED = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUBBED.includes(k.toUpperCase())));

export function findClaude() {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  const known = [path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'bin')];
  for (const dir of [...String(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...known]) {
    for (const ext of exts) {
      const f = path.join(dir, 'claude' + ext);
      try { if (fs.statSync(f).isFile()) return f; } catch (_) { /* not here */ }
    }
  }
  throw new ClaudeError('not-found', 'Claude Code was not found on PATH - install it and log in once with "claude".');
}

export function agentFolder(dataDir) {
  const dir = path.join(dataDir, 'agent');
  fs.mkdirSync(dir, { recursive: true });
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) throw new ClaudeError('unsafe-folder', `NoteX's agent folder ${dir} is inside the git repository at ${d}; use a data folder outside any repository.`);
    if (path.dirname(d) === d) return dir;
  }
}

function classify(message) {
  if (/log ?in|auth|credential|api key/i.test(message)) return new ClaudeError('not-logged-in', `Claude Code is not logged in - run "claude" once in a terminal and log in. (${message})`);
  if (/limit|rate|overloaded|quota/i.test(message)) return new ClaudeError('limit', `Claude is at a usage limit: ${message}`);
  return new ClaudeError('failed', `Claude did not answer: ${message}`);
}

const killTree = (pid) => {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGTERM'); } catch (_) { /* gone */ } }
};

/* One prompt, one answer. */
export function runClaude({ prompt, system = null, model = 'sonnet', dataDir, timeoutMs = 180_000, executable = null }) {
  const exe = executable || findClaude();
  const cwd = agentFolder(dataDir);
  const args = ['-p', '--output-format', 'json', '--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--model', model];
  if (system) args.push('--append-system-prompt', system);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let out = '', err = '', done = false;
    const end = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => { killTree(child.pid); end(reject, new ClaudeError('timeout', `Claude did not answer within ${Math.round(timeoutMs / 1000)} s.`)); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s) => { out += s; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => { err = (err + s).slice(-4000); });
    child.stdin.on('error', () => { /* it exited before reading; its exit says why */ });
    child.on('error', (e) => end(reject, new ClaudeError('not-found', `Could not start ${exe}: ${e.message}`)));
    child.on('close', (code) => {
      let r = null;
      try { r = JSON.parse(out.trim().split('\n').pop()); } catch (_) { /* not JSON */ }
      if (!r) return end(reject, classify(err.trim() || `claude exited with code ${code} and no answer`));
      if (r.is_error || (r.subtype && r.subtype !== 'success')) return end(reject, classify(String(r.result || r.subtype)));
      end(resolve, { text: String(r.result || ''), model, cost: r.total_cost_usd ?? null, ms: Date.now() - started });
    });
    child.stdin.end(prompt);
  });
}
