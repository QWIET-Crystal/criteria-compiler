#!/usr/bin/env node
// 审计 core-any 的词：哪些真在区分，哪些只是这个领域的常识。
//
// Usage:
//   node bench/term-audit.mjs \
//     --draft packs/_x/draft.json \
//     --gold  packs/cof-h2o2/gold.csv \
//     --gold-works <题录快照: 金集> \
//     --pool-works <题录快照: 背景池>
//
// 背景池必须是**与候选词无关**的那种（例如按对象词取的题录快照）。
// 拿「命中任一候选词」的池子当分母会失真——实测 photosynthesis 在有偏池子里
// lift 算成 31.9，在无关池子里是 0.93。分母错了，结论会整个反过来。

import fs from 'node:fs';
import path from 'node:path';

import { parseCsv, worksFromCsv } from './lib/io.mjs';

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : '';
};

const draftPath = argValue('--draft');
const goldPath = argValue('--gold');
const goldWorksPath = argValue('--gold-works');
const poolWorksPath = argValue('--pool-works');

for (const [name, value] of [
  ['--draft', draftPath],
  ['--gold', goldPath],
  ['--gold-works', goldWorksPath],
  ['--pool-works', poolWorksPath],
]) {
  if (!value) {
    console.error('用法：node bench/term-audit.mjs --draft <draft.json> --gold <gold.csv> --gold-works <csv> --pool-works <csv>');
    console.error(`缺 ${name}`);
    process.exit(1);
  }
}

const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
const core = (draft.criteria ?? []).find((c) => c.id === 'core-any');
const terms = core ? (core.terms ?? []) : [];

const gold = parseCsv(fs.readFileSync(goldPath, 'utf8'));
const positives = gold.filter((g) => String(g.label).trim() === '2');
const goldWorks = worksFromCsv(goldWorksPath);
const poolWorks = worksFromCsv(poolWorksPath);

const textOf = (w) => `${w.title ?? ''} ${w.abstract ?? ''}`.toLowerCase();

// 与求值器同一套词边界规则，避免 synthesis 匹配进 photosynthesis。
function has(text, term) {
  const raw = String(term);
  const lead = /^[A-Za-z]/.test(raw) ? '(?<![A-Za-z0-9])' : '';
  const tail = /[A-Za-z0-9]$/.test(raw) ? '(?![A-Za-z0-9])' : '';
  return new RegExp(`${lead}${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${tail}`, 'i').test(text);
}

const posTexts = positives.map((g) => goldWorks.get(String(g.doi).trim().toLowerCase())).filter(Boolean).map(textOf);
const poolTexts = [...poolWorks.values()].map(textOf);

if (!posTexts.length) {
  console.error('金集里没有能取到摘要的阳性，无法计算覆盖率。');
  process.exit(1);
}

console.log(`\n区分词审计 · ${path.basename(draftPath)}`);
console.log('─'.repeat(62));
console.log(`阳性 ${posTexts.length} 篇（有摘要的）｜背景池 ${poolTexts.length} 篇`);
console.log('');
console.log('词'.padEnd(20), '阳性命中'.padEnd(10), '池子占比'.padEnd(10), 'lift');
console.log('─'.repeat(62));

const rows = terms
  .map((term) => {
    const p = posTexts.filter((t) => has(t, term)).length / posTexts.length;
    const q = poolTexts.filter((t) => has(t, term)).length / poolTexts.length;
    return { term, p, q, lift: q > 0 ? p / q : (p > 0 ? Infinity : 0) };
  })
  .sort((a, b) => b.lift - a.lift);

for (const r of rows) {
  const lift = r.lift === Infinity ? '∞' : r.lift.toFixed(2);
  const flag = r.lift !== Infinity && r.lift < 1.5 ? '   ← 不区分' : '';
  console.log(
    r.term.padEnd(20),
    `${(r.p * 100).toFixed(0)}%`.padEnd(10),
    `${(r.q * 100).toFixed(0)}%`.padEnd(10),
    `${lift}${flag}`,
  );
}

const weak = rows.filter((r) => r.lift !== Infinity && r.lift < 1.5);
console.log('');
if (weak.length) {
  console.log(`lift < 1.5 的 ${weak.length} 个：${weak.map((r) => r.term).join('、')}`);
  console.log('这些词在阳性和背景里差不多常见——它们不是判据，是这个领域的常识。');
  console.log('删不删由人定：脚本只给数，概念得由了解这个领域的人来定。');
} else {
  console.log('全部词的 lift 都 ≥ 1.5，没有明显的常识词。');
}
