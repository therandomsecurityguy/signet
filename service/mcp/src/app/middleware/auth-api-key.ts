import { randomUUID } from 'node:crypto';

import type { MiddlewareHandler } from 'hono';

import { ErrorCode } from '../../domain/errors/error-codes.js';
import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { ApiKeyStore } from '../../application/ports/api-key-store.js';
import type { AppEnv } from '../server.js';

export function apiKeyAuth(input: {
  apiKeys: ApiKeyStore;
  audit: AuditPublisher;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const logger = c.get('logger');
    const request_id = c.get('requestId');
    const client_name = c.req.header('X-Agent-Client') ?? 'unknown';

    const header = c.req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      await input.audit.publishAuthEvent({
        audit_id: randomUUID(),
        request_id,
        client_name,
        principal_type: 'unknown',
        principal_id: 'unknown',
        auth_method: 'api_key',
        path: c.req.path,
        policy_effect: 'deny',
        policy_reason: 'missing_bearer',
        error_code: ErrorCode.AuthUnauthenticated,
        occurred_at: new Date(),
      });
      logger.warn({ auth: 'missing_bearer' }, 'authentication failed');
      return c.json(
        { error: { code: ErrorCode.AuthUnauthenticated, message: 'Unauthorized.' } },
        401,
      );
    }

    const token = header.slice('Bearer '.length).trim();
    const principal = await input.apiKeys.resolve(token);

    if (!principal) {
      await input.audit.publishAuthEvent({
        audit_id: randomUUID(),
        request_id,
        client_name,
        principal_type: 'unknown',
        principal_id: 'unknown',
        auth_method: 'api_key',
        path: c.req.path,
        policy_effect: 'deny',
        policy_reason: 'invalid_bearer',
        error_code: ErrorCode.AuthUnauthenticated,
        occurred_at: new Date(),
      });
      logger.warn({ auth: 'invalid_bearer' }, 'authentication failed');
      return c.json(
        { error: { code: ErrorCode.AuthUnauthenticated, message: 'Unauthorized.' } },
        401,
      );
    }

    c.set('principal', principal);
    c.set('logger', logger.child({ principal_id: principal.id }));
    await next();
  };
}

