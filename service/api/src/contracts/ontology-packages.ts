import { z } from 'zod';

export const OntologyPackageFormatSchema = z.enum(['legacy-json-v1', 'owl-turtle']);

export const CreateOntologyPackageInputSchema = z
  .object({
    ontology_version: z.string().min(1).max(200),
    author: z.string().min(1).max(200),
    ontology: z.unknown(),
    /**
     * Omit for the legacy JSON ontology document format (the kind lives
     * inside the document). Set to "owl-turtle" to register authored OWL
     * Turtle; the registry kind is then an envelope field.
     */
    ontology_format: z.literal('owl-turtle').optional(),
    ontology_kind: z.enum(['registry_shape', 'skill_area']).optional(),
    description: z.string().min(1).max(2_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.ontology_format === 'owl-turtle') {
      if (typeof value.ontology !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ontology'],
          message: 'ontology must be a Turtle string when ontology_format is "owl-turtle".',
        });
      }
      if (value.ontology_kind === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ontology_kind'],
          message: 'ontology_kind is required when ontology_format is "owl-turtle".',
        });
      }
    } else if (value.ontology_kind !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ontology_kind'],
        message: 'ontology_kind is only accepted with ontology_format "owl-turtle".',
      });
    }
  });

export const OntologyPackageDetailsSchema = z.object({
  artifact_urn: z.string(),
  sha256: z.string(),
  ontology_version: z.string(),
  ontology_kind: z.enum(['registry_shape', 'skill_area']),
  ontology_format: OntologyPackageFormatSchema,
  /** RDFC-1.0 canonical digest over the ontology's semantic projection (format-independent). */
  canonical_rdf_sha256: z.string(),
  canonical_rdf_artifact_urn: z.string(),
  created_by: z.string(),
  created_at: z.string(),
  description: z.string().optional(),
  ontology: z.unknown(),
});

export const ListOntologyPackagesOutputSchema = z.object({
  ontology_packages: z.array(OntologyPackageDetailsSchema),
});

export type CreateOntologyPackageInput = z.infer<typeof CreateOntologyPackageInputSchema>;
