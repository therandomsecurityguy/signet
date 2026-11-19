import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { closeSidecarServers, startNativeSidecar } from './support/native-sidecar.js';

afterEach(async () => {
  await closeSidecarServers();
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
  const { token } = await deps.apiKeys.create({ owner_label: 'Reconciliation Writer' });
  return { app: buildApp(deps), token };
}

type TestAppLike = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

async function publishSkill(app: TestAppLike, token: string, skillKey: string) {
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      author: 'pablo',
      artifact: {
        content: `# ${skillKey}`,
        original_path: `skills/${skillKey.replace(/[^a-z0-9]+/gi, '-')}.md`,
      },
    }),
  });
  expect(draft.status).toBe(200);
  const validate = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ author: 'pablo' }),
  });
  expect(validate.status).toBe(200);
  const publish = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ author: 'pablo' }),
  });
  expect(publish.status).toBe(200);
  return `/v1/skills/${encodeURIComponent(skillKey)}/versions/1`;
}

async function reconcile(app: TestAppLike, token: string, publicationUrn: string) {
  const response = await app.request('/v1/transparency-logs/reconcile', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ publication_urn: publicationUrn }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

describe('transparency reconciliation', () => {
  it('verifies a published skill against the native companion log and stores evidence', async () => {
    const sidecar = await startNativeSidecar();
    const { app, token } = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'signet-governance',
      TESSERA_LOG_PUBLIC_KEY: sidecar.publicKeyPem,
    });

    const versionPath = await publishSkill(app, token, 'skill:reconcile-verified');
    const reconciled = await reconcile(app, token, 'urn:sg:skill-version:skill:reconcile-verified@v1');
    expect(reconciled.status).toBe(200);
    expect(reconciled.body).toMatchObject({
      publication_urn: 'urn:sg:skill-version:skill:reconcile-verified@v1',
      log_id: 'signet-governance',
      status: 'verified',
    });
    const outcomes = reconciled.body['outcomes'] as Array<Record<string, unknown>>;
    expect(outcomes.length).toBeGreaterThanOrEqual(2);
    expect(outcomes.map((outcome) => outcome['source_type'])).toContain('publication_envelope');
    expect(outcomes.map((outcome) => outcome['source_type'])).toContain('governance_event');
    for (const outcome of outcomes) {
      expect(outcome['status']).toBe('verified');
      const checks = outcome['checks'] as Array<{ name: string; ok: boolean }>;
      expect(checks.every((check) => check.ok)).toBe(true);
      expect(checks.map((check) => check.name)).toEqual(
        expect.arrayContaining([
          'record_digest_matches_staged_intent',
          'inclusion_proof_valid',
          'checkpoint_signature_valid',
          'checkpoint_matches_inclusion_root',
        ]),
      );
    }
    expect(reconciled.body['evidence_artifact_urn']).toMatch(/^urn:sg:/);
    expect(reconciled.body['evidence_sha256']).toMatch(/^[0-9a-f]{64}$/);

    // The same publication reconciles against the native log endpoints.
    const firstIndex = outcomes[0]?.['tessera_entry_index'] as number;
    const entry = await fetch(
      `${sidecar.baseUrl}/v1/logs/signet-governance/entries/${firstIndex}`,
    );
    expect(entry.status).toBe(200);
    const entryBody = (await entry.json()) as Record<string, unknown>;
    expect(entryBody['log_id']).toBe('signet-governance');
    expect(typeof (entryBody['checkpoint'] as Record<string, unknown>)['envelope']).toBe('string');

    // Sanity: the version is still readable after reconciliation recorded
    // evidence on it (reconciliation must not disturb the publication).
    const version = await app.request(versionPath);
    expect(version.status).toBe(200);
  });

  it('reconciles against a spec note-mode companion log (Ed25519 note verifier)', async () => {
    const sidecar = await startNativeSidecar({ noteKeyMode: true });
    const { app, token } = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'signet-governance',
      TESSERA_LOG_NOTE_VERIFIER: sidecar.noteVerifierKey,
    });

    await publishSkill(app, token, 'skill:reconcile-note-mode');
    const reconciled = await reconcile(app, token, 'urn:sg:skill-version:skill:reconcile-note-mode@v1');
    expect(reconciled.status).toBe(200);
    expect(reconciled.body).toMatchObject({
      publication_urn: 'urn:sg:skill-version:skill:reconcile-note-mode@v1',
      log_id: 'signet-governance',
      status: 'verified',
    });
    const outcomes = reconciled.body['outcomes'] as Array<Record<string, unknown>>;
    expect(outcomes.length).toBeGreaterThanOrEqual(2);
    for (const outcome of outcomes) {
      expect(outcome['status']).toBe('verified');
      const checks = outcome['checks'] as Array<{ name: string; ok: boolean }>;
      expect(checks.every((check) => check.ok)).toBe(true);
      expect(checks.map((check) => check.name)).toEqual(
        expect.arrayContaining([
          'record_digest_matches_staged_intent',
          'inclusion_proof_valid',
          'checkpoint_signature_valid',
          'checkpoint_matches_inclusion_root',
        ]),
      );
    }

    // The sidecar publishes a real spec note: its envelope verifies against
    // the verifier key the registry was configured with.
    const entry = await fetch(`${sidecar.baseUrl}/v1/logs/signet-governance`);
    expect(entry.status).toBe(200);
    const entryBody = (await entry.json()) as { signer?: string; checkpoint: { envelope: string } };
    expect(entryBody.signer).toBe('note');
    expect(entryBody.checkpoint.envelope).toContain('\u2014 signet-test-log ');
  });

  it('reports not_submitted intents when the sidecar runs staged-only', async () => {
    const sidecar = await startNativeSidecar({ native: false });
    const { app, token } = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'signet-governance',
      TESSERA_LOG_PUBLIC_KEY: sidecar.publicKeyPem,
    });

    await publishSkill(app, token, 'skill:reconcile-staged');
    const reconciled = await reconcile(app, token, 'urn:sg:skill-version:skill:reconcile-staged@v1');
    expect(reconciled.status).toBe(200);
    expect(reconciled.body['status']).toBe('incomplete');
    const outcomes = reconciled.body['outcomes'] as Array<Record<string, unknown>>;
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
    for (const outcome of outcomes) {
      expect(outcome['status']).toBe('not_submitted');
      expect(outcome['checks']).toEqual([]);
    }
  });

  it('reports a mismatch when the registry trusts a different log key', async () => {
    const sidecar = await startNativeSidecar();
    const otherKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const otherPublicKeyPem = otherKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const { app, token } = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'signet-governance',
      TESSERA_LOG_PUBLIC_KEY: otherPublicKeyPem,
    });

    await publishSkill(app, token, 'skill:reconcile-mismatch');
    const reconciled = await reconcile(app, token, 'urn:sg:skill-version:skill:reconcile-mismatch@v1');
    expect(reconciled.status).toBe(200);
    expect(reconciled.body['status']).toBe('mismatch');
    const outcomes = reconciled.body['outcomes'] as Array<Record<string, unknown>>;
    const failing = outcomes.flatMap((outcome) =>
      (outcome['checks'] as Array<{ name: string; ok: boolean }>).filter((check) => !check.ok),
    );
    expect(failing.map((check) => check.name)).toContain('checkpoint_signature_valid');
    // Inclusion against the entry's own root still holds; only the trusted
    // signer binding fails.
    expect(failing.map((check) => check.name)).not.toContain('inclusion_proof_valid');
  });

  it('refuses tampered leaves that point outside the requests prefix', async () => {
    const sidecar = await startNativeSidecar();
    const { app, token } = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'signet-governance',
      TESSERA_LOG_PUBLIC_KEY: sidecar.publicKeyPem,
    });

    const versionPath = await publishSkill(app, token, 'skill:reconcile-tampered');
    const envelopeResponse = await app.request(`${versionPath}/publication-envelope`);
    expect(envelopeResponse.status).toBe(200);
    const envelope = (await envelopeResponse.json()) as {
      transparency_append_intent: { tessera_entry_index: number };
    };
    const referencedIndex = envelope.transparency_append_intent.tessera_entry_index;
    expect(typeof referencedIndex).toBe('number');

    const leafKey = [...sidecar.objects.keys()]
      .filter((key) => key.includes('/signet-governance/leaves/'))
      .find((key) => {
        const leaf = JSON.parse((sidecar.objects.get(key) as Buffer).toString('utf8')) as Record<string, unknown>;
        return leaf['entry_index'] === referencedIndex;
      });
    expect(leafKey).toBeTruthy();
    const leaf = JSON.parse((sidecar.objects.get(leafKey as string) as Buffer).toString('utf8')) as Record<
      string,
      unknown
    >;
    leaf['record_key'] = 'tessera/tiles/test/signet-governance/state.json';
    sidecar.objects.set(leafKey as string, Buffer.from(JSON.stringify(leaf), 'utf8'));

    const reconciled = await reconcile(app, token, 'urn:sg:skill-version:skill:reconcile-tampered@v1');
    expect(reconciled.status).toBe(200);
    expect(reconciled.body['status']).toBe('incomplete');
    const outcomes = reconciled.body['outcomes'] as Array<Record<string, unknown>>;
    expect(outcomes.some((outcome) => outcome['status'] === 'fetch_failed')).toBe(true);
  });

  it('enforces the shared bearer token when configured and carries it end to end', async () => {
    const sidecar = await startNativeSidecar({ authToken: 'e2e-sidecar-token' });

    // Unauthenticated calls to state-changing and log endpoints are rejected;
    // probes/discovery remain open.
    const unauthenticatedAppend = await fetch(`${sidecar.baseUrl}/v1/append-intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        log_id: 'signet-governance',
        source_type: 'publication_envelope',
        source_urn: 'urn:sg:skill-version:skill:ignored@v1',
        digest: 'a'.repeat(64),
        digest_algorithm: 'sha256',
      }),
    });
    expect(unauthenticatedAppend.status).toBe(401);
    const unauthenticatedLogs = await fetch(`${sidecar.baseUrl}/v1/logs`);
    expect(unauthenticatedLogs.status).toBe(401);
    const config = await fetch(`${sidecar.baseUrl}/v1/config`);
    expect(config.status).toBe(200);
    expect(((await config.json()) as Record<string, unknown>)['auth_enabled']).toBe(true);

    const authenticatedLogs = await fetch(`${sidecar.baseUrl}/v1/logs`, {
      headers: { authorization: 'Bearer e2e-sidecar-token' },
    });
    expect(authenticatedLogs.status).toBe(200);

    // The registry presents the same token on append and reconciliation calls.
    const { app, token } = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'signet-governance',
      TESSERA_LOG_PUBLIC_KEY: sidecar.publicKeyPem,
      TESSERA_SIDECAR_AUTH_TOKEN: 'e2e-sidecar-token',
    });
    await publishSkill(app, token, 'skill:reconcile-authed');
    const reconciled = await reconcile(app, token, 'urn:sg:skill-version:skill:reconcile-authed@v1');
    expect(reconciled.status).toBe(200);
    expect(reconciled.body['status']).toBe('verified');

    // A registry without the token cannot stage append intents against an
    // authenticated sidecar: the lifecycle operation fails loudly (the
    // governance-artifact intent attach is not best-effort), so a half
    // configured pair never silently publishes without transparency intent.
    const misconfigured = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'signet-governance',
      TESSERA_LOG_PUBLIC_KEY: sidecar.publicKeyPem,
    });
    const draft = await misconfigured.app.request('/v1/skills/skill%3Areconcile-unauthed/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${misconfigured.token}` },
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# unauthed', original_path: 'skills/unauthed.md' },
      }),
    });
    expect(draft.status).toBe(200);
    const validate = await misconfigured.app.request('/v1/skills/skill%3Areconcile-unauthed/versions/1/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${misconfigured.token}` },
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(validate.status).toBe(500);
  });

  it('fails closed when auth is not configured at all', async () => {
    const sidecar = await startNativeSidecar({ allowUnauthenticated: false });

    const logs = await fetch(`${sidecar.baseUrl}/v1/logs`);
    expect(logs.status).toBe(401);
    const body = (await logs.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: { code: 'SIDECAR_AUTH_NOT_CONFIGURED' } });

    const config = await fetch(`${sidecar.baseUrl}/v1/config`);
    expect(config.status).toBe(200);
    expect(((await config.json()) as Record<string, unknown>)['unauthenticated_allowed']).toBe(false);
  });

  it('returns 409 when reconciliation is not configured and 404 for unknown publications', async () => {
    const { app, token } = await buildTestApp();

    const notConfigured = await reconcile(app, token, 'urn:sg:skill-version:skill:any@v1');
    expect(notConfigured.status).toBe(409);
    expect(notConfigured.body).toMatchObject({
      error: { code: 'TRANSPARENCY_RECONCILIATION_NOT_CONFIGURED' },
    });

    const sidecar = await startNativeSidecar();
    const configured = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'signet-governance',
      TESSERA_LOG_PUBLIC_KEY: sidecar.publicKeyPem,
    });

    const missing = await reconcile(configured.app, configured.token, 'urn:sg:skill-version:skill:missing@v1');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: 'PUBLICATION_NOT_FOUND' } });

    const unsupported = await reconcile(configured.app, configured.token, 'urn:sg:something-else:1');
    expect(unsupported.status).toBe(404);
    expect(unsupported.body).toMatchObject({ error: { code: 'TRANSPARENCY_RECONCILIATION_INVALID' } });
  });
});
