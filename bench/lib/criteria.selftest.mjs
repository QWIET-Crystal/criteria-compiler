// 判据求值器的自测。不用跑框架，`node bench/lib/criteria.selftest.mjs` 即可。
//
// 用例刻意与领域无关：判据机制不认识任何学科的词，认识的是「同一句里有没有一起出现」。

import { decide, evaluate, findCooccurrences, workText } from './criteria.mjs';

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

// ── workText：标题与摘要之间必须有句号 ──────────────────────────────────────
{
  const work = { title: 'A Study of Coupling', abstract: 'First sentence here. Second one.' };
  const text = workText(work);
  check('workText：标题与摘要之间有句号', text.startsWith('A Study of Coupling. '), text);

  // 真实坑：标题没带句号时，空格拼接会和摘要第一句黏成一句，造出假共现
  const t2 = 'Tailoring Orbital Hybridization for Peroxide Production';
  const a2 = 'The process is controlled by adsorption.';
  const glued = evaluate([{ id: 'x', kind: 'co-occur', terms: ['peroxide', 'adsorption'] }], `${t2} ${a2}`);
  const proper = evaluate([{ id: 'x', kind: 'co-occur', terms: ['peroxide', 'adsorption'] }], workText({ title: t2, abstract: a2 }));
  check('空格拼接会造出假共现（这是要避免的）', glued[0].matched === true);
  check('workText 不会：标题与摘要不同句', proper[0].matched === false);
}

// ── decide：三档，且排除信号优先 ────────────────────────────────────────────
{
  const text = 'We couple A with B in one vessel.';
  const parts = { title: 't', abstract: text };

  const strong = decide([{ id: 'c', kind: 'co-occur', terms: ['couple', 'vessel'] }], text, parts);
  check('decide：共现命中 → 算', strong.verdict === '算', strong.verdict);

  const weak = decide([{ id: 'a', kind: 'any', terms: ['couple'] }], text, parts);
  check('decide：只有泛词 → 疑似', weak.verdict === '疑似', weak.verdict);

  const none = decide([{ id: 'a', kind: 'any', terms: ['zzz'] }], text, parts);
  check('decide：都没有 → 不算', none.verdict === '不算', none.verdict);

  const blocked = decide(
    [
      { id: 'c', kind: 'co-occur', terms: ['couple', 'vessel'] },
      { id: 'e', kind: 'absent', terms: ['vessel'] },
    ],
    text,
    parts,
  );
  check('decide：踩到排除信号，即使共现命中也不算', blocked.verdict === '不算', blocked.verdict);
}

// ── findCooccurrences：不许生成永远不会命中的判据 ─────────────────────────────
{
  // synthesis 只以 photosynthesis 的形式出现：生成器若用 includes 会误判成共现
  const pos = [{ title: 'T', abstract: 'Photosynthesis and aerobic oxidation proceed together.', _terms: ['synthesis', 'aerobic'] }];
  const pairs = findCooccurrences(pos, [], { minPos: 1, limit: 5 });
  check('生成器不把 photosynthesis 里的 synthesis 当命中', !pairs.some((p) => p.terms.includes('synthesis')), JSON.stringify(pairs));

  // 生成出来的每一条，求值器都必须认得出——这是生成器与求值器的一致性契约
  const pos2 = [{ title: 'T', abstract: 'Aerobic oxidation proceeds in water.', _terms: ['aerobic', 'oxidation'] }];
  const pairs2 = findCooccurrences(pos2, [], { minPos: 1, limit: 5 });
  const alive = pairs2.every((pair) =>
    evaluate([{ id: 'x', kind: 'co-occur', terms: pair.terms }], pos2[0].abstract, { title: pos2[0].title, abstract: pos2[0].abstract })[0].matched,
  );
  check('生成出来的判据，求值器全都认得出', pairs2.length > 0 && alive, JSON.stringify(pairs2));
}

// ── 否定语境：同一个词，两种方向 ────────────────────────────────────────────
{
  const plain = [{ id: 'x', kind: 'absent', terms: ['sacrificial'] }];
  const aware = [{ id: 'x', kind: 'absent', terms: ['sacrificial'], negationAware: true }];

  const BAD = 'A sacrificial-agent-triggered system produced hydrogen peroxide.';
  const GOOD = 'Hydrogen peroxide was produced without any sacrificial agent.';

  check('纯字符串：坏例子判违规', evaluate(plain, BAD)[0].matched === false);

  const goodPlain = evaluate(plain, GOOD)[0];
  check('纯字符串：好例子被误判为违规（这就是要修的问题）', goodPlain.matched === false, goodPlain.reason);

  const goodAware = evaluate(aware, GOOD)[0];
  check('否定感知：好例子不判违规', goodAware.matched === true, goodAware.reason);
  check('否定感知：把否定形式当正面证据返回', goodAware.evidence.length > 0, JSON.stringify(goodAware.evidence));

  const badAware = evaluate(aware, BAD)[0];
  check('否定感知：坏例子仍然判违规', badAware.matched === false, badAware.reason);
}

