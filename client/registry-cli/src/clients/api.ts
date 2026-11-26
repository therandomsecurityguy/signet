import { readFile } from 'node:fs/promises';

import type { AgentCreatePlan, SkillSeedPlan } from '../types.js';

export class RegistryOperatorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RegistryOperatorApiError';
  }
}

export type RegistryOperatorApiClient = {
  createSkillDraft(plan: SkillSeedPlan, apiToken: string): Promise<{ version: number; artifactUrn?: string }>;
  setSkillTags(skillKey: string, tags: string[], apiToken: string): Promise<void>;
  setAgentTags(agentKey: string, tags: string[], apiToken: string): Promise<void>;
  validateSkillVersion(input: { skill_key: string; version: number; author: string; note?: string }, apiToken: string): Promise<void>;
  publishSkillVersion(input: { skill_key: string; version: number; author: string; note?: string }, apiToken: string): Promise<void>;
  certifySkillVersion(input: { skill_key: string; version: number; author: string; note?: string }, apiToken: string): Promise<void>;
  prepareAgentPublication(
    agentKey: string,
    version: number,
    input: { author: string; note?: string },
    apiToken: string,
  ): Promise<Record<string, unknown>>;
  publishAgentVersion(
    input: {
      agent_key: string;
      version: number;
      author: string;
      note?: string;
      prepared_publication_urn?: string;
      signatures?: Array<{
        signer: string;
        key_ref?: string;
        algorithm?: string;
        signature?: string;
        keyless_bundle?: Record<string, unknown>;
        signed_payload?: 'canonical_json' | 'canonical_rdf';
      }>;
    },
    apiToken: string,
  ): Promise<void>;
  certifyAgentVersion(
    input: { agent_key: string; version: number; author: string; note?: string },
    apiToken: string,
  ): Promise<void>;
  getActiveSkillVersion(skillKey: string, apiToken?: string): Promise<Record<string, unknown>>;
  getSkillVersion(skillKey: string, version: number, apiToken?: string): Promise<Record<string, unknown>>;
  getSkill(skillKey: string, apiToken?: string): Promise<Record<string, unknown>>;
  getActiveAgentVersion(agentKey: string, apiToken?: string): Promise<Record<string, unknown>>;
  getAgentVersions(agentKey: string, apiToken?: string): Promise<Record<string, unknown>>;
  createAgent(plan: AgentCreatePlan, apiToken: string): Promise<Record<string, unknown>>;
  getAgent(agentKey: string, apiToken: string): Promise<Record<string, unknown>>;
  createTrustedPublicKey(
    input: { key_ref: string; algorithm: string; public_key_pem: string; owner: string },
    apiToken: string,
  ): Promise<Record<string, unknown>>;
  createTransparencyLog(
    input: { log_id: string; origin: string; checkpoint_key_ref: string; log_type?: string; witness_quorum?: number },
    apiToken: string,
  ): Promise<Record<string, unknown>>;
  createTransparencyWitness(
    logId: string,
    input: { witness_id: string; key_ref: string; witness_type?: string },
    apiToken: string,
  ): Promise<Record<string, unknown>>;
  createTransparencyCheckpoint(
    logId: string,
    input: Record<string, unknown>,
    apiToken: string,
  ): Promise<Record<string, unknown>>;
  createTransparencyObservation(
    logId: string,
    input: Record<string, unknown>,
    apiToken: string,
  ): Promise<Record<string, unknown>>;
  createTransparencyGossipEvent(
    logId: string,
    input: Record<string, unknown>,
    apiToken: string,
  ): Promise<Record<string, unknown>>;
  getTransparencyLog(logId: string, apiToken: string): Promise<Record<string, unknown>>;
  getTransparencyLogVerification(logId: string, apiToken: string): Promise<Record<string, unknown>>;
  getTransparencyLogTimeline(logId: string, apiToken: string): Promise<Record<string, unknown>>;
  getSkillPublicationEnvelope(skillKey: string, version: number, apiToken?: string): Promise<Record<string, unknown>>;
  getAgentPublicationEnvelope(agentKey: string, version: number, apiToken?: string): Promise<Record<string, unknown>>;
  getSkillPublicationVerification(
    skillKey: string,
    version: number,
    apiToken?: string,
  ): Promise<Record<string, unknown>>;
  getAgentPublicationVerification(
    agentKey: string,
    version: number,
    apiToken?: string,
  ): Promise<Record<string, unknown>>;
  listPublicKeys(apiToken?: string): Promise<Record<string, unknown>>;
  getPublicKey(keyRef: string, apiToken?: string): Promise<Record<string, unknown>>;
  getArtifactBytes(sha256: string, apiToken?: string): Promise<{ bytes: Uint8Array; contentDigest?: string }>;
  createSkillDetachedSignature(
    skillKey: string,
    version: number,
    input: Record<string, unknown>,
    apiToken: string,
  ): Promise<Record<string, unknown>>;
};

