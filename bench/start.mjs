#!/usr/bin/env node
// 学生版入口：一句话 + 几篇你认的论文 → 一份你能改的判据草案 + 50 篇最该由你来标的。
//
// 为什么是这个顺序：判据从哪来，是这个项目最容易被问倒的一环。答案是——从你的
// 正反例里长出来，长出来先给你看，你说不对它改。这里做的是「长出来」和「挑出来」，
// 判断仍然在你手里。
//
// 它不做的事：不自动决定槽位（那是领域判断，见 docs/design-tree.md A1′），
// 不替你标，不给终判。
//
// Usage:
//   node bench/start.mjs --id my-topic \
//     --want "COF 光催化里真正同时发生的水氧化与双氧水生成" \
//     --pos 10.1002/adfm.202510257,10.1021/jacs.6c00731 \
//     --neg 10.1016/j.mser.2025.101117 \
//     --cap 200

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = 'https://api.openalex.org/works';
const CACHE_DIR = path.join(ROOT, '.cache', 'openalex');
const ABSTRACT_CACHE = path.join(ROOT, '.cache', 'abstracts', 'works.json');

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const ID = argValue('--id', '').trim();
const WANT = argValue('--want', '').trim();
const POS = argValue('--pos', '').split(',').map(normalizeDoi).filter(Boolean);
const NEG = argValue('--neg', '').split(',').map(normalizeDoi).filter(Boolean);
const CAP = Math.max(50, Math.min(1000, Number(argValue('--cap', '200')) || 200));
const PICK = Math.max(10, Math.min(100, Number(argValue('--pick', '50')) || 50));

function normalizeDoi(v) {
  return String(v ?? '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '');
}

if (!ID) fail('缺 --id（新建的包名，例如 cof-coupling）');
if (!WANT) fail('缺 --want（一句话说明你要搜什么）');
if (POS.length < 2) fail('至少给 2 篇你认的论文 —— 一篇不足以看出共同点');

function fail(message) {
  console.error(`\n${message}\n`);
  console.error('用法：node bench/start.mjs --id <名字> --want "<一句话>" --pos doi1,doi2 [--neg doi3,doi4]');
  process.exit(1);
}

// ── HTTP（与 run.mjs / axis-yield.mjs 同一套缓存） ───────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cacheFile = (url) => path.join(CACHE_DIR, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);

async function api(url) {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile(url), 'utf8'));
    if (cached) return cached;
  } catch { /* 没缓存就去取 */ }
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'criteria-compiler-start/0.1' }, signal: controller.signal });
      if (res.status === 200) {
        const data = await res.json();
        try {
          fs.mkdirSync(CACHE_DIR, { recursive: true });
          fs.writeFileSync(cacheFile(url), JSON.stringify(data), 'utf8');
        } catch { /* best effort */ }
        return data;
      }
      if (res.status === 429) { await sleep(4000 * (attempt + 1)); continue; }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

const SAFE_DOI = /^10\.[0-9]{4,9}\/[A-Za-z0-9._;()/:+-]+$/;
const SAFE_TERM = /^[\p{L}\p{N}\s\-.,()+/'’·]+$/u;

/** OpenAlex 的倒排索引 → 正文，只在内存里拼。 */
function reconstructAbstract(inverted) {
  if (!inverted) return '';
  const slots = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const position of positions) slots[position] = word;
  }
  return slots.filter((w) => w != null).join(' ');
}

// ── 抓例子 ───────────────────────────────────────────────────────────────────
async function loadWorks(dois) {
  const found = new Map();
  const safe = dois.filter((d) => SAFE_DOI.test(d) && !d.includes('..'));
  for (let i = 0; i < safe.length; i += 50) {
    const filter = `doi:${safe.slice(i, i + 50).join('|')}`;
    const url = `${API}?filter=${encodeURIComponent(filter)}&per-page=50&select=doi,title,abstract_inverted_index,publication_year`;
    const data = await api(url);
    for (const work of data?.results ?? []) {
      const doi = normalizeDoi(work.doi);
      if (doi) found.set(doi, {
        doi,
        title: work.title ?? '',
        year: work.publication_year ?? null,
        abstract: reconstructAbstract(work.abstract_inverted_index),
      });
    }
    await sleep(250);
  }
  return found;
}

