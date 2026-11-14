import { z } from 'zod';

export const TransparencyTimelineOutputSchema = z.object({
  events: z.array(
    z.object({
      event_id: z.string(),
      kind: z.enum(['checkpoint', 'observation', 'witness_attestation', 'gossip', 'disagreement']),
      occurred_at: z.string(),
      summary: z.string(),
      related_urns: z.array(z.string()),
    }),
  ),
});
