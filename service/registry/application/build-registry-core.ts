import {
  FsCasArtifactStore,
  S3CasArtifactStore,
  type ArtifactStore,
} from '../domain/signet/db/graph/freeform/registry/artifact-store.js';
import type { GraphStore } from '../domain/signet/db/graph/freeform/registry/graph-store.js';
import { InMemoryGraphStore } from '../domain/signet/db/graph/freeform/registry/graph-store.js';
import { JsonFileGraphStore } from '../domain/signet/db/graph/freeform/registry/json-file-graph-store.js';
import { SparqlGraphStore } from '../domain/signet/db/graph/freeform/registry/sparql-graph-store.js';
import { DefaultRegistryService } from './services/default-registry-service.js';
import { fetchWithRetry } from './services/fetch-with-retry.js';
import { HeuristicLlmValidator, HttpLlmValidator, OpenAiCompatibleLlmValidator } from './services/llm-validator.js';

export type RegistryCoreConfig = {
  graph_backend: 'memory' | 'json_file' | 'sparql';
  graph_state_file?: string;
  sparql_query_url?: string;
  sparql_update_url?: string;
  sparql_username?: string;
  sparql_password?: string;
  artifact_backend?: 'fs' | 's3';
  objects_dir?: string;
  // Whether CAS reads recompute the object digest. `warn` (default) reports
  // a mismatch via `digest_verified`; `enforce` fails the read, so tampered
  // bytes can never be silently used.
  artifact_integrity_mode?: 'warn' | 'enforce';
  s3_bucket?: string;
  s3_prefix?: string;
  s3_region?: string;
  s3_endpoint?: string;
  s3_force_path_style?: boolean;
  s3_access_key_id?: string;
  s3_secret_access_key?: string;
  s3_session_token?: string;
  transparency_append_url?: string;
  // Shared bearer token presented to the Tessera sidecar on append and
  // reconciliation calls when the sidecar enforces auth.
  transparency_append_token?: string;
  // Optional SHACL-AF runtime sidecar (service/shacl-runtime): executes
  // rules, SPARQL functions, and custom constraint components. Authored
  // policies using those constructs fail closed without it.
  shacl_runtime_url?: string;
  shacl_runtime_token?: string;
  // Keyless (sigstore) signature trust policy: PEM files for trusted roots
  // plus allowed OIDC issuers and subject patterns.
  keyless?: import('./services/keyless-verification.js').KeylessTrustPolicy;
  transparency_append_log_id?: string;
  // PEM of the native companion log's checkpoint key, used to verify signed
  // checkpoints during transparency reconciliation (legacy key identity).
  tessera_log_public_key_pem?: string;
  // Spec transparency-dev verifier key for the companion log's Ed25519
  // checkpoint key; preferred over the PEM when set.
  tessera_log_note_verifier?: string;
  llm_validator_url?: string;
  llm_validator_model?: string;
  /** Advisory backend selection: generic JSON seam or OpenAI-compatible Chat Completions. */
  llm_validator_provider?: 'http' | 'openai-compatible';
  llm_validator_api_key?: string;
  llm_validator_json_mode?: boolean;
};

