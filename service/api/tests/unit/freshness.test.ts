import { describe, expect, it } from 'vitest';

import {
  FRESHNESS_AGING_DAYS,
  FRESHNESS_STALE_DAYS,
  computeFreshness,
} from '../../../registry/application/services/freshness.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('freshness signal', () => {
  const now = new Date('2026-11-25T00:00:00.000Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const daysAhead = (days: number) => new Date(now.getTime() + days * DAY_MS).toISOString();

  it('is fresh inside the aging window with no reasons', () => {
    const freshness = computeFreshness({ published_at: daysAgo(0) }, now);
    expect(freshness).not.toBeNull();
    expect(freshness?.freshness).toBe('fresh');
    expect(freshness?.age_days).toBe(0);
    expect(freshness?.verification_basis).toBe('published_at');
    expect(freshness?.last_verified_at).toBe(daysAgo(0));
    expect(freshness?.reasons).toEqual([]);
  });

  it('crosses into aging at the day boundary and into stale at the next one', () => {
    expect(computeFreshness({ published_at: daysAgo(FRESHNESS_AGING_DAYS - 1) }, now)?.freshness).toBe('fresh');
    const aging = computeFreshness({ published_at: daysAgo(FRESHNESS_AGING_DAYS) }, now);
    expect(aging?.freshness).toBe('aging');
    expect(aging?.reasons).toEqual(['aging']);
    expect(computeFreshness({ published_at: daysAgo(FRESHNESS_STALE_DAYS - 1) }, now)?.freshness).toBe('aging');
    const stale = computeFreshness({ published_at: daysAgo(FRESHNESS_STALE_DAYS) }, now);
    expect(stale?.freshness).toBe('stale');
    expect(stale?.reasons).toEqual(['aged']);
  });

  it('measures age from the newest verification moment (certification first)', () => {
    const certified = computeFreshness(
      { certified_at: daysAgo(100), published_at: daysAgo(1) },
      now,
    );
    expect(certified?.verification_basis).toBe('certified_at');
    expect(certified?.age_days).toBe(100);
    const published = computeFreshness({ published_at: daysAgo(5), validated_at: daysAgo(9) }, now);
    expect(published?.verification_basis).toBe('published_at');
    const validated = computeFreshness({ validated_at: daysAgo(3) }, now);
    expect(validated?.verification_basis).toBe('validated_at');
  });

  it('returns null when there is no verification timestamp to age from', () => {
    expect(computeFreshness({}, now)).toBeNull();
    expect(computeFreshness({ certified_at: 'not-a-date', published_at: '' }, now)).toBeNull();
  });

  it('skips unparseable timestamps in favor of the next valid one', () => {
    const freshness = computeFreshness({ certified_at: 'nonsense', published_at: daysAgo(2) }, now);
    expect(freshness?.verification_basis).toBe('published_at');
    expect(freshness?.age_days).toBe(2);
  });

  it('tracks a future certification expiry with a positive countdown', () => {
    const freshness = computeFreshness(
      { certified_at: daysAgo(10), certification_expires_at: daysAhead(80) },
      now,
    );
    expect(freshness?.freshness).toBe('fresh');
    expect(freshness?.certification_expired).toBe(false);
    expect(freshness?.certification_expires_at).toBe(daysAhead(80));
    expect(freshness?.expires_in_days).toBe(80);
  });

  it('forces stale — with the expiry reason — when the certification has expired', () => {
    const freshness = computeFreshness(
      { certified_at: daysAgo(1), certification_expires_at: daysAgo(3) },
      now,
    );
    expect(freshness?.freshness).toBe('stale');
    expect(freshness?.certification_expired).toBe(true);
    expect(freshness?.expires_in_days).toBe(-3);
    expect(freshness?.reasons).toContain('certification_expired');
  });

  it('reports an unparseable expiry as absent rather than expired', () => {
    const freshness = computeFreshness(
      { certified_at: daysAgo(1), certification_expires_at: 'someday' },
      now,
    );
    expect(freshness?.certification_expired).toBe(false);
    expect(freshness?.certification_expires_at).toBeNull();
    expect(freshness?.expires_in_days).toBeNull();
  });
});
