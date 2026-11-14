import { describe, expect, it } from 'vitest';
import { canonicalDoi, dedupeKey, hasFormula, normalizeDoi, normalizeForMatch } from '../src/normalize.js';

describe('normalizeForMatch / hasFormula', () => {
  it('matches a formula that the API rendered with spaces', () => {
    const abstract = 'photocatalytic hydrogen peroxide (H 2 O 2) synthesis is controlled by O 2 adsorption';
    expect(hasFormula(abstract, 'H2O2')).toBe(true);
  });

  it('matches space-rendered material formulas', () => {
    const abstract = 'OV-Bi 2 O 2 S/CuInS 2 (OV-BOS/CIS) photocatalyst';
    expect(hasFormula(abstract, 'Bi2O2S')).toBe(true);
    expect(hasFormula(abstract, 'CuInS2')).toBe(true);
  });

  it('handles unicode subscripts', () => {
    expect(normalizeForMatch('H₂O₂')).toBe('h2o2');
  });

  it('does not invent matches', () => {
    expect(hasFormula('carbon nitride photocatalyst', 'COF')).toBe(false);
  });
});

describe('normalizeDoi / canonicalDoi', () => {
  it('strips resolver and prefix', () => {
    expect(normalizeDoi('https://doi.org/10.1000/ABC')).toBe('10.1000/abc');
    expect(normalizeDoi('doi: 10.1000/abc')).toBe('10.1000/abc');
  });

  it('collapses Angewandte German and International DOIs', () => {
    const intl = '10.1002/anie.202318562';
    const ger = '10.1002/ange.202318562';
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
