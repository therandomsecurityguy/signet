import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { buildApp as buildSidecarApp } from '../../../tessera-sidecar/src/app.js';
import { loadEnv as loadSidecarEnv } from '../../../tessera-sidecar/src/config/env.js';

const servers: ServerType[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
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
  });
}

type FakeS3Command = {
  constructor: { name: string };
  input: {
    Bucket?: string;
    Key?: string;
    Prefix?: string;
    Delimiter?: string;
    Body?: Buffer | string;
  };
};

function createFakeS3() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async send(command: FakeS3Command): Promise<unknown> {
      const name = command.constructor.name;
      const bucket = command.input.Bucket ?? '';
      if (name === 'HeadBucketCommand') return {};
      if (name === 'PutObjectCommand') {
        const body = command.input.Body;
        objects.set(
          `${bucket}/${command.input.Key ?? ''}`,
          Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8'),
        );
        return {};
      }
      if (name === 'GetObjectCommand') {
        const key = `${bucket}/${command.input.Key ?? ''}`;
        const body = objects.get(key);
        if (!body) {
          const err = new Error('The specified key does not exist.') as Error & { name: string };
          err.name = 'NoSuchKey';
          throw err;
        }
        return { Body: body };
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = `${bucket}/${command.input.Prefix ?? ''}`;
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
        if (command.input.Delimiter) {
          const commonPrefixes = new Set(
            keys.map((key) => {
              const rest = key.slice(prefix.length);
              const separator = rest.indexOf(command.input.Delimiter as string);
              return separator === -1 ? rest : rest.slice(0, separator + 1);
            }),
          );
          return {
            CommonPrefixes: [...commonPrefixes].map((value) => ({
              Prefix: `${command.input.Prefix ?? ''}${value}`,
            })),
          };
        }
        return { Contents: keys.map((key) => ({ Key: key.slice(bucket.length + 1) })) };
      }
      throw new Error(`fake S3 does not implement ${name}`);
    },
  };
}

