import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { closeSidecarServers, startNativeSidecar } from './support/native-sidecar.js';

afterEach(async () => {
  await closeSidecarServers();
});

type TestApp = ReturnType<typeof buildApp>;

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
  const { token } = await deps.apiKeys.create({ owner_label: 'Evidence Transparency Writer' });
  return { app: buildApp(deps), token, deps };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

async function registerEd25519Key(app: TestApp, token: string, keyRef: string, owner: string): Promise<KeyObject> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const create = await app.request('/v1/public-keys', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      key_ref: keyRef,
      algorithm: 'ed25519',
      public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      owner,
    }),
  });
  expect(create.status).toBe(201);
  return privateKey;
}

async function createPublishedSkill(app: TestApp, token: string, skillKey: string) {
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'pablo',
      artifact: { content: '# evidence transparency', original_path: `skills/${skillKey}.md` },
    }),
  });
  expect(draft.status).toBe(200);
  for (const action of ['validate', 'publish']) {
    const step = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/${action}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(step.status).toBe(200);
  }
}

function signBase64(privateKey: KeyObject, bytes: string): string {
  return `base64:${signBytes(null, Buffer.from(bytes, 'utf8'), privateKey).toString('base64')}`;
}

async function attachProvenanceSignature(app: TestApp, token: string, versionPath: string, privateKey: KeyObject) {
  const provenance = (await (await app.request(`${versionPath}/provenance`)).json()) as {
    evidence: { canonical_rdf_sha256: string };
  };
  const canonical = await (await app.request(`/v1/artifacts/${provenance.evidence.canonical_rdf_sha256}`)).text();
  const attach = await app.request(`${versionPath}/provenance/signatures`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      signer: 'auditor',
      key_ref: 'evt://keys/auditor',
      algorithm: 'ed25519',
      signature: signBase64(privateKey, canonical),
    }),
  });
  expect(attach.status).toBe(200);
  const body = (await attach.json()) as { provenance_signature: { artifact_urn: string } };
  return { provenanceSha256: provenance.evidence.canonical_rdf_sha256, signatureArtifactUrn: body.provenance_signature.artifact_urn };
}

async function reconcile(app: TestApp, token: string, publicationUrn: string) {
  const response = await app.request('/v1/transparency-logs/reconcile', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ publication_urn: publicationUrn }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    status: string;
    outcomes: Array<{ request_id: string; status: string; checks: Array<{ ok: boolean }> }>;
  };
}

describe('evidence transparency intents', () => {
  it('stages provenance and report-RDF evidence intents and reconciles them against the native log', async () => {
    const sidecar = await startNativeSidecar();
    const { app, token, deps } = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'signet-governance',
      TESSERA_LOG_PUBLIC_KEY: sidecar.publicKeyPem,
    });
    const privateKey = await registerEd25519Key(app, token, 'evt://keys/auditor', 'auditor');
    await createPublishedSkill(app, token, 'skill:evt');

    const versionPath = '/v1/skills/skill:evt/versions/1';
    const { provenanceSha256, signatureArtifactUrn } = await attachProvenanceSignature(app, token, versionPath, privateKey);

    // The validation report's RDF artifact digest rides the report payload.
    // Refs carry role "validation_report" for both the SHACL report and the
    // advisory LLM evidence artifact (and placeholders), so locate the SHACL
    // report by its payload instead of positional order.
    const versionBody = (await (await app.request(versionPath)).json()) as {
      governance_artifacts: Array<{ role: string; sha256?: string }>;
    };
    const reportRefs = versionBody.governance_artifacts.filter(
      (artifact) => artifact.role === 'validation_report' && typeof artifact.sha256 === 'string',
    );
    let reportRdfSha: string | undefined;
    for (const ref of reportRefs) {
      const payload = (await (await app.request(`/v1/artifacts/${ref.sha256}`)).json()) as {
        payload?: { validator?: string; rdf?: { canonical_rdf_sha256?: string } };
      };
      if (payload.payload?.validator === 'shacl-v1' && typeof payload.payload.rdf?.canonical_rdf_sha256 === 'string') {
        reportRdfSha = payload.payload.rdf.canonical_rdf_sha256;
        break;
      }
    }
    expect(reportRdfSha).toMatch(/^[0-9a-f]{64}$/);

    // Every evidence artifact node carries a staged append intent.
    const signatureNode = await deps.graph.getNode(signatureArtifactUrn);
    const exportNode = await deps.graph.getNode(`urn:sg:artifact:sha256:${provenanceSha256}`);
    const reportRdfNode = await deps.graph.getNode(`urn:sg:artifact:sha256:${reportRdfSha}`);
    const requestIds = [
      signatureNode?.properties['transparency_append_request_id'],
      exportNode?.properties['transparency_append_request_id'],
      reportRdfNode?.properties['transparency_append_request_id'],
    ];
    for (const requestId of requestIds) {
      expect(typeof requestId).toBe('string');
    }
    expect(exportNode?.properties['governance_role']).toBe('provenance_export');
    expect(reportRdfNode?.properties['governance_role']).toBe('validation_report_rdf');

    // Reconciliation discovers and verifies all three intent families
    // against the native companion log.
    const reconciled = await reconcile(app, token, 'urn:sg:skill-version:skill:evt@v1');
    expect(reconciled.status).toBe('verified');
    const outcomeByRequest = new Map(reconciled.outcomes.map((outcome) => [outcome.request_id, outcome]));
    for (const requestId of requestIds as string[]) {
      const outcome = outcomeByRequest.get(requestId);
      expect(outcome).toBeDefined();
      expect(outcome?.status).toBe('verified');
      expect((outcome?.checks ?? []).every((check) => check.ok)).toBe(true);
    }
  });

  it('is a no-op without a configured sidecar', async () => {
    const { app, token, deps } = await buildTestApp();
    const privateKey = await registerEd25519Key(app, token, 'evt://keys/auditor', 'auditor');
    await createPublishedSkill(app, token, 'skill:evt-off');

    const versionPath = '/v1/skills/skill:evt-off/versions/1';
    const { provenanceSha256, signatureArtifactUrn } = await attachProvenanceSignature(app, token, versionPath, privateKey);

    const signatureNode = await deps.graph.getNode(signatureArtifactUrn);
    const exportNode = await deps.graph.getNode(`urn:sg:artifact:sha256:${provenanceSha256}`);
    expect(signatureNode?.properties['transparency_append_request_id']).toBeUndefined();
    expect(exportNode?.properties['transparency_append_request_id']).toBeUndefined();
  });
});
