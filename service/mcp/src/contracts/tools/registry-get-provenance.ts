import { z } from 'zod';

export const RegistryGetProvenanceInputSchema = z.object({
  version_urn: z.string().min(1),
});

export const RegistryGetProvenanceOutputSchema = z.object({
  entity: z.object({
    urn: z.string(),
    entity_type: z.string(),
  }),
  derivation_chain: z.array(
    z.object({
      version_urn: z.string(),
      was_derived_from: z.array(z.string()),
      activities: z.array(
        z.object({
          task_urn: z.string(),
          operation: z.string(),
          status: z.string(),
          occurred_at: z.string().optional(),
          actor: z.string().optional(),
          used: z.array(
            z.object({
              urn: z.string(),
              entity_type: z.string().optional(),
            }),
          ),
          associated_agents: z.array(
            z.object({
              urn: z.string(),
              agent_name: z.string().optional(),
              role: z.string().optional(),
            }),
          ),
        }),
      ),
    }),
  ),
  replay: z.array(
    z.object({
      occurred_at: z.string().optional(),
      operation: z.string(),
      actor: z.string().optional(),
      version_urn: z.string(),
      status: z.string(),
    }),
  ),
});

export type RegistryGetProvenanceInput = z.infer<typeof RegistryGetProvenanceInputSchema>;
export type RegistryGetProvenanceOutput = z.infer<typeof RegistryGetProvenanceOutputSchema>;
