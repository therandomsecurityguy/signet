import { z } from 'zod';

import { FreshnessSchema } from '../freshness.js';

export const RegistryGetAgentInputSchema = z.object({
  agent_urn: z.string().min(1),
});

export const RegistryGetAgentOutputSchema = z.object({
  agent: z.object({
    urn: z.string(),
    properties: z.record(z.string(), z.unknown()),
  }),
  active_version: z
    .object({
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
      /** Staleness signal for the active version (build plan 2.1). */
      freshness: FreshnessSchema.optional(),
    })
    .optional(),
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

export type RegistryGetAgentInput = z.infer<typeof RegistryGetAgentInputSchema>;
export type RegistryGetAgentOutput = z.infer<typeof RegistryGetAgentOutputSchema>;

