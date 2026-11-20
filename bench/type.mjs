#!/usr/bin/env node
// 给已判定为「算」的论文分型（A/B/C/D）。
//
// Usage:
//   node bench/type.mjs --pack cof-h2o2 [--works <题录快照>]
//
// 分型决定综述的章节骨架，所以本工具**只给建议和证据**，不写回 gold.csv。
// 人确认之后再手工改——这是「机器给证据、人下判断」在分型上的落地。

import fs from 'node:fs';
import path from 'node:path';

import { splitSentences, workText } from './lib/criteria.mjs';
import { parseCsv, worksFromCsv, loadWorks, readDraft, ROOT } from './lib/io.mjs';
import { TYPES, detectType } from './lib/types.mjs';

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
};

const packId = argValue('--pack');
if (!packId) {
  console.error('用法：node bench/type.mjs --pack <id> [--works <csv>]');
  process.exit(1);
}

const packDir = path.join(ROOT, 'packs', packId);
const gold = parseCsv(fs.readFileSync(path.join(packDir, 'gold.csv'), 'utf8'));
const positives = gold.filter((g) => String(g.label).trim() === '2');

const worksPath = argValue('--works');
let works;
if (worksPath) {
  works = worksFromCsv(path.resolve(worksPath));
} else {
  const missing = positives.filter((g) => !works); // 占位
  works = await loadWorks(positives.map((g) => g.doi));
  void missing;
}

console.log(`\n四型分型建议 · ${packId}`);
console.log('─'.repeat(78));
console.log('A 载流子耦合｜B H2O2 介导｜C H2O2→ROS｜D 附加/级联');
console.log('只给建议和证据，不写回 gold.csv——章节骨架得人定。');

let agree = 0;
let judged = 0;

for (const g of positives) {
  const doi = g.doi.trim().toLowerCase();
  const w = works.get(doi);
  console.log(`\n${'─'.repeat(78)}`);
  console.log(doi);

  if (!w) {
    console.log('  ⚠ 取不到题录，无法分型（这是数据缺口，不是「没有类型」）');
    continue;
  }

  const result = detectType(splitSentences(workText(w)));
  const goldType = (g.coupling_type ?? '').trim();
  judged++;
  if (result.type && goldType && result.type === goldType) agree++;

  const mark = result.type
    ? result.type === goldType ? '✓ 与标注一致' : `✗ 建议 ${result.type}，标注是 ${goldType || '空'}`
    : '— 摘要里没有分型依据';
  console.log(`  建议：${result.type ? `${result.type} ${TYPES[result.type].name}` : '（未定）'}   ${mark}`);
  console.log(`  置信：${result.confidence}   ${result.note}`);

  for (const [type, hits] of Object.entries(result.evidence)) {
    console.log(`  [${type}] ${TYPES[type].short}`);
    for (const h of hits.slice(0, 2)) console.log(`      · ${h.slice(0, 170)}`);
  }
}

console.log(`\n${'═'.repeat(78)}`);
console.log(`与 gold.csv 标注一致：${agree}/${judged}`);
console.log('不一致的不一定是工具错——先看证据句，再决定改哪边。');
