#!/usr/bin/env node
// Zero-dependency benchmark runner.
// Usage: node bench/run.mjs [--json] [--cap 1000] [--mailto you@example.com]
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = 'https://api.openalex.org/works';
const CACHE_DIR = path.join(ROOT, '.cache', 'openalex');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const CAP = clamp(Number(argValue('--cap', '1000')) || 1000, 100, 2000);
const MAILTO = argValue('--mailto', process.env.OPENALEX_MAILTO || '');
const API_KEY = argValue('--api-key', process.env.OPENALEX_API_KEY || '');
// OpenAlex caps per_page at 100. Asking for 200 burns budget without returning more.
const PER_PAGE = 100;
const ONLY_STAGE = argValue('--stage', '').toUpperCase();
const TIMEOUT_MS = clamp(Number(argValue('--timeout', '15000')) || 15000, 3000, 60000);
const VERBOSE = !argv.includes('--quiet');
const NO_CACHE = argv.includes('--no-cache');
const DUMP = argValue('--dump', '');

const cacheFile = (url) => path.join(CACHE_DIR, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);
const cacheRead = (url) => {
  if (NO_CACHE) return null;
  try { return JSON.parse(fs.readFileSync(cacheFile(url), 'utf8')); } catch { return null; }
};
const cacheWrite = (url, data) => {
  if (NO_CACHE) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(url), JSON.stringify(data), 'utf8');
  } catch { /* cache is best-effort */ }
};

// ── Domain data comes from a pack, never from this file ──────────────────────
// The runner knows nothing about chemistry. Everything field-specific lives in
// packs/<id>/pack.json: object terms, retrieval dimensions, corrections, stages.
const PACK_ARG = argValue('--pack', '');
const PACK_DIR = PACK_ARG ? path.resolve(PACK_ARG) : path.join(ROOT, 'packs', 'cof-h2o2');

function loadPack(dir) {
  const file = path.join(dir, 'pack.json');
  if (!fs.existsSync(file)) {
    throw new Error(`no pack.json in ${dir} — pass --pack <dir> pointing at a pack directory`);
  }
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['id', 'dimensions', 'stages']) {
    if (!pack[key]) throw new Error(`pack ${dir}: missing "${key}"`);
  }
  if (!pack.slots && !pack.object) throw new Error(`pack ${dir}: missing "object" (or "slots")`);
  return pack;
}

const PACK = loadPack(PACK_DIR);

// Sources are adapters, not a single fixed backend. Boolean sources take the slot
// expression as-is; free-text sources take the terms without the operators.
const KNOWN_SOURCES = ['openalex', 'crossref'];
const SOURCES = (argValue('--sources', (PACK.sources ?? ['openalex']).join(',')) || 'openalex')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const s of SOURCES) {
  if (!KNOWN_SOURCES.includes(s)) throw new Error(`unknown source "${s}"; known: ${KNOWN_SOURCES.join(', ')}`);
}
const quote = (t) => `"${t}"`;
const OR = (terms) => `(${terms.map(quote).join(' OR ')})`;

// A pack may declare one object or several slots. Multiple slots are ANDed:
// the CV/ESG pack needs "vision" AND "finance/ESG", which a single object cannot express.
const SLOTS = PACK.slots ?? (PACK.object ? [{ id: 'object', terms: PACK.object.terms }] : []);
if (!SLOTS.length) throw new Error(`pack ${PACK.id}: needs "object" or "slots"`);
const SLOT_EXPR = SLOTS.map((slot) => OR(slot.terms)).join(' AND ');

const DIMENSIONS = Object.fromEntries(PACK.dimensions.map((d) => [d.id, d]));
const EXTRA = Object.fromEntries((PACK.extraQueries ?? []).map((e) => [e.id, e]));

const dimensionQuery = (id) => {
  const dim = DIMENSIONS[id];
  if (!dim) throw new Error(`pack references unknown dimension "${id}"`);
  return `${OR(dim.terms)} AND ${SLOT_EXPR}`;
};

