import { describe, expect, it } from 'vitest';
import { canonicalDoi, dedupeKey, hasFormula, normalizeDoi, normalizeForMatch } from '../src/normalize.js';

// Fixtures are deliberately domain-neutral: the engine must not know any field's
// vocabulary, and a test that imports that vocabulary hides the difference.
describe('normalizeForMatch / hasFormula', () => {
  it('matches a formula that the API rendered with spaces', () => {
    const text = 'the sample (A 1 B 2) was measured against a reference';
    expect(hasFormula(text, 'A1B2')).toBe(true);
  });

  it('matches space-rendered multi-part formulas', () => {
    const text = 'we used (D 4 E 5)/poly(F 6) as the control';
    expect(hasFormula(text, 'D4E5')).toBe(true);
    expect(hasFormula(text, 'poly(F6)')).toBe(true);
  });

  it('handles unicode subscripts', () => {
    expect(normalizeForMatch('X₂Y₃')).toBe('x2y3');
  });

  it('does not invent matches', () => {
    expect(hasFormula('plain text without the token', 'A1B2')).toBe(false);
  });
});

describe('normalizeDoi / canonicalDoi', () => {
  it('strips resolver and prefix', () => {
    expect(normalizeDoi('https://doi.org/10.1000/ABC')).toBe('10.1000/abc');
    expect(normalizeDoi('doi: 10.1000/abc')).toBe('10.1000/abc');
  });

  it('collapses the two editions that share one article', () => {
    const intl = '10.1002/anie.202300001';
    const ger = '10.1002/ange.202300001';
    expect(canonicalDoi(intl)).toBe(canonicalDoi(ger));
  });
});

describe('dedupeKey', () => {
  it('prefers DOI', () => {
    expect(dedupeKey('10.1/x', 'Title')).toBe('10.1/x');
  });

  it('falls back to a stable title key', () => {
    const a = dedupeKey('', 'Same  Title');
    const b = dedupeKey('', 'same title');
    expect(a).toBe(b);
    expect(a.startsWith('title:')).toBe(true);
  });
});
