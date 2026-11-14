import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import type { ServerType } from '@hono/node-server';
import { serve } from '@hono/node-server';

import { buildAppDependencies, type AppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import {
  artifactUrn,
  skillUrn,
  skillVersionUrn,
} from '../../../registry/domain/signet/db/graph/freeform/registry/urn.js';

const servers: ServerType[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

type SeededRegistry = {
  cleanArtifactSha: string;
  revokedArtifactSha: string;
  orphanArtifactSha: string;
};

async function seedRegistry(deps: AppDependencies): Promise<SeededRegistry> {
  const graph = deps.registryGraph;

  const cleanVersion = skillVersionUrn('skill:gated-clean', 1);
  await graph.upsertNode({
    urn: skillUrn('skill:gated-clean'),
    entity_type: 'SKILL',
    properties: { skill_key: 'skill:gated-clean', active_version_urn: cleanVersion },
  });
  await graph.upsertNode({
    urn: cleanVersion,
    entity_type: 'SKILL_VERSION',
    properties: {
      skill_key: 'skill:gated-clean',
      version: 1,
      lifecycle_status: 'published',
      active: true,
      publisher: 'gates-e2e',
      policy_version: 'registry-policy/v1',
      validation_status: 'passed',
    },
  });

  const revokedVersion = skillVersionUrn('skill:gated-revoked', 1);
  await graph.upsertNode({
    urn: skillUrn('skill:gated-revoked'),
    entity_type: 'SKILL',
    properties: { skill_key: 'skill:gated-revoked', active_version_urn: revokedVersion },
  });
  await graph.upsertNode({
    urn: revokedVersion,
    entity_type: 'SKILL_VERSION',
    properties: {
      skill_key: 'skill:gated-revoked',
      version: 1,
      lifecycle_status: 'revoked',
      revoked: true,
      publisher: 'gates-e2e',
      policy_version: 'registry-policy/v1',
      validation_status: 'passed',
    },
  });

  // A publication whose only detached signature does not cover the derived
  // envelope: verification reports signature_mismatch.
  const unverifiedVersion = skillVersionUrn('skill:gated-unverified', 1);
  const badSignature = artifactUrn('f'.repeat(64));
  await graph.upsertNode({
    urn: skillUrn('skill:gated-unverified'),
    entity_type: 'SKILL',
    properties: { skill_key: 'skill:gated-unverified', active_version_urn: unverifiedVersion },
  });
  await graph.upsertNode({
    urn: unverifiedVersion,
    entity_type: 'SKILL_VERSION',
    properties: {
      skill_key: 'skill:gated-unverified',
      version: 1,
      lifecycle_status: 'published',
      active: true,
      publisher: 'gates-e2e',
      policy_version: 'registry-policy/v1',
      validation_status: 'passed',
    },
  });
  await graph.upsertNode({
    urn: badSignature,
    entity_type: 'ARTIFACT',
    properties: {
      governance_role: 'detached_signature',
      signer: 'gates-e2e',
      key_ref: 'kms://registry/gates-e2e-key',
      algorithm: 'ed25519',
      signed_at: '2026-01-05T00:00:00.000Z',
      envelope_sha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      signature: 'AAAA',
      signed_payload: 'canonical_json',
      sha256: 'f'.repeat(64),
    },
  });
  await graph.upsertEdge({
    from_urn: unverifiedVersion,
    to_urn: badSignature,
    predicate: 'sg:hasDetachedSignature',
    properties: {},
  });

  const cleanArtifact = await deps.registryCas.put({
    bytes: Buffer.from('verified publication bytes', 'utf8'),
    media_type: 'text/markdown',
  });
  const revokedArtifact = await deps.registryCas.put({
    bytes: Buffer.from('revoked publication bytes', 'utf8'),
    media_type: 'text/markdown',
  });
  const orphanArtifact = await deps.registryCas.put({
    bytes: Buffer.from('orphan artifact bytes', 'utf8'),
    media_type: 'text/markdown',
  });

  for (const artifact of [cleanArtifact, revokedArtifact, orphanArtifact]) {
    await graph.upsertNode({
      urn: artifactUrn(artifact.sha256),
      entity_type: 'ARTIFACT',
      properties: {
        sha256: artifact.sha256,
        size_bytes: artifact.size_bytes,
        media_type: artifact.media_type,
      },
    });
  }
  await graph.upsertEdge({
    from_urn: cleanVersion,
    to_urn: artifactUrn(cleanArtifact.sha256),
    predicate: 'sg:implementedBy',
    properties: {},
  });
  await graph.upsertEdge({
    from_urn: revokedVersion,
    to_urn: artifactUrn(revokedArtifact.sha256),
    predicate: 'sg:implementedBy',
    properties: {},
  });

  return {
    cleanArtifactSha: cleanArtifact.sha256,
    revokedArtifactSha: revokedArtifact.sha256,
    orphanArtifactSha: orphanArtifact.sha256,
  };
}

async function buildGatedApp(overrides: NodeJS.ProcessEnv = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'mcp-read-gate-'));
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: `file:${path.join(tmp, 'mcp.db')}`,
    REGISTRY_OBJECTS_DIR: path.join(tmp, 'objects'),
    ...overrides,
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const seeded = await seedRegistry(deps);
  const { token } = await deps.apiKeys.create({ owner_label: 'Read Gate E2E' });
  const app = buildApp(deps);
  const started = await startServer(app);
  return { ...started, token, seeded, tmp };
}

