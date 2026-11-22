/**
 * Witness trust scoring (ADVISORY).
 *
 * A deterministic, fully explainable score derived ONLY from cryptographic
 * coverage evidence — nothing in validation, quorum, or gating reads it.
 * Inputs come from the witness coverage report (per-log checkpoints
 * witnessed from valid attestations or verified cosignatures, recency).
 *
 * Components (all 0..1, rounded to 2 decimals):
 * - breadth:       logs with evidence / logs in the network
 * - participation: checkpoints witnessed / checkpoints available across the
 *                  witness's attached logs
 * - recency:       1 - age_days/30 against the NEWEST checkpoint timestamp
 *                  in the network (data-relative, never wall clock — the
 *                  same data always produces the same score), clamped [0,1]
 * score = 100 * (0.4*breadth + 0.4*participation + 0.2*recency), 1 decimal.
 */

export const WITNESS_TRUST_WEIGHTS = { breadth: 0.4, participation: 0.4, recency: 0.2 } as const;
export const WITNESS_TRUST_RECENCY_WINDOW_DAYS = 30;

export type WitnessTrustScoringInput = {
  logs_attached: number;
  logs_total: number;
  logs_witnessed: number;
  checkpoints_witnessed: number;
  checkpoints_available: number;
  last_witnessed_at?: string;
  newest_checkpoint_at?: string;
};

export type WitnessTrustScoring = {
  score: number;
  components: { breadth: number; participation: number; recency: number };
  weights: { breadth: number; participation: number; recency: number };
  evidence: WitnessTrustScoringInput;
};

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100) / 100;
}

function ageDaysInWindow(lastWitnessedAt: string, newestCheckpointAt: string): number {
  const last = Date.parse(lastWitnessedAt);
  const newest = Date.parse(newestCheckpointAt);
  if (Number.isNaN(last) || Number.isNaN(newest)) return 0;
  const ageDays = Math.max(0, (newest - last) / (24 * 60 * 60 * 1000));
  return Math.round((1 - ageDays / WITNESS_TRUST_RECENCY_WINDOW_DAYS) * 100) / 100;
}

export function computeWitnessTrustScoring(input: WitnessTrustScoringInput): WitnessTrustScoring {
  const breadth = ratio(input.logs_witnessed, input.logs_total);
  const participation = ratio(input.checkpoints_witnessed, input.checkpoints_available);
  const recency =
    input.last_witnessed_at && input.newest_checkpoint_at
      ? Math.max(0, ageDaysInWindow(input.last_witnessed_at, input.newest_checkpoint_at))
      : 0;
  const score = Math.round((breadth * WITNESS_TRUST_WEIGHTS.breadth + participation * WITNESS_TRUST_WEIGHTS.participation + recency * WITNESS_TRUST_WEIGHTS.recency) * 100 * 10) / 10;
  return {
    score,
    components: { breadth, participation, recency },
    weights: { ...WITNESS_TRUST_WEIGHTS },
    evidence: { ...input },
  };
}
