import type { PolicyService } from '../../application/ports/policy-service.js';
import type { PolicyDecision } from '../../domain/policy/policy-decision.js';

export class AllowAllPolicyService implements PolicyService {
  async evaluate(): Promise<PolicyDecision> {
    return {
      effect: 'allow',
      reason: 'default_allow',
      limits_applied: {
        max_rows: 50,
        timeout_ms: 15_000,
        max_output_bytes: 65_536,
      },
    };
  }
}