async function callTool(
  baseUrl: string,
  token: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<{ status: number; body: { result: unknown; error: { code: string } | null } }> {
  const response = await fetch(`${baseUrl}/v1/tools/${tool}:execute`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-agent-client': 'e2e',
    },
    body: JSON.stringify(input),
  });
  return {
    status: response.status,
    body: (await response.json()) as { result: unknown; error: { code: string } | null },
  };
}

describe('MCP registry read gates', () => {
  it('fails closed with ARTIFACT_DIGEST_MISMATCH in enforce mode', async () => {
    const { baseUrl, token, seeded, tmp } = await buildGatedApp({
      REGISTRY_ARTIFACT_INTEGRITY_MODE: 'enforce',
    });
    try {
      const clean = await callTool(baseUrl, token, 'registry.get_artifact', {
        sha256: seeded.cleanArtifactSha,
      });
      expect(clean.status).toBe(200);
      expect(clean.body.error).toBeNull();

      const objectPath = path.join(
        tmp,
        'objects',
        seeded.cleanArtifactSha.slice(0, 2),
        seeded.cleanArtifactSha,
      );
      await writeFile(objectPath, 'tampered bytes');

      const tampered = await callTool(baseUrl, token, 'registry.get_artifact', {
        sha256: seeded.cleanArtifactSha,
      });
      expect(tampered.body.result).toBeNull();
      expect(tampered.body.error?.code).toBe('ARTIFACT_DIGEST_MISMATCH');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('denies revoked reads by default while leaving the verification gate opt-in', async () => {
    const { baseUrl, token, seeded, tmp } = await buildGatedApp();
    try {
      const clean = await callTool(baseUrl, token, 'registry.get_skill', {
        skill_urn: skillUrn('skill:gated-clean'),
      });
      expect(clean.status).toBe(200);
      expect(clean.body.error).toBeNull();

      // Revocation denial is the default posture.
      const revoked = await callTool(baseUrl, token, 'registry.get_skill', {
        skill_urn: skillUrn('skill:gated-revoked'),
      });
      expect(revoked.body.result).toBeNull();
      expect(revoked.body.error?.code).toBe('REGISTRY_READ_DENIED_REVOKED');

      const revokedArtifact = await callTool(baseUrl, token, 'registry.get_artifact', {
        sha256: seeded.revokedArtifactSha,
      });
      expect(revokedArtifact.body.result).toBeNull();
      expect(revokedArtifact.body.error?.code).toBe('REGISTRY_READ_DENIED_REVOKED');

      // The verification gate stays opt-in: unsigned-but-valid content and
      // signature-mismatch content are served unless require_verified is set.
      const unverified = await callTool(baseUrl, token, 'registry.get_skill', {
        skill_urn: skillUrn('skill:gated-unverified'),
      });
      expect(unverified.status).toBe(200);
      expect(unverified.body.error).toBeNull();

      const verification = await callTool(baseUrl, token, 'registry.verify_publication', {
        version_urn: skillVersionUrn('skill:gated-revoked', 1),
      });
      expect(verification.status).toBe(200);
      expect(verification.body.error).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('restores the legacy fail-open behaviour when revocation denial is explicitly disabled', async () => {
    const { baseUrl, token, seeded, tmp } = await buildGatedApp({
      REGISTRY_READ_DENY_REVOKED: 'false',
    });
    try {
      for (const urn of ['skill:gated-clean', 'skill:gated-revoked', 'skill:gated-unverified']) {
        const read = await callTool(baseUrl, token, 'registry.get_skill', {
          skill_urn: skillUrn(urn),
        });
        expect(read.status).toBe(200);
        expect(read.body.error).toBeNull();
      }
      const artifactRead = await callTool(baseUrl, token, 'registry.get_artifact', {
        sha256: seeded.revokedArtifactSha,
      });
      expect(artifactRead.status).toBe(200);
      expect(artifactRead.body.error).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('denies revoked and unverified reads when the gates are on, and never gates verification', async () => {
    const { baseUrl, token, seeded, tmp } = await buildGatedApp({
      REGISTRY_READ_DENY_REVOKED: 'true',
      REGISTRY_READ_REQUIRE_VERIFIED: 'true',
    });
    try {
      const clean = await callTool(baseUrl, token, 'registry.get_skill', {
        skill_urn: skillUrn('skill:gated-clean'),
      });
      expect(clean.status).toBe(200);
      expect(clean.body.error).toBeNull();

      const revoked = await callTool(baseUrl, token, 'registry.get_skill', {
        skill_urn: skillUrn('skill:gated-revoked'),
      });
      expect(revoked.body.result).toBeNull();
      expect(revoked.body.error?.code).toBe('REGISTRY_READ_DENIED_REVOKED');

      const unverified = await callTool(baseUrl, token, 'registry.get_skill', {
        skill_urn: skillUrn('skill:gated-unverified'),
      });
      expect(unverified.body.result).toBeNull();
      expect(unverified.body.error?.code).toBe('REGISTRY_READ_DENIED_UNVERIFIED');

      const revokedArtifact = await callTool(baseUrl, token, 'registry.get_artifact', {
        sha256: seeded.revokedArtifactSha,
      });
      expect(revokedArtifact.body.result).toBeNull();
      expect(revokedArtifact.body.error?.code).toBe('REGISTRY_READ_DENIED_REVOKED');

      const verifiedArtifact = await callTool(baseUrl, token, 'registry.get_artifact', {
        sha256: seeded.cleanArtifactSha,
      });
      expect(verifiedArtifact.status).toBe(200);
      expect(verifiedArtifact.body.error).toBeNull();

      const orphanArtifact = await callTool(baseUrl, token, 'registry.get_artifact', {
        sha256: seeded.orphanArtifactSha,
      });
      expect(orphanArtifact.status).toBe(200);
      expect(orphanArtifact.body.error).toBeNull();

      // Verification itself is never gated: it is how a reader discovers a
      // revoked or unverified publication.
      const verification = await callTool(baseUrl, token, 'registry.verify_publication', {
        version_urn: skillVersionUrn('skill:gated-revoked', 1),
      });
      expect(verification.status).toBe(200);
      expect(verification.body.error).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

async function startServer(app: ReturnType<typeof buildApp>) {
  const port = await getFreePort();
  const server = serve(
    {
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port,
    },
    () => undefined,
  );
  servers.push(server);
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate a port.'));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
