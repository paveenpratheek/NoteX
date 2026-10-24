#!/usr/bin/env node
/* The engine from a terminal.
 *
 *   node engine/cli.js <command> [...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { listFabrics, isFabric, FabricError } from './lib/fabric.js';
import { buildFabric, startServer } from './lib/server.js';
import { writeLocal, REPO } from './lib/lifecycle.js';

const USAGE = `usage: node engine/cli.js <command>

  build <folder> [--out <dir>]
                          a fabric (a folder holding fabric.json) or a whole
                          workspace as address documents and place maps;
                          one fabric with no --out prints its document
  fabrics <workspace>     the fabrics in a workspace, newest first
  serve --data-dir <folder> [--port 7781] [--origin <url,url>]
                          run as the plugin's server on 127.0.0.1 (Ctrl+C stops it)
  plugin-setup            once: tells the plugin where the engine is`;

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
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${name}.notex.md`), built.markdown);
  fs.writeFileSync(path.join(out, `${name}.places.json`), JSON.stringify(built.map, null, 2));
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
      if (isFabric(folder)) {
        const built = buildFabric(folder);
        if (!opts.out) { process.stdout.write(built.markdown); return 0; }
        writeBuilt(opts.out, path.basename(path.resolve(folder)), built);
        return 0;
      }
      if (!opts.out) throw new UsageError('A whole workspace needs --out <dir> for its documents.');
      let failed = 0;
      for (const f of listFabrics(folder)) {
        try { writeBuilt(opts.out, f.name, buildFabric(f.dir)); } catch (e) { failed++; console.log(`✗ ${f.name}: ${e.message}`); }
      }
      return failed ? 1 : 0;
    }
    case 'serve': {
      if (!opts['data-dir']) throw new UsageError('Give the folder NoteX keeps its settings in: --data-dir <folder>');
      const s = await startServer({
        dataDir: opts['data-dir'],
        port: opts.port ? Number(opts.port) : undefined,
        origins: opts.origin ? opts.origin.split(',').map((o) => o.trim()) : undefined,
        onStopped: () => process.exit(0),
      });
      console.log(`NoteX engine ready at ${s.url}`);
      console.log(`  data       ${s.dataDir}`);
      console.log(`  workspace  ${s.config().workspace || 'not set - set it on the NoteX page'}`);
      console.log('  Ctrl+C stops it; closing the plugin does not.');
      return null;
    }
    default:
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then((code) => { if (code !== null) process.exitCode = code; }, (e) => {
  if (e instanceof UsageError || e instanceof FabricError) { console.error(e.message); process.exitCode = 2; return; }
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
