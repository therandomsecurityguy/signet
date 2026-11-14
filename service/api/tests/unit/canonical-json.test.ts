import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import {
  JCS_CANONICALIZATION_ALGORITHM,
  LEGACY_CANONICALIZATION_ALGORITHM,
  canonicalJsonString,
  canonicalizeWith,
  legacyCanonicalJsonString,
  resolveCanonicalizationAlgorithm,
} from '../../../registry/application/services/canonical-json.js';
import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

async function buildTestApp(overrides: NodeJS.ProcessEnv = {}) {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
    ...overrides,
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Canonicalization Writer' });
  return { app: buildApp(deps), token };
}

describe('RFC 8785 (JCS) canonical JSON', () => {
  it('sorts object keys by UTF-16 code units', () => {
    const value = { '2': 'f', '10': 'f', '1': 'f', F: 'f', '3': 'f' };
    expect(canonicalJsonString(value)).toBe('{"1":"f","10":"f","2":"f","3":"f","F":"f"}');
  });

  it('sorts keys with control and non-ASCII characters by code unit', () => {
    const value = { '\r': 'cr', '\u0000': 'nul', a: 'lower', A: 'upper', '€': 'euro' };
    expect(canonicalJsonString(value)).toBe(
      '{"\\u0000":"nul","\\r":"cr","A":"upper","a":"lower","€":"euro"}',
    );
  });

  it('matches the RFC 8785 appendix A number and literal vector', () => {
    const value = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27],
      string: '€$\u000F\nA\'B"\\\\"/',
      literals: [null, true, false],
    };
    expect(canonicalJsonString(value)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('serializes -0 as 0', () => {
    expect(canonicalJsonString([-0])).toBe('[0]');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJsonString([Number.NaN])).toThrow(TypeError);
    expect(() => canonicalJsonString({ value: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it('drops undefined object properties deterministically', () => {
    expect(canonicalJsonString({ b: undefined, a: 1 })).toBe('{"a":1}');
  });

  it('diverges from the legacy localeCompare serializer on case-ordered keys', () => {
    const value = { a: 1, B: 2 };
    expect(canonicalJsonString(value)).toBe('{"B":2,"a":1}');
    expect(legacyCanonicalJsonString(value)).toBe('{"a":1,"B":2}');
  });

  it('canonicalizeWith dispatches on the recorded algorithm', () => {
    const value = { a: 1, B: 2 };
    expect(canonicalizeWith(JCS_CANONICALIZATION_ALGORITHM, value)).toBe('{"B":2,"a":1}');
    expect(canonicalizeWith(LEGACY_CANONICALIZATION_ALGORITHM, value)).toBe('{"a":1,"B":2}');
  });

  it('resolveCanonicalizationAlgorithm defaults unknown or missing values to legacy', () => {
    expect(resolveCanonicalizationAlgorithm('jcs-rfc8785')).toBe('jcs-rfc8785');
    expect(resolveCanonicalizationAlgorithm(undefined)).toBe('json-key-sort-v1');
    expect(resolveCanonicalizationAlgorithm('something-else')).toBe('json-key-sort-v1');
  });
});

describe('publication envelope canonicalization and references', () => {
  it('publishes envelopes with JCS canonicalization plus provenance, supersession, and revocation refs', async () => {
    const { app, token } = await buildTestApp();
    const headers = { 'content-type': 'application/json', Authorization: `Bearer ${token}` };

    const draftOne = await app.request('/v1/skills/skill:canonical/drafts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        author: 'pablo',
        display_name: 'Canonical skill',
        artifact: { content: '# canonical v1', original_path: 'skills/canonical.md' },
      }),
    });
    expect(draftOne.status).toBe(200);
    const publishOne = await app.request('/v1/skills/skill:canonical/versions/1/publish', {
      method: 'POST',
      headers,
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(publishOne.status).toBe(200);

    const draftTwo = await app.request('/v1/skills/skill:canonical/drafts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# canonical v2', original_path: 'skills/canonical.md' },
        lineage: {
          upstream_skill_version_urns: ['urn:tg:skill-version:skill:canonical@v1'],
          openlineage: { job_namespace: 'registry', job_name: 'canonical-job', run_id: 'run-1' },
        },
      }),
    });
    expect(draftTwo.status).toBe(200);
    const publishTwo = await app.request('/v1/skills/skill:canonical/versions/2/publish', {
      method: 'POST',
      headers,
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(publishTwo.status).toBe(200);
    const promote = await app.request('/v1/skills/skill:canonical/versions/2/promote', {
      method: 'POST',
      headers,
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(promote.status).toBe(200);

    const envelopeTwo = await app.request('/v1/skills/skill:canonical/versions/2/publication-envelope');
    expect(envelopeTwo.status).toBe(200);
    const bodyTwo = (await envelopeTwo.json()) as Record<string, unknown>;
    expect(bodyTwo['canonicalization_algorithm']).toBe('jcs-rfc8785');
    expect(bodyTwo['provenance_refs']).toEqual({
      upstream_version_urns: ['urn:tg:skill-version:skill:canonical@v1'],
      openlineage: { job_namespace: 'registry', job_name: 'canonical-job', run_id: 'run-1' },
    });

    // The canonical payload must be valid JCS: re-serializing the parsed
    // payload reproduces the exact bytes, and the digest matches.
    const canonicalJson = bodyTwo['canonical_json'] as string;
    expect(canonicalJsonString(JSON.parse(canonicalJson))).toBe(canonicalJson);
    expect(bodyTwo['canonical_json_sha256']).toBe(
      createHash('sha256').update(Buffer.from(canonicalJson, 'utf8')).digest('hex'),
    );

    // Superseded v1 envelope carries supersession refs.
    const envelopeOne = await app.request('/v1/skills/skill:canonical/versions/1/publication-envelope');
    const bodyOne = (await envelopeOne.json()) as Record<string, unknown>;
    expect(bodyOne['supersession_refs']).toEqual({
      superseded_by_version_urn: 'urn:tg:skill-version:skill:canonical@v2',
    });

    // Revoking v2 adds revocation refs to its envelope.
    const revoke = await app.request('/v1/skills/skill:canonical/versions/2/revoke', {
      method: 'POST',
      headers,
      body: JSON.stringify({ author: 'pablo', note: 'trust failure' }),
    });
    expect(revoke.status).toBe(200);
    const envelopeRevoked = await app.request('/v1/skills/skill:canonical/versions/2/publication-envelope');
    const bodyRevoked = (await envelopeRevoked.json()) as Record<string, unknown>;
    expect(bodyRevoked['revocation_refs']).toMatchObject({
      revoked_by: 'pablo',
      revocation_reason: 'trust failure',
    });
    expect(typeof (bodyRevoked['revocation_refs'] as { revoked_at?: string }).revoked_at).toBe('string');
  });
});
