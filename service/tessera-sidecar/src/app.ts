import { randomUUID, createHash, createPrivateKey } from 'node:crypto';

import { HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Hono } from 'hono';
import { z } from 'zod';

import { fetchWithRetry } from './fetch-with-retry.js';
import { buildCheckpointForSigner, keyHintForPrivateKey, parseNoteSignerKey } from './log.js';
import type { CheckpointSigner } from './log.js';
import { NativeLog, type S3Like } from './native-log.js';
import type { Env } from './config/env.js';

const AppendIntentSchema = z.object({
  log_id: z.string().min(1).max(500),
  source_urn: z.string().min(1).max(2000),
  source_type: z.enum(['publication_envelope', 'checkpoint', 'governance_event', 'freeform']),
  digest: z.string().min(1).max(512),
  digest_algorithm: z.string().min(1).max(100).default('sha256'),
  content_type: z.string().min(1).max(200).optional(),
  note: z.string().min(1).max(4000).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const RuntimeAddResponseSchema = z.object({
  ok: z.boolean(),
  index: z.number().int().nonnegative(),
  checkpoint_url: z.string().optional(),
  checkpoint_tree_size: z.number().int().nonnegative().optional(),
  checkpoint_root_hash: z.string().optional(),
  checkpoint_note_sha256: z.string().optional(),
});

export type BuildAppDeps = {
  s3?: S3Like;
};

export function buildApp(env: Env, deps: BuildAppDeps = {}) {
  const app = new Hono();
  const s3: S3Like = deps.s3 ?? buildS3Client(env);
  const nativeLog = new NativeLog(
    s3,
    env.TESSERA_SIDECAR_BUCKET,
    env.TESSERA_SIDECAR_TILES_PREFIX,
    env.TESSERA_SIDECAR_REQUESTS_PREFIX,
  );
  // Native companion log signing. Exactly one mode (enforced by env
  // validation): a legacy PEM key or a spec note key. In note mode the key
  // name is part of the key identity, so it must match the note origin the
  // registry binds checkpoints to.
  const noteSigner = env.TESSERA_LOG_NOTE_KEY ? parseNoteSignerKey(env.TESSERA_LOG_NOTE_KEY) : null;
  if (noteSigner && noteSigner.name !== env.TESSERA_LOG_ORIGIN) {
    throw new Error(
      `TESSERA_LOG_ORIGIN (${env.TESSERA_LOG_ORIGIN}) must equal the note signer key name (${noteSigner.name}); the name is part of the spec key identity.`,
    );
  }
  const checkpointSigner: CheckpointSigner | null = noteSigner
    ? { kind: 'note', noteKey: env.TESSERA_LOG_NOTE_KEY as string }
    : env.TESSERA_LOG_PRIVATE_KEY
      ? { kind: 'pem', privateKeyPem: env.TESSERA_LOG_PRIVATE_KEY }
      : null;
  const keyHintHex = noteSigner
    ? noteSigner.keyHashHex
    : env.TESSERA_LOG_PRIVATE_KEY
      ? keyHintForPrivateKey(createPrivateKey(env.TESSERA_LOG_PRIVATE_KEY)).toString('hex')
      : '';
  const nativeLogNotConfigured = () =>
    ({
      error: {
        code: 'NATIVE_LOG_NOT_CONFIGURED',
        message: 'Configure TESSERA_LOG_PRIVATE_KEY (legacy PEM) or TESSERA_LOG_NOTE_KEY (spec note key) to enable the native log.',
      },
    }) as const;
  const authToken = env.TESSERA_SIDECAR_AUTH_TOKEN;
  const allowUnauthenticated = env.TESSERA_SIDECAR_ALLOW_UNAUTHENTICATED && !authToken;
  // Fail closed: /v1/* requires the shared bearer token. Running without a
  // token requires the explicit local-development opt-out; health, readiness,
  // and the config discovery endpoint stay open for probes and tooling.
  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/config') {
      return await next();
    }
    if (allowUnauthenticated) {
      return await next();
    }
    if (!authToken) {
      return c.json(
        {
          error: {
            code: 'SIDECAR_AUTH_NOT_CONFIGURED',
            message:
              'Sidecar auth is not configured. Set TESSERA_SIDECAR_AUTH_TOKEN (or opt out for local development with TESSERA_SIDECAR_ALLOW_UNAUTHENTICATED=true).',
          },
        },
        401,
      );
    }
    if (c.req.header('Authorization') !== `Bearer ${authToken}`) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid bearer token.' } },
        401,
      );
    }
    return await next();
  });

  app.get('/healthz', (c) => c.json({ ok: true }, 200));

  app.get('/readyz', async (c) => {
    try {
      await s3.send(
        new HeadBucketCommand({
          Bucket: env.TESSERA_SIDECAR_BUCKET,
        }),
      );
      if (env.TESSERA_RUNTIME_ADD_URL) {
        const probe = await fetch(env.TESSERA_RUNTIME_ADD_URL.replace(/\/v1\/entries$/, '/healthz'));
        if (!probe.ok) {
          throw new Error(`Tessera runtime health probe failed (${probe.status})`);
        }
      }
      return c.json({ ok: true }, 200);
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        503,
      );
    }
  });

  app.get('/v1', (c) =>
    c.json({
      service: 'tessera-sidecar',
      purpose: 'Stage registry transparency append intents and companion metadata into S3 prefixes reserved for Tessera-related local and dev/test workflows.',
      capabilities: {
        mode: checkpointSigner ? 's3-companion+native-log' : 's3-companion',
        supports: [
          'health',
          'config-summary',
          'append-intent-staging',
          ...(checkpointSigner
            ? ['native-log-append', 'signed-checkpoints', 'inclusion-proofs', `checkpoint-signer:${checkpointSigner.kind}`]
            : []),
          ...(authToken ? ['bearer-auth'] : []),
        ],
        does_not_yet_support: ['witness-policy-enforcement', 'tile-file-layout'],
      },
    }),
  );

  app.get('/v1/config', (c) =>
    c.json({
      bucket: env.TESSERA_SIDECAR_BUCKET,
      region: env.TESSERA_SIDECAR_REGION,
      tiles_prefix: trimSlashes(env.TESSERA_SIDECAR_TILES_PREFIX),
      requests_prefix: trimSlashes(env.TESSERA_SIDECAR_REQUESTS_PREFIX),
      tessera_runtime_add_url: env.TESSERA_RUNTIME_ADD_URL,
      native_log_enabled: Boolean(checkpointSigner),
      native_log_signer: checkpointSigner ? checkpointSigner.kind : null,
      tessera_log_origin: checkpointSigner ? env.TESSERA_LOG_ORIGIN : null,
      auth_enabled: Boolean(authToken),
      unauthenticated_allowed: allowUnauthenticated,
      using_custom_endpoint: Boolean(env.TESSERA_SIDECAR_AWS_ENDPOINT),
    }),
  );

  app.post('/v1/append-intents', async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = AppendIntentSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid append intent payload.',
          },
        },
        400,
      );
    }

    const requestId = randomUUID();
    const now = new Date().toISOString();
    const record = canonicalJsonString({
      request_id: requestId,
      created_at: now,
      log_id: parsed.data.log_id,
      source_urn: parsed.data.source_urn,
      source_type: parsed.data.source_type,
      digest: parsed.data.digest,
      digest_algorithm: parsed.data.digest_algorithm,
      ...(parsed.data.content_type ? { content_type: parsed.data.content_type } : {}),
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
      ...(parsed.data.payload ? { payload: parsed.data.payload } : {}),
    });
    const sha256 = sha256Hex(Buffer.from(record, 'utf8'));
    const key = [
      trimSlashes(env.TESSERA_SIDECAR_REQUESTS_PREFIX),
      sanitizePathSegment(parsed.data.log_id),
      `${now.slice(0, 10)}-${requestId}.json`,
    ].join('/');

    await s3.send(
      new PutObjectCommand({
        Bucket: env.TESSERA_SIDECAR_BUCKET,
        Key: key,
        Body: Buffer.from(record, 'utf8'),
        ContentType: 'application/json',
        Metadata: {
          request_id: requestId,
          sha256,
          log_id: parsed.data.log_id,
          source_type: parsed.data.source_type,
        },
      }),
    );

    const runtimeResult = env.TESSERA_RUNTIME_ADD_URL
      ? await submitToTesseraRuntime({
          addUrl: env.TESSERA_RUNTIME_ADD_URL,
          key,
          record,
          source_type: parsed.data.source_type,
          source_urn: parsed.data.source_urn,
        })
      : checkpointSigner
        ? await appendToNativeLog({
            nativeLog,
            checkpointSigner,
            checkpointOrigin: env.TESSERA_LOG_ORIGIN,
            logId: parsed.data.log_id,
            requestId,
            record,
            key,
            sha256,
            createdAt: now,
          })
        : {
            tessera_submission_status: 'staged_only' as const,
          };

    return c.json(
      {
        ok: true,
        request_id: requestId,
        sha256,
        bucket: env.TESSERA_SIDECAR_BUCKET,
        key,
        s3_uri: `s3://${env.TESSERA_SIDECAR_BUCKET}/${key}`,
        ...runtimeResult,
        next_step:
          runtimeResult.tessera_submission_status === 'submitted'
            ? 'The append-intent object was staged in S3 and submitted to the configured Tessera runtime.'
            : 'The append-intent object was staged in S3. Configure a Tessera runtime to submit it automatically.',
      },
      201,
    );
  });

  app.get('/v1/logs', async (c) => {
    if (!checkpointSigner) {
      return c.json(nativeLogNotConfigured(), 501);
    }
    const logIds = await nativeLog.listLogIds();
    const logs = [];
    for (const logId of logIds) {
      const state = await nativeLog.readState(logId);
      logs.push({ log_id: logId, ...(state ?? {}) });
    }
    return c.json({ logs }, 200);
  });

  app.get('/v1/logs/:logId', async (c) => {
    if (!checkpointSigner) {
      return c.json(nativeLogNotConfigured(), 501);
    }
    const logId = c.req.param('logId');
    const state = await nativeLog.readState(logId);
    if (!state) {
      return c.json({ error: { code: 'LOG_NOT_FOUND', message: 'Unknown log id.' } }, 404);
    }
    const checkpoint = buildCheckpointForSigner({
      signer: checkpointSigner,
      origin: env.TESSERA_LOG_ORIGIN,
      treeSize: state.tree_size,
      rootHash: Buffer.from(state.root_hash, 'hex'),
    });
    return c.json(
      {
        log_id: logId,
        tree_size: state.tree_size,
        root_hash: state.root_hash,
        updated_at: state.updated_at,
        checkpoint: { envelope: checkpoint.envelope, note_sha256: checkpoint.noteSha256 },
        key_hint: keyHintHex,
        signer: checkpointSigner.kind,
      },
      200,
    );
  });

  app.get('/v1/logs/:logId/entries/:index', async (c) => {
    if (!checkpointSigner) {
      return c.json(nativeLogNotConfigured(), 501);
    }
    const logId = c.req.param('logId');
    const index = Number(c.req.param('index'));
    if (!Number.isInteger(index) || index < 0) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid entry index.' } }, 400);
    }
    const got = await nativeLog.entry({
      logId,
      index,
      checkpointOrigin: env.TESSERA_LOG_ORIGIN,
      checkpointSigner,
    });
    if (!got) {
      return c.json({ error: { code: 'ENTRY_NOT_FOUND', message: 'Unknown entry index.' } }, 404);
    }
    return c.json(
      {
        log_id: logId,
        entry_index: got.entry.entry_index,
        request_id: got.entry.request_id,
        record_sha256: got.entry.record_sha256,
        leaf_hash: got.entry.leaf_hash,
        created_at: got.entry.created_at,
        record_b64: got.record_b64,
        proof: got.proof,
        checkpoint: got.checkpoint,
      },
      200,
    );
  });

  return app;
}