export class HttpRegistryOperatorApiClient implements RegistryOperatorApiClient {
  constructor(private readonly deps: { apiOrigin: string; fetchFn?: typeof fetch; extraHeaders?: Record<string, string> }) {}

  async createSkillDraft(plan: SkillSeedPlan, apiToken: string): Promise<{ version: number; artifactUrn?: string }> {
    const artifactContent = await readFile(plan.draft.artifact_path, 'utf8');
    const result = await this.fetchJson<{ result: { skill_version: { properties: Record<string, unknown> }; artifacts: Array<{ artifact_urn: string }> } }>(
      `/v1/skills/${encodeURIComponent(plan.draft.skill_key)}/drafts`,
      {
        method: 'POST',
        body: JSON.stringify({
          author: plan.draft.author,
          ...(plan.draft.display_name ? { display_name: plan.draft.display_name } : {}),
          ...(plan.draft.description ? { description: plan.draft.description } : {}),
          ...(plan.draft.source_path ? { source_path: plan.draft.source_path } : {}),
          ...(plan.draft.commit_sha ? { commit_sha: plan.draft.commit_sha } : {}),
          ...(plan.draft.git_tag ? { git_tag: plan.draft.git_tag } : {}),
          ...(plan.draft.artifact_signature ? { artifact_signature: plan.draft.artifact_signature } : {}),
          ...(plan.draft.capability_claims?.length ? { capability_claims: plan.draft.capability_claims } : {}),
          ...(plan.draft.lineage ? { lineage: plan.draft.lineage } : {}),
          artifact: {
            content: artifactContent,
            encoding: 'utf8',
            media_type: plan.draft.artifact_media_type,
            original_path: plan.draft.source_path ?? plan.draft.artifact_path,
          },
        }),
      },
      apiToken,
    );

    const rawVersion = result.result.skill_version.properties['version'];
    const version = typeof rawVersion === 'number' ? rawVersion : Number(rawVersion ?? 0);
    return {
      version,
      artifactUrn: result.result.artifacts[0]?.artifact_urn,
    };
  }

  async setSkillTags(skillKey: string, tags: string[], apiToken: string): Promise<void> {
    await this.fetchJson(
      `/v1/skills/${encodeURIComponent(skillKey)}/tags`,
      { method: 'PUT', body: JSON.stringify({ tags }) },
      apiToken,
    );
  }

  async setAgentTags(agentKey: string, tags: string[], apiToken: string): Promise<void> {
    await this.fetchJson(
      `/v1/agents/${encodeURIComponent(agentKey)}/tags`,
      { method: 'PUT', body: JSON.stringify({ tags }) },
      apiToken,
    );
  }

  async validateSkillVersion(
    input: { skill_key: string; version: number; author: string; note?: string },
    apiToken: string,
  ): Promise<void> {
    await this.postSkillVersionAction('validate', input, apiToken);
  }

  async publishSkillVersion(
    input: {
      skill_key: string;
      version: number;
      author: string;
      note?: string;
      prepared_publication_urn?: string;
      signatures?: Array<{
        signer: string;
        key_ref?: string;
        algorithm?: string;
        signature?: string;
        keyless_bundle?: Record<string, unknown>;
        signed_payload?: 'canonical_json' | 'canonical_rdf';
      }>;
    },
    apiToken: string,
  ): Promise<void> {
    await this.postSkillVersionAction('publish', input, apiToken);
  }

