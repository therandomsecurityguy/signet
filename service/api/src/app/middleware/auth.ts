import type { Context, MiddlewareHandler } from 'hono';
import { randomUUID } from 'node:crypto';

import type { ApiKeyStore } from '../../application/ports/api-key-store.js';
import type { AuditPublisher } from '../../application/ports/audit-publisher.js';
import { keyHasWriteScope, requiredWriteScopeForPath } from '../../domain/principal/scopes.js';
import type { Env } from '../../infrastructure/config/env.js';
import type { AppEnv } from '../server.js';
import { apiKeyAuth } from './auth-api-key.js';
import { oktaAuth } from './auth-okta.js';

export function buildWriteAuthMiddleware(input: {
  env: Env;
  apiKeys: ApiKeyStore;
  audit: AuditPublisher;
}): MiddlewareHandler<AppEnv> {
  return buildAuthMiddleware({
    ...input,
    protectWritesOnly: true,
  });
}

export function buildAuthMiddleware(input: {
  env: Env;
  apiKeys: ApiKeyStore;
  audit: AuditPublisher;
  protectWritesOnly?: boolean;
}): MiddlewareHandler<AppEnv> {
const auth =
    input.env.AUTH_MODE === 'api_key'
      ? apiKeyAuth({ apiKeys: input.apiKeys, audit: input.audit })
      : input.env.AUTH_MODE === 'okta'
        ? oktaAuth(buildOktaAuthInput(input))
        : dualAuth(input);

  return async (c, next) => {
    if (input.protectWritesOnly && !isWriteMethod(c.req.method)) {
      return await next();
    }
    let scopeDenied: Response | undefined;
    const authResult = await auth(c, async () => {
      scopeDenied = (await checkWriteScope(c, input)) ?? undefined;
      if (!scopeDenied) await next();
    });
    // Propagate auth-layer short-circuits (401/403); otherwise the scope
    // guard's rejection (if any) wins.
    return authResult ?? scopeDenied;
  };
}

/**
 * API-key write-scope check. Runs after authentication sets the principal:
 * warn mode records a scope_warning auth event and allows; enforce mode
 * rejects with 403 INSUFFICIENT_SCOPE. Human (Okta) principals are not
 * scope-limited; legacy keys with an empty scope list are grandfathered.
 */
async function checkWriteScope(
  c: Context<AppEnv>,
  input: { env: Env; audit: AuditPublisher },
): Promise<Response | null> {
  if (!isWriteMethod(c.req.method)) return null;
  const principal = c.get('principal');
  if (!principal || principal.type !== 'api_key') return null;
  const required = requiredWriteScopeForPath(c.req.path);
  if (!required) return null;
  if (keyHasWriteScope({ scopes: principal.scopes, required })) return null;

  const base = {
    request_id: c.get('requestId'),
    client_name: c.req.header('X-Agent-Client') ?? 'unknown',
    principal_type: 'api_key' as const,
    principal_id: principal.id,
    auth_method: 'api_key' as const,
    path: c.req.path,
    occurred_at: new Date(),
  };
  if (input.env.SCOPE_ENFORCEMENT === 'enforce') {
    await input.audit.publishAuthEvent({
      audit_id: randomUUID(),
      ...base,
      policy_effect: 'deny',
      policy_reason: `scope_missing:${required}`,
      error_code: 'INSUFFICIENT_SCOPE',
    });
    return c.json(
      { error: { code: 'INSUFFICIENT_SCOPE', message: `API key is missing the required scope: ${required}.` } },
      403,
    );
  }
  await input.audit.publishAuthEvent({
    audit_id: randomUUID(),
    ...base,
    policy_effect: 'allow',
    policy_reason: `scope_warning:${required}`,
    error_code: 'SCOPE_WARNING',
  });
  c.get('logger').warn(
    { required_scope: required, path: c.req.path, key_id: principal.id },
    'api key is missing a write scope (warn mode; enforcement flips with SCOPE_ENFORCEMENT=enforce)',
  );
  return null;
}

function dualAuth(input: {
  env: Env;
  apiKeys: ApiKeyStore;
  audit: AuditPublisher;
  protectWritesOnly?: boolean;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (token.startsWith('agk_')) {
      return await apiKeyAuth({ apiKeys: input.apiKeys, audit: input.audit })(c, next);
    }
    return await oktaAuth(buildOktaAuthInput(input))(c, next);
  };
}

function buildOktaAuthInput(input: {
  env: Env;
  audit: AuditPublisher;
  protectWritesOnly?: boolean;
}) {
  const adminGroups = parseAdminGroups(input.env.OKTA_ADMIN_GROUPS);
  return {
    env: input.env,
    audit: input.audit,
    ...(adminGroups.length > 0 ? { adminGroups } : {}),
    ...(input.protectWritesOnly ? { requireAdminForWrites: true } : {}),
  };
}

function isWriteMethod(method: string) {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

/**
 * API keys may not manage API keys; reject them before Okta verification so the
 * key-management endpoints are reachable only by human (Okta) principals.
 */
export function buildApiKeyPrincipalGuard(input: { audit: AuditPublisher }): MiddlewareHandler<AppEnv> {
  const AUTH_FORBIDDEN = 'AUTH_FORBIDDEN';
  return async (c, next) => {
    const header = c.req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (token.startsWith('agk_')) {
      await input.audit.publishAuthEvent({
        audit_id: randomUUID(),
        request_id: c.get('requestId'),
        client_name: c.req.header('X-Agent-Client') ?? 'unknown',
        principal_type: 'api_key',
        principal_id: 'unknown',
        auth_method: 'api_key',
        path: c.req.path,
        policy_effect: 'deny',
        policy_reason: 'api_key_cannot_manage_keys',
        error_code: AUTH_FORBIDDEN,
        occurred_at: new Date(),
      });
      return c.json({ error: { code: AUTH_FORBIDDEN, message: 'API keys cannot manage API keys.' } }, 403);
    }
    await next();
  };
}

/**
 * Okta authentication that requires an admin group for every method (not just
 * writes). Fails closed when no admin groups are configured.
 */
export function buildAdminAuth(input: {
  env: Env;
  apiKeys: ApiKeyStore;
  audit: AuditPublisher;
}): MiddlewareHandler<AppEnv> {
  const adminGroups = parseAdminGroups(input.env.OKTA_ADMIN_GROUPS);
  if (adminGroups.length === 0) {
    return async (c) =>
      c.json({ error: { code: 'AUTH_FORBIDDEN', message: 'Admin access is not configured.' } }, 403);
  }
  return oktaAuth({ env: input.env, audit: input.audit, adminGroups, requireAdminForAll: true });
}

function parseAdminGroups(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/\s*,\s*/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
