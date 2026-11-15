#!/usr/bin/env node
// 对账：把「判据的结论」和「人的判断」对起来，只输出分歧。
//
// 分歧就是该问用户的问题——这是整个回路里唯一真正产生信息的一步。
//
// 三个特点：
//   1. 只读，不发新请求：摘要取自 bench 已经抓过的 .cache/openalex，
//      加 --refresh 才会重新联网。
//   2. 引擎里没有任何领域词：判定全部来自 pack 的 checks。
//   3. 不存摘要、不存全文：读的时候就地拼、用完就扔，仓库里只有 DOI 与标签。
//
// Usage:
//   node bench/contradictions.mjs
//   node bench/contradictions.mjs --pack packs/cof-h2o2 --out /tmp/queue.md
//   node bench/contradictions.mjs --refresh          # 缓存里没有的 DOI 才联网

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'openalex');
const API = 'https://api.openalex.org/works';

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const REFRESH = argv.includes('--refresh');

const PACK_ARG = argValue('--pack', '');
const PACK_DIR = PACK_ARG ? path.resolve(PACK_ARG) : path.join(ROOT, 'packs', 'cof-h2o2');
const OUT = argValue('--out', '');

const BUCKETS = {
  too_wide: { title: '判据太宽（误伤）', question: (ids) => `判据说这篇有问题（${ids || '—'}），但你判了「算」。它凭什么算？` },
  too_narrow: { title: '判据太窄（漏判）', question: () => '判据一条都没报警，但你判了「不算」。是哪一点让它不算？' },
  unclear_strict: { title: '线没画（严的一侧）', question: (ids) => `判据说这篇有问题（${ids || '—'}），你也说不好。这条线你打算划在哪边？` },
  unclear_loose: { title: '线没画（松的一侧）', question: () => '判据没发现问题，你也说不好。缺了哪一条判据？' },
};

const normalizeDoi = (value) =>
  (value || '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');

// ── pack ────────────────────────────────────────────────────────────────────
function loadPack(dir) {
  const file = path.join(dir, 'pack.json');
  if (!fs.existsSync(file)) throw new Error(`no pack.json in ${dir} — pass --pack <dir>`);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['id', 'dimensions', 'stages']) {
    if (!pack[key]) throw new Error(`pack ${dir}: missing "${key}"`);
  }
  return pack;
}

function loadGold(dir, pack) {
  if (!pack.gold) return [];
  const file = path.resolve(dir, pack.gold);
  if (!fs.existsSync(file)) return [];
  const [header, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const columns = header.split(',');
  const doiAt = columns.indexOf('doi');
  const labelAt = columns.indexOf('label');
  if (doiAt < 0 || labelAt < 0) throw new Error(`${file}: needs "doi" and "label" columns`);
  return lines.filter(Boolean).map((line) => {
    const cells = line.split(',');
    return { doi: normalizeDoi(cells[doiAt]), label: Number(cells[labelAt]) };
  });
}

// ── 摘要缓存 ────────────────────────────────────────────────────────────────
// 判据要跑在摘要上，但仓库里**不存摘要**（gold.csv 只放 DOI 与标签）。
// 摘要单独缓存在 .cache/abstracts/ 下，gitignore 覆盖；要用时 --refresh 拉一次。
const ABSTRACT_CACHE = path.join(ROOT, '.cache', 'abstracts', 'works.json');

function loadAbstracts() {
  try {
    return JSON.parse(fs.readFileSync(ABSTRACT_CACHE, 'utf8'));
  } catch {
    return {};
  }
}

function saveAbstracts(map) {
  try {
    fs.mkdirSync(path.dirname(ABSTRACT_CACHE), { recursive: true });
    fs.writeFileSync(ABSTRACT_CACHE, JSON.stringify(map), 'utf8');
  } catch {
    /* cache is best-effort */
  }
}

async function warmAbstracts(dois) {
  const map = loadAbstracts();
  const missing = dois.filter((doi) => !map[doi]?.abstract_inverted_index);
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    const filter = `doi:${batch.join('|')}`;
    const url = `${API}?filter=${encodeURIComponent(filter)}&per-page=50&select=doi,title,abstract_inverted_index`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) continue;
      const payload = await response.json();
      for (const work of payload.results ?? []) {
        const doi = normalizeDoi(work.doi);
        if (doi) map[doi] = { title: work.title ?? '', abstract_inverted_index: work.abstract_inverted_index ?? null };
      }
    } catch {
      /* 网络问题不中断，能拿到几篇算几篇 */
    }
  }
  saveAbstracts(map);
  return map;
}

