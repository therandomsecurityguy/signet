export type AgentUrn = `urn:tg:agent:${string}`;
export type AgentVersionUrn = `urn:tg:agent-version:${string}`;
export type SkillUrn = `urn:tg:skill:${string}`;
export type SkillVersionUrn = `urn:tg:skill-version:${string}`;
export type TaskUrn = `urn:tg:task:${string}`;
export type ArtifactUrn = `urn:tg:artifact:sha256:${string}`;
export type ArtifactBlobUrn = `urn:tg:artifact-blob:sha256:${string}`;
export type ArtifactManifestUrn = `urn:tg:artifact-manifest:${string}`;
export type CommitUrn = `urn:tg:commit:${string}`;
export type RefUrn = `urn:tg:ref:${string}`;
export type TagUrn = `urn:tg:tag:${string}`;
export type WorkspaceUrn = `urn:tg:workspace:${string}`;
export type RetentionRootUrn = `urn:tg:retention-root:${string}`;
export type GcJobUrn = `urn:tg:gc-job:${string}`;
export type HarnessUrn = `urn:tg:harness:${string}`;
export type ToolUrn = `urn:tg:tool:${string}`;
export type PublicKeyUrn = `urn:tg:public-key:${string}`;
export type TransparencyLogUrn = `urn:tg:transparency-log:${string}`;
export type TransparencyWitnessUrn = `urn:tg:transparency-witness:${string}`;
export type TransparencyGossipEventUrn = `urn:tg:transparency-gossip-event:${string}`;

export function agentUrn(agent_key: string): AgentUrn {
  return `urn:tg:agent:${agent_key}` as const;
}

export function agentVersionUrn(agent_key: string, version: number): AgentVersionUrn {
  return `urn:tg:agent-version:${agent_key}@v${version}` as const;
}

export function skillUrn(skill_key: string): SkillUrn {
  return `urn:tg:skill:${skill_key}` as const;
}

export function skillVersionUrn(skill_key: string, version: number): SkillVersionUrn {
  return `urn:tg:skill-version:${skill_key}@v${version}` as const;
}

export function taskUrn(task_id: string): TaskUrn {
  return `urn:tg:task:${task_id}` as const;
}

export function artifactUrn(sha256: string): ArtifactUrn {
  return `urn:tg:artifact:sha256:${sha256}` as const;
}

export function artifactBlobUrn(sha256: string): ArtifactBlobUrn {
  return `urn:tg:artifact-blob:sha256:${sha256}` as const;
}

export function artifactManifestUrn(manifest_id: string): ArtifactManifestUrn {
  return `urn:tg:artifact-manifest:${manifest_id}` as const;
}

export function commitUrn(commit_id: string): CommitUrn {
  return `urn:tg:commit:${commit_id}` as const;
}

export function refUrn(ref_name: string): RefUrn {
  return `urn:tg:ref:${ref_name}` as const;
}

export function tagUrn(tag_name: string): TagUrn {
  return `urn:tg:tag:${tag_name}` as const;
}

export function workspaceUrn(workspace_id: string): WorkspaceUrn {
  return `urn:tg:workspace:${workspace_id}` as const;
}

export function retentionRootUrn(root_id: string): RetentionRootUrn {
  return `urn:tg:retention-root:${root_id}` as const;
}

export function gcJobUrn(job_id: string): GcJobUrn {
  return `urn:tg:gc-job:${job_id}` as const;
}

export type DeFactoTermUrn = `urn:tg:defacto-term:${string}`;

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
  return `urn:tg:defacto-term:${encodeUrnSegment(term)}` as const;
}

export type ProvAgentUrn = `urn:tg:prov-agent:${string}`;

export function provAgentUrn(agent_name: string): ProvAgentUrn {
  return `urn:tg:prov-agent:${agent_name}` as const;
}

export function harnessUrn(harness_name: string): HarnessUrn {
  return `urn:tg:harness:${harness_name}` as const;
}

export function toolUrn(tool_name: string): ToolUrn {
  return `urn:tg:tool:${tool_name}` as const;
}

export function publicKeyUrn(key_ref: string): PublicKeyUrn {
  return `urn:tg:public-key:${key_ref}` as const;
}

export function transparencyLogUrn(log_id: string): TransparencyLogUrn {
  return `urn:tg:transparency-log:${log_id}` as const;
}

export function transparencyWitnessUrn(witness_id: string): TransparencyWitnessUrn {
  return `urn:tg:transparency-witness:${witness_id}` as const;
}

export function transparencyGossipEventUrn(event_id: string): TransparencyGossipEventUrn {
  return `urn:tg:transparency-gossip-event:${event_id}` as const;
}

