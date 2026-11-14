import { canonicalDoi, normalizeDoi } from '../normalize.js';

const API = 'https://api.openalex.org/works';

export interface OpenAlexWork {
  doi: string;
  title: string;
  year: number | null;
  cited: number;
  via?: string;
}

export interface SearchOptions {
  /** Max records collected per query. */
  cap?: number;
  /** Polite-pool contact. Kept for etiquette; it no longer buys extra budget. */
  mailto?: string;
  /** Free OpenAlex key: 10x daily budget and required for cursor paging. */
  apiKey?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Called after each page, useful for progress output in a CLI. */
  onPage?: (info: { page: number; collected: number }) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function request<T>(url: string, attempts = 4, timeoutMs = 20_000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'criteria-compiler/0.1' },
        signal: controller.signal,
      });
      if (res.status === 200) return (await res.json()) as T;
      if ([401, 429, 500, 502, 503].includes(res.status)) {
        await sleep(1200 * (i + 1));
        continue;
      }
      throw new Error(`OpenAlex HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) throw err;
      await sleep(1200 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('OpenAlex request failed');
}

function buildUrl(search: string, page: number, perPage: number, mailto?: string, apiKey?: string): string {
  const params = new URLSearchParams({
    filter: `title_and_abstract.search:${search}`,
    // OpenAlex caps per_page at 100; 200 silently burns budget without returning more.
    'per-page': String(Math.min(perPage, 100)),
    page: String(page),
    select: 'doi,title,publication_year,cited_by_count',
  });
  if (mailto) params.set('mailto', mailto);
  if (apiKey) params.set('api_key', apiKey);
  return `${API}?${params.toString()}`;
}

export async function countWorks(search: string, mailto?: string, apiKey?: string): Promise<number> {
  const data = await request<{ meta?: { count?: number } }>(buildUrl(search, 1, 1, mailto, apiKey));
  return data.meta?.count ?? 0;
}

/** Fetch one page (max 100). */
export async function searchWorks(
  search: string,
  page = 1,
  perPage = 100,
  mailto?: string,
  apiKey?: string,
): Promise<OpenAlexWork[]> {
  const data = await request<{ results?: any[] }>(buildUrl(search, page, Math.min(perPage, 100), mailto, apiKey));
  return (data.results ?? []).map((w) => ({
    doi: canonicalDoi(normalizeDoi(w.doi ?? '')),
    title: String(w.title ?? w.display_name ?? '').replace(/\s+/g, ' ').trim(),
    year: w.publication_year ?? null,
    cited: w.cited_by_count ?? 0,
  }));
}

/** Page through a query up to `cap` records and append into `pool`. */
export async function collect(
  search: string,
  pool: Map<string, OpenAlexWork>,
  opts: SearchOptions = {},
): Promise<{ total: number; added: number }> {
  const { cap = 500, mailto, apiKey, onPage } = opts;
  const total = await countWorks(search, mailto, apiKey);
  // 10 pages x 100 records = 1000 records per query; keeps budget predictable.
  const pages = Math.max(1, Math.min(10, Math.ceil(Math.min(total, cap) / 100)));
  let added = 0;
  for (let page = 1; page <= pages; page++) {
    const works = await searchWorks(search, page, 100, mailto, apiKey);
    for (const w of works) {
      const key = w.doi || `title:${w.title.toLowerCase()}`;
      if (pool.has(key)) continue;
      pool.set(key, w);
      added++;
    }
    onPage?.({ page, collected: pool.size });
    await sleep(250);
  }
  return { total, added };
}

/** Last-resort single-record lookup (records without abstracts are not searchable). */
export async function probeDoi(doi: string, pool: Map<string, OpenAlexWork>): Promise<boolean> {
  const key = canonicalDoi(doi);
  if (!key || pool.has(key)) return false;
  try {
    const w = await request<any>(`${API}/https://doi.org/${key}`);
    pool.set(key, {
      doi: key,
      title: String(w.title ?? '').replace(/\s+/g, ' ').trim(),
      year: w.publication_year ?? null,
      cited: w.cited_by_count ?? 0,
      via: 'doi-fallback',
    });
    return true;
  } catch {
    return false;
  }
}
