export type PolicyEffect = 'allow' | 'deny';

export type ExecutionLimits = {
  max_rows: number;
  timeout_ms: number;
  max_output_bytes: number;
};

export type PolicyDecision = {
  effect: PolicyEffect;
  reason: string;
  limits_applied: ExecutionLimits;
};

