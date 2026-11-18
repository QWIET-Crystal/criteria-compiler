#!/usr/bin/env node
// 闭环：读你标过的，改判据，再把下一轮要问你的事变少。
//
// 这是整个学生版里唯一称得上「越用越懂」的一步。它不是训练模型——没有任何权重
// 更新；它是**从你标错的那些论文里，找出判据漏掉的说法**，加进草案，然后重新排
// 队列。标过的论文不再问你，这就是「下次少问你几篇」。
//
// Usage:
//   node bench/refine.mjs --pack _t

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { candidateTerms, escapeRe, refineAgainstPool, termsOf } from './lib/terms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = 'https://api.openalex.org/works';
const CACHE_DIR = path.join(ROOT, '.cache', 'openalex');
const PER_PAGE = 100;

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PACK_ID = argValue('--pack', '').trim();
if (!PACK_ID) {
  console.error('用法：node bench/refine.mjs --pack <包名>');
  process.exit(1);
}

const PACK_DIR = path.join(ROOT, 'packs', PACK_ID);
const DRAFT_PATH = path.join(PACK_DIR, 'draft.json');
const QUEUE_PATH = path.join(PACK_DIR, 'review-queue.csv');

if (!fs.existsSync(DRAFT_PATH)) fail(`packs/${PACK_ID}/draft.json 不存在。先用 start.mjs 起草。`);
if (!fs.existsSync(QUEUE_PATH)) fail(`packs/${PACK_ID}/review-queue.csv 不存在。`);

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeDoi = (v) => String(v ?? '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '');
const SAFE_DOI = /^10\.[0-9]{4,9}\/[A-Za-z0-9._;()/:+-]+$/;
const cacheFile = (url) => path.join(CACHE_DIR, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);

async function api(url) {
  try {
    const hit = JSON.parse(fs.readFileSync(cacheFile(url), 'utf8'));
    if (hit) return hit;
  } catch { /* 没缓存就去取 */ }
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'criteria-compiler-refine/0.1' }, signal: controller.signal });
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

function reconstructAbstract(inverted) {
  if (!inverted) return '';
  const slots = [];
  for (const [word, positions] of Object.entries(inverted)) for (const position of positions) slots[position] = word;
  return slots.filter((w) => w != null).join(' ');
}

