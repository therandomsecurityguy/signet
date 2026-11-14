import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { keyHasWriteScope, requiredWriteScopeForPath } from '../../src/domain/principal/scopes.js';

async function buildTestApp(overrides: NodeJS.ProcessEnv = {}) {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
    ...overrides,
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  return { app: buildApp(deps), deps };
}

async function authEventsWithReason(deps: Awaited<ReturnType<typeof buildTestApp>>['deps'], pattern: string) {
  const db = await deps.db.getDb();
  return (await db.all(
    'SELECT policy_reason FROM audit_events WHERE policy_reason LIKE ?',
    pattern,
  )) as Array<{ policy_reason: string }>;
}

describe('scope mapping', () => {
  it('maps write paths to scopes and leaves non-write paths unmapped', () => {
    expect(requiredWriteScopeForPath('/v1/skills/skill:x/drafts')).toBe('skills:write');
    expect(requiredWriteScopeForPath('/v1/agents')).toBe('agents:write');
    expect(requiredWriteScopeForPath('/v1/advisories')).toBe('advisories:write');
    expect(requiredWriteScopeForPath('/v1/attestations')).toBe('attestations:write');
    expect(requiredWriteScopeForPath('/v1/public-keys/key-1/revoke')).toBe('public-keys:write');
    expect(requiredWriteScopeForPath('/v1/transparency-logs/reconcile')).toBe('transparency-logs:write');
    expect(requiredWriteScopeForPath('/v1/ontology-packages')).toBe('ontologies:write');
    expect(requiredWriteScopeForPath('/v1/de-facto-terms/otel/review')).toBe('ontologies:write');
    expect(requiredWriteScopeForPath('/v1/compile/skill')).toBe('skills:write');
    expect(requiredWriteScopeForPath('/v1/openapi.json')).toBeNull();
    expect(requiredWriteScopeForPath('/v1/reviews/pending')).toBeNull();
  });

  it('grandfathers legacy keys with empty scopes and checks membership otherwise', () => {
    expect(keyHasWriteScope({ scopes: [], required: 'advisories:write' })).toBe(true);
    expect(keyHasWriteScope({ scopes: ['skills:write'], required: 'advisories:write' })).toBe(false);
    expect(keyHasWriteScope({ scopes: ['skills:write', 'advisories:write'], required: 'advisories:write' })).toBe(
      true,
    );
  });
});

describe('scope warn mode (default)', () => {
  it('allows the write, records a scope_warning auth event, and leaves reads alone', async () => {
    const { app, deps } = await buildTestApp();
    const { token } = await deps.apiKeys.create({ owner_label: 'narrow-key', scopes: ['skills:write'] });

    // Missing advisories:write -> passes the guard (warn) and then fails body
    // validation, proving the request was not rejected at the auth layer.
    const write = await app.request('/v1/advisories', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    expect(write.status).not.toBe(403);

    const warnings = await authEventsWithReason(deps, 'scope_warning:%');
    expect(warnings.some((row) => row.policy_reason === 'scope_warning:advisories:write')).toBe(true);

    const read = await app.request('/v1/skills', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(200);
  });
});

describe('scope enforce mode', () => {
  it('rejects missing scopes with 403 INSUFFICIENT_SCOPE', async () => {
    const { app, deps } = await buildTestApp({ SCOPE_ENFORCEMENT: 'enforce' });
    const { token } = await deps.apiKeys.create({ owner_label: 'narrow-key', scopes: ['skills:write'] });

    const denied = await app.request('/v1/advisories', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } });
  });

  it('allows writes when the scope is present', async () => {
    const { app, deps } = await buildTestApp({ SCOPE_ENFORCEMENT: 'enforce' });
    const { token } = await deps.apiKeys.create({
      owner_label: 'scoped-key',
      scopes: ['skills:write', 'advisories:write'],
    });

    const allowed = await app.request('/v1/advisories', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    expect(allowed.status).not.toBe(403);
  });

  it('keeps legacy empty-scope keys working and disables the guard for safety after enforcement', async () => {
    const { app, deps } = await buildTestApp({ SCOPE_ENFORCEMENT: 'enforce' });
    const { token } = await deps.apiKeys.create({ owner_label: 'legacy-key', scopes: [] });

    const legacy = await app.request('/v1/advisories', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    expect(legacy.status).not.toBe(403);
  });
});
