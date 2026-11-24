export type AgentSummary = {
  agent_urn: string;
  agent_key: string;
  harness_name?: string;
  display_name?: string;
  description?: string;
  source_path?: string;
};

export type SkillSummary = {
  skill_urn: string;
  skill_key: string;
  display_name?: string;
  description?: string;
  source_path?: string;
};

export type AgentDetails = {
  agent: {
    urn: string;
    properties: Record<string, unknown>;
  };
  active_version?: {
    agent_version: {
      urn: string;
      properties: Record<string, unknown>;
    };
    skills: Array<{
      skill_urn: string;
      skill_key?: string;
    }>;
    artifacts: Array<{
      artifact_urn: string;
      sha256?: string;
    }>;
    harnesses: Array<{
      harness_urn: string;
      harness_name?: string;
    }>;
  };
  skills: Array<{
    skill_urn: string;
    skill_key?: string;
  }>;
  artifacts: Array<{
    artifact_urn: string;
    sha256?: string;
  }>;
  harnesses: Array<{
    harness_urn: string;
    harness_name?: string;
  }>;
};

export type SkillDetails = {
  skill: {
    urn: string;
    properties: Record<string, unknown>;
  };
  active_version?: SkillVersionDetails;
  artifacts: Array<{
    artifact_urn: string;
    sha256?: string;
  }>;
};

export type GovernanceArtifactRef = {
  role: 'policy_package' | 'validation_report' | 'certification_evidence' | 'review_evidence';
  artifact_urn: string;
  sha256?: string;
};

export type SkillVersionDetails = {
  skill_version: {
    urn: string;
    properties: Record<string, unknown>;
  };
  artifacts: Array<{
    artifact_urn: string;
    sha256?: string;
  }>;
  upstream_versions: Array<{
    skill_version_urn: string;
  }>;
  governance_artifacts?: GovernanceArtifactRef[];
};

export type AgentVersionDetails = {
  agent_version: {
    urn: string;
    properties: Record<string, unknown>;
  };
  skills: Array<{
    skill_urn: string;
    skill_key?: string;
  }>;
  artifacts: Array<{
    artifact_urn: string;
    sha256?: string;
  }>;
  harnesses: Array<{
    harness_urn: string;
    harness_name?: string;
  }>;
  governance_artifacts?: GovernanceArtifactRef[];
};

export type PendingReviewItem = {
  publication_urn: string;
  entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
  logical_key: string;
  lifecycle_status: string;
  review_status: string;
  policy_version?: string;
};

export type ReviewVersionInput = {
  decision: 'approve' | 'reject';
  author: string;
  review_role?: string;
  note?: string;
};

export type ReviewOperationResult = {
  task: {
    task: {
      urn: string;
      properties: Record<string, unknown>;
    };
    targets: Array<{
      target_urn: string;
    }>;
  };
  result: SkillVersionDetails | AgentVersionDetails;
};

export type ProvenanceActivity = {
  task_urn: string;
  operation: string;
  status: string;
  occurred_at?: string;
  actor?: string;
  used: Array<{ urn: string; entity_type?: string }>;
  associated_agents: Array<{ urn: string; agent_name?: string; role?: string }>;
};

export type ProvenanceRecord = {
  entity: { urn: string; entity_type: string };
  derivation_chain: Array<{
    version_urn: string;
    was_derived_from: string[];
    activities: ProvenanceActivity[];
  }>;
  replay: Array<{
    occurred_at?: string;
    operation: string;
    actor?: string;
    version_urn: string;
    status: string;
  }>;
  evidence: {
    canonical_rdf_sha256: string;
    canonical_rdf_artifact_urn: string;
  };
  provenance_signatures: Array<{
    signer: string;
    verdict: 'valid' | 'invalid' | 'stale';
    signed_at: string;
  }>;
  all_provenance_signatures_verified: boolean;
  current_provenance_signed: boolean;
};

export type GraphNodeView = {
  id: string;
  urn: string;
  entity_type: string;
  label: string;
  properties: Record<string, unknown>;
};

export type GraphEdgeView = {
  id: string;
  from_urn: string;
  to_urn: string;
  predicate: string;
  label: string;
};

export type GraphSubgraph = {
  root_urn: string;
  depth: number;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
};

export type CreateAgentInput = {
  agent_key: string;
  harness_name?: string;
  display_name?: string;
  description?: string;
  source_path?: string;
  artifact?: {
    content: string;
    encoding: 'utf8' | 'base64';
    media_type?: string;
    original_path?: string;
  };
  skill_refs?: Array<{
    skill_urn?: string;
    skill_key?: string;
  }>;
};

