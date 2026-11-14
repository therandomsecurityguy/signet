import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildAppDependencies } from '../../src/app/dependencies.js';
import { buildApp } from '../../src/app/server.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function buildTestApp() {
  const objectsDir = await mkdtemp(path.join(os.tmpdir(), 'cachet-envelope-freeze-'));
  tempDirs.push(objectsDir);
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: ':memory:',
    REGISTRY_GRAPH_BACKEND: 'memory',
    REGISTRY_OBJECTS_DIR: objectsDir,
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Envelope Writer' });
  return { app: buildApp(deps), token, deps, objectsDir };
}

function sha256Hex(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

type EnvelopeBody = {
  canonical_json: string;
  canonical_json_sha256: string;
  publication_envelope_artifact_urn?: string;
  publication_envelope_sha256?: string;
  governance_artifacts: Array<{ role: string; artifact_urn: string }>;
};

type VerificationBody = {
  publication_envelope_artifact_present: boolean;
  publication_envelope_artifact_sha256_matches: boolean | null;
  live_envelope_matches_frozen_artifact: boolean | null;
};

describe('frozen publication envelope', () => {
  it('freezes published bytes, keeps them stable across later evidence, and reports drift', async () => {
    const { app, token } = await buildTestApp();
    const skillKey = 'skill:freeze-demo';
    const auth = { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
    const versionPath = `/v1/skills/${encodeURIComponent(skillKey)}/versions/1`;

    const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        author: 'pablo',
        display_name: 'Freeze demo',
        description: 'Skill used to verify frozen publication envelopes',
        artifact: { content: '# Freeze demo\n', original_path: 'skills/freeze-demo.md' },
      }),
    });
    expect(draft.status).toBe(200);

    const publish = await app.request(`${versionPath}/publish`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(publish.status).toBe(200);

    const envelopeResponse = await app.request(`${versionPath}/publication-envelope`);
    expect(envelopeResponse.status).toBe(200);
    const envelope = (await envelopeResponse.json()) as EnvelopeBody;
    expect(envelope.publication_envelope_artifact_urn).toMatch(/^urn:tg:artifact:sha256:/);
    expect(envelope.publication_envelope_sha256).toBe(sha256Hex(envelope.canonical_json));

    const verificationResponse = await app.request(`${versionPath}/verification`);
    expect(verificationResponse.status).toBe(200);
    const verification = (await verificationResponse.json()) as VerificationBody;
    expect(verification.publication_envelope_artifact_present).toBe(true);
    expect(verification.publication_envelope_artifact_sha256_matches).toBe(true);
    expect(verification.live_envelope_matches_frozen_artifact).toBe(true);

    // Attach review evidence after publish. The published payload must stay
    // frozen while the live derivation grows.
    const review = await app.request(`${versionPath}/review`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        decision: 'approve',
        author: 'reviewer',
        review_role: 'security',
        note: 'evidence attached after publish',
      }),
    });
    expect(review.status).toBe(200);

    const afterResponse = await app.request(`${versionPath}/publication-envelope`);
    expect(afterResponse.status).toBe(200);
    const afterEnvelope = (await afterResponse.json()) as EnvelopeBody;
    expect(afterEnvelope.canonical_json).toBe(envelope.canonical_json);
    expect(afterEnvelope.canonical_json_sha256).toBe(envelope.canonical_json_sha256);
    expect(afterEnvelope.governance_artifacts.length).toBeGreaterThan(
      envelope.governance_artifacts.length,
    );

    const afterVerificationResponse = await app.request(`${versionPath}/verification`);
    expect(afterVerificationResponse.status).toBe(200);
    const afterVerification = (await afterVerificationResponse.json()) as VerificationBody;
    expect(afterVerification.publication_envelope_artifact_present).toBe(true);
    expect(afterVerification.publication_envelope_artifact_sha256_matches).toBe(true);
    expect(afterVerification.live_envelope_matches_frozen_artifact).toBe(false);
  });

  it('stores the frozen envelope as a readable, digest-verified CAS artifact', async () => {
    const { app, token, deps } = await buildTestApp();
    const skillKey = 'skill:frozen-artifact';
    const auth = { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
    const versionPath = `/v1/skills/${encodeURIComponent(skillKey)}/versions/1`;

    const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        author: 'pablo',
        display_name: 'Frozen artifact demo',
        description: 'Skill used to verify the frozen envelope artifact',
        artifact: { content: '# Frozen artifact demo\n', original_path: 'skills/frozen-artifact.md' },
      }),
    });
    expect(draft.status).toBe(200);
    const publish = await app.request(`${versionPath}/publish`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(publish.status).toBe(200);

    const envelope = (await (
      await app.request(`${versionPath}/publication-envelope`)
    ).json()) as EnvelopeBody;
    const artifactSha256 = envelope.publication_envelope_sha256;
    expect(artifactSha256).toBeTruthy();

    const artifact = await deps.registryCore.getArtifact({ sha256: artifactSha256 as string });
    expect(artifact).not.toBeNull();
    expect(artifact?.digest_verified).toBe(true);
    expect(artifact?.content).toBe(envelope.canonical_json);
  });

  it('reports a tampered frozen envelope artifact instead of serving it', async () => {
    const { app, token, objectsDir } = await buildTestApp();
    const skillKey = 'skill:frozen-tamper';
    const auth = { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
    const versionPath = `/v1/skills/${encodeURIComponent(skillKey)}/versions/1`;

    const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        author: 'pablo',
        display_name: 'Frozen tamper demo',
        description: 'Skill used to verify frozen envelope tamper handling',
        artifact: { content: '# Frozen tamper demo\n', original_path: 'skills/frozen-tamper.md' },
      }),
    });
    expect(draft.status).toBe(200);
    const publish = await app.request(`${versionPath}/publish`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(publish.status).toBe(200);

    const envelope = (await (
      await app.request(`${versionPath}/publication-envelope`)
    ).json()) as EnvelopeBody;
    const artifactSha256 = envelope.publication_envelope_sha256 as string;
    expect(artifactSha256).toBeTruthy();

    const objectPath = path.join(objectsDir, artifactSha256.slice(0, 2), artifactSha256);
    await writeFile(objectPath, '{"tampered":true}');

    const verification = (await (
      await app.request(`${versionPath}/verification`)
    ).json()) as VerificationBody;
    expect(verification.publication_envelope_artifact_present).toBe(true);
    expect(verification.publication_envelope_artifact_sha256_matches).toBe(false);
  });
});