async function appendToNativeLog(input: {
  nativeLog: NativeLog;
  checkpointSigner: CheckpointSigner;
  checkpointOrigin: string;
  logId: string;
  requestId: string;
  record: string;
  key: string;
  sha256: string;
  createdAt: string;
}) {
  const appended = await input.nativeLog.append({
    logId: input.logId,
    requestId: input.requestId,
    record: input.record,
    recordKey: input.key,
    recordSha256: input.sha256,
    createdAt: input.createdAt,
  });
  const checkpoint = buildCheckpointForSigner({
    signer: input.checkpointSigner,
    origin: input.checkpointOrigin,
    treeSize: appended.state.tree_size,
    rootHash: Buffer.from(appended.state.root_hash, 'hex'),
  });
  return {
    tessera_submission_status: 'submitted' as const,
    tessera_entry_index: appended.entryIndex,
    tessera_add_url: `native://${input.logId}/append`,
    tessera_checkpoint_url: `native://${input.logId}/checkpoint`,
    tessera_checkpoint_tree_size: appended.state.tree_size,
    tessera_checkpoint_root_hash: appended.state.root_hash,
    tessera_checkpoint_note_sha256: checkpoint.noteSha256,
  };
}

function buildS3Client(env: Env) {
  return new S3Client({
    region: env.TESSERA_SIDECAR_REGION,
    ...(env.TESSERA_SIDECAR_AWS_ENDPOINT ? { endpoint: env.TESSERA_SIDECAR_AWS_ENDPOINT } : {}),
    ...(typeof env.TESSERA_SIDECAR_FORCE_PATH_STYLE === 'boolean'
      ? { forcePathStyle: env.TESSERA_SIDECAR_FORCE_PATH_STYLE }
      : {}),
    ...(env.TESSERA_SIDECAR_AWS_ACCESS_KEY_ID && env.TESSERA_SIDECAR_AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.TESSERA_SIDECAR_AWS_ACCESS_KEY_ID,
            secretAccessKey: env.TESSERA_SIDECAR_AWS_SECRET_ACCESS_KEY,
            ...(env.TESSERA_SIDECAR_AWS_SESSION_TOKEN
              ? { sessionToken: env.TESSERA_SIDECAR_AWS_SESSION_TOKEN }
              : {}),
          },
        }
      : {}),
  });
}

