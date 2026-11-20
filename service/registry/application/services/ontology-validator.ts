/**
 * Ontology validation for capability claims.
 *
 * Ontology packages are versioned, content-addressed documents in two
 * kinds, kept architecturally separate per the governance model:
 * - `registry_shape`: governs lifecycle, publication, evidence, and
 *   certification vocabulary (registered for governance evidence; not
 *   executed against capability claims)
 * - `skill_area`: describes domain concepts that skill/agent capability
 *   claims must bind to, plus prohibited semantic combinations
 *
 * Ontology validation ensures semantic coherence beyond structural
 * shape: every capability claim must bind to a known concept in the
 * resolved normative skill-area ontology, and no claim set may contain
 * concepts declared disjoint. Unmapped claims are reported as de facto
 * vocabulary candidates (evidence for future normative promotion; the
 * mining/promotion workflow itself remains future work).
 *
 * Violations reuse the SHACL result vocabulary from the SHACL-like
 * policy layer so all validation layers share one report format.
 */

import type { ValidationViolation } from './shacl-like-validator.js';

export type OntologyKind = 'registry_shape' | 'skill_area';

export type OntologyConcept = {
  id: string;
  label?: string;
  parents?: string[];
};

export type OntologyDocument = {
  kind: OntologyKind;
  concepts: OntologyConcept[];
  disjoint: Array<[string, string]>;
};

export class OntologyDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OntologyDocumentError';
  }
}

export function parseOntologyDocument(raw: unknown): OntologyDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OntologyDocumentError('Ontology document must be a JSON object.');
  }
  const record = raw as Record<string, unknown>;
  const kind = record['kind'];
  if (kind !== 'registry_shape' && kind !== 'skill_area') {
    throw new OntologyDocumentError('Ontology document kind must be registry_shape or skill_area.');
  }
  const concepts = record['concepts'];
  if (!Array.isArray(concepts) || concepts.length === 0) {
    throw new OntologyDocumentError('Ontology document must contain a non-empty concepts array.');
  }
  const parsedConcepts = concepts.map((concept, index) => parseConcept(concept, index));
  const ids = new Set<string>();
  for (const concept of parsedConcepts) {
    if (ids.has(concept.id)) {
      throw new OntologyDocumentError(`Duplicate concept id: ${concept.id}`);
    }
    ids.add(concept.id);
  }
  for (const concept of parsedConcepts) {
    for (const parent of concept.parents ?? []) {
      if (!ids.has(parent)) {
        throw new OntologyDocumentError(`Concept ${concept.id} references unknown parent concept: ${parent}`);
      }
    }
  }
  const disjoint = record['disjoint'];
  if (disjoint !== undefined && !Array.isArray(disjoint)) {
    throw new OntologyDocumentError('Ontology document disjoint must be an array of concept id pairs.');
  }
  const parsedDisjoint: Array<[string, string]> = (disjoint ?? []).map((pair, index) => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      throw new OntologyDocumentError(`Disjoint entry at index ${index} must be a pair of concept ids.`);
    }
    for (const id of pair as string[]) {
      if (!ids.has(id)) {
        throw new OntologyDocumentError(`Disjoint entry references unknown concept: ${id}`);
      }
    }
    return [pair[0] as string, pair[1] as string];
  });
  return { kind, concepts: parsedConcepts, disjoint: parsedDisjoint };
}

function parseConcept(raw: unknown, index: number): OntologyConcept {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OntologyDocumentError(`Concept at index ${index} must be an object.`);
  }
  const record = raw as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new OntologyDocumentError(`Concept at index ${index} requires a non-empty string id.`);
  }
  const parents = record['parents'];
  if (parents !== undefined && (!Array.isArray(parents) || parents.some((p) => typeof p !== 'string'))) {
    throw new OntologyDocumentError(`Concept ${id} parents must be an array of concept ids.`);
  }
  return {
    id,
    ...(typeof record['label'] === 'string' ? { label: record['label'] } : {}),
    ...(parents ? { parents: parents as string[] } : {}),
  };
}

export type OntologyValidationResult = {
  violations: ValidationViolation[];
  de_facto_candidates: string[];
};

/**
 * Validate capability claims against a normative skill-area ontology.
 * Claims that bind to no known concept are Violations (normative
 * ontologies govern publication decisions) and are also reported as de
 * facto vocabulary candidates. Claim sets containing disjoint concept
 * pairs fail even when every claim binds — and disjointness is
 * SUBCLASS-AWARE: a claim on a subclass of one disjoint concept combined
 * with a claim on a subclass of the other is the same conflict, reported
 * with the claims and the disjoint ancestor pair that produced it. A
 * single multiply-derived claim covering both sides of a pair is an
 * ontology-inconsistency question, not a claim combination, and is not
 * flagged here.
 */
export function validateCapabilityClaims(input: {
  focus_urn: string;
  claims: string[];
  document: OntologyDocument;
  ontology_version: string;
}): OntologyValidationResult {
  const violations: ValidationViolation[] = [];
  const known = new Map(input.document.concepts.map((concept) => [concept.id, concept]));
  const deFactoCandidates: string[] = [];

  for (const claim of input.claims) {
    if (!known.has(claim)) {
      deFactoCandidates.push(claim);
      violations.push({
        focusNode: input.focus_urn,
        resultPath: 'capability_claims',
        sourceConstraintComponent: 'OntologyBindingConstraintComponent',
        sourceShape: `ontology:${input.ontology_version}`,
        message: `capability claim does not bind to a known concept: ${claim}`,
        severity: 'Violation',
      });
    }
  }

  // Ancestor closure per bound claim: exact binding plus every transitive
  // parent, so disjointness propagates through the subclass hierarchy.
  const closureByClaim = new Map<string, Set<string>>();
  for (const claim of input.claims) {
    const concept = known.get(claim);
    if (!concept) continue;
    const closure = new Set<string>([claim]);
    const queue: string[] = [claim];
    while (queue.length > 0) {
      const conceptId = queue.pop() as string;
      for (const parent of known.get(conceptId)?.parents ?? []) {
        if (!closure.has(parent)) {
          closure.add(parent);
          queue.push(parent);
        }
      }
    }
    closureByClaim.set(claim, closure);
  }
  const orderedClaims = [...closureByClaim.keys()];

  for (const [left, right] of input.document.disjoint) {
    const leftClaim = orderedClaims.find((claim) => (closureByClaim.get(claim) as Set<string>).has(left));
    if (!leftClaim) continue;
    const rightClaim = orderedClaims.find(
      (claim) => claim !== leftClaim && (closureByClaim.get(claim) as Set<string>).has(right),
    );
    if (!rightClaim) continue;
    // Exact pairs keep the historical message byte-for-byte; subclass
    // witnesses append the disjoint ancestor pair for evidence.
    const viaDetail = leftClaim === left && rightClaim === right ? '' : ` (via ${left} + ${right})`;
    violations.push({
      focusNode: input.focus_urn,
      resultPath: 'capability_claims',
      sourceConstraintComponent: 'OntologyDisjointConstraintComponent',
      sourceShape: `ontology:${input.ontology_version}`,
      message: `capability claims combine disjoint concepts: ${leftClaim} + ${rightClaim}${viaDetail}`,
      severity: 'Violation',
    });
  }

  return { violations, de_facto_candidates: deFactoCandidates };
}
