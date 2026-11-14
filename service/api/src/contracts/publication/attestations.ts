import { z } from 'zod';

export const DsseSignatureSchema = z.object({
  keyid: z.string().min(1).max(500).optional(),
  sig: z.string().min(1).max(20_000),
});

export const DsseEnvelopeSchema = z.object({
  payload_type: z.string().min(1).max(200),
  payload: z.string().min(1).max(5_000_000),
  signatures: z.array(DsseSignatureSchema).min(1).max(20),
});

export const CreateAttestationInputSchema = z.object({
  publication_urn: z.string().min(1).max(500),
  signer: z.string().min(1).max(200),
  key_ref: z.string().min(1).max(500),
  algorithm: z.string().min(1).max(100),
  envelope: DsseEnvelopeSchema,
  // Optional when the DSSE payload is an in-toto statement carrying
  // predicateType; required otherwise.
  predicate_type: z.string().min(1).max(500).optional(),
  note: z.string().min(1).max(2_000).optional(),
});

export const AttestationRecordSchema = z.object({
  artifact_urn: z.string(),
  sha256: z.string(),
  signer: z.string(),
  key_ref: z.string(),
  algorithm: z.string(),
  predicate_type: z.string(),
  signature_valid: z.boolean(),
  subject_bound: z.boolean(),
  subject_digests: z.array(z.string()),
  attached_at: z.string(),
});

export const ListAttestationsOutputSchema = z.object({
  attestations: z.array(AttestationRecordSchema),
});

export type DsseEnvelope = z.infer<typeof DsseEnvelopeSchema>;
export type CreateAttestationInput = z.infer<typeof CreateAttestationInputSchema>;
export type AttestationRecord = z.infer<typeof AttestationRecordSchema>;
