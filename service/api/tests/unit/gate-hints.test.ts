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
  const objectsDir = await mkdtemp(path.join(os.tmpdir(), 'signet-gate-hints-'));
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
  const { token } = await deps.apiKeys.create({ owner_label: 'Gate Hint Writer' });
  return { app: buildApp(deps), token };
}

type TestAppLike = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type GateHintsBody = {
  publication_urn: string;
  policy_version: string | null;
  gates: Array<{ gate: string; operation: string; applicable: boolean; satisfied: boolean; reason: string }>;
  would_publish: boolean;
  would_certify: boolean;
};

function hint(body: GateHintsBody, gate: string, operation: string) {
  const found = body.gates.find((entry) => entry.gate === gate && entry.operation === operation);
  if (!found) throw new Error(`Expected a hint for ${gate}/${operation}`);
  return found;
}

async function createPolicy(app: TestAppLike, token: string, policyVersion: string, document: Record<string, unknown>) {
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

async function skillAction(app: TestAppLike, token: string, skillKey: string, action: string) {
  return await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/${action}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ author: 'pablo' }),
  });
}

async function getSkillHints(app: TestAppLike, skillKey: string): Promise<GateHintsBody> {
  const res = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/gate-hints`);
  expect(res.status).toBe(200);
  return (await res.json()) as GateHintsBody;
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

async function attachDetachedSignature(
  app: TestAppLike,
  token: string,
  skillKey: string,
  keyRef: string,
  privateKey: KeyObject,
) {
  const envelope = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/publication-envelope`);
  expect(envelope.status).toBe(200);
  const body = (await envelope.json()) as { canonical_json: string };
  const signature = `base64:${signBytes(null, Buffer.from(body.canonical_json, 'utf8'), privateKey).toString('base64')}`;
  return await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/signatures`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ signer: 'pablo', key_ref: keyRef, algorithm: 'ed25519', signature }),
  });
}

const SHAPES = [{ id: 'policy/hints', target: { entity_type: 'SKILL_VERSION' } }];

describe('publication gate hints', () => {
  it('reports an empty, permissive hint set when no policy is bound', async () => {
    const { app, token } = await buildTestApp();
    await createDraft(app, token, 'skill:hints-nopolicy');

    const body = await getSkillHints(app, 'skill:hints-nopolicy');
    expect(body).toMatchObject({
      publication_urn: 'urn:sg:skill-version:skill:hints-nopolicy@v1',
      policy_version: null,
      gates: [],
      would_publish: true,
      would_certify: true,
    });

    const missing = await app.request('/v1/skills/skill:no-such/versions/1/gate-hints');
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: 'SKILL_VERSION_NOT_FOUND' } });

    const badVersion = await app.request('/v1/skills/skill:hints-nopolicy/versions/0/gate-hints');
    expect(badVersion.status).toBe(400);
  });

  it('explains which publish/certify gates reject a draft, then flips to permissive as the state improves', async () => {
    const { app, token } = await buildTestApp();
    await createPolicy(app, token, 'hint-review/v1', {
      shapes: SHAPES,
      require_human_review: true,
      require_validation: true,
    });
    await createDraft(app, token, 'skill:hints-review', 'hint-review/v1');

    const draftHints = await getSkillHints(app, 'skill:hints-review');
    expect(draftHints.policy_version).toBe('hint-review/v1');
    expect(draftHints.would_publish).toBe(false);
    expect(draftHints.would_certify).toBe(false);

    const validation = hint(draftHints, 'require_validation', 'publish');
    expect(validation.applicable).toBe(true);
    expect(validation.satisfied).toBe(false);
    expect(validation.reason).toContain('draft');

    for (const operation of ['publish', 'certify']) {
      const review = hint(draftHints, 'require_human_review', operation);
      expect(review.applicable).toBe(true);
      expect(review.satisfied).toBe(false);
      expect(review.reason).toContain('unset');
    }

    // Gates the policy does not configure are marked non-applicable and can
    // never influence would_publish / would_certify.
    for (const [gate, operation] of [
      ['require_signature', 'certify'],
      ['require_trusted_publisher', 'certify'],
      ['require_build_provenance', 'certify'],
      ['require_sbom', 'certify'],
    ] as const) {
      const entry = hint(draftHints, gate, operation);
      expect(entry.applicable).toBe(false);
      expect(entry.satisfied).toBe(true);
      expect(entry.reason).toBe('policy does not configure this gate');
    }

    // Validate + approve: both stacked gates become satisfied.
    expect((await skillAction(app, token, 'skill:hints-review', 'validate')).status).toBe(200);
    const approved = await app.request('/v1/skills/skill:hints-review/versions/1/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ decision: 'approve', author: 'dana' }),
    });
    expect(approved.status).toBe(200);

    const improved = await getSkillHints(app, 'skill:hints-review');
    expect(improved.would_publish).toBe(true);
    expect(improved.would_certify).toBe(true);
    expect(hint(improved, 'require_validation', 'publish')).toMatchObject({ satisfied: true });
    expect(hint(improved, 'require_validation', 'publish').reason).toContain('validated');
    expect(hint(improved, 'require_human_review', 'publish')).toMatchObject({ satisfied: true });
    expect(hint(improved, 'require_human_review', 'publish').reason).toContain('approved');
  });

  it('predicts the require_signature certify rejection and agrees after signing', async () => {
    const { app, token } = await buildTestApp();
    await createPolicy(app, token, 'hint-signature/v1', { shapes: SHAPES, require_signature: true });
    await createDraft(app, token, 'skill:hints-signature', 'hint-signature/v1');
    expect((await skillAction(app, token, 'skill:hints-signature', 'validate')).status).toBe(200);
    expect((await skillAction(app, token, 'skill:hints-signature', 'publish')).status).toBe(200);

    // The signature gate is certify-only: publish still clears.
    const beforeSigning = await getSkillHints(app, 'skill:hints-signature');
    expect(beforeSigning.would_publish).toBe(true);
    expect(beforeSigning.would_certify).toBe(false);
    const signature = hint(beforeSigning, 'require_signature', 'certify');
    expect(signature.applicable).toBe(true);
    expect(signature.satisfied).toBe(false);
    expect(signature.reason).toContain('no verified qualified detached signature');

    // Enforcement agrees with the hint: certify is rejected for exactly this gate.
    const blocked = await skillAction(app, token, 'skill:hints-signature', 'certify');
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({ error: { code: 'SKILL_VERSION_SIGNATURE_REQUIRED' } });

    const { privateKey } = await registerTrustedKey(app, token, 'kms://build/hint-key', 'pablo');
    const signed = await attachDetachedSignature(app, token, 'skill:hints-signature', 'kms://build/hint-key', privateKey);
    expect(signed.status).toBe(200);

    const afterSigning = await getSkillHints(app, 'skill:hints-signature');
    expect(afterSigning.would_certify).toBe(true);
    expect(hint(afterSigning, 'require_signature', 'certify')).toMatchObject({ satisfied: true });
    expect(hint(afterSigning, 'require_signature', 'certify').reason).toContain('1 verified qualified signature');

    // Enforcement agrees again: certify now succeeds.
    expect((await skillAction(app, token, 'skill:hints-signature', 'certify')).status).toBe(200);
  });

  it('evaluates evidence gates on unfrozen drafts without throwing', async () => {
    const { app, token } = await buildTestApp();
    await createPolicy(app, token, 'hint-draft-evidence/v1', { shapes: SHAPES, require_signature: true });
    await createDraft(app, token, 'skill:hints-draft-evidence', 'hint-draft-evidence/v1');

    // Drafts have no frozen envelope, but hints are read-only and must serve.
    const body = await getSkillHints(app, 'skill:hints-draft-evidence');
    expect(body.policy_version).toBe('hint-draft-evidence/v1');
    const signature = hint(body, 'require_signature', 'certify');
    expect(signature.applicable).toBe(true);
    expect(signature.satisfied).toBe(false);
    // require_signature binds at certify only: the draft still clears publish gates.
    expect(body.would_publish).toBe(true);
    expect(body.would_certify).toBe(false);
  });

  it('serves agent-version hints through the agent twin', async () => {
    const { app, token } = await buildTestApp();
    await createPolicy(app, token, 'hint-agent/v1', {
      shapes: [{ id: 'policy/agent-hints', target: { entity_type: 'AGENT_VERSION' } }],
      require_human_review: true,
    });

    const createAgent = await app.request('/v1/agents', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        agent_key: 'agent:hints',
        source_path: 'agents/hints.md',
        artifact: { content: '# agent', original_path: 'agents/hints.md' },
        governance: { policy_version: 'hint-agent/v1' },
      }),
    });
    expect(createAgent.status).toBe(201);

    const res = await app.request('/v1/agents/agent:hints/versions/1/gate-hints');
    expect(res.status).toBe(200);
    const body = (await res.json()) as GateHintsBody;
    expect(body.publication_urn).toBe('urn:sg:agent-version:agent:hints@v1');
    expect(body.policy_version).toBe('hint-agent/v1');
    expect(body.would_publish).toBe(false);
    expect(hint(body, 'require_human_review', 'publish')).toMatchObject({ applicable: true, satisfied: false });

    // An agent without a bound policy resolves to permissive hints.
    const plain = await app.request('/v1/agents', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        agent_key: 'agent:hints-none',
        source_path: 'agents/hints-none.md',
        artifact: { content: '# agent', original_path: 'agents/hints-none.md' },
      }),
    });
    expect(plain.status).toBe(201);
    const plainHints = await app.request('/v1/agents/agent:hints-none/versions/1/gate-hints');
    expect(plainHints.status).toBe(200);
    await expect(plainHints.json()).resolves.toMatchObject({ policy_version: null, gates: [], would_certify: true });

    const missing = await app.request('/v1/agents/agent:nope/versions/1/gate-hints');
    expect(missing.status).toBe(404);
  });
});
