import type { RegistryTrustScore } from '../ports/registry-service.js';

// Deterministic trust ranking for list/search surfaces.
//
// score = tier_weight * 10 + recency_component + usage_component
//
// Tier dominance is structural: the 10-point gap between lifecycle tiers is
// larger than the maximum recency bonus (1) plus the maximum usage bonus
// (0.5), so a fresh, heavily used published entity can never outrank an
// older certified one — "certification state > publication recency". Ties
// break on the logical key (ascending) for stable ordering.
//
// Recency uses the newest of certified_at / published_at / validated_at /
// revalidated_at. Usage (build plan 3.1) joins as an aggregate, capped
// component: 100 recorded loads saturate at 0.5. Components are always
// exposed next to the score so ordering is never a black box.

const TIER_WEIGHTS: Record<string, number> = {
  certified: 3,
  published: 2,
  validated: 1,
  draft: 0.5,
  rejected: 0,
  revoked: 0,
  archived: 0,
  none: 0,
};

const RECENCY_WINDOW_DAYS = 180;
const USAGE_SATURATION_LOADS = 100;
const USAGE_MAX_COMPONENT = 0.5;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TrustScoreInput = {
  lifecycle_status: string | null;
  certified?: boolean;
  certified_at?: string;
  published_at?: string;
  /** Aggregate load count for the version (build plan 3.1); absent = 0. */
  load_count?: number;
};

export function scoreTrust(input: TrustScoreInput, now: Date = new Date()): RegistryTrustScore {
  const status = normalizeStatus(input.lifecycle_status, input.certified === true);
  const tierWeight = TIER_WEIGHTS[status] ?? 0;

  const timestamp = input.certified_at ?? input.published_at;
  let recencyDays: number | null = null;
  let recencyComponent = 0;
  if (timestamp) {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) {
      recencyDays = Math.max(0, Math.floor((now.getTime() - parsed) / DAY_MS));
      recencyComponent = Math.max(0, 1 - recencyDays / RECENCY_WINDOW_DAYS);
    }
  }

  const usageLoads =
    typeof input.load_count === 'number' && Number.isFinite(input.load_count)
      ? Math.max(0, Math.floor(input.load_count))
      : null;
  const usageComponent =
    usageLoads === null ? 0 : Math.min(usageLoads, USAGE_SATURATION_LOADS) / USAGE_SATURATION_LOADS * USAGE_MAX_COMPONENT;

  return {
    score: round4(tierWeight * 10 + recencyComponent + usageComponent),
    lifecycle_status: status,
    tier_weight: tierWeight,
    recency_days: recencyDays,
    recency_component: round4(recencyComponent),
    usage_loads: usageLoads,
    usage_component: round4(usageComponent),
  };
}

export function compareTrust(
  left: { logical_key: string; trust: RegistryTrustScore },
  right: { logical_key: string; trust: RegistryTrustScore },
): number {
  if (right.trust.score !== left.trust.score) {
    return right.trust.score - left.trust.score;
  }
  if (left.logical_key === right.logical_key) return 0;
  return left.logical_key < right.logical_key ? -1 : 1;
}

function normalizeStatus(lifecycleStatus: string | null, certified: boolean): string {
  if (certified) return 'certified';
  const status = (lifecycleStatus ?? '').toLowerCase();
  return status in TIER_WEIGHTS ? status : 'none';
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
