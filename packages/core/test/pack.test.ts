import { describe, expect, it } from 'vitest';
import { assertSafeDoi } from '../src/normalize.js';
import { assertSafeTerm, orExpr } from '../src/pack.js';

// These two guards exist because a pack is a *shared artefact*: someone else can
// hand you one, and it goes straight into a query string and a request path.
// A term that closes its own quote, or a DOI that rewrites the path, would let a
// pack change what gets retrieved while the results still look plausible.
describe('term safety', () => {
  it('quotes ordinary multi-word terms unchanged', () => {
    expect(orExpr(['covalent organic framework', 'poly(heptazine imide)'])).toBe(
      '("covalent organic framework" OR "poly(heptazine imide)")',
    );
  });

  it('refuses a term that can close the phrase early', () => {
    expect(() => assertSafeTerm('x" OR "y')).toThrow(/query grammar/);
    expect(() => assertSafeTerm('back\\slash')).toThrow(/query grammar/);
  });

  it('refuses an overlong term', () => {
    expect(() => assertSafeTerm('x'.repeat(81))).toThrow(/80/);
  });

  it('refuses an empty term', () => {
    expect(() => assertSafeTerm('   ')).toThrow(/empty/);
  });

  it('accepts CJK terms', () => {
    expect(assertSafeTerm('过氧化氢')).toBe('过氧化氢');
  });
});

describe('doi safety', () => {
  it('accepts a normal doi and strips the resolver', () => {
    expect(assertSafeDoi('https://doi.org/10.1021/jacs.6c00731')).toBe('10.1021/jacs.6c00731');
  });

  it('refuses a doi that can inject query parameters', () => {
    expect(() => assertSafeDoi('10.1002/x?mailto=evil@example.com')).toThrow(/request path/);
    expect(() => assertSafeDoi('10.1002/x&per-page=200')).toThrow(/request path/);
  });

  it('refuses a doi that can traverse the path', () => {
    expect(() => assertSafeDoi('10.1002/../../admin')).toThrow(/traversal/);
  });

  it('refuses an empty doi', () => {
    expect(() => assertSafeDoi('   ')).toThrow(/empty/);
  });
});
