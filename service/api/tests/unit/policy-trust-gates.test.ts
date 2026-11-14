import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function buildTestApp() {
  const objectsDir = await mkdtemp(path.join(os.tmpdir(), 'signet-trust-gates-'));
  tempDirs.push(objectsDir);
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
    REGISTRY_OBJECTS_DIR: objectsDir,
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Trust Gate Writer' });
  return { app: buildApp(deps), token };
}

type TestAppLike = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

async function createPolicy(
  app: TestAppLike,
  token: string,
  policyVersion: string,
  document: Record<string, unknown>,
) {
  const created = await app.request('/v1/policy-packages', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ policy_version: policyVersion, author: 'pablo', shapes: document }),
  });
  expect(created.status).toBe(201);
}

async function createDraft(app: TestAppLike, token: string, skillKey: string, policyVersion?: string) {
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'pablo',
      artifact: { content: `# ${skillKey}`, original_path: `skills/${skillKey.replaceAll(':', '-')}.md` },
      ...(policyVersion ? { governance: { policy_version: policyVersion } } : {}),
    }),
  });
  expect(draft.status).toBe(200);
}

async function skillAction(
  app: TestAppLike,
  token: string,
  skillKey: string,
  action: 'validate' | 'publish' | 'certify',
) {
  return await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/${action}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ author: 'pablo' }),
  });
}

async function skillArtifactSha(app: TestAppLike, skillKey: string): Promise<string> {
  const version = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1`);
  const body = (await version.json()) as { artifacts: Array<{ sha256?: string }> };
  const sha = body.artifacts[0]?.sha256;
  if (!sha) throw new Error('Expected a published artifact digest.');
  return sha;
}

async function registerTrustedKey(app: TestAppLike, token: string, keyRef: string, owner: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const created = await app.request('/v1/public-keys', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      key_ref: keyRef,
      algorithm: 'ed25519',
      public_key_pem: publicKeyPem,
      owner,
      trust_scope: 'skill-publication',
    }),
  });
  expect(created.status).toBe(201);
  return { privateKey };
}

function buildDsseEnvelope(statement: Record<string, unknown>, privateKey: KeyObject) {
  const payload = Buffer.from(JSON.stringify(statement), 'utf8');
  const payloadType = 'application/vnd.in-toto+json';
  const pae = Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `, 'utf8'),
    payload,
  ]);
  return {
    payload_type: payloadType,
    payload: payload.toString('base64'),
    signatures: [{ sig: `base64:${signBytes(null, pae, privateKey).toString('base64')}` }],
  };
}

async function attachAttestation(
  app: TestAppLike,
  token: string,
  publicationUrn: string,
  predicateType: string,
  artifactSha: string,
  privateKey: KeyObject,
  keyRef: string,
) {
  const attach = await app.request('/v1/attestations', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      publication_urn: publicationUrn,
      signer: 'build-bot',
      key_ref: keyRef,
      algorithm: 'ed25519',
      envelope: buildDsseEnvelope(
        {
          _type: 'https://in-toto.io/Statement/v1',
          predicateType,
          subject: [{ name: 'signet/skill', digest: { sha256: artifactSha } }],
          predicate: { buildType: 'https://signet.dev/build/v1' },
        },
        privateKey,
      ),
    }),
  });
  expect(attach.status).toBe(200);
}

