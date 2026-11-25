import type { RegistryFreshness } from '../ports/registry-service.js';

// Deterministic freshness/staleness signal for version-bearing read surfaces
// (build plan 2.1). Purely derived from timestamps already recorded on the
// version node — nothing is cached or written, so every surface reports the
// same answer for the same properties at the same instant.
//
// States:
//   fresh  age_days < FRESHNESS_AGING_DAYS
//   aging  FRESHNESS_AGING_DAYS <= age_days < FRESHNESS_STALE_DAYS
//   stale  age_days >= FRESHNESS_STALE_DAYS, or the certification has expired
//
// Age runs from the newest verification moment known on the node:
// certified_at (a certification restates validation) -> published_at
// (publication requires validation) -> validated_at (validated, not yet
// published). Versions with none of those timestamps carry no freshness
// signal at all (null) — a draft was never verified, which is different from
// "verified long ago".
//
// An expired certification forces `stale` regardless of age and is reported
// separately (`certification_expired`, `expires_in_days`) so consumers can
// distinguish "aged" from "expired". Reasons are machine-readable and listed
// alongside the state; nothing here reads a clock other than `now`.

export const FRESHNESS_AGING_DAYS = 90;
export const FRESHNESS_STALE_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

export type FreshnessInput = {
  certified_at?: string;
  published_at?: string;
  validated_at?: string;
  certification_expires_at?: string;
};

export function freshnessInputFromProperties(properties: Record<string, unknown>): FreshnessInput {
  const out: FreshnessInput = {};
  for (const key of ['certified_at', 'published_at', 'validated_at', 'certification_expires_at'] as const) {
    const value = properties[key];
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

export function computeFreshness(input: FreshnessInput, now: Date = new Date()): RegistryFreshness | null {
  const candidates: Array<[RegistryFreshness['verification_basis'], string | undefined]> = [
    ['certified_at', input.certified_at],
    ['published_at', input.published_at],
    ['validated_at', input.validated_at],
  ];

  let basis: RegistryFreshness['verification_basis'] | null = null;
  let basisMs: number | null = null;
  let basisValue: string | null = null;
  for (const [type, value] of candidates) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) continue;
    basis = type;
    basisMs = parsed;
    basisValue = value;
    break;
  }
  if (basis === null || basisMs === null || basisValue === null) {
    return null;
  }

  const ageDays = Math.max(0, Math.floor((now.getTime() - basisMs) / DAY_MS));
  const reasons: string[] = [];
  let state: RegistryFreshness['freshness'];
  if (ageDays >= FRESHNESS_STALE_DAYS) {
    state = 'stale';
    reasons.push('aged');
  } else if (ageDays >= FRESHNESS_AGING_DAYS) {
    state = 'aging';
    reasons.push('aging');
  } else {
    state = 'fresh';
  }

  let expiresAtMs: number | null = null;
  let expiresAt: string | null = null;
  if (input.certification_expires_at) {
    const parsed = Date.parse(input.certification_expires_at);
    if (Number.isFinite(parsed)) {
      expiresAtMs = parsed;
      expiresAt = input.certification_expires_at;
    }
  }
  const certificationExpired = expiresAtMs !== null && expiresAtMs <= now.getTime();
  if (certificationExpired) {
    state = 'stale';
    reasons.push('certification_expired');
  }

  return {
    freshness: state,
    last_verified_at: basisValue,
    verification_basis: basis,
    age_days: ageDays,
    certification_expires_at: expiresAt,
    certification_expired: certificationExpired,
    expires_in_days: expiresAtMs !== null ? Math.floor((expiresAtMs - now.getTime()) / DAY_MS) : null,
    reasons,
  };
}
