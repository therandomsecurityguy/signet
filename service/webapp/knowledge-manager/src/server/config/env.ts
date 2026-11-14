import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().max(65535).default(3200),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_ORIGIN: z.string().url().default('http://localhost:3100'),
  // VocBench UI link, shown only when set (ontology authoring is opt-in).
  VOCBENCH_UI_URL: z.string().url().optional(),
  // Fuseki endpoint shown on the query-shortcuts page. Cluster-internal in prod.
  FUSEKI_URL: z.string().url().default('http://localhost:3030'),
  // Optional links surfaced on the home page (API docs / MCP endpoint).
  API_DOCS_URL: z.string().optional(),
  MCP_URL: z.string().optional(),
  DATABASE_URL: z.string().default('file:./var/knowledge-manager.db'),
  AUTH_MODE: z.enum(['api_key', 'okta', 'dual']).default('api_key'),
  OKTA_MODE: z.enum(['mock', 'real']).default('mock'),
  // Mock auth is dev/test-only; any other environment (staging, prod, unset)
  // must opt in explicitly with ALLOW_MOCK_AUTH=true.
  ALLOW_MOCK_AUTH: z.string().optional(),
  OKTA_ISSUER: z.string().url().optional(),
  OKTA_CLIENT_ID: z.string().optional(),
  OKTA_CLIENT_SECRET: z.string().optional(),
  OKTA_REDIRECT_URI: z.string().url().default('http://localhost:3200/session/callback'),
  OKTA_SCOPES: z.string().default('openid profile email'),
  OKTA_ADMIN_GROUPS: z.string().default('app_signet_admin'),
  SESSION_COOKIE_NAME: z.string().min(1).default('knowledge_manager_session'),
  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(480),
  SEMANTIC_TURKEY_BASE_URL: z.string().url().optional(),
  SEMANTIC_TURKEY_EMAIL: z.string().optional(),
  SEMANTIC_TURKEY_PASSWORD: z.string().optional(),
}).superRefine((env, ctx) => {
  // Mock auth is dev/test-only: staging, prod, or any unrecognized NODE_ENV
  // requires an explicit opt-in.
  if (
    env.OKTA_MODE === 'mock' &&
    env.NODE_ENV !== 'test' &&
    env.NODE_ENV !== 'development' &&
    env.ALLOW_MOCK_AUTH !== 'true'
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'OKTA_MODE=mock is only allowed in test/development or with ALLOW_MOCK_AUTH=true.',
    });
  }
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
  }
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(input);
}
