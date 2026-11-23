import { createServer } from 'node:net';

import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import {
  LLM_OPENAI_COMPATIBLE_SYSTEM_PROMPT,
  OpenAiCompatibleLlmValidator,
  type LlmValidationInput,
} from '../../../registry/application/services/llm-validator.js';

const servers: ServerType[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to reserve free port.'));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

type RecordedRequest = { path: string; body: Record<string, unknown>; authorization: string | undefined };

async function startFakeChatEndpoint(options?: { status?: number; content?: string }): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
}> {
  const requests: RecordedRequest[] = [];
  const app = new Hono();
  app.post('/v1/chat/completions', async (c) => {
    requests.push({
      path: c.req.path,
      body: (await c.req.json()) as Record<string, unknown>,
      authorization: c.req.header('authorization'),
    });
    if (options?.status && options.status !== 200) {
      return c.json({ error: { message: 'boom' } }, options.status as 200);
    }
    const content =
      options?.content ??
      JSON.stringify({
        scorecards: [
          { dimension: 'overclaim', score: 0.9, rationale: 'claims are grounded' },
          { dimension: 'not_a_dimension', score: 0.1, rationale: 'dropped' },
        ],
        confidence: 0.8,
        suggestions: { missing_ontology_terms: ['data-lake'], policy_warnings: [] },
        warnings: ['model says ok'],
      });
    return c.json({ choices: [{ message: { role: 'assistant', content } }] });
  });
  const port = await getFreePort();
  const server = await new Promise<ServerType>((resolve) => {
    const started = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => resolve(started));
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

const input: LlmValidationInput = {
  entity_type: 'SKILL_VERSION',
  publication_urn: 'urn:sg:skill-version:skill:fake@v1',
  display_name: 'Fake',
  description: 'does things',
  capability_claims: ['data-processing'],
  examples: [],
  known_concepts: ['data-processing'],
};

describe('OpenAI-compatible LLM validator', () => {
  it('posts Chat Completions and maps sanitized evidence with the model-tagged validator id', async () => {
    const fake = await startFakeChatEndpoint();
    const validator = new OpenAiCompatibleLlmValidator({
      base_url: fake.baseUrl,
      model: 'fake-model',
      api_key: 'sk-test',
    });
    const result = await validator.validate(input);

    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0] as RecordedRequest;
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.authorization).toBe('Bearer sk-test');
    expect(request.body['model']).toBe('fake-model');
    expect(request.body['temperature']).toBe(0);
    expect(request.body['response_format']).toBeUndefined(); // json_mode off by default
    const messages = request.body['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toBe(LLM_OPENAI_COMPATIBLE_SYSTEM_PROMPT);
    expect(messages[1]?.content).toContain('urn:sg:skill-version:skill:fake@v1');
    expect(messages[1]?.content).toContain('data-processing');

    expect(result.validator).toBe('llm-openai-compatible-v1:fake-model');
    // Unknown dimensions are dropped; known ones clamped.
    expect(result.scorecards).toEqual([
      { dimension: 'overclaim', score: 0.9, rationale: 'claims are grounded' },
    ]);
    expect(result.confidence).toBe(0.8);
    expect(result.suggestions.missing_ontology_terms).toEqual(['data-lake']);
    expect(result.warnings).toEqual(['model says ok']);
  });

  it('requests JSON mode when enabled and tolerates markdown-fenced content', async () => {
    const fenced = '```json\n{"scorecards":[],"confidence":0.7,"suggestions":{},"warnings":["fenced"]}\n```';
    const fake = await startFakeChatEndpoint({ content: fenced });
    const validator = new OpenAiCompatibleLlmValidator({ base_url: fake.baseUrl, json_mode: true });
    const result = await validator.validate(input);
    expect((fake.requests[0] as RecordedRequest).body['response_format']).toEqual({ type: 'json_object' });
    expect(result.validator).toBe('llm-openai-compatible-v1');
    expect(result.confidence).toBe(0.7);
    expect(result.warnings).toEqual(['fenced']);
  });

  it('falls back to the heuristic validator on malformed or failed responses', async () => {
    const malformed = await startFakeChatEndpoint({ content: 'not json at all' });
    const fallbackValidator = new OpenAiCompatibleLlmValidator({ base_url: malformed.baseUrl });
    expect((await fallbackValidator.validate(input)).validator).toBe('llm-heuristic-v1');

    const failing = await startFakeChatEndpoint({ status: 500 });
    const failingValidator = new OpenAiCompatibleLlmValidator({ base_url: failing.baseUrl });
    expect((await failingValidator.validate(input)).validator).toBe('llm-heuristic-v1');

    // Unreachable endpoint (nothing listens on this port).
    const port = await getFreePort();
    const unreachable = new OpenAiCompatibleLlmValidator({ base_url: `http://127.0.0.1:${port}/v1`, timeout_ms: 2_000 });
    expect((await unreachable.validate(input)).validator).toBe('llm-heuristic-v1');
  });

  it('sanitizes hostile payloads (prototype keys, non-string arrays)', async () => {
    const hostile = JSON.stringify({
      __proto__: { polluted: true },
      scorecards: [{ dimension: 'ambiguity', score: 7, rationale: 'x'.repeat(5_000) }],
      confidence: 42,
      suggestions: { missing_ontology_terms: ['ok', 13, null], policy_warnings: 'not-an-array' },
      warnings: ['fine', 7],
    });
    const fake = await startFakeChatEndpoint({ content: hostile });
    const validator = new OpenAiCompatibleLlmValidator({ base_url: fake.baseUrl });
    const result = await validator.validate(input);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(result.scorecards[0]?.score).toBe(1); // clamped
    expect(result.scorecards[0]?.rationale.length).toBe(2_000);
    expect(result.confidence).toBe(1);
    expect(result.suggestions.missing_ontology_terms).toEqual(['ok']);
    expect(result.suggestions.policy_warnings).toEqual([]);
    expect(result.warnings).toEqual(['fine']);
  });

  it('rejects non-http(s) base URLs at construction', () => {
    expect(() => new OpenAiCompatibleLlmValidator({ base_url: 'ftp://example.com/v1' })).toThrow(/http: or https:/);
    expect(() => new OpenAiCompatibleLlmValidator({ base_url: 'not a url' })).toThrow(/valid URL/);
  });
});

describe('advisory layer with the OpenAI-compatible backend wired through env', () => {
  it('records the backend validator id in llm evidence without blocking validation', async () => {
    const fake = await startFakeChatEndpoint();
    const env = loadEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: ':memory:',
      REGISTRY_GRAPH_BACKEND: 'memory',
      LLM_VALIDATOR_URL: fake.baseUrl,
      LLM_VALIDATOR_PROVIDER: 'openai-compatible',
      LLM_VALIDATOR_MODEL: 'fake-model',
    });
    const deps = buildAppDependencies(env);
    await deps.ready();
    const { token } = await deps.apiKeys.create({ owner_label: 'LLM Backend Writer' });
    const app = buildApp(deps);

    const draft = await app.request('/v1/skills/skill:llm-backend/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        author: 'pablo',
        description: 'does things',
        artifact: { content: '# x', original_path: 'skills/llm-backend.md' },
        capability_claims: ['data-processing'],
      }),
    });
    expect(draft.status).toBe(200);
    const validate = await app.request('/v1/skills/skill:llm-backend/versions/1/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(validate.status).toBe(200);
    await expect(validate.json()).resolves.toMatchObject({
      result: { skill_version: { properties: { lifecycle_status: 'validated' } } },
    });

    const version = await app.request('/v1/skills/skill:llm-backend/versions/1');
    const versionBody = (await version.json()) as {
      governance_artifacts: Array<{ role: string; artifact_urn: string }>;
    };
    let validatorId: string | undefined;
    for (const report of versionBody.governance_artifacts.filter((a) => a.role === 'validation_report')) {
      const sha = report.artifact_urn.replace('urn:sg:artifact:sha256:', '');
      const stored = await deps.registryCas.getBySha256(sha);
      if (!stored) continue;
      const content = JSON.parse(new TextDecoder().decode(stored.bytes)) as {
        payload?: { validator_kind?: string; validator?: string };
      };
      if (content.payload?.['validator_kind'] === 'llm_semantic') {
        validatorId = content.payload.validator;
      }
    }
    expect(validatorId).toBe('llm-openai-compatible-v1:fake-model');
    expect(fake.requests.length).toBeGreaterThanOrEqual(1);
  });
});
