// 来历与口径的自测。
//
// 这一层最怕的是「看起来记了，其实记的是空」——那比不记更糟，
// 因为它让人以为自己知道这份清单是怎么来的。

import { describe, make, STANDARD_NOT_INCLUDED } from './provenance.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
};
const text = (entry) => (describe(entry) ?? []).join('\n');

// ── 给了什么就记什么 ────────────────────────────────────────────────────────
{
  const entry = make({
    tool: 'bench/start.mjs',
    builtFrom: { want: '测试问题', positives: ['10.1/a', '10.1/b'], negatives: ['10.1/c'] },
    filteredBy: { cap: 300, poolSize: 299, dropped: 24 },
  });
  const out = text(entry);
  check('记了要做的事', out.includes('测试问题'), out);
  check('记了正例篇数与 DOI', out.includes('正例 2 篇') && out.includes('10.1/a'), out);
  check('记了反例', out.includes('反例 1 篇'), out);
  check('记了上限与池子', out.includes('300') && out.includes('299'), out);
}

// ── 没给的不要瞎印「未记录」，那是噪音 ──────────────────────────────────────
{
  const entry = make({ tool: 'x', builtFrom: { positives: ['10.1/a'] } });
  const out = text(entry);
  check('没给 seeds 就不印 seeds', !out.includes('seeds'), out);
  check('没给 want 就不印 want', !out.includes('要做的事'), out);
}

// ── 给了但是空的：要印「0 篇」（那是结论，不是缺失） ───────────────────────
{
  const entry = make({ tool: 'x', builtFrom: { seeds: [] } });
  check('空数组印成 0 篇', text(entry).includes('seeds：0 篇'), text(entry));
}

// ── 「明确没做」必须印出来 ──────────────────────────────────────────────────
{
  const entry = make({ tool: 'x', notIncluded: STANDARD_NOT_INCLUDED });
  const out = text(entry);
  check('印出「明确没做」', out.includes('明确没做'), out);
  check('列出没取全文', out.includes('没有取全文'), out);
  check('列出没查引文网络', out.includes('引文网络'), out);
}

// ── 局限也要印 ──────────────────────────────────────────────────────────────
{
  const entry = make({ tool: 'x', limits: ['这是下界，不是覆盖率'] });
  check('印出已知局限', text(entry).includes('下界'), text(entry));
}

// ── 空 entry 不崩 ───────────────────────────────────────────────────────────
{
  check('空 entry 返回 null', describe(null) === null);
  const lines = describe(make({ tool: 'x' }));
  check('只有 tool 时也能渲染', Array.isArray(lines));
}

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