/** OpenAlex 的 abstract_inverted_index → 正文。只在内存里拼，不落盘。 */
function reconstructAbstract(inverted) {
  if (!inverted) return '';
  const slots = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const position of positions) slots[position] = word;
  }
  return slots.filter((word) => word != null).join(' ');
}

// ── 判定 ────────────────────────────────────────────────────────────────────
function runChecks(pack, text) {
  const fired = [];
  for (const check of pack.checks ?? []) {
    let matched = false;
    try {
      if (check.absent) matched = !new RegExp(check.absent, 'i').test(text);
      else if (check.pattern) matched = new RegExp(check.pattern, 'i').test(text);
    } catch {
      matched = false;
    }
    if (matched) fired.push(check);
  }
  return fired;
}

function classify(flagged, human) {
  if (human === 2) return flagged ? 'too_wide' : 'agree';
  if (human === 0) return flagged ? 'agree' : 'too_narrow';
  return flagged ? 'unclear_strict' : 'unclear_loose';
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const pack = loadPack(PACK_DIR);
  const gold = loadGold(PACK_DIR, pack);
  if (!gold.length) {
    console.error(`pack ${pack.id}: no gold set — nothing to reconcile.`);
    process.exit(1);
  }

  const abstracts = REFRESH ? await warmAbstracts(gold.map((record) => record.doi)) : loadAbstracts();
  if (!Object.keys(abstracts).length) {
    console.error('摘要缓存是空的。先跑一次：node bench/contradictions.mjs --refresh');
    process.exit(1);
  }

  const results = [];
  const stats = { total: gold.length, no_abstract: 0, agree: 0 };

  for (const record of gold) {
    const work = abstracts[record.doi];
    const abstract = reconstructAbstract(work?.abstract_inverted_index);
    if (!abstract) {
      stats.no_abstract += 1;
      continue;
    }
    const text = `${work.title ?? ''} ${abstract}`;
    const fired = runChecks(pack, text);
    const bucket = classify(fired.length > 0, record.label);
    if (bucket === 'agree') stats.agree += 1;
    results.push({
      bucket,
      doi: record.doi,
      title: work?.title ?? '',
      human: record.label,
      ids: fired.map((check) => check.id),
      notes: fired.map((check) => check.note).filter(Boolean),
    });
  }

  const order = ['too_wide', 'too_narrow', 'unclear_strict', 'unclear_loose', 'agree'];
  results.sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket));

  const queued = results.filter((item) => item.bucket !== 'agree');
  const lines = [
    `# 矛盾队列 · pack ${pack.id}`,
    '',
    `金集 ${stats.total} 条｜一致 ${stats.agree}｜待你判 ${queued.length}｜缺摘要 ${stats.no_abstract}`,
    REFRESH ? '' : '（摘要取自本地缓存，未发新请求）',
    '',
  ];

  if (!queued.length) {
    lines.push('没有分歧。要么判据已经对齐，要么金集还没开始标。');
  } else {
    for (const key of ['too_wide', 'too_narrow', 'unclear_strict', 'unclear_loose']) {
      const items = results.filter((item) => item.bucket === key);
      if (!items.length) continue;
      lines.push(`## ${BUCKETS[key].title} · ${items.length} 篇`, '');
      for (const item of items) {
        lines.push(`- **${item.title || item.doi}**`);
        lines.push(`  - ${BUCKETS[key].question(item.ids.join('、'))}`);
        if (item.notes.length) lines.push(`  - 命中说明：${item.notes.join(' / ')}`);
      }
      lines.push('');
    }
  }

  const markdown = lines.join('\n');
  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(path.resolve(OUT), markdown, 'utf8');
    console.log(`写入 ${OUT}`);
  } else {
    console.log(markdown);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
