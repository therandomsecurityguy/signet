import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import {
  agentVersionUrn,
  skillVersionUrn,
} from '../../../registry/domain/signet/db/graph/freeform/registry/urn.js';

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Simulate Writer' });
  return { app: buildApp(deps), token, deps };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type TestApp = { request: (i: string, init?: RequestInit) => Promise<Response> | Response };

const DESCRIPTION_TURTLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:policy:sim-description> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:property [
        sh:path <urn:sg:property:description> ;
        sh:minCount 1 ;
        sh:message "description_required" ;
    ] .
`;

async function registerSimPolicy(app: TestApp, token: string, policyVersion: string) {
  const res = await app.request('/v1/policy-packages', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      policy_version: policyVersion,
      author: 'simulate-test',
      shapes_format: 'shacl-turtle',
      shapes: DESCRIPTION_TURTLE,
    }),
  });
  expect(res.status).toBe(201);
}

async function seedSkillDraft(app: TestApp, token: string, skillKey: string, description?: string) {
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
      author: 'simulate-test',
      ...(description ? { description } : {}),
      artifact: { content: `# ${skillKey} v1`, original_path: `skills/${skillKey.replaceAll(':', '-')}.md` },
    }),
  });
  expect(draft.status).toBe(200);
}

describe('policy simulation (dry-run)', () => {
  it('returns standard verdicts with zero lifecycle side effects', async () => {
    const { app, token, deps } = await buildTestApp();
    await registerSimPolicy(app, token, 'policy/sim-description/v1');
    await seedSkillDraft(app, token, 'skill:sim-nodesc');
    await seedSkillDraft(app, token, 'skill:sim-desc', 'A described skill.');
    const createAgent = await app.request('/v1/agents', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        agent_key: 'cursor:sim-agent',
        source_path: 'agents/sim.md',
        artifact: { content: '# agent', original_path: 'agents/sim.md' },
      }),
    });
    expect(createAgent.status).toBe(201);

    const noDescUrn = skillVersionUrn('skill:sim-nodesc', 1);
    const descUrn = skillVersionUrn('skill:sim-desc', 1);
    const agentUrn = agentVersionUrn('cursor:sim-agent', 1);

    // Snapshot every observable that a side effect would change.
    const beforeNode = await deps.graph.getNode(noDescUrn);
    const beforeLog = await deps.registryCore.getGovernanceLogState();
    const beforeTasks = (await deps.graph.listNodesByType('TASK')).length;
    const beforeArtifacts = (await deps.graph.listNodesByType('ARTIFACT')).length;

    const res = await app.request('/v1/policy-packages/policy%2Fsim-description%2Fv1/simulate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ publication_urns: [noDescUrn, descUrn, agentUrn] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      policy_version: string;
      policy_package_sha256: string | null;
      conforms: boolean;
      targets: Array<{
        publication_urn: string;
        found: boolean;
        conforms: boolean;
        failures: string[];
        violations: Array<{ severity: string; message: string }>;
        policy?: { resolved: boolean; shapes_format?: string; engine?: string };
      }>;
    };
    expect(body.policy_version).toBe('policy/sim-description/v1');
    expect(body.policy_package_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.conforms).toBe(false);

    const noDesc = body.targets.find((target) => target.publication_urn === noDescUrn);
    expect(noDesc?.found).toBe(true);
    expect(noDesc?.conforms).toBe(false);
    expect(noDesc?.failures).toContain('description_required');
    expect(noDesc?.violations[0]?.severity).toBe('Violation');
    expect(noDesc?.policy?.resolved).toBe(true);
    expect(noDesc?.policy?.shapes_format).toBe('shacl-turtle');
    expect(noDesc?.policy?.engine).toBeTruthy();

    const desc = body.targets.find((target) => target.publication_urn === descUrn);
    expect(desc?.conforms).toBe(true);
    expect(desc?.failures).toEqual([]);

    // The shape targets SKILL_VERSION: focus-scoped targeting means agent
    // versions are not incidentally validated by it (and therefore conform).
    const agent = body.targets.find((target) => target.publication_urn === agentUrn);
    expect(agent?.found).toBe(true);
    expect(agent?.conforms).toBe(true);
    expect(agent?.violations).toEqual([]);

    // Nothing changed: no node writes, no tasks, no artifacts, no log growth.
    const afterNode = await deps.graph.getNode(noDescUrn);
    expect(afterNode?.properties).toEqual(beforeNode?.properties);
    const afterLog = await deps.registryCore.getGovernanceLogState();
    expect(afterLog.tree_size).toBe(beforeLog.tree_size);
    expect((await deps.graph.listNodesByType('TASK')).length).toBe(beforeTasks);
    expect((await deps.graph.listNodesByType('ARTIFACT')).length).toBe(beforeArtifacts);
  });

  it('reports malformed and missing targets without failing the batch', async () => {
    const { app, token } = await buildTestApp();
    await registerSimPolicy(app, token, 'policy/sim-batch/v1');
    await seedSkillDraft(app, token, 'skill:sim-batch', 'described');

    const res = await app.request('/v1/policy-packages/policy%2Fsim-batch%2Fv1/simulate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        publication_urns: [
          'not-a-urn',
          'urn:sg:skill-version:skill:missing@v1',
          skillVersionUrn('skill:sim-batch', 1),
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      targets: Array<{ found: boolean; failures: string[]; conforms: boolean }>;
    };
    expect(body.targets[0]?.found).toBe(false);
    expect(body.targets[0]?.failures).toEqual(['INVALID_PUBLICATION_URN']);
    expect(body.targets[1]?.found).toBe(false);
    expect(body.targets[1]?.failures).toEqual(['PUBLICATION_NOT_FOUND']);
    expect(body.targets[2]?.conforms).toBe(true);
  });

  it('404s for unknown policy packages and validates input bounds', async () => {
    const { app, token } = await buildTestApp();
    const missing = await app.request('/v1/policy-packages/policy%2Fnope%2Fv1/simulate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ publication_urns: ['urn:sg:skill-version:skill:x@v1'] }),
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('POLICY_PACKAGE_NOT_FOUND');

    await registerSimPolicy(app, token, 'policy/sim-bounds/v1');
    const empty = await app.request('/v1/policy-packages/policy%2Fsim-bounds%2Fv1/simulate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ publication_urns: [] }),
    });
    expect(empty.status).toBe(400);

    const tooMany = await app.request('/v1/policy-packages/policy%2Fsim-bounds%2Fv1/simulate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        publication_urns: Array.from({ length: 26 }, (_v, index) => `urn:sg:skill-version:skill:x${index}@v1`),
      }),
    });
    expect(tooMany.status).toBe(400);
  });
});
