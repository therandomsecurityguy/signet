import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { iri } from '../../../registry/domain/together/db/graph/freeform/registry/sparql-graph-store.js';
import { deFactoTermUrn } from '../../../registry/domain/together/db/graph/freeform/registry/urn.js';

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  return { app: buildApp(deps), deps };
}

describe('sparql IRI composition guard', () => {
  it('accepts registry URN shapes and rejects anything with IRI metacharacters', () => {
    expect(iri('urn:sg:skill:skill:argocd-break-glass')).toBe('<urn:sg:skill:skill:argocd-break-glass>');
    expect(iri('urn:sg:skill-version:deploy:security-prod/cachet@v1')).toBe(
      '<urn:sg:skill-version:deploy:security-prod/cachet@v1>',
    );
    expect(iri('urn:sg:defacto-term:c%2B%2B%20%3E%20java')).toContain('defacto-term');

    for (const unsafe of [
      'urn:sg:skill:x> . ?s ?p ?o } #',
      'urn:sg:skill:x<y',
      'urn:sg:skill:x y',
      'urn:sg:skill:x"y',
      'urn:sg:skill:x\\y',
      'urn:sg:skill:x{y}',
      'urn:sg:skill:x|y',
      'urn:sg:skill:x`y',
      'urn:sg:skill:x^y',
      '',
    ]) {
      expect(() => iri(unsafe), `expected rejection for ${JSON.stringify(unsafe)}`).toThrow(
        /unsafe value/,
      );
    }
  });

  it('percent-encodes free-form de-facto terms before they enter a URN', () => {
    const urn = deFactoTermUrn('C++ > Rust (v2)!');
    expect(urn).not.toContain('>');
    expect(urn).not.toContain(' ');
    expect(urn).not.toContain('(');
    expect(urn).toBe('urn:sg:defacto-term:C%2B%2B%20%3E%20Rust%20%28v2%29%21');
    expect(() => iri(urn)).not.toThrow();
  });
});

describe('input-surface key validation', () => {
  it('rejects injected skill and agent keys at the contract layer', async () => {
    const { app, deps } = await buildTestApp();
    const { token } = await deps.apiKeys.create({ owner_label: 'inj-test' });
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    const skill = await app.request('/v1/skills', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        skill_key: 'skill:x> . ?s ?p ?o } #',
        artifact: { content: '# x', original_path: 'skills/x.md' },
      }),
    });
    expect(skill.status).toBe(400);

    const agent = await app.request('/v1/agents', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agent_key: 'agent:ok', harness_name: 'x> y' }),
    });
    expect(agent.status).toBe(400);

    const ref = await app.request('/v1/agents', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agent_key: 'agent:ok', skill_refs: [{ skill_key: 'skill:bad key' }] }),
    });
    expect(ref.status).toBe(400);

    const draftPath = await app.request(
      `/v1/skills/${encodeURIComponent('skill:x> . ?s ?p ?o } #')}/drafts`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ author: 'inj', artifact: { content: '# x', original_path: 'skills/x.md' } }),
      },
    );
    expect(draftPath.status).toBe(400);
  });
});
