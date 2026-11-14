import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().max(65535).default(3400),
  TESSERA_SIDECAR_BUCKET: z.string().min(1),
  TESSERA_SIDECAR_REGION: z.string().default('us-west-2'),
  TESSERA_SIDECAR_TILES_PREFIX: z.string().default('tessera/tiles/dev'),
  TESSERA_SIDECAR_REQUESTS_PREFIX: z.string().default('tessera/requests/dev'),
  TESSERA_RUNTIME_ADD_URL: z.string().optional(),
  // Native companion log (RFC 6962): when the log private key is configured
  // (PEM), append intents are also appended to the native log and signed
  // checkpoints are published; the registry reconciles against them.
  TESSERA_LOG_PRIVATE_KEY: z.string().optional(),
  TESSERA_LOG_ORIGIN: z.string().default('signet-tessera.local'),
  // Shared bearer token for /v1/* calls (health/readiness/config stay open).
  // Auth is fail-closed: without the token, /v1/* responds 401 unless
  // TESSERA_SIDECAR_ALLOW_UNAUTHENTICATED explicitly opts out (local
  // development only).
  TESSERA_SIDECAR_AUTH_TOKEN: z.string().optional(),
  TESSERA_SIDECAR_ALLOW_UNAUTHENTICATED: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  TESSERA_SIDECAR_AWS_ENDPOINT: z.string().optional(),
  TESSERA_SIDECAR_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  TESSERA_SIDECAR_AWS_ACCESS_KEY_ID: z.string().optional(),
  TESSERA_SIDECAR_AWS_SECRET_ACCESS_KEY: z.string().optional(),
  TESSERA_SIDECAR_AWS_SESSION_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(input);
}
