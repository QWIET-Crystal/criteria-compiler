#!/usr/bin/env node
// 闭环：读你标过的，改判据，再拉一批新的、更该由你来标的。
//
// 这是整个学生版里唯一称得上「越用越懂」的一步。它不是训练模型——没有任何权重
// 更新。它做三件具体的事：
//
//   1. 校准松紧：你说「算」的都命中很多词、说「不算」的都命中很少？那把「命中几个
//      才算」这条线调对。这往往比补词更管用——第一轮实测 18 篇「太宽」，病根就在这。
//   2. 补词：判据太窄的，从你判「算」但系统没认出的论文里长新词；太宽的，找排除
//      信号（带撞车闸门）。
//   3. 换一批：标过的不再问你，但他没标过的、按新判据更贴边的，会拉一批新的来。
//
// Usage:
//   node bench/refine.mjs --pack <包名> [--cap 400]

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { candidateTerms, escapeRe, refineAgainstPool, termsOf } from './lib/terms.mjs';
import { evaluate } from './lib/criteria.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = 'https://api.openalex.org/works';
const CACHE_DIR = path.join(ROOT, '.cache', 'openalex');

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PACK_ID = argValue('--pack', '').trim();
const CAP = Math.max(100, Math.min(1000, Number(argValue('--cap', '400')) || 400));
const PICK = Math.max(10, Math.min(200, Number(argValue('--pick', '50')) || 50));
if (!PACK_ID) fail('用法：node bench/refine.mjs --pack <包名>');

const PACK_DIR = path.join(ROOT, 'packs', PACK_ID);
if (!fs.existsSync(PACK_DIR)) fail(`packs/${PACK_ID} 不存在。`);

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

// ── 基础设施 ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeDoi = (v) => String(v ?? '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '');
const SAFE_DOI = /^10\.[0-9]{4,9}\/[A-Za-z0-9._;()/:+-]+$/;
const cacheFile = (url) => path.join(CACHE_DIR, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);

async function api(url) {
  try {
    const hit = JSON.parse(fs.readFileSync(cacheFile(url), 'utf8'));
    if (hit) return hit;
  } catch { /* 没缓存 */ }
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'criteria-compiler-refine/0.2' }, signal: controller.signal });
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

/** 与 start.mjs 共用同一套缓存键，题录可以互相复用。 */
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
    await sleep(200);
    if (results.length < 100) break;
  }
  return works;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.some((v) => v && v.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

/** 版本号最大的一份。第一版叫 draft.json，之后 draft-v2.json… */
function latestArtifact(dir, base, ext) {
  let best = null;
  let bestVersion = -1;
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(new RegExp(`^${base}(?:-v(\\d+))?\\.${ext}$`));
    if (!match) continue;
    const version = match[1] ? Number(match[1]) : 1;
    if (version > bestVersion) { bestVersion = version; best = path.join(dir, name); }
  }
  return best;
}

function allQueues(dir) {
  return fs.readdirSync(dir)
    .filter((name) => /^review-queue(?:-v\d+)?\.csv$/.test(name))
    .map((name) => path.join(dir, name));
}