export function buildRegistryCore(cfg: RegistryCoreConfig) {
  const graph = buildGraphStore(cfg);
  const cas = buildArtifactStore(cfg);
  const transparencyAppendUrl = cfg.transparency_append_url;
  const transparencyAppendLogId = cfg.transparency_append_log_id;
  const transparencyAuthHeaders: Record<string, string> = cfg.transparency_append_token
    ? { authorization: `Bearer ${cfg.transparency_append_token}` }
    : {};
  const transparencyReconciler =
    transparencyAppendUrl &&
    transparencyAppendLogId &&
    (cfg.tessera_log_public_key_pem || cfg.tessera_log_note_verifier)
      ? {
          ...(cfg.tessera_log_public_key_pem ? { public_key_pem: cfg.tessera_log_public_key_pem } : {}),
          ...(cfg.tessera_log_note_verifier ? { note_verifier_key: cfg.tessera_log_note_verifier } : {}),
          log_id: transparencyAppendLogId,
          fetchLogEntry: async ({ log_id, entry_index }: { log_id: string; entry_index: number }) => {
            const response = await fetchWithRetry(
              new URL(`/v1/logs/${encodeURIComponent(log_id)}/entries/${entry_index}`, transparencyAppendUrl),
              { headers: { accept: 'application/json', ...transparencyAuthHeaders } },
            );
            if (!response.ok) {
              throw new Error(`Transparency log entry fetch failed (${response.status})`);
            }
            return (await response.json()) as Record<string, unknown>;
          },
          fetchLogState: async ({ log_id }: { log_id: string }) => {
            const response = await fetchWithRetry(
              new URL(`/v1/logs/${encodeURIComponent(log_id)}`, transparencyAppendUrl),
              { headers: { accept: 'application/json', ...transparencyAuthHeaders } },
            );
            if (!response.ok) {
              throw new Error(`Transparency log state fetch failed (${response.status})`);
            }
            return (await response.json()) as Record<string, unknown>;
          },
        }
      : undefined;
  // Advisory LLM validation: deterministic heuristic validator by
  // default; a model endpoint can be wired via configuration (generic
  // HTTP seam or OpenAI-compatible Chat Completions) with the heuristic
  // as fallback so validation never blocks on the model.
  const heuristicValidator = new HeuristicLlmValidator();
  const llmValidator = cfg.llm_validator_url
    ? cfg.llm_validator_provider === 'openai-compatible'
      ? new OpenAiCompatibleLlmValidator({
          base_url: cfg.llm_validator_url,
          ...(cfg.llm_validator_model ? { model: cfg.llm_validator_model } : {}),
          ...(cfg.llm_validator_api_key ? { api_key: cfg.llm_validator_api_key } : {}),
          ...(cfg.llm_validator_json_mode ? { json_mode: true } : {}),
          fallback: heuristicValidator,
        })
      : new HttpLlmValidator({
          url: cfg.llm_validator_url,
          ...(cfg.llm_validator_model ? { model: cfg.llm_validator_model } : {}),
          fallback: heuristicValidator,
        })
    : heuristicValidator;
  const service = new DefaultRegistryService({
    graph,
    cas,
    llmValidator,
    ...(cfg.keyless ? { keyless: cfg.keyless } : {}),
    ...(cfg.shacl_runtime_url
      ? {
          shaclRuntime: {
            url: cfg.shacl_runtime_url,
            ...(cfg.shacl_runtime_token ? { token: cfg.shacl_runtime_token } : {}),
          },
        }
      : {}),
    ...(transparencyReconciler ? { transparencyReconciler } : {}),
    ...(transparencyAppendUrl && transparencyAppendLogId
      ? {
          appendIntentPublisher: {
            publishAppendIntent: async (input) => {
              const response = await fetchWithRetry(new URL('/v1/append-intents', transparencyAppendUrl), {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  accept: 'application/json',
                  ...transparencyAuthHeaders,
                },
                body: JSON.stringify({
                  log_id: transparencyAppendLogId,
                  ...input,
                }),
              });
              if (!response.ok) {
                throw new Error(`Transparency append sidecar request failed (${response.status})`);
              }
              const payload = (await response.json()) as Record<string, unknown>;
              const request_id = typeof payload['request_id'] === 'string' ? payload['request_id'] : undefined;
              const request_record_sha256 = typeof payload['sha256'] === 'string' ? payload['sha256'] : undefined;
              const s3_uri = typeof payload['s3_uri'] === 'string' ? payload['s3_uri'] : undefined;
              const tessera_submission_status =
                payload['tessera_submission_status'] === 'submitted' || payload['tessera_submission_status'] === 'staged_only'
                  ? payload['tessera_submission_status']
                  : undefined;
              const tessera_submission_error =
                typeof payload['tessera_submission_error'] === 'string' ? payload['tessera_submission_error'] : undefined;
              const tessera_entry_index = typeof payload['tessera_entry_index'] === 'number' ? payload['tessera_entry_index'] : undefined;
              const tessera_add_url = typeof payload['tessera_add_url'] === 'string' ? payload['tessera_add_url'] : undefined;
              const tessera_checkpoint_url =
                typeof payload['tessera_checkpoint_url'] === 'string' ? payload['tessera_checkpoint_url'] : undefined;
              const tessera_checkpoint_tree_size =
                typeof payload['tessera_checkpoint_tree_size'] === 'number'
                  ? payload['tessera_checkpoint_tree_size']
                  : undefined;
              const tessera_checkpoint_root_hash =
                typeof payload['tessera_checkpoint_root_hash'] === 'string'
                  ? payload['tessera_checkpoint_root_hash']
                  : undefined;
              const tessera_checkpoint_note_sha256 =
                typeof payload['tessera_checkpoint_note_sha256'] === 'string'
                  ? payload['tessera_checkpoint_note_sha256']
                  : undefined;
              const bucket = typeof payload['bucket'] === 'string' ? payload['bucket'] : undefined;
              const key = typeof payload['key'] === 'string' ? payload['key'] : undefined;
              if (!request_id || !request_record_sha256 || !s3_uri) {
                throw new Error('Transparency append sidecar response was missing required fields.');
              }
              return {
                log_id: transparencyAppendLogId,
                source_type: input.source_type,
                request_id,
                request_record_sha256,
                s3_uri,
                ...(tessera_submission_status ? { tessera_submission_status } : {}),
                ...(tessera_submission_error ? { tessera_submission_error } : {}),
                ...(typeof tessera_entry_index === 'number' ? { tessera_entry_index } : {}),
                ...(tessera_add_url ? { tessera_add_url } : {}),
                ...(tessera_checkpoint_url ? { tessera_checkpoint_url } : {}),
                ...(typeof tessera_checkpoint_tree_size === 'number'
                  ? { tessera_checkpoint_tree_size }
                  : {}),
                ...(tessera_checkpoint_root_hash ? { tessera_checkpoint_root_hash } : {}),
                ...(tessera_checkpoint_note_sha256 ? { tessera_checkpoint_note_sha256 } : {}),
                ...(bucket ? { bucket } : {}),
                ...(key ? { key } : {}),
              };
            },
          },
        }
      : {}),
  });

  return {
    graph,
    cas,
    service,
  };
}

