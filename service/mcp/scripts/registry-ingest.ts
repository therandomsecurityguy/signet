import * as path from 'node:path';

import { buildRegistryCore } from '../../registry/application/build-registry-core.js';
import { ingestRegistry } from '../../registry/domain/signet/db/graph/freeform/registry/ingest.js';
import { loadEnv } from '../src/infrastructure/config/env.js';

function parseArgs(argv: string[]) {
  const agentRoots: string[] = [];
  const skillRoots: string[] = [];
  let objectsDir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--scan-root' && next) {
      agentRoots.push(next);
      i += 1;
      continue;
    }
    if (a === '--agent-root' && next) {
      agentRoots.push(next);
      i += 1;
      continue;
    }
    if (a === '--skill-root' && next) {
      skillRoots.push(next);
      i += 1;
      continue;
    }
    if (a === '--objects-dir' && next) {
      objectsDir = next;
      i += 1;
      continue;
    }
  }

  return { agentRoots, skillRoots, objectsDir };
}

async function main() {
  const { agentRoots, skillRoots, objectsDir } = parseArgs(process.argv.slice(2));
  const env = loadEnv();

  const defaultRoots = [
    { kind: 'agent' as const, dir: path.resolve('agent') },
    { kind: 'skill' as const, dir: path.resolve('skills') },
  ];

  const roots = [
    ...(agentRoots.length > 0
      ? agentRoots.map((dir) => ({ kind: 'agent' as const, dir: path.resolve(dir) }))
      : defaultRoots.filter((root) => root.kind === 'agent')),
    ...(skillRoots.length > 0
      ? skillRoots.map((dir) => ({ kind: 'skill' as const, dir: path.resolve(dir) }))
      : defaultRoots.filter((root) => root.kind === 'skill')),
  ];

  const resolvedObjectsDir =
    objectsDir ? path.resolve(objectsDir) : path.resolve(env.REGISTRY_OBJECTS_DIR);
  const registryCore = buildRegistryCore({
    graph_backend: env.REGISTRY_GRAPH_BACKEND,
    ...(env.REGISTRY_GRAPH_STATE_FILE ? { graph_state_file: path.resolve(env.REGISTRY_GRAPH_STATE_FILE) } : {}),
    ...(env.REGISTRY_SPARQL_QUERY_URL ? { sparql_query_url: env.REGISTRY_SPARQL_QUERY_URL } : {}),
    ...(env.REGISTRY_SPARQL_UPDATE_URL ? { sparql_update_url: env.REGISTRY_SPARQL_UPDATE_URL } : {}),
    ...(env.REGISTRY_SPARQL_USERNAME ? { sparql_username: env.REGISTRY_SPARQL_USERNAME } : {}),
    ...(env.REGISTRY_SPARQL_PASSWORD ? { sparql_password: env.REGISTRY_SPARQL_PASSWORD } : {}),
    artifact_backend: env.REGISTRY_ARTIFACT_BACKEND,
    ...(env.REGISTRY_ARTIFACT_BACKEND === 'fs'
      ? { objects_dir: resolvedObjectsDir }
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
  });

  const res = await ingestRegistry({
    roots,
    cas: registryCore.cas,
    graph: registryCore.graph,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        graph_backend: env.REGISTRY_GRAPH_BACKEND,
        artifact_backend: env.REGISTRY_ARTIFACT_BACKEND,
        ...(env.REGISTRY_ARTIFACT_BACKEND === 'fs' ? { objects_dir: resolvedObjectsDir } : {}),
        ...(env.REGISTRY_S3_BUCKET ? { s3_bucket: env.REGISTRY_S3_BUCKET } : {}),
        ...(env.REGISTRY_S3_PREFIX ? { s3_prefix: env.REGISTRY_S3_PREFIX } : {}),
        roots,
        ...res,
      },
      null,
      2,
    ),
  );
}

await main();

