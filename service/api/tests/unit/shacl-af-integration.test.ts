import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { PYSHACL_RUNTIME_ENGINE_ID } from '../../../registry/application/services/pyshacl-runtime-engine.js';
import { parseTurtlePolicyShapes, TurtlePolicyError } from '../../../registry/application/services/shacl-turtle-policy.js';
import { turtleShapesRequireShaclRuntime } from '../../../registry/application/services/shacl-publication-validation.js';
import { readFileSync } from 'node:fs';

const servers: ServerType[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to reserve free port.'));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

type RecordedRequest = { body: Record<string, unknown>; authorization: string | undefined };

async function startFakeRuntime(options?: {
  status?: number;
  body?: unknown;
}): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.post('/v1/validate', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    requests.push({ body, authorization: c.req.header('authorization') });
    if (options?.status && options.status !== 200) {
      return c.json(
        (options.body as object) ?? { error: { code: 'VALIDATION_FAILURE', message: 'runtime boom' } },
        options.status as 200,
      );
    }
    return c.json(
      options?.body ?? {
        conforms: false,
        results: [
          {
            focusNode: 'urn:sg:skill-version:af-gated@v1',
            path: 'urn:sg:property:description',
            sourceConstraintComponent: 'urn:example:TagsComponent',
            severity: 'http://www.w3.org/ns/shacl#Violation',
            message: 'af runtime violation',
            value: 'x',
          },
        ],
      },
    );
  });
  const port = await getFreePort();
  const server = await new Promise<ServerType>((resolve) => {
    const started = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => resolve(started));
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

async function buildTestApp(overrides: NodeJS.ProcessEnv = {}) {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
    ...overrides,
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'SHACL-AF Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

const AF_POLICY_TURTLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <urn:example:> .

ex:onto a <http://www.w3.org/2002/07/owl#Ontology> ;
    sh:declare [ sh:prefix "ex" ; sh:namespace "urn:example:"^^xsd:anyURI ] .

<urn:policy:af> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:rule [
        a sh:SPARQLRule ;
        sh:construct """
            CONSTRUCT { $this <urn:sg:property:review_flag> "needs-review" } WHERE {
                $this <urn:sg:property:description> ?value .
                FILTER(CONTAINS(STR(?value), "TODO"))
            }
        """ ;
        sh:prefixes ex:onto ;
    ] .
`;

const CORE_POLICY_TURTLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:policy:core> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:property [ sh:path <urn:sg:property:description> ; sh:minCount 0 ] .
`;

const SPARQL_POLICY_TURTLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:policy:sparql> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:sparql [
        sh:message "never matches" ;
        sh:select "SELECT $this WHERE { FILTER(false) }" ;
    ] .
`;

async function registerPolicy(app: ReturnType<typeof buildApp>, token: string, version: string, turtle: string) {
  const create = await app.request('/v1/policy-packages', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ policy_version: version, author: 'pablo', shapes_format: 'shacl-turtle', shapes: turtle }),
  });
  expect(create.status).toBe(201);
}

async function draftAndValidate(
  app: ReturnType<typeof buildApp>,
  token: string,
  skillKey: string,
  policyVersion: string,
) {
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'pablo',
      description: 'contains TODO',
      artifact: { content: '# x', original_path: `skills/${skillKey}.md` },
      governance: { policy_version: policyVersion },
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

describe('SHACL-AF policy execution via the runtime sidecar', () => {
  it('routes AF policies to the runtime with prepared shapes and records its verdicts', async () => {
    const runtime = await startFakeRuntime();
    const { app, token } = await buildTestApp({
      SHACL_RUNTIME_URL: runtime.baseUrl,
      SHACL_RUNTIME_TOKEN: 'runtime-token',
    });
    await registerPolicy(app, token, 'af-policy/v1', AF_POLICY_TURTLE);

    const validate = await draftAndValidate(app, token, 'af-gated', 'af-policy/v1');
    expect(validate.status).toBe(200);
    const body = (await validate.json()) as ValidateBody;
    expect(body.result.skill_version.properties.lifecycle_status).toBe('rejected');
    expect(body.result.skill_version.properties.validation_failures).toContain('af runtime violation');

    // The runtime received PREPARED shapes (N-Quads: targeting rewritten,
    // patterns stripped) and the derived validation dataset, with the
    // bearer token.
    expect(runtime.requests).toHaveLength(1);
    const request = runtime.requests[0];
    expect(request?.authorization).toBe('Bearer runtime-token');
    const shapesSent = String(request?.body['shapes_turtle']);
    expect(shapesSent).toContain('http://www.w3.org/ns/shacl#targetNode');
    expect(shapesSent).toContain('http://www.w3.org/ns/shacl#rule');
    expect(shapesSent).not.toContain('http://www.w3.org/ns/shacl#pattern');
    expect(String(request?.body['data_nquads'])).toContain('urn:sg:entity-type:SKILL_VERSION');

    // The report records the runtime engine for the policy layer.
    const version = await app.request('/v1/skills/af-gated/versions/1');
    const versionBody = (await version.json()) as {
      governance_artifacts: Array<{ role: string; sha256?: string }>;
    };
    let engineId: string | undefined;
    for (const ref of versionBody.governance_artifacts.filter((a) => a.role === 'validation_report' && a.sha256)) {
      const payload = (await (await app.request(`/v1/artifacts/${ref.sha256}`)).json()) as {
        payload?: { validator?: string; layers?: Array<{ layer: string; engine?: string }> };
      };
      if (payload.payload?.validator !== 'shacl-v1') continue;
      engineId = payload.payload.layers?.find((layer) => layer.layer === 'policy')?.engine;
      break;
    }
    expect(engineId).toBe(PYSHACL_RUNTIME_ENGINE_ID);
  });

  it('fails closed when the runtime is not configured', async () => {
    const { app, token } = await buildTestApp();
    await registerPolicy(app, token, 'af-policy/v1', AF_POLICY_TURTLE);

    const validate = await draftAndValidate(app, token, 'af-unconfigured', 'af-policy/v1');
    expect(validate.status).toBe(200);
    const body = (await validate.json()) as ValidateBody;
    expect(body.result.skill_version.properties.lifecycle_status).toBe('rejected');
    const failures = body.result.skill_version.properties.validation_failures ?? [];
    expect(failures.some((failure) => failure.includes('requires the SHACL-AF runtime'))).toBe(true);
    expect(failures.some((failure) => failure.includes('not configured'))).toBe(true);
  });

  it('fails closed when the runtime errors', async () => {
    const runtime = await startFakeRuntime({ status: 500 });
    const { app, token } = await buildTestApp({ SHACL_RUNTIME_URL: runtime.baseUrl });
    await registerPolicy(app, token, 'af-policy/v1', AF_POLICY_TURTLE);

    const validate = await draftAndValidate(app, token, 'af-error', 'af-policy/v1');
    const body = (await validate.json()) as ValidateBody;
    expect(body.result.skill_version.properties.lifecycle_status).toBe('rejected');
    const failures = body.result.skill_version.properties.validation_failures ?? [];
    expect(failures.some((failure) => failure.includes('runtime boom'))).toBe(true);
  });

  it('never calls the runtime for core-only or SPARQL-constraint policies', async () => {
    const runtime = await startFakeRuntime();
    const { app, token } = await buildTestApp({ SHACL_RUNTIME_URL: runtime.baseUrl });
    await registerPolicy(app, token, 'core-policy/v1', CORE_POLICY_TURTLE);
    await registerPolicy(app, token, 'sparql-policy/v1', SPARQL_POLICY_TURTLE);

    await draftAndValidate(app, token, 'core-only', 'core-policy/v1');
    await draftAndValidate(app, token, 'sparql-only', 'sparql-policy/v1');
    expect(runtime.requests).toHaveLength(0);
  });

  it('pins the recorded engine id to the runtime sidecar requirements', () => {
    const version = PYSHACL_RUNTIME_ENGINE_ID.replace('pyshacl@', '').replace('+shacl-runtime', '');
    const requirements = readFileSync(
      new URL('../../../shacl-runtime/requirements.txt', import.meta.url),
      'utf8',
    );
    expect(requirements).toContain(`pyshacl==${version}`);
  });
});

describe('SHACL-AF registration conventions', () => {
  it('detects AF usage (including plain parameter usage) for runtime routing', () => {
    expect(turtleShapesRequireShaclRuntime(AF_POLICY_TURTLE)).toBe(true);
    expect(turtleShapesRequireShaclRuntime(CORE_POLICY_TURTLE)).toBe(false);
    expect(turtleShapesRequireShaclRuntime(SPARQL_POLICY_TURTLE)).toBe(false);
    const componentUsageOnly = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <urn:example:> .
<urn:sg:shape:u> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:property [ sh:path <urn:sg:property:description> ; <urn:example:af#startsWith> "x" ] .
ex:StartsWithComponent a sh:ConstraintComponent ;
  sh:parameter [ sh:path <urn:example:af#startsWith> ] ;
  sh:propertyValidator ex:v .
ex:v a sh:SPARQLSelectValidator ;
  sh:select "SELECT $this ?value WHERE { $this $PATH ?value . FILTER(!STRSTARTS(STR(?value), STR($startsWith))) }" .
`;
    expect(turtleShapesRequireShaclRuntime(componentUsageOnly)).toBe(true);
  });

  it('accepts rules, SPARQL functions, and custom constraint components', () => {
    expect(parseTurtlePolicyShapes(AF_POLICY_TURTLE)).toEqual({ shape_count: 1 });

    const tripleRule = `@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:rule [ a sh:TripleRule ; sh:subject sh:this ; sh:predicate <urn:sg:property:x> ; sh:object "y" ] .
`;
    expect(parseTurtlePolicyShapes(tripleRule)).toEqual({ shape_count: 1 });

    const component = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <urn:example:> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:property [ sh:path <urn:sg:property:description> ; <urn:example:af#startsWith> "urn:example:" ] .
ex:StartsWithComponent a sh:ConstraintComponent ;
  sh:parameter [ sh:path <urn:example:af#startsWith> ] ;
  sh:propertyValidator ex:v .
ex:v a sh:SPARQLSelectValidator ;
  sh:select "SELECT $this ?value WHERE { $this $PATH ?value . FILTER(!STRSTARTS(STR(?value), STR($startsWith))) }" .
ex:double a sh:SPARQLFunction ;
  sh:parameter [ sh:path <urn:example:fn#arg> ] ;
  sh:select "SELECT (2 * $arg AS ?result) WHERE {}" .
`;
    expect(parseTurtlePolicyShapes(component)).toEqual({ shape_count: 1 });
  });

  it('rejects JS and node expressions, which nothing executes', () => {
    for (const feature of ['sh:js', 'sh:expression']) {
      expect(() =>
        parseTurtlePolicyShapes(`@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  ${feature} [ <urn:p> "x" ] .
`),
      ).toThrow(TurtlePolicyError);
    }
  });

  it('rejects JS rules, untyped rules/functions, and unsafe SPARQL in AF constructs', () => {
    const cases: Array<[string, RegExp]> = [
      [
        `@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:rule [ a sh:JSRule ] .`,
        /sh:TripleRule or sh:SPARQLRule/,
      ],
      [
        `@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:rule [ a sh:SPARQLRule ; sh:construct "CONSTRUCT { ?this <urn:x> ?o } WHERE { SERVICE <http://evil/> { ?s ?p ?o } }" ] .`,
        /SERVICE/,
      ],
      [
        `@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:rule [ a sh:SPARQLRule ; sh:construct "CONSTRUCT { ?this <urn:x> ?o } WHERE { FILTER(REGEX(STR(?o), \\"x\\")) }" ] .`,
        /REGEX\(\) in SPARQL/,
      ],
      [
        `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <urn:example:> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:property [ sh:path <urn:sg:property:description> ; <urn:example:af#param> "x" ] .
ex:C a sh:ConstraintComponent ; sh:parameter [ sh:path <urn:example:af#param> ] ; sh:propertyValidator ex:v .
ex:v a sh:JSRule ; sh:select "SELECT $this WHERE { FILTER(false) }" .`,
        /must be a sh:SPARQLSelectValidator or sh:SPARQLAskValidator/,
      ],
      [
        `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <urn:example:> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:property [ sh:path <urn:sg:property:description> ; <urn:example:af#startsWith> "x" ] .
ex:C a sh:ConstraintComponent ; sh:parameter [ sh:path <urn:example:af#startsWith> ] ; sh:propertyValidator ex:v .
ex:v a sh:SPARQLSelectValidator ; sh:select "SELECT $this WHERE { FILTER(false) }" .
ex:F a sh:SPARQLFunction ; sh:parameter [ sh:path <urn:example:bad> ] ; sh:select "SELECT 1 WHERE {}" .`,
        /localname-derivable/,
      ],
    ];
    for (const [turtle, pattern] of cases) {
      expect(() => parseTurtlePolicyShapes(turtle), turtle.slice(0, 40)).toThrow(pattern);
    }
  });

  it('rejects generic SELECT validators (must be ASK) and query-less validators', () => {
    const genericSelect = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <urn:example:> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:property [ sh:path <urn:sg:property:description> ; <urn:example:af#p> "x" ] .
ex:C a sh:ConstraintComponent ; sh:parameter [ sh:path <urn:example:af#p> ] ; sh:validator ex:v .
ex:v a sh:SPARQLSelectValidator ; sh:select "SELECT $this WHERE { FILTER(false) }" .
`;
    expect(() => parseTurtlePolicyShapes(genericSelect)).toThrow(/sh:SPARQLAskValidator/);

    const queryless = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <urn:example:> .
<urn:s> a sh:NodeShape ; sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
  sh:property [ sh:path <urn:sg:property:description> ; <urn:example:af#p> "x" ] .
ex:C a sh:ConstraintComponent ; sh:parameter [ sh:path <urn:example:af#p> ] ; sh:propertyValidator ex:v .
ex:v a sh:SPARQLSelectValidator .
`;
    expect(() => parseTurtlePolicyShapes(queryless)).toThrow(/requires a sh:select, sh:construct, or sh:ask/);
  });
});
