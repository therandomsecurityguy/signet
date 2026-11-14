import type {
  ApiWriteAuditEvent,
  AuditPublisher,
  AuthAuditEvent,
} from '../../application/ports/audit-publisher.js';

export class FanoutAuditPublisher implements AuditPublisher {
  constructor(private readonly publishers: AuditPublisher[]) {}

  async publishApiWriteEvent(event: ApiWriteAuditEvent): Promise<void> {
    for (const publisher of this.publishers) {
      await publisher.publishApiWriteEvent(event);
    }
  }

  async publishAuthEvent(event: AuthAuditEvent): Promise<void> {
    for (const publisher of this.publishers) {
      await publisher.publishAuthEvent(event);
    }
  }
}
