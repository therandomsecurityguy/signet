import type { MiddlewareHandler } from 'hono';

import type { Env } from '../../infrastructure/config/env.js';
import type { ApiKeyStore } from '../../application/ports/api-key-store.js';
import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { AppEnv } from '../server.js';
import { apiKeyAuth } from './auth-api-key.js';
import { oktaAuth } from './auth-okta.js';

export function buildAuthMiddleware(input: {
  env: Env;
  apiKeys: ApiKeyStore;
  audit: AuditPublisher;
}): MiddlewareHandler<AppEnv> {
  if (input.env.AUTH_MODE === 'api_key') {
    return apiKeyAuth({ apiKeys: input.apiKeys, audit: input.audit });
  }

  if (input.env.AUTH_MODE === 'okta') {
    return oktaAuth({ env: input.env, audit: input.audit });
  }

  // dual: treat tokens starting with agk_ as API keys, otherwise Okta tokens
  return async (c, next) => {
    const header = c.req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (token.startsWith('agk_')) {
      return await apiKeyAuth({ apiKeys: input.apiKeys, audit: input.audit })(c, next);
    }
    return await oktaAuth({ env: input.env, audit: input.audit })(c, next);
  };
}

