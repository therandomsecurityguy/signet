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
  const { token } = await deps.apiKeys.create({ owner_label: 'Provenance Signer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type TestApp = ReturnType<typeof buildApp>;

async function registerEd25519Key(
  app: TestApp,
  token: string,
  keyRef: string,
  owner: string,
): Promise<{ privateKey: KeyObject; publicKeyPem: string }> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const create = await app.request('/v1/public-keys', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ key_ref: keyRef, algorithm: 'ed25519', public_key_pem: publicKeyPem, owner }),
  });
  expect(create.status).toBe(201);
  return { privateKey, publicKeyPem };
}

async function registerEcdsaKey(app: TestApp, token: string, keyRef: string, owner: string): Promise<KeyObject> {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const create = await app.request('/v1/public-keys', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      key_ref: keyRef,
      algorithm: 'ecdsa-p256-sha256',
      public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      owner,
    }),
  });
  expect(create.status).toBe(201);
  return privateKey;
}

function signBase64(privateKey: KeyObject, bytes: string, algorithm: 'ed25519' | 'ecdsa-p256-sha256' = 'ed25519'): string {
  const digest = algorithm === 'ed25519' ? null : 'sha256';
  return `base64:${signBytes(digest, Buffer.from(bytes, 'utf8'), privateKey).toString('base64')}`;
}