async function submitToTesseraRuntime(input: {
  addUrl: string;
  key: string;
  record: string;
  source_type: string;
  source_urn: string;
}) {
  try {
    const response = await fetchWithRetry(input.addUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        source_key: input.key,
        source_type: input.source_type,
        source_urn: input.source_urn,
        entry_content_b64: Buffer.from(input.record, 'utf8').toString('base64'),
        content_type: 'application/json',
      }),
    });
    if (!response.ok) {
      return {
        tessera_submission_status: 'staged_only' as const,
        tessera_submission_error: `runtime request failed (${response.status})`,
        tessera_add_url: input.addUrl,
      };
    }
    const payload = RuntimeAddResponseSchema.parse(await response.json());
    return {
      tessera_submission_status: 'submitted' as const,
      tessera_entry_index: payload.index,
      tessera_add_url: input.addUrl,
      ...(payload.checkpoint_url ? { tessera_checkpoint_url: payload.checkpoint_url } : {}),
      ...(typeof payload.checkpoint_tree_size === 'number' ? { tessera_checkpoint_tree_size: payload.checkpoint_tree_size } : {}),
      ...(payload.checkpoint_root_hash ? { tessera_checkpoint_root_hash: payload.checkpoint_root_hash } : {}),
      ...(payload.checkpoint_note_sha256 ? { tessera_checkpoint_note_sha256: payload.checkpoint_note_sha256 } : {}),
    };
  } catch (err) {
    return {
      tessera_submission_status: 'staged_only' as const,
      tessera_submission_error: err instanceof Error ? err.message : String(err),
      tessera_add_url: input.addUrl,
    };
  }
}

// RFC 8785 (JCS) canonical JSON: UTF-16 code-unit key ordering, ECMAScript
// number serialization, minimal string escaping, no whitespace.
// Keep in sync with service/registry/application/services/canonical-json.ts.
function canonicalJsonString(value: unknown): string {
  return serializeJcs(value);
}

function serializeJcs(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('JCS cannot serialize non-finite numbers.');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeJcs(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeJcs(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`JCS cannot serialize values of type ${typeof value}.`);
}

function sha256Hex(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, '');
}
