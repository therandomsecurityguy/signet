import { z } from 'zod';

export const RegistrySearchInputSchema = z.object({
  query: z.string().min(1).max(200),
  type: z.enum(['skill', 'agent', 'all']).default('all'),
  limit: z.number().int().positive().max(50).optional(),
});

export const RegistrySearchOutputSchema = z.object({
  query: z.string(),
  skills: z.array(
    z.object({
      skill_urn: z.string(),
      skill_key: z.string(),
      display_name: z.string().optional(),
      description: z.string().optional(),
      source_path: z.string().optional(),
      active_version: z.number().optional(),
      certification_status: z.string().optional(),
    }),
  ),
  agents: z.array(
    z.object({
      agent_urn: z.string(),
      agent_key: z.string(),
      harness_name: z.string().optional(),
      display_name: z.string().optional(),
      description: z.string().optional(),
      source_path: z.string().optional(),
    }),
  ),
});

export type RegistrySearchInput = z.infer<typeof RegistrySearchInputSchema>;
export type RegistrySearchOutput = z.infer<typeof RegistrySearchOutputSchema>;
