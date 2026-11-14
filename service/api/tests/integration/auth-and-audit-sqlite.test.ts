import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

describe('api write auth and audit', () => {
  it('audits missing bearer denial and successful authorized write', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'api-auth-audit-'));
    try {
      const env = loadEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'api_key',
        DATABASE_URL: `file:${path.join(tmp, 'api.db')}`,
        REGISTRY_GRAPH_BACKEND: 'memory',
        REGISTRY_OBJECTS_DIR: path.join(tmp, 'objects'),
      });

      const deps = buildAppDependencies(env);
      await deps.ready();
      const app = buildApp(deps);

      const denied = await app.request('/v1/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skill_key: 'skill:denied' }),
      });
      expect(denied.status).toBe(401);

      const { token } = await deps.apiKeys.create({ owner_label: 'Writer' });
      const created = await app.request('/v1/skills', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          skill_key: 'skill:audited',
          artifact: {
            content: '# secret skill content',
            original_path: 'skills/audited.md',
          },
        }),
      });
      expect(created.status).toBe(201);

      const db = await deps.db.getDb();
      const rows = await db.all<
        Array<{
          event_type: string;
          policy_effect: string;
          policy_reason: string;
          error_code: string | null;
          input_preview_redacted: string | null;
        }>
      >('SELECT event_type, policy_effect, policy_reason, error_code, input_preview_redacted FROM audit_events');

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        event_type: 'auth',
        policy_effect: 'deny',
        policy_reason: 'missing_bearer',
        error_code: 'AUTH_UNAUTHENTICATED',
      });
      expect(rows[1]).toMatchObject({
        event_type: 'api_write',
        policy_effect: 'allow',
        policy_reason: 'created',
        error_code: null,
      });

      const preview = JSON.parse(rows[1]!.input_preview_redacted ?? '{}') as Record<string, unknown>;
      const artifact = preview['artifact'] as Record<string, unknown>;
      expect(artifact['content']).toBe('[REDACTED]');
      expect(typeof artifact['content_sha256']).toBe('string');
      expect(typeof artifact['content_length']).toBe('number');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('protects nested lifecycle and time-aware write routes', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'api-auth-audit-nested-'));
    try {
      const env = loadEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'api_key',
        DATABASE_URL: `file:${path.join(tmp, 'api.db')}`,
        REGISTRY_GRAPH_BACKEND: 'memory',
        TIME_AWARE_GRAPH_BACKEND: 'memory',
        REGISTRY_OBJECTS_DIR: path.join(tmp, 'objects'),
        TIME_AWARE_OBJECTS_DIR: path.join(tmp, 'time-aware-objects'),
      });

      const deps = buildAppDependencies(env);
      await deps.ready();
      const app = buildApp(deps);

      const deniedDraft = await app.request('/v1/skills/skill:nested/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          author: 'jane',
          artifact: {
            content: '# nested skill',
            original_path: 'skills/nested.md',
          },
        }),
      });
      expect(deniedDraft.status).toBe(401);

      const seedCommit = await deps.timeAwareCore.createCommit({
        commit_id: 'c1',
        author: 'seed',
        message: 'seed commit',
      });
      await deps.timeAwareCore.createRef({
        ref_name: 'main',
        commit_urn: seedCommit.value.urn,
        author: 'seed',
      });

      const { token } = await deps.apiKeys.create({ owner_label: 'Nested Writer' });
      const createdDraft = await app.request('/v1/skills/skill:nested/drafts', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          author: 'jane',
          artifact: {
            content: '# nested skill',
            original_path: 'skills/nested.md',
          },
        }),
      });
      expect(createdDraft.status).toBe(200);

      const createdWorkspace = await app.request('/v1/time-aware/refs/main/workspaces/ws-nested/draft', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          owner: 'jane',
        }),
      });
      expect(createdWorkspace.status).toBe(201);

      const db = await deps.db.getDb();
      const rows = await db.all<
        Array<{
          event_type: string;
          policy_effect: string;
          policy_reason: string;
          path: string;
        }>
      >('SELECT event_type, policy_effect, policy_reason, path FROM audit_events ORDER BY rowid');

      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: 'auth',
            policy_effect: 'deny',
            policy_reason: 'missing_bearer',
            path: '/v1/skills/skill:nested/drafts',
          }),
          expect.objectContaining({
            event_type: 'api_write',
            policy_effect: 'allow',
            policy_reason: 'operation_completed',
            path: '/v1/skills/skill:nested/drafts',
          }),
          expect.objectContaining({
            event_type: 'api_write',
            policy_effect: 'allow',
            policy_reason: 'created',
            path: '/v1/time-aware/refs/main/workspaces/ws-nested/draft',
          }),
        ]),
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('validates and describes an authenticated session for api-key and okta flows', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'api-session-auth-'));
    try {
      const apiKeyEnv = loadEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'api_key',
        DATABASE_URL: `file:${path.join(tmp, 'api-key.db')}`,
        REGISTRY_GRAPH_BACKEND: 'memory',
        REGISTRY_OBJECTS_DIR: path.join(tmp, 'objects-api-key'),
      });
      const apiKeyDeps = buildAppDependencies(apiKeyEnv);
      await apiKeyDeps.ready();
      const apiKeyApp = buildApp(apiKeyDeps);
      const { token } = await apiKeyDeps.apiKeys.create({ owner_label: 'Session Writer' });

      const apiKeyRes = await apiKeyApp.request('/v1/session', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      expect(apiKeyRes.status).toBe(200);
      await expect(apiKeyRes.json()).resolves.toMatchObject({
        auth: {
          mode: 'api_key',
          okta_mode: 'mock',
        },
        principal: {
          type: 'api_key',
          auth_method: 'api_key',
        },
      });

      const oktaEnv = loadEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'okta',
        OKTA_MODE: 'mock',
        OKTA_REQUIRED_SCOPES: 'registry.write',
        DATABASE_URL: `file:${path.join(tmp, 'okta.db')}`,
        REGISTRY_GRAPH_BACKEND: 'memory',
        REGISTRY_OBJECTS_DIR: path.join(tmp, 'objects-okta'),
      });
      const oktaDeps = buildAppDependencies(oktaEnv);
      await oktaDeps.ready();
      const oktaApp = buildApp(oktaDeps);

      const oktaRes = await oktaApp.request('/v1/session', {
        headers: {
          Authorization: 'Bearer okta-mock-token',
        },
      });
      expect(oktaRes.status).toBe(200);
      await expect(oktaRes.json()).resolves.toMatchObject({
        auth: {
          mode: 'okta',
          okta_mode: 'mock',
        },
        principal: {
          type: 'okta_user',
          auth_method: 'okta_access_token',
          scopes: ['registry.write'],
        },
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
