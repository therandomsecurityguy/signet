import { z } from 'zod';

export const CreatePolicyPackageInputSchema = z.object({
  policy_version: z.string().min(1).max(200),
  author: z.string().min(1).max(200),
  shapes: z.unknown(),
  description: z.string().min(1).max(2_000).optional(),
});

export const PolicyPackageDetailsSchema = z.object({
  artifact_urn: z.string(),
  sha256: z.string(),
  policy_version: z.string(),
  created_by: z.string(),
  created_at: z.string(),
  description: z.string().optional(),
  shapes: z.unknown(),
});

export const ListPolicyPackagesOutputSchema = z.object({
  policy_packages: z.array(PolicyPackageDetailsSchema),
});

export type CreatePolicyPackageInput = z.infer<typeof CreatePolicyPackageInputSchema>;