export type CreateSkillInput = {
  skill_key: string;
  display_name?: string;
  description?: string;
  source_path?: string;
  artifact?: {
    content: string;
    encoding: 'utf8' | 'base64';
    media_type?: string;
    original_path?: string;
  };
};

export type CreateSkillDraftInput = {
  author: string;
  display_name?: string;
  description?: string;
  source_path?: string;
  commit_sha?: string;
  git_tag?: string;
  artifact_signature?: string;
  artifact: {
    content: string;
    encoding: 'utf8' | 'base64';
    media_type?: string;
    original_path?: string;
  };
};

export type SkillVersionOperationInput = {
  author: string;
  note?: string;
};

export type SkillLifecycleOperationResult = {
  task: {
    task: {
      urn: string;
      properties: Record<string, unknown>;
    };
    targets: Array<{
      target_urn: string;
    }>;
  };
  result: SkillVersionDetails;
};

export type RegistryApiSession = {
  auth: {
    mode: 'api_key' | 'okta' | 'dual';
    okta_mode: 'mock' | 'real';
  };
  principal: {
    type: 'api_key' | 'okta_user';
    id: string;
    email?: string;
    display_name?: string;
    auth_method: 'api_key' | 'okta_access_token';
    scopes: string[];
    groups: string[];
  };
};

export class RegistryApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RegistryApiError';
  }
}

export type OntologyPackageDetails = {
  artifact_urn: string;
  sha256: string;
  ontology_version: string;
  ontology_kind: 'registry_shape' | 'skill_area';
  created_by: string;
  created_at: string;
  description?: string;
  ontology: unknown;
};

export type DeFactoTermDetails = {
  urn: string;
  term: string;
  status: 'candidate' | 'promoted' | 'rejected';
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  example_publication_urns: string[];
  reviewed_by?: string;
  reviewed_at?: string;
  promoted_into_ontology_version?: string;
};

export type ReviewDeFactoTermInput = {
  action: 'promote' | 'reject';
  author: string;
  source_ontology_version?: string;
  target_ontology_version?: string;
};

export interface RegistryApiClient {
  health(): Promise<{ ok: boolean }>;
  getSession(apiToken: string): Promise<RegistryApiSession>;
  getGraphSubgraph(rootUrn: string, depth: number): Promise<GraphSubgraph>;
  listAgents(opts?: { limit?: number; offset?: number }): Promise<{ agents: AgentSummary[] }>;
  getAgent(agentKey: string): Promise<AgentDetails>;
  createAgent(input: CreateAgentInput, apiToken: string): Promise<AgentDetails>;
  listSkills(opts?: { limit?: number; offset?: number }): Promise<{ skills: SkillSummary[] }>;
  getSkill(skillKey: string): Promise<SkillDetails>;
  createSkill(input: CreateSkillInput, apiToken: string): Promise<SkillDetails>;
  listSkillVersions(skillKey: string): Promise<{ versions: SkillVersionDetails[] }>;
  getActiveSkillVersion(skillKey: string): Promise<SkillVersionDetails | null>;
  createSkillDraft(skillKey: string, input: CreateSkillDraftInput, apiToken: string): Promise<SkillLifecycleOperationResult>;
  validateSkillVersion(
    skillKey: string,
    version: number,
    input: SkillVersionOperationInput,
    apiToken: string,
  ): Promise<SkillLifecycleOperationResult>;
  publishSkillVersion(
    skillKey: string,
    version: number,
    input: SkillVersionOperationInput,
    apiToken: string,
  ): Promise<SkillLifecycleOperationResult>;
  promoteSkillVersion(
    skillKey: string,
    version: number,
    input: SkillVersionOperationInput,
    apiToken: string,
  ): Promise<SkillLifecycleOperationResult>;
  deprecateSkillVersion(
    skillKey: string,
    version: number,
    input: SkillVersionOperationInput,
    apiToken: string,
  ): Promise<SkillLifecycleOperationResult>;
  certifySkillVersion(
    skillKey: string,
    version: number,
    input: SkillVersionOperationInput,
    apiToken: string,
  ): Promise<SkillLifecycleOperationResult>;
  listOntologyPackages(): Promise<{ ontology_packages: OntologyPackageDetails[] }>;
  listDeFactoTerms(opts?: { status?: DeFactoTermDetails['status'] }): Promise<{ terms: DeFactoTermDetails[] }>;
  reviewDeFactoTerm(
    term: string,
    input: ReviewDeFactoTermInput,
    apiToken: string,
  ): Promise<DeFactoTermDetails>;
  listPendingReviews(): Promise<{ pending: PendingReviewItem[] }>;
  listAgentVersions(agentKey: string): Promise<{ versions: AgentVersionDetails[] }>;
  reviewSkillVersion(
    skillKey: string,
    version: number,
    input: ReviewVersionInput,
    apiToken: string,
  ): Promise<ReviewOperationResult>;
  reviewAgentVersion(
    agentKey: string,
    version: number,
    input: ReviewVersionInput,
    apiToken: string,
  ): Promise<ReviewOperationResult>;
  getArtifactJson(sha256: string): Promise<unknown | null>;
  getSkillProvenance(skillKey: string, version: number): Promise<ProvenanceRecord>;
  getAgentProvenance(agentKey: string, version: number): Promise<ProvenanceRecord>;
}

