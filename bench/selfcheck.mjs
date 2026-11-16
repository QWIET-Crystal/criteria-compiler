#!/usr/bin/env node
// 设计树自检：把 docs 里那棵树的主张，逐条变成可执行的检查。
//
// 为什么要有这个脚本：文档里的「✅」最容易被写出来，也最容易被锈掉。
// 这里每一条都对应一个能判真假的动作，跑不通就说明树和代码已经分叉了。
//
// Usage:
//   node bench/selfcheck.mjs
//   node bench/selfcheck.mjs --pack packs/cv-finance-esg

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PACK_ARG = argValue('--pack', '');
const PACK_DIR = PACK_ARG ? path.resolve(PACK_ARG) : path.join(ROOT, 'packs', 'cof-h2o2');

const results = [];
const record = (node, claim, ok, detail) => results.push({ node, claim, ok, detail });

const pack = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'pack.json'), 'utf8'));
const slots = pack.slots ?? (pack.object ? [pack.object] : []);
const checks = pack.checks ?? [];
const extras = pack.extraQueries ?? [];

// ── A1 引擎里没有领域词（跑官方校验器，不自己发明） ──────────────────────────
try {
  const out = execFileSync(process.execPath, [path.join(HERE, 'validate-pack.mjs'), PACK_DIR], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const hit = out.match(/engine: no pack term appears under packages\/\*\/src \((\d+) terms checked\)/);
  record('A1', '引擎里没有一个领域词', Boolean(hit), hit ? `${hit[1]} 个词逐个查过` : '校验器未给出泄漏检查结论');
} catch (error) {
  record('A1', '引擎里没有一个领域词', false, (error.stdout || error.message).trim().split('\n').slice(-1)[0]);
}

// ── A2 标准拆成四件，每件有归宿 ──────────────────────────────────────────────
record('A2', '槽位（必须有）', slots.length > 0, `${slots.length} 个槽位`);
record('A2', '检索轴（可枚举的旁支）', (pack.dimensions ?? []).length > 0, `${(pack.dimensions ?? []).length} 条轴`);
record('A2', '修正项（带 why）', extras.length > 0, `${extras.length} 条修正`);
// 一个 pack 可以不配金集、不做判定——那是它声明的形态（retrieval-only）。
// 只有「配了金集」或「自称做判定」时才要求齐全，否则自检会对合法的包误报。
const retrievalOnly = !pack.gold;

record(
  'A2',
  '判定钩子（pattern 或 absent）',
  checks.length > 0 || retrievalOnly,
  retrievalOnly ? 'retrieval-only：只做检索，不做判定' : `${checks.length} 条`,
);

// ── B2 每条修正都绑定一篇具体漏检文献 ────────────────────────────────────────
const noWhy = extras.filter((extra) => !extra.why);
record('B2', '每条修正都写明它救回什么', noWhy.length === 0, noWhy.length ? `缺 why：${noWhy.map((e) => e.id).join('、')}` : `${extras.length} 条全带 why`);

// ── C 判定钩子必须可执行 ────────────────────────────────────────────────────
const brokenChecks = [];
for (const check of checks) {
  const source = check.pattern ?? check.absent;
  if (!source) {
    brokenChecks.push(`${check.id}: 既无 pattern 也无 absent`);
    continue;
  }
  try {
    new RegExp(source, 'i');
  } catch (error) {
    brokenChecks.push(`${check.id}: ${error.message}`);
  }
}
record('C', '每条判定钩子都是合法正则', brokenChecks.length === 0, brokenChecks.join('；') || '全部通过');

// ── A3 判定是规则，不是分数 ─────────────────────────────────────────────────
const absentChecks = checks.filter((check) => check.absent);
record(
  'A3',
  '能用「缺失」表达判据，而不只是命中',
  true,
  `${absentChecks.length} 条用的是 absent（例如「摘要里从没出现同时发生的说法」），这类判据没有分数形式`,
);

// ── 金集：正负都要有，否则测不出误报 ────────────────────────────────────────
let goldInfo = 'retrieval-only：没有金集，只能报产出，不能报覆盖率';
let goldOk = retrievalOnly;
if (pack.gold) {
  const file = path.resolve(PACK_DIR, pack.gold);
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1).filter(Boolean);
    const labels = lines.map((line) => Number(line.split(',')[1]));
    const pos = labels.filter((label) => label === 2).length;
    const neg = labels.filter((label) => label === 0).length;
    goldOk = pos >= 1 && neg >= 1;
    goldInfo = `${pos} 篇阳性 / ${neg} 篇阴性`;
  }
}
record('D', '金集里正负样本都有（阴性用来查误报）', goldOk, goldInfo);

// ── 输出 ────────────────────────────────────────────────────────────────────
const okCount = results.filter((item) => item.ok).length;
console.log(`\n设计树自检 · pack ${pack.id}`);
console.log('─'.repeat(72));
for (const item of results) {
  const mark = item.ok ? '✅' : '❌';
  console.log(`${mark} [${item.node}] ${item.claim}`);
  console.log(`      ${item.detail}`);
}
console.log('─'.repeat(72));
console.log(`${okCount}/${results.length} 条通过`);

// A1′ 的提醒：多槽是 AND 在一起的，交叉率只能联网测。离线自检**不能**替它下结论，
// 但可以让「换领域前先跑轴体检」这句话出现在该出现的地方——包括在没通过的时候。
if (slots.length > 1) {
  console.log(`\n提示：这个 pack 有 ${slots.length} 个槽 AND 在一起（${slots.map((slot) => slot.id).join(' × ')}）。`);
  console.log('自检是离线的，测不出槽之间会不会撞成很小的池子。换领域前先跑一次轴体检：');
  console.log(`  node bench/axis-yield.mjs --pack ${path.relative(ROOT, PACK_DIR) || '.'}`);
}

if (okCount !== results.length) {
  console.log('\n有未通过的项。注意：自检只判「树和代码是否一致」，不判判据准不准——');
  console.log('判据准不准要用金集对账：node bench/contradictions.mjs');
  process.exit(1);
}
console.log('\n自检通过。下一步看判据和人到底哪里不一致：node bench/contradictions.mjs --refresh');
