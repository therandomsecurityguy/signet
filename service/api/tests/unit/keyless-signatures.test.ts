import { readFileSync } from 'node:fs';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

const FIXTURES = path.resolve('tests/fixtures/keyless');

const keylessEnv = {
  KEYLESS_TRUSTED_ROOTS: `${FIXTURES}/intermediate.pem,${FIXTURES}/root.pem`,
  KEYLESS_ALLOWED_ISSUERS: 'https://token.actions.githubusercontent.com',
  KEYLESS_ALLOWED_SUBJECTS: '^https://github\\.com/togethercomputer/signet/',
};

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
  const { token } = await deps.apiKeys.create({ owner_label: 'Keyless Writer' });
  return { app: buildApp(deps), token, deps };
}

type TestAppLike = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

function fixturePem(name: string): string {
  return readFileSync(path.join(FIXTURES, `${name}.pem`), 'utf8');
}

function certDerBase64(name: string): string {
  return Buffer.from(
    fixturePem(name).replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''),
    'base64',
  ).toString('base64');
}

function bundleFor(leafName: string, signedBytes: Buffer): Record<string, unknown> {
  const digest = createHash('sha256').update(signedBytes).digest('base64');
  const signature = sign('sha256', signedBytes, createPrivateKey(fixturePem(`${leafName}-key`))).toString('base64');
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: {
      certificate: { rawBytes: certDerBase64(leafName) },
      tlogEntries: [],
    },
    messageSignature: { messageDigest: { algorithm: 'SHA2_256', digest }, signature },
  };
}

async function createValidatedSkill(app: TestAppLike, token: string, skillKey: string) {
  const draft = await app.request(`/v1/skills/${skillKey}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'governance-team',
      artifact: { content: `# ${skillKey}\nKeyless signature fixture.\n`, original_path: `skills/${skillKey}.md` },
    }),
  });
  expect([200, 201]).toContain(draft.status);
  const validate = await app.request(`/v1/skills/${skillKey}/versions/1/validate`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ author: 'governance-team' }),
  });
  expect(validate.status).toBe(200);
}

