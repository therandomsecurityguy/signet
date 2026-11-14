import { trace } from '@opentelemetry/api';
import type { Logger } from 'pino';

export function makeRequestLogger(
  base: Logger,
  input: {
    requestId: string;
    clientName?: string;
    principalId?: string;
    auditId?: string;
  },
) {
  const span = trace.getActiveSpan();
  const spanCtx = span?.spanContext();

  return base.child({
    request_id: input.requestId,
    client_name: input.clientName,
    principal_id: input.principalId,
    audit_id: input.auditId,
    trace_id: spanCtx?.traceId,
    span_id: spanCtx?.spanId,
  });
}

