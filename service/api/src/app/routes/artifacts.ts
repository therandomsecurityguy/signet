import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';

import { RegistryCoreError } from '../../../../registry/application/errors/registry-core-error.js';
import type { RegistryService } from '../../../../registry/application/ports/registry-service.js';
import { ErrorResponseSchema } from '../../contracts/error.js';
import type { AppEnv } from '../server.js';

const ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/;

const artifactParamsSchema = z.object({
  sha256: z.string().regex(ARTIFACT_SHA256_PATTERN).openapi({
    example: 'f5335ed75c09e3ffdbd28f8414bfb8dc8bc3e89d87b9b83753e7c8c3327e1c06',
  }),
});

const getArtifactRoute = createRoute({
  method: 'get',
  path: '/v1/artifacts/{sha256}',
  request: { params: artifactParamsSchema },
  responses: {
    200: {
      content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
      description: 'Artifact bytes (content-addressed; see Content-Digest header)',
    },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid artifact digest' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Artifact not found' },
    409: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Artifact failed its digest verification and is not served',
    },
    500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Internal error' },
  },
});

const getArtifactRetentionRoute = createRoute({
  method: 'get',
  path: '/v1/artifacts/{sha256}/retention',
  request: { params: artifactParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: z.any() } },
      description: 'Immutability report (S3 Object Lock retention) for the artifact',
    },
    400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Invalid artifact digest' },
    404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'Artifact not found' },
  },
});

export function registerArtifactRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: {
    registry: RegistryService;
  },
) {
  app.openapi(getArtifactRoute, async (c) => {
    const sha256 = c.req.param('sha256').toLowerCase();
    if (!ARTIFACT_SHA256_PATTERN.test(sha256)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid artifact digest.' } }, 400);
    }

    const artifact = await loadVerifiedArtifact(c, deps, sha256);
    if (!('bytes' in artifact)) {
      return artifact.response;
    }

    c.header('content-type', artifact.media_type ?? 'application/octet-stream');
    c.header('content-digest', contentDigestHeader(sha256));
    c.header('x-artifact-digest-verified', 'true');
    c.header('content-length', String(artifact.bytes.byteLength));
    return c.body(new Uint8Array(artifact.bytes), 200);
  });
  // HEAD is served by Hono's automatic GET dispatch, which reuses these
  // headers (including Content-Length) with a null body.

  app.openapi(getArtifactRetentionRoute, async (c) => {
    const sha256 = c.req.param('sha256').toLowerCase();
    if (!ARTIFACT_SHA256_PATTERN.test(sha256)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid artifact digest.' } }, 400);
    }
    const retention = await deps.registry.getArtifactRetention({ sha256 });
    if (!retention) {
      return c.json({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found.' } }, 404);
    }
    return c.json(retention, 200);
  });
}

type ArtifactLoadResult =
  | { bytes: Uint8Array; media_type?: string }
  | { response: Response };

async function loadVerifiedArtifact(
  c: Context<AppEnv>,
  deps: { registry: RegistryService },
  sha256: string,
): Promise<ArtifactLoadResult> {
  let artifact;
  try {
    artifact = await deps.registry.getArtifactBytes({ sha256 });
  } catch (err) {
    if (err instanceof RegistryCoreError && err.code === 'ARTIFACT_DIGEST_MISMATCH') {
      return {
        response: c.json({ error: { code: err.code, message: 'Artifact failed its digest verification.' } }, 409),
      };
    }
    throw err;
  }

  if (!artifact) {
    return {
      response: c.json({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found.' } }, 404),
    };
  }

  // Never transport bytes that failed their own integrity check, even in
  // warn mode: the download surface is fail-closed by design.
  if (!artifact.digest_verified) {
    return {
      response: c.json(
        { error: { code: 'ARTIFACT_DIGEST_MISMATCH', message: 'Artifact failed its digest verification.' } },
        409,
      ),
    };
  }

  return {
    bytes: artifact.bytes,
    ...(artifact.media_type ? { media_type: artifact.media_type } : {}),
  };
}

function contentDigestHeader(sha256: string): string {
  // RFC 9530 structured field: sha-256=:BASE64:
  return `sha-256=:${Buffer.from(sha256, 'hex').toString('base64')}:`;
}
