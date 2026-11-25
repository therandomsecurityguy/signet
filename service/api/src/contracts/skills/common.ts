import { z } from 'zod';

import { TrustScoreSchema } from '../trust.js';

export const SkillSummarySchema = z.object({
  skill_urn: z.string(),
  skill_key: z.string(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  source_path: z.string().optional(),
  /** Present when the list is requested with `sort=trust`. */
  trust: TrustScoreSchema.optional(),
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
  governance_artifacts: z.array(
    z.object({
      role: z.enum(['policy_package', 'validation_report', 'certification_evidence', 'review_evidence']),
      artifact_urn: z.string(),
      sha256: z.string().optional(),
    }),
  ),
});

export const SkillDetailsSchema = z.object({
  skill: z.object({
    urn: z.string(),
    properties: z.record(z.string(), z.unknown()),
  }),
  active_version: SkillVersionDetailsSchema.optional(),
  artifacts: z.array(
    z.object({
      artifact_urn: z.string(),
      sha256: z.string().optional(),
    }),
  ),
});

export type SkillSummary = z.infer<typeof SkillSummarySchema>;
export type SkillDetails = z.infer<typeof SkillDetailsSchema>;
