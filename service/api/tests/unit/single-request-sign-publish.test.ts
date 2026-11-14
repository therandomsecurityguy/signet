import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { createServer } from 'node:net';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { sortGovernanceArtifactRefs } from '../../../registry/application/services/default-registry-service.js';

const sidecarServers: ServerType[] = [];

afterEach(async () => {
  for (const server of sidecarServers.splice(0)) {
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
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function startAppendIntentSidecar() {
  const records: Array<Record<string, unknown>> = [];
  let baseURL = '';
  const app = new Hono();
  const checkpointNote = 'srp-sidecar-checkpoint\n9\nbase64:srp-root\n';
  app.get('/checkpoint', (c) => c.body(checkpointNote, 200, { 'content-type': 'text/plain; charset=utf-8' }));
  app.post('/v1/append-intents', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    records.push(body);
    const requestId = `srp-intent-${records.length}`;
    return c.json(
      {
        ok: true,
        request_id: requestId,
        sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
        tessera_submission_status: 'submitted',
        tessera_entry_index: records.length,
        tessera_add_url: 'http://127.0.0.1:2024/v1/entries',
        tessera_checkpoint_url: `${baseURL}/checkpoint`,
        tessera_checkpoint_tree_size: 9,
        tessera_checkpoint_root_hash: 'base64:srp-root',
        tessera_checkpoint_note_sha256: createHash('sha256').update(checkpointNote, 'utf8').digest('hex'),
        bucket: 'srp-append-intent-bucket',
        key: `append-intents/${requestId}.json`,
        s3_uri: `s3://srp-append-intent-bucket/append-intents/${requestId}.json`,
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
  return { baseUrl: baseURL, records };
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
  const { token } = await deps.apiKeys.create({ owner_label: 'Single Request Writer' });
  return { app: buildApp(deps), token, deps };
}

type TestAppLike = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

async function createValidatedSkill(app: TestAppLike, token: string, skillKey: string) {
  const draft = await app.request(`/v1/skills/${skillKey}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'governance-team',
      artifact: {
        content: `# ${skillKey}\nSingle-request sign-then-publish.\n`,
        original_path: `skills/${skillKey}.md`,
      },
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

async function createValidatedAgent(app: TestAppLike, token: string, agentKey: string) {
  const draft = await app.request(`/v1/agents/${agentKey}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'governance-team',
      artifact: { content: `# ${agentKey}`, original_path: `agents/${agentKey}.md` },
    }),
  });
  expect([200, 201]).toContain(draft.status);
  const validate = await app.request(`/v1/agents/${agentKey}/versions/1/validate`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ author: 'governance-team' }),
  });
  expect(validate.status).toBe(200);
}

async function registerEd25519Key(app: TestAppLike, token: string, keyRef: string, owner: string) {
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

type PreparedBody = {
  prepared_publication_urn: string;
  publication_urn: string;
  canonical_json: string;
  canonical_json_sha256: string;
  expires_at: string;
};

async function prepareSkill(path: string, app: TestAppLike, token: string) {
  const prepare = await app.request(path, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ author: 'governance-team' }),
  });
  expect(prepare.status).toBe(200);
  return (await prepare.json()) as PreparedBody;
}

