import type { Logger } from 'pino';

import type {
  ApiWriteAuditEvent,
  AuditPublisher,
  AuthAuditEvent,
} from '../../application/ports/audit-publisher.js';

export class LogAuditPublisher implements AuditPublisher {
  constructor(private readonly logger: Logger) {}

  async publishApiWriteEvent(event: ApiWriteAuditEvent): Promise<void> {
    this.logger.info(
      {
        audit: {
          audit_id: event.audit_id,
          request_id: event.request_id,
          client_name: event.client_name,
          principal_type: event.principal.type,
          principal_id: event.principal.id,
          path: event.path,
          method: event.method,
          policy_effect: event.policy_effect,
          policy_reason: event.policy_reason,
          error_code: event.error_code,
          occurred_at: event.occurred_at.toISOString(),
        },
      },
      'api write audited',
    );
  }

  async publishAuthEvent(event: AuthAuditEvent): Promise<void> {
    this.logger.info(
      {
        audit: {
          audit_id: event.audit_id,
          request_id: event.request_id,
          client_name: event.client_name,
          principal_type: event.principal_type,
          principal_id: event.principal_id,
          auth_method: event.auth_method,
          path: event.path,
          policy_effect: event.policy_effect,
          policy_reason: event.policy_reason,
          error_code: event.error_code,
          occurred_at: event.occurred_at.toISOString(),
        },
      },
      'auth audited',
    );
  }
}
