import { canonicalDoi, normalizeDoi } from './normalize.js';
import { FAMILIES, FIX_QUERIES, familyQuery, type FamilyName } from './profiles/families.js';
import { collect, probeDoi, type OpenAlexWork, type SearchOptions } from './sources/openalex.js';
import type { GoldRecord } from './gold.js';

export interface StageResult {
  posTotal: number;
  posHit: number;
  posMissing: string[];
  negTotal: number;
  negHit: number;
  poolSize: number;
}

export type StageName = 'cof-only' | 'six-families' | 'six-families-with-fixes';

export const STAGES: { name: StageName; families: FamilyName[]; fixes: boolean; doiFallback: boolean }[] = [
  { name: 'cof-only', families: ['COF'], fixes: false, doiFallback: false },
  {
    name: 'six-families',
    families: ['COF', 'CMP', 'PHI', 'CN', 'CdS', 'Bi'],
    fixes: false,
    doiFallback: false,
  },
  {
    name: 'six-families-with-fixes',
    families: ['COF', 'CMP', 'PHI', 'CN', 'CdS', 'Bi'],
    fixes: true,
    doiFallback: true,
  },
];

export async function runStage(
  stage: (typeof STAGES)[number],
  gold: GoldRecord[],
  opts: SearchOptions = {},
): Promise<StageResult> {
  const pool = new Map<string, OpenAlexWork>();
  for (const family of stage.families) {
    await collect(familyQuery(family), pool, opts);
  }
  if (stage.fixes) {
    for (const query of Object.values(FIX_QUERIES)) await collect(query, pool, opts);
  }
  if (stage.doiFallback) {
    for (const g of gold.filter((x) => Number(x.label) === 2)) {
      const key = canonicalDoi(normalizeDoi(g.doi));
      if (!pool.has(key)) await probeDoi(g.doi, pool);
    }
  }
  return evaluate(pool, gold);
}

export function evaluate(pool: Map<string, OpenAlexWork>, gold: GoldRecord[]): StageResult {
  const positives = gold.filter((g) => Number(g.label) === 2);
  const negatives = gold.filter((g) => Number(g.label) === 0);
  const has = (g: GoldRecord) => pool.has(canonicalDoi(normalizeDoi(g.doi)));
  return {
    poolSize: pool.size,
    posTotal: positives.length,
    posHit: positives.filter(has).length,
    posMissing: positives.filter((g) => !has(g)).map((g) => g.doi),
    negTotal: negatives.length,
    negHit: negatives.filter(has).length,
  };
}

export { FAMILIES, FIX_QUERIES, familyQuery };