describe('single-request sign-then-publish', () => {
  it('orders governance artifact refs deterministically regardless of arrival order', () => {
    const refs = [
      { role: 'validation_report' as const, artifact_urn: 'urn:tg:artifact:sha256:bb' },
      { role: 'policy_package' as const, artifact_urn: 'urn:tg:artifact:sha256:zz' },
      { role: 'validation_report' as const, artifact_urn: 'urn:tg:artifact:sha256:aa' },
      { role: 'review_evidence' as const, artifact_urn: 'urn:tg:artifact:sha256:cc' },
    ];
    const expected = [
      'policy_package:zz',
      'validation_report:aa',
      'validation_report:bb',
      'review_evidence:cc',
    ];
    const summarize = (input: typeof refs) =>
      sortGovernanceArtifactRefs(input).map((ref) => `${ref.role}:${ref.artifact_urn.slice(-2)}`);

    expect(summarize(refs)).toEqual(expected);
    expect(summarize([...refs].reverse())).toEqual(expected);
  });

  it('publishes a skill with a prepared envelope and signature in one mutating request', async () => {
    const { app, token } = await buildTestApp();
    await createValidatedSkill(app, token, 'srp-skill');
    const privateKey = await registerEd25519Key(app, token, 'srp://keys/skill-1', 'governance-team');

    const prepared = await prepareSkill('/v1/skills/srp-skill/versions/1/prepare-publication', app, token);
    const signature = `base64:${signBytes(null, Buffer.from(prepared.canonical_json, 'utf8'), privateKey).toString('base64')}`;

    const publish = await app.request('/v1/skills/srp-skill/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'governance-team',
        prepared_publication_urn: prepared.prepared_publication_urn,
        signatures: [
          { signer: 'governance-team', key_ref: 'srp://keys/skill-1', algorithm: 'ed25519', signature },
        ],
      }),
    });
    expect(publish.status).toBe(200);
    await expect(publish.clone().json()).resolves.toMatchObject({
      result: { skill_version: { properties: { lifecycle_status: 'published' } } },
    });

    const envelope = await app.request('/v1/skills/srp-skill/versions/1/publication-envelope');
    expect(envelope.status).toBe(200);
    await expect(envelope.clone().json()).resolves.toMatchObject({
      canonical_json: prepared.canonical_json,
      canonical_json_sha256: prepared.canonical_json_sha256,
      detached_signatures: [{ signer: 'governance-team', key_ref: 'srp://keys/skill-1' }],
    });

    // Governance artifacts must come back in the shared deterministic order:
    // the prepared candidate and the publish-time freeze derive through
    // different graph paths, and an unstable order changes the canonical
    // bytes (observed in prod as SKILL_VERSION_PUBLISH_PREPARED_STALE on a
    // second sequential publication).
    const envelopeBody = (await envelope.json()) as {
      governance_artifacts: Array<{ role: string; artifact_urn: string }>;
    };
    expect(envelopeBody.governance_artifacts).toEqual(
      sortGovernanceArtifactRefs(envelopeBody.governance_artifacts as never),
    );

    const verification = await app.request('/v1/skills/srp-skill/versions/1/verification');
    expect(verification.status).toBe(200);
    await expect(verification.json()).resolves.toMatchObject({
      verification_status: 'verified',
      all_detached_signatures_match_envelope: true,
      all_detached_signatures_verify_cryptographically: true,
      live_envelope_matches_frozen_artifact: true,
    });
  });

  it('rejects signatures at publish without a prepared publication', async () => {
    const { app, token } = await buildTestApp();
    await createValidatedSkill(app, token, 'srp-no-prep');
    const privateKey = await registerEd25519Key(app, token, 'srp://keys/no-prep', 'governance-team');
    const signature = `base64:${signBytes(null, Buffer.from('whatever', 'utf8'), privateKey).toString('base64')}`;

    const publish = await app.request('/v1/skills/srp-no-prep/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'governance-team',
        signatures: [
          { signer: 'governance-team', key_ref: 'srp://keys/no-prep', algorithm: 'ed25519', signature },
        ],
      }),
    });
    expect(publish.status).toBe(409);
    await expect(publish.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_SIGNATURES_REQUIRE_PREPARED' },
    });
  });

  it('fails closed when the prepared envelope is stale', async () => {
    const { app, token } = await buildTestApp();
    await createValidatedSkill(app, token, 'srp-stale');
    const privateKey = await registerEd25519Key(app, token, 'srp://keys/stale', 'governance-team');

    const prepared = await prepareSkill('/v1/skills/srp-stale/versions/1/prepare-publication', app, token);

    // Registering a policy package for the bound policy version changes the
    // governance artifacts the publication will attach, so the pinned
    // candidate no longer matches the state publish would freeze.
    const policy = await app.request('/v1/policy-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        policy_version: 'registry-policy/v1',
        author: 'governance-team',
        shapes: {
          shapes: [
            {
              id: 'policy/srp-stale-noop',
              target: { entity_type: 'SKILL_VERSION' },
              properties: [
                {
                  path: 'description',
                  minCount: 0,
                  maxCount: 1,
                  datatype: 'string',
                  message: 'srp_stale_noop',
                },
              ],
            },
          ],
        },
        description: 'no-op policy registered between prepare and publish',
      }),
    });
    expect(policy.status).toBe(201);

    const signature = `base64:${signBytes(null, Buffer.from(prepared.canonical_json, 'utf8'), privateKey).toString('base64')}`;
    const publish = await app.request('/v1/skills/srp-stale/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'governance-team',
        prepared_publication_urn: prepared.prepared_publication_urn,
        signatures: [
          { signer: 'governance-team', key_ref: 'srp://keys/stale', algorithm: 'ed25519', signature },
        ],
      }),
    });
    expect(publish.status).toBe(409);
    await expect(publish.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_PUBLISH_PREPARED_STALE' },
    });
  });

  it('rejects a signature that does not verify over the prepared envelope', async () => {
    const { app, token } = await buildTestApp();
    await createValidatedSkill(app, token, 'srp-bad-sig');
    const privateKey = await registerEd25519Key(app, token, 'srp://keys/bad-sig', 'governance-team');

    const prepared = await prepareSkill('/v1/skills/srp-bad-sig/versions/1/prepare-publication', app, token);
    const signature = `base64:${signBytes(null, Buffer.from('not the envelope', 'utf8'), privateKey).toString('base64')}`;

    const publish = await app.request('/v1/skills/srp-bad-sig/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'governance-team',
        prepared_publication_urn: prepared.prepared_publication_urn,
        signatures: [
          { signer: 'governance-team', key_ref: 'srp://keys/bad-sig', algorithm: 'ed25519', signature },
        ],
      }),
    });
    expect(publish.status).toBe(409);
    await expect(publish.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_SIGNATURE_INVALID' },
    });
  });

  it('supports the same single-request flow for agents', async () => {
    const { app, token } = await buildTestApp();
    await createValidatedAgent(app, token, 'srp-agent');
    const privateKey = await registerEd25519Key(app, token, 'srp://keys/agent-1', 'governance-team');

    const prepared = await prepareSkill('/v1/agents/srp-agent/versions/1/prepare-publication', app, token);
    const signature = `base64:${signBytes(null, Buffer.from(prepared.canonical_json, 'utf8'), privateKey).toString('base64')}`;

    const publish = await app.request('/v1/agents/srp-agent/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'governance-team',
        prepared_publication_urn: prepared.prepared_publication_urn,
        signatures: [
          { signer: 'governance-team', key_ref: 'srp://keys/agent-1', algorithm: 'ed25519', signature },
        ],
      }),
    });
    expect(publish.status).toBe(200);
    await expect(publish.json()).resolves.toMatchObject({
      result: { agent_version: { properties: { lifecycle_status: 'published' } } },
    });

    const envelope = await app.request('/v1/agents/srp-agent/versions/1/publication-envelope');
    await expect(envelope.json()).resolves.toMatchObject({
      canonical_json: prepared.canonical_json,
      detached_signatures: [{ key_ref: 'srp://keys/agent-1' }],
    });

    const verification = await app.request('/v1/agents/srp-agent/versions/1/verification');
    await expect(verification.json()).resolves.toMatchObject({ verification_status: 'verified' });
  });

  it('keeps the frozen bytes stable with a transparency sidecar configured', async () => {
    const sidecar = await startAppendIntentSidecar();
    const { app, token } = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'srp-sidecar-log',
    });
    await createValidatedSkill(app, token, 'srp-sidecar');
    const privateKey = await registerEd25519Key(app, token, 'srp://keys/sidecar', 'governance-team');

    const prepared = await prepareSkill('/v1/skills/srp-sidecar/versions/1/prepare-publication', app, token);
    const signature = `base64:${signBytes(null, Buffer.from(prepared.canonical_json, 'utf8'), privateKey).toString('base64')}`;

    const publish = await app.request('/v1/skills/srp-sidecar/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'governance-team',
        prepared_publication_urn: prepared.prepared_publication_urn,
        signatures: [
          { signer: 'governance-team', key_ref: 'srp://keys/sidecar', algorithm: 'ed25519', signature },
        ],
      }),
    });
    expect(publish.status).toBe(200);

    const envelope = await app.request('/v1/skills/srp-sidecar/versions/1/publication-envelope');
    await expect(envelope.json()).resolves.toMatchObject({
      canonical_json: prepared.canonical_json,
      canonical_json_sha256: prepared.canonical_json_sha256,
    });

    const verification = await app.request('/v1/skills/srp-sidecar/versions/1/verification');
    await expect(verification.json()).resolves.toMatchObject({ verification_status: 'verified' });

    // The version-level envelope intent was reserved once (at prepare) and
    // reused at publish instead of being published again.
    const envelopeIntents = sidecar.records.filter(
      (record) => record['source_type'] === 'publication_envelope',
    );
    expect(envelopeIntents).toHaveLength(1);
  });
});