describe('keyless publication signatures', () => {
  it('publishes with a keyless signature in one prepared request', async () => {
    const { app, token } = await buildTestApp(keylessEnv);
    await createValidatedSkill(app, token, 'kl-prepared');

    const prepare = await app.request('/v1/skills/kl-prepared/versions/1/prepare-publication', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'governance-team' }),
    });
    expect(prepare.status).toBe(200);
    const prepared = (await prepare.json()) as { prepared_publication_urn: string; canonical_json: string };

    const bundle = bundleFor('leaf', Buffer.from(prepared.canonical_json, 'utf8'));
    const publish = await app.request('/v1/skills/kl-prepared/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'governance-team',
        prepared_publication_urn: prepared.prepared_publication_urn,
        signatures: [{ signer: 'signet-release-workflow', keyless_bundle: bundle }],
      }),
    });
    if (publish.status !== 200) {
      console.log('DEBUG keyless publish body', JSON.stringify(await publish.clone().json()));
    }
    expect(publish.status).toBe(200);

    const envelope = await app.request('/v1/skills/kl-prepared/versions/1/publication-envelope');
    const envelopeBody = (await envelope.json()) as {
      detached_signatures: Array<{ signed_at: string }>;
    };
    expect(envelopeBody).toMatchObject({
      detached_signatures: [
        {
          key_ref: 'https://github.com/togethercomputer/signet/.github/workflows/release.yaml@refs/tags/v0.1.28',
          algorithm: 'ecdsa-p256-sha256',
          keyless: {
            identity: 'https://github.com/togethercomputer/signet/.github/workflows/release.yaml@refs/tags/v0.1.28',
            issuer: 'https://token.actions.githubusercontent.com',
          },
        },
      ],
    });
    const signedAt = envelopeBody.detached_signatures[0]?.signed_at;

    const verification = await app.request('/v1/skills/kl-prepared/versions/1/verification');
    const verificationBody = (await verification.json()) as {
      all_detached_signatures_verified: boolean;
      verification_status: string;
      signature_checks: Array<{ signature_kind: string; keyless?: { verified: boolean; validity_evaluated_at?: string } }>;
    };
    expect(verificationBody).toMatchObject({
      all_detached_signatures_verified: true,
      verification_status: 'verified',
      signature_checks: [
        {
          signature_kind: 'keyless',
          cryptographic_verification_passed: true,
          keyless: {
            verified: true,
            identity: 'https://github.com/togethercomputer/signet/.github/workflows/release.yaml@refs/tags/v0.1.28',
          },
        },
      ],
    });
    // Fulcio certificates live minutes: stored records must be re-verified
    // against the registry-witnessed attach time, not the wall clock.
    expect(verificationBody.signature_checks[0]?.keyless?.validity_evaluated_at).toBe(signedAt);
  });

  it('accepts keyless signatures via the legacy attach endpoint', async () => {
    const { app, token } = await buildTestApp(keylessEnv);
    await createValidatedSkill(app, token, 'kl-legacy');
    const publish = await app.request('/v1/skills/kl-legacy/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'governance-team' }),
    });
    expect(publish.status).toBe(200);

    const envelope = await app.request('/v1/skills/kl-legacy/versions/1/publication-envelope');
    const envelopeBody = (await envelope.json()) as { canonical_json: string };
    const bundle = bundleFor('leaf', Buffer.from(envelopeBody.canonical_json, 'utf8'));

    const attach = await app.request('/v1/skills/kl-legacy/versions/1/signatures', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ signer: 'signet-release-workflow', keyless_bundle: bundle }),
    });
    if (attach.status !== 200) {
      console.log('DEBUG keyless attach body', JSON.stringify(await attach.clone().json()));
    }
    expect(attach.status).toBe(200);

    const verification = await app.request('/v1/skills/kl-legacy/versions/1/verification');
    await expect(verification.json()).resolves.toMatchObject({
      all_detached_signatures_verified: true,
      verification_status: 'verified',
    });
  });

  it('rejects untrusted, misbound, and misconfigured keyless signatures', async () => {
    const { app, token } = await buildTestApp(keylessEnv);
    await createValidatedSkill(app, token, 'kl-reject');
    const prepare = await app.request('/v1/skills/kl-reject/versions/1/prepare-publication', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'governance-team' }),
    });
    const prepared = (await prepare.json()) as { prepared_publication_urn: string; canonical_json: string };
    const signedBytes = Buffer.from(prepared.canonical_json, 'utf8');
    const attempt = async (bundle: Record<string, unknown>) =>
      await app.request('/v1/skills/kl-reject/versions/1/publish', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          author: 'governance-team',
          prepared_publication_urn: prepared.prepared_publication_urn,
          signatures: [{ signer: 'signet-release-workflow', keyless_bundle: bundle }],
        }),
      });

    const untrusted = await attempt(bundleFor('leaf-other-root', signedBytes));
    expect(untrusted.status).toBe(409);
    await expect(untrusted.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_KEYLESS_SIGNATURE_INVALID' },
    });

    const wrongIssuer = await attempt(bundleFor('leaf-other-issuer', signedBytes));
    expect(wrongIssuer.status).toBe(409);

    const wrongSubject = await attempt(bundleFor('leaf-other-subject', signedBytes));
    expect(wrongSubject.status).toBe(409);

    const tampered = await attempt(bundleFor('leaf', Buffer.from('different payload', 'utf8')));
    expect(tampered.status).toBe(409);
    await expect(tampered.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('digest does not match') },
    });

    const unconfigured = await buildTestApp();
    await createValidatedSkill(unconfigured.app, unconfigured.token, 'kl-unconfigured');
    const prepare2 = await unconfigured.app.request('/v1/skills/kl-unconfigured/versions/1/prepare-publication', {
      method: 'POST',
      headers: authHeaders(unconfigured.token),
      body: JSON.stringify({ author: 'governance-team' }),
    });
    const prepared2 = (await prepare2.json()) as { prepared_publication_urn: string; canonical_json: string };
    const publish2 = await unconfigured.app.request('/v1/skills/kl-unconfigured/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(unconfigured.token),
      body: JSON.stringify({
        author: 'governance-team',
        prepared_publication_urn: prepared2.prepared_publication_urn,
        signatures: [
          { signer: 'signet-release-workflow', keyless_bundle: bundleFor('leaf', Buffer.from(prepared2.canonical_json, 'utf8')) },
        ],
      }),
    });
    expect(publish2.status).toBe(409);
    await expect(publish2.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('not configured') },
    });
  });

  it('satisfies a require_signature policy at certification', async () => {
    const { app, token } = await buildTestApp(keylessEnv);
    const policy = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'registry-policy/v1',
        author: 'governance-team',
        shapes: {
          shapes: [
            {
              id: 'policy/kl-noop',
              target: { entity_type: 'SKILL_VERSION' },
              properties: [{ path: 'description', minCount: 0, maxCount: 1, datatype: 'string', message: 'kl_noop' }],
            },
          ],
          require_signature: true,
        },
      }),
    });
    expect(policy.status).toBe(201);

    // Signed publication certifies.
    await createValidatedSkill(app, token, 'kl-gate-signed');
    const publish = await app.request('/v1/skills/kl-gate-signed/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'governance-team' }),
    });
    expect(publish.status).toBe(200);
    const envelope = await app.request('/v1/skills/kl-gate-signed/versions/1/publication-envelope');
    const envelopeBody = (await envelope.json()) as { canonical_json: string };
    const attach = await app.request('/v1/skills/kl-gate-signed/versions/1/signatures', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        signer: 'signet-release-workflow',
        keyless_bundle: bundleFor('leaf', Buffer.from(envelopeBody.canonical_json, 'utf8')),
      }),
    });
    expect(attach.status).toBe(200);
    const certify = await app.request('/v1/skills/kl-gate-signed/versions/1/certify', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'governance-team' }),
    });
    expect(certify.status).toBe(200);

    // Unsigned publication is refused.
    await createValidatedSkill(app, token, 'kl-gate-unsigned');
    const publishUnsigned = await app.request('/v1/skills/kl-gate-unsigned/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'governance-team' }),
    });
    expect(publishUnsigned.status).toBe(200);
    const certifyUnsigned = await app.request('/v1/skills/kl-gate-unsigned/versions/1/certify', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'governance-team' }),
    });
    expect(certifyUnsigned.status).toBe(409);
    await expect(certifyUnsigned.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_SIGNATURE_REQUIRED' },
    });
  });
});
