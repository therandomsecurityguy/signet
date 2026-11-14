import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { runCli } from '../src/operator.js';
import { buildAppDependencies as buildApiDependencies } from '../../../service/api/src/app/dependencies.js';
import { buildApp as buildApiApp } from '../../../service/api/src/app/server.js';
import { loadEnv as loadApiEnv } from '../../../service/api/src/infrastructure/config/env.js';

vi.setConfig({ testTimeout: 60_000 });

const servers: ServerType[] = [];
const FIXTURES = path.resolve('tests/fixtures/keyless');

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

type FetchHandler = (request: Request) => Response | Promise<Response>;

async function startServer(fetchHandler: FetchHandler) {
  const port = await getFreePort();
  const server = serve({ fetch: fetchHandler, hostname: '127.0.0.1', port }, () => undefined);
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${port}` };
}

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
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const OIDC_SUBJECT =
  'https://github.com/togethercomputer/cachet/.github/workflows/release.yaml@refs/tags/v9.9.9';

// sigstore validates the identity token client-side (JWT subject claim), so
// the fake OIDC token has the real three-segment shape with a test payload.
function makeOidcJwt(issuer: string, subject: string): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'none', typ: 'JWT' })}.${segment({ iss: issuer, sub: subject })}.${Buffer.from(
    'fake-signature',
  ).toString('base64url')}`;
}

type FakeFulcio = { baseUrl: string; state: { requests: number } };

// A minimal Fulcio that signs the submitted public key with the shared test
// intermediate, deriving the certificate identity from the (test-controlled)
// OIDC token. Mirrors the /api/v2/signingCert contract sigstore-client uses.
async function startFakeFulcio(): Promise<FakeFulcio> {
  const state = { requests: 0 };
  const app = new Hono();
  app.post('/api/v2/signingCert', async (c) => {
    state.requests += 1;
    const body = (await c.req.json()) as {
      credentials?: { oidcIdentityToken?: string };
      publicKeyRequest?: { publicKey?: { content?: string } };
    };
    const token = body.credentials?.oidcIdentityToken ?? '';
    const identity = (() => {
      try {
        const payload = token.split('.')[1] ?? '';
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
          iss?: string;
          sub?: string;
        };
        return { issuer: claims.iss ?? OIDC_ISSUER, subject: claims.sub ?? OIDC_SUBJECT };
      } catch {
        return { issuer: OIDC_ISSUER, subject: OIDC_SUBJECT };
      }
    })();
    const publicKeyPem = body.publicKeyRequest?.publicKey?.content;
    if (!publicKeyPem || !publicKeyPem.includes('BEGIN PUBLIC KEY')) {
      return c.json({ error: 'missing public key' }, 400);
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-fulcio-'));
    try {
      const pubPath = path.join(dir, 'client.pub.pem');
      const keyPath = path.join(dir, 'dummy.key');
      const csrPath = path.join(dir, 'dummy.csr');
      const extPath = path.join(dir, 'ext.cnf');
      const leafPath = path.join(dir, 'leaf.pem');
      await writeFile(pubPath, publicKeyPem);
      execFileSync(
        'openssl',
        ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyPath, '-subj', '/CN=', '-out', csrPath],
        { stdio: 'ignore' },
      );
      const issuerHex = Buffer.from(identity.issuer).toString('hex');
      const san = identity.subject.includes('@') ? `email:${identity.subject}` : `URI:${identity.subject}`;
      await writeFile(
        extPath,
        [
          'basicConstraints=critical,CA:FALSE',
          'keyUsage=critical,digitalSignature',
          `subjectAltName=${san}`,
          `1.3.6.1.4.1.57264.1.1=DER:${issuerHex}`,
          '',
        ].join('\n'),
      );
      execFileSync(
        'openssl',
        ['x509', '-req', '-in', csrPath, '-force_pubkey', pubPath, '-CA', path.join(FIXTURES, 'intermediate.pem'), '-CAkey', path.join(FIXTURES, 'intermediate-key.pem'), '-CAcreateserial', '-days', '1', '-extfile', extPath, '-out', leafPath],
        { stdio: 'ignore' },
      );
      const leafPem = await readFile(leafPath, 'utf8');
      const leafDerBase64 = Buffer.from(
        leafPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''),
        'base64',
      ).toString('base64');
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return c.json(
        { signedCertificateEmbeddedSct: { chain: { certificates: [leafDerBase64] } } },
        201,
      );
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return c.json({ error: err instanceof Error ? err.message : 'signing failed' }, 500);
    }
  });
  const server = await startServer(app.fetch as unknown as FetchHandler);
  return { baseUrl: server.baseUrl, state };
}

