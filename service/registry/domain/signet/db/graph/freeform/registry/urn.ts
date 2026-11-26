export type AgentUrn = `urn:sg:agent:${string}`;
export type AgentVersionUrn = `urn:sg:agent-version:${string}`;
export type SkillUrn = `urn:sg:skill:${string}`;
export type SkillVersionUrn = `urn:sg:skill-version:${string}`;
export type TaskUrn = `urn:sg:task:${string}`;
export type ArtifactUrn = `urn:sg:artifact:sha256:${string}`;
export type ArtifactBlobUrn = `urn:sg:artifact-blob:sha256:${string}`;
export type ArtifactManifestUrn = `urn:sg:artifact-manifest:${string}`;
export type CommitUrn = `urn:sg:commit:${string}`;
export type RefUrn = `urn:sg:ref:${string}`;
export type TagUrn = `urn:sg:tag:${string}`;
export type WorkspaceUrn = `urn:sg:workspace:${string}`;
export type RetentionRootUrn = `urn:sg:retention-root:${string}`;
export type GcJobUrn = `urn:sg:gc-job:${string}`;
export type RevalidationJobUrn = `urn:sg:revalidation-job:${string}`;
export type HarnessUrn = `urn:sg:harness:${string}`;
export type ToolUrn = `urn:sg:tool:${string}`;
export type PublicKeyUrn = `urn:sg:public-key:${string}`;
export type TransparencyLogUrn = `urn:sg:transparency-log:${string}`;
export type TransparencyWitnessUrn = `urn:sg:transparency-witness:${string}`;
export type TransparencyGossipEventUrn = `urn:sg:transparency-gossip-event:${string}`;

export function agentUrn(agent_key: string): AgentUrn {
  return `urn:sg:agent:${agent_key}` as const;
}

export function agentVersionUrn(agent_key: string, version: number): AgentVersionUrn {
  return `urn:sg:agent-version:${agent_key}@v${version}` as const;
}

export function skillUrn(skill_key: string): SkillUrn {
  return `urn:sg:skill:${skill_key}` as const;
}

export function skillVersionUrn(skill_key: string, version: number): SkillVersionUrn {
  return `urn:sg:skill-version:${skill_key}@v${version}` as const;
}

export function taskUrn(task_id: string): TaskUrn {
  return `urn:sg:task:${task_id}` as const;
}

export function artifactUrn(sha256: string): ArtifactUrn {
  return `urn:sg:artifact:sha256:${sha256}` as const;
}

export function artifactBlobUrn(sha256: string): ArtifactBlobUrn {
  return `urn:sg:artifact-blob:sha256:${sha256}` as const;
}

export function artifactManifestUrn(manifest_id: string): ArtifactManifestUrn {
  return `urn:sg:artifact-manifest:${manifest_id}` as const;
}

export function commitUrn(commit_id: string): CommitUrn {
  return `urn:sg:commit:${commit_id}` as const;
}

export function refUrn(ref_name: string): RefUrn {
  return `urn:sg:ref:${ref_name}` as const;
}

export function tagUrn(tag_name: string): TagUrn {
  return `urn:sg:tag:${tag_name}` as const;
}

export function workspaceUrn(workspace_id: string): WorkspaceUrn {
  return `urn:sg:workspace:${workspace_id}` as const;
}

export function retentionRootUrn(root_id: string): RetentionRootUrn {
  return `urn:sg:retention-root:${root_id}` as const;
}

export function gcJobUrn(job_id: string): GcJobUrn {
  return `urn:sg:gc-job:${job_id}` as const;
}

export function revalidationJobUrn(job_id: string): RevalidationJobUrn {
  return `urn:sg:revalidation-job:${job_id}` as const;
}

export type DeFactoTermUrn = `urn:sg:defacto-term:${string}`;

// Terms arrive from free-form capability claims, so they must be strictly
// percent-encoded before entering a URN: encodeURIComponent leaves `!'()*`
// unescaped, which is not enough for an IRI segment.
export function encodeUrnSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

export function deFactoTermUrn(term: string): DeFactoTermUrn {
  return `urn:sg:defacto-term:${encodeUrnSegment(term)}` as const;
}

export type ProvAgentUrn = `urn:sg:prov-agent:${string}`;

export function provAgentUrn(agent_name: string): ProvAgentUrn {
  // Percent-encode the name: raw display names routinely contain spaces
  // ("Dana Reviewer"), which produce invalid IRIs that SPARQL backends
  // (Fuseki) reject mid-write. Space-free machine names are unchanged.
  return `urn:sg:prov-agent:${encodeURIComponent(agent_name)}` as const;
}

export function harnessUrn(harness_name: string): HarnessUrn {
  // Same encoding contract as provAgentUrn: harness display names may
  // contain spaces ("Claude Code") and must stay valid IRIs.
  return `urn:sg:harness:${encodeURIComponent(harness_name)}` as const;
}

export function toolUrn(tool_name: string): ToolUrn {
  return `urn:sg:tool:${encodeURIComponent(tool_name)}` as const;
}

export function publicKeyUrn(key_ref: string): PublicKeyUrn {
  return `urn:sg:public-key:${key_ref}` as const;
}

export function transparencyLogUrn(log_id: string): TransparencyLogUrn {
  return `urn:sg:transparency-log:${log_id}` as const;
}

export function transparencyWitnessUrn(witness_id: string): TransparencyWitnessUrn {
  return `urn:sg:transparency-witness:${witness_id}` as const;
}

export function transparencyGossipEventUrn(event_id: string): TransparencyGossipEventUrn {
  return `urn:sg:transparency-gossip-event:${event_id}` as const;
}

