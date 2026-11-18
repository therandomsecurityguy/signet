import { describe, expect, it } from 'vitest';

import { parseOwlOntologyTurtle } from '../../../registry/application/services/owl-ontology.js';
import {
  owlClassIriForConceptId,
  serializeOwlOntologyTurtle,
} from '../../../registry/application/services/owl-ontology-writer.js';
import { canonicalizeOntologyDocument } from '../../../registry/application/services/ontology-projection.js';
import type { OntologyDocument } from '../../../registry/application/services/ontology-validator.js';

const document: OntologyDocument = {
  kind: 'skill_area',
  concepts: [{ id: 'analysis', label: 'Analysis' }, { id: 'transform', parents: ['analysis'] }],
  disjoint: [['analysis', 'transform']],
};

function asDocument(turtle: string): OntologyDocument {
  const reparsed = parseOwlOntologyTurtle(turtle);
  return { kind: 'skill_area', concepts: reparsed.concepts, disjoint: reparsed.disjoint };
}

describe('authored-OWL writer', () => {
  it('round-trips a document deterministically with identical canonical digests', async () => {
    const first = serializeOwlOntologyTurtle(document);
    const second = serializeOwlOntologyTurtle(document);
    expect(second).toBe(first);
    expect(asDocument(first)).toEqual(document);
    const before = await canonicalizeOntologyDocument(document);
    const after = await canonicalizeOntologyDocument(asDocument(first));
    expect(after.sha256).toBe(before.sha256);
  });

  it('preserves source class IRIs and derives safe defaults for new concepts', () => {
    const turtle = serializeOwlOntologyTurtle(
      { ...document, concepts: [...document.concepts, { id: 'new_term' }] },
      { analysis: 'urn:example:Analysis', transform: 'urn:example:Transform' },
    );
    const reparsed = parseOwlOntologyTurtle(turtle);
    expect(reparsed.iri_by_id['analysis']).toBe('urn:example:Analysis');
    expect(reparsed.iri_by_id['transform']).toBe('urn:example:Transform');
    expect(reparsed.iri_by_id['new_term']).toBe(owlClassIriForConceptId('new_term'));
  });

  it('emits concept-id overrides when the IRI local name differs from the id', () => {
    const turtle = serializeOwlOntologyTurtle(
      { kind: 'skill_area', concepts: [{ id: 'data_access' }], disjoint: [] },
      { data_access: 'urn:example:Data-Access' },
    );
    expect(turtle).toContain('<urn:sg:property:concept-id> "data_access"');
    expect(parseOwlOntologyTurtle(turtle).concepts).toEqual([{ id: 'data_access' }]);
  });

  it('round-trips ids that are not IRI-safe through the emitted override', () => {
    const turtle = serializeOwlOntologyTurtle({
      kind: 'skill_area',
      concepts: [{ id: 'data access' }],
      disjoint: [],
    });
    expect(parseOwlOntologyTurtle(turtle).concepts).toEqual([{ id: 'data access' }]);
  });

  it('refuses documents that do not survive the round trip (IRI collisions)', () => {
    expect(() =>
      serializeOwlOntologyTurtle(
        { kind: 'skill_area', concepts: [{ id: 'alpha' }, { id: 'beta' }], disjoint: [] },
        // Collide beta's class IRI with alpha's default mapping.
        { beta: owlClassIriForConceptId('alpha') },
      ),
    ).toThrow(/round-trip/);
  });
});