  async prepareSkillPublication(
    skillKey: string,
    version: number,
    input: { author: string; note?: string },
    apiToken: string,
  ): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/skills/${encodeURIComponent(skillKey)}/versions/${version}/prepare-publication`,
      {
        method: 'POST',
        body: JSON.stringify({
          author: input.author,
          ...(input.note ? { note: input.note } : {}),
        }),
      },
      apiToken,
    );
  }

  async certifySkillVersion(
    input: { skill_key: string; version: number; author: string; note?: string },
    apiToken: string,
  ): Promise<void> {
    await this.postSkillVersionAction('certify', input, apiToken);
  }

  async prepareAgentPublication(
    agentKey: string,
    version: number,
    input: { author: string; note?: string },
    apiToken: string,
  ): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/agents/${encodeURIComponent(agentKey)}/versions/${version}/prepare-publication`,
      {
        method: 'POST',
        body: JSON.stringify({
          author: input.author,
          ...(input.note ? { note: input.note } : {}),
        }),
      },
      apiToken,
    );
  }

  async publishAgentVersion(
    input: {
      agent_key: string;
      version: number;
      author: string;
      note?: string;
      prepared_publication_urn?: string;
      signatures?: Array<{
        signer: string;
        key_ref?: string;
        algorithm?: string;
        signature?: string;
        keyless_bundle?: Record<string, unknown>;
        signed_payload?: 'canonical_json' | 'canonical_rdf';
      }>;
    },
    apiToken: string,
  ): Promise<void> {
    await this.postAgentVersionAction('publish', input, apiToken);
  }

  async certifyAgentVersion(
    input: { agent_key: string; version: number; author: string; note?: string },
    apiToken: string,
  ): Promise<void> {
    await this.postAgentVersionAction('certify', input, apiToken);
  }

  private async postAgentVersionAction(
    action: 'publish' | 'certify',
    input: {
      agent_key: string;
      version: number;
      author: string;
      note?: string;
      prepared_publication_urn?: string;
      signatures?: Array<{
        signer: string;
        key_ref?: string;
        algorithm?: string;
        signature?: string;
        keyless_bundle?: Record<string, unknown>;
        signed_payload?: 'canonical_json' | 'canonical_rdf';
      }>;
    },
    apiToken: string,
  ): Promise<void> {
    await this.fetchJson(
      `/v1/agents/${encodeURIComponent(input.agent_key)}/versions/${input.version}/${action}`,
      {
        method: 'POST',
        body: JSON.stringify({
          author: input.author,
          ...(input.note ? { note: input.note } : {}),
          ...(input.prepared_publication_urn
            ? { prepared_publication_urn: input.prepared_publication_urn }
            : {}),
          ...(input.signatures ? { signatures: input.signatures } : {}),
        }),
      },
      apiToken,
    );
  }

  async getActiveSkillVersion(skillKey: string, apiToken?: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(`/v1/skills/${encodeURIComponent(skillKey)}/active`, undefined, apiToken);
  }

  async getSkillVersion(skillKey: string, version: number, apiToken?: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/skills/${encodeURIComponent(skillKey)}/versions/${version}`,
      undefined,
      apiToken,
    );
  }

  async getSkill(skillKey: string, apiToken?: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(`/v1/skills/${encodeURIComponent(skillKey)}`, undefined, apiToken);
  }

  async getActiveAgentVersion(agentKey: string, apiToken?: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(`/v1/agents/${encodeURIComponent(agentKey)}/active`, undefined, apiToken);
  }

  async getAgentVersions(agentKey: string, apiToken?: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(`/v1/agents/${encodeURIComponent(agentKey)}/versions`, undefined, apiToken);
  }

  async createAgent(plan: AgentCreatePlan, apiToken: string): Promise<Record<string, unknown>> {
    const artifactContent = plan.artifact_path ? await readFile(plan.artifact_path, 'utf8') : null;
    return await this.fetchJson(
      '/v1/agents',
      {
        method: 'POST',
        body: JSON.stringify({
          agent_key: plan.agent_key,
          ...(plan.harness_name ? { harness_name: plan.harness_name } : {}),
          ...(plan.display_name ? { display_name: plan.display_name } : {}),
          ...(plan.description ? { description: plan.description } : {}),
          ...(plan.source_path ? { source_path: plan.source_path } : {}),
          ...(artifactContent
            ? {
                artifact: {
                  content: artifactContent,
                  encoding: 'utf8',
                  media_type: plan.artifact_media_type ?? 'text/markdown',
                  original_path: plan.source_path ?? plan.artifact_path,
                },
              }
            : {}),
          ...(plan.skill_refs.length > 0 ? { skill_refs: plan.skill_refs } : {}),
        }),
      },
      apiToken,
    );
  }

  async getAgent(agentKey: string, apiToken: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(`/v1/agents/${encodeURIComponent(agentKey)}`, undefined, apiToken);
  }

  async createTrustedPublicKey(
    input: { key_ref: string; algorithm: string; public_key_pem: string; owner: string },
    apiToken: string,
  ): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      '/v1/public-keys',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      apiToken,
    );
  }

  async createTransparencyLog(
    input: { log_id: string; origin: string; checkpoint_key_ref: string; log_type?: string; witness_quorum?: number },
    apiToken: string,
  ): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      '/v1/transparency-logs',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      apiToken,
    );
  }

  async createTransparencyWitness(
    logId: string,
    input: { witness_id: string; key_ref: string; witness_type?: string },
    apiToken: string,
  ): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/transparency-logs/${encodeURIComponent(logId)}/witnesses`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      apiToken,
    );
  }

  async createTransparencyCheckpoint(logId: string, input: Record<string, unknown>, apiToken: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/transparency-logs/${encodeURIComponent(logId)}/checkpoints`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      apiToken,
    );
  }

  async createTransparencyObservation(logId: string, input: Record<string, unknown>, apiToken: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/transparency-logs/${encodeURIComponent(logId)}/observations`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      apiToken,
    );
  }

  async createTransparencyGossipEvent(logId: string, input: Record<string, unknown>, apiToken: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/transparency-logs/${encodeURIComponent(logId)}/gossip-events`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      apiToken,
    );
  }

  async getTransparencyLog(logId: string, apiToken: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(`/v1/transparency-logs/${encodeURIComponent(logId)}`, undefined, apiToken);
  }

  async getTransparencyLogVerification(logId: string, apiToken: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(`/v1/transparency-logs/${encodeURIComponent(logId)}/verification`, undefined, apiToken);
  }

  async getTransparencyLogTimeline(logId: string, apiToken: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(`/v1/transparency-logs/${encodeURIComponent(logId)}/timeline`, undefined, apiToken);
  }

  async getSkillPublicationEnvelope(
    skillKey: string,
    version: number,
    apiToken?: string,
  ): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/skills/${encodeURIComponent(skillKey)}/versions/${version}/publication-envelope`,
      undefined,
      apiToken,
    );
  }

  async getAgentPublicationEnvelope(
    agentKey: string,
    version: number,
    apiToken?: string,
  ): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/agents/${encodeURIComponent(agentKey)}/versions/${version}/publication-envelope`,
      undefined,
      apiToken,
    );
  }

  async getSkillPublicationVerification(
    skillKey: string,
    version: number,
    apiToken?: string,
  ): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/skills/${encodeURIComponent(skillKey)}/versions/${version}/verification`,
      undefined,
      apiToken,
    );
  }

  async getSkillProvenance(skillKey: string, version: number, apiToken?: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/skills/${encodeURIComponent(skillKey)}/versions/${version}/provenance`,
      undefined,
      apiToken,
    );
  }

  async getAgentProvenance(agentKey: string, version: number, apiToken?: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/agents/${encodeURIComponent(agentKey)}/versions/${version}/provenance`,
      undefined,
      apiToken,
    );
  }

  async getSkillReportSignatures(skillKey: string, version: number, apiToken?: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/skills/${encodeURIComponent(skillKey)}/versions/${version}/report-signatures`,
      undefined,
      apiToken,
    );
  }

  async getAgentReportSignatures(agentKey: string, version: number, apiToken?: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/agents/${encodeURIComponent(agentKey)}/versions/${version}/report-signatures`,
      undefined,
      apiToken,
    );
  }

  async getAgentPublicationVerification(
    agentKey: string,
    version: number,
    apiToken?: string,
  ): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/agents/${encodeURIComponent(agentKey)}/versions/${version}/verification`,
      undefined,
      apiToken,
    );
  }

  async listPublicKeys(apiToken?: string): Promise<Record<string, unknown>> {
    return await this.fetchJson('/v1/public-keys', undefined, apiToken);
  }

  async getPublicKey(keyRef: string, apiToken?: string): Promise<Record<string, unknown>> {
    return await this.fetchJson(`/v1/public-keys/${encodeURIComponent(keyRef)}`, undefined, apiToken);
  }

  async getArtifactBytes(sha256: string, apiToken?: string): Promise<{ bytes: Uint8Array; contentDigest?: string }> {
    const headers = this.buildHeaders(undefined, apiToken);
    const response = await (this.deps.fetchFn ?? fetch)(new URL(`/v1/artifacts/${sha256}`, this.deps.apiOrigin), {
      headers,
    });
    if (!response.ok) {
      const errorBody = (await response.json().catch(() => undefined)) as
        | { error?: { code?: string; message?: string } }
        | undefined;
      throw new RegistryOperatorApiError(
        errorBody?.error?.message ?? `Registry API request failed (${response.status})`,
        response.status,
        errorBody?.error?.code,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentDigest = response.headers.get('content-digest');
    return {
      bytes,
      ...(contentDigest ? { contentDigest } : {}),
    };
  }

  async createSkillDetachedSignature(
    skillKey: string,
    version: number,
    input: Record<string, unknown>,
    apiToken: string,
  ): Promise<Record<string, unknown>> {
    return await this.fetchJson(
      `/v1/skills/${encodeURIComponent(skillKey)}/versions/${version}/signatures`,
      { method: 'POST', body: JSON.stringify(input) },
      apiToken,
    );
  }

  private async postSkillVersionAction(
    action: 'validate' | 'publish' | 'certify',
    input: {
      skill_key: string;
      version: number;
      author: string;
      note?: string;
      prepared_publication_urn?: string;
      signatures?: Array<{
        signer: string;
        key_ref?: string;
        algorithm?: string;
        signature?: string;
        keyless_bundle?: Record<string, unknown>;
        signed_payload?: 'canonical_json' | 'canonical_rdf';
      }>;
    },
    apiToken: string,
  ) {
    await this.fetchJson(
      `/v1/skills/${encodeURIComponent(input.skill_key)}/versions/${input.version}/${action}`,
      {
        method: 'POST',
        body: JSON.stringify({
          author: input.author,
          ...(input.note ? { note: input.note } : {}),
          ...(input.prepared_publication_urn
            ? { prepared_publication_urn: input.prepared_publication_urn }
            : {}),
          ...(input.signatures ? { signatures: input.signatures } : {}),
        }),
      },
      apiToken,
    );
  }

  private buildHeaders(init?: RequestInit, apiToken?: string): Headers {
    const headers = new Headers(init?.headers);
    headers.set('accept', 'application/json');
    if (init?.body) {
      headers.set('content-type', 'application/json');
    }
    if (apiToken) {
      headers.set('authorization', `Bearer ${apiToken}`);
    }
    for (const [key, value] of Object.entries(this.deps.extraHeaders ?? {})) {
      headers.set(key, value);
    }
    return headers;
  }

  private async fetchJson<T>(apiPath: string, init?: RequestInit, apiToken?: string): Promise<T> {
    const headers = this.buildHeaders(init, apiToken);

    const response = await (this.deps.fetchFn ?? fetch)(new URL(apiPath, this.deps.apiOrigin), {
      ...init,
      headers,
    });
    if (!response.ok) {
      const errorBody = (await response.json().catch(() => undefined)) as
        | { error?: { code?: string; message?: string } }
        | undefined;
      throw new RegistryOperatorApiError(
        errorBody?.error?.message ?? `Registry API request failed (${response.status})`,
        response.status,
        errorBody?.error?.code,
      );
    }
    return (await response.json()) as T;
  }
}
