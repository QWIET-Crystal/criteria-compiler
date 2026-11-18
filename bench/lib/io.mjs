// 小工具：读写、抓题录、找版本。
//
// 抽出来的原因很实际——parseCsv / loadWorks 在 start、refine、ledger 里各写了一遍。
// 三份同义实现放在一个号称"标准要可复核"的仓库里，是个笑话。

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
const API = 'https://api.openalex.org/works';
const CACHE_DIR = path.join(ROOT, '.cache', 'openalex');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const normalizeDoi = (value) =>
  String(value ?? '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '');

export const canonicalDoi = (doi) => normalizeDoi(doi).replace(/\bange\./, 'anie.');

export const SAFE_DOI = /^10\.[0-9]{4,9}\/[A-Za-z0-9._;()/:+-]+$/;

const cacheFile = (url) => path.join(CACHE_DIR, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);

export async function api(url) {
  try {
    const hit = JSON.parse(fs.readFileSync(cacheFile(url), 'utf8'));
    if (hit) return hit;
  } catch { /* 没缓存就去取 */ }
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'criteria-compiler/0.1' }, signal: controller.signal });
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

export function reconstructAbstract(inverted) {
  if (!inverted) return '';
  const slots = [];
  for (const [word, positions] of Object.entries(inverted)) for (const position of positions) slots[position] = word;
  return slots.filter((w) => w != null).join(' ');
}

/** 按 DOI 批量取题录，走同一套缓存；start / refine / ledger 共用。 */
export async function loadWorks(dois) {
  const found = new Map();
  const safe = [...new Set(dois.map(normalizeDoi))].filter((d) => SAFE_DOI.test(d) && !d.includes('..'));
  for (let i = 0; i < safe.length; i += 50) {
    const filter = `doi:${safe.slice(i, i + 50).join('|')}`;
    const url = `${API}?filter=${encodeURIComponent(filter)}&per-page=50&select=doi,title,publication_year,cited_by_count,abstract_inverted_index`;
    const data = await api(url);
    for (const work of data?.results ?? []) {
      const doi = normalizeDoi(work.doi);
      if (!doi) continue;
      found.set(doi, {
        doi,
        title: work.title ?? '',
        year: work.publication_year ?? null,
        cited: work.cited_by_count ?? 0,
        abstract: reconstructAbstract(work.abstract_inverted_index),
      });
    }
    await sleep(200);
  }
  return found;
}

export function parseCsv(text) {
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

export const csvEscape = (value) => `"${String(value ?? '').replace(/"/g, "'")}"`;

/** 版本号最大的一份。第一版叫 draft.json，之后 draft-v2.json… */
export function latestArtifact(dir, base, ext) {
  if (!fs.existsSync(dir)) return null;
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

export function readDraft(packDir, explicit) {
  const file = explicit ? path.resolve(explicit) : latestArtifact(packDir, 'draft', 'json');
  if (!file || !fs.existsSync(file)) return null;
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

export function readQueue(packDir, explicit) {
  const file = explicit ? path.resolve(explicit) : latestArtifact(packDir, 'review-queue', 'csv');
  if (!file || !fs.existsSync(file)) return null;
  return { file, rows: parseCsv(fs.readFileSync(file, 'utf8')) };
}

export const labelOf = (row) => {
  const value = String(row?.verdict ?? '').trim();
  return value === '2' ? 2 : value === '0' ? 0 : value === '1' ? 1 : null;
};
