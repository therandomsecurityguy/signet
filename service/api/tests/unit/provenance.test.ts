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
  const { token } = await deps.apiKeys.create({ owner_label: 'Provenance Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type ProvenanceBody = {
  entity: { urn: string; entity_type: string };
  derivation_chain: Array<{
    version_urn: string;
    was_derived_from: string[];
    activities: Array<{
      task_urn: string;
      operation: string;
      status: string;
      occurred_at?: string;
      actor?: string;
      used: Array<{ urn: string; entity_type?: string }>;
      associated_agents: Array<{ urn: string; agent_name?: string; role?: string }>;
    }>;
  }>;
  replay: Array<{ occurred_at?: string; operation: string; actor?: string; version_urn: string; status: string }>;
  evidence: { canonical_rdf_sha256: string; canonical_rdf_artifact_urn: string };
};

describe('PROV-O provenance tracking', () => {
  it('tracks derivation, activities, used entities, and associated agents across the lifecycle', async () => {
    const { app, token } = await buildTestApp();

    // Register policy + ontology packages so certify can bind them.
    const policyPackage = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'prov-policy/v1',
        author: 'pablo',
        shapes: { shapes: [{ id: 'policy/base', target: { entity_type: 'SKILL_VERSION' } }] },
      }),
    });
    expect(policyPackage.status).toBe(201);
    const { policy_package: policyPkg } = (await policyPackage.json()) as { policy_package: { artifact_urn: string } };

    const ontologyPackage = await app.request('/v1/ontology-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        ontology_version: 'prov-ontology/v1',
        author: 'pablo',
        ontology: { kind: 'skill_area', concepts: [{ id: 'data-processing' }], disjoint: [] },
      }),
    });
    expect(ontologyPackage.status).toBe(201);
    const { ontology_package: ontologyPkg } = (await ontologyPackage.json()) as {
      ontology_package: { artifact_urn: string };
    };

    // v1: draft + publish.
    const draftOne = await app.request('/v1/skills/skill:prov/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# v1', original_path: 'skills/prov.md' },
        governance: { policy_version: 'prov-policy/v1', ontology_version: 'prov-ontology/v1' },
      }),
    });
    expect(draftOne.status).toBe(200);
    expect(
      (
        await app.request('/v1/skills/skill:prov/versions/1/publish', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ author: 'pablo' }),
        })
      ).status,
    ).toBe(200);

    // v2: draft (derives from v1) + validate + publish + certify with approver.
    const draftTwo = await app.request('/v1/skills/skill:prov/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# v2', original_path: 'skills/prov.md' },
        capability_claims: ['data-processing'],
        governance: { policy_version: 'prov-policy/v1', ontology_version: 'prov-ontology/v1' },
      }),
    });
    expect(draftTwo.status).toBe(200);
    for (const action of ['validate', 'publish']) {
      expect(
        (
          await app.request(`/v1/skills/skill:prov/versions/2/${action}`, {
            method: 'POST',
            headers: authHeaders(token),
            body: JSON.stringify({ author: 'pablo' }),
          })
        ).status,
      ).toBe(200);
    }
    const certify = await app.request('/v1/skills/skill:prov/versions/2/certify', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        governance: {
          policy_version: 'prov-policy/v1',
          ontology_version: 'prov-ontology/v1',
          approver: 'dana',
          approver_role: 'security-reviewer',
        },
      }),
    });
    expect(certify.status).toBe(200);

    const provenance = await app.request('/v1/skills/skill:prov/versions/2/provenance');
    expect(provenance.status).toBe(200);
    const body = (await provenance.json()) as ProvenanceBody;

    // Derivation chain: v2 derives from v1.
    expect(body.entity.entity_type).toBe('SKILL_VERSION');
    expect(body.derivation_chain.map((link) => link.version_urn)).toEqual([
      'urn:sg:skill-version:skill:prov@v2',
      'urn:sg:skill-version:skill:prov@v1',
    ]);
    expect(body.derivation_chain[0]?.was_derived_from).toEqual(['urn:sg:skill-version:skill:prov@v1']);
    expect(body.derivation_chain[1]?.was_derived_from).toEqual([]);

    // v2 activities cover the lifecycle operations in order.
    const v2Operations = body.derivation_chain[0]?.activities.map((a) => a.operation);
    expect(v2Operations).toEqual(['create_draft', 'validate', 'publish', 'certify']);

    // The certify activity used the certification evidence, policy package,
    // and ontology package, and was associated with the author and approver.
    const certifyActivity = body.derivation_chain[0]?.activities.find((a) => a.operation === 'certify');
    expect(certifyActivity).toBeDefined();
    expect(certifyActivity?.used.map((u) => u.urn)).toEqual(
      expect.arrayContaining([policyPkg.artifact_urn, ontologyPkg.artifact_urn]),
    );
    expect(certifyActivity?.associated_agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent_name: 'pablo', role: 'author' }),
        expect.objectContaining({ agent_name: 'dana', role: 'security-reviewer' }),
      ]),
    );

    // The validate activity used the policy + ontology packages and a report.
    const validateActivity = body.derivation_chain[0]?.activities.find((a) => a.operation === 'validate');
    expect(validateActivity?.used.map((u) => u.urn)).toEqual(
      expect.arrayContaining([policyPkg.artifact_urn, ontologyPkg.artifact_urn]),
    );

    // v1 has its own publish activity.
    const v1Operations = body.derivation_chain[1]?.activities.map((a) => a.operation);
    expect(v1Operations).toEqual(['create_draft', 'publish']);

    // Replay is a flattened, time-ordered audit trail across the chain.
    expect(body.replay.map((r) => r.operation)).toEqual([
      'create_draft',
      'publish',
      'create_draft',
      'validate',
      'publish',
      'certify',
    ]);
    for (const entry of body.replay) {
      expect(entry.actor).toBe('pablo');
      expect(entry.occurred_at).toBeDefined();
    }

    // Canonical provenance export: the response carries the RDFC-1.0 digest
    // and the artifact urn; the artifact bytes hash to that digest.
    expect(body.evidence.canonical_rdf_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.evidence.canonical_rdf_artifact_urn).toBe(`urn:sg:artifact:sha256:${body.evidence.canonical_rdf_sha256}`);
    const canonicalBytes = await app.request(`/v1/artifacts/${body.evidence.canonical_rdf_sha256}`);
    expect(canonicalBytes.status).toBe(200);
    const canonicalText = await canonicalBytes.text();
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(Buffer.from(canonicalText, 'utf8')).digest('hex')).toBe(
      body.evidence.canonical_rdf_sha256,
    );
    expect(canonicalText).toContain('http://www.w3.org/ns/prov#wasGeneratedBy');

    // The export is stable across reads (same digest, same artifact).
    const second = await app.request('/v1/skills/skill:prov/versions/2/provenance');
    const secondBody = (await second.json()) as ProvenanceBody;
    expect(secondBody.evidence.canonical_rdf_sha256).toBe(body.evidence.canonical_rdf_sha256);

    // JSON-LD export: PROV-O document derived from the same triple list.
    const jsonld = await app.request('/v1/skills/skill:prov/versions/2/provenance?format=jsonld');
    expect(jsonld.status).toBe(200);
    const jsonldBody = (await jsonld.json()) as {
      '@context': { prov: string; sg: string };
      '@graph': Array<{ '@id': string; '@type'?: string[]; [key: string]: unknown }>;
    };
    expect(jsonldBody['@context'].prov).toBe('http://www.w3.org/ns/prov#');
    expect(jsonldBody['@graph'].length).toBeGreaterThan(0);
    const v2Node = jsonldBody['@graph'].find((node) => node['@id'] === 'urn:sg:skill-version:skill:prov@v2');
    expect(v2Node?.['@type']).toEqual(
      expect.arrayContaining(['http://www.w3.org/ns/prov#Entity', 'urn:sg:entity-type:SKILL_VERSION']),
    );
    expect(v2Node?.['prov:wasGeneratedBy']).toEqual(
      expect.arrayContaining([expect.objectContaining({ '@id': expect.stringContaining('urn:sg:task:') })]),
    );
  });

  it('serves agent version provenance and 404s for unknown versions', async () => {
    const { app, token } = await buildTestApp();

    const createAgent = await app.request('/v1/agents', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        agent_key: 'agent:prov',
        source_path: 'agents/prov.md',
        artifact: { content: '# agent v1', original_path: 'agents/prov.md' },
      }),
    });
    expect(createAgent.status).toBe(201);

    const provenance = await app.request('/v1/agents/agent:prov/versions/1/provenance');
    expect(provenance.status).toBe(200);
    const body = (await provenance.json()) as ProvenanceBody;
    expect(body.entity.entity_type).toBe('AGENT_VERSION');
    expect(body.derivation_chain).toHaveLength(1);
    expect(body.evidence.canonical_rdf_sha256).toMatch(/^[0-9a-f]{64}$/);

    const jsonld = await app.request('/v1/agents/agent:prov/versions/1/provenance?format=jsonld');
    expect(jsonld.status).toBe(200);
    const jsonldBody = (await jsonld.json()) as { '@graph': Array<{ '@id': string }> };
    expect(jsonldBody['@graph'].some((node) => node['@id'] === 'urn:sg:agent-version:agent:prov@v1')).toBe(true);

    const missing = await app.request('/v1/agents/agent:prov/versions/99/provenance');
    expect(missing.status).toBe(404);
  });
});
