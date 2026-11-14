import { describe, expect, it } from 'vitest';

import { estimateTokens } from '../../src/domain/cognitive/token-estimator.js';
import { summarizeCompact } from '../../src/domain/cognitive/summarizer.js';
import { EphemeralCache } from '../../src/infrastructure/cognitive/ephemeral-cache.js';
import { DefaultCognitiveService } from '../../src/infrastructure/cognitive/default-cognitive-service.js';

const principal = {
  type: 'api_key' as const,
  id: 'test-principal',
  authMethod: 'api_key' as const,
  scopes: [],
  groups: [],
  claims: {},
};

describe('estimateTokens', () => {
  it('returns a positive token estimate that scales with payload size', () => {
    const small = estimateTokens({ a: 1 });
    const large = estimateTokens({ a: 'x'.repeat(400) });
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });
});

describe('summarizeCompact', () => {
  it('truncates long strings', () => {
    const result = summarizeCompact('x'.repeat(500)) as string;
    expect(result.length).toBeLessThan(500);
    expect(result.endsWith('…')).toBe(true);
  });

  it('summarizes arrays to count + preview', () => {
    const result = summarizeCompact([1, 2, 3, 4, 5]) as { _type: string; count: number; preview: unknown[] };
    expect(result._type).toBe('array');
    expect(result.count).toBe(5);
    expect(result.preview).toHaveLength(3);
  });

  it('summarizes objects to key_count + preview', () => {
    const input = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    const result = summarizeCompact(input) as { _type: string; key_count: number };
    expect(result._type).toBe('object');
    expect(result.key_count).toBe(20);
  });
});

describe('EphemeralCache', () => {
  it('stores and retrieves values', () => {
    const cache = new EphemeralCache<string>({ maxEntries: 10, ttlMs: 60_000 });
    cache.set('k', 'v');
    expect(cache.get('k')).toBe('v');
  });

  it('expires entries after the TTL', async () => {
    const cache = new EphemeralCache<string>({ maxEntries: 10, ttlMs: 5 });
    cache.set('k', 'v');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cache.get('k')).toBeUndefined();
  });

  it('evicts the oldest entry when full', () => {
    const cache = new EphemeralCache<string>({ maxEntries: 2, ttlMs: 60_000 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBe('3');
  });
});

describe('DefaultCognitiveService', () => {
  it('passes through when disabled', async () => {
    const service = new DefaultCognitiveService({
      enabled: false,
      budget_tokens: 10,
      cache_ttl_ms: 60_000,
      cache_max_entries: 10,
    });
    const result = { skills: [1, 2, 3] };
    const out = await service.shape({ principal, tool_name: 'registry.list_skills', input_sha256: 'abc', result });
    expect(out.summarized).toBe(false);
    expect(out.result).toBe(result);
  });

  it('passes through when under budget', async () => {
    const service = new DefaultCognitiveService({
      enabled: true,
      budget_tokens: 100_000,
      cache_ttl_ms: 60_000,
      cache_max_entries: 10,
    });
    const result = { skills: [1, 2, 3] };
    const out = await service.shape({ principal, tool_name: 'registry.list_skills', input_sha256: 'abc', result });
    expect(out.summarized).toBe(false);
    expect(out.result).toBe(result);
  });

  it('summarizes when over budget and caches the summary', async () => {
    const service = new DefaultCognitiveService({
      enabled: true,
      budget_tokens: 1,
      cache_ttl_ms: 60_000,
      cache_max_entries: 10,
    });
    const result = { skills: Array.from({ length: 50 }, (_, i) => ({ skill_key: `skill:${i}` })) };

    const first = await service.shape({ principal, tool_name: 'registry.list_skills', input_sha256: 'abc', result });
    expect(first.summarized).toBe(true);
    expect(first.result).toMatchObject({ _summarized: true, reason: 'context_budget_exceeded' });

    // Second identical call should return the cached summary.
    const second = await service.shape({ principal, tool_name: 'registry.list_skills', input_sha256: 'abc', result });
    expect(second.summarized).toBe(true);
    expect(second.result).toEqual(first.result);
  });
});
