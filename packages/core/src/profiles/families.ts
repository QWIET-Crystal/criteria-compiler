/**
 * Material families. The lesson that produced this file:
 * recall is set by retrieval *dimensions*, not by ranking.
 *
 * A single-family query ("COF") caps coverage no matter how good the reranker is,
 * because sibling systems (CMP / PHI / carbon nitride / CdS / bismuth-based)
 * never mention the missing term in their abstracts.
 */
export const H2O2_SLOT = '("hydrogen peroxide" OR H2O2)';

export const FAMILIES = {
  COF: '("covalent organic framework" OR COF OR CTF)',
  CMP: '("conjugated microporous polymer")',
  PHI: '("heptazine imide" OR "poly(heptazine imide)")',
  CN: '("carbon nitride" OR C3N4 OR "polymeric carbon nitride")',
  CdS: '("cadmium sulfide" OR CdS)',
  Bi: '(Bi2O2S OR "bismuth oxysulfide" OR CuInS2)',
} as const;

export type FamilyName = keyof typeof FAMILIES;

/** Compose a family slot with the mandatory product slot. */
export function familyQuery(family: FamilyName): string {
  return `${FAMILIES[family]} AND ${H2O2_SLOT}`;
}

/**
 * Corrections that were found by measurement, not by guessing.
 * Each one exists because a specific gold paper was missing for this exact reason.
 */
export const FIX_QUERIES = {
  /** API returns "Bi 2 O 2 S", so a literal Bi2O2S query misses it. */
  spacedFormula: '(Bi2O2S OR "Bi 2 O 2 S" OR CuInS2) AND ("hydrogen peroxide" OR H2O2)',
  /** Class-C papers consume H2O2 in situ and never name it in the abstract. */
  noProductSlot: '("carbon nitride" OR C3N4) AND methane AND ethanol',
} as const;
