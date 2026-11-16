import { z } from 'zod';

export const PolicyShapesFormatSchema = z.enum(['legacy-json-v1', 'shacl-turtle']);

const CreateGateFieldsSchema = {
  require_human_review: z.boolean().optional(),
  require_validation: z.boolean().optional(),
  require_signature: z.boolean().optional(),
  require_trusted_publisher: z.boolean().optional(),
  require_build_provenance: z.boolean().optional(),
  require_sbom: z.boolean().optional(),
};

export const CreatePolicyPackageInputSchema = z
  .object({
    policy_version: z.string().min(1).max(200),
    author: z.string().min(1).max(200),
    shapes: z.unknown(),
    /**
     * Omit for the legacy JSON shape document format (gates live inside the
     * document). Set to "shacl-turtle" to register authored W3C SHACL
     * Turtle; lifecycle gates are then top-level fields.
     */
    shapes_format: z.literal('shacl-turtle').optional(),
    description: z.string().min(1).max(2_000).optional(),
    ...CreateGateFieldsSchema,
  })
  .superRefine((value, ctx) => {
    if (value.shapes_format === 'shacl-turtle' && typeof value.shapes !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shapes'],
        message: 'shapes must be a Turtle string when shapes_format is "shacl-turtle".',
      });
    }
    const gateProvided = Object.keys(CreateGateFieldsSchema).some(
      (field) => (value as Record<string, unknown>)[field] !== undefined,
    );
    if (gateProvided && value.shapes_format !== 'shacl-turtle') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['shapes_format'],
        message:
          'Policy gate fields belong inside the shapes document for legacy JSON policies; top-level gates require shapes_format "shacl-turtle".',
      });
    }
  });

export const PolicyPackageDetailsSchema = z.object({
  artifact_urn: z.string(),
  sha256: z.string(),
  policy_version: z.string(),
  created_by: z.string(),
  created_at: z.string(),
  description: z.string().optional(),
  shapes_format: PolicyShapesFormatSchema,
  shapes: z.unknown(),
});

export const ListPolicyPackagesOutputSchema = z.object({
  policy_packages: z.array(PolicyPackageDetailsSchema),
});

export type CreatePolicyPackageInput = z.infer<typeof CreatePolicyPackageInputSchema>;
