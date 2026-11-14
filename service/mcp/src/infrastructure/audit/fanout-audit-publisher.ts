import type {
  AuditPublisher,
  AuthAuditEvent,
  ToolExecutionAuditEvent,
} from '../../application/ports/audit-publisher.js';

export class FanoutAuditPublisher implements AuditPublisher {
  constructor(private readonly publishers: AuditPublisher[]) {}

  async publishToolExecution(event: ToolExecutionAuditEvent): Promise<void> {
    for (const publisher of this.publishers) {
      await publisher.publishToolExecution(event);
    }
  }

  async publishAuthEvent(event: AuthAuditEvent): Promise<void> {
    for (const publisher of this.publishers) {
      await publisher.publishAuthEvent(event);
    }
  }
}

