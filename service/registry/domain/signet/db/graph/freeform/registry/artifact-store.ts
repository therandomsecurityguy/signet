import { GetObjectCommand, GetObjectLegalHoldCommand, GetObjectRetentionCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export type PutArtifactInput = {
  bytes: Uint8Array;
  media_type?: string;
  original_path?: string;
};

export type ArtifactRecord = {
  sha256: string;
  size_bytes: number;
  media_type?: string;
  original_path?: string;
};

export type GetArtifactResult = {
  record: ArtifactRecord;
  bytes: Uint8Array;
  // Digest recomputed from the bytes actually read. Content addressed storage
  // must not be trusted blindly: a mismatch means the object was tampered
  // with or corrupted.
  computed_sha256: string;
  digest_verified: boolean;
};

// How a store reacts when the recomputed digest does not match the requested
// object key. `warn` (default) surfaces `digest_verified: false`; `enforce`
// throws so callers cannot accidentally use tampered bytes.
export type ArtifactIntegrityMode = 'warn' | 'enforce';

export class CasIntegrityError extends Error {
  constructor(
    public readonly requested_sha256: string,
    public readonly computed_sha256: string,
  ) {
    super(
      `CAS integrity check failed: requested ${requested_sha256}, computed ${computed_sha256}`,
    );
    this.name = 'CasIntegrityError';
  }
}

// Content addresses are opaque keys. Anything that is not a lowercase hex
// sha256 is rejected before it can reach a filesystem path or object key, so
// a crafted address can never escape the CAS root.
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type S3ArtifactStoreConfig = {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  force_path_style?: boolean;
  access_key_id?: string;
  secret_access_key?: string;
  session_token?: string;
  integrity_mode?: ArtifactIntegrityMode;
  client?: {
    send(command: unknown): Promise<unknown>;
  };
};

export interface ArtifactStore {
  put(input: PutArtifactInput): Promise<ArtifactRecord>;
  getBySha256(sha256: string): Promise<GetArtifactResult | null>;
  /**
   * Object-lock retention reported by the backend for one object, when the
   * backend supports immutability reporting (S3 Object Lock). File-system
   * stores omit this method: they cannot enforce WORM.
   */
  getRetention?(sha256: string): Promise<ArtifactRetention | null>;
}

export type ArtifactRetention = {
  /** S3 Object Lock mode, or null when no lock retention is configured. */
  mode: 'GOVERNANCE' | 'COMPLIANCE' | null;
  /** ISO timestamp until which the object is locked. */
  retain_until?: string;
  /** S3 legal hold status, when the backend reports one. */
  legal_hold?: boolean;
};

export class FsCasArtifactStore implements ArtifactStore {
  private readonly integrityMode: ArtifactIntegrityMode;

  constructor(
    private readonly objectsRootDir: string,
    options?: { integrity_mode?: ArtifactIntegrityMode },
  ) {
    this.integrityMode = options?.integrity_mode ?? 'warn';
  }

  async put(input: PutArtifactInput): Promise<ArtifactRecord> {
    const sha256 = sha256Hex(input.bytes);
    const objectPath = this.objectPath(sha256);

    await mkdir(path.dirname(objectPath), { recursive: true });
    await writeFile(objectPath, input.bytes);

    const st = await stat(objectPath);

    return {
      sha256,
      size_bytes: st.size,
      ...(input.media_type ? { media_type: input.media_type } : {}),
      ...(input.original_path ? { original_path: input.original_path } : {}),
    };
  }

  async getBySha256(sha256: string): Promise<GetArtifactResult | null> {
    if (!SHA256_PATTERN.test(sha256)) {
      return null;
    }
    const objectPath = this.objectPath(sha256);
    try {
      const bytes = await readFile(objectPath);
      const st = await stat(objectPath);
      const verification = verifyReadDigest(sha256, bytes, this.integrityMode);
      return {
        record: {
          sha256,
          size_bytes: st.size,
        },
        bytes,
        ...verification,
      };
    } catch (err) {
      if (err instanceof CasIntegrityError) {
        throw err;
      }
      return null;
    }
  }

  private objectPath(sha256: string): string {
    const root = path.resolve(this.objectsRootDir);
    // Spread objects by prefix to avoid huge directories.
    const prefix = sha256.slice(0, 2);
    const resolved = path.resolve(root, prefix, sha256);
    if (!resolved.startsWith(root + path.sep)) {
      throw new Error(`Refusing to resolve a CAS path outside the objects root: ${sha256}`);
    }
    return resolved;
  }
}

export class S3CasArtifactStore implements ArtifactStore {
  private readonly bucket: string;
  private readonly prefix: string | undefined;
  private readonly integrityMode: ArtifactIntegrityMode;

  private readonly client: {
    send(command: unknown): Promise<unknown>;
  };

  constructor(cfg: S3ArtifactStoreConfig) {
    this.bucket = cfg.bucket;
    this.prefix = normalizeS3Prefix(cfg.prefix);
    this.integrityMode = cfg.integrity_mode ?? 'warn';
    this.client =
      cfg.client ??
      new S3Client({
        ...(cfg.region ? { region: cfg.region } : {}),
        ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
        ...(typeof cfg.force_path_style === 'boolean' ? { forcePathStyle: cfg.force_path_style } : {}),
        ...(cfg.access_key_id && cfg.secret_access_key
          ? {
              credentials: {
                accessKeyId: cfg.access_key_id,
                secretAccessKey: cfg.secret_access_key,
                ...(cfg.session_token ? { sessionToken: cfg.session_token } : {}),
              },
            }
          : {}),
      });
  }

  async put(input: PutArtifactInput): Promise<ArtifactRecord> {
    const sha256 = sha256Hex(input.bytes);
    const key = this.objectKey(sha256);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.bytes,
        ...(input.media_type ? { ContentType: input.media_type } : {}),
        Metadata: {
          sha256,
          ...(input.original_path ? { original_path: input.original_path } : {}),
        },
      }),
    );

    return {
      sha256,
      size_bytes: input.bytes.byteLength,
      ...(input.media_type ? { media_type: input.media_type } : {}),
      ...(input.original_path ? { original_path: input.original_path } : {}),
    };
  }

  async getBySha256(sha256: string): Promise<GetArtifactResult | null> {
    if (!SHA256_PATTERN.test(sha256)) {
      return null;
    }
    try {
      const response = (await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(sha256),
        }),
      )) as {
        Body?: unknown;
        ContentLength?: number;
        ContentType?: string;
        Metadata?: Record<string, string>;
      };

      const bytes = await readS3BodyBytes(response.Body);
      const verification = verifyReadDigest(sha256, bytes, this.integrityMode);
      return {
        record: {
          sha256,
          size_bytes: typeof response.ContentLength === 'number' ? response.ContentLength : bytes.byteLength,
          ...(response.ContentType ? { media_type: response.ContentType } : {}),
          ...(response.Metadata?.['original_path'] ? { original_path: response.Metadata['original_path'] } : {}),
        },
        bytes,
        ...verification,
      };
    } catch (err) {
      if (err instanceof CasIntegrityError) {
        throw err;
      }
      if (isS3NotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }

  async getRetention(sha256: string): Promise<ArtifactRetention | null> {
    if (!SHA256_PATTERN.test(sha256)) {
      return null;
    }
    const key = this.objectKey(sha256);
    const retention: ArtifactRetention = { mode: null };
    try {
      const response = (await this.client.send(
        new GetObjectRetentionCommand({ Bucket: this.bucket, Key: key }),
      )) as { Retention?: { Mode?: string; RetainUntilDate?: Date | string } };
      const mode = response.Retention?.Mode;
      if (mode === 'GOVERNANCE' || mode === 'COMPLIANCE') {
        retention.mode = mode;
      }
      const retainUntil = response.Retention?.RetainUntilDate;
      if (retainUntil) {
        retention.retain_until = new Date(retainUntil).toISOString();
      }
    } catch {
      // NoSuchObjectLockConfiguration, missing object, or an endpoint without
      // Object Lock: report "no retention" rather than failing the read.
    }
    try {
      const hold = (await this.client.send(
        new GetObjectLegalHoldCommand({ Bucket: this.bucket, Key: key }),
      )) as { LegalHold?: { Status?: string } };
      if (hold.LegalHold?.Status === 'ON' || hold.LegalHold?.Status === 'OFF') {
        retention.legal_hold = hold.LegalHold.Status === 'ON';
      }
    } catch {
      // Optional; undocumented when absent.
    }
    return retention;
  }

  private objectKey(sha256: string): string {
    const prefix = sha256.slice(0, 2);
    return [this.prefix, prefix, sha256].filter((value) => Boolean(value)).join('/');
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function verifyReadDigest(
  requestedSha256: string,
  bytes: Uint8Array,
  mode: ArtifactIntegrityMode,
): { computed_sha256: string; digest_verified: boolean } {
  const computed_sha256 = sha256Hex(bytes);
  const digest_verified = computed_sha256 === requestedSha256;
  if (!digest_verified && mode === 'enforce') {
    throw new CasIntegrityError(requestedSha256, computed_sha256);
  }
  return { computed_sha256, digest_verified };
}

async function readS3BodyBytes(body: unknown): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    return await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  }
  if (Symbol.asyncIterator in Object(body)) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }
  throw new Error('Unsupported S3 body type.');
}

function normalizeS3Prefix(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.replace(/^\/+|\/+$/g, '');
  return trimmed.length > 0 ? trimmed : undefined;
}

function isS3NotFoundError(err: unknown) {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'NoSuchKey'
  );
}