async function attachDetachedSignature(
  app: TestAppLike,
  token: string,
  skillKey: string,
  keyRef: string,
  privateKey: KeyObject,
) {
  const envelope = await app.request(
    `/v1/skills/${encodeURIComponent(skillKey)}/versions/1/publication-envelope`,
  );
  expect(envelope.status).toBe(200);
  const body = (await envelope.json()) as { canonical_json: string };
  const signature = `base64:${signBytes(null, Buffer.from(body.canonical_json, 'utf8'), privateKey).toString('base64')}`;
  return await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/signatures`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ signer: 'pablo', key_ref: keyRef, algorithm: 'ed25519', signature }),
  });
}

const SHAPES = [{ id: 'policy/trust', target: { entity_type: 'SKILL_VERSION' } }];

describe('policy-driven publication trust gates', () => {
  it('require_validation blocks publish until validation passes', async () => {
    const { app, token } = await buildTestApp();
    await createPolicy(app, token, 'trust-validation/v1', { shapes: SHAPES, require_validation: true });
    await createDraft(app, token, 'skill:gate-validation', 'trust-validation/v1');

    const blocked = await skillAction(app, token, 'skill:gate-validation', 'publish');
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_VALIDATION_REQUIRED' },
    });

    expect((await skillAction(app, token, 'skill:gate-validation', 'validate')).status).toBe(200);
    expect((await skillAction(app, token, 'skill:gate-validation', 'publish')).status).toBe(200);
  });

  it('require_build_provenance and require_sbom bind at certification', async () => {
    const { app, token } = await buildTestApp();
    await createPolicy(app, token, 'trust-provenance/v1', {
      shapes: SHAPES,
      require_build_provenance: true,
      require_sbom: true,
    });
    await createDraft(app, token, 'skill:gate-provenance', 'trust-provenance/v1');
    expect((await skillAction(app, token, 'skill:gate-provenance', 'publish')).status).toBe(200);
    const artifactSha = await skillArtifactSha(app, 'skill:gate-provenance');
    const publicationUrn = 'urn:sg:skill-version:skill:gate-provenance@v1';
    const { privateKey } = await registerTrustedKey(app, token, 'kms://build/gate-key', 'build-team');

    const blocked = await skillAction(app, token, 'skill:gate-provenance', 'certify');
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_BUILD_PROVENANCE_REQUIRED' },
    });

    await attachAttestation(
      app,
      token,
      publicationUrn,
      'https://slsa.dev/provenance/v1',
      artifactSha,
      privateKey,
      'kms://build/gate-key',
    );
    const stillBlocked = await skillAction(app, token, 'skill:gate-provenance', 'certify');
    expect(stillBlocked.status).toBe(409);
    await expect(stillBlocked.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_SBOM_REQUIRED' },
    });

    await attachAttestation(
      app,
      token,
      publicationUrn,
      'https://spdx.dev/Document',
      artifactSha,
      privateKey,
      'kms://build/gate-key',
    );
    expect((await skillAction(app, token, 'skill:gate-provenance', 'certify')).status).toBe(200);
  });

  it('require_signature blocks certification until a valid signature is attached', async () => {
    const { app, token } = await buildTestApp();
    await createPolicy(app, token, 'trust-signature/v1', { shapes: SHAPES, require_signature: true });
    await createDraft(app, token, 'skill:gate-signature', 'trust-signature/v1');
    expect((await skillAction(app, token, 'skill:gate-signature', 'publish')).status).toBe(200);
    const { privateKey } = await registerTrustedKey(app, token, 'kms://build/sign-key', 'pablo');

    const blocked = await skillAction(app, token, 'skill:gate-signature', 'certify');
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_SIGNATURE_REQUIRED' },
    });

    const signed = await attachDetachedSignature(app, token, 'skill:gate-signature', 'kms://build/sign-key', privateKey);
    expect(signed.status).toBe(200);
    expect((await skillAction(app, token, 'skill:gate-signature', 'certify')).status).toBe(200);
  });

  it('require_trusted_publisher rejects keys not owned by the publisher', async () => {
    const { app, token } = await buildTestApp();
    await createPolicy(app, token, 'trust-publisher/v1', {
      shapes: SHAPES,
      require_trusted_publisher: true,
    });
    await createDraft(app, token, 'skill:gate-publisher', 'trust-publisher/v1');
    // publish with author 'pablo' binds publisher = 'pablo'.
    expect((await skillAction(app, token, 'skill:gate-publisher', 'publish')).status).toBe(200);

    const wrongOwner = await registerTrustedKey(app, token, 'kms://build/other-key', 'someone-else');
    const rejected = await attachDetachedSignature(
      app,
      token,
      'skill:gate-publisher',
      'kms://build/other-key',
      wrongOwner.privateKey,
    );
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_SIGNATURE_PUBLISHER_MISMATCH' },
    });

    const publisherKey = await registerTrustedKey(app, token, 'kms://build/publisher-key', 'pablo');
    const accepted = await attachDetachedSignature(
      app,
      token,
      'skill:gate-publisher',
      'kms://build/publisher-key',
      publisherKey.privateKey,
    );
    expect(accepted.status).toBe(200);
    expect((await skillAction(app, token, 'skill:gate-publisher', 'certify')).status).toBe(200);
  });
});