const STAGES = PACK.stages.map((stage) => {
  const dimIds = stage.dimensions.includes('*') ? PACK.dimensions.map((d) => d.id) : stage.dimensions;
  const extraIds = (stage.extraQueries ?? []).includes('*')
    ? Object.keys(EXTRA)
    : (stage.extraQueries ?? []);
  return {
    id: stage.id,
    label: stage.label,
    queries: [
      ...dimIds.map(dimensionQuery),
      ...extraIds.map((id) => {
        const extra = EXTRA[id];
        if (!extra) throw new Error(`pack stage ${stage.id} references unknown extraQuery "${id}"`);
        return extra.query;
      }),
    ],
    doiFallback: Boolean(stage.doiFallback),
  };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let RATE_LIMITED = 0;

function normalizeDoi(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '');
}

function canonicalDoi(doi) {
  // anie. (Int Ed) and ange. (German Ed) are two DOIs of the same article.
  return doi.replace(/\bange\./, 'anie.');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
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

async function api(url, tries = 3) {
  const cached = cacheRead(url);
  if (cached) return cached;

  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'criteria-compiler-bench/0.1' },
        signal: controller.signal,
      });
      if (res.status === 200) {
        const data = await res.json();
        cacheWrite(url, data);
        return data;
      }
      if (res.status === 429) {
        RATE_LIMITED++;
        let payload = null;
        try { payload = await res.json(); } catch { /* body may be empty */ }
        const message = String(payload?.message ?? payload?.error ?? '');
        const remaining = res.headers.get('x-ratelimit-remaining');
        const reset = Number(res.headers.get('x-ratelimit-reset'));

        // "Insufficient budget" is not a rate spike — waiting 20s never helps.
        if (/budget/i.test(message) || remaining === '0') {
          const hours = Number.isFinite(reset) && reset > 0 ? (reset / 3600).toFixed(1) : '?';
          const err = new Error(
            `daily budget exhausted (resets in ${hours}h, UTC midnight). ` +
              `Anonymous calls share one budget per egress IP, so --mailto does not help. ` +
              `Set OPENALEX_API_KEY (free key = 10x budget) and retry.`,
          );
          err.budgetExhausted = true;
          throw err;
        }

        const retryAfter = Number(res.headers.get('retry-after'));
        // Never trust a server-provided wait blindly: some endpoints send minutes or hours.
        const suggested = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * (attempt + 1);
        const wait = Math.min(suggested, 20000);
        process.stderr.write(`\n   rate limited (429), waiting ${Math.round(wait / 1000)}s\n`);
        await sleep(wait);
        continue;
      }
      if ([401, 500, 502, 503].includes(res.status)) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
      if (attempt === tries - 1) throw err;
      await sleep(1500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('request failed');
}

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

async function runQuery(search, pool) {
  let total = 0;
  try {
    const meta = await api(workUrl(search, 1, 1));
    total = meta.meta?.count ?? 0;
  } catch (err) {
    return { total: 0, added: 0, error: err.message };
  }
  // Hard ceiling on pages keeps cost bounded: 10 pages x 100 = 1000 records per query.
  const MAX_PAGES = 10;
  const pages = clamp(Math.ceil(Math.min(total, CAP) / PER_PAGE), 1, MAX_PAGES);
  let added = 0;
  for (let page = 1; page <= pages; page++) {
    let data;
    try {
      data = await api(workUrl(search, page, PER_PAGE));
    } catch (err) {
      return { total, added, error: err.message };
    }
    for (const w of data.results || []) {
      const doi = canonicalDoi(normalizeDoi(w.doi || ''));
      const key = doi || `openalex:${String(w.id || '').split('/').pop()}`;
      if (pool.has(key)) continue;
      pool.set(key, {
        doi,
        title: String(w.title || w.display_name || '').replace(/\s+/g, ' ').trim(),
        year: w.publication_year ?? null,
        cited: w.cited_by_count ?? 0,
      });
      added++;
    }
    await sleep(250);
  }
  return { total, added };
}

