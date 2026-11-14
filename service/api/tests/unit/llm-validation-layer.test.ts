import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'LLM Layer Writer' });
  return { app: buildApp(deps), deps, token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

describe('advisory LLM validation layer', () => {
  it('produces evidence without ever blocking validation', async () => {
    const { app, deps, token } = await buildTestApp();

    // Draft with an unsupported claim and vague language: deterministic
    // layers pass, so the version must validate despite LLM warnings.
    const draft = await app.request('/v1/skills/skill:llm-layer/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        display_name: 'Magic Pipeline',
        description: 'The best seamless pipeline for everything.',
        artifact: { content: '# llm layer', original_path: 'skills/llm-layer.md' },
        capability_claims: ['teleportation'],
      }),
    });
    expect(draft.status).toBe(200);

    const validate = await app.request('/v1/skills/skill:llm-layer/versions/1/validate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(validate.status).toBe(200);
    // Advisory rule: LLM warnings never cause rejection.
    await expect(validate.json()).resolves.toMatchObject({
      result: { skill_version: { properties: { lifecycle_status: 'validated' } } },
    });

    // The LLM evidence artifact (scorecards, prompt, confidence) is stored
    // in the CAS and linked via sg:validatedBy.
    const version = await app.request('/v1/skills/skill:llm-layer/versions/1');
    expect(version.status).toBe(200);
    const versionBody = (await version.json()) as {
      governance_artifacts: Array<{ role: string; artifact_urn: string }>;
    };
    const reports = versionBody.governance_artifacts.filter((a) => a.role === 'validation_report');
    expect(reports.length).toBeGreaterThanOrEqual(2);

    type LlmEvidence = {
      validator_kind: string;
      validator: string;
      prompt: string;
      scorecards: Array<{ dimension: string; score: number; rationale: string }>;
      confidence: number;
      warnings: string[];
      advisory: boolean;
    };
    let llmEvidence: LlmEvidence | null = null;
    for (const report of reports) {
      const sha = report.artifact_urn.replace('urn:sg:artifact:sha256:', '');
      const stored = await deps.registryCas.getBySha256(sha);
      if (!stored) continue;
      const content = JSON.parse(new TextDecoder().decode(stored.bytes)) as {
        payload?: { validator_kind?: string } & Record<string, unknown>;
      };
      if (content.payload?.['validator_kind'] === 'llm_semantic') {
        llmEvidence = content.payload as unknown as LlmEvidence;
      }
    }
    expect(llmEvidence).not.toBeNull();
    expect(llmEvidence?.advisory).toBe(true);
    expect(llmEvidence?.validator).toBe('llm-heuristic-v1');
    expect(llmEvidence?.prompt).toContain('urn:sg:skill-version:skill:llm-layer@v1');
    expect(llmEvidence?.scorecards.map((s) => s.dimension)).toEqual([
      'overclaim',
      'ambiguity',
      'example_consistency',
      'term_coverage',
    ]);
    expect(llmEvidence?.warnings.some((w: string) => w.includes('teleportation'))).toBe(true);
    expect(llmEvidence?.warnings.some((w: string) => w.includes('"best"'))).toBe(true);
  });
});
