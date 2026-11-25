import { describe, expect, it } from 'vitest';

import { scoreSemanticMatch, tokenize } from '../../../registry/application/services/semantic-search.js';

describe('semantic search scorer', () => {
  it('tokenizes on non-alphanumerics and drops single characters', () => {
    expect(tokenize('PII-handling: workflows & data')).toEqual(['pii', 'handling', 'workflows', 'data']);
  });

  it('rewards full-query phrase matches', () => {
    const phrase = scoreSemanticMatch('pii handling pipelines', {
      logical_key: 'skill:x',
      description: 'Handles PII handling pipelines daily.',
      capability_claims: [],
    });
    expect(phrase.phrase_match).toBe(true);
    expect(phrase.score).toBeGreaterThanOrEqual(5);
  });

  it('matches capability claims when the query covers every claim token', () => {
    const match = scoreSemanticMatch('PII handling for exports', {
      logical_key: 'skill:x',
      capability_claims: ['pii-handling', 'public-data'],
    });
    expect(match.matched_claims).toEqual(['pii-handling']);
  });

  it('gives partial claim overlap only generic token credit', () => {
    const match = scoreSemanticMatch('handling archive', {
      logical_key: 'skill:x',
      capability_claims: ['pii-handling'],
    });
    expect(match.matched_claims).toEqual([]);
    expect(match.matched_terms).toContain('handling');
    expect(match.score).toBeGreaterThan(0);
  });

  it('applies bounded prefix matching for morphology', () => {
    const match = scoreSemanticMatch('processor', {
      logical_key: 'skill:x',
      description: 'Industrial processors guidance.',
      capability_claims: [],
    });
    expect(match.score).toBeGreaterThan(0);
  });

  it('is zero for no overlap and fully deterministic', () => {
    const doc = { logical_key: 'skill:x', description: 'Gardening tips.', capability_claims: [] };
    expect(scoreSemanticMatch('quantum telemetry', doc).score).toBe(0);
    expect(scoreSemanticMatch('garden', doc)).toEqual(scoreSemanticMatch('garden', doc));
  });
});
