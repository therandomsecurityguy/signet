import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Policy Writer' });
  return { app: buildApp(deps), token };
}

const DESCRIPTION_POLICY_SHAPES = {
  shapes: [
    {
      id: 'policy/skill-version-description',
      target: { entity_type: 'SKILL_VERSION' },
      properties: [
        { path: 'description', minCount: 1, maxCount: 1, datatype: 'string', message: 'description_required_by_policy' },
      ],
    },
  ],
};

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

describe('policy packages', () => {
  it('registers, lists, and fetches policy packages idempotently', async () => {
    const { app, token } = await buildTestApp();

    const create = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'test-policy/v1',
        author: 'pablo',
        shapes: DESCRIPTION_POLICY_SHAPES,
        description: 'requires descriptions on skill versions',
      }),
    });
    expect(create.status).toBe(201);
    const createdBody = (await create.json()) as {
      policy_package: { artifact_urn: string; sha256: string; policy_version: string };
      created: boolean;
    };
    expect(createdBody.created).toBe(true);
    expect(createdBody.policy_package.policy_version).toBe('test-policy/v1');

    // Idempotent re-register with identical shapes.
    const recreate = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ policy_version: 'test-policy/v1', author: 'pablo', shapes: DESCRIPTION_POLICY_SHAPES }),
    });
    expect(recreate.status).toBe(200);
    await expect(recreate.json()).resolves.toMatchObject({ created: false });

    // Conflicting shapes for the same policy version are rejected.
    const conflict = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'test-policy/v1',
        author: 'pablo',
        shapes: { shapes: [{ id: 'policy/other', target: { entity_type: 'SKILL_VERSION' } }] },
      }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: 'POLICY_PACKAGE_CONFLICT' } });

    // Invalid shape documents are rejected at registration.
    const invalid = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ policy_version: 'test-policy/v2', author: 'pablo', shapes: { shapes: [] } }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'POLICY_PACKAGE_INVALID' } });

    // Perl-only pattern syntax unsupported by RE2 is rejected at registration.
    const unsupported = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'test-policy/v3',
        author: 'pablo',
        shapes: {
          shapes: [
            {
              id: 'policy/lookahead',
              target: { entity_type: 'SKILL_VERSION' },
              properties: [{ path: 'description', pattern: 'a(?=b)' }],
            },
          ],
        },
      }),
    });
    expect(unsupported.status).toBe(400);
    await expect(unsupported.json()).resolves.toMatchObject({ error: { code: 'POLICY_PACKAGE_INVALID' } });

    // Catastrophic-backtracking patterns register fine: execution uses the
    // linear-time RE2 engine, so they cannot stall validation (ReDoS-safe).
    const redosSafe = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'test-policy/v4',
        author: 'pablo',
        shapes: {
          shapes: [
            {
              id: 'policy/nested-quantifier',
              target: { entity_type: 'SKILL_VERSION' },
              properties: [{ path: 'description', pattern: '(a+)+$' }],
            },
          ],
        },
      }),
    });
    expect(redosSafe.status).toBe(201);

    const get = await app.request('/v1/policy-packages/test-policy%2Fv1');
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({
      artifact_urn: createdBody.policy_package.artifact_urn,
      policy_version: 'test-policy/v1',
      shapes: DESCRIPTION_POLICY_SHAPES,
    });

    const missing = await app.request('/v1/policy-packages/test-policy%2Fmissing');
    expect(missing.status).toBe(404);

    const list = await app.request('/v1/policy-packages');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { policy_packages: Array<{ policy_version: string }> };
    expect(listBody.policy_packages.map((p) => p.policy_version)).toContain('test-policy/v1');
  });

  it('gates draft validation on registered policy shapes and stores violation reports', async () => {
    const { app, token } = await buildTestApp();
    expect(
      (
        await app.request('/v1/policy-packages', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ policy_version: 'strict/v1', author: 'pablo', shapes: DESCRIPTION_POLICY_SHAPES }),
        })
      ).status,
    ).toBe(201);

    // Draft bound to the strict policy but missing the required description.
    const draft = await app.request('/v1/skills/skill:policy-gated/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# gated', original_path: 'skills/policy-gated.md' },
        governance: { policy_version: 'strict/v1' },
      }),
    });
    expect(draft.status).toBe(200);

    const validate = await app.request('/v1/skills/skill:policy-gated/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(validate.status).toBe(200);
    await expect(validate.json()).resolves.toMatchObject({
      result: {
        skill_version: {
          properties: {
            lifecycle_status: 'rejected',
            validation_status: 'failed',
            validation_failures: ['description_required_by_policy'],
          },
        },
      },
    });

    // The validation run stored a machine-readable report artifact linked
    // via sg:validatedBy.
    const version = await app.request('/v1/skills/skill:policy-gated/versions/1');
    expect(version.status).toBe(200);
    const versionBody = (await version.json()) as {
      governance_artifacts: Array<{ role: string; artifact_urn: string; sha256?: string }>;
    };
    const reports = versionBody.governance_artifacts.filter((a) => a.role === 'validation_report');
    expect(reports.length).toBeGreaterThan(0);

    // Publish is blocked while policy violations stand.
    const publish = await app.request('/v1/skills/skill:policy-gated/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(publish.status).toBe(409);

    // A conforming draft passes policy validation.
    const goodDraft = await app.request('/v1/skills/skill:policy-conforming/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        description: 'documented skill',
        artifact: { content: '# conforming', original_path: 'skills/policy-conforming.md' },
        governance: { policy_version: 'strict/v1' },
      }),
    });
    expect(goodDraft.status).toBe(200);
    const goodValidate = await app.request('/v1/skills/skill:policy-conforming/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(goodValidate.status).toBe(200);
    await expect(goodValidate.json()).resolves.toMatchObject({
      result: { skill_version: { properties: { lifecycle_status: 'validated' } } },
    });
  });

  it('links the registered policy package at publish time instead of a placeholder', async () => {
    const { app, token } = await buildTestApp();
    const create = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ policy_version: 'publish-policy/v1', author: 'pablo', shapes: DESCRIPTION_POLICY_SHAPES }),
    });
    expect(create.status).toBe(201);
    const { policy_package: policyPackage } = (await create.json()) as {
      policy_package: { artifact_urn: string };
    };

    const draft = await app.request('/v1/skills/skill:policy-published/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        description: 'documented skill',
        artifact: { content: '# published', original_path: 'skills/policy-published.md' },
        governance: { policy_version: 'publish-policy/v1' },
      }),
    });
    expect(draft.status).toBe(200);
    const publish = await app.request('/v1/skills/skill:policy-published/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(publish.status).toBe(200);

    const envelope = await app.request('/v1/skills/skill:policy-published/versions/1/publication-envelope');
    expect(envelope.status).toBe(200);
    const body = (await envelope.json()) as {
      governance_artifacts: Array<{ role: string; artifact_urn: string }>;
    };
    const policyRefs = body.governance_artifacts.filter((a) => a.role === 'policy_package');
    expect(policyRefs).toHaveLength(1);
    expect(policyRefs[0]?.artifact_urn).toBe(policyPackage.artifact_urn);
  });
});
