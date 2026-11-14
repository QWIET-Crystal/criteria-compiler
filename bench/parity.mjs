#!/usr/bin/env node
/**
 * Guard against drift between the two implementations.
 *
 * The benchmark runner (bench/run.mjs) and the library
 * (packages/core/src/profiles/families.ts) must embed exactly the same retrieval
 * queries. If they diverge, the README numbers stop matching what the library
 * produces, and nobody notices until someone reruns the benchmark.
 *
 * This is a source-level check on purpose: it needs no build, no install, no network.
 * It is a stopgap until the queries live in one shared data file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function readObjectLiteral(text, needle) {
  const i = text.indexOf(needle);
  if (i < 0) return null;
  const start = text.indexOf('{', i);
  const open = text.indexOf('[', i);
  // Allow arrays too (bench keeps fixes in an array).
  const from = start < 0 ? open : open < 0 ? start : Math.min(start, open);
  if (from < 0) return null;
  const openChar = text[from];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  for (let j = from; j < text.length; j++) {
    if (text[j] === openChar) depth++;
    else if (text[j] === closeChar) {
      depth--;
      if (depth === 0) return text.slice(from, j + 1);
    }
  }
  return null;
}

function stringLiterals(literal) {
  // Comments may contain example strings (e.g. the space-rendered formula); they are
  // documentation, not queries, so they must not count as drift.
  const code = literal
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const out = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(code))) {
    const value = (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1');
    out.push(value.replace(/\s+/g, ' ').trim());
  }
  return out;
}

function collect(file, specs) {
  const text = fs.readFileSync(file, 'utf8');
  const values = [];
  for (const needle of specs) {
    const literal = readObjectLiteral(text, needle);
    if (!literal) throw new Error(`${path.relative(ROOT, file)}: could not find ${needle}`);
    values.push(...stringLiterals(literal));
  }
  return values.sort();
}

const benchFile = path.join(ROOT, 'bench', 'run.mjs');
const coreFile = path.join(ROOT, 'packages', 'core', 'src', 'profiles', 'families.ts');

const bench = collect(benchFile, ['const FAMILIES =', 'const EXTRA =']);
const core = collect(coreFile, ['export const FAMILIES =', 'export const FIX_QUERIES =']);

const onlyBench = bench.filter((v) => !core.includes(v));
const onlyCore = core.filter((v) => !bench.includes(v));

if (onlyBench.length || onlyCore.length) {
  console.error('query drift detected between bench/run.mjs and packages/core:\n');
  if (onlyBench.length) {
    console.error('  only in bench/run.mjs:');
    for (const v of onlyBench) console.error(`    - ${v}`);
  }
  if (onlyCore.length) {
    console.error('  only in packages/core:');
    for (const v of onlyCore) console.error(`    - ${v}`);
  }
  console.error('\nUpdate both files, or move the queries into one shared data file.');
  process.exit(1);
}

console.log(`parity ok: ${bench.length} query literals identical across bench and core`);
