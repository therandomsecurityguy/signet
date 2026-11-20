import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import {
  owlConceptLocalName,
  parseOwlOntologyTurtle,
  OwlOntologyError,
} from '../../../registry/application/services/owl-ontology.js';
import {
  buildOntologyTriples,
  canonicalizeOntologyDocument,
} from '../../../registry/application/services/ontology-projection.js';
import { validateCapabilityClaims } from '../../../registry/application/services/ontology-validator.js';

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'OWL Ontology Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

const OWL_AREA = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <urn:example:skill-area:> .

<urn:example:skill-area:ontology> a owl:Ontology ; rdfs:label "Skill area" .

ex:analyze a owl:Class ; rdfs:label "Analyze" .
ex:transform a owl:Class .
ex:report a owl:Class ; rdfs:subClassOf ex:analyze .
ex:analyze owl:disjointWith ex:transform .
ex:transform owl:disjointWith ex:analyze .
`;

const LEGACY_EQUIVALENT = {
  kind: 'skill_area' as const,
  concepts: [
    { id: 'analyze', label: 'Analyze' },
    { id: 'transform' },
    { id: 'report', parents: ['analyze'] },
  ],
  disjoint: [['analyze', 'transform']] as Array<[string, string]>,
};

describe('OWL ontology parsing and projection', () => {
  it('projects the supported subset onto the legacy document shape', () => {
    const projected = parseOwlOntologyTurtle(OWL_AREA);
    expect(projected.concepts).toEqual([
      { id: 'analyze', label: 'Analyze' },
      { id: 'report', parents: ['analyze'] },
      { id: 'transform' },
    ]);
    // Symmetric and deduped: authored both directions, stored once.
    expect(projected.disjoint).toEqual([['analyze', 'transform']]);
  });

  it('derives local names from fragment, path, and urn forms with overrides', () => {
    expect(owlConceptLocalName('http://ex.org/skill#DataAnalysis')).toBe('DataAnalysis');
    expect(owlConceptLocalName('http://ex.org/skill/DataAnalysis')).toBe('DataAnalysis');
    expect(owlConceptLocalName('urn:example:skill-area:summarize-text')).toBe('summarize-text');
    expect(owlConceptLocalName('urn:example:')).toBeNull();

    const projected = parseOwlOntologyTurtle(`@prefix owl: <http://www.w3.org/2002/07/owl#> .
<urn:sg:property:concept-id> a owl:Class .`);
    // Local name fallback would be "concept-id"; explicit override wins.
    const withOverride = parseOwlOntologyTurtle(`@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix ex: <urn:example:> .
ex:weird-irI a owl:Class ; <urn:sg:property:concept-id> "wanted-id" .`);
    expect(withOverride.concepts).toEqual([{ id: 'wanted-id' }]);
    expect(projected.concepts.map((concept) => concept.id)).toEqual(['concept-id']);
  });

  it('rejects ambiguous concept ids without overrides', () => {
    expect(() =>
      parseOwlOntologyTurtle(`@prefix owl: <http://www.w3.org/2002/07/owl#> .
