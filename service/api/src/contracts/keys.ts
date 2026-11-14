import { z } from 'zod';

// Entity keys become URNs embedded in SPARQL IRIs, so they are constrained to
// an IRI-safe charset at every input surface (defense in depth behind the
// graph store's fail-closed IRI composition).
export const ENTITY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/;

export const entityKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(ENTITY_KEY_PATTERN, {
    message: 'Keys may only contain letters, digits, and :._/- (must start alphanumeric).',
  });

export const harnessNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message: 'Harness names may only contain letters, digits, and ._- (must start alphanumeric).',
  });

// Full registry URNs are accepted where clients pass them back (e.g. linked
// skill refs); same IRI-safety rationale as keys.
export const registryUrnSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^urn:sg:[A-Za-z0-9:._~@/-]+$/, {
    message: 'Expected a urn:sg: registry URN with an IRI-safe body.',
  });
