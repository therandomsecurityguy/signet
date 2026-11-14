import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { createServer } from 'node:net';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

const sidecarServers: ServerType[] = [];

afterEach(async () => {
  for (const server of sidecarServers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

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
  const { token } = await deps.apiKeys.create({ owner_label: 'Lifecycle Writer' });
  return { app: buildApp(deps), token, deps };
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
      owner: 'governance-team',
      trust_scope: 'skill-publication',
      transparency_log_ref: 'tessera://keys/skill-1',
      inclusion_proof_ref: 'trillian://proofs/skill-key-1',
    }),
  });
  expect(create.status).toBe(201);
  return { privateKey };
}

async function createTransparencyLog(
  app: TestAppLike,
  token: string,
  input: { logId: string; origin: string; checkpointKeyRef: string },
) {
  const create = await app.request('/v1/transparency-logs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      log_id: input.logId,
      origin: input.origin,
      checkpoint_key_ref: input.checkpointKeyRef,
      log_type: 'tessera',
      trust_scope: 'skill-publication',
    }),
  });
  expect(create.status).toBe(201);
}

async function signPublicationEnvelope(
  app: TestAppLike,
  envelopePath: string,
  privateKey: Parameters<typeof signBytes>[2],
) {
  const envelope = await app.request(envelopePath);
  expect(envelope.status).toBe(200);
  const body = (await envelope.json()) as { canonical_json: string };
  return `base64:${signBytes(null, Buffer.from(body.canonical_json, 'utf8'), privateKey).toString('base64')}`;
}

function transparencyLeafPayload(input: {
  logId: string;
  envelopeSha256: string;
  signer: string;
  keyRef: string;
  algorithm: string;
  signature: string;
}) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries({
        log_id: input.logId,
        envelope_sha256: input.envelopeSha256,
        signer: input.signer,
        key_ref: input.keyRef,
        algorithm: input.algorithm,
        signature: input.signature,
      }).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

function rfc6962LeafHash(payload: string) {
  return createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), Buffer.from(payload, 'utf8')])).digest();
}

function buildCheckpointBody(origin: string, treeSize: number, rootHash: string) {
  return `${origin}\n${treeSize}\n${rootHash}\n`;
}

async function startAppendIntentSidecar() {
  const records: Array<Record<string, unknown>> = [];
  let baseURL = '';
  const app = new Hono();
  const checkpointNote = 'registry-sidecar-checkpoint\n7\nbase64:checkpoint-root\n';
  app.get('/checkpoint', (c) => c.body(checkpointNote, 200, { 'content-type': 'text/plain; charset=utf-8' }));
  app.post('/v1/append-intents', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    records.push(body);
    const requestId = `intent-${records.length}`;
    return c.json(
      {
        ok: true,
        request_id: requestId,
        sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
        tessera_submission_status: 'submitted',
        tessera_entry_index: records.length,
        tessera_add_url: 'http://127.0.0.1:2024/v1/entries',
        tessera_checkpoint_url: `${baseURL}/checkpoint`,
        tessera_checkpoint_tree_size: 8,
        tessera_checkpoint_root_hash: 'base64:checkpoint-root',
        tessera_checkpoint_note_sha256: createHash('sha256').update(checkpointNote, 'utf8').digest('hex'),
        bucket: 'append-intent-bucket',
        key: `append-intents/${requestId}.json`,
        s3_uri: `s3://append-intent-bucket/append-intents/${requestId}.json`,
      },
      201,
    );
  });

  const port = await getFreePort();
  const server = await new Promise<ServerType>((resolve) => {
    const started = serve(
      {
        fetch: app.fetch,
        hostname: '127.0.0.1',
        port,
      },
      () => resolve(started),
    );
  });
  sidecarServers.push(server);
  baseURL = `http://127.0.0.1:${port}`;
  return {
    baseUrl: baseURL,
    records,
  };
}

