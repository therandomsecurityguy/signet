import type { Principal } from '../../domain/principal/principal.js';

export type AuthAuditEvent = {
  audit_id: string;
  request_id: string;
  client_name: string;
  principal_type: string;
  principal_id: string;
  auth_method: 'api_key' | 'okta_access_token';
  path: string;
  policy_effect: 'deny' | 'allow';
  policy_reason: string;
  error_code: string;
  occurred_at: Date;
};

export type ApiWriteAuditEvent = {
  audit_id: string;
  request_id: string;
  client_name: string;
  principal: Principal;
  path: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  input_sha256: string;
  input_preview_redacted: Record<string, unknown>;
  policy_effect: 'allow' | 'deny';
  policy_reason: string;
  error_code?: string;
  occurred_at: Date;
};

export interface AuditPublisher {
  publishApiWriteEvent(event: ApiWriteAuditEvent): Promise<void>;
  publishAuthEvent(event: AuthAuditEvent): Promise<void>;
}
