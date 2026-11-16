#!/usr/bin/env node
// 轴产出体检：在**没有金集**的前提下，回答一个问题——
// 「这几条检索轴，到底是各自拉回了一类东西，还是大家拉的是同一批？」
//
// 为什么需要它：多轴召回是这个项目唯一一条被数据钉死的结论，但那条结论是在 COF
// 上测出来的。换一个领域之前，先得知道那个领域的轴是不是真的分得开——如果七条轴
// 拉回来的几乎重合，再多轴也只是在同一个池子里打转。
//
// 不需要金集：它只跑到「每条轴各拿到什么」为止，不判对错。
// 有金集时额外报「这条轴独有的阳性」——那才是真正承重的轴。
//
// Usage:
//   node bench/axis-yield.mjs                            # 默认 packs/cof-h2o2
//   node bench/axis-yield.mjs --pack packs/cv-finance-esg
//   node bench/axis-yield.mjs --pack packs/cv-finance-esg --cap 300 --json

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
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
const AS_JSON = argv.includes('--json');
const CAP = Math.max(100, Math.min(2000, Number(argValue('--cap', '1000')) || 1000));
const TIMEOUT_MS = Math.max(3000, Math.min(60000, Number(argValue('--timeout', '15000')) || 15000));
const MAILTO = argValue('--mailto', process.env.OPENALEX_MAILTO || '');
const API_KEY = argValue('--api-key', process.env.OPENALEX_API_KEY || '');

const PACK_ARG = argValue('--pack', '');
const PACK_DIR = PACK_ARG ? path.resolve(PACK_ARG) : path.join(ROOT, 'packs', 'cof-h2o2');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 安全：词要拼进检索式，只放行白名单字符 ────────────────────────────────────
// 与 packages/core/src/pack.ts 的 assertSafeTerm 保持一致。
const SAFE_TERM = /^[\p{L}\p{N}\s\-.,()+/'’·]+$/u;
function assertSafeTerm(term) {
  const value = String(term ?? '').trim();
  if (!value) throw new Error('pack term is empty');
  if (value.length > 80) throw new Error(`pack term is longer than 80 characters`);
  if (!SAFE_TERM.test(value)) throw new Error(`pack term can break the query grammar: ${JSON.stringify(value)}`);
  return value;
}
const quote = (t) => `"${assertSafeTerm(t)}"`;
const orExpr = (terms) => `(${terms.map(quote).join(' OR ')})`;

// ── pack ────────────────────────────────────────────────────────────────────
function loadPack(dir) {
  const file = path.join(dir, 'pack.json');
  if (!fs.existsSync(file)) throw new Error(`no pack.json in ${dir}`);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['id', 'dimensions', 'stages']) {
    if (!pack[key]) throw new Error(`pack ${dir}: missing "${key}"`);
  }
  return pack;
}

const slotsOf = (pack) => pack.slots ?? (pack.object ? [{ id: pack.object.id ?? 'object', terms: pack.object.terms }] : []);
const slotExpr = (pack) => slotsOf(pack).map((slot) => orExpr(slot.terms)).join(' AND ');
const axisExpr = (pack, dim) => `${orExpr(dim.terms)} AND ${slotExpr(pack)}`;

function loadGold(dir, pack) {
  if (!pack.gold) return null;
  const file = path.resolve(dir, pack.gold);
  if (!fs.existsSync(file)) return null;
  const [header, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const columns = header.split(',');
  const doiAt = columns.indexOf('doi');
  const labelAt = columns.indexOf('label');
  if (doiAt < 0 || labelAt < 0) return null;
  return lines.filter(Boolean).map((line) => {
    const cells = line.split(',');
    return { doi: normalizeDoi(cells[doiAt]), positive: Number(cells[labelAt]) === 2 };
  });
}

// ── HTTP（与 run.mjs 同款缓存与参数，跨脚本可复用已抓到的结果） ──────────────
const normalizeDoi = (v) => String(v ?? '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '');
const canonicalDoi = (doi) => normalizeDoi(doi).replace(/\bange\./, 'anie.');
const cacheFile = (url) => path.join(CACHE_DIR, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);
const cacheRead = (url) => {
  try { return JSON.parse(fs.readFileSync(cacheFile(url), 'utf8')); } catch { return null; }
};
const cacheWrite = (url, data) => {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cacheFile(url), JSON.stringify(data), 'utf8'); } catch { /* best effort */ }
};

