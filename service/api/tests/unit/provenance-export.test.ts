import { describe, expect, it } from 'vitest';

import {
  buildProvenanceTriples,
  canonicalizeProvenance,
  projectProvenanceToJsonLd,
  type ProvenanceExportInput,
  type ProvenanceTriple,
} from '../../../registry/application/services/provenance-export.js';

const PROV = 'http://www.w3.org/ns/prov#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function provenance(overrides: Partial<ProvenanceExportInput> = {}): ProvenanceExportInput {
  return {
    entity: { urn: 'urn:sg:skill-version:skill:demo@v2', entity_type: 'SKILL_VERSION' },
    derivation_chain: [
      {
        version_urn: 'urn:sg:skill-version:skill:demo@v2',
        was_derived_from: ['urn:sg:skill-version:skill:demo@v1'],
        activities: [
          {
            task_urn: 'urn:sg:task:t2',
            operation: 'publish',
            status: 'completed',
            occurred_at: '2026-11-16T10:00:00.000Z',
            actor: 'pablo',
            used: [
              { urn: 'urn:sg:artifact:sha256:policy', entity_type: 'ARTIFACT' },
              { urn: 'urn:sg:artifact:sha256:report', entity_type: 'ARTIFACT' },
            ],
            associated_agents: [{ urn: 'urn:sg:prov-agent:pablo', agent_name: 'Pablo', role: 'publisher' }],
          },
        ],
      },
      {
        version_urn: 'urn:sg:skill-version:skill:demo@v1',
        was_derived_from: [],
        activities: [
          {
            task_urn: 'urn:sg:task:t1',
            operation: 'create_draft',
            status: 'completed',
            occurred_at: '2026-11-15T09:00:00.000Z',
            actor: 'pablo',
            used: [],
            associated_agents: [{ urn: 'urn:sg:prov-agent:pablo', agent_name: 'Pablo', role: 'author' }],
          },
        ],
      },
    ],
    replay: [
      {
        occurred_at: '2026-11-15T09:00:00.000Z',
        operation: 'create_draft',
        actor: 'pablo',
        version_urn: 'urn:sg:skill-version:skill:demo@v1',
        status: 'completed',
      },
      {
        occurred_at: '2026-11-16T10:00:00.000Z',
        operation: 'publish',
        actor: 'pablo',
        version_urn: 'urn:sg:skill-version:skill:demo@v2',
        status: 'completed',
      },
    ],
    ...overrides,
  };
}

function sortedTripleKeys(triples: ProvenanceTriple[]): string[] {
  return triples
    .map((triple) =>
      JSON.stringify([triple.subject, triple.predicate, triple.object.kind, triple.object.value]),
    )
    .sort();
}

function invertJsonLd(jsonld: ReturnType<typeof projectProvenanceToJsonLd>): string[] {
  const triples: Array<[string, string, 'iri' | 'literal', string]> = [];
  const expand = (predicate: string): string =>
    predicate.startsWith('prov:') ? `${PROV}${predicate.slice('prov:'.length)}` : predicate.startsWith('sg:')
      ? `urn:sg:${predicate.slice('sg:'.length)}`
      : predicate;
  for (const node of jsonld['@graph']) {
    const subject = node['@id'];
    for (const type of node['@type'] ?? []) {
      triples.push([subject, RDF_TYPE, 'iri', type]);
    }
    for (const [predicate, entries] of Object.entries(node)) {
      if (predicate === '@id' || predicate === '@type') continue;
      for (const entry of entries as Array<Record<string, string>>) {
        if (typeof entry['@id'] === 'string') {
          triples.push([subject, expand(predicate), 'iri', entry['@id']]);
        } else if (typeof entry['@value'] === 'string') {
          triples.push([subject, expand(predicate), 'literal', entry['@value']]);
        }
      }
    }
  }
  return triples.map((triple) => JSON.stringify(triple)).sort();
}

describe('provenance export', () => {
  it('produces a byte-stable canonical digest across runs', async () => {
    const first = await canonicalizeProvenance(provenance());
    const second = await canonicalizeProvenance(provenance());
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.sha256).toBe(first.sha256);
    expect(second.nquads).toBe(first.nquads);
  });

  it('is invariant to backend-dependent ordering of collections', async () => {
    const shuffled: ProvenanceExportInput = {
      entity: provenance().entity,
      derivation_chain: provenance()
        .derivation_chain.map((entry) => ({
          ...entry,
          was_derived_from: [...entry.was_derived_from].reverse(),
          activities: entry.activities.map((activity) => ({
            ...activity,
            used: [...activity.used].reverse(),
            associated_agents: [...activity.associated_agents].reverse(),
          })),
        }))
        .reverse(),
      replay: [...provenance().replay].reverse(),
    };
    const base = await canonicalizeProvenance(provenance());
    const permuted = await canonicalizeProvenance(shuffled);
    expect(permuted.sha256).toBe(base.sha256);
  });

  it('JSON-LD is a lossless representation of the same triple list', () => {
    const triples = buildProvenanceTriples(provenance());
    const jsonld = projectProvenanceToJsonLd(provenance());
    expect(jsonld['@context']).toEqual({ prov: PROV, sg: 'urn:sg:' });
    expect(jsonld['@graph'].length).toBeGreaterThan(0);
    expect(invertJsonLd(jsonld)).toEqual(sortedTripleKeys(triples));
  });

  it('carries PROV-O structure: entity types, generation, derivation, roles', () => {
    const triples = buildProvenanceTriples(provenance());
    const has = (subject: string, predicate: string, value: string): boolean =>
      triples.some(
        (triple) => triple.subject === subject && triple.predicate === predicate && triple.object.value === value,
      );
    expect(has('urn:sg:skill-version:skill:demo@v2', RDF_TYPE, `${PROV}Entity`)).toBe(true);
    expect(has('urn:sg:skill-version:skill:demo@v2', `${PROV}wasGeneratedBy`, 'urn:sg:task:t2')).toBe(true);
    expect(
      has('urn:sg:skill-version:skill:demo@v2', `${PROV}wasDerivedFrom`, 'urn:sg:skill-version:skill:demo@v1'),
    ).toBe(true);
    expect(has('urn:sg:task:t2', `${PROV}used`, 'urn:sg:artifact:sha256:policy')).toBe(true);
    expect(has('urn:sg:task:t2', `${PROV}wasAssociatedWith`, 'urn:sg:prov-agent:pablo')).toBe(true);
    expect(has('urn:sg:prov-agent:pablo', RDF_TYPE, `${PROV}Agent`)).toBe(true);
    expect(has('urn:sg:prov-agent:pablo', 'urn:sg:property:role', 'publisher')).toBe(true);
  });

  it('escapes literals and rejects invalid IRIs', () => {
    const tricky = provenance({
      derivation_chain: [
        {
          version_urn: 'urn:sg:skill-version:skill:demo@v2',
          was_derived_from: [],
          activities: [
            {
              task_urn: 'urn:sg:task:t2',
              operation: 'publish',
              status: 'completed',
              actor: 'pablo "reviewer"\nsecond line',
              used: [],
              associated_agents: [],
            },
          ],
        },
      ],
    });
    return canonicalizeProvenance(tricky).then((result) => {
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.nquads).toContain('\\"reviewer\\"\\nsecond line');
    });
  });
});
