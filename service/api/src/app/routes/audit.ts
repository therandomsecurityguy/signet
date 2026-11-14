import { createHash, randomUUID } from 'node:crypto';

import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { Principal } from '../../domain/principal/principal.js';

export async function auditApiWrite(input: {
  audit: AuditPublisher;
  request_id: string;
  client_name: string;
  principal: Principal;
  path: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  raw_input: unknown;
  policy_effect: 'allow' | 'deny';
  policy_reason: string;
  error_code?: string;
}) {
  const json = safeStableStringify(input.raw_input);
  const input_sha256 = createHash('sha256').update(json, 'utf8').digest('hex');
  await input.audit.publishApiWriteEvent({
    audit_id: randomUUID(),
    request_id: input.request_id,
    client_name: input.client_name,
    principal: input.principal,
    path: input.path,
    method: input.method,
    input_sha256,
    input_preview_redacted: redactPreview(input.raw_input),
    policy_effect: input.policy_effect,
    policy_reason: input.policy_reason,
    ...(input.error_code ? { error_code: input.error_code } : {}),
    occurred_at: new Date(),
  });
}

function safeStableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unstringifiable]"';
  }
}

function redactPreview(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return { value: '[non_object]' };
  const obj = { ...(value as Record<string, unknown>) };

  if (obj['artifact'] && typeof obj['artifact'] === 'object') {
    const artifact = { ...(obj['artifact'] as Record<string, unknown>) };
    if (typeof artifact['content'] === 'string') {
      const content = artifact['content'] as string;
      artifact['content_sha256'] = createHash('sha256').update(content, 'utf8').digest('hex');
      artifact['content_length'] = content.length;
      artifact['content'] = '[REDACTED]';
    }
    obj['artifact'] = artifact;
  }

  for (const key of ['token', 'access_token', 'refresh_token', 'password', 'connection_string']) {
    if (key in obj) obj[key] = '[REDACTED]';
  }

  return obj;
}
