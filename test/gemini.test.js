/* Gemini through Antigravity's CLI (t-bdcb28547b, t-fa99d45f2d): the input it
 * is sent, how its answer is read, the folders it runs in, and the canvas's
 * own model. A stand-in agy (a Node script) plays the CLI, so no prompt
 * leaves this PC. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { geminiInput, geminiResult, runGemini, isGemini, GEMINI_MODELS } from '../engine/lib/gemini.js';
import { MODELS, CLAUDE_MODELS, canvasModel, runAgent } from '../engine/lib/models.js';
import { Writer } from '../engine/lib/writer.js';
import { Bronze } from '../engine/lib/bronze.js';
import { AgentCanvases } from '../engine/lib/agentcanvas.js';
import { Arranger } from '../engine/lib/arranger.js';
import { ClaudeError } from '../engine/lib/claude.js';

test('the models: Claude\'s, then Gemini\'s through Antigravity', () => {
  assert.deepEqual(MODELS, [...CLAUDE_MODELS, ...GEMINI_MODELS]);
  assert.ok(GEMINI_MODELS.every((m) => m.startsWith('gemini-')));
  assert.equal(isGemini('gemini-3.8-flash-low'), true);
  assert.equal(isGemini('sonnet'), false);
});

test('the input: one stream-json text message, the system prompt first, images as named files', () => {
  const { files, line } = geminiInput({ prompt: 'Place it.', system: 'You keep a canvas.', images: [{ label: 'The image of drop d-1 (beach.jpg):', mediaType: 'image/jpeg', data: Buffer.from('jpg') }] });
  assert.deepEqual(files.map((f) => f.name), ['image-1.jpg']);
  const msg = JSON.parse(line);
  assert.equal(msg.event, 'user');
  assert.deepEqual(msg.message.content.map((c) => c.type), ['text']);
  const text = msg.message.content[0].text;
  assert.ok(text.startsWith('You keep a canvas.'));
  assert.match(text, /- image-1\.jpg: The image of drop d-1 \(beach\.jpg\):/);
  assert.ok(text.endsWith('Place it.'));
  assert.ok(line.endsWith('\n'));
});

test('the answer: the result event of the stream, whatever comes before it', () => {
  const out = ['{"event":"init","init":{"model":"m"}}', 'not json', '{"event":"result","result":{"status":"SUCCESS","response":"Done.\\n"}}'].join('\n');
  assert.deepEqual(geminiResult(out), { status: 'SUCCESS', response: 'Done.\n' });
  assert.equal(geminiResult('{"event":"init"}'), null);
});

// A stand-in agy: records what it was given - its arguments, folder, home and the files beside it - and answers.
function fakeAgy(dir, { answer = 'OK', status = 'SUCCESS', error = null, slow = 0 } = {}) {
  const js = path.join(dir, 'fake-agy.js');
  fs.writeFileSync(js, `
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'seen.json'))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.USERPROFILE, files: fs.readdirSync('.'), input, key: process.env.GEMINI_API_KEY || null }));
  fs.writeFileSync('scribble.txt', 'the model wrote here');
  console.log(JSON.stringify({ event: 'init', init: {} }));
  console.log(JSON.stringify({ event: 'result', result: { status: ${JSON.stringify(status)}, response: ${JSON.stringify(answer)}, error: ${JSON.stringify(error)} } }));
}, ${slow}));
`);
  return { exe: process.execPath, pre: [js] }; // node running the script; the script goes first among the arguments
}

test('a run: in its own home and an empty work folder, images beside it, the folder gone afterwards', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-gemini-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const fake = fakeAgy(root, { answer: 'Placed it.' });
  process.env.GEMINI_API_KEY = 'must-not-pass';
  t.after(() => { delete process.env.GEMINI_API_KEY; });
  // The stand-in is node running the script: the script goes first among the arguments.
  const r = await runGemini({ prompt: 'Where?', system: 'Sys.', images: [{ label: 'Drop d-1:', mediaType: 'image/png', data: Buffer.from('png') }], model: 'gemini-3.8-flash-low', dataDir: data, executable: fake.exe, args: fake.pre });
  assert.equal(r.text, 'Placed it.');
  assert.equal(r.model, 'gemini-3.8-flash-low');
  const seen = JSON.parse(fs.readFileSync(path.join(root, 'seen.json'), 'utf8'));
  assert.equal(seen.home, path.join(data, 'gemini-home'));
  assert.equal(path.dirname(seen.cwd), path.join(data, 'gemini-runs'));
  assert.deepEqual(seen.files, ['image-1.png']);
  assert.equal(seen.key, null, 'API keys are taken out of its environment');
  const a = seen.args.slice(1);
  assert.deepEqual(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2), ['--model', 'gemini-3.8-flash-low']);
  const settings = JSON.parse(a[a.indexOf('--settings') + 1]);
  assert.equal(settings.allowNonWorkspaceAccess, false);
  assert.deepEqual(settings.permissions.deny, ['write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)']);
  assert.deepEqual(a.slice(-2), ['-p', '']);
  const said = JSON.parse(seen.input).message.content[0].text;
  assert.match(said, /^Sys\.\n\nAnswer in your reply only\. Do not run commands/);
  assert.match(said, /Open each with view_file by the exact name given.*\n- image-1\.png: Drop d-1:/s);
  assert.equal(fs.existsSync(seen.cwd), false, 'the work folder, and what the model wrote there, is removed');
});

test('a refusal says what to do: signed out, at a limit, or failed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-gemini-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  for (const [error, code] of [['Print mode: not authenticated', 'not-logged-in'], ['quota exhausted', 'limit'], ['something broke', 'failed']]) {
    const fake = fakeAgy(root, { status: 'ERROR', error });
    await assert.rejects(runGemini({ prompt: 'x', model: 'gemini-3.8-flash-low', dataDir: data, executable: fake.exe, args: fake.pre }), (e) => e instanceof ClaudeError && e.code === code);
  }
  // A turn agy ended after a refused command: no words at all, which the arranger asks again about.
  const empty = fakeAgy(root, { answer: '' });
  await assert.rejects(runGemini({ prompt: 'x', model: 'gemini-3.8-flash-low', dataDir: data, executable: empty.exe, args: empty.pre }), (e) => e.code === 'failed' && /gave no answer/.test(e.message));
  const slow = fakeAgy(root, { slow: 3000 });
  await assert.rejects(runGemini({ prompt: 'x', model: 'gemini-3.8-flash-low', dataDir: data, executable: slow.exe, args: slow.pre, timeoutMs: 300 }), (e) => e.code === 'timeout');
  await assert.rejects(runAgent({ prompt: 'x', model: 'gemini-3.8-flash-low', dataDir: data, executable: path.join(root, 'no-such-agy.exe') }), (e) => e.code === 'not-found');
});

test('a canvas keeps the model of its last message; an ask naming none uses it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notex-gemini-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws'), data = path.join(root, 'data');
  fs.mkdirSync(path.join(ws, 'Board'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'Board', 'fabric.json'), JSON.stringify({ drawings: [], areas: [], files: [], links: [], totems: [] }));
  fs.writeFileSync(path.join(ws, 'Board', 'agent.json'), '{}');
  const config = { workspace: ws };
  const writer = new Writer({ config, dataDir: data });
  writer.agent = new AgentCanvases({ dataDir: data, writer, bronze: new Bronze(data) });
  const models = [];
  const arranger = new Arranger({ config, dataDir: data, writer, run: async (req) => { models.push(req.model); return { text: 'Noted.' }; } });
  assert.equal(canvasModel(writer.agent, 'Board'), null);
  assert.equal(arranger.modelFor('Board'), 'sonnet');
  arranger.ask('Board', 'hello', 'gemini-3.8-flash-medium'); await arranger.running.done;
  assert.equal(arranger.modelFor('Board'), 'gemini-3.8-flash-medium');
  arranger.ask('Board', 'and again'); await arranger.running.done; // from the phone, no model named
  assert.deepEqual(models, ['gemini-3.8-flash-medium', 'gemini-3.8-flash-medium']);
  assert.equal(writer.agent.chat('Board').filter((x) => x.who === 'agent').every((x) => x.model === 'gemini-3.8-flash-medium'), true);
  arranger.ask('Board', 'back to Claude', 'opus'); await arranger.running.done;
  assert.equal(arranger.modelFor('Board'), 'opus');
});
