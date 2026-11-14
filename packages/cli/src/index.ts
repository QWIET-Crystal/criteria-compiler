#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  FAMILIES,
  familyQuery,
  searchWorks,
  type FamilyName,
} from '@criteria-compiler/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function usage(): void {
  console.log(`criteria-compiler <command> [options]

Commands
  bench                     run the reproducible benchmark (needs network)
  search <query>            run one raw OpenAlex title+abstract query
  families                  print the six material-family queries
  help                      show this message

Options
  --json                    machine-readable output
  --mailto <email>          OpenAlex polite-pool contact
  --limit <n>               max records for 'search' (default 20)

Examples
  criteria-compiler bench
  criteria-compiler search '("covalent organic framework") AND ("hydrogen peroxide")'
  criteria-compiler families --json
`);
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

  if (!command || command === 'help' || command === '--help') {
    usage();
    return 0;
  }

  if (command === 'bench') {
    return runBench(argv.slice(1));
  }

  if (command === 'families') {
    const entries = Object.entries(FAMILIES) as [FamilyName, string][];
    if (json) {
      console.log(JSON.stringify({ families: Object.fromEntries(entries.map(([k]) => [k, familyQuery(k)])) }, null, 2));
      return 0;
    }
    for (const [name] of entries) console.log(`${name}\t${familyQuery(name)}`);
    return 0;
  }

  if (command === 'search') {
    const query = argv[1];
    if (!query) {
      console.error('search needs a query');
      return 2;
    }
    const limitIndex = argv.indexOf('--limit');
    const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) || 20 : 20;
    const mailtoIndex = argv.indexOf('--mailto');
    const mailto = mailtoIndex >= 0 ? argv[mailtoIndex + 1] : process.env.OPENALEX_MAILTO;
    const apiKeyIndex = argv.indexOf('--api-key');
    const apiKey = apiKeyIndex >= 0 ? argv[apiKeyIndex + 1] : process.env.OPENALEX_API_KEY;
    const works = await searchWorks(query, 1, Math.min(limit, 200), mailto, apiKey);
    if (json) console.log(JSON.stringify(works, null, 2));
    else for (const w of works) console.log(`${w.year ?? '----'}\t${w.doi || '(no doi)'}\t${w.title}`);
    return 0;
  }

  console.error(`unknown command: ${command}`);
  usage();
  return 2;
}

main().then((code) => process.exit(code)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