async function createValidatedSkill(apiBaseUrl: string, token: string, skillKey: string) {
  const draft = await fetch(`${apiBaseUrl}/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      author: 'ci',
      artifact: { content: `# ${skillKey}\nKeyless CI signing fixture.\n`, original_path: `skills/${skillKey}.md` },
    }),
  });
  expect([200, 201]).toContain(draft.status);
  const validate = await fetch(`${apiBaseUrl}/v1/skills/${encodeURIComponent(skillKey)}/versions/1/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ author: 'ci' }),
  });
  expect(validate.status).toBe(200);
}

async function createValidatedAgent(apiBaseUrl: string, token: string, agentKey: string) {
  const draft = await fetch(`${apiBaseUrl}/v1/agents/${encodeURIComponent(agentKey)}/drafts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      author: 'ci',
      artifact: {
        content: JSON.stringify({ agent_key: agentKey, note: 'keyless ci agent fixture' }),
        media_type: 'application/json',
        original_path: `agents/${agentKey.replaceAll(':', '-')}.json`,
      },
    }),
  });
  expect([200, 201]).toContain(draft.status);
  const validate = await fetch(`${apiBaseUrl}/v1/agents/${encodeURIComponent(agentKey)}/versions/1/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ author: 'ci' }),
  });
  expect(validate.status).toBe(200);
}

describe('registry-operator sign keyless', () => {
  it('signs and publishes an agent through a Fulcio certificate in one request', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-operator-keyless-agent-'));
    const previousEnv = { API_ORIGIN: process.env.API_ORIGIN };
    try {
      const apiEnv = loadApiEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'api_key',
        DATABASE_URL: `file:${path.join(tmp, 'api.db')}`,
        REGISTRY_GRAPH_BACKEND: 'json_file',
        REGISTRY_GRAPH_STATE_FILE: path.join(tmp, 'graph', 'registry-state.json'),
        REGISTRY_OBJECTS_DIR: path.join(tmp, 'objects'),
        TIME_AWARE_GRAPH_BACKEND: 'memory',
        TIME_AWARE_OBJECTS_DIR: path.join(tmp, 'time-aware-objects'),
        KEYLESS_TRUSTED_ROOTS: `${FIXTURES}/intermediate.pem,${FIXTURES}/root.pem`,
        KEYLESS_ALLOWED_ISSUERS: OIDC_ISSUER,
        KEYLESS_ALLOWED_SUBJECTS: '^https://github\\.com/togethercomputer/cachet/',
      });
      const apiDeps = buildApiDependencies(apiEnv);
      await apiDeps.ready();
      const api = buildApiApp(apiDeps);
      const apiServer = await startServer(api.fetch as unknown as FetchHandler);
      process.env.API_ORIGIN = apiServer.baseUrl;
      const { token } = await apiDeps.apiKeys.create({ owner_label: 'keyless-ci-agent' });

      await createValidatedAgent(apiServer.baseUrl, token, 'agent:keyless-ci');
      const fulcio = await startFakeFulcio();
      const oidcToken = makeOidcJwt(OIDC_ISSUER, OIDC_SUBJECT);

      const output: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        output.push(args.map(String).join(' '));
      });
      try {
        await runCli([
          'sign',
          'keyless',
          '--agent',
          'agent:keyless-ci',
          '--version',
          '1',
          '--author',
          'ci',
          '--api-token',
          token,
          '--fulcio-url',
          fulcio.baseUrl,
          '--oidc-token',
          oidcToken,
          '--certify',
        ]);
      } finally {
        logSpy.mockRestore();
      }
      const printed = JSON.parse(output.join('\n')) as {
        agent_key: string;
        identity: string;
        issuer: string;
        published: boolean;
        certified: boolean;
      };
      expect(printed).toMatchObject({
        agent_key: 'agent:keyless-ci',
        identity: OIDC_SUBJECT,
        issuer: OIDC_ISSUER,
        published: true,
        certified: true,
      });

      const verification = await fetch(
        `${apiServer.baseUrl}/v1/agents/${encodeURIComponent('agent:keyless-ci')}/versions/1/verification`,
      );
      const verificationBody = (await verification.json()) as {
        verification_status: string;
        all_detached_signatures_verified: boolean;
        signature_checks: Array<{
          signature_kind: string;
          keyless?: { verified: boolean; identity?: string };
        }>;
      };
      expect(verificationBody).toMatchObject({
        verification_status: 'verified',
        all_detached_signatures_verified: true,
        signature_checks: [
          {
            signature_kind: 'keyless',
            keyless: { verified: true, identity: OIDC_SUBJECT },
          },
        ],
      });
    } finally {
      if (previousEnv.API_ORIGIN === undefined) delete process.env.API_ORIGIN;
      else process.env.API_ORIGIN = previousEnv.API_ORIGIN;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('signs and publishes a skill through a Fulcio certificate in one request', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'registry-operator-keyless-'));
    const previousEnv = { API_ORIGIN: process.env.API_ORIGIN };
    try {
      const apiEnv = loadApiEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        AUTH_MODE: 'api_key',
        DATABASE_URL: `file:${path.join(tmp, 'api.db')}`,
        REGISTRY_GRAPH_BACKEND: 'json_file',
        REGISTRY_GRAPH_STATE_FILE: path.join(tmp, 'graph', 'registry-state.json'),
        REGISTRY_OBJECTS_DIR: path.join(tmp, 'objects'),
        TIME_AWARE_GRAPH_BACKEND: 'memory',
        TIME_AWARE_OBJECTS_DIR: path.join(tmp, 'time-aware-objects'),
        KEYLESS_TRUSTED_ROOTS: `${FIXTURES}/intermediate.pem,${FIXTURES}/root.pem`,
        KEYLESS_ALLOWED_ISSUERS: OIDC_ISSUER,
        KEYLESS_ALLOWED_SUBJECTS: '^https://github\\.com/togethercomputer/cachet/',
      });
      const apiDeps = buildApiDependencies(apiEnv);
      await apiDeps.ready();
      const api = buildApiApp(apiDeps);
      const apiServer = await startServer(api.fetch as unknown as FetchHandler);
      process.env.API_ORIGIN = apiServer.baseUrl;
      const { token } = await apiDeps.apiKeys.create({ owner_label: 'keyless-ci' });

      await createValidatedSkill(apiServer.baseUrl, token, 'skill:keyless-ci');
      const fulcio = await startFakeFulcio();
      const oidcToken = makeOidcJwt(OIDC_ISSUER, OIDC_SUBJECT);

      const output: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        output.push(args.map(String).join(' '));
      });
      try {
        await runCli([
          'sign',
          'keyless',
          '--skill',
          'skill:keyless-ci',
          '--version',
          '1',
          '--author',
          'ci',
          '--api-token',
          token,
          '--fulcio-url',
          fulcio.baseUrl,
          '--oidc-token',
          oidcToken,
          '--certify',
        ]);
      } finally {
        logSpy.mockRestore();
      }
      const printed = JSON.parse(output.join('\n')) as {
        identity: string;
        issuer: string;
        published: boolean;
        certified: boolean;
      };
      expect(printed).toMatchObject({
        identity: OIDC_SUBJECT,
        issuer: OIDC_ISSUER,
        published: true,
        certified: true,
      });
      expect(fulcio.state.requests).toBe(1);

      const verification = await fetch(
        `${apiServer.baseUrl}/v1/skills/${encodeURIComponent('skill:keyless-ci')}/versions/1/verification`,
      );
      const verificationBody = (await verification.json()) as {
        verification_status: string;
        all_detached_signatures_verified: boolean;
        signature_checks: Array<{
          signature_kind: string;
          keyless?: { verified: boolean; identity?: string };
        }>;
      };
      expect(verificationBody).toMatchObject({
        verification_status: 'verified',
        all_detached_signatures_verified: true,
        signature_checks: [
          {
            signature_kind: 'keyless',
            keyless: { verified: true, identity: OIDC_SUBJECT },
          },
        ],
      });

      const version = await fetch(
        `${apiServer.baseUrl}/v1/skills/${encodeURIComponent('skill:keyless-ci')}/versions/1`,
      );
      await expect(version.json()).resolves.toMatchObject({
        skill_version: { properties: { lifecycle_status: 'certified' } },
      });

      // verify publication must accept the keyless signature: the client
      // verdict for keyless records comes from the server trust evaluation
      // (the certificate identity is not a registered trusted key).
      const verifyOutput: string[] = [];
      const verifySpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        verifyOutput.push(args.map(String).join(' '));
      });
      try {
        await runCli([
          'verify',
          'publication',
          '--skill',
          'skill:keyless-ci',
          '--version',
          '1',
          '--api-token',
          token,
          '--strict',
        ]);
      } finally {
        verifySpy.mockRestore();
      }
      const verifyPrinted = JSON.parse(verifyOutput.join('\n')) as {
        verdict: string;
        strict_failures: string[];
        valid_signatures: number;
        server: { verification_status: string };
        client: {
          signatures: Array<{
            signature_kind: string;
            signature_valid: boolean;
            keyless?: { identity?: string; issuer?: string; verified?: boolean };
          }>;
        };
      };
      expect(verifyPrinted).toMatchObject({
        verdict: 'verified',
        strict_failures: [],
        valid_signatures: 1,
        server: { verification_status: 'verified' },
        client: {
          signatures: [
            {
              signature_kind: 'keyless',
              signature_valid: true,
              keyless: { identity: OIDC_SUBJECT, issuer: OIDC_ISSUER, verified: true },
            },
          ],
        },
      });
    } finally {
      if (previousEnv.API_ORIGIN === undefined) delete process.env.API_ORIGIN;
      else process.env.API_ORIGIN = previousEnv.API_ORIGIN;
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
