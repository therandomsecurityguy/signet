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
  const { token } = await deps.apiKeys.create({ owner_label: 'Dedupe Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type TestApp = { request: (i: string, init?: RequestInit) => Promise<Response> | Response };

async function seedPublishedSkill(
  app: TestApp,
  token: string,
  skillKey: string,
  input: { description: string; capability_claims?: string[] },
) {
  const created = await app.request('/v1/skills', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ skill_key: skillKey, description: input.description, artifact: { content: `# ${skillKey}` } }),
  });
  expect(created.status).toBe(201);

  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'seed',
      ...(input.capability_claims?.length ? { capability_claims: input.capability_claims } : {}),
      artifact: { content: `# ${skillKey} v1`, original_path: `skills/${skillKey.replace(':', '-')}.md` },
    }),
  });
  expect(draft.status).toBe(200);

  for (const action of ['validate', 'publish']) {
    const res = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/${action}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'seed' }),
    });
    expect(res.status, `${action} on ${skillKey}`).toBe(200);
  }
}

interface DedupeLayer {
  layer: string;
  advisory?: boolean;
  validator?: string;
  threshold?: number;
  checked_against?: number;
  candidates?: Array<{
    logical_key: string;
    score: number;
    shared_claims: string[];
    shared_terms: string[];
    phrase_match: boolean;
  }>;
}

async function loadValidationLayers(app: TestApp, skillKey: string): Promise<DedupeLayer[]> {
  const version = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1`);
  expect(version.status).toBe(200);
  const body = (await version.json()) as {
    governance_artifacts: Array<{ role: string; sha256: string }>;
  };
  for (const artifact of body.governance_artifacts.filter((entry) => entry.role === 'validation_report')) {
    const fetched = await app.request(`/v1/artifacts/${artifact.sha256}`);
    if (fetched.status !== 200) continue;
    const content = (await fetched.json()) as { payload?: { layers?: DedupeLayer[] } };
    if (Array.isArray(content.payload?.layers)) {
      return content.payload.layers;
    }
  }
  throw new Error('no layered validation report found');
}

describe('dedupe advisory layer', () => {
  it('surfaces similar skills as evidence on validation without blocking', async () => {
    const { app, token } = await buildTestApp();
    await seedPublishedSkill(app, token, 'skill:llama-original', {
      description: 'A playful skill used to prove MCP discovery and load.',
      capability_claims: ['demo-claim'],
    });
    await seedPublishedSkill(app, token, 'skill:unrelated', {
      description: 'Gardening tips for balcony tomatoes.',
    });

    // A near-duplicate draft: same description, same capability claim.
    const created = await app.request('/v1/skills', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        skill_key: 'skill:llama-clone',
        description: 'A playful skill used to prove MCP discovery and load.',
        artifact: { content: '# clone' },
      }),
    });
    expect(created.status).toBe(201);
    const draft = await app.request('/v1/skills/skill%3Allama-clone/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'seed',
        capability_claims: ['demo-claim'],
        artifact: { content: '# clone v1', original_path: 'skills/clone.md' },
      }),
    });
    expect(draft.status).toBe(200);

    const validate = await app.request('/v1/skills/skill%3Allama-clone/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'seed' }),
    });
    expect(validate.status).toBe(200);
    const validateBody = (await validate.json()) as {
      result: { skill_version: { properties: Record<string, unknown> } };
    };
    // Advisory only: the version still transitions to validated.
    expect(validateBody.result.skill_version.properties['lifecycle_status']).toBe('validated');

    const layers = await loadValidationLayers(app, 'skill:llama-clone');
    const dedupe = layers.find((layer) => layer.layer === 'dedupe');
    expect(dedupe).toBeDefined();
    expect(dedupe?.advisory).toBe(true);
    expect(dedupe?.validator).toBe('dedupe-v1');
    expect(dedupe?.threshold).toBe(10);
    expect(dedupe?.checked_against).toBe(2);

    const candidates = dedupe?.candidates ?? [];
    expect(candidates.map((candidate) => candidate.logical_key)).toEqual(['skill:llama-original']);
    expect(candidates[0]?.shared_claims).toEqual(['demo-claim']);
    expect(candidates[0]?.score).toBeGreaterThanOrEqual(10);
    expect(candidates[0]?.phrase_match).toBe(true);
  });

  it('records an empty candidate list for unique versions', async () => {
    const { app, token } = await buildTestApp();
    await seedPublishedSkill(app, token, 'skill:one', { description: 'Quantum telemetry dashboards.' });
    await seedPublishedSkill(app, token, 'skill:unique', { description: 'Fermentation schedules for sourdough.' });

    const layers = await loadValidationLayers(app, 'skill:unique');
    const dedupe = layers.find((layer) => layer.layer === 'dedupe');
    expect(dedupe).toBeDefined();
    expect(dedupe?.checked_against).toBe(1);
    expect(dedupe?.candidates).toEqual([]);
  });
});
