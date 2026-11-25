import { describe, expect, it } from 'vitest';

import { compareTrust, scoreTrust } from '../../../registry/application/services/trust-ranking.js';

describe('trust ranking', () => {
  const now = new Date('2026-11-24T00:00:00.000Z');

  it('lets lifecycle tiers dominate recency across the whole range', () => {
    const certifiedOld = scoreTrust(
      { lifecycle_status: 'published', certified: true, certified_at: '2024-01-01T00:00:00.000Z' },
      now,
    );
    const publishedFresh = scoreTrust(
      { lifecycle_status: 'published', published_at: '2026-11-24T00:00:00.000Z' },
      now,
    );
    expect(certifiedOld.score).toBeGreaterThan(publishedFresh.score);
    // Structural guarantee: the 10-point tier gap exceeds the max recency bonus.
    expect(certifiedOld.score).toBeGreaterThanOrEqual(30);
    expect(publishedFresh.score).toBeLessThanOrEqual(21);
    expect(certifiedOld.tier_weight).toBe(3);
    expect(publishedFresh.tier_weight).toBe(2);
  });

  it('derives the tier from the certified flag, then the lifecycle status', () => {
    expect(scoreTrust({ lifecycle_status: 'validated', certified: true }, now).lifecycle_status).toBe('certified');
    expect(scoreTrust({ lifecycle_status: 'draft' }, now).tier_weight).toBe(0.5);
    expect(scoreTrust({ lifecycle_status: 'revoked' }, now).tier_weight).toBe(0);
    expect(scoreTrust({ lifecycle_status: null }, now).lifecycle_status).toBe('none');
    expect(scoreTrust({ lifecycle_status: 'something-odd' }, now).tier_weight).toBe(0);
  });

  it('decays recency over a 180-day window and floors at zero', () => {
    const fresh = scoreTrust({ lifecycle_status: 'published', published_at: '2026-11-24T00:00:00.000Z' }, now);
    expect(fresh.recency_days).toBe(0);
    expect(fresh.recency_component).toBe(1);

    const halfWindow = scoreTrust({ lifecycle_status: 'published', published_at: '2026-08-26T00:00:00.000Z' }, now);
    expect(halfWindow.recency_days).toBe(90);
    expect(halfWindow.recency_component).toBeCloseTo(0.5, 5);

    const expired = scoreTrust({ lifecycle_status: 'published', published_at: '2026-01-01T00:00:00.000Z' }, now);
    expect(expired.recency_component).toBe(0);
    expect(expired.score).toBe(20);

    const undated = scoreTrust({ lifecycle_status: 'published' }, now);
    expect(undated.recency_days).toBeNull();
    expect(undated.recency_component).toBe(0);
  });

  it('prefers certified_at over published_at for recency', () => {
    const trust = scoreTrust(
      {
        lifecycle_status: 'published',
        certified: true,
        certified_at: '2026-11-24T00:00:00.000Z',
        published_at: '2026-01-01T00:00:00.000Z',
      },
      now,
    );
    expect(trust.recency_days).toBe(0);
  });

  it('breaks score ties on the logical key for stable ordering', () => {
    const trust = scoreTrust({ lifecycle_status: 'published', published_at: '2026-11-24T00:00:00.000Z' }, now);
    const left = { logical_key: 'skill:a', trust };
    const right = { logical_key: 'skill:b', trust };
    expect(compareTrust(left, right)).toBeLessThan(0);
    expect(compareTrust(right, left)).toBeGreaterThan(0);
    // A higher score sorts first regardless of key.
    expect(compareTrust(left, { ...right, trust: { ...trust, score: trust.score - 5 } })).toBeLessThan(0);
  });
});
