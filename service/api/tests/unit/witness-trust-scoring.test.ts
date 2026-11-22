import { describe, expect, it } from 'vitest';

import {
  computeWitnessTrustScoring,
  WITNESS_TRUST_WEIGHTS,
} from '../../../registry/application/services/witness-trust-scoring.js';

const base = {
  logs_attached: 2,
  logs_total: 2,
  logs_witnessed: 2,
  checkpoints_witnessed: 4,
  checkpoints_available: 4,
  last_witnessed_at: '2026-11-20T00:00:00.000Z',
  newest_checkpoint_at: '2026-11-20T00:00:00.000Z',
};

describe('witness trust scoring (advisory)', () => {
  it('scores full coverage 100 with explicit components and weights', () => {
    const scoring = computeWitnessTrustScoring(base);
    expect(scoring.score).toBe(100);
    expect(scoring.components).toEqual({ breadth: 1, participation: 1, recency: 1 });
    expect(scoring.weights).toEqual(WITNESS_TRUST_WEIGHTS);
    expect(scoring.evidence).toEqual(base);
  });

  it('scores an empty/silent witness 0', () => {
    const scoring = computeWitnessTrustScoring({
      logs_attached: 1,
      logs_total: 2,
      logs_witnessed: 0,
      checkpoints_witnessed: 0,
      checkpoints_available: 3,
    });
    expect(scoring.score).toBe(0);
    expect(scoring.components).toEqual({ breadth: 0, participation: 0, recency: 0 });
  });

  it('derives recency from data timestamps only (data-relative, never wall clock)', () => {
    // 15 days behind the newest checkpoint in the network -> half the window.
    const partial = computeWitnessTrustScoring({
      ...base,
      last_witnessed_at: '2026-11-05T00:00:00.000Z',
      newest_checkpoint_at: '2026-11-20T00:00:00.000Z',
    });
    expect(partial.components.recency).toBe(0.5);
    // Older than the window clamps to 0.
    const stale = computeWitnessTrustScoring({
      ...base,
      last_witnessed_at: '2026-09-01T00:00:00.000Z',
      newest_checkpoint_at: '2026-11-20T00:00:00.000Z',
    });
    expect(stale.components.recency).toBe(0);
    // Missing timestamps score recency 0.
    const undated = computeWitnessTrustScoring({
      logs_attached: 1,
      logs_total: 1,
      logs_witnessed: 1,
      checkpoints_witnessed: 1,
      checkpoints_available: 1,
    });
    expect(undated.components.recency).toBe(0);
    // Deterministic for identical inputs.
    expect(computeWitnessTrustScoring(base)).toEqual(computeWitnessTrustScoring(base));
  });

  it('rounds ratios to two decimals and the score to one', () => {
    const scoring = computeWitnessTrustScoring({
      logs_attached: 3,
      logs_total: 3,
      logs_witnessed: 1,
      checkpoints_witnessed: 1,
      checkpoints_available: 3,
      last_witnessed_at: '2026-11-10T00:00:00.000Z',
      newest_checkpoint_at: '2026-11-20T00:00:00.000Z',
    });
    expect(scoring.components.breadth).toBe(0.33);
    expect(scoring.components.participation).toBe(0.33);
    expect(scoring.components.recency).toBe(0.67);
    // 0.4*0.33 + 0.4*0.33 + 0.2*0.67 = 0.398 -> 39.8
    expect(scoring.score).toBe(39.8);
  });
});
