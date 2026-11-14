import { z } from 'zod';

export const CreateOntologyPackageInputSchema = z.object({
  ontology_version: z.string().min(1).max(200),
  author: z.string().min(1).max(200),
  ontology: z.unknown(),
  description: z.string().min(1).max(2_000).optional(),
});

export const OntologyPackageDetailsSchema = z.object({
  artifact_urn: z.string(),
  sha256: z.string(),
  ontology_version: z.string(),
  ontology_kind: z.enum(['registry_shape', 'skill_area']),
  created_by: z.string(),
  created_at: z.string(),
  description: z.string().optional(),
  ontology: z.unknown(),
});

export const ListOntologyPackagesOutputSchema = z.object({
  ontology_packages: z.array(OntologyPackageDetailsSchema),
});

export type CreateOntologyPackageInput = z.infer<typeof CreateOntologyPackageInputSchema>;
