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

import { evaluate } from './lib/criteria.mjs';
import { loadWorks, normalizeDoi as normDoi, worksFromCsv } from './lib/io.mjs';
import { CAUSES, readCauses, summariseCauses, writeCause } from './lib/causes.mjs';

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

/**
 * 判据账：拿一份草案里的 criteria，在已知阳性上跑一遍。
 *
 * 这不是检索账——它问的是「判据认不认得出这些我们已知该算的论文」。
 * 认出太少 = 判据太窄（欠拟合）；全认得出也不代表对，还要看它会不会乱认。
 *
 * 判定规则与 bench/try.mjs、bench/refine.mjs 完全一致。
 */
/**
 * --cause <doi> <cause> [--note "为什么"]：人工给一条漏检定原因。
 * 只认三类（见 lib/causes.mjs），因为只有三类，多一类就会变成新的垃圾桶。
 */
function recordCause(PACK_DIR, pack, positives) {
  const at = argv.indexOf('--cause');
  const doi = argv[at + 1];
  const cause = argv[at + 2];
  if (!doi || !cause) fail('用法：--cause <doi> <criterion|data|out_of_scope> [--note "为什么"]');
  if (!CAUSES[cause]) fail(`未知原因 "${cause}"。只能是：${Object.keys(CAUSES).join(' / ')}`);

  const known = positives.some((row) => normDoi(row.doi) === normDoi(doi));
  if (!known) fail(`${doi} 不在这份金集的阳性里。漏检原因只对阳性有意义。`);

  const all = writeCause(PACK_DIR, doi, cause, argValue('--note', ''));
  const entry = all[normDoi(doi)];
  console.log(`\n记下了 · ${pack.id}`);
  console.log('─'.repeat(78));
  console.log(`  ${doi}`);
  console.log(`  原因：${CAUSES[cause].label}`);
  console.log(`  含义：${CAUSES[cause].hint}`);
  if (entry.note) console.log(`  备注：${entry.note}`);
  console.log(`\n  存在 ${path.relative(ROOT, path.join(PACK_DIR, 'causes.json'))}，不进 gold.csv——`);
  console.log('  原因属于分析过程，不属于金标。');
}

