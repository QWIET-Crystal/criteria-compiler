import { canonicalDoi, normalizeDoi } from './normalize.js';
import type { GoldRecord } from './gold.js';
import { stagesOf, type Pack } from './pack.js';
import { collect, probeDoi, type OpenAlexWork, type SearchOptions } from './sources/openalex.js';

export interface StageResult {
  stage: string;
  poolSize: number;
  posTotal: number;
  posHit: number;
  /** Positives found by the retrieval queries themselves. */
  posHitSearch: number;
  /** Positives that only showed up through the DOI fallback (records without abstracts). */
  posHitFallback: number;
  posMissing: string[];
  negTotal: number;
  negHit: number;
}

/** Run one stage of a pack against a gold set. */
export async function runStage(
  pack: Pack,
  stageId: string,
  gold: GoldRecord[],
  opts: SearchOptions = {},
): Promise<StageResult> {
  const stage = stagesOf(pack).find((s) => s.id === stageId);
  if (!stage) throw new Error(`pack ${pack.id}: no stage "${stageId}"`);

  const pool = new Map<string, OpenAlexWork>();
  for (const query of stage.queries) await collect(query, pool, opts);

  if (stage.doiFallback) {
    for (const g of gold.filter((x) => Number(x.label) === 2)) {
      const key = canonicalDoi(normalizeDoi(g.doi));
      if (!pool.has(key)) await probeDoi(g.doi, pool);
    }
  }
  return { stage: stage.id, ...evaluate(pool, gold) };
}

export function evaluate(pool: Map<string, OpenAlexWork>, gold: GoldRecord[]): Omit<StageResult, 'stage'> {
  const positives = gold.filter((g) => Number(g.label) === 2);
  const negatives = gold.filter((g) => Number(g.label) === 0);
  const keyOf = (g: GoldRecord) => canonicalDoi(normalizeDoi(g.doi));
  const has = (g: GoldRecord) => pool.has(keyOf(g));
  const hits = positives.filter(has);
  // A hit that only arrived through probeDoi() is not evidence of retrieval quality,
  // so it is reported separately instead of being folded into the coverage number.
  const fallbackHits = hits.filter((g) => pool.get(keyOf(g))?.via === 'doi-fallback');
  return {
    poolSize: pool.size,
    posTotal: positives.length,
    posHit: hits.length,
    posHitSearch: hits.length - fallbackHits.length,
    posHitFallback: fallbackHits.length,
    posMissing: positives.filter((g) => !has(g)).map((g) => g.doi),
    negTotal: negatives.length,
    negHit: negatives.filter(has).length,
  };
}