async function createSignedTransparentSkillPublication(
  app: TestAppLike,
  token: string,
  input: {
    skillKey: string;
    artifactContent: string;
    artifactPath: string;
    signer: string;
    signingKeyRef: string;
    checkpointKeyRef: string;
    logId: string;
    logOrigin: string;
  },
) {
  const draft = await app.request(`/v1/skills/${encodeURIComponent(input.skillKey)}/drafts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      author: 'pablo',
      display_name: `Skill for ${input.skillKey}`,
      description: `Consumable markdown skill ${input.skillKey}`,
      artifact: {
        content: input.artifactContent,
        original_path: input.artifactPath,
      },
    }),
  });
  expect(draft.status).toBe(200);

  const publish = await app.request(`/v1/skills/${encodeURIComponent(input.skillKey)}/versions/1/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ author: 'pablo' }),
  });
  expect(publish.status).toBe(200);

  const { privateKey } = await registerTrustedEd25519Key(app, token, input.signingKeyRef);
  const { privateKey: checkpointPrivateKey } = await registerTrustedEd25519Key(app, token, input.checkpointKeyRef);
  await createTransparencyLog(app, token, {
    logId: input.logId,
    origin: input.logOrigin,
    checkpointKeyRef: input.checkpointKeyRef,
  });

  const envelopeBeforeSigning = await app.request(
    `/v1/skills/${encodeURIComponent(input.skillKey)}/versions/1/publication-envelope`,
  );
  expect(envelopeBeforeSigning.status).toBe(200);
  const envelopeBeforeSigningBody = (await envelopeBeforeSigning.json()) as { canonical_json_sha256: string };
  const detachedSignature = await signPublicationEnvelope(
    app,
    `/v1/skills/${encodeURIComponent(input.skillKey)}/versions/1/publication-envelope`,
    privateKey,
  );
  const rootHash = `base64:${rfc6962LeafHash(
    transparencyLeafPayload({
      logId: input.logId,
      envelopeSha256: envelopeBeforeSigningBody.canonical_json_sha256,
      signer: input.signer,
      keyRef: input.signingKeyRef,
      algorithm: 'ed25519',
      signature: detachedSignature,
    }),
  ).toString('base64')}`;
  const checkpointBody = buildCheckpointBody(input.logOrigin, 1, rootHash);
  const checkpointSignature = `base64:${signBytes(
    null,
    Buffer.from(checkpointBody, 'utf8'),
    checkpointPrivateKey,
  ).toString('base64')}`;

  const createSignature = await app.request(`/v1/skills/${encodeURIComponent(input.skillKey)}/versions/1/signatures`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      signer: input.signer,
      key_ref: input.signingKeyRef,
      algorithm: 'ed25519',
      signature: detachedSignature,
      transparency_log_ref: `tessera://log/${input.logId}/entry/1`,
      inclusion_proof: {
        log_id: input.logId,
        tree_size: 1,
        leaf_index: 0,
        root_hash: rootHash,
        proof_hashes: [],
        checkpoint_body: checkpointBody,
        checkpoint_signature: checkpointSignature,
        transparency_log_ref: `tessera://log/${input.logId}/entry/1`,
      },
    }),
  });
  expect(createSignature.status).toBe(200);

  return {
    verificationPath: `/v1/skills/${encodeURIComponent(input.skillKey)}/versions/1/verification`,
    skillPath: `/v1/skills/${encodeURIComponent(input.skillKey)}`,
    versionUrn: `urn:sg:skill-version:${input.skillKey}@v1`,
    signingKeyRef: input.signingKeyRef,
    transparencyLogRef: `tessera://log/${input.logId}/entry/1`,
  };
}