async function criteriaCheck(criteriaPath, pack, positives) {
  const draft = JSON.parse(fs.readFileSync(path.resolve(criteriaPath), 'utf8'));
  const criteria = draft.criteria ?? [];
  if (!criteria.length) fail(`${criteriaPath} 里没有结构化 criteria。`);

  console.log(`\n判据账 · ${pack.id}`);
  console.log('─'.repeat(78));
  console.log(`用 ${path.relative(ROOT, path.resolve(criteriaPath))} 的 ${criteria.length} 条判据：`);
  for (const item of criteria) console.log(`  ${item.id}(${item.kind})  ${(item.terms ?? []).join('、')}`);
  console.log(`在 ${positives.length} 篇已知阳性上跑（这些是人工判定为「该算」的）：`);

  const worksPath = argValue('--works', '');
  const works = worksPath ? worksFromCsv(worksPath) : await loadWorks(positives.map((row) => row.doi));
  const causes = readCauses(PACK_DIR);
  const rows = positives.map((row) => {
    const doi = canonicalDoi(normalizeDoi(row.doi));
    const work = works.get(doi);
    const text = work ? `${work.title} ${work.abstract}` : '';
    if (!text) return { doi, note: row.note ?? '', status: 'no_text', evidence: [], reason: '取不到题录或摘要', cause: causes[doi] ?? null };

    const results = evaluate(criteria, text, { title: work.title, abstract: work.abstract });
    const violated = results.find((r) => r.kind === 'absent' && !r.matched);
    const coOccur = results.filter((r) => r.kind === 'co-occur');
    const positive = results.filter((r) => r.kind !== 'absent' && r.matched);
    // 与 try.mjs 同一套三档：共现命中=算；只有泛词命中=疑似；都没有=漏。
    const strong = coOccur.some((r) => r.matched);
    const weak = positive.length > 0;
    const said = !violated && (strong || weak);

    return {
      doi,
      note: row.note ?? '',
      status: !violated && strong ? 'recognized' : !violated && weak ? 'weak' : 'missed',
      cause: causes[doi] ?? null,
      violated: Boolean(violated),
      evidence: results.filter((r) => r.kind !== 'absent' && r.matched).flatMap((r) => r.evidence.slice(0, 1)),
      reason: violated ? `踩到排除信号「${violated.evidence[0]?.quote ?? '?'}」` : strong ? '共现判据命中' : weak ? '只有泛词命中，没有共现证据' : '没有任何正向判据命中',
    };
  });

  console.log('');
  for (const row of rows) {
    const mark = row.status === 'recognized' ? '✓' : '✗';
    console.log(`  ${mark} ${row.doi}`);
    if (row.status === 'recognized') {
      // 证据去重：几条共现判据常常撞到同一个词，重复印出来只会让人看不清。
      const seenQuote = new Set();
      const quotes = row.evidence
        .map((e) => e.quote)
        .filter((quote) => {
          const key = String(quote).toLowerCase();
          if (seenQuote.has(key)) return false;
          seenQuote.add(key);
          return true;
        })
        .map((quote) => `「${quote}」`)
        .join(' 与 ');
      console.log(`      认出来了：${quotes || row.reason}`);
    } else {
      console.log(`      ${row.reason}`);
      if (row.cause) console.log(`      已定原因：${CAUSES[row.cause.cause]?.label ?? row.cause.cause}${row.cause.note ? `——${row.cause.note}` : ''}`);
      else console.log(`      原因未定：跑 --cause ${row.doi} <criterion|data|out_of_scope>`);
      if (row.note) console.log(`      （人工备注：${row.note}）`);
    }
  }

  const recognized = rows.filter((r) => r.status === 'recognized').length;
  const weak = rows.filter((r) => r.status === 'weak').length;
  const missed = rows.filter((r) => r.status === 'missed').length;
  const noText = rows.filter((r) => r.status === 'no_text').length;

  // 「取不到文本」不算「没认出」：那是没数据，不是判据说它不算。
  // 把它算进来会把整组原因的比例冲淡，进而把该给的建议挤掉。
  const missedRows = rows.filter((r) => r.status !== 'recognized' && r.status !== 'no_text');
  const { buckets, advice } = summariseCauses(missedRows);

  console.log('');
  if (missedRows.length) {
    console.log('没认出（按原因分）');
    console.log('─'.repeat(78));
    for (const key of ['criterion', 'data', 'out_of_scope', 'unknown']) {
      const list = buckets[key] ?? [];
      if (!list.length) continue;
      const label = key === 'unknown' ? '原因未定' : CAUSES[key].label;
      console.log(`  ${label}：${list.length} 篇  ${list.map((r) => r.doi).join('、')}`);
      if (key !== 'unknown') console.log(`     → ${CAUSES[key].hint}`);
    }
    console.log('');
  }

  console.log('小结');
  console.log('─'.repeat(78));
  console.log(`  判据认出 ${recognized}/${positives.length}${noText ? `（${noText} 篇取不到文本）` : ''}`);
  if (weak) console.log(`  另有 ${weak} 篇只给出弱信号（命中泛词但没有共现证据）——「疑似」，不是「认出」。`);
  // 欠拟合防线：判据认不出已知该算的论文，是最危险的失败——它看起来"很干净"。
  const touched = recognized + weak;
  const checklist = positives.length - noText;
  if (touched < checklist * 0.8) {
    console.log('  ❌ 够不到。判据可能太窄（欠拟合）——它把该算的论文判成了不算。');
    console.log('     这正是过拟合的反面，也一样难发现：错得很安静。');
  } else if (weak > recognized) {
    console.log(`  ⚠️ 够到了（${touched}/${checklist}），但多数是弱信号：只有 ${recognized} 篇有共现证据。`);
    console.log('     说明泛词把范围兜住了，真正的判据还太少。加共现比加词管用。');
  } else if (weak) {
    console.log(`  ◐ 够到了（${touched}/${checklist}）：${recognized} 篇有共现证据，${weak} 篇只是弱信号。`);
    console.log('     弱信号那几篇建议逐条看原因——有的是判据缺一条，有的是数据本身有问题。');
  } else if (missed) {
    console.log(`  ⚠️ 漏 ${missed} 篇。看一眼上面每条的原因，判断是判据太窄，还是这几篇确实特殊。`);
  } else {
    console.log('  ✅ 全部认出。但这只说明它没把已知的丢掉；会不会乱认「不算」的，要另测。');
  }

  // 三类原因指向三种完全不同的动作。占比最高的那类，就是现在该做的事。
  if (advice) {
    console.log('');
    if (advice === 'criterion') {
      console.log('  → 多数漏检是「判据缺一条」：该动 criteria。');
    } else if (advice === 'data') {
      console.log('  → 多数漏检是「数据要清洗」：现在改判据是白改，先去修化学式空格/缺摘要。');
    } else if (advice === 'out_of_scope') {
      console.log('  → 多数漏检是「概念不在摘要里」：加判据也救不回来，该考虑金标本身是否成立，');
      console.log('     或者承认「只看摘要」这条路的边界在哪里。');
    }
  }
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

  // 给了 --criteria 就只做判据账（判据认不认得出已知该算的），不重放检索查询。
  // 先处理 --cause：它只写原因文件，不跑判据账。
  if (argv.includes('--cause')) {
    recordCause(PACK_DIR, pack, positives);
    return;
  }

  const criteriaPath = argValue('--criteria', '');
  if (criteriaPath) {
    await criteriaCheck(criteriaPath, pack, positives);
    return;
  }

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
