import { LogAuditPublisher } from '../infrastructure/audit/log-audit-publisher.js';
import { FanoutAuditPublisher } from '../infrastructure/audit/fanout-audit-publisher.js';
import { SqliteAuditPublisher } from '../infrastructure/audit/sqlite-audit-publisher.js';
import { WarehouseRouterConnector } from '../infrastructure/connectors/router/warehouse-router.js';
import { SnowflakeConnector } from '../infrastructure/connectors/snowflake/snowflake-connector.js';
import { AthenaConnector } from '../infrastructure/connectors/athena/athena-connector.js';
import { MotherDuckConnector } from '../infrastructure/connectors/motherduck/motherduck-connector.js';
import { DefaultPolicyService } from '../infrastructure/policy/default-policy-service.js';
import { ExecuteToolUseCase } from '../application/usecases/execute-tool.js';
import { ListToolsUseCase } from '../application/usecases/list-tools.js';
import { ToolRegistry } from '../domain/tools/tool-registry.js';
import type { Env } from '../infrastructure/config/env.js';
import { buildLogger } from '../infrastructure/logging/pino.js';
import { createDbProvider } from '../infrastructure/persistence/db-provider.js';
import { SqliteApiKeyStore } from '../infrastructure/auth/sqlite-api-key-store.js';
import { RegistryServiceConnector } from '../infrastructure/registry/registry-service-connector.js';
import { RegistryReadGate } from '../infrastructure/registry/read-gate.js';
import { DefaultCognitiveService } from '../infrastructure/cognitive/default-cognitive-service.js';
import { buildRegistryCore } from '../../../registry/application/build-registry-core.js';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export type AppDependencies = ReturnType<typeof buildAppDependencies>;

