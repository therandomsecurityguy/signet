import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import {
  agentUrn,
  artifactUrn,
  harnessUrn,
  skillUrn,
  skillVersionUrn,
} from '../../../../service/registry/domain/together/db/graph/freeform/registry/urn.js';

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  return { app: buildApp(deps), deps };
}

describe('graph routes', () => {
  it('returns a rooted subgraph for the demo-style entity chain', async () => {
    const { app, deps } = await buildTestApp();
    const agent = agentUrn('cursor:graph-demo');
    const skill = skillUrn('skill:graph-demo');
    const version = skillVersionUrn('skill:graph-demo', 1);
    const harness = harnessUrn('cursor');
    const artifact = artifactUrn('abc123');

    await deps.graph.upsertNode({
      urn: agent,
      entity_type: 'AGENT',
      properties: {
        agent_key: 'cursor:graph-demo',
        harness_name: 'cursor',
        display_name: 'Graph Demo Agent',
      },
    });
    await deps.graph.upsertNode({
      urn: skill,
      entity_type: 'SKILL',
      properties: {
        skill_key: 'skill:graph-demo',
        display_name: 'Graph Demo Skill',
        active_version_urn: version,
      },
    });
    await deps.graph.upsertNode({
      urn: version,
      entity_type: 'SKILL_VERSION',
      properties: {
        skill_key: 'skill:graph-demo',
        version: 1,
        lifecycle_status: 'published',
        active: true,
      },
    });
    await deps.graph.upsertNode({
      urn: harness,
      entity_type: 'HARNESS',
      properties: { harness_name: 'cursor' },
    });
    await deps.graph.upsertNode({
      urn: artifact,
      entity_type: 'ARTIFACT',
      properties: { sha256: 'abc123', size_bytes: 10 },
    });
    await deps.graph.upsertEdge({
      from_urn: agent,
      to_urn: harness,
      predicate: 'sg:runsOn',
      properties: {},
    });
    await deps.graph.upsertEdge({
      from_urn: agent,
      to_urn: skill,
      predicate: 'sg:usesSkill',
      properties: {},
    });
    await deps.graph.upsertEdge({
      from_urn: skill,
      to_urn: version,
      predicate: 'sg:hasVersion',
      properties: {},
    });
    await deps.graph.upsertEdge({
      from_urn: version,
      to_urn: artifact,
      predicate: 'sg:implementedBy',
      properties: {},
    });

    const res = await app.request(
      `/v1/graph/subgraph?root_urn=${encodeURIComponent(agent)}&depth=3`,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      root_urn: agent,
      depth: 3,
      nodes: expect.arrayContaining([
        expect.objectContaining({ urn: agent, entity_type: 'AGENT', label: 'Graph Demo Agent' }),
        expect.objectContaining({ urn: skill, entity_type: 'SKILL', label: 'Graph Demo Skill' }),
        expect.objectContaining({ urn: version, entity_type: 'SKILL_VERSION', label: 'skill:graph-demo@v1' }),
        expect.objectContaining({ urn: artifact, entity_type: 'ARTIFACT', label: 'artifact:abc123' }),
      ]),
      edges: expect.arrayContaining([
        expect.objectContaining({ from_urn: agent, to_urn: skill, predicate: 'sg:usesSkill' }),
        expect.objectContaining({ from_urn: skill, to_urn: version, predicate: 'sg:hasVersion' }),
        expect.objectContaining({ from_urn: version, to_urn: artifact, predicate: 'sg:implementedBy' }),
      ]),
    });
  });
});
