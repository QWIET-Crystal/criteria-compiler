#!/usr/bin/env node
// 「值得看一眼」的信号，哪些真的有信息量。
//
// Usage:
//   node bench/note-audit.mjs --pack cof-h2o2 \
//     --gold-works <金集题录> --pool-works <背景池题录>
//
// note 判据不改变判定，所以它不需要 lift 高。它需要的是「有信息量」：
// 如果 95% 的论文都有，那给 95% 都标一遍等于没标。
// 判据：阳性里出现 ≥2 篇，且池子里不到 60%。
//
// 包里已经装了哪些在 pack.json 的 noteTerms 里；这里测的是**候选**。

import fs from 'node:fs';
import path from 'node:path';

import { parseCsv, worksFromCsv, ROOT } from './lib/io.mjs';

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
};

const packId = argValue('--pack');
const goldWorksPath = argValue('--gold-works');
const poolWorksPath = argValue('--pool-works');

if (!packId || !poolWorksPath) {
  console.error('用法：node bench/note-audit.mjs --pack <id> --gold-works <csv> --pool-works <csv>');
  process.exit(1);
}

const packDir = path.join(ROOT, 'packs', packId);
const pack = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
const gold = parseCsv(fs.readFileSync(path.join(packDir, 'gold.csv'), 'utf8'));
const positives = gold.filter((g) => String(g.label).trim() === '2');

const goldWorks = goldWorksPath ? worksFromCsv(path.resolve(goldWorksPath)) : new Map();
const poolWorks = worksFromCsv(path.resolve(poolWorksPath));

// 候选信号：读这一篇之前该知道的事。
// 这些是领域惯例的候选，**不是**从数据里长出来的——所以必须实测，不能直接装。
const CANDIDATES = [
  { id: 'in-situ', label: '原位 / operando 表征', re: /\b(in[-\s]?situ|operando|on[-\s]?line)\b/i },
  { id: 'isotope', label: '同位素标记', re: /\b(18\s*O|D\s*2\s*O|13\s*C|isotop\w*\s+label\w*|isotopic)\b/i },
  { id: 'aqy', label: '量子产率 / 转化数', re: /\b(apparent quantum (yield|efficiency)|AQY|turnover number|TON|TOF)\b/i },
  { id: 'dft', label: 'DFT / 理论计算', re: /\b(DFT|density functional|first[-\s]?principles?|theoretical calculation)\b/i },
  { id: 'triphase', label: '三相 / 界面工程', re: /\b(tri[-\s]?phase|three[-\s]?phase|gas[-\s]?liquid[-\s]?solid|self[-\s]?float\w*|air[-\s]?water interface)\b/i },
  { id: 'quench', label: '自由基捕获 / 淬灭实验', re: /\b(radical (trapping|scaveng\w*|quench\w*)|scavenger (test|experiment)|quench\w* experiment)\b/i },
  { id: 'recycle', label: '循环稳定性', re: /\b(recycl\w+|reusab\w+|stability (test|over \d+ cycles)|cycling)\b/i },
  { id: 'flow', label: '流动 / 放大反应器', re: /\b(flow reactor|continuous[- ]flow|scale[-\s]?up|pilot)\b/i },
  { id: 'quant', label: '定量产率数据', re: /(\d\s*(mmol|μmol|umol)\s*g|mmol\s*g\s*[-–]?\s*1|yield of \d+%)/i },
];

const textOf = (w) => `${w.title ?? ''} ${w.abstract ?? ''}`;
const posTexts = positives
  .map((g) => goldWorks.get(String(g.doi).trim().toLowerCase()))
  .filter(Boolean)
  .map(textOf);
const poolTexts = [...poolWorks.values()].map(textOf);

const installed = new Set((pack.noteTerms ?? []).map((t) => t.id));

console.log(`\n提示信号审计 · ${packId}`);
console.log('─'.repeat(68));
console.log(`阳性 ${posTexts.length} 篇（有题录的）｜背景池 ${poolTexts.length} 篇`);
if (posTexts.length < 10) {
  console.log(`⚠ 阳性只有 ${posTexts.length} 篇。0/N 更可能是样本不足，不是这个信号没价值——别拿它定词表。`);
}
console.log('');
console.log('信号'.padEnd(24), '阳性', '池子', '判定');
console.log('─'.repeat(68));

const useful = [];
for (const c of CANDIDATES) {
  const p = posTexts.filter((t) => c.re.test(t)).length;
  const q = poolTexts.filter((t) => c.re.test(t)).length;
  const pct = (q / poolTexts.length) * 100;
  const ok = p >= 2 && pct < 60;
  if (ok) useful.push(c.id);
  const verdict = ok ? (installed.has(c.id) ? '✓ 已装' : '· 够格，未装') : (p < 2 ? '阳性里太少' : '太普遍');
  console.log(c.label.padEnd(24), `${p}/${posTexts.length}`.padEnd(6), `${q}/${poolTexts.length}`.padEnd(6), verdict);
}

console.log('');
const missing = useful.filter((id) => !installed.has(id));
if (missing.length) {
  console.log(`够格但没装的：${missing.join('、')}`);
  console.log('装之前先想清楚该提示人什么——「出现 N 处」不构成理由。');
} else {
  console.log('够格的都已装进 pack。');
}
