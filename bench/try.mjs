#!/usr/bin/env node
// 试判据：改完 draft.json，立刻看它抓到什么、漏了什么、凭什么。
//
// 这条命令是整个学生版里最该常用的那一条。它只读、不写、不改任何东西——
// 因为「人给概念」的前提是改动足够便宜：改一条判据，一眼看到它在已知样本上的后果。
//
// 每一处判断都附**原文片段**。给不出原文的判据不许存在，这条在执行层也是这样。
//
// Usage:
//   node bench/try.mjs --pack _co
//   node bench/try.mjs --pack _co --draft packs/_co/draft-v3.json
//   node bench/try.mjs --pack _co --only-wrong     # 只看判据和人打架的

import fs from 'node:fs';
import path from 'node:path';

import { evaluate } from './lib/criteria.mjs';
import { labelOf, loadWorks, normalizeDoi, readDraft, readQueue, ROOT } from './lib/io.mjs';

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PACK_ARG = argValue('--pack', '');
if (!PACK_ARG) {
  console.error('用法：node bench/try.mjs --pack <包名> [--draft <文件>] [--only-wrong]');
  process.exit(1);
}
const PACK_DIR = (() => {
  const asPath = path.resolve(PACK_ARG);
  if (fs.existsSync(path.join(asPath, 'draft.json'))) return asPath;
  const under = path.join(ROOT, 'packs', PACK_ARG);
  return fs.existsSync(under) ? under : asPath;
})();
const ONLY_WRONG = argv.includes('--only-wrong');

const draft = readDraft(PACK_DIR, argValue('--draft', ''));
if (!draft) {
  console.error(`\n${path.relative(ROOT, PACK_DIR)} 下没有 draft.json。先用 start.mjs 起草。\n`);
  process.exit(1);
}
const queue = readQueue(PACK_DIR, argValue('--queue', ''));

const criteria = draft.data.criteria ?? [];
if (!criteria.length) {
  console.error('\n这份草案没有结构化 criteria（还是旧版按词频判的）。重新跑一次 start.mjs。\n');
  process.exit(1);
}

/** 判定规则与 refine.mjs 保持一致：踩到排除信号直接不算；否则至少两条正向判据同时中。 */
function decide(text) {
  const results = evaluate(criteria, text);
  const exclusion = results.find((r) => r.kind === 'absent');
  const violated = exclusion && !exclusion.matched;
  const positive = results.filter((r) => r.kind !== 'absent' && r.matched);
  const coOccur = results.filter((r) => r.kind === 'co-occur');
  // 有共现判据时，以共现为准——它就是「两个说法必须撞在一起」这条强信号。
  // 没有共现判据（草案还停在词表阶段）才退回 any。
  const said = coOccur.length ? coOccur.some((r) => r.matched) : positive.length > 0;
  return { verdict: violated ? '不算' : said ? '算' : '不算', results, violated, positive };
}

async function main() {
  const rows = queue?.rows ?? [];
  const works = await loadWorks(rows.map((row) => row.doi));
  const textOf = (doi) => {
    const work = works.get(normalizeDoi(doi));
    return work ? `${work.title} ${work.abstract}` : '';
  };

  console.log(`\n试判据 · ${path.relative(ROOT, draft.file)}`);
  console.log('─'.repeat(78));
  console.log(`判据 ${criteria.length} 条：${criteria.map((c) => `${c.id}(${c.kind})`).join('、')}`);
  console.log('规则：踩到排除信号 → 不算；否则有共现判据就以共现为准，没有才退回 any。');

  // ── 有标注的部分：真正的检验 ──────────────────────────────────────────────
  const labeled = rows.filter((row) => labelOf(row) !== null);
  if (labeled.length) {
    let tp = 0;
    let tn = 0;
    let fp = 0;
    let fn = 0;
    const wrong = [];

    for (const row of labeled) {
      const label = labelOf(row);
      if (label === 1) continue;
      const decided = decide(textOf(row.doi));
      const said = label === 2;

      // 正常判据说算 = 不算（缺判据）
      if (said && decided.verdict === '算') tp++;
      else if (!said && decided.verdict === '不算') tn++;
      else if (!said && decided.verdict === '算') { fp++; wrong.push({ row, decided, said, kind: '误判为算' }); }
      else { fn++; wrong.push({ row, decided, said, kind: '该算却漏' }); }
    }

    const positives = tp + fn;
    console.log('');
    console.log(`已标注 ${tp + tn + fp + fn} 篇（说不好 ${labeled.filter((r) => labelOf(r) === 1).length} 篇不计）`);
    console.log(`  你说算、判据也说算：${tp}/${positives}${positives ? `（召回 ${Math.round((tp / positives) * 100)}%）` : ''}`);
    console.log(`  你说不算、判据也说不算：${tn}`);
    console.log(`  你判不算、判据说算：${fp}（误报）`);
    console.log(`  你判算、判据说漏：${fn}（漏判）`);
    if (positives < 3) {
      console.log(`  ⚠️ 只有 ${positives} 篇正例，上面这些比例不可信——全判「不算」也能很好看。`);
    }

    if (wrong.length) {
      console.log('');
      console.log('判据和人打架的（附原文，方便直接改）');
      console.log('─'.repeat(78));
      for (const item of wrong) {
        console.log(`  [${item.kind}] ${item.row.doi}`);
        console.log(`    ${(item.row.title ?? '').slice(0, 90)}`);
        if (item.decided.violated) {
          const ev = item.decided.results.find((r) => r.kind === 'absent' && !r.matched)?.evidence[0];
          if (ev) console.log(`    踩到排除信号：「${ev.quote}」`);
        }
        for (const result of item.decided.positive) {
          const quotes = result.evidence.map((e) => `「${e.quote}」`).join(' 与 ');
          console.log(`    命中 ${result.id}（${result.kind}）：${quotes || result.reason}`);
        }
        console.log('');
      }
    } else if (!ONLY_WRONG) {
      console.log('\n  这批标注和判据完全一致。');
    }
  } else {
    console.log('\n还没有标注。下面只列判据在各篇上的说法，不判对错。');
  }

  // ── 没标注的部分：判据现在怎么说 ──────────────────────────────────────────
  const unlabeled = rows.filter((row) => labelOf(row) === null);
  if (unlabeled.length) {
    const tally = { 算: 0, 不算: 0 };
    const positives = [];
    for (const row of unlabeled) {
      const decided = decide(textOf(row.doi));
      tally[decided.verdict]++;
      if (decided.verdict === '算') positives.push({ row, decided });
    }
    console.log('');
    console.log(`未标注 ${unlabeled.length} 篇：判据说算 ${tally['算']} 篇，说不算 ${tally['不算']} 篇`);

    if (!ONLY_WRONG) {
      for (const item of positives.slice(0, 8)) {
        const co = item.decided.results.find((r) => r.kind === 'co-occur' && r.matched);
        console.log(`  · ${item.row.doi}  ${(item.row.title ?? '').slice(0, 70)}`);
        if (co) console.log(`      共现证据：${co.evidence.map((e) => `「${e.quote}」`).join(' 与 ')}`);
      }
      if (positives.length > 8) console.log(`  …还有 ${positives.length - 8} 篇`);
    }
  }

  console.log('\n这条命令只读。要改判据，直接编辑 draft.json 里的 criteria，再跑一遍。');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