async function startNativeSidecar(input?: {
  native?: boolean;
  authToken?: string;
  allowUnauthenticated?: boolean;
}) {
  const native = input?.native ?? true;
  // Dev-equivalent default for tests that do not exercise auth: explicit
  // opt-out, matching local development without a token.
  const allowUnauthenticated = input?.allowUnauthenticated ?? !input?.authToken;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fakeS3 = createFakeS3();
  const env = loadSidecarEnv({
    TESSERA_SIDECAR_BUCKET: 'transparency-test-bucket',
    TESSERA_SIDECAR_TILES_PREFIX: 'tessera/tiles/test',
    TESSERA_SIDECAR_REQUESTS_PREFIX: 'tessera/requests/test',
    ...(native ? { TESSERA_LOG_PRIVATE_KEY: privateKeyPem, TESSERA_LOG_ORIGIN: 'cachet-test-log' } : {}),
    ...(input?.authToken ? { TESSERA_SIDECAR_AUTH_TOKEN: input.authToken } : {}),
    ...(allowUnauthenticated ? { TESSERA_SIDECAR_ALLOW_UNAUTHENTICATED: 'true' } : {}),
  });
  const app = buildSidecarApp(env, { s3: fakeS3 });
  const port = await getFreePort();
  const server = await new Promise<ServerType>((resolve) => {
    const started = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => resolve(started));
  });
  servers.push(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    publicKeyPem,
    objects: fakeS3.objects,
  };
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
      TRANSPARENCY_APPEND_LOG_ID: 'cachet-governance',
      TESSERA_LOG_PUBLIC_KEY: sidecar.publicKeyPem,
    });

    const versionPath = await publishSkill(app, token, 'skill:reconcile-verified');
    const reconciled = await reconcile(app, token, 'urn:tg:skill-version:skill:reconcile-verified@v1');
    expect(reconciled.status).toBe(200);
    expect(reconciled.body).toMatchObject({
      publication_urn: 'urn:tg:skill-version:skill:reconcile-verified@v1',
      log_id: 'cachet-governance',
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
    expect(reconciled.body['evidence_artifact_urn']).toMatch(/^urn:tg:/);
    expect(reconciled.body['evidence_sha256']).toMatch(/^[0-9a-f]{64}$/);

    // The same publication reconciles against the native log endpoints.
    const firstIndex = outcomes[0]?.['tessera_entry_index'] as number;
    const entry = await fetch(
      `${sidecar.baseUrl}/v1/logs/cachet-governance/entries/${firstIndex}`,
    );
    expect(entry.status).toBe(200);
    const entryBody = (await entry.json()) as Record<string, unknown>;
    expect(entryBody['log_id']).toBe('cachet-governance');
    expect(typeof (entryBody['checkpoint'] as Record<string, unknown>)['envelope']).toBe('string');

    // Sanity: the version is still readable after reconciliation recorded
    // evidence on it (reconciliation must not disturb the publication).
    const version = await app.request(versionPath);
    expect(version.status).toBe(200);
  });

  it('reports not_submitted intents when the sidecar runs staged-only', async () => {
    const sidecar = await startNativeSidecar({ native: false });
    const { app, token } = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'cachet-governance',
      TESSERA_LOG_PUBLIC_KEY: sidecar.publicKeyPem,
    });

    await publishSkill(app, token, 'skill:reconcile-staged');
    const reconciled = await reconcile(app, token, 'urn:tg:skill-version:skill:reconcile-staged@v1');
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
      TRANSPARENCY_APPEND_LOG_ID: 'cachet-governance',
      TESSERA_LOG_PUBLIC_KEY: otherPublicKeyPem,
    });

    await publishSkill(app, token, 'skill:reconcile-mismatch');
    const reconciled = await reconcile(app, token, 'urn:tg:skill-version:skill:reconcile-mismatch@v1');
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
      TRANSPARENCY_APPEND_LOG_ID: 'cachet-governance',
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
      .filter((key) => key.includes('/cachet-governance/leaves/'))
      .find((key) => {
        const leaf = JSON.parse((sidecar.objects.get(key) as Buffer).toString('utf8')) as Record<string, unknown>;
        return leaf['entry_index'] === referencedIndex;
      });
    expect(leafKey).toBeTruthy();
    const leaf = JSON.parse((sidecar.objects.get(leafKey as string) as Buffer).toString('utf8')) as Record<
      string,
      unknown
    >;
    leaf['record_key'] = 'tessera/tiles/test/cachet-governance/state.json';
    sidecar.objects.set(leafKey as string, Buffer.from(JSON.stringify(leaf), 'utf8'));

    const reconciled = await reconcile(app, token, 'urn:tg:skill-version:skill:reconcile-tampered@v1');
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
        log_id: 'cachet-governance',
        source_type: 'publication_envelope',
        source_urn: 'urn:tg:skill-version:skill:ignored@v1',
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
      TRANSPARENCY_APPEND_LOG_ID: 'cachet-governance',
      TESSERA_LOG_PUBLIC_KEY: sidecar.publicKeyPem,
      TESSERA_SIDECAR_AUTH_TOKEN: 'e2e-sidecar-token',
    });
    await publishSkill(app, token, 'skill:reconcile-authed');
    const reconciled = await reconcile(app, token, 'urn:tg:skill-version:skill:reconcile-authed@v1');
    expect(reconciled.status).toBe(200);
    expect(reconciled.body['status']).toBe('verified');

    // A registry without the token cannot stage append intents against an
    // authenticated sidecar: the lifecycle operation fails loudly (the
    // governance-artifact intent attach is not best-effort), so a half
    // configured pair never silently publishes without transparency intent.
    const misconfigured = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'cachet-governance',
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

    const notConfigured = await reconcile(app, token, 'urn:tg:skill-version:skill:any@v1');
    expect(notConfigured.status).toBe(409);
    expect(notConfigured.body).toMatchObject({
      error: { code: 'TRANSPARENCY_RECONCILIATION_NOT_CONFIGURED' },
    });

    const sidecar = await startNativeSidecar();
    const configured = await buildTestApp({
      TESSERA_SIDECAR_URL: sidecar.baseUrl,
      TRANSPARENCY_APPEND_LOG_ID: 'cachet-governance',
      TESSERA_LOG_PUBLIC_KEY: sidecar.publicKeyPem,
    });

    const missing = await reconcile(configured.app, configured.token, 'urn:tg:skill-version:skill:missing@v1');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: 'PUBLICATION_NOT_FOUND' } });

    const unsupported = await reconcile(configured.app, configured.token, 'urn:tg:something-else:1');
    expect(unsupported.status).toBe(404);
    expect(unsupported.body).toMatchObject({ error: { code: 'TRANSPARENCY_RECONCILIATION_INVALID' } });
  });
});