function workUrl(search, page) {
  const params = new URLSearchParams({
    filter: `title_and_abstract.search:${search}`,
    'per-page': String(PER_PAGE),
    page: String(page),
    select: 'doi,title,publication_year,cited_by_count',
  });
  if (MAILTO) params.set('mailto', MAILTO);
  if (API_KEY) params.set('api_key', API_KEY);
  return `${API}?${params.toString()}`;
}

async function api(url) {
  const cached = cacheRead(url);
  if (cached) return cached;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'criteria-compiler-axis-yield/0.1' }, signal: controller.signal });
      if (res.status === 200) {
        const data = await res.json();
        cacheWrite(url, data);
        return data;
      }
      if (res.status === 429) {
        await sleep(Math.min(5000 * (attempt + 1), 20000));
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('request failed');
}

const keyOf = (work) =>
  canonicalDoi(normalizeDoi(work.doi)) || `title:${String(work.title ?? '').trim().toLowerCase().slice(0, 80)}`;

/** 只要总数：per-page=1，不拉正文。 */
function countUrl(search) {
  const params = new URLSearchParams({
    filter: `title_and_abstract.search:${search}`,
    'per-page': '1',
    select: 'doi',
  });
  if (MAILTO) params.set('mailto', MAILTO);
  if (API_KEY) params.set('api_key', API_KEY);
  return `${API}?${params.toString()}`;
}

async function countOf(search) {
  try {
    const data = await api(countUrl(search));
    return data.meta?.count ?? 0;
  } catch {
    return -1;
  }
}