<http://a.example/thing#Widget> a owl:Class .
<http://b.example/other/Widget> a owl:Class .`),
    ).toThrow(/ambiguous/);
  });

  it('rejects everything outside the subset with explicit errors', () => {
    const cases: Array<[string, RegExp]> = [
      [
        `@prefix owl: <http://www.w3.org/2002/07/owl#> .`,
        /at least one owl:Class/,
      ],
      [
        `@prefix owl: <http://www.w3.org/2002/07/owl#> .
[ a owl:Class ] .`,
        /must be named IRIs/,
      ],
      [
        `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
<urn:x> a owl:Class ; skos:prefLabel "X" .`,
        /skos:\* is not supported/,
      ],
      [
        `@prefix owl: <http://www.w3.org/2002/07/owl#> .
<urn:x> a owl:Class . <urn:y> a owl:Class . <urn:x> owl:equivalentClass <urn:y> .`,
        /owl:equivalentClass/,
      ],
      [
        `@prefix owl: <http://www.w3.org/2002/07/owl#> .
<urn:x> a owl:Class ; owl:unionOf ( <urn:a> <urn:b> ) .`,
        /owl:unionOf/,
      ],
      [
        `@prefix owl: <http://www.w3.org/2002/07/owl#> .
<urn:x> a owl:Class . [ a owl:Restriction ] .`,
        /owl:Restriction/,
      ],
      [
        `@prefix owl: <http://www.w3.org/2002/07/owl#> .
[ a owl:AllDisjointClasses ] .`,
        /owl:AllDisjointClasses/,
      ],
      [
        `@prefix owl: <http://www.w3.org/2002/07/owl#> .
<urn:x> a owl:Class ; owl:imports <urn:other> .`,
        /owl:imports/,
      ],
      [
        `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<urn:x> a owl:Class ; rdfs:subClassOf <urn:external> .`,
        /must be an owl:Class declared in this document/,
      ],
      [
        `@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<urn:x> a owl:Class ; rdfs:comment "not allowed" .`,
        /rdf-schema#comment.*is not supported/,
      ],
      [
        `@prefix owl: <http://www.w3.org/2002/07/owl#> .
<urn:x> a owl:Class . <urn:y> owl:disjointWith <urn:x> .`,
        /Statement.*on urn:y is not supported/,
      ],
    ];
    for (const [turtle, pattern] of cases) {
      expect(() => parseOwlOntologyTurtle(turtle), turtle.slice(0, 40)).toThrow(OwlOntologyError);
      expect(() => parseOwlOntologyTurtle(turtle), turtle.slice(0, 40)).toThrow(pattern);
    }
  });

  it('produces a format-independent canonical digest and identical claim outcomes', async () => {
    const projected = parseOwlOntologyTurtle(OWL_AREA);
    const owlDocument = { kind: 'skill_area' as const, concepts: projected.concepts, disjoint: projected.disjoint };

    const owlCanonical = await canonicalizeOntologyDocument(owlDocument);
    const legacyCanonical = await canonicalizeOntologyDocument(LEGACY_EQUIVALENT);
    expect(owlCanonical.sha256).toBe(legacyCanonical.sha256);

    const again = await canonicalizeOntologyDocument(owlDocument);
    expect(again.sha256).toBe(owlCanonical.sha256);

    const triples = buildOntologyTriples(owlDocument);
    const serialized = JSON.stringify(triples);
    expect(serialized).toContain('http://www.w3.org/2002/07/owl#Ontology');
    expect(serialized).toContain('http://www.w3.org/2000/01/rdf-schema#subClassOf');
    expect(serialized).toContain('http://www.w3.org/2002/07/owl#disjointWith');
    expect(serialized).toContain('urn:sg:property:kind');

    const claims = ['analyze', 'mystery'];
    const legacyResult = validateCapabilityClaims({
      focus_urn: 'urn:x',
      claims,
      document: LEGACY_EQUIVALENT,
      ontology_version: 'parity/v1',
    });
    const owlResult = validateCapabilityClaims({
      focus_urn: 'urn:x',
      claims,
      document: owlDocument,
      ontology_version: 'parity/v1',
    });
    expect(owlResult).toEqual(legacyResult);
  });
});

