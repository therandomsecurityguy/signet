import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { FanoutAuditPublisher } from '../infrastructure/audit/fanout-audit-publisher.js';
import { LogAuditPublisher } from '../infrastructure/audit/log-audit-publisher.js';
import { SqliteAuditPublisher } from '../infrastructure/audit/sqlite-audit-publisher.js';
import { SqliteApiKeyStore } from '../infrastructure/auth/sqlite-api-key-store.js';
import { buildLogger } from '../infrastructure/logging/pino.js';
import { buildRegistryCore } from '../../../registry/application/build-registry-core.js';
import { buildTimeAwareCore } from '../../../registry/application/time-aware/build-time-aware-core.js';
import { FsCasArtifactStore } from '../../../registry/domain/signet/db/graph/freeform/registry/artifact-store.js';
import type { Env } from '../infrastructure/config/env.js';
import { createDbProvider } from '../infrastructure/persistence/db-provider.js';
import { buildGraphStore } from '../infrastructure/registry/graph-backend-factory.js';
import { GraphAgentRegistry } from '../infrastructure/registry/graph-agent-registry.js';
import { GraphSkillRegistry } from '../infrastructure/registry/graph-skill-registry.js';
import { CreateAgentUseCase } from '../application/usecases/create-agent.js';
import { ApiKeyUseCase } from '../application/usecases/api-keys.js';
import { AgentLifecycleUseCase } from '../application/usecases/agent-lifecycle.js';
import { CompileUseCase, DeFactoTermsUseCase } from '../application/usecases/compile.js';
import { ReviewsUseCase } from '../application/usecases/reviews.js';
import { GovernanceLogUseCase } from '../application/usecases/governance-log.js';
import { OntologyPackageUseCase } from '../application/usecases/ontology-packages.js';
import { PolicyPackageUseCase } from '../application/usecases/policy-packages.js';
import { AgentPublicationUseCase } from '../application/usecases/agent-publication.js';
import { CreatePublicKeyUseCase } from '../application/usecases/create-public-key.js';
import { CreateTransparencyLogUseCase } from '../application/usecases/create-transparency-log.js';
import { CreateTransparencyObservationUseCase } from '../application/usecases/create-transparency-observation.js';
import { CreateTransparencyGossipEventUseCase } from '../application/usecases/create-transparency-gossip-event.js';
import { CreateTransparencyWitnessUseCase } from '../application/usecases/create-transparency-witness.js';
import { CreateTransparencyCheckpointUseCase } from '../application/usecases/create-transparency-checkpoint.js';
import { GetAgentUseCase } from '../application/usecases/get-agent.js';
import { GetPublicKeyUseCase } from '../application/usecases/get-public-key.js';
import { GetTransparencyLogUseCase } from '../application/usecases/get-transparency-log.js';
import { GetTransparencyLogTimelineUseCase } from '../application/usecases/get-transparency-log-timeline.js';
import { GetTransparencyLogVerificationUseCase } from '../application/usecases/get-transparency-log-verification.js';
import { ReconcilePublicationTransparencyUseCase } from '../application/usecases/reconcile-publication-transparency.js';
import { ListAgentsUseCase } from '../application/usecases/list-agents.js';
import { ListPublicKeysUseCase } from '../application/usecases/list-public-keys.js';
import { ListTransparencyLogsUseCase } from '../application/usecases/list-transparency-logs.js';
import { RevokePublicKeyUseCase } from '../application/usecases/revoke-public-key.js';
import { CreateSkillUseCase } from '../application/usecases/create-skill.js';
import { GetSkillUseCase } from '../application/usecases/get-skill.js';
import { ListSkillsUseCase } from '../application/usecases/list-skills.js';
import { ReadGraphSubgraphUseCase } from '../application/usecases/read-graph-subgraph.js';
import { AdvisoriesUseCase } from '../application/usecases/advisories.js';
import { SkillLifecycleUseCase } from '../application/usecases/skill-lifecycle.js';
import { TimeAwareRegistryUseCase } from '../application/usecases/time-aware-registry.js';

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
  const registryCore = buildRegistryCore({
    graph_backend: env.REGISTRY_GRAPH_BACKEND,
    ...(env.REGISTRY_GRAPH_STATE_FILE ? { graph_state_file: env.REGISTRY_GRAPH_STATE_FILE } : {}),
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
    ...(env.TESSERA_SIDECAR_URL ? { transparency_append_url: env.TESSERA_SIDECAR_URL } : {}),
    ...(env.TESSERA_SIDECAR_AUTH_TOKEN ? { transparency_append_token: env.TESSERA_SIDECAR_AUTH_TOKEN } : {}),
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
    ...(env.TRANSPARENCY_APPEND_LOG_ID ? { transparency_append_log_id: env.TRANSPARENCY_APPEND_LOG_ID } : {}),
    ...(env.TESSERA_LOG_PUBLIC_KEY ? { tessera_log_public_key_pem: env.TESSERA_LOG_PUBLIC_KEY } : {}),
  });
  const timeAwareCas = new FsCasArtifactStore(path.resolve(env.TIME_AWARE_OBJECTS_DIR));
  const timeAwareCore = buildTimeAwareCore({
    graph: buildGraphStore({
      backend: env.TIME_AWARE_GRAPH_BACKEND,
      ...(env.TIME_AWARE_GRAPH_STATE_FILE ? { state_file: env.TIME_AWARE_GRAPH_STATE_FILE } : {}),
      ...(env.TIME_AWARE_SPARQL_QUERY_URL ? { sparql_query_url: env.TIME_AWARE_SPARQL_QUERY_URL } : {}),
      ...(env.TIME_AWARE_SPARQL_UPDATE_URL ? { sparql_update_url: env.TIME_AWARE_SPARQL_UPDATE_URL } : {}),
      ...(env.TIME_AWARE_SPARQL_USERNAME ? { sparql_username: env.TIME_AWARE_SPARQL_USERNAME } : {}),
      ...(env.TIME_AWARE_SPARQL_PASSWORD ? { sparql_password: env.TIME_AWARE_SPARQL_PASSWORD } : {}),
    }),
    cas: timeAwareCas,
  });
  const agentRegistry = new GraphAgentRegistry(registryCore.service);
  const skillRegistry = new GraphSkillRegistry(registryCore.service);
  const audit = new FanoutAuditPublisher([new LogAuditPublisher(baseLogger), new SqliteAuditPublisher(dbProvider)]);
  const apiKeys = new SqliteApiKeyStore(dbProvider, env.API_KEY_PEPPER ? { pepper: env.API_KEY_PEPPER } : {});

  return {
    ready: dbProvider.ready,
    db: dbProvider,
    env,
    graph: registryCore.graph,
    registryCas: registryCore.cas,
    registryCore: registryCore.service,
    timeAwareCas,
    timeAwareCore: timeAwareCore.service,
    agentRegistry,
    skillRegistry,
    audit,
    apiKeys,
    apiKeyManagement: new ApiKeyUseCase(apiKeys, env.API_KEY_DEFAULT_TTL_DAYS),
    listAgents: new ListAgentsUseCase(agentRegistry),
    getAgent: new GetAgentUseCase(agentRegistry),
    createAgent: new CreateAgentUseCase(agentRegistry),
    agentPublication: new AgentPublicationUseCase(registryCore.service),
    agentLifecycle: new AgentLifecycleUseCase(registryCore.service),
    policyPackages: new PolicyPackageUseCase(registryCore.service),
    ontologyPackages: new OntologyPackageUseCase(registryCore.service),
    governanceLog: new GovernanceLogUseCase(registryCore.service),
    compile: new CompileUseCase(registryCore.service),
    deFactoTerms: new DeFactoTermsUseCase(registryCore.service),
    reviews: new ReviewsUseCase(registryCore.service),
    listPublicKeys: new ListPublicKeysUseCase(registryCore.service),
    getPublicKey: new GetPublicKeyUseCase(registryCore.service),
    createPublicKey: new CreatePublicKeyUseCase(registryCore.service),
    revokePublicKey: new RevokePublicKeyUseCase(registryCore.service),
    listTransparencyLogs: new ListTransparencyLogsUseCase(registryCore.service),
    getTransparencyLog: new GetTransparencyLogUseCase(registryCore.service),
    createTransparencyLog: new CreateTransparencyLogUseCase(registryCore.service),
    createTransparencyObservation: new CreateTransparencyObservationUseCase(registryCore.service),
    createTransparencyGossipEvent: new CreateTransparencyGossipEventUseCase(registryCore.service),
    createTransparencyWitness: new CreateTransparencyWitnessUseCase(registryCore.service),
    createTransparencyCheckpoint: new CreateTransparencyCheckpointUseCase(registryCore.service),
    getTransparencyLogTimeline: new GetTransparencyLogTimelineUseCase(registryCore.service),
    getTransparencyLogVerification: new GetTransparencyLogVerificationUseCase(registryCore.service),
    reconcilePublicationTransparency: new ReconcilePublicationTransparencyUseCase(registryCore.service),
    listSkills: new ListSkillsUseCase(skillRegistry),
    getSkill: new GetSkillUseCase(skillRegistry),
    createSkill: new CreateSkillUseCase(skillRegistry),
    readGraphSubgraph: new ReadGraphSubgraphUseCase(registryCore.graph),
    skillLifecycle: new SkillLifecycleUseCase(registryCore.service),
    timeAwareRegistry: new TimeAwareRegistryUseCase(timeAwareCore.service),
    advisories: new AdvisoriesUseCase(registryCore.service),
  };
}
