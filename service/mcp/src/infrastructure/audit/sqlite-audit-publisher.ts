import type { Db } from '../persistence/db.js';
import type {
  AuditPublisher,
  AuthAuditEvent,
  ToolExecutionAuditEvent,
} from '../../application/ports/audit-publisher.js';

export class SqliteAuditPublisher implements AuditPublisher {
  constructor(private readonly dbProvider: { getDb(): Promise<Db> }) {}

  async publishToolExecution(event: ToolExecutionAuditEvent): Promise<void> {
    const db = await this.dbProvider.getDb();
    await db.run(
      `
INSERT INTO audit_events (
  audit_id, event_type, occurred_at, request_id, client_name,
  principal_type, principal_id, auth_method,
  tool_name, tool_version, data_source, input_sha256, input_preview_redacted,
  policy_effect, policy_reason, limits_applied, error_code
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`.trim(),
      event.audit_id,
      'tool',
      event.occurred_at.toISOString(),
      event.request_id,
      event.client_name,
      event.principal.type,
      event.principal.id,
      event.principal.authMethod,
      event.tool_name,
      event.tool_version,
      event.data_source ?? null,
      event.input_sha256,
      JSON.stringify(event.input_preview_redacted),
      event.decision.effect,
      event.decision.reason,
      JSON.stringify(event.decision.limits_applied),
      event.error_code ?? null,
    );
  }

  async publishAuthEvent(event: AuthAuditEvent): Promise<void> {
    const db = await this.dbProvider.getDb();
    await db.run(
      `
INSERT INTO audit_events (
  audit_id, event_type, occurred_at, request_id, client_name,
  principal_type, principal_id, auth_method,
  path,
  policy_effect, policy_reason, limits_applied, error_code
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`.trim(),
      event.audit_id,
      'auth',
      event.occurred_at.toISOString(),
      event.request_id,
      event.client_name,
      event.principal_type,
      event.principal_id,
      event.auth_method,
      event.path,
      event.policy_effect,
      event.policy_reason,
      JSON.stringify({
        max_rows: 0,
        timeout_ms: 0,
        max_output_bytes: 0,
      }),
      event.error_code,
    );
  }
}

