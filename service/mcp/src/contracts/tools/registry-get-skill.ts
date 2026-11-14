import { z } from 'zod';

export const RegistryGetSkillInputSchema = z.object({
  skill_urn: z.string().min(1),
});

export const RegistryGetSkillOutputSchema = z.object({
  skill: z.object({
    urn: z.string(),
    properties: z.record(z.string(), z.unknown()),
  }),
  active_version: z
    .object({
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
    })
    .optional(),
  artifacts: z.array(
    z.object({
      artifact_urn: z.string(),
      sha256: z.string().optional(),
    }),
  ),
});

export type RegistryGetSkillInput = z.infer<typeof RegistryGetSkillInputSchema>;
export type RegistryGetSkillOutput = z.infer<typeof RegistryGetSkillOutputSchema>;

