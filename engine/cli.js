#!/usr/bin/env node
/* The engine from a terminal.
 *
 *   node engine/cli.js <command> [...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { listFabrics, isFabric, FabricError } from './lib/fabric.js';
import { buildFabric, startServer, writeBuilt as keepBuilt } from './lib/server.js';
import { writeLocal, REPO } from './lib/lifecycle.js';
import { readFabricImages } from './lib/read.js';
import { RagxError } from './lib/ragx.js';
import { Bronze, BronzeError } from './lib/bronze.js';
import { Writer } from './lib/writer.js';
import { AgentCanvases } from './lib/agentcanvas.js';
import { Refusal } from './lib/layout.js';
import { Placer } from './lib/placer.js';

const USAGE = `usage: node engine/cli.js <command>

  build <folder> [--out <dir>] [--data-dir <folder>]
                          a fabric (a folder holding fabric.json) or a whole
                          workspace as address documents and place maps;
                          one fabric with no --out prints its document;
                          with --data-dir, images carry their kept readings
  read <fabric> --data-dir <folder> [--ragx <RAGX plugin folder>]
                          have RAGX's engine read the fabric's images, four
                          at a time, keeping the readings in the data folder
  fabrics <workspace>     the fabrics in a workspace, newest first
  serve --data-dir <folder> [--port 7781] [--origin <url,url>] [--ragx <folder>]
                          run as the plugin's server on 127.0.0.1 (Ctrl+C stops it)
  plugin-setup            once: tells the plugin where the engine is
  drop <file> | --text "<words>"  --data-dir <folder> [--canvas <name>] [--note "<words>"]
                          keep a file or typed text in the inbox, as it is;
                          with no --canvas it waits for one
  drops --data-dir <folder>       the inbox, newest first
  forget <drop id> --data-dir <folder>
                          remove a drop from the inbox for good
  render <canvas> --data-dir <folder>
                          draw an agent canvas again from its totem scripts
  place --data-dir <folder> [--model sonnet]
                          have the agent place the oldest queued drop now,
                          with Claude Code (stop the engine first)`;

class UsageError extends Error {}

function parse(argv) {
  const opts = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'help') opts.help = true;
      else if (i + 1 < argv.length) opts[key] = argv[++i];
      else throw new UsageError(`${a} needs a value.`);
    } else args.push(a);
  }
  return { opts, args };
}

function writeBuilt(out, name, built) {
  keepBuilt(out, name, built);
  console.log(`✓ ${name}: ${built.map.places.length} places, ${built.markdown.length} characters (${built.ms} ms)`);
}

async function main(argv) {
  const { opts, args } = parse(argv);
  const [command, ...rest] = args;
  if (opts.help || !command) { console.log(USAGE); return command ? 0 : 2; }

  switch (command) {
    case 'plugin-setup': {
      const info = writeLocal(path.join(REPO, 'plugin', 'local.json'));
      console.log(`Wrote plugin/local.json: the plugin will start ${info.cli} with ${info.node}.`);
      console.log(`Install the plugin in ter-manager by pointing it at ${path.join(REPO, 'plugin')}.`);
      return 0;
    }
    case 'fabrics': {
      if (!rest[0]) throw new UsageError('fabrics needs the workspace folder.');
      for (const f of listFabrics(rest[0])) console.log(`${f.modified.slice(0, 10)}  ${f.name}`);
      return 0;
    }
    case 'build': {
      const folder = rest[0];
      if (!folder) throw new UsageError('build needs a fabric or workspace folder.');
      const dataDir = opts['data-dir'] || null;
      if (isFabric(folder)) {
        const built = buildFabric(folder, { dataDir });
        if (!opts.out) { process.stdout.write(built.markdown); return 0; }
        writeBuilt(opts.out, path.basename(path.resolve(folder)), built);
        return 0;
      }
      if (!opts.out) throw new UsageError('A whole workspace needs --out <dir> for its documents.');
      let failed = 0;
      for (const f of listFabrics(folder)) {
        try { writeBuilt(opts.out, f.name, buildFabric(f.dir, { dataDir })); } catch (e) { failed++; console.log(`✗ ${f.name}: ${e.message}`); }
      }
      return failed ? 1 : 0;
    }
    case 'read': {
      if (!rest[0] || !isFabric(rest[0])) throw new UsageError('read needs a fabric folder (one holding fabric.json).');
      if (!opts['data-dir']) throw new UsageError('Give the folder NoteX keeps readings in: --data-dir <folder>');
      const started = Date.now();
      let last = -1;
      const r = await readFabricImages(rest[0], {
        dataDir: opts['data-dir'], ragx: opts.ragx || null,
        onProgress: ({ done, total }) => { if (done !== last) { last = done; console.log(`  read ${done}/${total}`); } },
      });
      console.log(`${r.fabric}: ${r.images} images, ${r.toRead} to read, ${r.read} read in ${Math.round((Date.now() - started) / 1000)} s`
        + `${r.failed.length ? `, ${r.failed.length} failed` : ''}`);
      for (const f of r.failed) console.log(`  ✗ ${f.name}: ${f.error}`);
      if (r.stopped) console.log(`Stopped: ${r.stopped}`);
      return r.stopped || r.failed.length ? 1 : 0;
    }
    case 'serve': {
      if (!opts['data-dir']) throw new UsageError('Give the folder NoteX keeps its settings in: --data-dir <folder>');
      const s = await startServer({
        dataDir: opts['data-dir'],
        port: opts.port ? Number(opts.port) : undefined,
        origins: opts.origin ? opts.origin.split(',').map((o) => o.trim()) : undefined,
        ragx: opts.ragx || null,
        onStopped: () => process.exit(0),
      });
      console.log(`NoteX engine ready at ${s.url}`);
      console.log(`  data       ${s.dataDir}`);
      console.log(`  workspace  ${s.config().workspace || 'not set - set it on the NoteX page'}`);
      console.log('  Ctrl+C stops it; closing the plugin does not.');
      return null;
    }
    case 'drop': case 'drops': case 'forget': {
      if (!opts['data-dir']) throw new UsageError('Give the folder NoteX keeps the inbox in: --data-dir <folder>');
      const bronze = new Bronze(opts['data-dir']);
      const line = (d) => `${d.id}  ${d.landedAt.slice(0, 16).replace('T', ' ')}  ${d.kind.padEnd(5)}  ${d.status.padEnd(7)}  ${(d.canvas || '-').padEnd(14)}  ${d.name || '(typed text)'}`;
      if (command === 'drops') {
        const all = bronze.list();
        if (!all.length) console.log('The inbox is empty.');
        for (const d of all) console.log(line(d));
        return 0;
      }
      if (command === 'forget') {
        if (!rest[0]) throw new UsageError('forget needs the drop id (see drops).');
        const r = bronze.forget(rest[0]);
        console.log(`Forgot ${r.id}${r.blob === 'shared' ? '; its content stays for another drop of the same file' : ''}.`);
        return 0;
      }
      const common = { canvas: opts.canvas || null, note: opts.note || null, via: 'cli' };
      if (opts.text != null) { if (rest[0]) throw new UsageError('drop takes a file or --text, not both.'); console.log(line(bronze.land({ text: opts.text, ...common }))); return 0; }
      if (!rest[0]) throw new UsageError('drop needs a file, or --text "<words>".');
      console.log(line(bronze.land({ bytes: fs.readFileSync(rest[0]), name: rest[0], ...common })));
      return 0;
    }
    case 'render': case 'place': {
      if (command === 'render' && !rest[0]) throw new UsageError('render needs the agent canvas\'s name.');
      if (!opts['data-dir']) throw new UsageError('Give NoteX\'s data folder, which knows the workspace: --data-dir <folder>');
      let config = {};
      try { config = JSON.parse(fs.readFileSync(path.join(opts['data-dir'], 'config.json'), 'utf8')); } catch (_) { /* no workspace yet */ }
      const writer = new Writer({ config, dataDir: opts['data-dir'] });
      const bronze = new Bronze(opts['data-dir']);
      const agent = new AgentCanvases({ dataDir: opts['data-dir'], writer, bronze, log: (m) => console.log(m) });
      writer.agent = agent;
      if (command === 'place') {
        if (opts.model) config.placer = { ...(config.placer || {}), model: opts.model };
        const placer = new Placer({ config: { ...config, placing: true }, dataDir: opts['data-dir'], bronze, writer, log: (m) => console.log(m) });
        const d = placer.next();
        if (!d) { console.log('No drop is queued for a canvas assigned to the agent.'); return 0; }
        console.log(`Placing ${d.name || d.id} on ${d.canvas} with Claude (${(config.placer && config.placer.model) || 'sonnet'})...`);
        const r = await placer.place(d);
        console.log(r.status === 'placed' ? `Placed: ${r.entry.what}.` : `${r.status}${r.reason ? `: ${r.reason}` : ''}`);
        return r.status === 'placed' ? 0 : 1;
      }
      const r = agent.render(rest[0]);
      if (r === null) { console.log(`${rest[0]} changed while it was being drawn - run it again.`); return 1; }
      for (const t of r.totems) console.log(`${t.drawn === 'current' ? '✓' : t.drawn === 'good' ? '~' : '✗'} ${t.totem}${t.drawn === 'good' ? ' (from its last good script)' : t.drawn === 'none' ? ' (left out)' : ''}${t.errors.length ? ` - ${t.errors.join('; ')}` : ''}`);
      console.log(`${rest[0]}: ${r.written} items drawn; backup ${r.backup}`);
      return r.totems.some((t) => t.drawn === 'none') ? 1 : 0;
    }
    default:
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then((code) => { if (code !== null) process.exitCode = code; }, (e) => {
  if (e instanceof UsageError || e instanceof FabricError || e instanceof RagxError || e instanceof BronzeError || e instanceof Refusal) { console.error(e.message); process.exitCode = 2; return; }
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
