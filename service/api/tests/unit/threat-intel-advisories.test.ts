import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { canonicalJsonString } from '../../../registry/application/services/canonical-json.js';

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
  const { token } = await deps.apiKeys.create({ owner_label: 'Threat Intel Writer' });
  return { app: buildApp(deps), token, deps };
}

type TestAppLike = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
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

// Publishes a skill through the legacy flow and returns the sha256 of its
// content artifact (the version's artifact_sha256).
async function publishSkill(app: TestAppLike, token: string, skillKey: string): Promise<string> {
  const content = `# ${skillKey}\nThreat-intel advisory fixture.\n`;
  const draft = await app.request(`/v1/skills/${skillKey}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'governance-team',
      artifact: { content, original_path: `skills/${skillKey}.md` },
    }),
  });
  expect([200, 201]).toContain(draft.status);
  const validate = await app.request(`/v1/skills/${skillKey}/versions/1/validate`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ author: 'governance-team' }),
  });
  expect(validate.status).toBe(200);
  const publish = await app.request(`/v1/skills/${skillKey}/versions/1/publish`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ author: 'governance-team' }),
  });
  expect(publish.status).toBe(200);
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

type AdvisoryDoc = {
  advisory_id: string;
  source: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  summary: string;
  references?: string[];
  affected: {
    artifact_sha256?: string[];
    skills?: Array<{ skill_key: string; version?: number }>;
    agents?: Array<{ agent_key: string; version?: number }>;
  };
};

function signAdvisory(privateKey: Parameters<typeof signBytes>[2], advisory: AdvisoryDoc): string {
  const bytes = Buffer.from(canonicalJsonString(advisory), 'utf8');
  return `base64:${signBytes(null, bytes, privateKey).toString('base64')}`;
}

async function ingestAdvisory(
  app: TestAppLike,
  token: string,
  input: {
    advisory: AdvisoryDoc;
    signature: string;
    key_ref: string;
    mode?: 'report' | 'enforce';
  },
) {
  return await app.request('/v1/advisories', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      ...(input.mode ? { mode: input.mode } : {}),
      advisory: input.advisory,
      signer: 'security-team',
      key_ref: input.key_ref,
      algorithm: 'ed25519',
      signature: input.signature,
    }),
  });
}

async function getSkillStatus(app: TestAppLike, token: string, skillKey: string) {
  const got = await app.request(`/v1/skills/${skillKey}/versions/1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(got.status).toBe(200);
  const body = (await got.json()) as { skill_version: { properties: Record<string, unknown> } };
  return body.skill_version.properties;
}

describe('threat-intel advisories', () => {
  it('requires write authentication for advisory ingestion', async () => {
    const { app, token } = await buildTestApp();
    const privateKey = await registerEd25519Key(app, token, 'adv://keys/auth-0', 'security-team');
    const advisory: AdvisoryDoc = {
      advisory_id: 'GHSA-test-auth-0000',
      source: 'ghsa',
      severity: 'low',
      summary: 'auth fixture',
      affected: { skills: [{ skill_key: 'adv-auth' }] },
    };

    const unauthenticated = await app.request('/v1/advisories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        advisory,
        signer: 'security-team',
        key_ref: 'adv://keys/auth-0',
        algorithm: 'ed25519',
        signature: signAdvisory(privateKey, advisory),
      }),
    });
    expect(unauthenticated.status).toBe(401);

    // Reads stay public like the rest of the registry surface.
    const list = await app.request('/v1/advisories');
    expect(list.status).toBe(200);
  });

  it('report mode maps affected publications by exact artifact digest without mutating them', async () => {
    const { app, token } = await buildTestApp();
    const artifactSha = await publishSkill(app, token, 'adv-report');
    const privateKey = await registerEd25519Key(app, token, 'adv://keys/team-1', 'security-team');
    const advisory: AdvisoryDoc = {
      advisory_id: 'GHSA-test-0001',
      source: 'ghsa',
      severity: 'high',
      summary: 'remote code execution in the fixture skill',
      references: ['https://example.test/advisories/GHSA-test-0001'],
      affected: { artifact_sha256: [artifactSha] },
    };

    const response = await ingestAdvisory(app, token, {
      advisory,
      signature: signAdvisory(privateKey, advisory),
      key_ref: 'adv://keys/team-1',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { advisory: Record<string, unknown> };
    expect(body.advisory).toMatchObject({
      advisory_id: 'GHSA-test-0001',
      source: 'ghsa',
      severity: 'high',
      mode: 'report',
      signature_valid: true,
      matches: [
        {
          entity_type: 'SKILL_VERSION',
          logical_key: 'adv-report',
          version: 1,
          matched_by: 'artifact_sha256',
          status: 'published',
          outcome: 'reported',
        },
      ],
    });

    const status = await getSkillStatus(app, token, 'adv-report');
    expect(status['lifecycle_status']).toBe('published');
  });

  it('enforce mode revokes revocable matches with actor threat-intel and cites the advisory', async () => {
    const { app, token } = await buildTestApp();
    const artifactSha = await publishSkill(app, token, 'adv-enforce');
    const privateKey = await registerEd25519Key(app, token, 'adv://keys/team-2', 'security-team');
    const advisory: AdvisoryDoc = {
      advisory_id: 'CVE-test-0002',
      source: 'cve',
      severity: 'critical',
      summary: 'critical fixture vulnerability',
      affected: { artifact_sha256: [artifactSha] },
    };

    const response = await ingestAdvisory(app, token, {
      advisory,
      signature: signAdvisory(privateKey, advisory),
      key_ref: 'adv://keys/team-2',
      mode: 'enforce',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { advisory: Record<string, unknown> };
    expect(body.advisory).toMatchObject({
      mode: 'enforce',
      matches: [
        {
          logical_key: 'adv-enforce',
          version: 1,
          matched_by: 'artifact_sha256',
          status: 'revoked',
          outcome: 'revoked',
        },
      ],
    });
    const advisoryUrn = body.advisory['advisory_urn'] as string;

    const status = await getSkillStatus(app, token, 'adv-enforce');
    expect(status['lifecycle_status']).toBe('revoked');
    expect(status['revoked_by']).toBe('threat-intel');
    expect(String(status['revocation_reason'])).toContain('CVE-test-0002');
    expect(status['revocation_advisory_urn']).toBe(advisoryUrn);
  });

  it('matches by identifiers (key with an optional version lock)', async () => {
    const { app, token } = await buildTestApp();
    await publishSkill(app, token, 'adv-ident');
    const privateKey = await registerEd25519Key(app, token, 'adv://keys/team-3', 'security-team');
    const advisory: AdvisoryDoc = {
      advisory_id: 'OSV-test-0003',
      source: 'osv',
      severity: 'moderate',
      summary: 'identifier-matched fixture',
      affected: { skills: [{ skill_key: 'adv-ident', version: 1 }] },
    };

    const response = await ingestAdvisory(app, token, {
      advisory,
      signature: signAdvisory(privateKey, advisory),
      key_ref: 'adv://keys/team-3',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { advisory: { matches: Array<Record<string, unknown>> } };
    expect(body.advisory.matches).toEqual([
      expect.objectContaining({
        logical_key: 'adv-ident',
        version: 1,
        matched_by: 'identifier',
        status: 'published',
        outcome: 'reported',
      }),
    ]);
  });

  it('rejects untrusted keys and signatures that do not verify', async () => {
    const { app, token } = await buildTestApp();
    await publishSkill(app, token, 'adv-reject');
    const registered = await registerEd25519Key(app, token, 'adv://keys/team-4', 'security-team');
    const unregistered = generateKeyPairSync('ed25519').privateKey;
    const advisory: AdvisoryDoc = {
      advisory_id: 'GHSA-test-0004',
      source: 'ghsa',
      severity: 'low',
      summary: 'rejection fixture',
      affected: { skills: [{ skill_key: 'adv-reject' }] },
    };

    const untrusted = await ingestAdvisory(app, token, {
      advisory,
      signature: signAdvisory(registered, advisory),
      key_ref: 'adv://keys/not-registered',
    });
    expect(untrusted.status).toBe(409);
    await expect(untrusted.json()).resolves.toMatchObject({
      error: { code: 'ADVISORY_TRUSTED_KEY_NOT_FOUND' },
    });

    const badSignature = await ingestAdvisory(app, token, {
      advisory,
      signature: signAdvisory(unregistered, advisory),
      key_ref: 'adv://keys/team-4',
    });
    expect(badSignature.status).toBe(409);
    await expect(badSignature.json()).resolves.toMatchObject({
      error: { code: 'ADVISORY_SIGNATURE_INVALID' },
    });
  });

  it('rejects duplicate advisory ids', async () => {
    const { app, token } = await buildTestApp();
    await publishSkill(app, token, 'adv-dup');
    const privateKey = await registerEd25519Key(app, token, 'adv://keys/team-5', 'security-team');
    const advisory: AdvisoryDoc = {
      advisory_id: 'GHSA-test-0005',
      source: 'ghsa',
      severity: 'low',
      summary: 'duplicate fixture',
      affected: { skills: [{ skill_key: 'adv-dup' }] },
    };
    const first = await ingestAdvisory(app, token, {
      advisory,
      signature: signAdvisory(privateKey, advisory),
      key_ref: 'adv://keys/team-5',
    });
    expect(first.status).toBe(200);
    const second = await ingestAdvisory(app, token, {
      advisory,
      signature: signAdvisory(privateKey, advisory),
      key_ref: 'adv://keys/team-5',
    });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: { code: 'ADVISORY_EXISTS' } });
  });

  it('reports already-revoked publications without re-revoking', async () => {
    const { app, token } = await buildTestApp();
    const artifactSha = await publishSkill(app, token, 'adv-revoked');
    const revoke = await app.request('/v1/skills/adv-revoked/versions/1/revoke', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'ops', note: 'manual revoke before advisory' }),
    });
    expect(revoke.status).toBe(200);
    const privateKey = await registerEd25519Key(app, token, 'adv://keys/team-6', 'security-team');
    const advisory: AdvisoryDoc = {
      advisory_id: 'CVE-test-0006',
      source: 'cve',
      severity: 'high',
      summary: 'already revoked fixture',
      affected: { artifact_sha256: [artifactSha] },
    };
    const response = await ingestAdvisory(app, token, {
      advisory,
      signature: signAdvisory(privateKey, advisory),
      key_ref: 'adv://keys/team-6',
      mode: 'enforce',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { advisory: { matches: Array<Record<string, unknown>> } };
    expect(body.advisory.matches).toEqual([
      expect.objectContaining({ outcome: 'already_revoked', status: 'revoked' }),
    ]);
  });

  it('exposes recorded advisories via get and list', async () => {
    const { app, token } = await buildTestApp();
    await publishSkill(app, token, 'adv-get');
    const privateKey = await registerEd25519Key(app, token, 'adv://keys/team-7', 'security-team');
    const advisory: AdvisoryDoc = {
      advisory_id: 'GHSA-test-0007',
      source: 'ghsa',
      severity: 'moderate',
      summary: 'lookup fixture',
      affected: { skills: [{ skill_key: 'adv-get' }] },
    };
    const ingested = await ingestAdvisory(app, token, {
      advisory,
      signature: signAdvisory(privateKey, advisory),
      key_ref: 'adv://keys/team-7',
    });
    expect(ingested.status).toBe(200);

    const got = await app.request('/v1/advisories/GHSA-test-0007', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(got.status).toBe(200);
    await expect(got.json()).resolves.toMatchObject({
      advisory: { advisory_id: 'GHSA-test-0007', matches: [expect.any(Object)] },
    });

    const listed = await app.request('/v1/advisories', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { advisories: Array<{ advisory_id: string }> };
    expect(listedBody.advisories.map((entry) => entry.advisory_id)).toContain('GHSA-test-0007');

    const missing = await app.request('/v1/advisories/GHSA-does-not-exist', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(missing.status).toBe(404);
  });
});