export function buildAppDependencies(env: Env) {
  const dbProvider = createDbProvider(env.DATABASE_URL, {
    sslRootCertPath: env.DATABASE_SSL_ROOT_CERT,
  });

  const baseLogger = buildLogger();
  // Rekor trust is all-or-nothing and only meaningful with the keyless trust
  // policy itself; half-configured trust would silently reject every
  // tlog-carrying bundle at runtime, so fail at boot instead.
  if (Boolean(env.KEYLESS_REKOR_PUBLIC_KEY) !== Boolean(env.KEYLESS_REKOR_LOG_ID)) {
    throw new Error('KEYLESS_REKOR_PUBLIC_KEY and KEYLESS_REKOR_LOG_ID must be configured together.');
  }
  if (
    (env.KEYLESS_REKOR_PUBLIC_KEY || env.KEYLESS_REKOR_LOG_ID) &&
    !(env.KEYLESS_TRUSTED_ROOTS && env.KEYLESS_ALLOWED_ISSUERS && env.KEYLESS_ALLOWED_SUBJECTS)
  ) {
    throw new Error(
      'Rekor trust requires the keyless trust policy (KEYLESS_TRUSTED_ROOTS, KEYLESS_ALLOWED_ISSUERS, KEYLESS_ALLOWED_SUBJECTS).',
    );
  }
  const registry = ToolRegistry.buildDefault();
  const policy = new DefaultPolicyService(env);
  const connector = new WarehouseRouterConnector({
    snowflake: new SnowflakeConnector(env),
    athena: new AthenaConnector(env),
    motherduck: new MotherDuckConnector(env),
  });

  const registryCore = buildRegistryCore({
    graph_backend: env.REGISTRY_GRAPH_BACKEND,
    ...(env.REGISTRY_GRAPH_STATE_FILE ? { graph_state_file: path.resolve(env.REGISTRY_GRAPH_STATE_FILE) } : {}),
    ...(env.REGISTRY_SPARQL_QUERY_URL ? { sparql_query_url: env.REGISTRY_SPARQL_QUERY_URL } : {}),
    ...(env.REGISTRY_SPARQL_UPDATE_URL ? { sparql_update_url: env.REGISTRY_SPARQL_UPDATE_URL } : {}),
    ...(env.REGISTRY_SPARQL_USERNAME ? { sparql_username: env.REGISTRY_SPARQL_USERNAME } : {}),
    ...(env.REGISTRY_SPARQL_PASSWORD ? { sparql_password: env.REGISTRY_SPARQL_PASSWORD } : {}),
    artifact_backend: env.REGISTRY_ARTIFACT_BACKEND,
    artifact_integrity_mode: env.REGISTRY_ARTIFACT_INTEGRITY_MODE,
    ...(env.REGISTRY_ARTIFACT_BACKEND === 'fs'
      ? { objects_dir: path.resolve(env.REGISTRY_OBJECTS_DIR) }
      : {}),
    ...(env.REGISTRY_S3_BUCKET ? { s3_bucket: env.REGISTRY_S3_BUCKET } : {}),
    ...(env.REGISTRY_S3_PREFIX ? { s3_prefix: env.REGISTRY_S3_PREFIX } : {}),
    ...(env.REGISTRY_S3_REGION ? { s3_region: env.REGISTRY_S3_REGION } : {}),
    ...(env.REGISTRY_S3_ENDPOINT ? { s3_endpoint: env.REGISTRY_S3_ENDPOINT } : {}),
    ...(typeof env.REGISTRY_S3_FORCE_PATH_STYLE === 'boolean'
      ? { s3_force_path_style: env.REGISTRY_S3_FORCE_PATH_STYLE }
      : {}),
    ...(env.REGISTRY_S3_ACCESS_KEY_ID ? { s3_access_key_id: env.REGISTRY_S3_ACCESS_KEY_ID } : {}),
    ...(env.REGISTRY_S3_SECRET_ACCESS_KEY ? { s3_secret_access_key: env.REGISTRY_S3_SECRET_ACCESS_KEY } : {}),
    ...(env.REGISTRY_S3_SESSION_TOKEN ? { s3_session_token: env.REGISTRY_S3_SESSION_TOKEN } : {}),
    ...(env.KEYLESS_TRUSTED_ROOTS && env.KEYLESS_ALLOWED_ISSUERS && env.KEYLESS_ALLOWED_SUBJECTS
      ? {
          keyless: {
            trusted_root_pems: env.KEYLESS_TRUSTED_ROOTS.split(',')
              .map((entry) => readFileSync(entry.trim(), 'utf8'))
              .filter((pem) => pem.includes('BEGIN CERTIFICATE')),
            allowed_issuers: env.KEYLESS_ALLOWED_ISSUERS.split(',')
              .map((value) => value.trim())
              .filter(Boolean),
            allowed_subject_patterns: env.KEYLESS_ALLOWED_SUBJECTS.split(',')
              .map((value) => value.trim())
              .filter(Boolean),
            ...(env.KEYLESS_REKOR_PUBLIC_KEY && env.KEYLESS_REKOR_LOG_ID
              ? {
                  rekor_public_key_pem: readFileSync(env.KEYLESS_REKOR_PUBLIC_KEY, 'utf8'),
                  rekor_log_id: env.KEYLESS_REKOR_LOG_ID,
                }
              : {}),
          },
        }
      : {}),
  });
  const registryConnector = new RegistryServiceConnector(
    registryCore.service,
    new RegistryReadGate(registryCore.service, {
      deny_revoked: env.REGISTRY_READ_DENY_REVOKED,
      require_verified: env.REGISTRY_READ_REQUIRE_VERIFIED ?? false,
    }),
  );

  const audit = new FanoutAuditPublisher([
    new LogAuditPublisher(baseLogger),
    new SqliteAuditPublisher(dbProvider),
  ]);
  const apiKeys = new SqliteApiKeyStore(dbProvider, env.API_KEY_PEPPER ? { pepper: env.API_KEY_PEPPER } : {});

  const cognitive = new DefaultCognitiveService({
    enabled: env.COGNITIVE_LAYER_ENABLED,
    budget_tokens: env.CONTEXT_BUDGET_TOKENS,
    cache_ttl_ms: env.COGNITIVE_CACHE_TTL_MS,
    cache_max_entries: env.COGNITIVE_CACHE_MAX_ENTRIES,
  });

  return {
    ready: dbProvider.ready,
    db: dbProvider,
    env,
    registry,
    policy,
    connector,
    registryGraph: registryCore.graph,
    registryCas: registryCore.cas,
    registryCore: registryCore.service,
    registryConnector,
    audit,
    apiKeys,
    cognitive,
    listTools: new ListToolsUseCase(registry),
    executeTool: new ExecuteToolUseCase({
      registry,
      policy,
      warehouse: connector,
      registryConnector,
      audit,
      cognitive,
    }),
  };
}

