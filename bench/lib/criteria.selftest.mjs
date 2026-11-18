// 判据求值器的自测。不用跑框架，`node bench/lib/criteria.selftest.mjs` 即可。
//
// 用例刻意与领域无关：判据机制不认识任何学科的词，认识的是「同一句里有没有一起出现」。

import { evaluate } from './criteria.mjs';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const TEXT = [
  'We report a system that couples A with B inside one reactor.',
  'The second pathway is described elsewhere.',
  'Under these conditions C appears only after irradiation.',
].join(' ');

// ── any ─────────────────────────────────────────────────────────────────────
{
  const [hit] = evaluate([{ id: 'x', kind: 'any', terms: ['couples', 'never-there'] }], TEXT);
  check('any：任一命中', hit.matched === true);
  check('any：给出原文', hit.evidence[0]?.quote.toLowerCase() === 'couples');

  const [miss] = evaluate([{ id: 'x', kind: 'any', terms: ['absent-word'] }], TEXT);
  check('any：全不在就不命中', miss.matched === false);
}

// ── all ─────────────────────────────────────────────────────────────────────
{
  const [hit] = evaluate([{ id: 'x', kind: 'all', terms: ['couples', 'reactor'] }], TEXT);
  check('all：都出现就命中（可以不同句）', hit.matched === true);

  const [miss] = evaluate([{ id: 'x', kind: 'all', terms: ['couples', 'zzz'] }], TEXT);
  check('all：缺一个就不命中', miss.matched === false);
  check('all：说清楚缺哪个', miss.reason.includes('zzz'), miss.reason);
}

// ── co-occur（这一条是重点）──────────────────────────────────────────────────
{
  const [same] = evaluate([{ id: 'x', kind: 'co-occur', terms: ['couples', 'reactor'] }], TEXT);
  check('co-occur：同句命中', same.matched === true);
  check(
    'co-occur：证据逐个词给出，能核对是哪两个说法',
    same.evidence.length === 2 && same.evidence.every((span) => span.quote === TEXT.slice(span.start, span.end)),
  );

  const [apart] = evaluate([{ id: 'x', kind: 'co-occur', terms: ['couples', 'irradiation'] }], TEXT);
  check('co-occur：分处两句就不命中', apart.matched === false);
  check('co-occur：说明是分开出现', apart.reason.includes('不在同一句'), apart.reason);
}

// ── absent ──────────────────────────────────────────────────────────────────
{
  const [clean] = evaluate([{ id: 'x', kind: 'absent', terms: ['forbidden-phrase'] }], TEXT);
  check('absent：没出现就命中', clean.matched === true);

  const [dirty] = evaluate([{ id: 'x', kind: 'absent', terms: ['irradiation'] }], TEXT);
  check('absent：出现就不命中', dirty.matched === false);
  check('absent：给出它出现的位置', dirty.evidence[0]?.quote.toLowerCase() === 'irradiation');
}

// ── 证据必须可以回原文核对 ───────────────────────────────────────────────────
{
  const results = evaluate(
    [
      { id: 'a', kind: 'any', terms: ['reactor'] },
      { id: 'b', kind: 'co-occur', terms: ['couples', 'reactor'] },
      { id: 'c', kind: 'absent', terms: ['irradiation'] },
    ],
    TEXT,
  );
  const consistent = results.every((item) =>
    item.evidence.every((span) => span.quote === TEXT.slice(span.start, span.end)),
  );
  check('每条证据的偏移都能在原文里对上', consistent);
}

// ── 空判据不许崩 ────────────────────────────────────────────────────────────
{
  const results = evaluate([{ id: 'empty', kind: 'any', terms: [] }], TEXT);
  check('空判据：安全返回未命中', results[0].matched === false);
  check('空判据：说明为什么', Boolean(results[0].reason));
}

// ── 词边界：不能把 photosynthesis 里的 synthesis 算进去 ──────────────────────
{
  const text = 'Photosynthesis converts light into chemical energy.';
  const [hit] = evaluate([{ id: 'x', kind: 'any', terms: ['synthesis'] }], text);
  check('词边界：synthesis 不匹配 photosynthesis', hit.matched === false, JSON.stringify(hit.evidence));
  const [ok] = evaluate([{ id: 'x', kind: 'any', terms: ['photosynthesis'] }], text);
  check('词边界：完整词仍然匹配', ok.matched === true);
}

// ── 作用域：只在标题里找 ────────────────────────────────────────────────────
{
  const title = 'Hydrogen peroxide production and organic synthesis on carbon dots';
  const abstract = 'The catalyst converts oxygen under visible light with high efficiency.';
  const text = `${title}. ${abstract}`;
  const parts = { title, abstract };

  const [titleScoped] = evaluate([{ id: 'x', kind: 'co-occur', scope: 'title', terms: ['hydrogen peroxide', 'organic synthesis'] }], text, parts);
  check('作用域 title：标题里同句命中', titleScoped.matched === true);

  const [wrongScope] = evaluate([{ id: 'x', kind: 'co-occur', terms: ['hydrogen peroxide', 'visible light'] }], text, parts);
  check('作用域 all：跨标题与摘要不算同句', wrongScope.matched === false);
}

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
