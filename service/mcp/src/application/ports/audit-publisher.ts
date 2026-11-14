import type { PolicyDecision } from '../../domain/policy/policy-decision.js';
import type { Principal } from '../../domain/principal/principal.js';

export type AuthAuditEvent = {
  audit_id: string;
  request_id: string;
  client_name: string;
  principal_type: 'unknown';
  principal_id: 'unknown';
  auth_method: 'api_key' | 'okta_access_token';
  path: string;
  policy_effect: 'deny';
  policy_reason: string;
  error_code: string;
  occurred_at: Date;
};

export type ToolExecutionAuditEvent = {
  audit_id: string;
  request_id: string;
  client_name: string;
  principal: Principal;
  tool_name: string;
  tool_version: string;
  data_source?: string;
  input_sha256: string;
  input_preview_redacted: Record<string, unknown>;
  decision: PolicyDecision;
  error_code?: string;
  occurred_at: Date;
};

export interface AuditPublisher {
  publishToolExecution(event: ToolExecutionAuditEvent): Promise<void>;
  publishAuthEvent(event: AuthAuditEvent): Promise<void>;
}