function buildArtifactStore(cfg: RegistryCoreConfig): ArtifactStore {
  if (cfg.artifact_backend === 's3') {
    if (!cfg.s3_bucket) {
      throw new Error('s3_bucket is required when artifact_backend=s3');
    }
    return new S3CasArtifactStore({
      bucket: cfg.s3_bucket,
      ...(cfg.s3_prefix ? { prefix: cfg.s3_prefix } : {}),
      ...(cfg.s3_region ? { region: cfg.s3_region } : {}),
      ...(cfg.s3_endpoint ? { endpoint: cfg.s3_endpoint } : {}),
      ...(typeof cfg.s3_force_path_style === 'boolean' ? { force_path_style: cfg.s3_force_path_style } : {}),
      ...(cfg.s3_access_key_id ? { access_key_id: cfg.s3_access_key_id } : {}),
      ...(cfg.s3_secret_access_key ? { secret_access_key: cfg.s3_secret_access_key } : {}),
      ...(cfg.s3_session_token ? { session_token: cfg.s3_session_token } : {}),
      ...(cfg.artifact_integrity_mode ? { integrity_mode: cfg.artifact_integrity_mode } : {}),
    });
  }
  if (!cfg.objects_dir) {
    throw new Error('objects_dir is required when artifact_backend=fs');
  }
  return new FsCasArtifactStore(cfg.objects_dir, {
    ...(cfg.artifact_integrity_mode ? { integrity_mode: cfg.artifact_integrity_mode } : {}),
  });
}

function buildGraphStore(cfg: RegistryCoreConfig): GraphStore {
  switch (cfg.graph_backend) {
    case 'memory':
      return new InMemoryGraphStore();
    case 'sparql':
      if (!cfg.sparql_query_url) {
        throw new Error('sparql_query_url is required when graph_backend=sparql');
      }
      return new SparqlGraphStore({
        query_url: cfg.sparql_query_url,
        ...(cfg.sparql_update_url ? { update_url: cfg.sparql_update_url } : {}),
        ...(cfg.sparql_username ? { username: cfg.sparql_username } : {}),
        ...(cfg.sparql_password ? { password: cfg.sparql_password } : {}),
      });
    case 'json_file':
    default:
      if (!cfg.graph_state_file) {
        throw new Error('graph_state_file is required when graph_backend=json_file');
      }
      return new JsonFileGraphStore({ state_file: cfg.graph_state_file });
  }
}
