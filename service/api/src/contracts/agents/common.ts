import { z } from 'zod';

import { TrustScoreSchema } from '../trust.js';

export const AgentSummarySchema = z.object({
  agent_urn: z.string(),
  agent_key: z.string(),
  harness_name: z.string().optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  source_path: z.string().optional(),
  /** Present when the list is requested with `sort=trust`. */
  trust: TrustScoreSchema.optional(),
});

export const AgentVersionDetailsSchema = z.object({
  agent_version: z.object({
    urn: z.string(),
    properties: z.record(z.string(), z.unknown()),
  }),
  skills: z.array(
    z.object({
      skill_urn: z.string(),
      skill_key: z.string().optional(),
    }),
  ),
  artifacts: z.array(
    z.object({
      artifact_urn: z.string(),
      sha256: z.string().optional(),
    }),
  ),
  harnesses: z.array(
    z.object({
      harness_urn: z.string(),
      harness_name: z.string().optional(),
    }),
  ),
  governance_artifacts: z.array(
    z.object({
      role: z.enum(['policy_package', 'validation_report', 'certification_evidence', 'review_evidence']),
      artifact_urn: z.string(),
      sha256: z.string().optional(),
    }),
  ),
});

export const AgentDetailsSchema = z.object({
  agent: z.object({
    urn: z.string(),
    properties: z.record(z.string(), z.unknown()),
  }),
  active_version: AgentVersionDetailsSchema.optional(),
  skills: z.array(
    z.object({
      skill_urn: z.string(),
      skill_key: z.string().optional(),
    }),
  ),
  artifacts: z.array(
    z.object({
      artifact_urn: z.string(),
      sha256: z.string().optional(),
    }),
  ),
  harnesses: z.array(
    z.object({
      harness_urn: z.string(),
      harness_name: z.string().optional(),
    }),
  ),
});

export type AgentSummary = z.infer<typeof AgentSummarySchema>;
export type AgentDetails = z.infer<typeof AgentDetailsSchema>;
export type AgentVersionDetails = z.infer<typeof AgentVersionDetailsSchema>;
