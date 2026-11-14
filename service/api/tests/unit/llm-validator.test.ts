import { describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { HeuristicLlmValidator, HttpLlmValidator, type LlmValidationInput } from '../../../registry/application/services/llm-validator.js';

const validator = new HeuristicLlmValidator();

function input(overrides: Partial<LlmValidationInput> = {}): LlmValidationInput {
  return {
    entity_type: 'SKILL_VERSION',
    publication_urn: 'urn:sg:skill-version:skill:demo@v1',
    display_name: 'Data Pipeline',
    description: 'Processes data from the warehouse and produces reports.',
    capability_claims: ['data-processing', 'reporting'],
    examples: [],
    known_concepts: ['data-processing', 'reporting'],
    ...overrides,
  };
}

describe('heuristic LLM validator', () => {
  it('passes grounded claims with high scores and no warnings', async () => {
    const result = await validator.validate(input());
    expect(result.warnings).toEqual([]);
    const overclaim = result.scorecards.find((s) => s.dimension === 'overclaim');
    expect(overclaim?.score).toBe(1);
    expect(result.validator).toBe('llm-heuristic-v1');
    expect(result.confidence).toBe(0.5);
    expect(result.prompt).toContain('urn:sg:skill-version:skill:demo@v1');
  });

  it('flags claims not grounded in the description as possible overclaims', async () => {
    const result = await validator.validate(input({ capability_claims: ['data-processing', 'teleportation'] }));
    expect(result.warnings.some((w) => w.includes('teleportation'))).toBe(true);
    const overclaim = result.scorecards.find((s) => s.dimension === 'overclaim');
    expect(overclaim?.score).toBeLessThan(1);
    expect(overclaim?.rationale).toContain('teleportation');
  });

  it('flags vague and superlative language as ambiguity', async () => {
    const result = await validator.validate(
      input({ description: 'The best seamless solution for everything, etc.' }),
    );
    expect(result.warnings.some((w) => w.includes('"best"'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('"seamless"'))).toBe(true);
    const ambiguity = result.scorecards.find((s) => s.dimension === 'ambiguity');
    expect(ambiguity?.score).toBeLessThan(1);
  });

  it('flags examples referencing undeclared capabilities', async () => {
    const result = await validator.validate(
      input({ examples: ['run the quantum-sort job', 'produce reports'] }),
    );
    expect(result.warnings.some((w) => w.includes('quantum-sort'))).toBe(true);
    const consistency = result.scorecards.find((s) => s.dimension === 'example_consistency');
    expect(consistency?.score).toBeLessThan(1);
  });

  it('suggests missing ontology terms from uncovered description tokens', async () => {
    const result = await validator.validate(
      input({ description: 'Processes data with the quantum-sort pipeline.' }),
    );
    expect(result.suggestions.missing_ontology_terms).toContain('quantum-sort');
    expect(result.suggestions.policy_warnings.length).toBeGreaterThan(0);
  });

  it('produces the full evidence shape for every run', async () => {
    const result = await validator.validate(input());
    expect(result.scorecards.map((s) => s.dimension)).toEqual([
      'overclaim',
      'ambiguity',
      'example_consistency',
      'term_coverage',
    ]);
    for (const scorecard of result.scorecards) {
      expect(scorecard.score).toBeGreaterThanOrEqual(0);
      expect(scorecard.score).toBeLessThanOrEqual(1);
      expect(scorecard.rationale.length).toBeGreaterThan(0);
    }
    expect(result.suggestions).toBeDefined();
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

describe('HTTP LLM validator seam', () => {
  async function withMockServer(
    handler: (c: { req: { json: () => Promise<unknown> }; json: (body: unknown, status?: number) => Response }) => Response | Promise<Response>,
    run: (url: string) => Promise<void>,
  ) {
    const app = new Hono();
    app.post('/v1/validate', handler);
    const server = serve({ fetch: app.fetch, port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      await run(`http://127.0.0.1:${port}/v1/validate`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }

  it('rejects non-http(s) endpoint URLs at construction (SSRF mitigation)', () => {
    expect(() => new HttpLlmValidator({ url: 'file:///etc/passwd' })).toThrow(/http: or https:/);
    expect(() => new HttpLlmValidator({ url: 'gopher://internal/1' })).toThrow(/http: or https:/);
    expect(() => new HttpLlmValidator({ url: 'not a url' })).toThrow(/not a valid URL/);
  });

  it('sanitizes hostile model responses (prototype pollution and bad shapes)', async () => {
    await withMockServer(
      (c) =>
        c.json({
          __proto__: { polluted: true },
          constructor: 'evil',
          scorecards: [
            { dimension: 'overclaim', score: 9001, rationale: 'fine', __proto__: { x: 1 } },
            { dimension: 'not-a-dimension', score: 1 },
            'garbage',
            { score: 'nan' },
          ],
          confidence: Number.POSITIVE_INFINITY,
          suggestions: { missing_ontology_terms: ['ok', 42, { bad: true }], policy_warnings: 'nope' },
          warnings: ['real warning', { evil: true }, 7],
        }),
      async (url) => {
        const validator = new HttpLlmValidator({ url, model: 'test-model' });
        const result = await validator.validate(input());
        expect(result.validator).toBe('test-model');
        expect(result.scorecards).toHaveLength(1);
        expect(result.scorecards[0]).toEqual({ dimension: 'overclaim', score: 1, rationale: 'fine' });
        expect(result.confidence).toBe(0.5);
        expect(result.suggestions.missing_ontology_terms).toEqual(['ok']);
        expect(result.suggestions.policy_warnings).toEqual([]);
        expect(result.warnings).toEqual(['real warning']);
        // No prototype pollution leaked into the result objects.
        expect((result as Record<string, unknown>)['polluted']).toBeUndefined();
        expect(Object.getPrototypeOf(result.scorecards[0])).toBe(Object.prototype);
        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      },
    );
  });

  it('falls back to the heuristic validator when the endpoint fails', async () => {
    await withMockServer(
      (c) => c.json({ error: 'boom' }, 500),
      async (url) => {
        const validator = new HttpLlmValidator({ url });
        const result = await validator.validate(input());
        expect(result.validator).toBe('llm-heuristic-v1');
      },
    );
  });

  it('falls back when the endpoint is unreachable', async () => {
    const validator = new HttpLlmValidator({ url: 'http://127.0.0.1:1/v1/validate' });
    const result = await validator.validate(input());
    expect(result.validator).toBe('llm-heuristic-v1');
  });
});
