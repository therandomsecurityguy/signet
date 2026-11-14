import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { z } from 'zod';

function defaultRepoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..');
}

function defaultApiEnvFile() {
  return path.join(defaultRepoRoot(), 'service', 'api', 'infra', '.env');
}

function defaultWebappEnvFile() {
  return path.join(defaultRepoRoot(), 'service', 'webapp', 'knowledge-manager', 'infra', '.env');
}

function defaultMcpEnvFile() {
  return path.join(defaultRepoRoot(), 'service', 'mcp', 'infra', '.env');
}

const EnvSchema = z.object({
  API_ORIGIN: z.string().url().default('http://localhost:3100'),
  MCP_ORIGIN: z.string().url().default('http://localhost:3000'),
  WEBAPP_ORIGIN: z.string().url().default('http://localhost:3200'),
  REPO_ROOT: z.string().default(defaultRepoRoot()),
  API_ENV_FILE: z.string().default(defaultApiEnvFile()),
  WEBAPP_ENV_FILE: z.string().default(defaultWebappEnvFile()),
  MCP_ENV_FILE: z.string().default(defaultMcpEnvFile()),
  // Cloudflare Access service-token headers for the deployed tunnels
  // (non-WARP machine clients). Both must be set to take effect.
  CACHET_CF_ACCESS_CLIENT_ID: z.string().optional(),
  CACHET_CF_ACCESS_CLIENT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(input);
}

/** Cloudflare Access headers for machine clients, when configured. */
export function cfAccessHeaders(env: Env): Record<string, string> {
  if (env.CACHET_CF_ACCESS_CLIENT_ID && env.CACHET_CF_ACCESS_CLIENT_SECRET) {
    return {
      'CF-Access-Client-Id': env.CACHET_CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': env.CACHET_CF_ACCESS_CLIENT_SECRET,
    };
  }
  return {};
}