describe('skill lifecycle routes', () => {
  it('creates a draft, idempotently reuses it, validates, publishes, certifies, and resolves active version', async () => {
    const { app, token } = await buildTestApp();

    const draft = await app.request('/v1/skills/skill:lifecycle/drafts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        author: 'pablo',
        commit_sha: 'abc123',
        git_tag: 'v1.0.0-rc1',
        artifact_signature: 'sig-1',
        artifact: {
          content: '# lifecycle draft',
          original_path: 'skills/lifecycle.md',
        },
        lineage: {
          upstream_skill_version_urns: [],
          openlineage: {
            job_namespace: 'sg',
            job_name: 'skill-build',
            run_id: 'run-1',
          },
        },
      }),
    });

    expect(draft.status).toBe(200);
    const draftBody = (await draft.json()) as {
      task: { task: { properties: Record<string, unknown> } };
      result: { skill_version: { urn: string; properties: Record<string, unknown> } };
    };
    expect(draftBody.result.skill_version.properties).toMatchObject({
      skill_key: 'skill:lifecycle',
      version: 1,
      lifecycle_status: 'draft',
      author: 'pablo',
      commit_sha: 'abc123',
      git_tag: 'v1.0.0-rc1',
      artifact_signature: 'sig-1',
    });
    expect(draftBody.task.task.properties['operation']).toBe('create_draft');

    const sameDraft = await app.request('/v1/skills/skill:lifecycle/drafts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        author: 'pablo',
        commit_sha: 'abc123',
        git_tag: 'v1.0.0-rc1',
        artifact_signature: 'sig-1',
        artifact: {
          content: '# lifecycle draft',
          original_path: 'skills/lifecycle.md',
        },
      }),
    });
    expect(sameDraft.status).toBe(200);
    const sameDraftBody = (await sameDraft.json()) as {
      task: { task: { properties: Record<string, unknown> } };
      result: { skill_version: { properties: Record<string, unknown> } };
    };
    expect(sameDraftBody.task.task.properties['status']).toBe('noop');
    expect(sameDraftBody.result.skill_version.properties['version']).toBe(1);

    const validate = await app.request('/v1/skills/skill:lifecycle/versions/1/validate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(validate.status).toBe(200);
    await expect(validate.json()).resolves.toMatchObject({
      result: {
        skill_version: {
          properties: {
            lifecycle_status: 'validated',
          },
        },
      },
    });

    const publish = await app.request('/v1/skills/skill:lifecycle/versions/1/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(publish.status).toBe(200);
    await expect(publish.json()).resolves.toMatchObject({
      result: {
        skill_version: {
          properties: {
            lifecycle_status: 'published',
            active: true,
            publisher: 'pablo',
            policy_version: 'registry-policy/v1',
            validation_status: 'passed',
            validation_report: 'publish-gate:v1 passed',
            canonical_json_sha256: expect.any(String),
          },
        },
        governance_artifacts: expect.arrayContaining([
          expect.objectContaining({ role: 'policy_package' }),
          expect.objectContaining({ role: 'validation_report' }),
        ]),
      },
    });

    const certify = await app.request('/v1/skills/skill:lifecycle/versions/1/certify', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ author: 'principal', note: 'compliance approved' }),
    });
    expect(certify.status).toBe(200);
    await expect(certify.json()).resolves.toMatchObject({
      result: {
        skill_version: {
          properties: {
            certified: true,
            certified_by: 'principal',
            certification_note: 'compliance approved',
            publisher: 'principal',
            policy_version: 'registry-policy/v1',
            validation_status: 'passed',
            validation_report: 'publish-gate:v1 passed',
            canonical_json_sha256: expect.any(String),
          },
        },
        governance_artifacts: expect.arrayContaining([
          expect.objectContaining({ role: 'certification_evidence' }),
        ]),
      },
    });

    const active = await app.request('/v1/skills/skill:lifecycle/active');
    expect(active.status).toBe(200);
    await expect(active.json()).resolves.toMatchObject({
      skill_version: {
        properties: {
          version: 1,
          lifecycle_status: 'certified',
          certified: true,
          active: true,
        },
      },
    });

    const logicalSkill = await app.request('/v1/skills/skill:lifecycle');
    expect(logicalSkill.status).toBe(200);
    await expect(logicalSkill.json()).resolves.toMatchObject({
      skill: {
        urn: 'urn:sg:skill:skill:lifecycle',
        properties: {
          active_version_urn: 'urn:sg:skill-version:skill:lifecycle@v1',
        },
      },
      artifacts: [
        {
          artifact_urn: expect.stringMatching(/^urn:sg:artifact:sha256:/),
          sha256: expect.any(String),
        },
      ],
      active_version: {
        governance_artifacts: expect.arrayContaining([
          expect.objectContaining({ role: 'policy_package' }),
          expect.objectContaining({ role: 'validation_report' }),
          expect.objectContaining({ role: 'certification_evidence' }),
        ]),
      },
    });

    const envelope = await app.request('/v1/skills/skill:lifecycle/versions/1/publication-envelope');
    expect(envelope.status).toBe(200);
    await expect(envelope.json()).resolves.toMatchObject({
      publication_urn: 'urn:sg:skill-version:skill:lifecycle@v1',
      logical_urn: 'urn:sg:skill:skill:lifecycle',
      entity_type: 'SKILL_VERSION',
      canonical_json_sha256: expect.any(String),
      detached_signatures: [],
      governance_artifacts: expect.arrayContaining([
        expect.objectContaining({ role: 'policy_package' }),
        expect.objectContaining({ role: 'validation_report' }),
      ]),
    });

    const { privateKey } = await registerTrustedEd25519Key(app, token, 'kms://registry/signing-key');
    const { privateKey: checkpointPrivateKey } = await registerTrustedEd25519Key(
      app,
      token,
      'kms://registry/checkpoint-skill-key',
    );
    await createTransparencyLog(app, token, {
      logId: 'trillian-log-skill',
      origin: 'sg-log-skill',
      checkpointKeyRef: 'kms://registry/checkpoint-skill-key',
    });

    const envelopeBeforeSigning = await app.request('/v1/skills/skill:lifecycle/versions/1/publication-envelope');
    expect(envelopeBeforeSigning.status).toBe(200);
    const envelopeBeforeSigningBody = (await envelopeBeforeSigning.json()) as { canonical_json_sha256: string };
    const detachedSignature = await signPublicationEnvelope(
      app,
      '/v1/skills/skill:lifecycle/versions/1/publication-envelope',
      privateKey,
    );
    const rootHash = `base64:${rfc6962LeafHash(
      transparencyLeafPayload({
        logId: 'trillian-log-skill',
        envelopeSha256: envelopeBeforeSigningBody.canonical_json_sha256,
        signer: 'alice',
        keyRef: 'kms://registry/signing-key',
        algorithm: 'ed25519',
        signature: detachedSignature,
      }),
    ).toString('base64')}`;
    const checkpointBody = buildCheckpointBody('sg-log-skill', 1, rootHash);
    const checkpointSignature = `base64:${signBytes(
      null,
      Buffer.from(checkpointBody, 'utf8'),
      checkpointPrivateKey,
    ).toString('base64')}`;

    const createSignature = await app.request('/v1/skills/skill:lifecycle/versions/1/signatures', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        signer: 'alice',
        key_ref: 'kms://registry/signing-key',
        algorithm: 'ed25519',
        signature: detachedSignature,
        transparency_log_ref: 'tessera://log/entry/1',
        inclusion_proof: {
          log_id: 'trillian-log-skill',
          tree_size: 1,
          leaf_index: 0,
          root_hash: rootHash,
          proof_hashes: [],
          checkpoint_body: checkpointBody,
          checkpoint_signature: checkpointSignature,
          transparency_log_ref: 'tessera://log/entry/1',
        },
      }),
    });
    expect(createSignature.status).toBe(200);
    await expect(createSignature.json()).resolves.toMatchObject({
      signer: 'alice',
      key_ref: 'kms://registry/signing-key',
      algorithm: 'ed25519',
      transparency_log_ref: 'tessera://log/entry/1',
      inclusion_proof_ref: expect.stringMatching(/^urn:sg:artifact:sha256:/),
      envelope_sha256: expect.any(String),
    });

    const signedEnvelope = await app.request('/v1/skills/skill:lifecycle/versions/1/publication-envelope');
    expect(signedEnvelope.status).toBe(200);
    await expect(signedEnvelope.json()).resolves.toMatchObject({
      detached_signatures: [
        expect.objectContaining({
          signer: 'alice',
          key_ref: 'kms://registry/signing-key',
          algorithm: 'ed25519',
          inclusion_proof_ref: expect.stringMatching(/^urn:sg:artifact:sha256:/),
        }),
      ],
    });

    const verification = await app.request('/v1/skills/skill:lifecycle/versions/1/verification');
    expect(verification.status).toBe(200);
    await expect(verification.json()).resolves.toMatchObject({
      canonical_json_sha256_matches: true,
      all_detached_signatures_match_envelope: true,
      all_detached_signatures_resolve_trusted_key: true,
      all_detached_signatures_verify_cryptographically: true,
      all_detached_signatures_have_inclusion_proof: true,
      all_detached_signatures_validate_transparency_proof: true,
      transparency_verification_status: 'verified',
      verification_status: 'verified',
      signature_checks: [
        expect.objectContaining({
          key_ref: 'kms://registry/signing-key',
          trusted_public_key_resolved: true,
          cryptographic_verification_passed: true,
          inclusion_proof_present: true,
          transparency_proof_resolved: true,
          transparency_proof_validated: true,
          transparency_verification_status: 'verified',
          verification_status: 'verified',
        }),
      ],
      envelope: {
        publication_urn: 'urn:sg:skill-version:skill:lifecycle@v1',
      },
    });
  });

  it('publishes a second version and promotes it to active', async () => {
    const { app, token } = await buildTestApp();

    const createDraft = async (commit: string) =>
      await app.request('/v1/skills/skill:promotion/drafts', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          author: 'pablo',
          commit_sha: commit,
          artifact: {
            content: `# draft ${commit}`,
            original_path: `skills/promotion-${commit}.md`,
          },
        }),
      });

    expect((await createDraft('one')).status).toBe(200);
    expect(
      (
        await app.request('/v1/skills/skill:promotion/versions/1/publish', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ author: 'pablo' }),
        })
      ).status,
    ).toBe(200);

    expect((await createDraft('two')).status).toBe(200);
    expect(
      (
        await app.request('/v1/skills/skill:promotion/versions/2/validate', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ author: 'pablo' }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request('/v1/skills/skill:promotion/versions/2/publish', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ author: 'pablo' }),
        })
      ).status,
    ).toBe(200);

    const promote = await app.request('/v1/skills/skill:promotion/versions/2/promote', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(promote.status).toBe(200);

    const active = await app.request('/v1/skills/skill:promotion/active');
    expect(active.status).toBe(200);
    await expect(active.json()).resolves.toMatchObject({
      skill_version: {
        properties: {
          version: 2,
          active: true,
        },
      },
    });

    const previous = await app.request('/v1/skills/skill:promotion/versions/1');
    expect(previous.status).toBe(200);
    await expect(previous.json()).resolves.toMatchObject({
      skill_version: {
        properties: {
          publication_status: 'superseded',
          superseded_by_version_urn: 'urn:sg:skill-version:skill:promotion@v2',
          active: false,
        },
      },
    });
  });

  it('shows a happy-path trust story for a markdown skill publication', async () => {
    const { app, token } = await buildTestApp();
    const seeded = await createSignedTransparentSkillPublication(app, token, {
      skillKey: 'skill:trusted-md',
      artifactContent: '# Trusted skill\n\nUse this markdown skill as published.',
      artifactPath: 'skills/trusted-skill.md',
      signer: 'alice',
      signingKeyRef: 'kms://registry/signing-key-trusted-md',
      checkpointKeyRef: 'kms://registry/checkpoint-key-trusted-md',
      logId: 'trillian-log-trusted-md',
      logOrigin: 'sg-log-trusted-md',
    });

    const skill = await app.request(seeded.skillPath);
    expect(skill.status).toBe(200);
    await expect(skill.json()).resolves.toMatchObject({
      active_version: {
        skill_version: {
          properties: {
            publication_status: 'published',
            source_path: 'skills/trusted-skill.md',
          },
        },
        artifacts: [
          expect.objectContaining({
            artifact_urn: expect.stringMatching(/^urn:sg:artifact:sha256:/),
            sha256: expect.any(String),
          }),
        ],
      },
    });

    const verification = await app.request(seeded.verificationPath);
    expect(verification.status).toBe(200);
    await expect(verification.json()).resolves.toMatchObject({
      envelope: {
        detached_signatures: [
          expect.objectContaining({
            signer: 'alice',
            key_ref: seeded.signingKeyRef,
            transparency_log_ref: seeded.transparencyLogRef,
            inclusion_proof_ref: expect.stringMatching(/^urn:sg:artifact:sha256:/),
            signed_at: expect.any(String),
          }),
        ],
      },
      canonical_json_sha256_matches: true,
      all_detached_signatures_match_envelope: true,
      all_detached_signatures_resolve_trusted_key: true,
      all_detached_signatures_verify_cryptographically: true,
      all_detached_signatures_have_inclusion_proof: true,
      all_detached_signatures_validate_transparency_proof: true,
      transparency_verification_status: 'verified',
      verification_status: 'verified',
      signature_checks: [
        expect.objectContaining({
          key_ref: seeded.signingKeyRef,
          trusted_public_key_resolved: true,
          cryptographic_verification_passed: true,
          inclusion_proof_present: true,
          transparency_log_ref: seeded.transparencyLogRef,
          transparency_proof_validated: true,
          transparency_verification_status: 'verified',
          verification_status: 'verified',
        }),
      ],
    });
  });

  it('keeps detached signatures valid against the frozen envelope after post-publish state changes', async () => {
    const { app, token, deps } = await buildTestApp();
    const seeded = await createSignedTransparentSkillPublication(app, token, {
      skillKey: 'skill:tampered-md',
      artifactContent: '# Tamper target\n\nThis markdown skill was originally signed.',
      artifactPath: 'skills/tampered-skill.md',
      signer: 'bob',
      signingKeyRef: 'kms://registry/signing-key-tampered-md',
      checkpointKeyRef: 'kms://registry/checkpoint-key-tampered-md',
      logId: 'trillian-log-tampered-md',
      logOrigin: 'sg-log-tampered-md',
    });

    const before = await app.request(seeded.verificationPath);
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toMatchObject({
      verification_status: 'verified',
      transparency_verification_status: 'verified',
    });

    const versionNode = await deps.graph.getNode(seeded.versionUrn);
    expect(versionNode?.entity_type).toBe('SKILL_VERSION');
    if (!versionNode) {
      throw new Error('Expected skill version node to exist.');
    }
    await deps.graph.upsertNode({
      urn: versionNode.urn,
      entity_type: versionNode.entity_type,
      properties: {
        ...versionNode.properties,
        description: 'Tampered after signing',
        updated_at: '2026-01-04T00:00:00.000Z',
      },
    });

    // Signatures cover the frozen published envelope, so later graph changes
    // no longer invalidate them. The drift is reported explicitly instead:
    // the live derivation no longer matches the frozen artifact.
    const verification = await app.request(seeded.verificationPath);
    expect(verification.status).toBe(200);
    await expect(verification.json()).resolves.toMatchObject({
      envelope: {
        detached_signatures: [
          expect.objectContaining({
            signer: 'bob',
            key_ref: seeded.signingKeyRef,
            transparency_log_ref: seeded.transparencyLogRef,
            inclusion_proof_ref: expect.stringMatching(/^urn:sg:artifact:sha256:/),
            signed_at: expect.any(String),
          }),
        ],
      },
      canonical_json_sha256_matches: true,
      all_detached_signatures_match_envelope: true,
      all_detached_signatures_verify_cryptographically: true,
      all_detached_signatures_validate_transparency_proof: true,
      transparency_verification_status: 'verified',
      verification_status: 'verified',
      publication_envelope_artifact_sha256_matches: true,
      live_envelope_matches_frozen_artifact: false,
      signature_checks: [
        expect.objectContaining({
          key_ref: seeded.signingKeyRef,
          trusted_public_key_resolved: true,
          envelope_sha256_matches: true,
          cryptographic_verification_passed: true,
          transparency_log_ref: seeded.transparencyLogRef,
          transparency_proof_validated: true,
          transparency_verification_status: 'verified',
          verification_status: 'verified',
        }),
      ],
    });
  });

  it('records publication and governance append intents through the sidecar and exposes the returned refs', async () => {
    const sidecar = await startAppendIntentSidecar();
    const { app, token } = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'tessera-sidecar-log',
    });
    const seeded = await createSignedTransparentSkillPublication(app, token, {
      skillKey: 'skill:append-intents',
      artifactContent: '# Append intents\n\nThis skill exercises the sidecar append flow.',
      artifactPath: 'skills/append-intents.md',
      signer: 'carol',
      signingKeyRef: 'kms://registry/signing-key-append-intents',
      checkpointKeyRef: 'kms://registry/checkpoint-key-append-intents',
      logId: 'trillian-log-append-intents',
      logOrigin: 'sg-log-append-intents',
    });

    const certify = await app.request('/v1/skills/skill:append-intents/versions/1/certify', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ author: 'compliance', note: 'certified for append-intent flow' }),
    });
    expect(certify.status).toBe(200);

    expect(sidecar.records).toHaveLength(8);
    expect(sidecar.records.filter((record) => record['source_type'] === 'publication_envelope')).toHaveLength(2);
    // 3 governance-artifact intents (policy package + validation report at
    // publish, certification evidence at certify) plus 3 lifecycle
    // governance-event intents (create_draft, publish, certify).
    expect(sidecar.records.filter((record) => record['source_type'] === 'governance_event')).toHaveLength(6);
    expect(sidecar.records.map((record) => record['log_id'])).toEqual(Array(8).fill('tessera-sidecar-log'));
    const lifecycleEventIntents = sidecar.records.filter(
      (record) => record['source_type'] === 'governance_event' && typeof (record['payload'] as Record<string, unknown> | undefined)?.['event_type'] === 'string',
    );
    expect(lifecycleEventIntents.map((record) => (record['payload'] as Record<string, unknown>)['event_type'])).toEqual([
      'create_draft',
      'publish',
      'certify',
    ]);

    const envelope = await app.request('/v1/skills/skill:append-intents/versions/1/publication-envelope');
    expect(envelope.status).toBe(200);
    await expect(envelope.json()).resolves.toMatchObject({
      transparency_append_intent: {
        log_id: 'tessera-sidecar-log',
        source_type: 'publication_envelope',
        request_id: 'intent-7',
        s3_uri: 's3://append-intent-bucket/append-intents/intent-7.json',
        tessera_submission_status: 'submitted',
        tessera_entry_index: 7,
        tessera_add_url: 'http://127.0.0.1:2024/v1/entries',
        tessera_checkpoint_url: expect.stringMatching(/\/checkpoint$/),
        tessera_checkpoint_tree_size: 8,
        tessera_checkpoint_root_hash: 'base64:checkpoint-root',
        tessera_checkpoint_artifact_urn: expect.stringMatching(/^urn:sg:artifact:sha256:/),
      },
      governance_artifacts: expect.arrayContaining([
        expect.objectContaining({
          role: 'policy_package',
          transparency_append_intent: expect.objectContaining({
            log_id: 'tessera-sidecar-log',
            source_type: 'governance_event',
          }),
        }),
        expect.objectContaining({
          role: 'validation_report',
          transparency_append_intent: expect.objectContaining({
            log_id: 'tessera-sidecar-log',
            source_type: 'governance_event',
          }),
        }),
        expect.objectContaining({
          role: 'certification_evidence',
          transparency_append_intent: expect.objectContaining({
            log_id: 'tessera-sidecar-log',
            source_type: 'governance_event',
          }),
        }),
      ]),
    });

    const verification = await app.request(seeded.verificationPath);
    expect(verification.status).toBe(200);
    await expect(verification.json()).resolves.toMatchObject({
      envelope: {
        transparency_append_intent: {
          log_id: 'tessera-sidecar-log',
          source_type: 'publication_envelope',
          request_id: 'intent-7',
          tessera_submission_status: 'submitted',
          tessera_entry_index: 7,
          tessera_checkpoint_url: expect.stringMatching(/\/checkpoint$/),
          tessera_checkpoint_tree_size: 8,
          tessera_checkpoint_root_hash: 'base64:checkpoint-root',
          tessera_checkpoint_artifact_urn: expect.stringMatching(/^urn:sg:artifact:sha256:/),
        },
      },
      publication_append_intent: {
        request_id: 'intent-7',
        checkpoint_artifact_present: true,
        committed_by_checkpoint: true,
        verification_status: 'committed',
        tessera_checkpoint_tree_size: 8,
        tessera_checkpoint_root_hash: 'base64:checkpoint-root',
      },
      governance_append_intents: expect.arrayContaining([
        expect.objectContaining({
          checkpoint_artifact_present: true,
          verification_status: 'committed',
          committed_by_checkpoint: true,
        }),
      ]),
      append_intent_verification_status: 'committed',
      publication_envelope_artifact_sha256_matches: true,
      live_envelope_matches_frozen_artifact: false,
      verification_status: 'verified',
      transparency_verification_status: 'verified',
    });
  });

  it('revokes a published version and clears the active pointer', async () => {
    const { app, token } = await buildTestApp();

    expect(
      (
        await app.request('/v1/skills/skill:revoke/drafts', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            author: 'pablo',
            artifact: {
              content: '# revoke me',
              original_path: 'skills/revoke.md',
            },
          }),
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await app.request('/v1/skills/skill:revoke/versions/1/publish', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ author: 'pablo' }),
        })
      ).status,
    ).toBe(200);

    const revoke = await app.request('/v1/skills/skill:revoke/versions/1/revoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ author: 'security', note: 'policy violation' }),
    });
    expect(revoke.status).toBe(200);
    await expect(revoke.json()).resolves.toMatchObject({
      result: {
        skill_version: {
          properties: {
            lifecycle_status: 'revoked',
            publication_status: 'revoked',
            revoked: true,
            revoked_by: 'security',
            revocation_reason: 'policy violation',
            active: false,
          },
        },
      },
    });

    const active = await app.request('/v1/skills/skill:revoke/active');
    expect(active.status).toBe(404);
  });
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
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}
