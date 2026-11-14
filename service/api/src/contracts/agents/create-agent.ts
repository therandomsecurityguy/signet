import { z } from 'zod';

import { entityKeySchema, harnessNameSchema, registryUrnSchema } from '../keys.js';
import { AgentDetailsSchema } from './common.js';

const AgentArtifactInputSchema = z.object({
  content: z.string().min(1),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  media_type: z.string().min(1).max(200).optional(),
  original_path: z.string().min(1).max(1_000).optional(),
});

const AgentSkillRefInputSchema = z
  .object({
    skill_urn: registryUrnSchema.optional(),
    skill_key: entityKeySchema.optional(),
  })
  .refine((value) => Boolean(value.skill_urn || value.skill_key), {
    message: 'skill_urn or skill_key is required',
  });

const GovernanceInputSchema = z.object({
  publisher: z.string().min(1).max(200).optional(),
  policy_version: z.string().min(1).max(200).optional(),
  validation_report: z.string().min(1).max(2_000).optional(),
  signature_ref: z.string().min(1).max(1_000).optional(),
  approver: z.string().min(1).max(200).optional(),
  approver_role: z.string().min(1).max(200).optional(),
});

export const CreateAgentInputSchema = z.object({
  agent_key: entityKeySchema,
  harness_name: harnessNameSchema.optional(),
  display_name: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2_000).optional(),
  source_path: z.string().min(1).max(1_000).optional(),
  artifact: AgentArtifactInputSchema.optional(),
  skill_refs: z.array(AgentSkillRefInputSchema).max(200).optional(),
  governance: GovernanceInputSchema.optional(),
});

export const CreateAgentOutputSchema = AgentDetailsSchema;

export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;
export type CreateAgentOutput = z.infer<typeof CreateAgentOutputSchema>;
