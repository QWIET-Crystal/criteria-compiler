/**
 * Normalization is the only place where "the data is messy" is allowed to be handled.
 * Everything here is pure and offline: no network, no clock, no randomness.
 */

const SUBSCRIPT: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
};

/**
 * Build the string used for *matching* only. Never display this to a user.
 *
 * The API renders subscripts as spaces (a token shown as "X 2 Y 3" arrives with
 * gaps), so any literal match on "X2Y3" silently drops true positives. Instead
 * of trying to repair the text (which corrupts normal prose), we squash
 * whitespace and compare.
 */
export function normalizeForMatch(input: string): string {
  return String(input ?? '')
    .normalize('NFKC')
    .replace(/[₀-₉]/g, (c) => SUBSCRIPT[c] ?? c)
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** True when `formula` occurs in `text` once spacing/subscripts are ignored. */
export function hasFormula(text: string, formula: string): boolean {
  return normalizeForMatch(text).includes(normalizeForMatch(formula));
}

/** Strip the doi.org resolver and any "doi:" prefix; lowercase for comparison. */
export function normalizeDoi(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '');
}

/**
 * Angewandte publishes the same article twice: `anie.` (International Edition)
 * and `ange.` (German Edition) carry different DOIs. They must collapse to one key.
 */
export function canonicalDoi(doi: string): string {
  return normalizeDoi(doi).replace(/\bange\./, 'anie.');
}

/**
 * Dedupe key: DOI when present, otherwise a title hash.
 * The hash is intentionally simple so it is reproducible across languages.
 */
export function dedupeKey(doi: string, title: string): string {
  const d = canonicalDoi(doi);
  if (d) return d;
  const t = normalizeForMatch(title);
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return `title:${(h >>> 0).toString(36)}`;
}
