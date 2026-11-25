import { z } from 'zod';

export const RegistryListAgentsInputSchema = z.object({
  harness_name: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().max(10_000).optional(),
});

export const RegistryListAgentsOutputSchema = z.object({
  agents: z.array(
    z.object({
      agent_urn: z.string(),
      agent_key: z.string(),
      harness_name: z.string().optional(),
      source_path: z.string().optional(),
      /** Operator-curated tags (normalized: sorted, case-insensitively unique). */
      tags: z.array(z.string()).optional(),
    }),
  ),
});

export type RegistryListAgentsInput = z.infer<typeof RegistryListAgentsInputSchema>;
export type RegistryListAgentsOutput = z.infer<typeof RegistryListAgentsOutputSchema>;

