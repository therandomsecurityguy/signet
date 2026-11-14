import { z } from 'zod';

import { entityKeySchema, registryUrnSchema } from '../keys.js';
import { CreateDetachedSignatureInputSchema } from '../publication/envelope.js';
import { GovernanceInputSchema } from '../skills/lifecycle.js';

const AgentDraftArtifactInputSchema = z.object({
  content: z.string().min(1),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  media_type: z.string().min(1).max(200).optional(),
  original_path: z.string().min(1).max(1_000).optional(),
});

const AgentDraftSkillRefInputSchema = z
  .object({
    skill_urn: registryUrnSchema.optional(),
    skill_key: entityKeySchema.optional(),
  })
  .refine((value) => Boolean(value.skill_urn || value.skill_key), {
    message: 'skill_urn or skill_key is required',
  });

export const CreateAgentDraftInputSchema = z.object({
  artifact: AgentDraftArtifactInputSchema,
  author: z.string().min(1).max(200),
  display_name: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2_000).optional(),
  source_path: z.string().min(1).max(1_000).optional(),
  commit_sha: z.string().min(1).max(200).optional(),
  git_tag: z.string().min(1).max(200).optional(),
  artifact_signature: z.string().min(1).max(1_000).optional(),
  capability_claims: z.array(z.string().min(1).max(200)).max(200).optional(),
  skill_refs: z.array(AgentDraftSkillRefInputSchema).max(200).optional(),
  governance: GovernanceInputSchema.optional(),
});

export const AgentVersionOperationInputSchema = z.object({
  author: z.string().min(1).max(200),
  note: z.string().min(1).max(2_000).optional(),
  governance: GovernanceInputSchema.optional(),
  // Single-request sign-then-publish (see SkillVersionOperationInputSchema).
  prepared_publication_urn: z.string().min(1).max(500).optional(),
  signatures: z.array(CreateDetachedSignatureInputSchema).max(16).optional(),
});

export type CreateAgentDraftInput = z.infer<typeof CreateAgentDraftInputSchema>;
export type AgentVersionOperationInput = z.infer<typeof AgentVersionOperationInputSchema>;
