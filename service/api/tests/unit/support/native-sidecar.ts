/**
 * Test support: boot the real Tessera sidecar app in-process with a fake S3
 * backend, for append-intent staging and reconciliation coverage.
 *
 * Shared by transparency-reconciliation.test.ts and
 * evidence-transparency.test.ts.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';

import { buildApp as buildSidecarApp } from '../../../../tessera-sidecar/src/app.js';
import { loadEnv as loadSidecarEnv } from '../../../../tessera-sidecar/src/config/env.js';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Build (name, seed) -> spec signer/verifier key strings. */
function buildNoteKeys(name: string): { noteKey: string; verifierKey: string } {
  const seed = randomBytes(32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spkiDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const publicKey = spkiDer.subarray(spkiDer.length - 32);
  const keyData = Buffer.concat([Buffer.from([0x01]), publicKey]);
  const hash = createHash('sha256').update(name).update('\n').update(keyData).digest().subarray(0, 4);
  return {
    noteKey: `PRIVATE+KEY+${name}+${hash.toString('hex')}+${Buffer.concat([
      Buffer.from([0x01]),
      seed,
    ]).toString('base64')}`,
    verifierKey: `${name}+${hash.toString('hex')}+${keyData.toString('base64')}`,
  };
}

const servers: ServerType[] = [];

export async function closeSidecarServers(): Promise<void> {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

export async function getFreePort(): Promise<number> {
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
    server.on('error', reject);
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

export function createFakeS3() {
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

export async function startNativeSidecar(input?: {
  native?: boolean;
  authToken?: string;
  allowUnauthenticated?: boolean;
  /** Sign checkpoints with a spec note key (Ed25519) instead of the legacy PEM. */
  noteKeyMode?: boolean;
}) {
  const native = input?.native ?? true;
  // Dev-equivalent default for tests that do not exercise auth: explicit
  // opt-out, matching local development without a token.
  const allowUnauthenticated = input?.allowUnauthenticated ?? !input?.authToken;
  const noteKeys = input?.noteKeyMode ? buildNoteKeys('signet-test-log') : null;
  let privateKeyPem: string | null = null;
  let publicKeyPem: string | null = null;
  // Always provide a legacy key pair unless in note mode: staged-only tests
  // still need a public key for registry reconciliation config.
  if (!input?.noteKeyMode) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }
  const fakeS3 = createFakeS3();
  const env = loadSidecarEnv({
    TESSERA_SIDECAR_BUCKET: 'transparency-test-bucket',
    TESSERA_SIDECAR_TILES_PREFIX: 'tessera/tiles/test',
    TESSERA_SIDECAR_REQUESTS_PREFIX: 'tessera/requests/test',
    ...(native && privateKeyPem ? { TESSERA_LOG_PRIVATE_KEY: privateKeyPem, TESSERA_LOG_ORIGIN: 'signet-test-log' } : {}),
    ...(native && noteKeys ? { TESSERA_LOG_NOTE_KEY: noteKeys.noteKey, TESSERA_LOG_ORIGIN: 'signet-test-log' } : {}),
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
    publicKeyPem: publicKeyPem ?? '',
    noteVerifierKey: noteKeys?.verifierKey ?? '',
    objects: fakeS3.objects,
  };
}