export class HttpRegistryApiClient implements RegistryApiClient {
  constructor(private readonly deps: { apiOrigin: string; fetchFn?: typeof fetch }) {}

  async health(): Promise<{ ok: boolean }> {
    return await this.fetchJson('/healthz');
  }

  async getSession(apiToken: string): Promise<RegistryApiSession> {
    return await this.fetchJson('/v1/session', undefined, apiToken);
  }

  async getGraphSubgraph(rootUrn: string, depth: number): Promise<GraphSubgraph> {
    const query = new URLSearchParams({
      root_urn: rootUrn,
      depth: String(depth),
    });
    return await this.fetchJson(`/v1/graph/subgraph?${query.toString()}`);
  }

  async listAgents(opts?: { limit?: number; offset?: number }): Promise<{ agents: AgentSummary[] }> {
    return await this.fetchJson(`/v1/agents${pagingQuery(opts)}`);
  }

  async getAgent(agentKey: string): Promise<AgentDetails> {
    return await this.fetchJson(`/v1/agents/${encodeURIComponent(agentKey)}`);
  }

  async createAgent(input: CreateAgentInput, apiToken: string): Promise<AgentDetails> {
    return await this.fetchJson('/v1/agents', {
      method: 'POST',
      body: JSON.stringify(input),
    }, apiToken);
  }

  async listSkills(opts?: { limit?: number; offset?: number }): Promise<{ skills: SkillSummary[] }> {
    return await this.fetchJson(`/v1/skills${pagingQuery(opts)}`);
  }

  async getSkill(skillKey: string): Promise<SkillDetails> {
    return await this.fetchJson(`/v1/skills/${encodeURIComponent(skillKey)}`);
  }

  async createSkill(input: CreateSkillInput, apiToken: string): Promise<SkillDetails> {
    return await this.fetchJson('/v1/skills', {
      method: 'POST',
      body: JSON.stringify(input),
    }, apiToken);
  }

  async listSkillVersions(skillKey: string): Promise<{ versions: SkillVersionDetails[] }> {
    return await this.fetchJson(`/v1/skills/${encodeURIComponent(skillKey)}/versions`);
  }

  async getActiveSkillVersion(skillKey: string): Promise<SkillVersionDetails | null> {
    try {
      return await this.fetchJson(`/v1/skills/${encodeURIComponent(skillKey)}/active`);
    } catch (err) {
      // A skill whose versions are all drafts/rejected has no active version;
      // the API reports that as 404 and the contract here is `null`.
      if (err instanceof RegistryApiError && err.status === 404 && err.code === 'SKILL_ACTIVE_VERSION_NOT_FOUND') {
        return null;
      }
      throw err;
    }
  }

  async createSkillDraft(
    skillKey: string,
    input: CreateSkillDraftInput,
    apiToken: string,
  ): Promise<SkillLifecycleOperationResult> {
    return await this.fetchJson(
      `/v1/skills/${encodeURIComponent(skillKey)}/drafts`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      apiToken,
    );
  }

  async validateSkillVersion(
    skillKey: string,
    version: number,
    input: SkillVersionOperationInput,
    apiToken: string,
  ): Promise<SkillLifecycleOperationResult> {
    return await this.postSkillVersionAction('validate', skillKey, version, input, apiToken);
  }

  async publishSkillVersion(
    skillKey: string,
    version: number,
    input: SkillVersionOperationInput,
    apiToken: string,
  ): Promise<SkillLifecycleOperationResult> {
    return await this.postSkillVersionAction('publish', skillKey, version, input, apiToken);
  }

  async promoteSkillVersion(
    skillKey: string,
    version: number,
    input: SkillVersionOperationInput,
    apiToken: string,
  ): Promise<SkillLifecycleOperationResult> {
    return await this.postSkillVersionAction('promote', skillKey, version, input, apiToken);
  }

  async deprecateSkillVersion(
    skillKey: string,
    version: number,
    input: SkillVersionOperationInput,
    apiToken: string,
  ): Promise<SkillLifecycleOperationResult> {
    return await this.postSkillVersionAction('deprecate', skillKey, version, input, apiToken);
  }

