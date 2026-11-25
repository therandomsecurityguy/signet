import { z } from 'zod';

export const SetTagsInputSchema = z.object({
  /**
   * Free-form curator tags; normalized server-side (trimmed, deduped
   * case-insensitively, charset- and count-limited, sorted).
   */
  tags: z.array(z.string().min(1).max(40)).max(100),
});

export const SetSkillTagsOutputSchema = z.object({
  skill_key: z.string(),
  tags: z.array(z.string()),
});

export const SetAgentTagsOutputSchema = z.object({
  agent_key: z.string(),
  tags: z.array(z.string()),
});

export type SetTagsInput = z.infer<typeof SetTagsInputSchema>;
