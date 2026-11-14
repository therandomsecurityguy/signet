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
  const objectsDir = await mkdtemp(path.join(os.tmpdir(), 'cachet-attestations-'));
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
  const { token } = await deps.apiKeys.create({ owner_label: 'Attestation Writer' });
  return { app: buildApp(deps), token };
}

type TestAppLike = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

async function registerTrustedEd25519Key(app: TestAppLike, token: string, keyRef: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const create = await app.request('/v1/public-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      key_ref: keyRef,
      algorithm: 'ed25519',
      public_key_pem: publicKeyPem,
      owner: 'build-team',
      trust_scope: 'skill-publication',
    }),
  });
  expect(create.status).toBe(201);
  return { privateKey };
}

async function publishSkill(app: TestAppLike, token: string, skillKey: string): Promise<string> {
  const auth = { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      author: 'pablo',
      display_name: 'Attestation demo',
      artifact: { content: '# Attestation demo\n', original_path: 'skills/attestation-demo.md' },
    }),
  });
  expect(draft.status).toBe(200);
  const publish = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/publish`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ author: 'pablo' }),
  });
  expect(publish.status).toBe(200);
  const version = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1`);
  const body = (await version.json()) as { artifacts: Array<{ sha256?: string }> };
  const sha256 = body.artifacts[0]?.sha256;
  if (!sha256) throw new Error('Expected a published artifact digest.');
  return sha256;
}

function buildDsseEnvelope(input: {
  statement: Record<string, unknown>;
  privateKey: KeyObject;
  signInstead?: Buffer;
}) {
  const payload = Buffer.from(JSON.stringify(input.statement), 'utf8');
  const payloadType = 'application/vnd.in-toto+json';
  const pae = Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `, 'utf8'),
    payload,
  ]);
  const signedBytes = input.signInstead ?? pae;
  const sig = signBytes(null, signedBytes, input.privateKey).toString('base64');
  return {
    payload_type: payloadType,
    payload: payload.toString('base64'),
    signatures: [{ sig: `base64:${sig}` }],
  };
}

function slsaStatement(artifactSha256: string) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: 'cachet/skill', digest: { sha256: artifactSha256 } }],
    predicate: { buildType: 'https://cachet.dev/build/v1', builder: { id: 'github-actions' } },
  };
}

describe('publication attestations', () => {
  it('verifies, stores, and surfaces a DSSE in-toto attestation', async () => {
    const { app, token } = await buildTestApp();
    const skillKey = 'skill:attested';
    const artifactSha = await publishSkill(app, token, skillKey);
    const { privateKey } = await registerTrustedEd25519Key(app, token, 'kms://build/attestation-key');

    const attach = await app.request('/v1/attestations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        publication_urn: `urn:sg:skill-version:${skillKey}@v1`,
        signer: 'build-bot',
        key_ref: 'kms://build/attestation-key',
        algorithm: 'ed25519',
        envelope: buildDsseEnvelope({ statement: slsaStatement(artifactSha), privateKey }),
        note: 'slsa provenance',
      }),
    });
    expect(attach.status).toBe(200);
    const attached = (await attach.json()) as {
      attestation: {
        predicate_type: string;
        signature_valid: boolean;
        subject_bound: boolean;
        subject_digests: string[];
      };
    };
    expect(attached.attestation.predicate_type).toBe('https://slsa.dev/provenance/v1');
    expect(attached.attestation.signature_valid).toBe(true);
    expect(attached.attestation.subject_bound).toBe(true);
    expect(attached.attestation.subject_digests).toEqual([artifactSha]);

    const list = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/attestations`);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      attestations: [
        expect.objectContaining({
          predicate_type: 'https://slsa.dev/provenance/v1',
          signer: 'build-bot',
          key_ref: 'kms://build/attestation-key',
          signature_valid: true,
          subject_bound: true,
        }),
      ],
    });

    const verification = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/verification`);
    expect(verification.status).toBe(200);
    await expect(verification.json()).resolves.toMatchObject({
      all_attestation_signatures_valid: true,
      attestations: [expect.objectContaining({ predicate_type: 'https://slsa.dev/provenance/v1' })],
    });
  });

  it('rejects invalid signatures, unknown keys, subjects that do not match, and unpublished versions', async () => {
    const { app, token } = await buildTestApp();
    const skillKey = 'skill:attestation-guards';
    const artifactSha = await publishSkill(app, token, skillKey);
    const { privateKey } = await registerTrustedEd25519Key(app, token, 'kms://build/guard-key');
    const auth = { 'content-type': 'application/json', Authorization: `Bearer ${token}` };

    const badSignature = await app.request('/v1/attestations', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        publication_urn: `urn:sg:skill-version:${skillKey}@v1`,
        signer: 'build-bot',
        key_ref: 'kms://build/guard-key',
        algorithm: 'ed25519',
        envelope: buildDsseEnvelope({
          statement: slsaStatement(artifactSha),
          privateKey,
          signInstead: Buffer.from('not the payload', 'utf8'),
        }),
      }),
    });
    expect(badSignature.status).toBe(409);
    await expect(badSignature.json()).resolves.toMatchObject({
      error: { code: 'ATTESTATION_SIGNATURE_INVALID' },
    });

    const unknownKey = await app.request('/v1/attestations', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        publication_urn: `urn:sg:skill-version:${skillKey}@v1`,
        signer: 'build-bot',
        key_ref: 'kms://build/missing-key',
        algorithm: 'ed25519',
        envelope: buildDsseEnvelope({ statement: slsaStatement(artifactSha), privateKey }),
      }),
    });
    expect(unknownKey.status).toBe(409);
    await expect(unknownKey.json()).resolves.toMatchObject({
      error: { code: 'ATTESTATION_TRUSTED_KEY_NOT_FOUND' },
    });

    const mismatch = await app.request('/v1/attestations', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        publication_urn: `urn:sg:skill-version:${skillKey}@v1`,
        signer: 'build-bot',
        key_ref: 'kms://build/guard-key',
        algorithm: 'ed25519',
        envelope: buildDsseEnvelope({
          statement: slsaStatement('a'.repeat(64)),
          privateKey,
        }),
      }),
    });
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({
      error: { code: 'ATTESTATION_SUBJECT_MISMATCH' },
    });

    // A draft-only version is not attestable evidence yet.
    const draftOnly = await app.request('/v1/skills/skill:attestation-draft/drafts', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# Draft only\n' },
      }),
    });
    expect(draftOnly.status).toBe(200);
    const conflict = await app.request('/v1/attestations', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        publication_urn: 'urn:sg:skill-version:skill:attestation-draft@v1',
        signer: 'build-bot',
        key_ref: 'kms://build/guard-key',
        algorithm: 'ed25519',
        envelope: buildDsseEnvelope({ statement: slsaStatement(artifactSha), privateKey }),
      }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: 'ATTESTATION_CONFLICT' } });

    const missing = await app.request('/v1/attestations', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        publication_urn: 'urn:sg:skill-version:skill:missing@v1',
        signer: 'build-bot',
        key_ref: 'kms://build/guard-key',
        algorithm: 'ed25519',
        envelope: buildDsseEnvelope({ statement: slsaStatement(artifactSha), privateKey }),
      }),
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'ATTESTATION_PUBLICATION_NOT_FOUND' },
    });
  });
});
