import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const templatesDir = path.join(repoRoot, 'docs', 'policy-templates');

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Templates Test' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type TestApp = { request: (i: string, init?: RequestInit) => Promise<Response> | Response };

// Mirrors the gate table in docs/policy-templates/README.md: the gate that
// turns each template into the policy it claims to be.
const GATES_BY_TEMPLATE: Record<string, Record<string, boolean>> = {
  'description-required.ttl': { require_validation: true },
  'human-review-required.ttl': { require_human_review: true },
  'sbom-required.ttl': { require_sbom: true },
  'trusted-publisher.ttl': { require_trusted_publisher: true },
};

async function seedSkill(app: TestApp, token: string, skillKey: string, description?: string) {
  const create = await app.request('/v1/skills', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ skill_key: skillKey, artifact: { content: `# ${skillKey}` } }),
  });
  expect(create.status).toBe(201);
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'templates-test',
      ...(description ? { description } : {}),
      governance: { policy_version: 'policy/description-required/v1' },
      artifact: { content: `# ${skillKey} v1`, original_path: `skills/${skillKey.replaceAll(':', '-')}.md` },
    }),
  });
  expect(draft.status).toBe(200);
}

describe('policy template library', () => {
  it('every template registers through the real API', async () => {
    const { app, token } = await buildTestApp();
    const files = (await readdir(templatesDir)).filter((name) => name.endsWith('.ttl')).sort();
    expect(files).toEqual(Object.keys(GATES_BY_TEMPLATE).sort());

    for (const file of files) {
      const shapes = await readFile(path.join(templatesDir, file), 'utf8');
      const res = await app.request('/v1/policy-packages', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          policy_version: `policy/${file.replace('.ttl', '')}/v1`,
          author: 'templates-test',
          shapes_format: 'shacl-turtle',
          description: `Template fixture for ${file}`,
          shapes,
          ...GATES_BY_TEMPLATE[file],
        }),
      });
      if (res.status !== 201) {
        throw new Error(`${file} failed to register: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as { created: boolean; policy_package: { shapes_format: string } };
      expect(body.created).toBe(true);
      expect(body.policy_package.shapes_format).toBe('shacl-turtle');

      // Re-registration is idempotent (same bytes).
      const again = await app.request('/v1/policy-packages', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          policy_version: `policy/${file.replace('.ttl', '')}/v1`,
          author: 'templates-test',
          shapes_format: 'shacl-turtle',
          description: `Template fixture for ${file}`,
          shapes,
          ...GATES_BY_TEMPLATE[file],
        }),
      });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { created: boolean }).created).toBe(false);
    }
  });

  it('description-required.ttl works end to end as a starting point', async () => {
    const { app, token } = await buildTestApp();
    const shapes = await readFile(path.join(templatesDir, 'description-required.ttl'), 'utf8');
    const register = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'policy/description-required/v1',
        author: 'templates-test',
        shapes_format: 'shacl-turtle',
        shapes,
        require_validation: true,
      }),
    });
    expect(register.status).toBe(201);

    // A version without a description is rejected with the template's message.
    await seedSkill(app, token, 'skill:no-description');
    const failed = await app.request('/v1/skills/skill%3Ano-description/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'templates-test' }),
    });
    expect(failed.status).toBe(200);
    const failedBody = (await failed.json()) as {
      task: { task: { properties: Record<string, unknown> } };
      result: { skill_version: { properties: Record<string, unknown> } };
    };
    expect(failedBody.task.task.properties['validation_status']).toBe('failed');
    expect(String(failedBody.task.task.properties['validation_failures'])).toContain('description_required');
    expect(failedBody.result.skill_version.properties['lifecycle_status']).toBe('rejected');

    // A version with a description validates cleanly.
    await seedSkill(app, token, 'skill:with-description', 'A described skill.');
    const passed = await app.request('/v1/skills/skill%3Awith-description/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'templates-test' }),
    });
    expect(passed.status).toBe(200);
    const passedBody = (await passed.json()) as { result: { skill_version: { properties: Record<string, unknown> } } };
    expect(passedBody.result.skill_version.properties['lifecycle_status']).toBe('validated');
  });
});