// ── 后缀形式：sacrificial-free ──────────────────────────────────────────────
{
  const aware = [{ id: 'x', kind: 'absent', terms: ['sacrificial'], negationAware: true }];
  const r = evaluate(aware, 'A sacrificial-free route to hydrogen peroxide.')[0];
  check('否定感知：sacrificial-free 也算否定', r.matched === true, r.reason);
}

// ── 中文否定 ────────────────────────────────────────────────────────────────
{
  const aware = [{ id: 'x', kind: 'absent', terms: ['sacrificial'], negationAware: true }];
  const r = evaluate(aware, '该体系无需 sacrificial 即可产过氧化氢。')[0];
  check('否定感知：中文「无需」也算否定', r.matched === true, r.reason);
}

// ── 没开 negationAware 时行为不变 ───────────────────────────────────────────
{
  const r = evaluate([{ id: 'x', kind: 'absent', terms: ['zzz'] }], 'nothing here')[0];
  check('默认 absent 行为不受影响', r.matched === true);
}

// ── note：只给证据，不改判定 ────────────────────────────────────────────────
{
  const text = 'The reaction used benzyl alcohol as a sacrificial agent and gave benzaldehyde.';
  const withNote = [
    { id: 'any1', kind: 'any', terms: ['benzaldehyde'] },
    { id: 'hint', kind: 'note', terms: ['sacrificial'], negationAware: true },
  ];
  const decided = decide(withNote, text, { title: 't', abstract: text });
  check('note：不把结果判成不算', decided.verdict !== '不算', decided.verdict);
  check('note：不算作正向证据', decided.positive.every((r) => r.kind !== 'note'));

  const noteResult = decided.results.find((r) => r.kind === 'note');
  check('note：仍然给出证据', noteResult.matched === true && noteResult.evidence.length > 0);
  check('note：说明是肯定形式', /肯定形式/.test(noteResult.reason), noteResult.reason);
}

// ── note + 否定：反过来是正面信号 ────────────────────────────────────────────
{
  const text = 'Hydrogen peroxide was produced without any sacrificial agent.';
  const [r] = evaluate([{ id: 'hint', kind: 'note', terms: ['sacrificial'], negationAware: true }], text, { title: 't', abstract: text });
  check('note：否定形式被认出来', /否定形式/.test(r.reason), r.reason);
}

// ── required：按纳排标准判，而不是按「有没有更强证据」判 ────────────────────
{
  // 一篇论文：是 COF，产 H2O2，但摘要没写「耦合」
  const text = 'A covalent organic framework produced hydrogen peroxide under visible light.';
  const criteria = [
    { id: 'material', kind: 'any', terms: ['covalent organic framework'], required: true },
    { id: 'object', kind: 'any', terms: ['hydrogen peroxide'], required: true },
    { id: 'coupled', kind: 'co-occur', terms: ['coupled with', 'hydrogen peroxide'] },
  ];
  const decided = decide(criteria, text, { title: 't', abstract: text });
  check('required：两个必要条件都满足就判算，即使没有耦合证据', decided.verdict === '算', decided.verdict);
  check('required：结果里带出 required 标记', decided.results.every((r) => typeof r.required === 'boolean'));

  // 同一篇，但材料不是 COF
  const notCof = 'A carbon nitride produced hydrogen peroxide under visible light.';
  const decided2 = decide(criteria, notCof, { title: 't', abstract: notCof });
  check('required：只满足一个必要条件 → 疑似', decided2.verdict === '疑似', decided2.verdict);

  // 两个都不满足
  const neither = 'A review about photocatalysis.';
  const decided3 = decide(criteria, neither, { title: 't', abstract: neither });
  check('required：一个都不满足 → 不算', decided3.verdict === '不算', decided3.verdict);
}

// ── 没有 required 时行为不变 ────────────────────────────────────────────────
{
  const text = 'Hydrogen peroxide coupled with alcohol oxidation.';
  const decided = decide([{ id: 'c', kind: 'co-occur', terms: ['coupled with', 'hydrogen peroxide'] }], text, { title: 't', abstract: text });
  check('没有 required：仍按耦合证据判算', decided.verdict === '算', decided.verdict);
}

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