// ── Crossref adapter ─────────────────────────────────────────────────────────
// Crossref has no boolean slot syntax: it ranks by bibliographic relevance. We
// therefore strip the operators and hand it the terms as a plain phrase bag.
const CROSSREF = 'https://api.crossref.org/works';
const toFreeText = (q) =>
  q
    .replace(/\bAND\b|\bOR\b|\bNOT\b/g, ' ')
    .replace(/[()"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function crossrefQuery(search, pool) {
  const text = toFreeText(search);
  let total = 0;
  let added = 0;
  try {
    const metaUrl = `${CROSSREF}?rows=1&select=DOI&query.bibliographic=${encodeURIComponent(text)}${MAILTO ? `&mailto=${encodeURIComponent(MAILTO)}` : ''}`;
    const meta = await api(metaUrl);
    total = meta.message?.['total-results'] ?? 0;
  } catch (err) {
    return { total: 0, added: 0, error: err.message };
  }
  const pages = clamp(Math.ceil(Math.min(total, CAP) / 100), 1, 5);
  for (let page = 0; page < pages; page++) {
    const url =
      `${CROSSREF}?rows=100&offset=${page * 100}` +
      `&select=DOI,title,issued,is-referenced-by-count` +
      `&query.bibliographic=${encodeURIComponent(text)}` +
      (MAILTO ? `&mailto=${encodeURIComponent(MAILTO)}` : '');
    let data;
    try {
      data = await api(url);
    } catch (err) {
      return { total, added, error: err.message };
    }
    for (const item of data.message?.items ?? []) {
      const doi = canonicalDoi(normalizeDoi(item.DOI || ''));
      const title = Array.isArray(item.title) ? item.title[0] : item.title;
      if (!doi) continue;
      if (pool.has(doi)) continue;
      pool.set(doi, {
        doi,
        title: String(title ?? '').replace(/\s+/g, ' ').trim(),
        year: item.issued?.['date-parts']?.[0]?.[0] ?? null,
        cited: item['is-referenced-by-count'] ?? 0,
      });
      added++;
    }
    await sleep(250);
  }
  return { total, added };
}

async function runQueryAll(search, pool) {
  let total = 0;
  let added = 0;
  const errors = [];
  for (const source of SOURCES) {
    if (source === 'openalex') {
      const r = await runQuery(search, pool);
      total += r.total;
      added += r.added;
      if (r.error) errors.push(`openalex: ${r.error}`);
    } else if (source === 'crossref') {
      const r = await crossrefQuery(search, pool);
      total += r.total;
      added += r.added;
      if (r.error) errors.push(`crossref: ${r.error}`);
    }
  }
  return { total, added, error: errors.length ? errors.join('; ') : undefined };
}

async function probeDoi(doi, pool) {  const key = canonicalDoi(normalizeDoi(doi));
  if (!key || pool.has(key)) return false;
  try {
    const w = await api(`https://api.openalex.org/works/https://doi.org/${key}`);
    pool.set(key, {
      doi: key,
      title: String(w.title || '').replace(/\s+/g, ' ').trim(),
      year: w.publication_year ?? null,
      cited: w.cited_by_count ?? 0,
      via: 'doi-fallback',
    });
    return true;
  } catch {
    return false;
  }
}

function evaluate(pool, gold) {
  const pos = gold.filter((g) => Number(g.label) === 2);
  const neg = gold.filter((g) => Number(g.label) === 0);
  const hit = (rows) => rows.filter((g) => pool.has(canonicalDoi(normalizeDoi(g.doi))));
  const hitPos = hit(pos);
  const hitNeg = hit(neg);
  return {
    poolSize: pool.size,
    posTotal: pos.length,
    posHit: hitPos.length,
    posMissing: pos.filter((g) => !pool.has(canonicalDoi(normalizeDoi(g.doi)))).map((g) => g.doi),
    negTotal: neg.length,
    negHit: hitNeg.length,
  };
}

async function main() {
  const goldPath = PACK.gold ? path.join(PACK_DIR, PACK.gold) : null;
  if (goldPath && !fs.existsSync(goldPath)) throw new Error(`missing ${goldPath}`);
  const gold = goldPath ? parseCsv(fs.readFileSync(goldPath, 'utf8')) : null;
  const retrievalOnly = !gold;
  const startedAt = Date.now();
  if (!API_KEY && VERBOSE) {
    process.stderr.write('\nnote: no OPENALEX_API_KEY. Anonymous calls share one daily budget per egress IP\n');
  }

  // Fail fast: a single tiny request tells us whether the network works at all.
  if (VERBOSE) process.stderr.write(`\nchecking api.openalex.org (timeout ${TIMEOUT_MS}ms)... `);
  try {
    const probe = await api(workUrl(STAGES[0]?.queries[0] ?? dimensionQuery(PACK.dimensions[0].id), 1, 1));
    if (VERBOSE) process.stderr.write(`ok, ${probe.meta?.count ?? '?'} hits for the baseline query\n`);
  } catch (err) {
    process.stderr.write(`failed\n`);
    if (err.budgetExhausted) throw err;
    if (RATE_LIMITED > 0) {
      throw new Error(
        `api.openalex.org kept returning 429 (rate limited). ` +
          `Set OPENALEX_API_KEY for a 10x larger budget, or wait a few minutes. It is not a network failure.`,
      );
    }
    throw new Error(`cannot reach api.openalex.org within ${TIMEOUT_MS}ms: ${err.message}`);
  }

  const stages = ONLY_STAGE ? STAGES.filter((s) => s.id === ONLY_STAGE) : STAGES;
  if (!stages.length) throw new Error(`unknown --stage ${ONLY_STAGE}; use A, B or C`);
  const results = [];
  let lastPool = null;

  for (const stage of stages) {
    if (VERBOSE) process.stderr.write(`\n[${stage.id}] ${stage.label} — ${stage.queries.length} queries\n`);
    const pool = new Map();
    const perQuery = [];
    let index = 0;
    for (const q of stage.queries) {
      index++;
      if (VERBOSE) process.stderr.write(`   (${index}/${stage.queries.length}) ${q.slice(0, 60)}${q.length > 60 ? '…' : ''} `);
      const r = await runQueryAll(q, pool);
      perQuery.push({ query: q, ...r });
      if (VERBOSE) process.stderr.write(`total=${r.total} +${r.added} pool=${pool.size}${r.error ? ` ERR ${r.error}` : ''}\n`);
      if (r.error) process.stderr.write(`  ! query failed: ${r.error}\n`);
    }
    if (stage.doiFallback && gold) {
      for (const g of gold.filter((x) => Number(x.label) === 2)) {
        if (!pool.has(canonicalDoi(normalizeDoi(g.doi)))) await probeDoi(g.doi, pool);
      }
    }
    const scored = gold ? evaluate(pool, gold) : { poolSize: pool.size };
    results.push({ stage: stage.id, label: stage.label, queries: stage.queries.length, perQuery, ...scored });
    lastPool = pool;
  }

  if (DUMP && lastPool) {
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [...lastPool.values()].sort((a, b) => (b.cited ?? 0) - (a.cited ?? 0));
    const csv = ['doi,year,cited,title']
      .concat(rows.map((w) => [w.doi, w.year ?? '', w.cited ?? 0, w.title].map(esc).join(',')))
      .join('\r\n');
    fs.writeFileSync(DUMP, `\uFEFF${csv}\r\n`, 'utf8');
    process.stderr.write(`\ndumped ${rows.length} candidates -> ${DUMP}\n`);
  }

  if (asJson) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), cap: CAP, stages: results }, null, 2));
    return;
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log('\ncriteria-compiler benchmark');
  if (retrievalOnly) {
    console.log(`pack: ${PACK.id} — retrieval-only, no gold set, no coverage claim`);
  } else {
    console.log(`gold: ${gold.length} records (${results[0].posTotal} positive / ${results[0].negTotal} negative)`);
  }
  console.log(`cap per query: ${CAP}   sources: ${SOURCES.join(' + ')}\n`);
  if (retrievalOnly) {
    console.log(`${pad('stage', 34)}${pad('pool', 10)}${pad('queries', 10)}`);
    console.log('-'.repeat(56));
    for (const r of results) {
      console.log(`${pad(`${r.stage}. ${r.label}`, 34)}${pad(r.poolSize, 10)}${pad(r.queries, 10)}`);
    }
  } else {
    console.log(`${pad('stage', 34)}${pad('pool', 10)}${pad('positives', 14)}${pad('negatives', 12)}`);
    console.log('-'.repeat(70));
    for (const r of results) {
      console.log(
        `${pad(`${r.stage}. ${r.label}`, 34)}${pad(r.poolSize, 10)}${pad(`${r.posHit}/${r.posTotal}`, 14)}${pad(`${r.negHit}/${r.negTotal}`, 12)}`,
      );
    }
    const last = results[results.length - 1];
    if (last.posMissing?.length) {
      console.log(`\nstill missing (stage ${last.stage}):`);
      for (const d of last.posMissing) console.log(`  - ${d}`);
    }
  }
  console.log(`\nelapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s  (cap ${CAP}/query, timeout ${TIMEOUT_MS}ms)`);
  console.log('\nnote: negatives are records that look related but do not satisfy the criteria.');
  console.log('      a negative appearing in the pool is not an error by itself;');
  console.log('      it is there to test the downstream judge.\n');
}

main().catch((err) => {
  console.error(`\nbenchmark failed: ${err.message}`);
  console.error('this runner needs network access to api.openalex.org; it never downloads full text.');
  process.exit(1);
});
