import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { parseOwlOntologyTurtle } from '../../../registry/application/services/owl-ontology.js';
import { canonicalizeOntologyDocument } from '../../../registry/application/services/ontology-projection.js';

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Compile Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

const SKILL_AREA = {
  kind: 'skill_area',
  concepts: [{ id: 'data-processing' }, { id: 'reporting', parents: ['data-processing'] }],
  disjoint: [],
};

const MARKDOWN = `---
name: skill:compiled
display_name: Compiled Skill
capabilities:
  - data-processing
  - teleportation
---

# Compiled Skill

A compiled skill.
`;

async function registerOntology(app: { request: (i: string, init?: RequestInit) => Promise<Response> | Response }, token: string) {
  const res = await app.request('/v1/ontology-packages', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ ontology_version: 'skill-area/v1', author: 'pablo', ontology: SKILL_AREA }),
  });
  expect(res.status).toBe(201);
}

describe('semantic compiler ingestion', () => {
  it('compiles markdown and maps claims against the skill-area ontology', async () => {
    const { app, token } = await buildTestApp();
    await registerOntology(app, token);

    const compile = await app.request('/v1/compile/skill', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        source_type: 'markdown',
        content: MARKDOWN,
        author: 'pablo',
        ontology_version: 'skill-area/v1',
      }),
    });
    expect(compile.status).toBe(200);
    await expect(compile.json()).resolves.toMatchObject({
      compiled: {
        skill_key: 'skill:compiled',
        display_name: 'Compiled Skill',
        capability_claims: ['data-processing', 'teleportation'],
      },
      ontology_mapping: {
        ontology_version: 'skill-area/v1',
        ontology_package_resolved: true,
        mapped: ['data-processing'],
        unmapped: ['teleportation'],
      },
    });
  });

  it('compiles tool manifests', async () => {
    const { app, token } = await buildTestApp();
    const compile = await app.request('/v1/compile/skill', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        source_type: 'tool_manifest',
        content: JSON.stringify({ name: 'skill:manifest', capabilities: ['reporting'], tools: [{ name: 'Data Processing' }] }),
        author: 'pablo',
      }),
    });
    expect(compile.status).toBe(200);
    await expect(compile.json()).resolves.toMatchObject({
      compiled: { skill_key: 'skill:manifest', capability_claims: ['reporting', 'data-processing'] },
      ontology_mapping: { ontology_package_resolved: false },
    });
  });

  it('creates drafts from compiled source and records de facto candidates at validation', async () => {
    const { app, token } = await buildTestApp();
    await registerOntology(app, token);

    const compile = await app.request('/v1/compile/skill', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        source_type: 'markdown',
        content: MARKDOWN,
        author: 'pablo',
        ontology_version: 'skill-area/v1',
        create_draft: true,
      }),
    });
    expect(compile.status).toBe(200);
    const body = (await compile.json()) as {
      draft?: { result: { skill_version: { properties: Record<string, unknown> } } };
    };
    expect(body.draft?.result.skill_version.properties['capability_claims']).toEqual([
      'data-processing',
      'teleportation',
    ]);
    expect(body.draft?.result.skill_version.properties['ontology_version']).toBe('skill-area/v1');

    // Validation rejects the unmapped claim and records it as a de facto term.
    const validate = await app.request('/v1/skills/skill:compiled/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(validate.status).toBe(200);
    await expect(validate.json()).resolves.toMatchObject({
      result: { skill_version: { properties: { lifecycle_status: 'rejected' } } },
    });

    const terms = await app.request('/v1/de-facto-terms?status=candidate');
    expect(terms.status).toBe(200);
    const termsBody = (await terms.json()) as {
      terms: Array<{ term: string; seen_count: number; example_publication_urns: string[] }>;
    };
    const teleportation = termsBody.terms.find((t) => t.term === 'teleportation');
    expect(teleportation).toBeDefined();
    expect(teleportation?.seen_count).toBeGreaterThanOrEqual(1);
    expect(teleportation?.example_publication_urns).toContain('urn:sg:skill-version:skill:compiled@v1');
  });

  it('reviews de facto terms: reject, promote with normative incorporation, and conflict rules', async () => {
    const { app, token } = await buildTestApp();
    await registerOntology(app, token);

    // Seed two candidates via compile + draft + validate.
    for (const [skillKey, claim] of [
      ['skill:cand-a', 'quantum-sort'],
      ['skill:cand-b', 'teleportation'],
    ] as const) {
      const markdown = `---\nname: ${skillKey}\ncapabilities: [${claim}]\n---\n# X\n`;
      const compile = await app.request('/v1/compile/skill', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          source_type: 'markdown',
          content: markdown,
          author: 'pablo',
          ontology_version: 'skill-area/v1',
          create_draft: true,
        }),
      });
      expect(compile.status).toBe(200);
      const validate = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/validate`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ author: 'pablo' }),
      });
      expect(validate.status).toBe(200);
    }

    // Reject path.
    const reject = await app.request('/v1/de-facto-terms/quantum-sort/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ action: 'reject', author: 'dana' }),
    });
    expect(reject.status).toBe(200);
    await expect(reject.json()).resolves.toMatchObject({
      term: 'quantum-sort',
      status: 'rejected',
      reviewed_by: 'dana',
    });

    // Re-reviewing is a conflict.
    const rereview = await app.request('/v1/de-facto-terms/quantum-sort/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ action: 'reject', author: 'dana' }),
    });
    expect(rereview.status).toBe(409);

    // Promotion requires source and target ontology versions.
    const missingVersions = await app.request('/v1/de-facto-terms/teleportation/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ action: 'promote', author: 'dana' }),
    });
    expect(missingVersions.status).toBe(400);

    // Promotion appends the concept to a NEW ontology package version.
    const promote = await app.request('/v1/de-facto-terms/teleportation/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        action: 'promote',
        author: 'dana',
        source_ontology_version: 'skill-area/v1',
        target_ontology_version: 'skill-area/v2',
      }),
    });
    expect(promote.status).toBe(200);
    await expect(promote.json()).resolves.toMatchObject({
      term: 'teleportation',
      status: 'promoted',
      reviewed_by: 'dana',
      promoted_into_ontology_version: 'skill-area/v2',
    });

    // The new package version contains the promoted concept; the source is unchanged.
    const v2 = await app.request('/v1/ontology-packages/skill-area%2Fv2');
    expect(v2.status).toBe(200);
    const v2Body = (await v2.json()) as { ontology: { concepts: Array<{ id: string }> } };
    expect(v2Body.ontology.concepts.map((c) => c.id)).toContain('teleportation');
    const v1 = await app.request('/v1/ontology-packages/skill-area%2Fv1');
    const v1Body = (await v1.json()) as { ontology: { concepts: Array<{ id: string }> } };
    expect(v1Body.ontology.concepts.map((c) => c.id)).not.toContain('teleportation');

    // Status filters work.
    const promoted = await app.request('/v1/de-facto-terms?status=promoted');
    const promotedBody = (await promoted.json()) as { terms: Array<{ term: string }> };
    expect(promotedBody.terms.map((t) => t.term)).toEqual(['teleportation']);
  });

  it('promotes a legacy JSON candidate into a NEW authored-OWL version (one-way conversion)', async () => {
    const { app, token } = await buildTestApp();
    await registerOntology(app, token);

    // Seed a candidate against the legacy ontology.
    const compile = await app.request('/v1/compile/skill', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        source_type: 'markdown',
        content: '---\nname: skill:owl-bound\ncapabilities: [teleportation]\n---\n# X\n',
        author: 'pablo',
        ontology_version: 'skill-area/v1',
        create_draft: true,
      }),
    });
    expect(compile.status).toBe(200);
    const validate = await app.request('/v1/skills/skill%3Aowl-bound/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(validate.status).toBe(200);

    const promote = await app.request('/v1/de-facto-terms/teleportation/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        action: 'promote',
        author: 'dana',
        source_ontology_version: 'skill-area/v1',
        target_ontology_version: 'skill-area-owl/v1',
        target_ontology_format: 'owl-turtle',
      }),
    });
    expect(promote.status).toBe(200);
    await expect(promote.json()).resolves.toMatchObject({
      term: 'teleportation',
      status: 'promoted',
      promoted_into_ontology_version: 'skill-area-owl/v1',
    });

    // The converted package is authored OWL with the SAME semantics as the
    // legacy document plus the promoted term (format-independent digest).
    const target = await app.request('/v1/ontology-packages/skill-area-owl%2Fv1');
    expect(target.status).toBe(200);
    const targetBody = (await target.json()) as {
      ontology_format: string;
      ontology: string;
      canonical_rdf_sha256: string;
    };
    expect(targetBody.ontology_format).toBe('owl-turtle');
    const projected = parseOwlOntologyTurtle(targetBody.ontology);
    expect(projected.concepts.map((concept) => concept.id).sort()).toEqual([
      'data-processing',
      'reporting',
      'teleportation',
    ]);
    expect(projected.concepts.find((concept) => concept.id === 'reporting')?.parents).toEqual(['data-processing']);
    const expectedDigest = await canonicalizeOntologyDocument({
      kind: 'skill_area',
      concepts: [...SKILL_AREA.concepts, { id: 'teleportation' }],
      disjoint: [],
    });
    expect(targetBody.canonical_rdf_sha256).toBe(expectedDigest.sha256);

    // The promoted term binds against the converted ontology.
    const draft = await app.request('/v1/skills/skill%3Aowl-bound-2/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        capability_claims: ['teleportation'],
        artifact: { content: '# x', original_path: 'skills/owl-bound-2.md' },
        governance: { ontology_version: 'skill-area-owl/v1' },
      }),
    });
    expect(draft.status).toBe(200);
    const validate2 = await app.request('/v1/skills/skill%3Aowl-bound-2/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    await expect(validate2.json()).resolves.toMatchObject({
      result: { skill_version: { properties: { lifecycle_status: 'validated' } } },
    });
  });

  it('analyzes the corpus for de facto vocabulary demand', async () => {
    const { app, token } = await buildTestApp();
    await registerOntology(app, token);

    const draft = async (skillKey: string, claims: string[], governance?: Record<string, unknown>) =>
      await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          author: 'pablo',
          capability_claims: claims,
          artifact: { content: '# x', original_path: `skills/${skillKey}.md` },
          ...(governance ? { governance } : {}),
        }),
      });

    expect((await draft('skill:analysis-a', ['data-processing', 'teleportation'], { ontology_version: 'skill-area/v1' })).status).toBe(200);
    expect((await draft('skill:analysis-b', ['reporting', 'holodeck'], { ontology_version: 'skill-area/v1' })).status).toBe(200);
    // No resolvable ontology: contributes to totals but cannot be classified.
    expect((await draft('skill:analysis-c', ['teleportation'])).status).toBe(200);

    const analysis = await app.request('/v1/de-facto-terms/analysis');
    expect(analysis.status).toBe(200);
    const body = (await analysis.json()) as {
      totals: Record<string, number>;
      candidates: Array<{
        term: string;
        occurrences: number;
        bound_in: string[];
        unbound_in: string[];
        example_version_urns: string[];
      }>;
      ontology_versions: Array<Record<string, unknown>>;
    };
    expect(body.totals).toMatchObject({
      versions_analyzed: 3,
      versions_with_claims: 3,
      versions_without_ontology: 1,
      claims_total: 5,
      distinct_claims: 4,
      bound_claims: 2,
      unbound_claims: 2,
    });
    // Ordering: occurrences desc, then term ascending.
    expect(body.candidates.map((candidate) => candidate.term)).toEqual([
      'teleportation',
      'data-processing',
      'holodeck',
      'reporting',
    ]);
    const teleportation = body.candidates[0] as (typeof body.candidates)[number];
    expect(teleportation.occurrences).toBe(2);
    expect(teleportation.bound_in).toEqual([]);
    expect(teleportation.unbound_in).toEqual(['skill-area/v1']);
    expect(teleportation.example_version_urns).toHaveLength(2);
    expect(body.ontology_versions).toEqual([
      {
        ontology_version: 'skill-area/v1',
        versions_analyzed: 2,
        claims_total: 4,
        distinct_claims: 4,
        unbound_claims: 2,
        unbound_terms: ['holodeck', 'teleportation'],
      },
    ]);

    // Filtering by ontology version restricts the analyzed set.
    const filtered = await app.request('/v1/de-facto-terms/analysis?ontology_version=skill-area%2Fv1');
    const filteredBody = (await filtered.json()) as typeof body;
    expect(filteredBody.totals).toMatchObject({
      versions_analyzed: 2,
      versions_without_ontology: 0,
      claims_total: 4,
      unbound_claims: 2,
    });
    expect((filteredBody.candidates[0] as (typeof body.candidates)[number]).occurrences).toBe(1);

    const unknown = await app.request('/v1/de-facto-terms/analysis?ontology_version=nope%2Fv1');
    const unknownBody = (await unknown.json()) as typeof body;
    expect(unknownBody.totals).toMatchObject({ versions_analyzed: 0, claims_total: 0 });
    expect(unknownBody.candidates).toEqual([]);
    expect(unknownBody.ontology_versions).toEqual([]);
  });

  it('refuses promoting an authored OWL source into a legacy JSON target', async () => {
    const { app, token } = await buildTestApp();
    const owlSource = await app.request('/v1/ontology-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        ontology_version: 'owl-only/v1',
        author: 'pablo',
        ontology_format: 'owl-turtle',
        ontology_kind: 'skill_area',
        ontology: `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<urn:sg:ontology> a owl:Ontology .
<urn:example:omega> a owl:Class .
`,
      }),
    });
    expect(owlSource.status).toBe(201);

    const draft = await app.request('/v1/skills/skill%3Aowl-refuse/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        capability_claims: ['mystery'],
        artifact: { content: '# x', original_path: 'skills/owl-refuse.md' },
        governance: { ontology_version: 'owl-only/v1' },
      }),
    });
    expect(draft.status).toBe(200);
    const validate = await app.request('/v1/skills/skill%3Aowl-refuse/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(validate.status).toBe(200);

    const promote = await app.request('/v1/de-facto-terms/mystery/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        action: 'promote',
        author: 'dana',
        source_ontology_version: 'owl-only/v1',
        target_ontology_version: 'owl-only-legacy/v1',
        target_ontology_format: 'legacy-json-v1',
      }),
    });
    expect(promote.status).toBe(400);
    await expect(promote.json()).resolves.toMatchObject({
      error: { code: 'DEFACTO_TERM_PROMOTE_INVALID' },
    });
  });
});
