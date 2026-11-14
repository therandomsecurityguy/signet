import type { MiddlewareHandler } from 'hono';
import OktaJwtVerifier from '@okta/jwt-verifier';
import { randomUUID } from 'node:crypto';

import { ErrorCode } from '../../domain/errors/error-codes.js';
import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import type { Env } from '../../infrastructure/config/env.js';
import type { AppEnv } from '../server.js';

export function oktaAuth(input: {
  env: Env;
  audit: AuditPublisher;
}): MiddlewareHandler<AppEnv> {
  const verifier =
    input.env.OKTA_MODE === 'real' && input.env.OKTA_ISSUER
      ? new OktaJwtVerifier({ issuer: input.env.OKTA_ISSUER })
      : null;

  return async (c, next) => {
    const logger = c.get('logger');
    const request_id = c.get('requestId');
    const client_name = c.req.header('X-Agent-Client') ?? 'unknown';

    const header = c.req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      if (c.req.path === '/mcp') {
        const metaUrl = `${new URL(c.req.url).origin}/.well-known/oauth-protected-resource`;
        c.header('WWW-Authenticate', `Bearer resource_metadata="${metaUrl}"`);
      }
      await input.audit.publishAuthEvent({
        audit_id: randomUUID(),
        request_id,
        client_name,
        principal_type: 'unknown',
        principal_id: 'unknown',
        auth_method: 'okta_access_token',
        path: c.req.path,
        policy_effect: 'deny',
        policy_reason: 'missing_bearer',
        error_code: ErrorCode.AuthUnauthenticated,
        occurred_at: new Date(),
      });
      return c.json(
        { error: { code: ErrorCode.AuthUnauthenticated, message: 'Unauthorized.' } },
        401,
      );
    }

    const token = header.slice('Bearer '.length).trim();

    try {
      const principal =
        input.env.OKTA_MODE === 'mock'
          ? mockPrincipal(input.env, token)
          : await verifyRealToken({ verifier, token, env: input.env });

      const requiredScopes = input.env.OKTA_REQUIRED_SCOPES
        ? input.env.OKTA_REQUIRED_SCOPES.split(/\s+/).filter(Boolean)
        : [];
      const missing = requiredScopes.filter((s) => !principal.scopes.includes(s));
      if (missing.length > 0) {
        await input.audit.publishAuthEvent({
          audit_id: randomUUID(),
          request_id,
          client_name,
          principal_type: 'unknown',
          principal_id: 'unknown',
          auth_method: 'okta_access_token',
          path: c.req.path,
          policy_effect: 'deny',
          policy_reason: 'missing_scope',
          error_code: ErrorCode.AuthForbidden,
          occurred_at: new Date(),
        });
        return c.json(
          { error: { code: ErrorCode.AuthForbidden, message: 'Access denied.' } },
          403,
        );
      }

      c.set('principal', principal);
      c.set('logger', logger.child({ principal_id: principal.id, principal_type: principal.type }));
      await next();
    } catch (err) {
      logger.warn({ err }, 'okta authentication failed');
      if (c.req.path === '/mcp') {
        const metaUrl = `${new URL(c.req.url).origin}/.well-known/oauth-protected-resource`;
        c.header('WWW-Authenticate', `Bearer resource_metadata="${metaUrl}"`);
      }
      await input.audit.publishAuthEvent({
        audit_id: randomUUID(),
        request_id,
        client_name,
        principal_type: 'unknown',
        principal_id: 'unknown',
        auth_method: 'okta_access_token',
        path: c.req.path,
        policy_effect: 'deny',
        policy_reason: 'invalid_bearer',
        error_code: ErrorCode.AuthUnauthenticated,
        occurred_at: new Date(),
      });
      return c.json(
        { error: { code: ErrorCode.AuthUnauthenticated, message: 'Unauthorized.' } },
        401,
      );
    }
  };
}

function mockPrincipal(env: Env, token: string) {
  // Any bearer token is accepted in mock mode. This is explicitly for unblocking development.
  const scopes = env.OKTA_REQUIRED_SCOPES
    ? env.OKTA_REQUIRED_SCOPES.split(/\s+/).filter(Boolean)
    : [];

  return {
    type: 'okta_user' as const,
    id: `mock:${token.slice(0, 12) || 'user'}`,
    email: 'mock@example.com',
    displayName: 'Mock Okta User',
    scopes,
    groups: ['mock-group'],
    claims: { mock: true },
    authMethod: 'okta_access_token' as const,
  };
}

async function verifyRealToken(input: {
  verifier: OktaJwtVerifier | null;
  token: string;
  env: Env;
}) {
  if (!input.verifier) {
    throw new Error('Okta verifier not configured');
  }
  if (!input.env.OKTA_AUDIENCE) {
    throw new Error('Missing OKTA_AUDIENCE');
  }

  const jwt = await input.verifier.verifyAccessToken(input.token, input.env.OKTA_AUDIENCE);
  const claims = jwt.claims as Record<string, unknown>;

  const scopes = Array.isArray(claims['scp']) ? (claims['scp'] as string[]) : [];
  const groupsClaim = input.env.OKTA_GROUPS_CLAIM ?? 'groups';
  const groups = Array.isArray(claims[groupsClaim]) ? (claims[groupsClaim] as string[]) : [];

  const email = typeof claims['email'] === 'string' ? claims['email'] : undefined;
  const displayName =
    typeof claims['preferred_username'] === 'string'
      ? claims['preferred_username']
      : undefined;

  return {
    type: 'okta_user' as const,
    id: String(claims['sub'] ?? ''),
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
    scopes,
    groups,
    claims,
    authMethod: 'okta_access_token' as const,
  };
}

