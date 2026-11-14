import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().max(65535).default(3100),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  SERVICE_NAME: z.string().default('signet-api'),
  DATABASE_URL: z.string().default('file:./var/signet-api.db'),
  // Path to a PEM bundle of CAs for Postgres TLS (RDS regional CA). When set,
  // connections force sslmode=verify-full against that bundle.
  DATABASE_SSL_ROOT_CERT: z.string().optional(),
  // Observability. When OTEL_EXPORTER_OTLP_ENDPOINT is set, traces are exported
  // to that OTLP/HTTP collector; otherwise they fall back to the console (dev).
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  AUTH_MODE: z.enum(['api_key', 'okta', 'dual']).default('api_key'),
  OKTA_MODE: z.enum(['mock', 'real']).default('mock'),
  OKTA_ISSUER: z.string().optional(),
  OKTA_AUDIENCE: z.string().optional(),
  OKTA_REQUIRED_SCOPES: z.string().optional(),
  OKTA_GROUPS_CLAIM: z.string().default('groups'),
  OKTA_ADMIN_GROUPS: z.string().optional(),
  // Self-serve API keys. The pepper is mixed into the key hash (HMAC-SHA256) so
  // a database leak alone cannot verify guesses; it is required in production.
  // TTL is the default expiry applied to newly minted keys (days).
  API_KEY_PEPPER: z.string().optional(),
  API_KEY_DEFAULT_TTL_DAYS: z.coerce.number().int().positive().default(90),
  REGISTRY_GRAPH_BACKEND: z.enum(['json_file', 'memory', 'sparql']).default('json_file'),
  REGISTRY_GRAPH_STATE_FILE: z.string().default('../../data/registry/graph/api-state.json'),
  REGISTRY_SPARQL_QUERY_URL: z.string().optional(),
  REGISTRY_SPARQL_UPDATE_URL: z.string().optional(),
  REGISTRY_SPARQL_USERNAME: z.string().optional(),
  REGISTRY_SPARQL_PASSWORD: z.string().optional(),
  REGISTRY_ARTIFACT_BACKEND: z.enum(['fs', 's3']).default('fs'),
  REGISTRY_OBJECTS_DIR: z.string().default('../../data/registry/objects'),
  REGISTRY_ARTIFACT_INTEGRITY_MODE: z.enum(['warn', 'enforce']).default('warn'),
  REGISTRY_S3_BUCKET: z.string().optional(),
  REGISTRY_S3_PREFIX: z.string().optional(),
  REGISTRY_S3_REGION: z.string().optional(),
  REGISTRY_S3_ENDPOINT: z.string().optional(),
  REGISTRY_S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  REGISTRY_S3_ACCESS_KEY_ID: z.string().optional(),
  REGISTRY_S3_SECRET_ACCESS_KEY: z.string().optional(),
  REGISTRY_S3_SESSION_TOKEN: z.string().optional(),
  TESSERA_SIDECAR_URL: z.string().optional(),
  // Shared bearer token for registry <-> tessera-sidecar calls; must match
  // the sidecar's TESSERA_SIDECAR_AUTH_TOKEN when the sidecar enforces auth.
  TESSERA_SIDECAR_AUTH_TOKEN: z.string().optional(),
  // Keyless (sigstore) signature trust policy: KEYLESS_TRUSTED_ROOTS is a
  // comma-separated list of PEM file paths (roots/intermediates);
  // KEYLESS_ALLOWED_ISSUERS and KEYLESS_ALLOWED_SUBJECTS are comma-separated
  // exact values / regular expressions.
  // API-key write-scope enforcement: `enforce` (default) rejects writes whose
  // key lacks the required fine-grained scope with 403 INSUFFICIENT_SCOPE;
  // `warn` records scope_warning auth events and allows (compat/migration mode).
  SCOPE_ENFORCEMENT: z.enum(['warn', 'enforce']).default('enforce'),
  KEYLESS_TRUSTED_ROOTS: z.string().optional(),
  KEYLESS_ALLOWED_ISSUERS: z.string().optional(),
  KEYLESS_ALLOWED_SUBJECTS: z.string().optional(),
  // Rekor transparency-log trust for keyless bundles: the log's public key
  // (path to a PEM file) and the log id (hex). Both are required together;
  // tlog-carrying bundles fail closed without them.
  KEYLESS_REKOR_PUBLIC_KEY: z.string().optional(),
  KEYLESS_REKOR_LOG_ID: z.string().optional(),
  TRANSPARENCY_APPEND_LOG_ID: z.string().optional(),
  // PEM content of the native companion log's checkpoint key; enables
  // transparency reconciliation when set alongside TESSERA_SIDECAR_URL and
  // TRANSPARENCY_APPEND_LOG_ID.
  TESSERA_LOG_PUBLIC_KEY: z.string().optional(),
  TIME_AWARE_GRAPH_BACKEND: z.enum(['json_file', 'memory', 'sparql']).default('json_file'),
  TIME_AWARE_GRAPH_STATE_FILE: z.string().default('../../data/registry/graph/time-aware-state.json'),
  TIME_AWARE_SPARQL_QUERY_URL: z.string().optional(),
  TIME_AWARE_SPARQL_UPDATE_URL: z.string().optional(),
  TIME_AWARE_SPARQL_USERNAME: z.string().optional(),
  TIME_AWARE_SPARQL_PASSWORD: z.string().optional(),
  TIME_AWARE_OBJECTS_DIR: z.string().default('../../data/registry/objects'),

  // Rate limiting. When REDIS_URL is set, the limiter is distributed across
  // replicas via Redis; otherwise it falls back to an in-memory store (dev).
  RATE_LIMIT_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== 'false'),
  RATE_LIMIT_REQUESTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // Credential-guessing budget: failed authentications per client address
  // before the limiter rejects with 429. Independent of the per-credential
  // bucket, which cannot see guessing attempts (each guess is a new key).
  AUTH_FAILURE_LIMIT: z.coerce.number().int().positive().default(20),
  AUTH_FAILURE_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60_000),
  REDIS_URL: z.string().optional(),

  // CORS. Comma-separated allowlist of origins. When unset, CORS falls back to
  // '*' (dev only); production must set an explicit allowlist.
  CORS_ALLOWED_ORIGINS: z.string().optional(),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production') {
    if (env.OKTA_MODE === 'mock') {
      ctx.addIssue({
        code: 'custom',
        message: 'OKTA_MODE=mock is not allowed in production; set OKTA_MODE=real.',
      });
    }
    if (env.AUTH_MODE === 'api_key') {
      ctx.addIssue({
        code: 'custom',
        message: 'AUTH_MODE=api_key is not allowed in production; use okta or dual.',
      });
    }
    if (!env.CORS_ALLOWED_ORIGINS) {
      ctx.addIssue({
        code: 'custom',
        message: 'CORS_ALLOWED_ORIGINS must be set to an explicit allowlist in production.',
      });
    }
    if (!env.API_KEY_PEPPER) {
      ctx.addIssue({
        code: 'custom',
        message: 'API_KEY_PEPPER must be set in production (peppers the API-key hash).',
      });
    }
  }
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(input);
}