async function yieldOfAxis(search) {
  const keys = new Set();
  let total = 0;
  let error = '';
  try {
    const head = await api(workUrl(search, 1));
    total = head.meta?.count ?? 0;
    for (const work of head.results ?? []) keys.add(keyOf(work));
    const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(Math.min(total, CAP) / PER_PAGE)));
    for (let page = 2; page <= pages; page++) {
      const data = await api(workUrl(search, page));
      for (const work of data.results ?? []) keys.add(keyOf(work));
      await sleep(250);
    }
  } catch (err) {
    error = err.message;
  }
  return { keys, total, error };
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const pack = loadPack(PACK_DIR);
  const dims = pack.dimensions ?? [];
  const gold = loadGold(PACK_DIR, pack);
  const positives = new Set((gold ?? []).filter((g) => g.positive).map((g) => g.doi));

  if (!AS_JSON) {
    console.log(`\n轴产出体检 · pack ${pack.id}`);
    console.log(`轴 ${dims.length} 条｜cap ${CAP}/轴｜金集 ${gold ? `${positives.size} 篇阳性` : '无（只报产出，不判对错）'}`);
    console.log('─'.repeat(84));
  }

  const rows = [];
  const seen = new Map(); // key -> 首个命中它的轴

  // ── 槽体检 ────────────────────────────────────────────────────────────────
  // 多槽是 AND 在一起的。如果两个槽在真实摘要里几乎不共现，AND 之后的池子会
  // 塌成一个很小的数——这时候再往上叠多少条轴，都只是在 350 篇里打转。
  const slots = slotsOf(pack);
  const slotCounts = [];
  for (const slot of slots) slotCounts.push({ id: slot.id, count: await countOf(orExpr(slot.terms)) });
  const andCount = slots.length > 1 ? await countOf(slots.map((slot) => orExpr(slot.terms)).join(' AND ')) : null;

  // 交叉率：AND 之后还剩多少。低于 1% 说明这两个槽在真实摘要里几乎不共现，
  // 池子不是被「轴」限制住的，是被槽的 AND 限制住的。
  const smallestSlot = slotCounts.length ? Math.min(...slotCounts.map((s) => s.count).filter((c) => c >= 0)) : 0;
  const crossRate = andCount && smallestSlot > 0 ? andCount / smallestSlot : null;

  if (!AS_JSON) {
    console.log('槽体检');
    for (const slot of slotCounts) console.log(`  ${String(slot.id).padEnd(14)}${String(slot.count).padStart(8)}  单独`);
    if (andCount !== null) {
      const pct = crossRate === null ? '?' : (crossRate * 100).toFixed(1);
      console.log(`  ${'两槽 AND'.padEnd(14)}${String(andCount).padStart(8)}  交叉率 ${pct}%`);
    } else {
      console.log('  单槽，无交叉问题');
    }
    console.log('─'.repeat(84));
  }

  for (const dim of dims) {
    const { keys, total, error } = await yieldOfAxis(axisExpr(pack, dim));
    let fresh = 0;
    for (const key of keys) {
      if (!seen.has(key)) { seen.set(key, dim.id); fresh++; }
    }
    const goldHit = [...keys].filter((key) => positives.has(key)).length;
    rows.push({ axis: dim.id, terms: dim.terms.length, total, fetched: keys.size, fresh, goldHit, keys, error });
  }

  // 「独有」= 这条轴拿到、别的轴都拿不到——去掉它 union 就会变小。
  // 先算完再删 keys：删早了后面几行会读到 undefined。
  for (const row of rows) {
    row.unique = [...row.keys].filter((key) => rows.filter((other) => other.keys.has(key)).length === 1).length;
    row.goldUnique = gold
      ? [...row.keys].filter((key) => positives.has(key) && rows.filter((other) => other.keys.has(key)).length === 1).length
      : null;
  }
  for (const row of rows) delete row.keys;

  const union = seen.size;
  const sum = rows.reduce((acc, row) => acc + row.fetched, 0);

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          pack: pack.id,
          cap: CAP,
          slots: slotCounts,
          slotsAnd: andCount,
          crossRate,
          union,
          sumFetched: sum,
          positives: positives.size,
          axes: rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  const pad = (s, n) => String(s).padEnd(n);
  const num = (v, n = 7) => String(v).padStart(n);
  console.log(`${pad('轴', 14)}${num('命中总数')}${num('实收')}${num('独有')}${num('新贡献')}${num('阳性')}${num('独有阳性')}`);
  for (const row of rows) {
    const goldUnique = row.goldUnique === null ? '—' : row.goldUnique;
    console.log(`${pad(row.axis, 14)}${num(row.total)}${num(row.fetched)}${num(row.unique)}${num(row.fresh)}${num(row.goldHit)}${num(goldUnique)}`);
    if (row.error) console.log(`   ⚠️ ${row.error}`);
  }
  console.log('─'.repeat(84));
  console.log(`并集 ${union} 篇｜各轴相加 ${sum} 篇｜重叠率 ${sum ? (((sum - union) / sum) * 100).toFixed(0) : 0}%`);

  // ── 体检结论 ──────────────────────────────────────────────────────────────
  const empty = rows.filter((row) => row.fetched === 0);
  const redundant = rows.filter((row) => row.fetched > 0 && row.unique === 0);
  const loadBearing = rows.filter((row) => row.goldUnique > 0);

  console.log('');
  if (crossRate !== null && crossRate < 0.01) {
    console.log(
      `❌ 槽交叉塌陷：两个槽各自几十万篇，AND 之后只剩 ${andCount} 篇（${(crossRate * 100).toFixed(1)}%）——\n` +
        `   这个领域的两个槽几乎不在同一篇摘要里同时出现。此时叠多少条轴，都只是在这 ${andCount} 篇里打转。`,
    );
  }
  if (empty.length) console.log(`❌ 空轴 ${empty.length} 条：${empty.map((r) => r.axis).join('、')} —— 这条轴没有拉回任何东西，要么词表写错，要么这个领域没有这类文献`);
  if (redundant.length) console.log(`⚠️  冗余轴 ${redundant.length} 条：${redundant.map((r) => r.axis).join('、')} —— 去掉它并集不变，它只是在重复别人`);
  if (loadBearing.length) console.log(`🔑 承重轴 ${loadBearing.length} 条：${loadBearing.map((r) => `${r.axis}(${r.goldUnique})`).join('、')} —— 只有它能捞回某些阳性，去掉就漏`);
  if (!empty.length && !redundant.length) console.log('✅ 没有空轴，也没有完全冗余的轴');

  if (!gold) {
    console.log('\n没有金集，所以只能说「轴分不分得开」，不能说「漏没漏」。');
    console.log('要判漏没漏，需要一份外部给的金集：把 10 篇人工判过的论文写进 gold.csv 再跑一次。');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
