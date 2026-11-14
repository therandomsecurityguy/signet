import type { PolicyDecision } from '../../domain/policy/policy-decision.js';
import type { Principal } from '../../domain/principal/principal.js';

export type PolicyEvaluationInput = {
  principal: Principal;
  tool_name: string;
  parsed_input: unknown;
};

export interface PolicyService {
  evaluate(input: PolicyEvaluationInput): Promise<PolicyDecision>;
}

