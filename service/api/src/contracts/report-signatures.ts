import { z } from 'zod';

export const CreateReportSignatureInputSchema = z.object({
  /** One of the version's validation-report artifacts (SHACL report with an RDF export). */
  report_artifact_urn: z.string().min(1).max(500),
  signer: z.string().min(1).max(200),
  key_ref: z.string().min(1).max(500),
  algorithm: z.string().min(1).max(100),
  signature: z.string().min(1).max(20_000),
});

export const ReportSignatureRecordSchema = z.object({
  artifact_urn: z.string(),
  sha256: z.string().optional(),
  signer: z.string(),
  key_ref: z.string(),
  algorithm: z.string(),
  signed_at: z.string(),
  report_artifact_urn: z.string(),
  report_canonical_rdf_sha256: z.string(),
  signature: z.string(),
});

export const ReportSignatureVerificationSchema = z.object({
  artifact_urn: z.string(),
  signer: z.string(),
  key_ref: z.string(),
  algorithm: z.string(),
  signed_at: z.string(),
  report_artifact_urn: z.string(),
  report_canonical_rdf_sha256: z.string(),
  report_artifact_present: z.boolean(),
  canonical_artifact_present: z.boolean(),
  trusted_public_key_resolved: z.boolean(),
  cryptographic_verification_passed: z.boolean(),
  /** Reports are immutable: signatures are valid or invalid, never stale. */
  verdict: z.enum(['valid', 'invalid']),
});

export const ReportSignaturesOutputSchema = z.object({
  report_signatures: z.array(ReportSignatureVerificationSchema),
});

export type ReportSignaturesOutput = z.infer<typeof ReportSignaturesOutputSchema>;
