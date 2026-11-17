import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';

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
  const { token } = await deps.apiKeys.create({ owner_label: 'Report Signer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type TestApp = ReturnType<typeof buildApp>;

async function registerKey(
  app: TestApp,
  token: string,
  keyRef: string,
  owner: string,
  kind: 'ed25519' | 'ecdsa-p256-sha256',
): Promise<KeyObject> {
  const { publicKey, privateKey } =
    kind === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const create = await app.request('/v1/public-keys', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      key_ref: keyRef,
      algorithm: kind,
      public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      owner,
    }),
  });
  expect(create.status).toBe(201);
  return privateKey;
}

function signBase64(privateKey: KeyObject, bytes: string, kind: 'ed25519' | 'ecdsa-p256-sha256' = 'ed25519'): string {
  const digest = kind === 'ed25519' ? null : 'sha256';
  return `base64:${signBytes(digest, Buffer.from(bytes, 'utf8'), privateKey).toString('base64')}`;
}

async function createPublishedSkill(app: TestApp, token: string, skillKey: string) {
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'pablo',
      artifact: { content: '# report signature test', original_path: `skills/${skillKey}.md` },
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

type ReportRef = { role: string; artifact_urn: string; sha256?: string };

async function skillRefs(app: TestApp, versionPath: string): Promise<ReportRef[]> {
  const versionBody = (await (await app.request(versionPath)).json()) as { governance_artifacts: ReportRef[] };
  return versionBody.governance_artifacts;
}

async function agentRefs(app: TestApp, agentKey: string, version: number): Promise<ReportRef[]> {
  const list = (await (await app.request(`/v1/agents/${encodeURIComponent(agentKey)}/versions`)).json()) as {
    versions: Array<{ agent_version: { properties: { version?: number } }; governance_artifacts: ReportRef[] }>;
  };
  const entry = list.versions.find((candidate) => candidate.agent_version.properties.version === version);
  if (!entry) throw new Error(`Agent version ${version} not found in list.`);
  return entry.governance_artifacts;
}

/** Locate the SHACL report among the refs (roles also cover LLM evidence/placeholders). */
async function locateReport(app: TestApp, refs: ReportRef[]): Promise<{ reportArtifactUrn: string; canonicalRdfSha256: string }> {
  for (const ref of refs.filter((artifact) => artifact.role === 'validation_report')) {
    if (!ref.sha256) continue;
    const payload = (await (await app.request(`/v1/artifacts/${ref.sha256}`)).json()) as {
      payload?: { validator?: string; rdf?: { canonical_rdf_sha256?: string } };
    };
    if (payload.payload?.validator === 'shacl-v1' && typeof payload.payload.rdf?.canonical_rdf_sha256 === 'string') {
      return { reportArtifactUrn: ref.artifact_urn, canonicalRdfSha256: payload.payload.rdf.canonical_rdf_sha256 };
    }
  }
  throw new Error('SHACL validation report not found among governance artifacts.');
}

type ReportSignatureRow = {
  key_ref: string;
  verdict: 'valid' | 'invalid';
  report_artifact_present: boolean;
  canonical_artifact_present: boolean;
  trusted_public_key_resolved: boolean;
  cryptographic_verification_passed: boolean;
};

async function fetchReportSignatureRows(app: TestApp, versionPath: string): Promise<ReportSignatureRow[]> {
  const response = await app.request(`${versionPath}/report-signatures`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { report_signatures: ReportSignatureRow[] }).report_signatures;
}

describe('validation report signatures', () => {
  it('attaches, verifies on read, stays idempotent, and reports invalid after key revocation', async () => {
    const { app, token } = await buildTestApp();
    const privateKey = await registerKey(app, token, 'rptsig://keys/auditor', 'auditor', 'ed25519');
    await createPublishedSkill(app, token, 'skill:rptsig');

    const versionPath = '/v1/skills/skill:rptsig/versions/1';
    const { reportArtifactUrn, canonicalRdfSha256 } = await locateReport(app, await skillRefs(app, versionPath));
    const canonical = await (await app.request(`/v1/artifacts/${canonicalRdfSha256}`)).text();
    const signature = signBase64(privateKey, canonical);

    const attach = await app.request(`${versionPath}/report-signatures`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        report_artifact_urn: reportArtifactUrn,
        signer: 'auditor',
        key_ref: 'rptsig://keys/auditor',
        algorithm: 'ed25519',
        signature,
      }),
    });
    expect(attach.status).toBe(200);
    const attached = (await attach.json()) as {
      report_signature: { report_artifact_urn: string; report_canonical_rdf_sha256: string };
      created: boolean;
    };
    expect(attached.created).toBe(true);
    expect(attached.report_signature.report_artifact_urn).toBe(reportArtifactUrn);
    expect(attached.report_signature.report_canonical_rdf_sha256).toBe(canonicalRdfSha256);

    const rows = await fetchReportSignatureRows(app, versionPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key_ref: 'rptsig://keys/auditor',
      report_artifact_present: true,
      canonical_artifact_present: true,
      trusted_public_key_resolved: true,
      cryptographic_verification_passed: true,
      verdict: 'valid',
    });

    // Identical re-attach is idempotent.
    const reattach = await app.request(`${versionPath}/report-signatures`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        report_artifact_urn: reportArtifactUrn,
        signer: 'auditor',
        key_ref: 'rptsig://keys/auditor',
        algorithm: 'ed25519',
        signature,
      }),
    });
    expect(reattach.status).toBe(200);
    expect(((await reattach.json()) as { created: boolean }).created).toBe(false);

    // Revoking the key flips the stored signature to invalid on read.
    const revoke = await app.request('/v1/public-keys/rptsig%3A%2F%2Fkeys%2Fauditor/revoke', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo', reason: 'rotation' }),
    });
    expect(revoke.status).toBe(200);
    const revokedRows = await fetchReportSignatureRows(app, versionPath);
    expect(revokedRows[0]).toMatchObject({ trusted_public_key_resolved: false, verdict: 'invalid' });
  });

  it('rejects invalid targets, invalid signatures, untrusted keys, and conflicting duplicates', async () => {
    const { app, token } = await buildTestApp();
    const ed25519Key = await registerKey(app, token, 'rptsig://keys/a', 'a', 'ed25519');
    const ecdsaKey = await registerKey(app, token, 'rptsig://keys/b', 'b', 'ecdsa-p256-sha256');
    await createPublishedSkill(app, token, 'skill:rptsig-gates');

    const versionPath = '/v1/skills/skill:rptsig-gates/versions/1';
    const { reportArtifactUrn, canonicalRdfSha256 } = await locateReport(app, await skillRefs(app, versionPath));
    const canonical = await (await app.request(`/v1/artifacts/${canonicalRdfSha256}`)).text();

    const attach = async (body: Record<string, unknown>) =>
      await app.request(`${versionPath}/report-signatures`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(body),
      });

    // Unknown target: an artifact urn that is not a report of this version.
    const unknownTarget = await attach({
      report_artifact_urn: `urn:sg:artifact:sha256:${'a'.repeat(64)}`,
      signer: 'a',
      key_ref: 'rptsig://keys/a',
      algorithm: 'ed25519',
      signature: signBase64(ed25519Key, canonical),
    });
    expect(unknownTarget.status).toBe(409);
    await expect(unknownTarget.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_REPORT_SIGNATURE_TARGET_INVALID' },
    });

    // Invalid signature: correct target, signature over different bytes.
    const invalid = await attach({
      report_artifact_urn: reportArtifactUrn,
      signer: 'a',
      key_ref: 'rptsig://keys/a',
      algorithm: 'ed25519',
      signature: signBase64(ed25519Key, `${canonical}#other`),
    });
    expect(invalid.status).toBe(409);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_REPORT_SIGNATURE_INVALID' },
    });

    // Untrusted key.
    const untrusted = await attach({
      report_artifact_urn: reportArtifactUrn,
      signer: 'ghost',
      key_ref: 'rptsig://keys/ghost',
      algorithm: 'ed25519',
      signature: signBase64(ed25519Key, canonical),
    });
    expect(untrusted.status).toBe(409);
    await expect(untrusted.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_REPORT_SIGNATURE_KEY_UNTRUSTED' },
    });

    // Conflicting duplicate: ECDSA signatures are randomized over the same bytes.
    const first = await attach({
      report_artifact_urn: reportArtifactUrn,
      signer: 'b',
      key_ref: 'rptsig://keys/b',
      algorithm: 'ecdsa-p256-sha256',
      signature: signBase64(ecdsaKey, canonical, 'ecdsa-p256-sha256'),
    });
    expect(first.status).toBe(200);
    const conflict = await attach({
      report_artifact_urn: reportArtifactUrn,
      signer: 'b',
      key_ref: 'rptsig://keys/b',
      algorithm: 'ecdsa-p256-sha256',
      signature: signBase64(ecdsaKey, canonical, 'ecdsa-p256-sha256'),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_REPORT_SIGNATURE_CONFLICT' },
    });
  });

  it('serves agent report signatures with full parity', async () => {
    const { app, token } = await buildTestApp();
    const privateKey = await registerKey(app, token, 'rptsig://keys/agent-auditor', 'agent-auditor', 'ed25519');

    const createAgent = await app.request('/v1/agents', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        agent_key: 'agent:rptsig',
        source_path: 'agents/rptsig.md',
        artifact: { content: '# agent', original_path: 'agents/rptsig.md' },
      }),
    });
    expect(createAgent.status).toBe(201);
    for (const action of ['validate', 'publish']) {
      const step = await app.request(`/v1/agents/agent:rptsig/versions/1/${action}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ author: 'pablo' }),
      });
      expect(step.status).toBe(200);
    }

    const versionPath = '/v1/agents/agent:rptsig/versions/1';
    const { reportArtifactUrn, canonicalRdfSha256 } = await locateReport(app, await agentRefs(app, 'agent:rptsig', 1));
    const canonical = await (await app.request(`/v1/artifacts/${canonicalRdfSha256}`)).text();
    const attach = await app.request(`${versionPath}/report-signatures`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        report_artifact_urn: reportArtifactUrn,
        signer: 'agent-auditor',
        key_ref: 'rptsig://keys/agent-auditor',
        algorithm: 'ed25519',
        signature: signBase64(privateKey, canonical),
      }),
    });
    expect(attach.status).toBe(200);

    const rows = await fetchReportSignatureRows(app, versionPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe('valid');
  });
});
