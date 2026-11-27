import { z } from 'zod';

// Publication gate hints (build plan 3.3c): a non-throwing, read-only mirror
// of the policy-driven gate enforcement. Each hint says whether the bound
// policy configures a gate, whether the version's CURRENT state satisfies it,
// and why — answering "which gate would reject this, and what is missing"
// before anyone attempts publish or certify.
export const GateHintSchema = z.object({
  gate: z.enum([
    'require_human_review',
    'require_validation',
    'require_signature',
    'require_trusted_publisher',
    'require_build_provenance',
    'require_sbom',
  ]),
  operation: z.enum(['publish', 'certify']),
  /** The bound policy configures this gate. */
  applicable: z.boolean(),
  satisfied: z.boolean(),
  reason: z.string(),
});

export const PublicationGateHintsSchema = z.object({
  publication_urn: z.string(),
  /** Null when no policy package is bound to the version. */
  policy_version: z.string().nullable(),
  gates: z.array(GateHintSchema),
  /** True when no applicable publish/certify gate is unsatisfied. */
  would_publish: z.boolean(),
  would_certify: z.boolean(),
});

export type PublicationGateHints = z.infer<typeof PublicationGateHintsSchema>;