async function createPublishedSkill(app: TestApp, token: string, skillKey: string) {
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'pablo',
      artifact: { content: '# provenance-signature test', original_path: `skills/${skillKey}.md` },
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

type ProvenanceSignatureRow = {
  artifact_urn: string;
  signer: string;
  key_ref: string;
  algorithm: string;
  provenance_sha256: string;
  artifact_present: boolean;
  trusted_public_key_resolved: boolean;
  cryptographic_verification_passed: boolean;
  digest_matches_current: boolean;
  verdict: 'valid' | 'invalid' | 'stale';
};

type ProvenanceBody = {
  evidence: { canonical_rdf_sha256: string; canonical_rdf_artifact_urn: string };
  provenance_signatures: ProvenanceSignatureRow[];
  all_provenance_signatures_verified: boolean;
  current_provenance_signed: boolean;
};

async function fetchProvenance(app: TestApp, path: string): Promise<ProvenanceBody> {
  const response = await app.request(path);
  expect(response.status).toBe(200);
  return (await response.json()) as ProvenanceBody;
}

async function canonicalBytes(app: TestApp, sha256: string): Promise<string> {
  const response = await app.request(`/v1/artifacts/${sha256}`);
  expect(response.status).toBe(200);
  return await response.text();
}

describe('provenance signatures', () => {
  it('attaches, verifies, stays idempotent, and flips to stale when provenance grows', async () => {
    const { app, token } = await buildTestApp();
    const { privateKey } = await registerEd25519Key(app, token, 'provsig://keys/auditor', 'auditor');
    await createPublishedSkill(app, token, 'skill:provsig');

    const path = '/v1/skills/skill:provsig/versions/1/provenance';
    const before = await fetchProvenance(app, path);
    expect(before.provenance_signatures).toEqual([]);
    expect(before.all_provenance_signatures_verified).toBe(false);
    expect(before.current_provenance_signed).toBe(false);

    const canonical = await canonicalBytes(app, before.evidence.canonical_rdf_sha256);
    const signature = signBase64(privateKey, canonical);
    const attach = await app.request(`${path}/signatures`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        signer: 'auditor',
        key_ref: 'provsig://keys/auditor',
        algorithm: 'ed25519',
        signature,
        provenance_sha256: before.evidence.canonical_rdf_sha256,
      }),
    });
    expect(attach.status).toBe(200);
    const attached = (await attach.json()) as {
      provenance_signature: { artifact_urn: string; provenance_sha256: string; signer: string };
      created: boolean;
    };
    expect(attached.created).toBe(true);
    expect(attached.provenance_signature.provenance_sha256).toBe(before.evidence.canonical_rdf_sha256);

    // Re-read: verified against the current export.
    const after = await fetchProvenance(app, path);
    expect(after.provenance_signatures).toHaveLength(1);
    expect(after.provenance_signatures[0]).toMatchObject({
      signer: 'auditor',
      key_ref: 'provsig://keys/auditor',
      artifact_present: true,
      trusted_public_key_resolved: true,
      cryptographic_verification_passed: true,
      digest_matches_current: true,
      verdict: 'valid',
    });
    expect(after.all_provenance_signatures_verified).toBe(true);
    expect(after.current_provenance_signed).toBe(true);

    // Identical re-attach is idempotent.
    const reattach = await app.request(`${path}/signatures`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        signer: 'auditor',
        key_ref: 'provsig://keys/auditor',
        algorithm: 'ed25519',
        signature,
      }),
    });
    expect(reattach.status).toBe(200);
    expect(((await reattach.json()) as { created: boolean }).created).toBe(false);

    // Provenance grows (deprecate) after signing: verdict flips to stale —
    // still cryptographically valid over its (retrievable) signed export.
    const deprecate = await app.request('/v1/skills/skill:provsig/versions/1/deprecate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(deprecate.status).toBe(200);

    const grown = await fetchProvenance(app, path);
    expect(grown.evidence.canonical_rdf_sha256).not.toBe(before.evidence.canonical_rdf_sha256);
    expect(grown.provenance_signatures[0]).toMatchObject({
      provenance_sha256: before.evidence.canonical_rdf_sha256,
      digest_matches_current: false,
      cryptographic_verification_passed: true,
      verdict: 'stale',
    });
    expect(grown.all_provenance_signatures_verified).toBe(true);
    expect(grown.current_provenance_signed).toBe(false);
  });

  it('rejects stale digests, invalid signatures, untrusted keys, and conflicting duplicates', async () => {
    const { app, token } = await buildTestApp();
    const { privateKey } = await registerEd25519Key(app, token, 'provsig://keys/a', 'a');
    const ecdsaKey = await registerEcdsaKey(app, token, 'provsig://keys/b', 'b');
    await createPublishedSkill(app, token, 'skill:provsig-gates');

    const path = '/v1/skills/skill:provsig-gates/versions/1/provenance';
    const provenance = await fetchProvenance(app, path);
    const canonical = await canonicalBytes(app, provenance.evidence.canonical_rdf_sha256);

    const attach = async (body: Record<string, unknown>) =>
      await app.request(`${path}/signatures`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(body),
      });

    // Stale: an explicit digest that is not the current export.
    const stale = await attach({
      signer: 'a',
      key_ref: 'provsig://keys/a',
      algorithm: 'ed25519',
      signature: signBase64(privateKey, canonical),
      provenance_sha256: 'f'.repeat(64),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_PROVENANCE_SIGNATURE_STALE' },
    });

    // Invalid: correct digest, signature over different bytes.
    const invalid = await attach({
      signer: 'a',
      key_ref: 'provsig://keys/a',
      algorithm: 'ed25519',
      signature: signBase64(privateKey, `${canonical}#other`),
      provenance_sha256: provenance.evidence.canonical_rdf_sha256,
    });
    expect(invalid.status).toBe(409);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_PROVENANCE_SIGNATURE_INVALID' },
    });

    // Untrusted: key_ref does not resolve to a trusted key.
    const untrusted = await attach({
      signer: 'ghost',
      key_ref: 'provsig://keys/ghost',
      algorithm: 'ed25519',
      signature: signBase64(privateKey, canonical),
    });
    expect(untrusted.status).toBe(409);
    await expect(untrusted.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_PROVENANCE_SIGNATURE_KEY_UNTRUSTED' },
    });

    // Conflicting duplicate: ECDSA signatures are randomized, so the same
    // key can produce two different valid signatures over one digest.
    const first = await attach({
      signer: 'b',
      key_ref: 'provsig://keys/b',
      algorithm: 'ecdsa-p256-sha256',
      signature: signBase64(ecdsaKey, canonical, 'ecdsa-p256-sha256'),
    });
    expect(first.status).toBe(200);
    const second = await attach({
      signer: 'b',
      key_ref: 'provsig://keys/b',
      algorithm: 'ecdsa-p256-sha256',
      signature: signBase64(ecdsaKey, canonical, 'ecdsa-p256-sha256'),
    });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_PROVENANCE_SIGNATURE_CONFLICT' },
    });
  });

  it('serves agent provenance signatures with full parity', async () => {
    const { app, token } = await buildTestApp();
    const { privateKey } = await registerEd25519Key(app, token, 'provsig://keys/agent-auditor', 'agent-auditor');

    const createAgent = await app.request('/v1/agents', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        agent_key: 'agent:provsig',
        source_path: 'agents/provsig.md',
        artifact: { content: '# agent', original_path: 'agents/provsig.md' },
      }),
    });
    expect(createAgent.status).toBe(201);
    for (const action of ['validate', 'publish']) {
      const step = await app.request(`/v1/agents/agent:provsig/versions/1/${action}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ author: 'pablo' }),
      });
      expect(step.status).toBe(200);
    }

    const path = '/v1/agents/agent:provsig/versions/1/provenance';
    const provenance = await fetchProvenance(app, path);
    const canonical = await canonicalBytes(app, provenance.evidence.canonical_rdf_sha256);
    const attach = await app.request(`${path}/signatures`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        signer: 'agent-auditor',
        key_ref: 'provsig://keys/agent-auditor',
        algorithm: 'ed25519',
        signature: signBase64(privateKey, canonical),
      }),
    });
    expect(attach.status).toBe(200);

    const verified = await fetchProvenance(app, path);
    expect(verified.provenance_signatures).toHaveLength(1);
    expect(verified.provenance_signatures[0]?.verdict).toBe('valid');
    expect(verified.current_provenance_signed).toBe(true);
  });
});
