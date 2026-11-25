import { z } from 'zod';

export const OpenLineageSchema = z
  .object({
    job_namespace: z.string().min(1).optional(),
    job_name: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
    event_time: z.string().min(1).optional(),
  })
  .optional();

export const SkillSeedSpecSchema = z.object({
  item_id: z.string().min(1).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
  capability_claims: z.array(z.string().min(1).max(200)).max(200).optional(),
  skill_key: z.string().min(1),
  author: z.string().min(1).optional(),
  artifact_path: z.string().min(1),
  artifact_media_type: z.string().min(1).default('text/markdown'),
  display_name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  source_path: z.string().min(1).optional(),
  commit_sha: z.string().min(1).optional(),
  git_tag: z.string().min(1).optional(),
  artifact_signature: z.string().min(1).optional(),
  publish_note: z.string().min(1).optional(),
  validate_note: z.string().min(1).optional(),
  certify: z.boolean().default(false),
  certify_note: z.string().min(1).optional(),
  lineage: z
    .object({
      upstream_skill_version_urns: z.array(z.string().min(1)).optional(),
      openlineage: OpenLineageSchema,
    })
    .optional(),
});

export const SkillSeedRefSchema = z
  .object({
    skill_key: z.string().min(1).optional(),
    skill_urn: z.string().min(1).optional(),
    skill_item_id: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.skill_key || value.skill_urn || value.skill_item_id), {
    message: 'skill_key, skill_urn, or skill_item_id is required',
  });

export const AgentSeedSpecSchema = z.object({
  item_id: z.string().min(1).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
  agent_key: z.string().min(1),
  harness_name: z.string().min(1).optional(),
  display_name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  source_path: z.string().min(1).optional(),
  artifact_path: z.string().min(1).optional(),
  artifact_media_type: z.string().min(1).default('text/markdown'),
  skill_refs: z.array(z.union([z.string().min(1), SkillSeedRefSchema])).default([]),
});

export const BootstrapPackMetadataSchema = z.object({
  pack_id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
});

export const SkillSeedDefaultsSchema = z.object({
  author: z.string().min(1).optional(),
  artifact_media_type: z.string().min(1).optional(),
  display_name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  source_path: z.string().min(1).optional(),
  commit_sha: z.string().min(1).optional(),
  git_tag: z.string().min(1).optional(),
  artifact_signature: z.string().min(1).optional(),
  capability_claims: z.array(z.string().min(1).max(200)).max(200).optional(),
  publish_note: z.string().min(1).optional(),
  validate_note: z.string().min(1).optional(),
  certify: z.boolean().optional(),
  certify_note: z.string().min(1).optional(),
}).optional();

export const AgentSeedDefaultsSchema = z.object({
  harness_name: z.string().min(1).optional(),
  display_name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  source_path: z.string().min(1).optional(),
  artifact_media_type: z.string().min(1).optional(),
}).optional();

export const BootstrapProfileSchema = z.object({
  description: z.string().min(1).optional(),
  skill_item_ids: z.array(z.string().min(1)).optional(),
  agent_item_ids: z.array(z.string().min(1)).optional(),
});

export const BootstrapManifestSchema = z.object({
  pack: BootstrapPackMetadataSchema.optional(),
  defaults: z
    .object({
      skill: SkillSeedDefaultsSchema,
      agent: AgentSeedDefaultsSchema,
    })
    .optional(),
  profiles: z.record(z.string(), BootstrapProfileSchema).optional(),
  // When enabled, published skills are signed with an ephemeral ed25519 demo
  // key (persisted under data/registry-operator/, never committed), registered
  // as a trusted key owned by `owner`, and the detached signature is attached
  // to the frozen envelope after publish.
  signing: z
    .object({
      enabled: z.boolean().default(false),
      owner: z.string().min(1).default('registry-operator'),
    })
    .optional(),
  skills: z.array(SkillSeedSpecSchema).default([]),
  agents: z.array(AgentSeedSpecSchema).default([]),
});

export type SkillSeedSpec = z.infer<typeof SkillSeedSpecSchema>;
export type AgentSeedSpec = z.infer<typeof AgentSeedSpecSchema>;
export type BootstrapManifest = z.infer<typeof BootstrapManifestSchema>;
export type SkillSeedRef = z.infer<typeof SkillSeedRefSchema>;
export type BootstrapProfile = z.infer<typeof BootstrapProfileSchema>;

export type SkillSeedPlan = {
  itemId: string;
  dependsOn: string[];
  tags: string[];
  draft: {
    skill_key: string;
    author: string;
    artifact_path: string;
    artifact_media_type: string;
    display_name?: string;
    description?: string;
    source_path?: string;
    commit_sha?: string;
    git_tag?: string;
    artifact_signature?: string;
    capability_claims?: string[];
    lineage?: {
      upstream_skill_version_urns?: string[];
      openlineage?: z.infer<NonNullable<typeof OpenLineageSchema>>;
    };
  };
  validateNote?: string;
  publishNote?: string;
  certify: boolean;
  certifyNote?: string;
};

export type AgentCreatePlan = {
  itemId: string;
  dependsOn: string[];
  tags: string[];
  agent_key: string;
  harness_name?: string;
  display_name?: string;
  description?: string;
  source_path?: string;
  artifact_path?: string;
  artifact_media_type?: string;
  skill_refs: Array<{ skill_key?: string; skill_urn?: string; skill_item_id?: string }>;
};
