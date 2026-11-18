// 三类原因的自测。
//
// 最要紧的一条：占比最高的那类要能把「现在该做什么」说出来。
// 说错了不会崩，但会让人去改不该改的东西——那种错比崩溃难发现。

import { CAUSES, summariseCauses } from './causes.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
};

check('只有三类，不多不少', Object.keys(CAUSES).length === 3, Object.keys(CAUSES).join(','));
check('每一类都说了「该怎么办」', Object.values(CAUSES).every((c) => c.hint && c.label));

// ── 分组 ────────────────────────────────────────────────────────────────────
{
  const rows = [
    { doi: 'a', cause: { cause: 'data' } },
    { doi: 'b', cause: { cause: 'data' } },
    { doi: 'c', cause: { cause: 'criterion' } },
  ];
  const { buckets, advice } = summariseCauses(rows);
  check('分对了组', buckets.data.length === 2 && buckets.criterion.length === 1);
  check('占比最高的那类被选为建议', advice === 'data', String(advice));
}

// ── 没有过半就不给建议（免得误导） ──────────────────────────────────────────
{
  const rows = [
    { doi: 'a', cause: { cause: 'data' } },
    { doi: 'b', cause: { cause: 'criterion' } },
    { doi: 'c', cause: { cause: 'out_of_scope' } },
  ];
  const { advice } = summariseCauses(rows);
  check('三类各一篇：不给建议', advice === null, String(advice));
}

// ── 未定原因进 unknown，不混进任何一类 ──────────────────────────────────────
{
  const rows = [{ doi: 'a' }, { doi: 'b', cause: null }];
  const { buckets } = summariseCauses(rows);
  check('没定原因的进 unknown', buckets.unknown.length === 2);
  check('没定原因不会被当成 criterion', buckets.criterion.length === 0);
}

// ── 空输入不崩 ──────────────────────────────────────────────────────────────
{
  const { total, advice } = summariseCauses([]);
  check('空输入：total 为 0', total === 0);
  check('空输入：无建议', advice === null);
}

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
