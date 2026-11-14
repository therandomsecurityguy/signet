import { z } from 'zod';

import { CreateDetachedSignatureInputSchema } from '../publication/envelope.js';

export const RegistryTaskDetailsSchema = z.object({
  task: z.object({
    urn: z.string(),
    properties: z.record(z.string(), z.unknown()),
  }),
  targets: z.array(
    z.object({
      target_urn: z.string(),
    }),
  ),
});

export const SkillVersionDetailsSchema = z.object({
  skill_version: z.object({
    urn: z.string(),
    properties: z.record(z.string(), z.unknown()),
  }),
  artifacts: z.array(
    z.object({
      artifact_urn: z.string(),
      sha256: z.string().optional(),
    }),
  ),
  upstream_versions: z.array(
    z.object({
      skill_version_urn: z.string(),
    }),
  ),
});

export const SkillLifecycleOperationResultSchema = z.object({
  task: RegistryTaskDetailsSchema,
  result: SkillVersionDetailsSchema,
});

const GovernanceInputSchema = z.object({
  publisher: z.string().min(1).max(200).optional(),
  policy_version: z.string().min(1).max(200).optional(),
  ontology_version: z.string().min(1).max(200).optional(),
  validation_report: z.string().min(1).max(2_000).optional(),
  signature_ref: z.string().min(1).max(1_000).optional(),
  approver: z.string().min(1).max(200).optional(),
  approver_role: z.string().min(1).max(200).optional(),
  certification_expires_at: z.string().min(1).max(100).optional(),
});

export { GovernanceInputSchema };

export const CreateSkillDraftInputSchema = z.object({
  artifact: z.object({
    content: z.string().min(1),
    encoding: z.enum(['utf8', 'base64']).default('utf8'),
    media_type: z.string().min(1).max(200).optional(),
    original_path: z.string().min(1).max(1_000).optional(),
  }),
  author: z.string().min(1).max(200),
  display_name: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2_000).optional(),
  source_path: z.string().min(1).max(1_000).optional(),
  commit_sha: z.string().min(1).max(200).optional(),
  git_tag: z.string().min(1).max(200).optional(),
  artifact_signature: z.string().min(1).max(1_000).optional(),
  capability_claims: z.array(z.string().min(1).max(200)).max(200).optional(),
  lineage: z
    .object({
      upstream_skill_version_urns: z.array(z.string().min(1)).optional(),
      openlineage: z
        .object({
          job_namespace: z.string().min(1).optional(),
          job_name: z.string().min(1).optional(),
          run_id: z.string().min(1).optional(),
          event_time: z.string().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
  governance: GovernanceInputSchema.optional(),
});

export const SkillVersionOperationInputSchema = z.object({
  author: z.string().min(1).max(200),
  note: z.string().min(1).max(2_000).optional(),
  governance: GovernanceInputSchema.optional(),
  // Single-request sign-then-publish: publish against the envelope pinned by
  // prepare-publication, attaching signatures that must verify over exactly
  // that envelope.
  prepared_publication_urn: z.string().min(1).max(500).optional(),
  signatures: z.array(CreateDetachedSignatureInputSchema).max(16).optional(),
});

export const ReviewVersionInputSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  author: z.string().min(1).max(200),
  review_role: z.string().min(1).max(200).optional(),
  note: z.string().min(1).max(2_000).optional(),
});

export const ListSkillVersionsOutputSchema = z.object({
  versions: z.array(SkillVersionDetailsSchema),
});

export const ActiveSkillVersionOutputSchema = SkillVersionDetailsSchema.nullable();

export type CreateSkillDraftInput = z.infer<typeof CreateSkillDraftInputSchema>;
export type SkillVersionOperationInput = z.infer<typeof SkillVersionOperationInputSchema>;
export type ReviewVersionInput = z.infer<typeof ReviewVersionInputSchema>;
