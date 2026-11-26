import { z } from 'zod';

// Trust event feed (build plan 2.2): filtered reads over the governance
// events recorded at lifecycle operations. Read-only — no new recording
// machinery; these are the canonical event documents already anchored in the
// internal Merkle log (position = leaf index).
export const GovernanceEventSchema = z.object({
  position: z.number().int(),
  event_artifact_urn: z.string(),
  event_sha256: z.string(),
  event_type: z.string(),
  occurred_at: z.string(),
  actor: z.string(),
  logical_urn: z.string(),
  entity_type: z.string(),
  publication_urn: z.string(),
  task_urn: z.string(),
  policy_version: z.string().optional(),
  ontology_version: z.string().optional(),
  envelope_sha256: z.string().optional(),
});

export const ListGovernanceEventsQuerySchema = z.object({
  /** Exact governance event type, e.g. `certify`, `revoke`, `recertify`. */
  event_type: z.string().min(1).max(100).optional(),
  /** Filter to one publication (skill/agent version URN). */
  publication_urn: z.string().min(1).max(500).optional(),
  /** Filter to one logical entity (skill:… / agent:…). */
  logical_key: z.string().min(1).max(500).optional(),
  /** ISO timestamp lower bound (inclusive). */
  since: z.string().min(1).max(100).optional(),
  /** ISO timestamp upper bound (inclusive). */
  until: z.string().min(1).max(100).optional(),
  /** Ascending catch-up cursor: return events with position > this. */
  after_position: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const ListGovernanceEventsOutputSchema = z.object({
  events: z.array(GovernanceEventSchema),
  latest_position: z.number().int().nullable(),
});

// The SSE stream accepts the same filters plus an exclusive start cursor
// (`since_position: -1` replays from the beginning of the log).
export const EventsStreamQuerySchema = z.object({
  event_type: z.string().min(1).max(100).optional(),
  publication_urn: z.string().min(1).max(500).optional(),
  logical_key: z.string().min(1).max(500).optional(),
  since_position: z.coerce.number().int().min(-1).optional(),
});

export type GovernanceEvent = z.infer<typeof GovernanceEventSchema>;
export type ListGovernanceEventsQuery = z.infer<typeof ListGovernanceEventsQuerySchema>;
export type ListGovernanceEventsOutput = z.infer<typeof ListGovernanceEventsOutputSchema>;
export type EventsStreamQuery = z.infer<typeof EventsStreamQuerySchema>;
