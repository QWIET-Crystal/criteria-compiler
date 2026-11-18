#!/usr/bin/env node
// 漏检账：把「漏了什么」变成一条条可追溯的记录，而不是一个数字。
//
// 这是这个项目真正跟别人分开的地方。别人的覆盖率是个数，我们的是一次一条的账：
// **这篇漏了、漏在哪条查询之外、被哪条查询救回来、还是根本救不回来。**
//
// 一条硬规矩（防过拟合，写在代码里）：**一条归因只涉及 1 篇时，不升格成修正。**
// 单篇就改判据，是在奖励噪音。要升格，至少两篇不同论文落在同一个归因上。
//
// Usage:
//   node bench/ledger.mjs --pack cof-h2o2 [--cap 1000]

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = 'https://api.openalex.org/works';
const CACHE_DIR = path.join(ROOT, '.cache', 'openalex');
const PER_PAGE = 100;
const MAX_PAGES = 10;

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PACK_ARG = argValue('--pack', '');
// 既接受包名（cof-h2o2），也接受路径（packs/cof-h2o2）：两种都有人这么写。
const PACK_DIR = (() => {
  const raw = PACK_ARG || 'cof-h2o2';
  const asPath = path.resolve(raw);
  if (fs.existsSync(path.join(asPath, 'pack.json'))) return asPath;
  const underPacks = path.join(ROOT, 'packs', raw);
  if (fs.existsSync(path.join(underPacks, 'pack.json'))) return underPacks;
  return asPath;
})();
const CAP = Math.max(100, Math.min(2000, Number(argValue('--cap', '1000')) || 1000));
const MAILTO = argValue('--mailto', process.env.OPENALEX_MAILTO || '');
const API_KEY = argValue('--api-key', process.env.OPENALEX_API_KEY || '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeDoi = (v) => String(v ?? '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '');
const canonicalDoi = (doi) => normalizeDoi(doi).replace(/\bange\./, 'anie.');
const SAFE_DOI = /^10\.[0-9]{4,9}\/[A-Za-z0-9._;()/:+-]+$/;
const cacheFile = (url) => path.join(CACHE_DIR, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);

const fail = (message) => { console.error(`\n${message}\n`); process.exit(1); };

async function api(url) {
  try { const hit = JSON.parse(fs.readFileSync(cacheFile(url), 'utf8')); if (hit) return hit; } catch { /* 没缓存 */ }
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'criteria-compiler-ledger/0.1' }, signal: controller.signal });
      if (res.status === 200) {
        const data = await res.json();
        try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cacheFile(url), JSON.stringify(data), 'utf8'); } catch { /* best effort */ }
        return data;
      }
      if (res.status === 429) { await sleep(4000 * (attempt + 1)); continue; }
      return null;
    } catch { return null; } finally { clearTimeout(timer); }
  }
  return null;
}

// 与 run.mjs 完全相同的 URL 形状，这样缓存能直接命中——账本是重放，不是重跑。
function workUrl(search, page, perPage = PER_PAGE) {
  const params = new URLSearchParams({
    filter: `title_and_abstract.search:${search}`,
    'per-page': String(Math.min(perPage, 100)),
    page: String(page),
    select: 'doi,title,publication_year,cited_by_count',
  });
  if (MAILTO) params.set('mailto', MAILTO);
  if (API_KEY) params.set('api_key', API_KEY);
  return `${API}?${params.toString()}`;
}

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.some((v) => v && v.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

/** 跑一条查询，返回它命中的 DOI 集合（受 cap 限制）。 */
async function hitsOf(query) {
  const keys = new Set();
  let total = 0;
  try {
    const head = await api(workUrl(query, 1));
    total = head.meta?.count ?? 0;
    for (const w of head.results ?? []) keys.add(canonicalDoi(normalizeDoi(w.doi)));
    const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(Math.min(total, CAP) / PER_PAGE)));
    for (let page = 2; page <= pages; page++) {
      const data = await api(workUrl(query, page));
      for (const w of data?.results ?? []) keys.add(canonicalDoi(normalizeDoi(w.doi)));
      await sleep(200);
    }
  } catch { /* 单条查询失败不该让整本账作废 */ }
  return { keys, total };
}