// 与 start.mjs 用同一套缓存键，所以两边的题录可以互相复用。
async function loadWorks(dois) {
  const found = new Map();
  const safe = dois.filter((d) => SAFE_DOI.test(d) && !d.includes('..'));
  for (let i = 0; i < safe.length; i += 50) {
    const filter = `doi:${safe.slice(i, i + 50).join('|')}`;
    const url = `${API}?filter=${encodeURIComponent(filter)}&per-page=50&select=doi,title,publication_year,cited_by_count,abstract_inverted_index`;
    const data = await api(url);
    for (const work of data?.results ?? []) {
      const doi = normalizeDoi(work.doi);
      if (doi) found.set(doi, {
        doi,
        title: work.title ?? '',
        year: work.publication_year ?? null,
        cited: work.cited_by_count ?? 0,
        abstract: reconstructAbstract(work.abstract_inverted_index),
      });
    }
    await sleep(250);
  }
  return found;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows;
  return body
    .filter((r) => r.some((v) => v && v.trim()))
    .map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

const hitsOf = (text, terms) => terms.filter((t) => text.includes(t));

async function main() {
  const draft = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));
  const queue = parseCsv(fs.readFileSync(QUEUE_PATH, 'utf8'));

  const currentMust = (draft.mustHave ?? []).map((m) => (typeof m === 'string' ? m : m.term));
  const currentNot = draft.mustNot ?? [];

  const labeled = queue.filter((row) => ['2', '0', '1'].includes(String(row.verdict ?? '').trim()));
  const unlabeled = queue.filter((row) => !['2', '0', '1'].includes(String(row.verdict ?? '').trim()));

  console.log(`\n闭环 · ${PACK_ID}`);
  console.log('─'.repeat(72));
  console.log(`队列 ${queue.length} 篇｜已标 ${labeled.length} 篇｜未标 ${unlabeled.length} 篇`);

  if (!labeled.length) {
    fail('还没有标注。把 review-queue.csv 最后一列填上 2 / 0 / 1 再来。');
  }

  const works = await loadWorks(queue.map((row) => row.doi));
  const textOf = (doi) => {
    const work = works.get(doi);
    return work ? `${work.title} ${work.abstract}`.toLowerCase() : '';
  };

  // 草案的猜测口径与 start.mjs 的 core-terms 检查一致：命中任一区分词就算「算」。
  const guess = (doi) => hitsOf(textOf(doi), currentMust).length > 0;

  const buckets = { tp: [], tn: [], fn: [], fp: [], unsure: [] };
  for (const row of labeled) {
    const verdict = String(row.verdict).trim();
    if (verdict === '1') { buckets.unsure.push(row); continue; }
    const said = verdict === '2';
    const guessed = guess(row.doi);
    if (said && guessed) buckets.tp.push(row);
    else if (!said && !guessed) buckets.tn.push(row);
    else if (said && !guessed) buckets.fn.push(row);   // 判据太窄：该算的它说不算
    else buckets.fp.push(row);                          // 判据太宽：不该算的它说算
  }

  const agreed = buckets.tp.length + buckets.tn.length;
  const total = agreed + buckets.fn.length + buckets.fp.length;
  console.log(`一致 ${agreed}/${total}｜判据太窄 ${buckets.fn.length}｜判据太宽 ${buckets.fp.length}｜说不好 ${buckets.unsure.length}`);

  if (!buckets.fn.length && !buckets.fp.length) {
    console.log('\n这批标注和草案完全一致。要么判据已经够用，要么这批样本还不够难——换一批边界论文再标。');
    return;
  }

  // ── 从标的错里长新词 ────────────────────────────────────────────────────
  const mustSet = new Set(currentMust);
  const notSet = new Set(currentNot);
  const textsOf = (rows) => rows.map((r) => works.get(r.doi)).filter(Boolean);

  // 判据太窄：这些论文你说是「算」，但我们一个词都没认出来。
  // 它们共同有的词，就是我们漏掉的说法。
  const fnWorks = textsOf(buckets.fn);
  const negWorks = textsOf([...buckets.tn, ...buckets.fp]);
  const negHas = new Set();
  for (const work of negWorks) for (const term of termsOf(work)) negHas.add(term);

  const fnCandidates = fnWorks.length
    ? candidateTerms(fnWorks, { exclude: negHas, limit: 20 }).filter((c) => !mustSet.has(c.term))
    : [];
  const fnPicked = fnCandidates.length ? refineAgainstPool(fnCandidates, textsOf(queue), { keep: 8 }) : [];

  // 判据太宽：这些论文你说是「不算」，但我们认出来了。
  // 它们有、而「算」的那些没有的词，就是「这样就不算」的信号。
  const fpWorks = textsOf(buckets.fp);
  const posHas = new Set();
  for (const work of textsOf([...buckets.tp, ...buckets.fn])) for (const term of termsOf(work)) posHas.add(term);

  const fpCandidates = fpWorks.length
    ? candidateTerms(fpWorks, { exclude: posHas, limit: 20 }).filter((c) => !notSet.has(c.term))
    : [];
  // 硬性护栏：一条词如果已经在「算」的词表里，就绝不能再被提议成「不算」的信号。
  // 这两批论文共享同一个领域的词汇（donor/acceptor 就是），没有这道闸，
  // 第一次闭环就会把判据自己打死。
  const collided = fpCandidates.filter((c) => mustSet.has(c.term)).map((c) => c.term);
  const safeFp = fpCandidates.filter((c) => !mustSet.has(c.term));
  // 排除信号比区分词更危险，标准要更严：阈值固定 12%，不放宽，最多 4 条。
  const fpPicked = safeFp.length ? refineAgainstPool(safeFp, textsOf(queue), { keep: 4, thresholds: [0.12], strict: true }) : [];

  const addedMust = fnPicked.map((c) => ({ term: c.term, from: `${buckets.fn.length} 篇你判「算」但草案没认出的论文`, poolFrequency: Number(c.df.toFixed(3)) }));
  const addedNot = fpPicked.map((c) => ({ term: c.term, from: `${buckets.fp.length} 篇你判「不算」但草案认出的论文`, poolFrequency: Number(c.df.toFixed(3)) }));

  // ── 写回 ────────────────────────────────────────────────────────────────
  const next = {
    ...draft,
    version: (draft.version ?? 1) + 1,
    mustHave: [...(draft.mustHave ?? []), ...addedMust],
    mustNot: [...currentNot, ...addedNot.map((a) => a.term)],
    revision: {
      date: new Date().toISOString().slice(0, 10),
      basedOn: { labeled: labeled.length, agreed, tooNarrow: buckets.fn.length, tooWide: buckets.fp.length },
      addedTerms: [...addedMust, ...addedNot],
      note: addedMust.length || addedNot.length
        ? '新词不是猜的，是从你标错的论文里长出来的'
        : '你没有标错的论文，但样本量还小；下一次多标几篇再看',
    },
  };

  const allTerms = next.mustHave.map((m) => (typeof m === 'string' ? m : m.term));
  const nextChecks = (draft.checks ?? []).map((check) => {
    if (check.id === 'core-terms' && allTerms.length) {
      return { ...check, pattern: allTerms.slice(0, 10).map(escapeRe).join('|') };
    }
    if (check.id === 'negative-marker' && next.mustNot.length) {
      return { ...check, pattern: next.mustNot.slice(0, 6).map(escapeRe).join('|') };
    }
    return check;
  });
  next.checks = nextChecks;

  fs.writeFileSync(path.join(PACK_DIR, `draft-v${next.version}.json`), JSON.stringify(next, null, 2) + '\n', 'utf8');

  // ── 下一轮队列：只留没标过的，按新判据重排 ──────────────────────────────
  const negRe = next.mustNot.length ? new RegExp(next.mustNot.map(escapeRe).join('|'), 'i') : null;
  const scored = unlabeled
    .map((row) => {
      const text = textOf(row.doi);
      const hits = hitsOf(text, allTerms).length;
      const neg = negRe ? negRe.test(text) : false;
      return { ...row, hits, neg };
    })
    .filter((row) => row.hits > 0);

  const top = Math.max(...scored.map((r) => r.hits), 0);
  const edgeFrom = Math.max(1, top - 3);
  const reranked = scored
    .map((r) => {
      let score = 0;
      let why = '与本题无关';
      if (r.hits >= edgeFrom && r.neg) { score = 5; why = `命中 ${r.hits}/${allTerms.length} 个，但同时踩到排除信号`; }
      else if (r.hits >= edgeFrom && r.hits < top) { score = 4; why = `命中 ${r.hits}/${allTerms.length} 个，贴着交集边缘`; }
      else if (r.hits >= top) { score = 3; why = `命中 ${r.hits}/${allTerms.length} 个——新草案最确定的一批`; }
      else if (r.neg) { score = 1; why = `只踩到排除信号`; }
      return { ...r, score, why };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => (b.score - a.score) || (b.hits - a.hits));

  const csv = ['doi,title,year,cited,why,verdict', ...reranked.map((r) => [r.doi, `"${(r.title ?? '').replace(/"/g, "'")}"`, r.year ?? '', r.cited ?? '', `"${r.why}"`, ''].join(','))];
  fs.writeFileSync(path.join(PACK_DIR, `review-queue-v${next.version}.csv`), `${csv.join('\n')}\n`, 'utf8');

  // ── 报告 ────────────────────────────────────────────────────────────────
  console.log('\n改了什么');
  console.log('─'.repeat(72));
  if (addedMust.length) {
    console.log('  判据太窄，补进区分词：');
    for (const item of addedMust) console.log(`    + ${item.term}  （${item.from}，背景池里占 ${(item.poolFrequency * 100).toFixed(1)}%）`);
  }
  if (addedNot.length) {
    console.log('  判据太宽，补进排除信号：');
    for (const item of addedNot) console.log(`    + ${item.term}  （${item.from}，背景池里占 ${(item.poolFrequency * 100).toFixed(1)}%）`);
  }
  if (!addedMust.length && !addedNot.length && !buckets.fp.length) console.log('  没能长出新的词——样本量太小，或者标错的那些论文彼此没有共同说法。');
  if (buckets.fp.length && !addedNot.length) {
    console.log('\n  这几篇你判「不算」，但它们和「算」的论文共享同一个领域的词汇，找不出干净的排除词。');
    console.log('  这通常说明：判据缺的是「必须有 X」（缺失型判据），而不是「不能有 Y」。');
    console.log('  下一步该问自己的是——这几篇，缺了什么？');
  }
  if (collided.length) console.log('  ⚠️ 挡下 %d 个和区分词撞车的排除候选：%s（它们本来就在「算」的词表里）', collided.length, collided.join('、'));

  console.log(`\n下一轮`);
  console.log('─'.repeat(72));
  console.log(`  标过的 ${labeled.length} 篇不会再问你。`);
  console.log(`  剩下 ${unlabeled.length} 篇里，按新草案还要看 ${reranked.length} 篇 → review-queue-v${next.version}.csv`);
  console.log(`  少问了你 ${Math.max(0, labeled.length)} 篇。`)
  console.log(`\n  一致率从 ${agreed}/${total} 开始，下一轮标完再看它有没有升。`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
