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

import { decide as decideRule, workText } from './lib/criteria.mjs';
import { labelOf, loadWorks, normalizeDoi, readDraft, readQueue, ROOT, worksFromCsv } from './lib/io.mjs';
import { describeDiff } from './lib/history.mjs';

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
const EXPLAIN = argv.includes('--explain');

const draft = readDraft(PACK_DIR, argValue('--draft', ''));
if (!draft) {
  console.error(`\n${path.relative(ROOT, PACK_DIR)} 下没有 draft.json。先用 start.mjs 起草。\n`);
  process.exit(1);
}
const queue = readQueue(PACK_DIR, argValue('--queue', ''));

// --history：只看这份草案的来路。改过什么、谁改的、为什么。
if (argv.includes('--history')) {
  const history = draft.data.history ?? [];
  console.log(`\n判据变更史 · ${path.relative(ROOT, draft.file)}`);
  console.log('─'.repeat(78));
  if (!history.length) {
    console.log('  这份草案没有变更记录（早于 2026-11-18 的版本）。');
    console.log('  没有记录的变化等于耍赖：过两周没人说得清「当时为什么这么定」。');
    process.exit(0);
  }
  for (const entry of history) {
    const at = String(entry.at ?? '').replace('T', ' ').slice(0, 16);
    console.log(`  v${entry.version}  ${at}  ${String(entry.by).padEnd(10)} ${entry.what}`);
    if (entry.diff && !entry.diff.initial) {
      const detail = describeDiff(entry.diff);
      if (detail && detail !== entry.what) console.log(`       ${detail}`);
    }
    if (entry.why) console.log(`       理由：${entry.why}`);
  }
  console.log('');
  console.log('  每一条都对应一次真实的改动。人改的和机器改的分开记，不混在一起。');
  process.exit(0);
}

const criteria = draft.data.criteria ?? [];
if (!criteria.length) {
  console.error('\n这份草案没有结构化 criteria（还是旧版按词频判的）。重新跑一次 start.mjs。\n');
  process.exit(1);
}

/** 判定规则与 refine.mjs 保持一致：踩到排除信号直接不算；否则至少两条正向判据同时中。 */
// 判定规则在 lib/criteria.mjs 里只有一份（decide），这里不再重写。
function decide(text, parts = {}) {
  return decideRule(criteria, text, parts);
}

async function main() {
  const rows = queue?.rows ?? [];
  // 有 --works 就用本地题录，完全离线、结果可复现。
  const worksPath = argValue('--works', '');
  const works = worksPath ? worksFromCsv(worksPath) : await loadWorks(rows.map((row) => row.doi));
  const workOf = (doi) => works.get(normalizeDoi(doi));
  // 标题与摘要之间必须有句号，否则会黏成一句、产生假共现（见 criteria.workText）。
  const textOf = (doi) => {
    const work = workOf(doi);
    return work ? workText(work) : '';
  };
  // 作用域判据（比如「只在标题里找共现」）需要原文的两段分开传。
  const partsOf = (doi) => {
    const work = workOf(doi);
    return work ? { title: work.title, abstract: work.abstract } : {};
  };

  // 取不到题录时**绝不能安静地继续**：判据一条都不会命中，输出会变成
  // 「判据说 0 篇算」——看起来像结论，其实是没数据。
  const noText = rows.filter((row) => !textOf(row.doi).trim());
  if (noText.length) {
    console.log('');
    console.log(`⚠️ ${noText.length}/${rows.length} 篇取不到题录或摘要。`);
    if (noText.length === rows.length) {
      console.log('   全部取不到——下面的判断没有任何意义。');
      console.log('   OpenAlex 免费额度按 IP 共享，用完了要等 UTC 零点重置；');
      console.log('   或者设 OPENALEX_API_KEY / 换一个网络。');
      process.exit(2);
    }
    console.log('   这些论文的「不命中」不代表判据说它不算，只代表没数据。');
  }

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
      const decided = decide(textOf(row.doi), partsOf(row.doi));
      const said = label === 2;

      // 正常判据说算 = 不算（缺判据）
      if (said && decided.verdict !== '不算') tp++;
      else if (!said && decided.verdict === '不算') tn++;
      else if (!said && decided.verdict !== '不算') { fp++; wrong.push({ row, decided, said, kind: decided.verdict === '算' ? '误判为算' : '误判为疑似' }); }
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

  // ── 分类视图 ──────────────────────────────────────────────────────────────
  // 综述要的不是「算 / 不算」，是「算，而且属于哪一部分」。
  // 判据本来就是分类器——按「哪几条判据一起命中」分组，分类就是从判据里长出来的，
  // 不需要另外再问用户一遍「你要分几类」。
  if (EXPLAIN) {
    const groups = new Map();
    for (const row of rows) {
      const decided = decide(textOf(row.doi), partsOf(row.doi));
      const fired = decided.results
        .filter((r) => r.kind !== 'absent' && r.matched)
        .map((r) => r.id)
        .sort();
      if (!fired.length) continue;
      const key = fired.join(' + ');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    console.log('');
    console.log(`分类视图 · ${rows.length} 篇按命中组合归类，共 ${ordered.length} 类`);
    console.log('─'.repeat(78));
    ordered.forEach(([key, members], index) => {
      const ids = key.split(' + ');
      console.log(`  ${String.fromCharCode(65 + (index % 26))}. ${members.length} 篇  ← 同时命中 ${ids.join('、')}`);
      for (const id of ids) {
        const criterion = criteria.find((c) => c.id === id);
        if (criterion?.kind === 'co-occur') console.log(`       「${criterion.terms.join('」与「')}」同句出现`);
        else if (criterion?.kind === 'any') console.log(`       ${criterion.terms.slice(0, 4).join('、')}… 任一出现`);
      }
      for (const row of members.slice(0, 3)) console.log(`       · ${row.doi}  ${(row.title ?? '').slice(0, 60)}`);
      if (members.length > 3) console.log(`       …还有 ${members.length - 3} 篇`);
      console.log('');
    });
    console.log('  这份分类不是我们编的，是判据自己长出来的：命中组合相同，就是同一类。');
    console.log('  你觉得哪一类不该存在，就去改对应的那条判据。');
    if (!groups.size) console.log('  （没有任何论文命中判据——判据可能太窄，先跑 ledger --criteria 查召回）');
  }

  // ── 没标注的部分：判据现在怎么说 ──────────────────────────────────────────
  const unlabeled = rows.filter((row) => labelOf(row) === null);
  if (unlabeled.length && !EXPLAIN) {
    const tally = { 算: 0, 不算: 0 };
    const positives = [];
    for (const row of unlabeled) {
      const decided = decide(textOf(row.doi), partsOf(row.doi));
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