// ── 从例子里长出词 ───────────────────────────────────────────────────────────
const STOP = new Set(`a an the and or of for in on with by to from at as is are was were be been being
this that these those we our their its it they them us use used using based via into than then
herein study results show shows shown report reported present presents new high low two three
one both such can may also more most less very between among during within without under over
however moreover furthermore thus therefore which where while when what who whom not no non
abstract introduction conclusion method methods approach approaches paper work works figure figures
table tables data result analysis system systems model models performance effect effects
achieving achieve achieved exceeded exceeding notably notably promising efficient efficiency
significantly significantly enhanced improve improved improving strategy strategies facile
respectively thereby thereby toward towards role roles insight insights design designs
recent recent novel excellent superior remarkable effective successfully easily first time
due owing attributed enabled enables enable allow allows allowing provide provides provided
obtained obtain obtaining observed observe shows revealed reveals reveal found find
compared comparison respectively relatively highly greatly largely mainly primarily`.split(/\s+/));

/** 词与相邻双词。双词必须是**原文相邻**的两个词——先过滤再拼会拼出「photosynthesis aerobic」这种怪东西。 */
function termsOf(work) {
  const raw = `${work.title ?? ''} ${work.abstract ?? ''}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const usable = (w) => w.length >= 4 && w.length <= 30 && !STOP.has(w) && !/^\d+$/.test(w);

  const set = new Set();
  for (const word of raw) if (usable(word)) set.add(word);
  for (let i = 0; i + 1 < raw.length; i++) {
    const [a, b] = [raw[i], raw[i + 1]];
    if (!usable(a) || !usable(b)) continue;
    const bigram = `${a} ${b}`;
    if (bigram.length <= 40) set.add(bigram);
  }
  return set;
}

/** 正例里常见、反例里绝迹的词 —— 第一层线索。先多取，后面再用池内词频过滤。 */
function distinctiveTerms(posWorks, negWorks, limit = 40) {
  const counter = new Map();
  for (const work of posWorks) for (const term of termsOf(work)) counter.set(term, (counter.get(term) ?? 0) + 1);
  const negHas = new Set();
  for (const work of negWorks) for (const term of termsOf(work)) negHas.add(term);

  return [...counter.entries()]
    .filter(([term, count]) => count >= Math.min(2, posWorks.length) && !negHas.has(term))
    .sort((a, b) => (b[1] - a[1]) || (b[0].split(' ').length - a[0].split(' ').length) || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

/**
 * 用同领域的池子做背景，把「通用词」筛掉。
 *
 * 只用 3 篇正例 + 2 篇反例，「photocatalysts」「electron」这种词当然满足
 * 「正例里有、反例里没有」——因为它们在这个领域里到处都有。要判断一个词是不是
 * *区分性* 的，缺的从来不是正例，是**背景分布**。这里拿池子自己当背景。
 */
function refineTerms(candidates, poolWorks, keep = 14) {
  const poolSize = poolWorks.length || 1;
  const df = new Map();
  for (const work of poolWorks) {
    for (const term of termsOf(work)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const scored = candidates.map((c) => ({ ...c, df: (df.get(c.term) ?? 0) / poolSize }));

  // 阈值自适应：先按 15% 卡，太严就放宽到 30%，避免一个都不剩。
  for (const maxDf of [0.15, 0.3]) {
    const kept = scored
      .filter((c) => c.df <= maxDf)
      .sort((a, b) => (b.count - a.count) || (a.df - b.df) || b.term.length - a.term.length)
      .slice(0, keep);
    if (kept.length >= Math.min(5, candidates.length)) return kept;
  }
  return scored.slice(0, keep);
}

/** 反例里有、正例里没有的词 —— 可能是排除信号，也可能只是噪音，交给用户判。 */
function negativeMarkers(posWorks, negWorks, limit = 8) {
  if (!negWorks.length) return [];
  const counter = new Map();
  for (const work of negWorks) for (const term of termsOf(work)) counter.set(term, (counter.get(term) ?? 0) + 1);
  const posHas = new Set();
  for (const work of posWorks) for (const term of termsOf(work)) posHas.add(term);
  return [...counter.entries()]
    .filter(([term]) => !posHas.has(term))
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

// ── 拉背景池 ─────────────────────────────────────────────────────────────────
async function fetchPool(terms, cap) {
  const query = `(${terms.map((t) => `"${t}"`).join(' OR ')})`;
  const base = `${API}?filter=${encodeURIComponent(`title_and_abstract.search:${query}`)}&per-page=100&select=doi,title,publication_year,cited_by_count,abstract_inverted_index`;
  const works = [];
  for (let page = 1; page <= Math.ceil(cap / 100); page++) {
    const data = await api(`${base}&page=${page}`);
    const results = data?.results ?? [];
    for (const entry of results) {
      const doi = normalizeDoi(entry.doi);
      if (!doi) continue;
      works.push({
        doi,
        title: entry.title ?? '',
        year: entry.publication_year ?? null,
        cited: entry.cited_by_count ?? 0,
        abstract: reconstructAbstract(entry.abstract_inverted_index),
      });
    }
    await sleep(250);
    if (results.length < 100) break;
  }
  return works;
}

// ── 挑「最该由人来标的」那一批 ───────────────────────────────────────────────
// 不用模型。判据是：**草案自己拿不准的论文最值钱**。
// 两个检查意见相反 → 最能教我们东西；只中一半区分词 → 贴在边界上。
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rankBoundary(works, terms, negMarkers, known = new Set()) {
  const negRe = negMarkers.length ? new RegExp(negMarkers.map((t) => escapeRe(t.term)).join('|'), 'i') : null;

  const scored = works.map((work) => {
    const text = `${work.title} ${work.abstract}`.toLowerCase();
    const hits = terms.filter((t) => text.includes(t.term)).length;
    return { ...work, hits, neg: negRe ? negRe.test(text) : false };
  });

  // 命中越多越贴近本题。真正的边界是**刚好在交集边上**的那一圈，不是最外围。
  const top = Math.max(...scored.map((r) => r.hits), 0);
  const edgeFrom = Math.max(1, top - 3);

  const rows = scored
    .filter((r) => !known.has(r.doi))
    .map((r) => {
      let score = 0;
      let why = '与本题无关';
      if (r.hits >= edgeFrom && r.neg) { score = 5; why = `命中 ${r.hits}/${terms.length} 个区分词，但同时踩到排除信号——两个检查意见相反`; }
      else if (r.hits >= edgeFrom && r.hits < top) { score = 4; why = `命中 ${r.hits}/${terms.length} 个，贴着交集边缘`; }
      else if (r.hits >= top) { score = 3; why = `命中 ${r.hits}/${terms.length} 个——草案最确定的这一批，抽查它们对不对`; }
      else if (r.neg) { score = 1; why = `只踩到排除信号（命中 ${r.hits} 个）`; }
      return { ...r, score, why };
    })
    .filter((r) => r.score > 0);

  rows.sort((a, b) => (b.score - a.score) || (b.hits - a.hits) || (b.cited - a.cited));
  return rows;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const outDir = path.join(ROOT, 'packs', ID);
  if (fs.existsSync(path.join(outDir, 'pack.json'))) {
    fail(`packs/${ID} 已经存在。换一个 --id，或先把旧包挪走。`);
  }

  console.log(`\n学生版 · 从一句话到一个可改的判据草案`);
  console.log('─'.repeat(72));
  console.log(`你要搜的是：${WANT}`);
  console.log(`正例 ${POS.length} 篇｜反例 ${NEG.length} 篇`);

  const works = await loadWorks([...POS, ...NEG]);
  const posWorks = POS.map((d) => works.get(d)).filter(Boolean);
  const negWorks = NEG.map((d) => works.get(d)).filter(Boolean);

  if (posWorks.length < 2) {
    fail(`只取到 ${posWorks.length} 篇正例的题录（联网失败或 DOI 有误）。至少需要 2 篇。`);
  }
  const skipped = POS.filter((d) => !works.has(d));
  if (skipped.length) console.log(`\n⚠️ 这 ${skipped.length} 篇没取到题录，已跳过：${skipped.join('、')}`);

  const candidates = distinctiveTerms(posWorks, negWorks);
  if (!candidates.length) fail('没能从正例里提取出任何候选词。补几篇正例，或确认摘要能取到。');

  console.log('\n正在拉一个同领域的背景池，用来分辨哪些词只是这个领域的通用词……');
  const poolWorks = await fetchPool(candidates.slice(0, 8).map((t) => t.term), CAP);
  const terms = refineTerms(candidates, poolWorks);
  if (!terms.length) fail('所有候选词都在背景池里高频出现，没有一个是区分性的。多半是正例太杂，或者这个领域的说法确实没有共识词。');

  const dropped = candidates.filter((c) => !terms.some((t) => t.term === c.term));
  const negMarkers = negativeMarkers(posWorks, negWorks);

  // 待标池就用背景池：它虽然混着邻域的论文，但只要按「命中几个区分词」排序，
  // 交集那一圈自己会浮上来。再另起一次查询反而更糟——OR 罕见词拉回来的是
  // 「各自只沾一个词」的杂牌军，交集被稀释到只剩一两篇。
  const topicPool = poolWorks;

  // ── 草案 ────────────────────────────────────────────────────────────────
  const draft = {
    pack: ID,
    want: WANT,
    examples: { positive: POS, negative: NEG },
    mustHave: terms.map((t) => ({ term: t.term, inPositives: t.count, poolFrequency: Number(t.df.toFixed(3)) })),
    mustNot: negMarkers.map((t) => t.term),
    checks: [
      {
        id: 'core-terms',
        pattern: terms.slice(0, 8).map((t) => escapeRe(t.term)).join('|'),
        note: `这 ${Math.min(8, terms.length)} 个词在你 ${posWorks.length} 篇正例里反复出现，而在同领域 ${poolWorks.length} 篇背景论文里很少见。先看它们是不是「本来就应该对」的同义说法——是，就进槽位；只是几篇的巧合，就删掉。`,
        source: '从正例里长出来，再用背景池过滤',
      },
      ...(negMarkers.length
        ? [{
            id: 'negative-marker',
            pattern: negMarkers.slice(0, 4).map((t) => escapeRe(t.term)).join('|'),
            note: `这 ${Math.min(4, negMarkers.length)} 个词只出现在你的反例里。它们可能是「这样就不算」的信号，也可能只是那几篇的巧合——这一条最容易错，请重点看。`,
            source: '从反例里长出来的',
          }]
        : []),
    ],
    openQuestions: [],
  };

  if (!negMarkers.length) {
    draft.openQuestions.push('反例没有提供任何可用信号。是它们太杂，还是「不算」本身没有共同点？后者说明判据要写成"必须有 X"，而不是"不能有 Y"。');
  }
  if (dropped.length) {
    draft.openQuestions.push(`${dropped.length} 个候选词在背景池里太常见、已自动丢弃（例如 ${dropped.slice(0, 3).map((d) => d.term).join('、')}）。如果有你眼里的关键术语被丢了，说明它喊得不够响——那本身就是个信息。`);
  }
  draft.openQuestions.push('槽位怎么切，脚本不替你决定。下面这几篇边界论文标完，再回来定。');

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'draft.json'), JSON.stringify(draft, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'intake.md'), renderIntake(draft, posWorks, negWorks), 'utf8');

  console.log('\n判据草案（这是要给你改的，不是结论）');
  console.log('─'.repeat(72));
  console.log(`  留下的区分词 ${terms.length} 个（括号里是它在这个领域背景池里出现的比例，越低越有区分力）：`);
  for (const t of terms.slice(0, 10)) {
    console.log(`    ${t.term}  (${(t.df * 100).toFixed(1)}%)`);
  }
  if (dropped.length) console.log(`  丢弃的通用词 ${dropped.length} 个：${dropped.slice(0, 6).map((d) => d.term).join('、')}…`);
  console.log('');
  for (const check of draft.checks) {
    console.log(`  [${check.id}] ${check.note}`);
    console.log(`    命中模式：${check.pattern}`);
    console.log('');
  }
  if (draft.openQuestions.length) {
    console.log('  需要你拍板的：');
    for (const q of draft.openQuestions) console.log(`    · ${q}`);
  }

  // ── 边界样本 ────────────────────────────────────────────────────────────
  console.log(`\n正在按这份草案找「最该由你来标」的论文……`);
  const rows = rankBoundary(topicPool, terms, negMarkers, new Set([...POS, ...NEG]));
  const picked = rows.slice(0, PICK);

  const csv = ['doi,title,year,cited,why,verdict'];
  for (const row of picked) {
    csv.push([row.doi, `"${row.title.replace(/"/g, "'")}"`, row.year ?? '', row.cited, `"${row.why}"`, ''].join(','));
  }
  fs.writeFileSync(path.join(outDir, 'review-queue.csv'), `${csv.join('\n')}\n`, 'utf8');

  const byWhy = new Map();
  for (const row of picked) byWhy.set(row.why, (byWhy.get(row.why) ?? 0) + 1);

  console.log(`\n背景池 ${poolWorks.length} 篇（判断哪些词是通用词）｜待标池 ${topicPool.length} 篇（只含本题相关的）`);
  console.log(`挑出 ${picked.length} 篇给你标：`);
  for (const [why, count] of [...byWhy.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)} 篇  ${why}`);
  }
  console.log(`\n产出：`);
  console.log(`  packs/${ID}/draft.json        判据草案`);
  console.log(`  packs/${ID}/intake.md         你给的四个答案（存档）`);
  console.log(`  packs/${ID}/review-queue.csv  ${picked.length} 篇待标注（最后一列 verdict 填 2/0/1）`);
  console.log(`\n下一步：lab 里逐篇标，标完回来说一句，它据此改判据——下次会少问你几篇。`);
}

function renderIntake(draft, posWorks, negWorks) {
  const lines = [
    `# ${draft.pack} · 起步记录`,
    '',
    `**你要搜的是**：${draft.want}`,
    '',
    '## 你给的例子',
    '',
    `正例 ${posWorks.length} 篇（这些算）：`,
    ...posWorks.map((w) => `- ${w.doi} — ${w.title}`),
    '',
    negWorks.length ? `反例 ${negWorks.length} 篇（这些不算）：` : '反例：未提供',
    ...negWorks.map((w) => `- ${w.doi} — ${w.title}`),
    '',
    '## 脚本从例子里读出来的',
    '',
    `区分性词：${draft.mustHave.slice(0, 10).join('、')}`,
    '',
    draft.mustNot.length ? `反例独有词：${draft.mustNot.join('、')}` : '反例独有词：无',
    '',
    '## 待你拍板',
    '',
    ...draft.openQuestions.map((q) => `- ${q}`),
    '',
    '> 这份文件是存档。判据草案在 `draft.json`，待标清单在 `review-queue.csv`。',
    '',
  ];
  return lines.join('\n');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
