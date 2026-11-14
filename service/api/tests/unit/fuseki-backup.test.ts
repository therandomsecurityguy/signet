import { describe, expect, it } from 'vitest';

import { collectFusekiBackup, fusekiBackupKey } from '../../../tessera-sidecar/src/fuseki-backup.js';

const GRAPH_LISTING = {
  head: { vars: ['g'] },
  results: {
    bindings: [
      { g: { type: 'uri', value: 'urn:sg:graph:b' } },
      { g: { type: 'uri', value: 'urn:sg:graph:a' } },
    ],
  },
};

describe('collectFusekiBackup', () => {
  it('lists graphs, exports the default graph first, then named graphs as N-Quads', async () => {
    const calls: Array<{ url: string; accept?: string; authorization?: string }> = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const accept = init?.method === 'POST' ? headers['content-type'] : headers['accept'];
      calls.push({
        url,
        ...(accept ? { accept } : {}),
        ...(headers['authorization'] ? { authorization: headers['authorization'] } : {}),
      });
      if (init?.method === 'POST') return new Response(JSON.stringify(GRAPH_LISTING), { status: 200 });
      if (url.includes('graph=urn%3Asg%3Agraph%3Aa')) {
        return new Response('<urn:s1> <urn:p> <urn:o> <urn:sg:graph:a> .\n', { status: 200 });
      }
      if (url.includes('graph=urn%3Asg%3Agraph%3Ab')) {
        return new Response('<urn:s2> <urn:p> <urn:o> <urn:sg:graph:b> .\n', { status: 200 });
      }
      return new Response('<urn:d> <urn:p> <urn:o> .\n', { status: 200 });
    }) as typeof fetch;

    const got = await collectFusekiBackup({
      queryUrl: 'http://fuseki:3030/registry/sparql',
      dataUrl: 'http://fuseki:3030/registry/data',
      username: 'admin',
      password: 'secret',
      fetchImpl,
    });

    // Default graph first, named graphs sorted.
    expect(got.namedGraphs).toBe(2);
    expect(got.lines).toBe(3);
    const lines = got.nquads.trimEnd().split('\n');
    expect(lines[0]).toContain('<urn:d>');
    expect(lines[1]).toContain('urn:sg:graph:a');
    expect(lines[2]).toContain('urn:sg:graph:b');
    // Basic auth is applied to the graph-store reads.
    expect(calls.every((call) => call.authorization?.startsWith('Basic '))).toBe(true);
  });

  it('fails loudly when a graph read errors', async () => {
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify(GRAPH_LISTING), { status: 200 });
      if (String(input).includes('graph=')) return new Response('boom', { status: 500 });
      return new Response('<urn:d> <urn:p> <urn:o> .\n', { status: 200 });
    }) as typeof fetch;
    await expect(
      collectFusekiBackup({
        queryUrl: 'http://fuseki:3030/registry/sparql',
        dataUrl: 'http://fuseki:3030/registry/data',
        fetchImpl,
      }),
    ).rejects.toThrow('fuseki graph fetch failed (500)');
  });

  it('assembles the dated gzip key under the backup prefix', () => {
    expect(fusekiBackupKey({ prefix: 'cachet/prod/', date: new Date('2026-11-01T03:17:00Z') })).toBe(
      'cachet/prod/backups/fuseki/2026-11-01.nq.gz',
    );
  });
});
