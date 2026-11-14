import { z } from 'zod';

export const AdvisorySeveritySchema = z.enum(['low', 'moderate', 'high', 'critical']);

export const AdvisoryDocumentSchema = z.object({
  advisory_id: z.string().min(1).max(200),
  source: z.string().min(1).max(100),
  severity: AdvisorySeveritySchema,
  summary: z.string().min(1).max(4_000),
  published_at: z.string().min(1).max(100).optional(),
  references: z.array(z.string().min(1).max(2_000)).max(50).optional(),
  affected: z.object({
    artifact_sha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(200).optional(),
    skills: z
      .array(
        z.object({
          skill_key: z.string().min(1).max(200),
          version: z.number().int().positive().optional(),
        }),
      )
      .max(200)
      .optional(),
    agents: z
      .array(
        z.object({
          agent_key: z.string().min(1).max(200),
          version: z.number().int().positive().optional(),
        }),
      )
      .max(200)
      .optional(),
  }),
});

export const CreateAdvisoryInputSchema = z.object({
  // report (default) lists the affected publications; enforce also revokes
  // revocable matches with actor "threat-intel".
  mode: z.enum(['report', 'enforce']).optional(),
  advisory: AdvisoryDocumentSchema,
  signer: z.string().min(1).max(200),
  key_ref: z.string().min(1).max(500),
  algorithm: z.string().min(1).max(100),
  signature: z.string().min(1).max(20_000),
});

export const AdvisoryMatchSchema = z.object({
  publication_urn: z.string(),
  entity_type: z.enum(['SKILL_VERSION', 'AGENT_VERSION']),
  logical_key: z.string(),
  version: z.number().int(),
  matched_by: z.enum(['artifact_sha256', 'identifier']),
  status: z.string(),
  outcome: z.enum(['revoked', 'already_revoked', 'not_revocable', 'reported']),
});

export const AdvisoryRecordSchema = z.object({
  advisory_urn: z.string(),
  advisory_sha256: z.string(),
  advisory_id: z.string(),
  source: z.string(),
  severity: AdvisorySeveritySchema,
  summary: z.string(),
  published_at: z.string().optional(),
  references: z.array(z.string()),
  signer: z.string(),
  key_ref: z.string(),
  algorithm: z.string(),
  signature: z.string(),
  signature_valid: z.boolean(),
  mode: z.enum(['report', 'enforce']),
  ingested_at: z.string(),
  matches: z.array(AdvisoryMatchSchema),
});

export const ListAdvisoriesOutputSchema = z.object({
  advisories: z.array(AdvisoryRecordSchema),
});

export type CreateAdvisoryInput = z.infer<typeof CreateAdvisoryInputSchema>;
