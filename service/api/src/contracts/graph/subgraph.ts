import { z } from 'zod';

export const GraphSubgraphInputSchema = z.object({
  root_urn: z.string().min(1),
  depth: z.coerce.number().int().min(1).max(5).default(3),
});

export const GraphSubgraphOutputSchema = z.object({
  root_urn: z.string(),
  depth: z.number().int().min(1).max(5),
  nodes: z.array(
    z.object({
      id: z.string(),
      urn: z.string(),
      entity_type: z.string(),
      label: z.string(),
      properties: z.record(z.string(), z.unknown()),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      from_urn: z.string(),
      to_urn: z.string(),
      predicate: z.string(),
      label: z.string(),
    }),
  ),
});

export type GraphSubgraphInput = z.infer<typeof GraphSubgraphInputSchema>;
export type GraphSubgraphOutput = z.infer<typeof GraphSubgraphOutputSchema>;
