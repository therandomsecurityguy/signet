import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  SERVICE_NAME: z.string().default('signet-mcp'),
  DATABASE_URL: z.string().default('file:./var/signet-mcp.db'),
  // Path to a PEM bundle of CAs for Postgres TLS (RDS regional CA). When set,
  // connections force sslmode=verify-full against that bundle.
  DATABASE_SSL_ROOT_CERT: z.string().optional(),
  // Peppers the API-key hash (HMAC-SHA256); must match service/api. Required in production.
  API_KEY_PEPPER: z.string().optional(),
  // Observability. When OTEL_EXPORTER_OTLP_ENDPOINT is set, traces are exported
  // to that OTLP/HTTP collector; otherwise they fall back to the console (dev).
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  MAX_ROWS_DEFAULT: z.coerce.number().int().positive().default(50),
  MAX_ROWS_HARD_MAX: z.coerce.number().int().positive().default(500),
  TOOL_TIMEOUT_MS_DEFAULT: z.coerce.number().int().positive().default(15_000),
  TOOL_TIMEOUT_MS_HARD_MAX: z.coerce.number().int().positive().default(60_000),
  MAX_OUTPUT_BYTES: z.coerce.number().int().positive().default(65_536),

  // Auth mode
  AUTH_MODE: z.enum(['api_key', 'okta', 'dual']).default('api_key'),

  // Okta (Stage 2)
  OKTA_MODE: z.enum(['mock', 'real']).default('mock'),
  OKTA_ISSUER: z.string().optional(),
  OKTA_AUDIENCE: z.string().optional(),
  OKTA_REQUIRED_SCOPES: z.string().optional(), // space-separated
  OKTA_GROUPS_CLAIM: z.string().default('groups'),
  AUTHZ_RULES_JSON: z.string().optional(),

  // Registry (graph + CAS)
  REGISTRY_GRAPH_BACKEND: z.enum(['memory', 'json_file', 'sparql']).default('memory'),
  REGISTRY_GRAPH_STATE_FILE: z.string().default('../../data/registry/graph/registry-state.json'),
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

  // Keyless (sigstore) signature trust policy, mirroring service/api.
  // KEYLESS_TRUSTED_ROOTS is a comma-separated list of PEM file paths
  // (roots/intermediates); KEYLESS_ALLOWED_ISSUERS and
  // KEYLESS_ALLOWED_SUBJECTS are comma-separated exact values / regular
  // expressions matched against the certificate identity. KEYLESS_REKOR_PUBLIC_KEY
  // (path to a PEM file) and KEYLESS_REKOR_LOG_ID (hex) are required together;
  // tlog-carrying bundles fail closed without them.
  KEYLESS_TRUSTED_ROOTS: z.string().optional(),
  KEYLESS_ALLOWED_ISSUERS: z.string().optional(),
  KEYLESS_ALLOWED_SUBJECTS: z.string().optional(),
  KEYLESS_REKOR_PUBLIC_KEY: z.string().optional(),
  KEYLESS_REKOR_LOG_ID: z.string().optional(),

  // Read gates. Revocation denial is on by default: serving revoked
  // publications unchecked is treated as a bug, not a policy choice. Set
  // REGISTRY_READ_DENY_REVOKED=false to restore the legacy fail-open
  // behaviour. The verification gate stays opt-in
  // (REGISTRY_READ_REQUIRE_VERIFIED=true): how strict verification must be is
  // a deployment policy. Setting both gives a default-deny posture.
  REGISTRY_READ_DENY_REVOKED: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? true : value === 'true')),
  REGISTRY_READ_REQUIRE_VERIFIED: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),

  // Connector modes (worksession 02 default: mock)
  SNOWFLAKE_MODE: z.enum(['mock', 'real']).default('mock'),
  ATHENA_MODE: z.enum(['mock', 'real']).default('mock'),
  MOTHERDUCK_MODE: z.enum(['mock', 'real']).default('mock'),

  // Snowflake (required only when SNOWFLAKE_MODE=real)
  SNOWFLAKE_ACCOUNT: z.string().optional(),
  SNOWFLAKE_USERNAME: z.string().optional(),
  SNOWFLAKE_PASSWORD: z.string().optional(),
  SNOWFLAKE_WAREHOUSE: z.string().optional(),
  SNOWFLAKE_DATABASE: z.string().optional(),
  SNOWFLAKE_SCHEMA: z.string().optional(),
  SNOWFLAKE_ROLE: z.string().optional(),

  // Rate limiting
  RATE_LIMIT_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== 'false'),
  RATE_LIMIT_REQUESTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  REDIS_URL: z.string().optional(),

  // CORS. Comma-separated allowlist of origins. When unset, CORS falls back to
  // '*' (dev only); production must set an explicit allowlist.
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // Cognitive layer (context management)
  COGNITIVE_LAYER_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  CONTEXT_BUDGET_TOKENS: z.coerce.number().int().positive().default(8_000),
  COGNITIVE_CACHE_TTL_MS: z.coerce.number().int().positive().default(300_000),
  COGNITIVE_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(500),
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

