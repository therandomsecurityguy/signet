import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

async function buildTestApp(opts?: {
  registryObjectsDir?: string;
  graphBackend?: 'memory' | 'json_file';
  graphStateFile?: string;
}) {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: opts?.graphBackend ?? 'memory',
    ...(opts?.graphStateFile ? { REGISTRY_GRAPH_STATE_FILE: opts.graphStateFile } : {}),
    ...(opts?.registryObjectsDir ? { REGISTRY_OBJECTS_DIR: opts.registryObjectsDir } : {}),
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Test Writer' });
  return { app: buildApp(deps), deps, token };
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
      owner: 'security-team',
      trust_scope: 'registry-publication',
      transparency_log_ref: 'tessera://keys/1',
      inclusion_proof_ref: 'trillian://proofs/key-1',
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
      trust_scope: 'registry-publication',
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

describe('agent routes', () => {
  it('GET /v1/agents returns empty list by default', async () => {
    const { app } = await buildTestApp();
    const res = await app.request('/v1/agents');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ agents: [] });
  });

  it('POST /v1/agents creates an agent and GET returns it', async () => {
    const { app, token } = await buildTestApp();

    const createSkill = await app.request('/v1/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        skill_key: 'skill:repo-move-reference-repair',
        display_name: 'Repo Move',
      }),
    });
    expect(createSkill.status).toBe(201);

    const createSkill2 = await app.request('/v1/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        skill_key: 'skill:local-infra-bootstrap',
        display_name: 'Infra Bootstrap',
      }),
    });
    expect(createSkill2.status).toBe(201);

    const create = await app.request('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        agent_key: 'cursor:cyborg',
        harness_name: 'cursor',
        display_name: 'Cyborg',
        description: 'A bootstrap API-created agent.',
        skill_refs: [
          { skill_key: 'skill:repo-move-reference-repair' },
          { skill_urn: 'urn:sg:skill:skill:local-infra-bootstrap' },
        ],
      }),
    });

    expect(create.status).toBe(201);
    await expect(create.json()).resolves.toMatchObject({
      agent: {
        urn: 'urn:sg:agent:cursor:cyborg',
        properties: {
          agent_key: 'cursor:cyborg',
          harness_name: 'cursor',
          display_name: 'Cyborg',
        },
      },
      skills: [
        {
          skill_urn: 'urn:sg:skill:skill:repo-move-reference-repair',
          skill_key: 'skill:repo-move-reference-repair',
        },
        {
          skill_urn: 'urn:sg:skill:skill:local-infra-bootstrap',
          skill_key: 'skill:local-infra-bootstrap',
        },
      ],
      harnesses: [
        {
          harness_urn: 'urn:sg:harness:cursor',
          harness_name: 'cursor',
        },
      ],
      active_version: {
        agent_version: {
          urn: 'urn:sg:agent-version:cursor:cyborg@v1',
          properties: {
            version: 1,
            publication_status: 'published',
            active: true,
            publisher: 'registry-system',
            policy_version: 'registry-policy/v1',
            validation_status: 'passed',
          },
        },
      },
    });

    const get = await app.request('/v1/agents/cursor:cyborg');
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({
      agent: {
        urn: 'urn:sg:agent:cursor:cyborg',
      },
      active_version: {
        agent_version: {
          urn: 'urn:sg:agent-version:cursor:cyborg@v1',
        },
      },
      skills: [
        {
          skill_urn: 'urn:sg:skill:skill:repo-move-reference-repair',
        },
        {
          skill_urn: 'urn:sg:skill:skill:local-infra-bootstrap',
        },
      ],
      harnesses: [
        {
          harness_urn: 'urn:sg:harness:cursor',
        },
      ],
    });

    const versions = await app.request('/v1/agents/cursor:cyborg/versions');
    expect(versions.status).toBe(200);
    await expect(versions.json()).resolves.toMatchObject({
      versions: [
        {
          agent_version: {
            urn: 'urn:sg:agent-version:cursor:cyborg@v1',
            properties: {
              publication_status: 'published',
            },
          },
        },
      ],
    });

    const active = await app.request('/v1/agents/cursor:cyborg/active');
    expect(active.status).toBe(200);
    await expect(active.json()).resolves.toMatchObject({
      agent_version: {
        urn: 'urn:sg:agent-version:cursor:cyborg@v1',
        properties: {
          active: true,
          publication_status: 'published',
        },
      },
    });

    const envelope = await app.request('/v1/agents/cursor:cyborg/versions/1/publication-envelope');
    expect(envelope.status).toBe(200);
    await expect(envelope.json()).resolves.toMatchObject({
      publication_urn: 'urn:sg:agent-version:cursor:cyborg@v1',
      logical_urn: 'urn:sg:agent:cursor:cyborg',
      entity_type: 'AGENT_VERSION',
      canonical_json_sha256: expect.any(String),
      detached_signatures: [],
      governance_artifacts: expect.arrayContaining([
        expect.objectContaining({ role: 'policy_package' }),
        expect.objectContaining({ role: 'validation_report' }),
      ]),
    });

    const { privateKey } = await registerTrustedEd25519Key(app, token, 'kms://registry/agent-key');
    const { privateKey: checkpointPrivateKey } = await registerTrustedEd25519Key(
      app,
      token,
      'kms://registry/checkpoint-key',
    );
    await createTransparencyLog(app, token, {
      logId: 'trillian-log-agent',
      origin: 'sg-log-agent',
      checkpointKeyRef: 'kms://registry/checkpoint-key',
    });

    const keyGet = await app.request(`/v1/public-keys/${encodeURIComponent('kms://registry/agent-key')}`);
    expect(keyGet.status).toBe(200);
    await expect(keyGet.json()).resolves.toMatchObject({
      public_key: {
        properties: {
          key_ref: 'kms://registry/agent-key',
          algorithm: 'ed25519',
          trust_status: 'trusted',
        },
      },
    });

    const keyList = await app.request('/v1/public-keys');
    expect(keyList.status).toBe(200);
    await expect(keyList.json()).resolves.toMatchObject({
      public_keys: expect.arrayContaining([
        expect.objectContaining({
          key_ref: 'kms://registry/agent-key',
          algorithm: 'ed25519',
        }),
      ]),
    });

    const envelopeBeforeSigning = await app.request('/v1/agents/cursor:cyborg/versions/1/publication-envelope');
    expect(envelopeBeforeSigning.status).toBe(200);
    const envelopeBeforeSigningBody = (await envelopeBeforeSigning.json()) as { canonical_json_sha256: string };
    const detachedSignature = await signPublicationEnvelope(
      app,
      '/v1/agents/cursor:cyborg/versions/1/publication-envelope',
      privateKey,
    );
    const rootHash = `base64:${rfc6962LeafHash(
      transparencyLeafPayload({
        logId: 'trillian-log-agent',
        envelopeSha256: envelopeBeforeSigningBody.canonical_json_sha256,
        signer: 'release-manager',
        keyRef: 'kms://registry/agent-key',
        algorithm: 'ed25519',
        signature: detachedSignature,
      }),
    ).toString('base64')}`;
    const checkpointBody = buildCheckpointBody('sg-log-agent', 1, rootHash);
    const checkpointSignature = `base64:${signBytes(
      null,
      Buffer.from(checkpointBody, 'utf8'),
      checkpointPrivateKey,
    ).toString('base64')}`;

    const signature = await app.request('/v1/agents/cursor:cyborg/versions/1/signatures', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        signer: 'release-manager',
        key_ref: 'kms://registry/agent-key',
        algorithm: 'ed25519',
        signature: detachedSignature,
        transparency_log_ref: 'tessera://log/entry/agent-1',
        inclusion_proof: {
          log_id: 'trillian-log-agent',
          tree_size: 1,
          leaf_index: 0,
          root_hash: rootHash,
          proof_hashes: [],
          checkpoint_body: checkpointBody,
          checkpoint_signature: checkpointSignature,
          transparency_log_ref: 'tessera://log/entry/agent-1',
        },
      }),
    });
    expect(signature.status).toBe(200);
    await expect(signature.json()).resolves.toMatchObject({
      signer: 'release-manager',
      key_ref: 'kms://registry/agent-key',
      algorithm: 'ed25519',
      transparency_log_ref: 'tessera://log/entry/agent-1',
      inclusion_proof_ref: expect.stringMatching(/^urn:sg:artifact:sha256:/),
      envelope_sha256: expect.any(String),
    });

    const verification = await app.request('/v1/agents/cursor:cyborg/versions/1/verification');
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
          key_ref: 'kms://registry/agent-key',
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
        publication_urn: 'urn:sg:agent-version:cursor:cyborg@v1',
        detached_signatures: [
          expect.objectContaining({
            signer: 'release-manager',
            key_ref: 'kms://registry/agent-key',
          }),
        ],
      },
    });
  });

  it('POST /v1/agents is idempotent for the same payload and 409 for conflicting payloads', async () => {
    const { app, token } = await buildTestApp();
    const payload = JSON.stringify({ agent_key: 'cursor:duplicate', display_name: 'Duplicate' });

    const first = await app.request('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: payload,
    });
    expect(first.status).toBe(201);

    const same = await app.request('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: payload,
    });
    expect(same.status).toBe(200);

    const conflict = await app.request('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_key: 'cursor:duplicate', display_name: 'Changed' }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: { code: 'AGENT_CREATE_CONFLICT', message: 'Agent already exists with different state.' },
    });
  });

  it('manages transparency logs and public key lifecycle state', async () => {
    const { app, token } = await buildTestApp();
    const firstKey = generateKeyPairSync('ed25519');
    const secondKey = generateKeyPairSync('ed25519');

    const createFirstKey = await app.request('/v1/public-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        key_ref: 'kms://registry/checkpoint-key-v1',
        algorithm: 'ed25519',
        public_key_pem: firstKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        owner: 'security-team',
      }),
    });
    expect(createFirstKey.status).toBe(201);

    const createLog = await app.request('/v1/transparency-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        log_id: 'sg-registry-log',
        origin: 'sg-registry',
        checkpoint_key_ref: 'kms://registry/checkpoint-key-v1',
        log_type: 'tessera',
      }),
    });
    expect(createLog.status).toBe(201);
    await expect(createLog.json()).resolves.toMatchObject({
      transparency_log: {
        properties: {
          log_id: 'sg-registry-log',
          origin: 'sg-registry',
          checkpoint_key_ref: 'kms://registry/checkpoint-key-v1',
          trust_status: 'trusted',
        },
      },
      checkpoint_key: {
        key_ref: 'kms://registry/checkpoint-key-v1',
      },
    });

    const listLogs = await app.request('/v1/transparency-logs');
    expect(listLogs.status).toBe(200);
    await expect(listLogs.json()).resolves.toMatchObject({
      transparency_logs: expect.arrayContaining([
        expect.objectContaining({
          log_id: 'sg-registry-log',
          checkpoint_key_ref: 'kms://registry/checkpoint-key-v1',
        }),
      ]),
    });

    const createSecondKey = await app.request('/v1/public-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        key_ref: 'kms://registry/checkpoint-key-v2',
        algorithm: 'ed25519',
        public_key_pem: secondKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        owner: 'security-team',
        supersedes_key_ref: 'kms://registry/checkpoint-key-v1',
      }),
    });
    expect(createSecondKey.status).toBe(201);

    const oldKey = await app.request(`/v1/public-keys/${encodeURIComponent('kms://registry/checkpoint-key-v1')}`);
    expect(oldKey.status).toBe(200);
    await expect(oldKey.json()).resolves.toMatchObject({
      public_key: {
        properties: {
          trust_status: 'superseded',
          superseded_by_key_ref: 'kms://registry/checkpoint-key-v2',
        },
      },
    });

    const revokeSecondKey = await app.request(`/v1/public-keys/${encodeURIComponent('kms://registry/checkpoint-key-v2')}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        author: 'security-admin',
        reason: 'rotated again',
      }),
    });
    expect(revokeSecondKey.status).toBe(200);
    await expect(revokeSecondKey.json()).resolves.toMatchObject({
      public_key: {
        properties: {
          trust_status: 'revoked',
          revoked_by: 'security-admin',
          revoked_reason: 'rotated again',
        },
      },
    });
  });

  it('validates bad create payloads', async () => {
    const { app, token } = await buildTestApp();
    const res = await app.request('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_key: '' }),
    });

expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request.' },
    });
  });

  it('POST /v1/agents returns 404 when referenced skills do not exist', async () => {
    const { app, token } = await buildTestApp();
    const res = await app.request('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        agent_key: 'cursor:missing-skill',
        skill_refs: [{ skill_key: 'skill:not-created-yet' }],
      }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'SKILL_NOT_FOUND',
        message: 'Skill not found: skill:not-created-yet',
      },
    });
  });

  it('POST /v1/agents writes attached artifact into CAS and links it', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'agents-api-cas-'));
    try {
      const { app, deps, token } = await buildTestApp({ registryObjectsDir: tmp });
      const create = await app.request('/v1/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          agent_key: 'cursor:file-backed',
          harness_name: 'cursor',
          artifact: {
            content: '# Agent file\n\nhello',
            media_type: 'text/markdown',
            original_path: 'service/mcp/agent/file-backed/cursor/AGENTS.md',
          },
        }),
      });

      expect(create.status).toBe(201);
      const created = (await create.json()) as {
        agent: { urn: string; properties: Record<string, unknown> };
        artifacts: Array<{ artifact_urn: string; sha256: string }>;
      };
      expect(created).toMatchObject({
        agent: {
          urn: 'urn:sg:agent:cursor:file-backed',
          properties: {
            source_path: 'service/mcp/agent/file-backed/cursor/AGENTS.md',
          },
        },
        artifacts: [
          {
            artifact_urn: expect.stringMatching(/^urn:sg:artifact:sha256:/),
            sha256: expect.any(String),
          },
        ],
      });

      const artifact = created.artifacts[0] as { sha256: string };
      const got = await deps.registryCas.getBySha256(artifact.sha256);
      expect(got).not.toBeNull();
      expect(new TextDecoder().decode(got!.bytes)).toBe('# Agent file\n\nhello');

      const get = await app.request('/v1/agents/cursor:file-backed');
      expect(get.status).toBe(200);
      await expect(get.json()).resolves.toMatchObject({
        skills: [],
        artifacts: [
          {
            sha256: artifact.sha256,
          },
        ],
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('agent state and idempotency survive rebuilds with json_file graph backend', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'agents-api-graph-'));
    const graphStateFile = path.join(tmp, 'graph', 'state.json');
    const objectsDir = path.join(tmp, 'objects');

    try {
      const firstApp = await buildTestApp({
        graphBackend: 'json_file',
        graphStateFile,
        registryObjectsDir: objectsDir,
      });

      const createSkill = await firstApp.app.request('/v1/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${firstApp.token}` },
        body: JSON.stringify({
          skill_key: 'skill:persistent',
          display_name: 'Persistent Skill',
        }),
      });
      expect(createSkill.status).toBe(201);

      const createAgent = await firstApp.app.request('/v1/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${firstApp.token}` },
        body: JSON.stringify({
          agent_key: 'cursor:persistent',
          display_name: 'Persistent Agent',
          skill_refs: [{ skill_key: 'skill:persistent' }],
          artifact: {
            content: 'persistent artifact',
            original_path: 'agent/persistent/AGENTS.md',
          },
        }),
      });
      expect(createAgent.status).toBe(201);

      const secondApp = await buildTestApp({
        graphBackend: 'json_file',
        graphStateFile,
        registryObjectsDir: objectsDir,
      });

      const getSkill = await secondApp.app.request('/v1/skills/skill:persistent');
      expect(getSkill.status).toBe(200);

      const getAgent = await secondApp.app.request('/v1/agents/cursor:persistent');
      expect(getAgent.status).toBe(200);
      await expect(getAgent.json()).resolves.toMatchObject({
        agent: {
          urn: 'urn:sg:agent:cursor:persistent',
        },
        skills: [
          {
            skill_urn: 'urn:sg:skill:skill:persistent',
          },
        ],
      });

      const sameCreate = await secondApp.app.request('/v1/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${secondApp.token}` },
        body: JSON.stringify({
          agent_key: 'cursor:persistent',
          display_name: 'Persistent Agent',
          skill_refs: [{ skill_key: 'skill:persistent' }],
          artifact: {
            content: 'persistent artifact',
            original_path: 'agent/persistent/AGENTS.md',
          },
        }),
      });
      expect(sameCreate.status).toBe(200);

      const sameSkillCreate = await secondApp.app.request('/v1/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${secondApp.token}` },
        body: JSON.stringify({
          skill_key: 'skill:persistent',
          display_name: 'Persistent Skill',
        }),
      });
      expect(sameSkillCreate.status).toBe(200);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