const csvEscape = (value) => `"${String(value ?? '').replace(/"/g, "'")}"`;

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const draftPath = latestArtifact(PACK_DIR, 'draft', 'json');
  const queuePath = latestArtifact(PACK_DIR, 'review-queue', 'csv');
  if (!draftPath) fail(`packs/${PACK_ID} 下没有 draft.json。先用 start.mjs 起草。`);
  if (!queuePath) fail(`packs/${PACK_ID} 下没有 review-queue*.csv。`);

  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  const queue = parseCsv(fs.readFileSync(queuePath, 'utf8'));

  const terms = (draft.mustHave ?? []).map((m) => (typeof m === 'string' ? m : m.term));
  const notTerms = draft.mustNot ?? [];
  const currentMinHits = draft.decision?.minHits ?? 1;

  const labeled = queue.filter((row) => ['2', '0', '1'].includes(String(row.verdict ?? '').trim()));
  const unlabeled = queue.filter((row) => !['2', '0', '1'].includes(String(row.verdict ?? '').trim()));

  console.log(`\n闭环 · ${PACK_ID}  （读 ${path.basename(draftPath)} / ${path.basename(queuePath)}）`);
  console.log('─'.repeat(72));
  console.log(`队列 ${queue.length} 篇｜已标 ${labeled.length} 篇｜未标 ${unlabeled.length} 篇｜当前阈值 ≥${currentMinHits} 个区分词`);

  // 没有标注也允许跑——那就是「只按新判据重拉一批」。
  // 改完判据之后最常做的就是这个动作：旧队列是按上一版挑的，已经过期了。
  const hasLabels = labeled.length > 0;
  if (!hasLabels) {
    console.log('');
    console.log('  这份队列还没有标注 → 跳过学习和校准，只按当前判据重新拉一批。');
    console.log('  想让它学，就先把上一轮的队列标完。');
  }

  const works = await loadWorks(queue.map((row) => row.doi));
  const textOf = (doi) => {
    const work = works.get(doi);
    return work ? `${work.title} ${work.abstract}`.toLowerCase() : '';
  };

  // 判定规则先定义，后面两处（留一检验、本轮分桶）都要用它。
  //
  // 如果草案里有结构化的 criteria（含共现 / 排除），优先用它，而不是数词频。
  // 为什么要「至少两条判据同时中」才算：单条 any 判据就是一张词表，几乎什么都沾边；
  // 真正有信息量的是**不同判据之间互相印证**。这条也是给用户留的口子——
  // 他可以直接编辑 draft.json 里的 criteria，人给概念，机器只做记账。
  const criteria = Array.isArray(draft.criteria) && draft.criteria.length ? draft.criteria : null;
  const guessAt = (doi, k) => terms.filter((t) => textOf(doi).includes(t)).length >= k;
  const decideWith = (doi, k) => {
    if (!criteria) return guessAt(doi, k);
    const results = evaluate(criteria, textOf(doi));
    const exclusion = results.find((r) => r.kind === 'absent');
    if (exclusion && !exclusion.matched) return false; // 踩到排除信号，直接不算
    const coOccur = results.filter((r) => r.kind === 'co-occur');
    // 有共现判据就以共现为准；没有才退回 any。与 bench/try.mjs 保持一致。
    return coOccur.length ? coOccur.some((r) => r.matched) : results.some((r) => r.kind !== 'absent' && r.matched);
  };

  // ── 1. 校准松紧 ───────────────────────────────────────────────────────────
  // 「命中一个词就算」几乎一定太松：一个领域里到处都是相关的词。
  // 你标过的每一篇都给了一个「命中几个」的数，这些数天然分成了两堆。
  const observations = labeled
    .filter((row) => String(row.verdict).trim() !== '1')
    .map((row) => ({ doi: row.doi, said: String(row.verdict).trim() === '2', hits: terms.filter((t) => textOf(row.doi).includes(t)).length }));

  // 先量「上一版判据」在新标注上的表现 —— 这才是真正的检验。
  // 用同一批标注调完阈值再在同一批上测，只会得到虚高的数字（第一版就是 96%，假的）。
  const incomingBuckets = { tp: 0, tn: 0, fn: 0, fp: 0 };
  for (const row of labeled) {
    const verdict = String(row.verdict).trim();
    if (verdict === '1') continue;
    const said = verdict === '2';
    const guessed = decideWith(row.doi, currentMinHits);
    if (said && guessed) incomingBuckets.tp++;
    else if (!said && !guessed) incomingBuckets.tn++;
    else if (said) incomingBuckets.fn++;
    else incomingBuckets.fp++;
  }
  const incomingAgreed = incomingBuckets.tp + incomingBuckets.tn;
  const incomingTotal = incomingAgreed + incomingBuckets.fn + incomingBuckets.fp;

  let bestK = currentMinHits;
  let bestAgreed = -1;
  if (observations.length && !criteria) {
    const maxHits = Math.max(...observations.map((o) => o.hits), 1);
    for (let k = 1; k <= maxHits + 1; k++) {
      const agreed = observations.filter((o) => (o.hits >= k) === o.said).length;
      if (agreed > bestAgreed) { bestAgreed = agreed; bestK = k; }
    }
  }
  const buckets = { tp: [], tn: [], fn: [], fp: [], unsure: [] };
  for (const row of labeled) {
    const verdict = String(row.verdict).trim();
    if (verdict === '1') { buckets.unsure.push(row); continue; }
    const said = verdict === '2';
    const guessed = decideWith(row.doi, bestK);
    if (said && guessed) buckets.tp.push(row);
    else if (!said && !guessed) buckets.tn.push(row);
    else if (said && !guessed) buckets.fn.push(row);
    else buckets.fp.push(row);
  }

  const agreed = buckets.tp.length + buckets.tn.length;
  const total = agreed + buckets.fn.length + buckets.fp.length;
  const rate = total ? agreed / total : 0;

  const incomingPos = incomingBuckets.tp + incomingBuckets.fn;
  const incomingRecall = incomingPos ? incomingBuckets.tp / incomingPos : null;

  console.log('');
  console.log(`  上一版判据在你这次新标的 ${incomingTotal} 篇上：`);
  console.log(`    抓到 ${incomingBuckets.tp}/${incomingPos} 篇「算」${incomingRecall === null ? '' : `（召回 ${Math.round(incomingRecall * 100)}%）`}｜误判 ${incomingBuckets.fp} 篇「不算」为算`);
  // 只有 1 篇正例时，「全部判不算」就能拿到很高的总一致率——这个数不能当成绩报。
  if (incomingPos < 3) {
    console.log(`    ⚠️ 这批只有 ${incomingPos} 篇正例，一致率不可信：把所有论文都判「不算」也能拿到 ${Math.round(((incomingTotal - incomingPos) / Math.max(incomingTotal, 1)) * 100)}%。`);
    console.log('       要多标几篇「算」进来，这个数才有意义。');
  }
  console.log(`  本轮校准后（同一批，会虚高）：一致 ${agreed}/${total}（${Math.round(rate * 100)}%）  ← 这是拟合`);
  console.log(`  太窄 ${buckets.fn.length}｜太宽 ${buckets.fp.length}｜说不好 ${buckets.unsure.length}`);
  if (bestK !== currentMinHits) {
    console.log(`校准：阈值从 ≥${currentMinHits} 改成 ≥${bestK} 个区分词（拿你标过的 ${observations.length} 篇试出来的）`);
  } else {
    console.log(`校准：阈值 ≥${bestK} 已经是最优，不动`);
  }

  // ── 2. 补词 ───────────────────────────────────────────────────────────────
  const mustSet = new Set(terms);
  const notSet = new Set(notTerms);
  const worksOf = (rows) => rows.map((r) => works.get(r.doi)).filter(Boolean);

  const negHas = new Set();
  for (const work of worksOf([...buckets.tn, ...buckets.fp])) for (const term of termsOf(work)) negHas.add(term);
  const fnCandidates = buckets.fn.length
    ? candidateTerms(worksOf(buckets.fn), { exclude: negHas, limit: 20 }).filter((c) => !mustSet.has(c.term))
    : [];
  const fnPicked = fnCandidates.length ? refineAgainstPool(fnCandidates, worksOf(queue), { keep: 6 }) : [];

  const posHas = new Set();
  for (const work of worksOf([...buckets.tp, ...buckets.fn])) for (const term of termsOf(work)) posHas.add(term);
  const fpCandidates = buckets.fp.length
    ? candidateTerms(worksOf(buckets.fp), { exclude: posHas, limit: 20 }).filter((c) => !notSet.has(c.term))
    : [];
  // 硬闸门：已经在「算」词表里的词，绝不进排除项。两批论文共享同一领域词汇
  // （donor / acceptor / charge 就是），没有这道闸门，第一次闭环就把判据打死。
  const collided = fpCandidates.filter((c) => mustSet.has(c.term)).map((c) => c.term);
  const safeFp = fpCandidates.filter((c) => !mustSet.has(c.term));
  // 排除信号比区分词危险得多：阈值固定 12%、不放宽、最多 4 条。
  const fpPicked = safeFp.length ? refineAgainstPool(safeFp, worksOf(queue), { keep: 4, thresholds: [0.12], strict: true }) : [];

  const addedMust = fnPicked.map((c) => ({ term: c.term, from: `${buckets.fn.length} 篇你判「算」但系统没认出的论文`, poolFrequency: Number(c.df.toFixed(3)) }));
  const addedNot = fpPicked.map((c) => ({ term: c.term, from: `${buckets.fp.length} 篇你判「不算」但系统认出的论文`, poolFrequency: Number(c.df.toFixed(3)) }));

  const nextMust = [...(draft.mustHave ?? []), ...addedMust];
  const nextNot = [...notTerms, ...addedNot.map((a) => a.term)];
  const allTerms = nextMust.map((m) => (typeof m === 'string' ? m : m.term));

  // criteria 也要跟着更新：core-any 换成新词表、exclusion 换成新的排除项，
  // 共现判据原样保留（它们是人给的，机器不擅自改）。
  const nextCriteria = (draft.criteria ?? []).map((criterion) => {
    if (criterion.id === 'core-any') return { ...criterion, terms: allTerms.slice(0, 10) };
    if (criterion.kind === 'absent') return { ...criterion, terms: nextNot.slice(0, 6) };
    return criterion;
  });

  const next = {
    ...draft,
    version: (draft.version ?? 1) + 1,
    mustHave: nextMust,
    mustNot: nextNot,
    criteria: nextCriteria,
    decision: { minHits: bestK, calibratedFrom: observations.length },
    checks: (draft.checks ?? []).map((check) => {
      if (check.id === 'core-terms') return { ...check, pattern: allTerms.slice(0, 10).map(escapeRe).join('|') };
      if (check.id === 'negative-marker' && nextNot.length) return { ...check, pattern: nextNot.slice(0, 6).map(escapeRe).join('|') };
      return check;
    }),
    revision: {
      date: new Date().toISOString().slice(0, 10),
      basedOn: { labeled: labeled.length, agreed, tooNarrow: buckets.fn.length, tooWide: buckets.fp.length },
      minHits: bestK,
      addedTerms: [...addedMust, ...addedNot],
    },
  };
  fs.writeFileSync(path.join(PACK_DIR, `draft-v${next.version}.json`), JSON.stringify(next, null, 2) + '\n', 'utf8');

  console.log('\n改了什么');
  console.log('─'.repeat(72));
  console.log(`  松紧：命中 ≥${bestK} 个区分词才算（原来 ≥${currentMinHits}）`);
  for (const item of addedMust) console.log(`  + ${item.term}  （${item.from}，背景池 ${(item.poolFrequency * 100).toFixed(1)}%）`);
  for (const item of addedNot) console.log(`  − ${item.term}  （${item.from}，背景池 ${(item.poolFrequency * 100).toFixed(1)}%）`);
  if (collided.length) console.log(`  ⚠️ 挡下 ${collided.length} 个和区分词撞车的排除候选：${collided.join('、')}`);

  // ── 3. 换一批新的来标 ─────────────────────────────────────────────────────
  // 只在旧队列里重排是不行的：标完就没了，第二轮无从谈起。
  const seen = new Set();
  for (const file of allQueues(PACK_DIR)) for (const row of parseCsv(fs.readFileSync(file, 'utf8'))) seen.add(normalizeDoi(row.doi));
  for (const row of labeled) seen.add(normalizeDoi(row.doi));
  for (const doi of draft.examples?.positive ?? []) seen.add(normalizeDoi(doi));
  for (const doi of draft.examples?.negative ?? []) seen.add(normalizeDoi(doi));

  console.log(`\n正在按新判据拉下一批（已看过 ${seen.size} 篇会跳过）……`);
  const pool = allTerms.length ? await fetchPool(allTerms.slice(0, 8), CAP) : [];
  // 选样本和判样本必须是同一套规则。
  // 之前这里按「命中几个词」挑，而 try / refine 的判定按 criteria —— 两套规则，
  // 结果就是「试的时候对得上，拉出来的队列却不对路」。这里统一到 criteria。
  const negRe = nextNot.length ? new RegExp(nextNot.map(escapeRe).join('|'), 'i') : null;
  const fresh = pool.filter((work) => !seen.has(work.doi) && !labeled.some((row) => normalizeDoi(row.doi) === work.doi));

  const scoreByCriteria = (text) => {
    const results = evaluate(next.criteria ?? [], text);
    const violated = results.some((r) => r.kind === 'absent' && !r.matched);
    const coOccur = results.filter((r) => r.kind === 'co-occur');
    const positives = results.filter((r) => r.kind !== 'absent' && r.matched);
    const said = coOccur.length ? coOccur.some((r) => r.matched) : positives.length > 0;

    let score = 0;
    let why = '与当前判据无关';
    if (violated && said) { score = 5; why = '判据内部打架：有正向命中，但也踩到排除信号'; }
    else if (violated) { score = 1; why = '只踩到排除信号'; }
    else if (said && coOccur.some((r) => r.matched)) { score = 4; why = '共现判据命中——贴着概念边界'; }
    else if (said && positives.length < (next.criteria ?? []).filter((c) => c.kind !== 'absent').length) { score = 3; why = '只中部分正向判据，贴在边界'; }
    else if (said) { score = 2; why = '当前判据最确定的一批'; }
    return { score, why, said, hits: positives.length };
  };

  const reranked = fresh
    .map((work) => {
      const text = `${work.title} ${work.abstract}`;
      const { score, why, hits } = scoreByCriteria(text);
      return { ...work, score, why, hits, neg: negRe ? negRe.test(text) : false };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => (b.score - a.score) || (b.hits - a.hits) || (b.cited - a.cited));

  // 旧队列里没标的，只有「在新判据下仍然命中」的才带过来。
  // 判据收窄之后，旧的未标条目是按老判据挑的，带过来就是污染。
  const carried = unlabeled.filter((row) => {
    const text = textOf(row.doi);
    if (!text) return false;
    const results = evaluate(criteria ?? [], text);
    const violated = results.some((r) => r.kind === 'absent' && !r.matched);
    if (violated) return false;
    const coOccur = results.filter((r) => r.kind === 'co-occur');
    return coOccur.length ? coOccur.some((r) => r.matched) : results.some((r) => r.kind !== 'absent' && r.matched);
  }).map((row) => ({ ...row, why: `${row.why}（上一轮遗留，新判据下仍命中）`, score: 2 }));

  const merged = [...reranked, ...carried]
    .sort((a, b) => (b.score - a.score) || ((b.hits ?? 0) - (a.hits ?? 0)))
    .slice(0, PICK);

  const csv = ['doi,title,year,cited,why,verdict', ...merged.map((r) => [r.doi, csvEscape(r.title), r.year ?? '', r.cited ?? '', csvEscape(r.why), ''].join(','))];
  fs.writeFileSync(path.join(PACK_DIR, `review-queue-v${next.version}.csv`), `${csv.join('\n')}\n`, 'utf8');

  // ── 归档 + 趋势 ───────────────────────────────────────────────────────────
  const record = {
    round: next.version - 1,
    date: new Date().toISOString().slice(0, 10),
    draft: path.basename(draftPath),
    labeled: labeled.length,
    agreed,
    tooNarrow: buckets.fn.length,
    tooWide: buckets.fp.length,
    unsure: buckets.unsure.length,
    agreement: Number(((incomingTotal ? incomingAgreed / incomingTotal : 0)).toFixed(3)),
    recall: incomingRecall === null ? null : Number(incomingRecall.toFixed(3)),
    positives: incomingPos,
    agreementInSample: Number(rate.toFixed(3)),
    minHits: bestK,
    addedMust: addedMust.length,
    addedNot: addedNot.length,
    nextQueue: merged.length,
  };
  const historyPath = path.join(PACK_DIR, 'history.jsonl');
  fs.appendFileSync(historyPath, JSON.stringify(record) + '\n', 'utf8');

  console.log(`  下一轮队列 ${merged.length} 篇（新拉 ${reranked.length} 中取 + 上轮遗留 ${carried.length}）→ review-queue-v${next.version}.csv`);
  console.log(`  这批标过的 ${labeled.length} 篇不会再问你。`);

  const history = fs.readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  console.log('\n跨轮趋势');
  console.log('─'.repeat(72));
  console.log('  轮  已标  正例  抓到  太窄  太宽  阈值  召回  补词  下一轮');
  for (const item of history) {
    console.log(
      `  ${String(item.round).padStart(2)}  ${String(item.labeled).padStart(4)}  ${String(item.positives ?? 0).padStart(4)}  ` +
      `${String(item.recall === null || item.recall === undefined ? '—' : `${Math.round(item.recall * 100)}%`).padStart(4)}  ` +
      `${String(item.tooNarrow).padStart(4)}  ${String(item.tooWide).padStart(4)}  ${String(item.minHits).padStart(4)}  ` +
      `${String(item.addedMust + item.addedNot).padStart(4)}  ${String(item.nextQueue).padStart(6)}`,
    );
  }
  if (history.length >= 2) {
    const first = history[0];
    const last = history[history.length - 1];
    const r0 = first.recall;
    const r1 = last.recall;
    if (r0 === null || r1 === null) {
      console.log('\n  召回算不出来（两轮里有轮没有正例），趋势无从判断。');
    } else {
      const delta = Math.round((r1 - r0) * 100);
      console.log(`\n  ${delta > 0 ? '↑' : delta < 0 ? '↓' : '→'} 召回 ${Math.round(r0 * 100)}% → ${Math.round(r1 * 100)}%（${delta >= 0 ? '+' : ''}${delta} 个点）`);
      if (delta <= 0) console.log('    没升。要么补的词不对路，要么这两轮的样本难度不一样。');
    }
  } else {
    console.log('\n  只有一轮，比不出趋势。把新队列标完再跑一次。');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
