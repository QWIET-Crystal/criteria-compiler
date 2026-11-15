#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defaultPackDir, loadPackFromDir, searchWorks, slotsOf, stagesOf } from '@criteria-compiler/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function usage(): void {
  console.log(`criteria-compiler <command> [options]

Commands
  bench [opts]              run the benchmark of a pack (needs network)
  search <query>            run one raw OpenAlex title+abstract query
  pack                      show the pack currently in use
  help                      this message

Global
  --pack <dir>              pack directory (default: $CRITERIA_PACK_DIR, else packs/default.json)
  --json                    machine-readable output
  --api-key <key>           OpenAlex key (default: $OPENALEX_API_KEY)
  --mailto <email>          OpenAlex contact (default: $OPENALEX_MAILTO)

Examples
  criteria-compiler pack
  criteria-compiler bench --stage A
  criteria-compiler bench --pack packs/cv-finance-esg --stage B
  criteria-compiler search '("some phrase") AND ("another phrase")'
`);
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}

function runBench(args: string[]): Promise<number> {
  const script = path.join(REPO_ROOT, 'bench', 'run.mjs');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const command = argv[0];
  const packDir = argValue(argv, '--pack');

  if (!command || command === 'help' || command === '--help') {
    usage();
    return 0;
  }

  if (command === 'bench') {
    return runBench(argv.slice(1));
  }

  if (command === 'pack') {
    const dir = packDir ?? defaultPackDir();
    const pack = loadPackFromDir(dir);
    const stages = stagesOf(pack);
    const slots = slotsOf(pack);
    if (json) {
      console.log(JSON.stringify({ dir, id: pack.id, title: pack.title, slots, stages }, null, 2));
      return 0;
    }
    console.log(`pack: ${pack.id}  ${pack.title ?? ''}`);
    console.log(`dir:  ${dir}`);
    console.log(`gold: ${pack.gold ?? '(none — retrieval-only)'}`);
    console.log('\nslots (ANDed):');
    for (const s of slots) console.log(`  ${s.id.padEnd(12)} ${s.terms.length} terms`);
    console.log('\ndimensions (queried separately, then unioned):');
    for (const d of pack.dimensions) console.log(`  ${d.id.padEnd(12)} ${d.scope ?? '-'.padEnd(8)} ${d.terms.length} terms`);
    console.log('\nstages:');
    for (const s of stages) console.log(`  ${s.id}  ${s.label}  (${s.queries.length} queries${s.doiFallback ? ', DOI fallback' : ''})`);
    return 0;
  }

  if (command === 'search') {
    const query = argv[1];
    if (!query) {
      console.error('search needs a query');
      return 2;
    }
    const limit = Number(argValue(argv, '--limit') ?? 20) || 20;
    const mailto = argValue(argv, '--mailto') ?? process.env.OPENALEX_MAILTO;
    const apiKey = argValue(argv, '--api-key') ?? process.env.OPENALEX_API_KEY;
    const works = await searchWorks(query, 1, Math.min(limit, 200), mailto, apiKey);
    if (json) console.log(JSON.stringify(works, null, 2));
    else for (const w of works) console.log(`${w.year ?? '----'}\t${w.doi || '(no doi)'}\t${w.title}`);
    return 0;
  }

  console.error(`unknown command: ${command}`);
  usage();
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
