import { describe, expect, it } from 'vitest';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { computeMerkleRoot, rfc6962LeafHash } from '../../../registry/application/services/merkle-log.js';

async function buildTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Governance Log Writer' });
  return { app: buildApp(deps), deps, token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type LogState = {
  log_id: string;
  tree_size: number;
  root_hash: string | null;
  leaves: Array<{ leaf_index: number; leaf_hash: string; event_artifact_urn?: string }>;
};

describe('internal governance event log', () => {
  it('appends canonical events for all lifecycle operations and serves proofs and replay', async () => {
    const { app, deps, token } = await buildTestApp();

    // Drive a skill through the full lifecycle: 6 completed operations.
    const draft = await app.request('/v1/skills/skill:logged/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# logged', original_path: 'skills/logged.md' },
      }),
    });
    expect(draft.status).toBe(200);
    for (const action of ['validate', 'publish', 'certify', 'revoke', 'archive']) {
      const res = await app.request(`/v1/skills/skill:logged/versions/1/${action}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ author: 'pablo' }),
      });
      expect(res.status, action).toBe(200);
    }

    // Log state: six leaves, one per completed operation.
    const state = await app.request('/v1/governance-log');
    expect(state.status).toBe(200);
    const stateBody = (await state.json()) as LogState;
    expect(stateBody.log_id).toBe('registry-governance');
    expect(stateBody.tree_size).toBe(6);
    expect(stateBody.root_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stateBody.leaves).toHaveLength(6);
    expect(stateBody.root_hash).toBe(computeMerkleRoot(stateBody.leaves.map((l) => l.leaf_hash)));

    // Every leaf links an immutable event artifact whose canonical content
    // hashes to the leaf hash.
    const eventTypes: string[] = [];
    for (const leaf of stateBody.leaves) {
      expect(leaf.event_artifact_urn).toBeDefined();
      const sha256 = (leaf.event_artifact_urn as string).replace('urn:tg:artifact:sha256:', '');
      const stored = await deps.registryCas.getBySha256(sha256);
      expect(stored).toBeDefined();
      const content = new TextDecoder().decode(stored?.bytes);
      expect(rfc6962LeafHash(content).toString('hex')).toBe(leaf.leaf_hash);
      const event = JSON.parse(content) as { event_type: string; actor: string; publication_urn: string };
      eventTypes.push(event.event_type);
      expect(event.actor).toBe('pablo');
      expect(event.publication_urn).toBe('urn:tg:skill-version:skill:logged@v1');
    }
    expect(eventTypes).toEqual(['create_draft', 'validate', 'publish', 'certify', 'revoke', 'archive']);

    // Inclusion proofs are served for every leaf and fold to the root.
    for (let i = 0; i < stateBody.tree_size; i++) {
      const proof = await app.request(`/v1/governance-log/proofs/${i}`);
      expect(proof.status).toBe(200);
      const proofBody = (await proof.json()) as {
        leaf_index: number;
        tree_size: number;
        leaf_hash: string;
        proof_hashes: string[];
        root_hash: string;
        event_artifact_urn?: string;
      };
      expect(proofBody.leaf_index).toBe(i);
      expect(proofBody.tree_size).toBe(6);
      expect(proofBody.leaf_hash).toBe(`hex:${stateBody.leaves[i]?.leaf_hash}`);
      expect(proofBody.root_hash).toBe(`hex:${stateBody.root_hash}`);
      expect(proofBody.event_artifact_urn).toBe(stateBody.leaves[i]?.event_artifact_urn);
    }

    // Out-of-range proof requests 404.
    const missing = await app.request('/v1/governance-log/proofs/99');
    expect(missing.status).toBe(404);

    // Replay recomputes the root from the event stream and matches.
    const replay = await app.request('/v1/governance-log/replay');
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      log_id: 'registry-governance',
      tree_size: 6,
      consistent: true,
      recorded_root_hash: stateBody.root_hash,
      recomputed_root_hash: stateBody.root_hash,
    });
  });

  it('does not append events for noop (idempotent) operations', async () => {
    const { app, token } = await buildTestApp();
    const draft = await app.request('/v1/skills/skill:noop-log/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# noop', original_path: 'skills/noop-log.md' },
      }),
    });
    expect(draft.status).toBe(200);
    // Identical draft re-create is a noop and must not append a second event.
    const redraft = await app.request('/v1/skills/skill:noop-log/drafts', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        author: 'pablo',
        artifact: { content: '# noop', original_path: 'skills/noop-log.md' },
      }),
    });
    expect(redraft.status).toBe(200);

    const state = await app.request('/v1/governance-log');
    const stateBody = (await state.json()) as LogState;
    expect(stateBody.tree_size).toBe(1);
  });

  it('returns an empty log state before any governance events', async () => {
    const { app } = await buildTestApp();
    const state = await app.request('/v1/governance-log');
    expect(state.status).toBe(200);
    await expect(state.json()).resolves.toMatchObject({
      log_id: 'registry-governance',
      tree_size: 0,
      root_hash: null,
      leaves: [],
    });
    const replay = await app.request('/v1/governance-log/replay');
    await expect(replay.json()).resolves.toMatchObject({ tree_size: 0, consistent: true });
  });
});