async function main() {
  const packFile = path.join(PACK_DIR, 'pack.json');
  if (!fs.existsSync(packFile)) fail(`${PACK_DIR} 下没有 pack.json`);
  const pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
  if (!pack.gold) fail(`pack ${pack.id} 是 retrieval-only，没有金集，记不了账。`);

  const goldPath = path.resolve(PACK_DIR, pack.gold);
  const gold = parseCsv(fs.readFileSync(goldPath, 'utf8'));
  const positives = gold.filter((g) => Number(g.label) === 2);
  if (!positives.length) fail('金集里没有阳性，账本无从记起。');

  // 查询从 run.mjs 的 --json 里取，不自己拼。
  // 自己拼一套就会和基准分叉——账本一旦和基准说的不是同一批查询，账就是假的。
  let run;
  const from = argValue('--from', '');
  if (from) {
    run = JSON.parse(fs.readFileSync(path.resolve(from), 'utf8'));
  } else {
    process.stderr.write('  正在用 run.mjs 解析查询（走本地缓存）…\n');
    const stdout = execFileSync(process.execPath, [path.join(HERE, 'run.mjs'), '--json', '--quiet', '--cap', String(CAP)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    run = JSON.parse(stdout);
  }
  if (!run?.stages?.length) fail('run.mjs 没有返回 stages，账本无从记起。');

  const extraByQuery = new Map((pack.extraQueries ?? []).map((e) => [e.query, e]));
  const sources = [];
  const seenQuery = new Set();
  for (const stage of run.stages) {
    (stage.perQuery ?? []).forEach((item, i) => {
      if (seenQuery.has(item.query)) return;
      seenQuery.add(item.query);
      const extra = extraByQuery.get(item.query);
      sources.push({
        stage: extra ? 'correction' : stage.stage,
        label: stage.label,
        id: extra ? extra.id : `${stage.stage}·${i + 1}`,
        query: item.query,
        why: extra?.why ?? null,
      });
    });
  }

  console.log(`\n漏检账 · ${pack.id}`);
  console.log('─'.repeat(78));
  console.log(`金集阳性 ${positives.length} 篇｜查询 ${sources.length} 条（按声明顺序重放）`);

  const coverage = new Map(); // queryId -> Set(doi)
  for (const source of sources) {
    const { keys, total } = await hitsOf(source.query);
    coverage.set(source.id, keys);
    process.stderr.write(`  ${source.id.padEnd(22)} 命中 ${String(total).padStart(6)} 篇\n`);
  }

  const records = positives.map((row) => {
    const doi = canonicalDoi(normalizeDoi(row.doi));
    const hits = sources.filter((s) => coverage.get(s.id)?.has(doi));
    const first = hits[0] ?? null;
    return {
      doi,
      title: row.note ? `${row.doi}（${row.note}）` : row.doi,
      status: first ? 'recovered' : 'still_missing',
      first_query: first ? first.id : null,
      first_stage: first ? first.stage : null,
      reason: first
        ? { kind: first.stage === 'correction' ? 'correction' : 'axis', id: first.id, why: first.why ?? first.label }
        : { kind: 'unknown', id: null, why: '所有声明过的查询都没把它拉回来' },
      hit_by: hits.map((s) => s.id),
    };
  });

  // ── 归因聚类 ──────────────────────────────────────────────────────────────
  const byReason = new Map();
  for (const record of records) {
    const key = record.first_query ?? '__unknown__';
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key).push(record);
  }

  console.log('\n逐篇');
  console.log('─'.repeat(78));
  for (const record of records) {
    const where = record.status === 'recovered' ? `首次召回 ${record.first_query}` : '仍然漏';
    console.log(`  ${record.status === 'recovered' ? '✓' : '✗'} ${record.doi.padEnd(30)} ${where}`);
    console.log(`     命中它的查询：${record.hit_by.length ? record.hit_by.join('、') : '（无）'}`);
  }

  console.log('\n归因');
  console.log('─'.repeat(78));
  const promotable = [];
  for (const [key, group] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (key === '__unknown__') {
      console.log(`  ⚠️ ${group.length} 篇没有任何查询能拉回来 —— 这一类我们解释不了，不假装解释。`);
      continue;
    }
    const source = sources.find((s) => s.id === key);
    const kind = source?.stage === 'correction' ? '修正项' : '检索轴';
    console.log(`  ${kind} ${key} 救回 ${group.length} 篇：${group.map((r) => r.doi).join('、')}`);
    if (source?.why) console.log(`     它的理由：${source.why}`);
    if (group.length >= 2) promotable.push({ id: key, kind, count: group.length, dois: group.map((r) => r.doi) });
  }

  // ── 升格建议（带防过拟合闸门） ────────────────────────────────────────────
  console.log('\n升格建议');
  console.log('─'.repeat(78));
  if (!promotable.length) {
    console.log('  没有。每条归因都只涉及 1 篇——按规矩，单篇不升格。');
    console.log('  单篇就改判据，是在奖励噪音；这条规矩写在代码里，不靠自觉。');
  } else {
    for (const item of promotable) {
      console.log(`  ${item.kind} ${item.id} 涉及 ${item.count} 篇，够格升格成一条独立修正。`);
      console.log(`     升格前必须重跑 bench/run.mjs：新修正在拉回这几篇的同时，不能把原本在池子里的阳性挤出去。`);
    }
  }

  const ledger = {
    pack: pack.id,
    generatedAt: new Date().toISOString(),
    cap: CAP,
    positives: positives.length,
    recovered: records.filter((r) => r.status === 'recovered').length,
    stillMissing: records.filter((r) => r.status === 'still_missing').length,
    sources: sources.map((s) => ({ id: s.id, stage: s.stage, query: s.query, why: s.why ?? null })),
    records,
    promotable,
  };
  const out = path.join(PACK_DIR, 'ledger.json');
  fs.writeFileSync(out, JSON.stringify(ledger, null, 2) + '\n', 'utf8');

  console.log('\n小结');
  console.log('─'.repeat(78));
  console.log(`  能召回的 ${ledger.recovered}/${ledger.positives}｜仍漏 ${ledger.stillMissing}`);
  // 欠拟合防线：漏太多不是「再补一条修正好」，是「这套判据还没覆盖住这个领域」。
  // 明说，别用一条条修补掩盖整体不足。
  const missingRatio = ledger.stillMissing / ledger.positives;
  if (missingRatio > 0.4) {
    console.log(`  ❌ 漏了 ${Math.round(missingRatio * 100)}%，覆盖面明显不足。别急着发——这不是补一条修正能解决的，是判据整体还没覆盖住这个领域。`);
  }
  const fallbackStages = (pack.stages ?? []).filter((s) => s.doiFallback).map((s) => s.id);
  if (fallbackStages.length && ledger.stillMissing > 0) {
    console.log(`  ⚠️ 剩下 ${ledger.stillMissing} 篇，只有 DOI 兜底直查能拿到（阶段 ${fallbackStages.join('、')}）。`);
    console.log('     兜底不是检索能力——账本不把它记成召回。这就是为什么报告里两个数不一样。');
  }
  console.log('  这是**下界**，不是覆盖率：分母只有手上这几篇已知文献。');
  console.log(`  账本：${path.relative(ROOT, out)}`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