  async certifySkillVersion(
    skillKey: string,
    version: number,
    input: SkillVersionOperationInput,
    apiToken: string,
  ): Promise<SkillLifecycleOperationResult> {
    return await this.postSkillVersionAction('certify', skillKey, version, input, apiToken);
  }

  private async fetchJson<T>(path: string, init?: RequestInit, apiToken?: string): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set('accept', 'application/json');
    if (init?.body) {
      headers.set('content-type', 'application/json');
    }
    if (apiToken) {
      headers.set('authorization', `Bearer ${apiToken}`);
    }

    const res = await (this.deps.fetchFn ?? fetch)(new URL(path, this.deps.apiOrigin), {
      ...init,
      headers,
    });
    if (!res.ok) {
      const errorBody = (await res.json().catch(() => undefined)) as
        | { error?: { code?: string; message?: string } }
        | undefined;
      throw new RegistryApiError(
        errorBody?.error?.message ?? `Registry API request failed (${res.status})`,
        res.status,
        errorBody?.error?.code,
      );
    }
    return (await res.json()) as T;
  }

  async listOntologyPackages(): Promise<{ ontology_packages: OntologyPackageDetails[] }> {
    return await this.fetchJson('/v1/ontology-packages');
  }

  async listDeFactoTerms(opts?: { status?: DeFactoTermDetails['status'] }): Promise<{ terms: DeFactoTermDetails[] }> {
    return await this.fetchJson(`/v1/de-facto-terms${opts?.status ? `?status=${opts.status}` : ''}`);
  }

  async reviewDeFactoTerm(
    term: string,
    input: ReviewDeFactoTermInput,
    apiToken: string,
  ): Promise<DeFactoTermDetails> {
    return await this.fetchJson(
      `/v1/de-facto-terms/${encodeURIComponent(term)}/review`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      apiToken,
    );
  }

  async listPendingReviews(): Promise<{ pending: PendingReviewItem[] }> {
    return await this.fetchJson('/v1/reviews/pending');
  }

  async listAgentVersions(agentKey: string): Promise<{ versions: AgentVersionDetails[] }> {
    return await this.fetchJson(`/v1/agents/${encodeURIComponent(agentKey)}/versions`);
  }

  async reviewSkillVersion(
    skillKey: string,
    version: number,
    input: ReviewVersionInput,
    apiToken: string,
  ): Promise<ReviewOperationResult> {
    return await this.fetchJson(
      `/v1/skills/${encodeURIComponent(skillKey)}/versions/${version}/review`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      apiToken,
    );
  }

  async reviewAgentVersion(
    agentKey: string,
    version: number,
    input: ReviewVersionInput,
    apiToken: string,
  ): Promise<ReviewOperationResult> {
    return await this.fetchJson(
      `/v1/agents/${encodeURIComponent(agentKey)}/versions/${version}/review`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      apiToken,
    );
  }

  async getArtifactJson(sha256: string): Promise<unknown | null> {
    const res = await (this.deps.fetchFn ?? fetch)(
      new URL(`/v1/artifacts/${encodeURIComponent(sha256)}`, this.deps.apiOrigin),
      { headers: { accept: 'application/json' } },
    );
    if (res.status === 404) {
      // Evidence artifacts are best-effort on the review surface: a missing
      // artifact renders as "unavailable", not as a page error.
      return null;
    }
    if (!res.ok) {
      const errorBody = (await res.json().catch(() => undefined)) as
        | { error?: { code?: string; message?: string } }
        | undefined;
      throw new RegistryApiError(
        errorBody?.error?.message ?? `Registry API request failed (${res.status})`,
        res.status,
        errorBody?.error?.code,
      );
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  async getSkillProvenance(skillKey: string, version: number): Promise<ProvenanceRecord> {
    return await this.fetchJson(
      `/v1/skills/${encodeURIComponent(skillKey)}/versions/${version}/provenance`,
    );
  }

  async getAgentProvenance(agentKey: string, version: number): Promise<ProvenanceRecord> {
    return await this.fetchJson(
      `/v1/agents/${encodeURIComponent(agentKey)}/versions/${version}/provenance`,
    );
  }

  private async postSkillVersionAction(
    action: 'validate' | 'publish' | 'promote' | 'deprecate' | 'certify',
    skillKey: string,
    version: number,
    input: SkillVersionOperationInput,
    apiToken: string,
  ): Promise<SkillLifecycleOperationResult> {
    return await this.fetchJson(
      `/v1/skills/${encodeURIComponent(skillKey)}/versions/${version}/${action}`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
      apiToken,
    );
  }
}

function pagingQuery(opts?: { limit?: number; offset?: number }): string {
  if (!opts || (opts.limit === undefined && opts.offset === undefined)) return '';
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.offset !== undefined) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
