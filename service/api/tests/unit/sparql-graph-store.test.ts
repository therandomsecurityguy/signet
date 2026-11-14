import { afterEach, describe, expect, it, vi } from 'vitest';

import { SparqlGraphStore } from '../../../registry/domain/together/db/graph/freeform/registry/sparql-graph-store.js';

describe('SparqlGraphStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses derived update endpoint for node upserts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const store = new SparqlGraphStore({
      query_url: 'http://localhost:3030/registry/sparql',
      username: 'admin',
      password: 'admin',
    });

    await store.upsertNode({
      urn: 'urn:sg:agent:cursor:test',
      entity_type: 'AGENT',
      properties: { agent_key: 'cursor:test' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:3030/registry/update');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/sparql-update',
        authorization: expect.stringMatching(/^Basic /),
      },
    });
  });

  it('parses node results from SPARQL JSON responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            bindings: [
              {
                entity_type: { value: 'AGENT' },
                properties: { value: '{"agent_key":"cursor:test","display_name":"Test"}' },
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/sparql-results+json' },
        },
      ),
    );

    const store = new SparqlGraphStore({
      query_url: 'http://localhost:3030/registry/sparql',
    });

    const got = await store.getNode('urn:sg:agent:cursor:test');
    expect(got).toEqual({
      urn: 'urn:sg:agent:cursor:test',
      entity_type: 'AGENT',
      properties: {
        agent_key: 'cursor:test',
        display_name: 'Test',
      },
    });
  });

  it('parses edge traversal results from SPARQL JSON responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            bindings: [
              {
                to_urn: { value: 'urn:sg:skill:skill:test' },
                predicate: { value: 'sg:usesSkill' },
                properties: { value: '{}' },
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/sparql-results+json' },
        },
      ),
    );

    const store = new SparqlGraphStore({
      query_url: 'http://localhost:3030/registry/sparql',
    });

    const edges = await store.listEdgesFrom('urn:sg:agent:cursor:test', 'sg:usesSkill');
    expect(edges).toEqual([
      {
        from_urn: 'urn:sg:agent:cursor:test',
        to_urn: 'urn:sg:skill:skill:test',
        predicate: 'sg:usesSkill',
        properties: {},
      },
    ]);
  });
});
