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
  const { token } = await deps.apiKeys.create({ owner_label: 'Ontology-Aware Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

const OWL_AREA = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<urn:sg:ontology> a owl:Ontology .

<urn:example:analysis> a owl:Class .
<urn:example:transform> a owl:Class ; rdfs:subClassOf <urn:example:analysis> .
<urn:example:report> a owl:Class .
`;

const ONTOLOGY_AWARE_POLICY = `@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:policy:ontology-aware> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:property [
        sh:path <urn:sg:property:capability_claim_concepts> ;
        sh:class <urn:sg:concept:analysis> ;
        sh:message "claims must be within the analysis family" ;
    ] .
`;

async function registerOntologyAndPolicy(app: ReturnType<typeof buildApp>, token: string) {
  const ontology = await app.request('/v1/ontology-packages', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      ontology_version: 'ona-area/v1',
      author: 'pablo',
      ontology_format: 'owl-turtle',
      ontology_kind: 'skill_area',
      ontology: OWL_AREA,
    }),
  });
  expect(ontology.status).toBe(201);
  const policy = await app.request('/v1/policy-packages', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      policy_version: 'ontology-aware/v1',
      author: 'pablo',
      shapes_format: 'shacl-turtle',
      shapes: ONTOLOGY_AWARE_POLICY,
    }),
  });
  expect(policy.status).toBe(201);
}

async function draftAndValidate(
  app: ReturnType<typeof buildApp>,
  token: string,
  skillKey: string,
  claims: string[],
) {
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'pablo',
      description: 'ontology-aware demo',
      capability_claims: claims,
      artifact: { content: '# x', original_path: `skills/${skillKey}.md` },
      governance: { ontology_version: 'ona-area/v1', policy_version: 'ontology-aware/v1' },
    }),
  });
  expect(draft.status).toBe(200);
  return await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/validate`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ author: 'pablo' }),
  });
}

type ValidateBody = {
  result: { skill_version: { properties: { lifecycle_status: string; validation_failures?: string[] } } };
};

describe('ontology-aware SHACL policies', () => {
  it('accepts claims on subclasses of a required concept via the exposed taxonomy', async () => {
    const { app, token } = await buildTestApp();
    await registerOntologyAndPolicy(app, token);

    const validate = await draftAndValidate(app, token, 'ona-subclass', ['transform']);
    expect(validate.status).toBe(200);
    const body = (await validate.json()) as ValidateBody;
    expect(body.result.skill_version.properties.lifecycle_status).toBe('validated');
  });

  it('rejects claims outside the required concept family', async () => {
    const { app, token } = await buildTestApp();
    await registerOntologyAndPolicy(app, token);

    const validate = await draftAndValidate(app, token, 'ona-outside', ['report']);
    expect(validate.status).toBe(200);
    const body = (await validate.json()) as ValidateBody;
    expect(body.result.skill_version.properties.lifecycle_status).toBe('rejected');
    expect(body.result.skill_version.properties.validation_failures).toContain(
      'claims must be within the analysis family',
    );
  });

  it('binds every claim before the family check (unbound claims fail on binding first)', async () => {
    const { app, token } = await buildTestApp();
    await registerOntologyAndPolicy(app, token);

    const validate = await draftAndValidate(app, token, 'ona-unbound', ['mystery']);
    const body = (await validate.json()) as ValidateBody;
    expect(body.result.skill_version.properties.lifecycle_status).toBe('rejected');
    const failures = body.result.skill_version.properties.validation_failures ?? [];
    expect(failures.some((failure) => failure.includes('mystery'))).toBe(true);
  });
});
