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
  const { token } = await deps.apiKeys.create({ owner_label: 'Agent Lifecycle Writer' });
  return { app: buildApp(deps), token };
}

type TestAppLike = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

async function versionAction(
  app: TestAppLike,
  token: string,
  agentKey: string,
  version: number,
  action: string,
  body: Record<string, unknown> = { author: 'pablo' },
) {
  return await app.request(
    `/v1/agents/${encodeURIComponent(agentKey)}/versions/${version}/${action}`,
    { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) },
  );
}

async function getVersion(app: TestAppLike, agentKey: string, version: number) {
  const list = await app.request(`/v1/agents/${encodeURIComponent(agentKey)}/versions`);
  expect(list.status).toBe(200);
  const body = (await list.json()) as {
    versions: Array<{ agent_version: { urn: string; properties: Record<string, unknown> } }>;
  };
  const found = body.versions.find((v) => v.agent_version.properties['version'] === version);
  expect(found).toBeDefined();
  return found as { agent_version: { urn: string; properties: Record<string, unknown> } };
}

describe('agent lifecycle parity', () => {
  it('drives an agent version through draft, validate, publish, promote, certify, revoke, and archive', async () => {
    const { app, token } = await buildTestApp();

    // Seed a skill the agent can depend on.
    const skillDraft = await app.request('/v1/skills/skill:agent-dep/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# dep skill', original_path: 'skills/agent-dep.md' },
      }),
    });
    expect(skillDraft.status).toBe(200);

    // Initial agent registration auto-publishes v1 (legacy behavior preserved).
    const createAgent = await app.request('/v1/agents', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        agent_key: 'agent:lifecycle',
        display_name: 'Lifecycle agent',
        source_path: 'agents/lifecycle.md',
        artifact: { content: '# agent v1', original_path: 'agents/lifecycle.md' },
        skill_refs: [{ skill_key: 'skill:agent-dep' }],
      }),
    });
    expect(createAgent.status).toBe(201);

    // New draft v2 with dependency validation on linked skills.
    const draft = await app.request('/v1/agents/agent:lifecycle/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# agent v2', original_path: 'agents/lifecycle.md' },
        skill_refs: [{ skill_key: 'skill:agent-dep' }],
      }),
    });
    expect(draft.status).toBe(200);
    await expect(draft.json()).resolves.toMatchObject({
      result: {
        agent_version: {
          properties: { version: 2, lifecycle_status: 'draft', active: false },
        },
        skills: expect.arrayContaining([expect.objectContaining({ skill_key: 'skill:agent-dep' })]),
      },
    });

    // Idempotent draft re-create is a noop.
    const sameDraft = await app.request('/v1/agents/agent:lifecycle/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# agent v2', original_path: 'agents/lifecycle.md' },
        skill_refs: [{ skill_key: 'skill:agent-dep' }],
      }),
    });
    expect(sameDraft.status).toBe(200);
    await expect(sameDraft.json()).resolves.toMatchObject({
      task: { task: { properties: { status: 'noop' } } },
    });

    expect((await versionAction(app, token, 'agent:lifecycle', 2, 'validate')).status).toBe(200);
    const publish = await versionAction(app, token, 'agent:lifecycle', 2, 'publish');
    expect(publish.status).toBe(200);
    await expect(publish.json()).resolves.toMatchObject({
      result: { agent_version: { properties: { lifecycle_status: 'published' } } },
    });

    // v1 is still active until v2 is promoted; promotion supersedes it.
    const promote = await versionAction(app, token, 'agent:lifecycle', 2, 'promote');
    expect(promote.status).toBe(200);
    const v1 = await getVersion(app, 'agent:lifecycle', 1);
    expect(v1.agent_version.properties['publication_status']).toBe('superseded');
    expect(v1.agent_version.properties['superseded_by_version_urn']).toBe(
      'urn:sg:agent-version:agent:lifecycle@v2',
    );

    const active = await app.request('/v1/agents/agent:lifecycle/active');
    expect(active.status).toBe(200);
    await expect(active.json()).resolves.toMatchObject({
      agent_version: { properties: { version: 2, active: true } },
    });

    // Certification binds policy and ontology versions; the ontology
    // package must be registered first.
    const ontologyPackage = await app.request('/v1/ontology-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        ontology_version: 'agent-ontology/v2',
        author: 'pablo',
        ontology: { kind: 'skill_area', concepts: [{ id: 'platform-operations' }], disjoint: [] },
      }),
    });
    expect(ontologyPackage.status).toBe(201);
    const certify = await versionAction(app, token, 'agent:lifecycle', 2, 'certify', {
      author: 'pablo',
      governance: {
        policy_version: 'agent-policy/v3',
        ontology_version: 'agent-ontology/v2',
        approver: 'dana',
        approver_role: 'security-reviewer',
      },
    });
    expect(certify.status).toBe(200);
    await expect(certify.json()).resolves.toMatchObject({
      result: {
        agent_version: {
          properties: {
            lifecycle_status: 'certified',
            certified: true,
            certification_policy_version: 'agent-policy/v3',
            certification_ontology_version: 'agent-ontology/v2',
          },
        },
        governance_artifacts: expect.arrayContaining([
          expect.objectContaining({ role: 'certification_evidence' }),
        ]),
      },
    });

    // Envelope is available for the certified agent version.
    const envelope = await app.request('/v1/agents/agent:lifecycle/versions/2/publication-envelope');
    expect(envelope.status).toBe(200);
    await expect(envelope.json()).resolves.toMatchObject({
      entity_type: 'AGENT_VERSION',
      canonicalization_algorithm: 'jcs-rfc8785',
    });

    // Revoke the certified version, then archive from revoked.
    expect((await versionAction(app, token, 'agent:lifecycle', 2, 'revoke', { author: 'pablo', note: 'compromised' })).status).toBe(200);
    const activeAfterRevoke = await app.request('/v1/agents/agent:lifecycle/active');
    expect(activeAfterRevoke.status).toBe(404);

    expect((await versionAction(app, token, 'agent:lifecycle', 2, 'archive')).status).toBe(200);
    const archived = await getVersion(app, 'agent:lifecycle', 2);
    expect(archived.agent_version.properties['lifecycle_status']).toBe('archived');
  });

  it('rejects agent drafts that reference unknown skills', async () => {
    const { app, token } = await buildTestApp();
    const draft = await app.request('/v1/agents/agent:bad-dep/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# agent', original_path: 'agents/bad-dep.md' },
        skill_refs: [{ skill_key: 'skill:does-not-exist' }],
      }),
    });
    expect(draft.status).toBe(404);
    await expect(draft.json()).resolves.toMatchObject({ error: { code: 'SKILL_NOT_FOUND' } });
  });

  it('rejects agent drafts missing deterministic evidence at validate time', async () => {
    const { app, token } = await buildTestApp();
    const draft = await app.request('/v1/agents/agent:rejectable/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# no source path' },
      }),
    });
    expect(draft.status).toBe(200);

    const validate = await versionAction(app, token, 'agent:rejectable', 1, 'validate');
    expect(validate.status).toBe(200);
    await expect(validate.json()).resolves.toMatchObject({
      result: {
        agent_version: {
          properties: {
            lifecycle_status: 'rejected',
            validation_status: 'failed',
            validation_failures: ['missing_source_path_evidence'],
          },
        },
      },
    });

    const publish = await versionAction(app, token, 'agent:rejectable', 1, 'publish');
    expect(publish.status).toBe(409);
    await expect(publish.json()).resolves.toMatchObject({ error: { code: 'AGENT_VERSION_PUBLISH_CONFLICT' } });
  });
});
