import type { Hono } from 'hono';

import type { Env } from '../../infrastructure/config/env.js';
import type { AppEnv } from '../server.js';

export function registerOAuthMetadataRoutes(app: Hono<AppEnv>, env: Env) {
  app.get('/.well-known/oauth-protected-resource', (c) => {
    const resource = `${c.req.url.replace(/\/+$/, '')}`.replace(/\/\.well-known\/oauth-protected-resource$/, '/mcp');
    const authorization_servers = env.OKTA_ISSUER ? [env.OKTA_ISSUER] : [];
    const scopes_supported = env.OKTA_REQUIRED_SCOPES
      ? env.OKTA_REQUIRED_SCOPES.split(/\s+/).filter(Boolean)
      : [];

    return c.json(
      {
        resource,
        authorization_servers,
        bearer_methods_supported: ['header'],
        scopes_supported,
      },
      200,
    );
  });
}

