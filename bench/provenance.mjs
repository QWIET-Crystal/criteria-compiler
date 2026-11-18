#!/usr/bin/env node
// 这份清单是从哪来的、按什么筛的。
//
// 一位使用者说，这句话比他拿到的三个工具加起来有用——他就是在这一句上栽的，
// 而且是他先栽的。所以它得是一条命令，不是文档里的一段话。
//
// Usage:
//   node bench/provenance.mjs --pack cof-h2o2
//   node bench/provenance.mjs --pack cof-h2o2 --json

import fs from 'node:fs';
import path from 'node:path';

import { describe, read, UNKNOWN } from './lib/provenance.mjs';
import { ROOT } from './lib/io.mjs';

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PACK_ARG = argValue('--pack', '');
if (!PACK_ARG) {
  console.error('用法：node bench/provenance.mjs --pack <包名> [--json]');
  process.exit(1);
}

const PACK_DIR = (() => {
  const asPath = path.resolve(PACK_ARG);
  if (fs.existsSync(path.join(asPath, 'provenance.json'))) return asPath;
  const under = path.join(ROOT, 'packs', PACK_ARG);
  return fs.existsSync(under) ? under : asPath;
})();

const data = read(PACK_DIR);
const entries = Object.entries(data.artifacts ?? {});

if (argv.includes('--json')) {
  console.log(JSON.stringify({ pack: data.pack ?? path.basename(PACK_DIR), artifacts: data.artifacts ?? {} }, null, 2));
  process.exit(0);
}

console.log(`\n来历与口径 · ${data.pack ?? path.basename(PACK_DIR)}`);
console.log('─'.repeat(78));

if (!entries.length) {
  console.log('  没有任何记录。');
  console.log(`  产物在 ${path.relative(ROOT, PACK_DIR)} 里没有 provenance.json ——`);
  console.log('  这意味着「这份清单从哪来、按什么筛的」现在只能靠人回忆。');
  console.log('  重跑一次 start / refine 就会写下来。');
  process.exit(0);
}

for (const [artifact, entry] of entries) {
  console.log(`\n▸ ${artifact}   （由 ${entry.tool ?? UNKNOWN} 生成）`);
  const lines = describe(entry) ?? [];
  if (!lines.length) console.log('  （记录是空的）');
  for (const line of lines) {
    for (const [index, piece] of line.split('\n').entries()) {
      console.log(index === 0 ? `  ${piece}` : `  ${piece}`);
    }
  }
}

console.log('');
console.log('─'.repeat(78));
console.log('  「找不到」和「没找」是两件事。上面每份产物的「明确没做」就是后者。');