describe('OWL ontology packages end to end', () => {
  it('registers, validates claims, rejects unmapped and disjoint sets, and binds certification', async () => {
    const { app, token } = await buildTestApp();

    const create = await app.request('/v1/ontology-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        ontology_version: 'owl-area/v1',
        author: 'pablo',
        ontology_format: 'owl-turtle',
        ontology_kind: 'skill_area',
        ontology: OWL_AREA,
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      ontology_package: { sha256: string; ontology_format: string; canonical_rdf_sha256: string; canonical_rdf_artifact_urn: string };
      created: boolean;
    };
    expect(created.ontology_package.ontology_format).toBe('owl-turtle');
    expect(created.ontology_package.canonical_rdf_sha256).toMatch(/^[0-9a-f]{64}$/);

    const canonical = await app.request(`/v1/artifacts/${created.ontology_package.canonical_rdf_sha256}`);
    expect(canonical.status).toBe(200);
    const canonicalText = await canonical.text();
    expect(canonicalText).toContain('http://www.w3.org/2002/07/owl#disjointWith');
    expect(canonicalText).toContain('urn:sg:concept:analyze');

    // Unmapped claims are rejected and recorded as de-facto candidates.
    const unmappedDraft = await app.request('/v1/skills/owl-unmapped/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        capability_claims: ['transform', 'mystery'],
        artifact: { content: '# x', original_path: 'skills/owl-unmapped.md' },
        governance: { ontology_version: 'owl-area/v1' },
      }),
    });
    expect(unmappedDraft.status).toBe(200);
    const unmappedValidate = await app.request('/v1/skills/owl-unmapped/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(unmappedValidate.status).toBe(200);
    const unmappedBody = (await unmappedValidate.json()) as {
      result: { skill_version: { properties: { lifecycle_status: string; validation_failures: string[] } } };
    };
    expect(unmappedBody.result.skill_version.properties.lifecycle_status).toBe('rejected');
    expect(
      unmappedBody.result.skill_version.properties.validation_failures.some((failure) =>
        failure.includes('mystery'),
      ),
    ).toBe(true);

    const deFacto = await app.request('/v1/de-facto-terms');
    expect(deFacto.status).toBe(200);
    const deFactoBody = (await deFacto.json()) as { terms: Array<{ term: string; status: string }> };
    expect(deFactoBody.terms.some((term) => term.term === 'mystery' && term.status === 'candidate')).toBe(true);

    // Disjoint combinations fail even when every claim binds.
    const disjointDraft = await app.request('/v1/skills/owl-disjoint/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        capability_claims: ['analyze', 'transform'],
        artifact: { content: '# x', original_path: 'skills/owl-disjoint.md' },
        governance: { ontology_version: 'owl-area/v1' },
      }),
    });
    expect(disjointDraft.status).toBe(200);
    const disjointValidate = await app.request('/v1/skills/owl-disjoint/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    const disjointBody = (await disjointValidate.json()) as {
      result: { skill_version: { properties: { lifecycle_status: string; validation_failures: string[] } } };
    };
    expect(disjointBody.result.skill_version.properties.lifecycle_status).toBe('rejected');
    expect(
      disjointBody.result.skill_version.properties.validation_failures.some((failure) =>
        failure.includes('disjoint'),
      ),
    ).toBe(true);

    // Conforming claims validate (same side of the disjoint hierarchy:
    // report is-a analyze), and the report layer records the OWL
    // format plus the artifact and canonical digests.
    const goodDraft = await app.request('/v1/skills/owl-conforming/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        capability_claims: ['report', 'analyze'],
        artifact: { content: '# ok', original_path: 'skills/owl-conforming.md' },
        governance: { ontology_version: 'owl-area/v1' },
      }),
    });
    expect(goodDraft.status).toBe(200);
    const goodValidate = await app.request('/v1/skills/owl-conforming/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(goodValidate.status).toBe(200);
    await expect(goodValidate.json()).resolves.toMatchObject({
      result: { skill_version: { properties: { lifecycle_status: 'validated' } } },
    });

    const version = await app.request('/v1/skills/owl-conforming/versions/1');
    const versionBody = (await version.json()) as {
      governance_artifacts: Array<{ role: string; sha256?: string }>;
    };
    let ontologyLayer: Record<string, unknown> | undefined;
    for (const ref of versionBody.governance_artifacts.filter((a) => a.role === 'validation_report' && a.sha256)) {
      const payload = (await (await app.request(`/v1/artifacts/${ref.sha256}`)).json()) as {
        payload?: { validator?: string; layers?: Array<Record<string, unknown>> };
      };
      if (payload.payload?.validator !== 'shacl-v1') continue;
      ontologyLayer = payload.payload.layers?.find((layer) => layer['layer'] === 'ontology');
      break;
    }
    expect(ontologyLayer).toMatchObject({
      ontology_version: 'owl-area/v1',
      ontology_package_resolved: true,
      ontology_format: 'owl-turtle',
      ontology_sha256: created.ontology_package.sha256,
      ontology_canonical_rdf_sha256: created.ontology_package.canonical_rdf_sha256,
    });

    // Certification binds to the OWL ontology package.
    for (const action of ['publish', 'certify']) {
      const step = await app.request(`/v1/skills/owl-conforming/versions/1/${action}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ author: 'pablo', governance: { ontology_version: 'owl-area/v1' } }),
      });
      expect(step.status).toBe(200);
    }

    // Promotion from authored OWL ontologies lands a NEW authored-OWL
    // version: existing class IRIs are preserved and the promoted term
    // becomes normative in the target version.
    const promote = await app.request('/v1/de-facto-terms/mystery/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        action: 'promote',
        author: 'pablo',
        source_ontology_version: 'owl-area/v1',
        target_ontology_version: 'owl-area/v2',
      }),
    });
    expect(promote.status).toBe(200);
    await expect(promote.json()).resolves.toMatchObject({
      term: 'mystery',
      status: 'promoted',
      promoted_into_ontology_version: 'owl-area/v2',
    });

    const promotedPackage = await app.request(`/v1/ontology-packages/${encodeURIComponent('owl-area/v2')}`);
    expect(promotedPackage.status).toBe(200);
    const promotedPackageBody = (await promotedPackage.json()) as {
      ontology_format: string;
      canonical_rdf_sha256: string;
      ontology: unknown;
    };
    expect(promotedPackageBody.ontology_format).toBe('owl-turtle');
    expect(promotedPackageBody.canonical_rdf_sha256).toBeTruthy();

    // A claim that was unmapped against v1 binds against the promoted v2.
    const promotedDraft = await app.request('/v1/skills/owl-promoted/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        capability_claims: ['mystery', 'transform'],
        artifact: { content: '# ok', original_path: 'skills/owl-promoted.md' },
        governance: { ontology_version: 'owl-area/v2' },
      }),
    });
    expect(promotedDraft.status).toBe(200);
    const promotedValidate = await app.request('/v1/skills/owl-promoted/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    await expect(promotedValidate.json()).resolves.toMatchObject({
      result: { skill_version: { properties: { lifecycle_status: 'validated' } } },
    });
  });

  it('rejects invalid OWL payloads with clear errors', async () => {
    const { app, token } = await buildTestApp();

    const invalid = await app.request('/v1/ontology-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        ontology_version: 'owl-bad/v1',
        author: 'pablo',
        ontology_format: 'owl-turtle',
        ontology_kind: 'skill_area',
        ontology: 'not turtle',
      }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: 'ONTOLOGY_PACKAGE_INVALID' } });

    const missingKind = await app.request('/v1/ontology-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        ontology_version: 'owl-bad-kind/v1',
        author: 'pablo',
        ontology_format: 'owl-turtle',
        ontology: OWL_AREA,
      }),
    });
    expect(missingKind.status).toBe(400);
    await expect(missingKind.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const misplacedKind = await app.request('/v1/ontology-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        ontology_version: 'owl-bad-legacy/v1',
        author: 'pablo',
        ontology_kind: 'skill_area',
        ontology: { kind: 'skill_area', concepts: [{ id: 'a' }], disjoint: [] },
      }),
    });
    expect(misplacedKind.status).toBe(400);
    await expect(misplacedKind.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});
