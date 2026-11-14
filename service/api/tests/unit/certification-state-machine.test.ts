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
  const { token } = await deps.apiKeys.create({ owner_label: 'State Machine Writer' });
  return { app: buildApp(deps), token };
}

type TestAppLike = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

async function createDraft(
  app: TestAppLike,
  token: string,
  skillKey: string,
  input: { content: string; originalPath?: string },
) {
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'pablo',
      artifact: {
        content: input.content,
        ...(input.originalPath ? { original_path: input.originalPath } : {}),
      },
    }),
  });
  expect(draft.status).toBe(200);
}

async function versionAction(
  app: TestAppLike,
  token: string,
  skillKey: string,
  version: number,
  action: string,
  body: Record<string, unknown> = { author: 'pablo' },
) {
  return await app.request(
    `/v1/skills/${encodeURIComponent(skillKey)}/versions/${version}/${action}`,
    { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) },
  );
}

async function getVersion(app: TestAppLike, skillKey: string, version: number) {
  const got = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/${version}`);
  expect(got.status).toBe(200);
  return (await got.json()) as {
    skill_version: { urn: string; properties: Record<string, unknown> };
  };
}

describe('certification state machine', () => {
  it('certifies with policy and ontology binding and exposes certified as a lifecycle state', async () => {
    const { app, token } = await buildTestApp();
    // Certification ontology binding requires a registered ontology package.
    const ontologyPackage = await app.request('/v1/ontology-packages', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        ontology_version: 'skill-ontology/v7',
        author: 'pablo',
        ontology: { kind: 'skill_area', concepts: [{ id: 'data-processing' }], disjoint: [] },
      }),
    });
    expect(ontologyPackage.status).toBe(201);
    await createDraft(app, token, 'skill:cert-binding', { content: '# v1', originalPath: 'skills/cert-binding.md' });
    expect((await versionAction(app, token, 'skill:cert-binding', 1, 'publish')).status).toBe(200);

    const certify = await versionAction(app, token, 'skill:cert-binding', 1, 'certify', {
      author: 'pablo',
      note: 'compliance approved',
      governance: {
        policy_version: 'registry-policy/v2',
        ontology_version: 'skill-ontology/v7',
        certification_expires_at: '2027-01-01T00:00:00Z',
        approver: 'dana',
        approver_role: 'security-reviewer',
      },
    });
    expect(certify.status).toBe(200);
    await expect(certify.json()).resolves.toMatchObject({
      result: {
        skill_version: {
          properties: {
            lifecycle_status: 'certified',
            certified: true,
            certification_policy_version: 'registry-policy/v2',
            certification_ontology_version: 'skill-ontology/v7',
            certification_expires_at: '2027-01-01T00:00:00Z',
          },
        },
        governance_artifacts: expect.arrayContaining([
          expect.objectContaining({ role: 'certification_evidence' }),
        ]),
      },
    });

    // Idempotent re-certify is a noop.
    const recertify = await versionAction(app, token, 'skill:cert-binding', 1, 'certify');
    expect(recertify.status).toBe(200);
    await expect(recertify.json()).resolves.toMatchObject({ task: { task: { properties: { status: 'noop' } } } });
  });

  it('promotes a certified version and supersedes it with a newer trusted snapshot', async () => {
    const { app, token } = await buildTestApp();
    await createDraft(app, token, 'skill:cert-promote', { content: '# v1', originalPath: 'skills/cert-promote.md' });
    expect((await versionAction(app, token, 'skill:cert-promote', 1, 'publish')).status).toBe(200);
    expect((await versionAction(app, token, 'skill:cert-promote', 1, 'certify')).status).toBe(200);

    // Promoting the already-active certified version is a noop.
    const noopPromote = await versionAction(app, token, 'skill:cert-promote', 1, 'promote');
    expect(noopPromote.status).toBe(200);
    await expect(noopPromote.json()).resolves.toMatchObject({ task: { task: { properties: { status: 'noop' } } } });

    await createDraft(app, token, 'skill:cert-promote', { content: '# v2', originalPath: 'skills/cert-promote.md' });
    expect((await versionAction(app, token, 'skill:cert-promote', 2, 'publish')).status).toBe(200);
    expect((await versionAction(app, token, 'skill:cert-promote', 2, 'promote')).status).toBe(200);

    const v1 = await getVersion(app, 'skill:cert-promote', 1);
    expect(v1.skill_version.properties['lifecycle_status']).toBe('certified');
    expect(v1.skill_version.properties['publication_status']).toBe('superseded');
    expect(v1.skill_version.properties['superseded_by_version_urn']).toBe(
      'urn:tg:skill-version:skill:cert-promote@v2',
    );
    expect(v1.skill_version.properties['active']).toBe(false);

    // The superseded certified version can be archived for retention.
    const archive = await versionAction(app, token, 'skill:cert-promote', 1, 'archive');
    expect(archive.status).toBe(200);
    const archived = await getVersion(app, 'skill:cert-promote', 1);
    expect(archived.skill_version.properties['lifecycle_status']).toBe('archived');
    expect(typeof archived.skill_version.properties['archived_at']).toBe('string');
  });

  it('revokes a certified version and archives it from revoked', async () => {
    const { app, token } = await buildTestApp();
    await createDraft(app, token, 'skill:cert-revoke', { content: '# v1', originalPath: 'skills/cert-revoke.md' });
    expect((await versionAction(app, token, 'skill:cert-revoke', 1, 'publish')).status).toBe(200);
    expect((await versionAction(app, token, 'skill:cert-revoke', 1, 'certify')).status).toBe(200);

    const revoke = await versionAction(app, token, 'skill:cert-revoke', 1, 'revoke', {
      author: 'pablo',
      note: 'trust failure',
    });
    expect(revoke.status).toBe(200);
    const revoked = await getVersion(app, 'skill:cert-revoke', 1);
    expect(revoked.skill_version.properties['lifecycle_status']).toBe('revoked');

    const archive = await versionAction(app, token, 'skill:cert-revoke', 1, 'archive');
    expect(archive.status).toBe(200);
    const archived = await getVersion(app, 'skill:cert-revoke', 1);
    expect(archived.skill_version.properties['lifecycle_status']).toBe('archived');

    // Archive is idempotent.
    const rearchive = await versionAction(app, token, 'skill:cert-revoke', 1, 'archive');
    expect(rearchive.status).toBe(200);
    await expect(rearchive.json()).resolves.toMatchObject({ task: { task: { properties: { status: 'noop' } } } });
  });

  it('rejects archive from non-terminal states', async () => {
    const { app, token } = await buildTestApp();
    await createDraft(app, token, 'skill:archive-conflict', { content: '# v1', originalPath: 'skills/archive-conflict.md' });
    expect((await versionAction(app, token, 'skill:archive-conflict', 1, 'publish')).status).toBe(200);

    const archiveActive = await versionAction(app, token, 'skill:archive-conflict', 1, 'archive');
    expect(archiveActive.status).toBe(409);
    await expect(archiveActive.json()).resolves.toMatchObject({ error: { code: 'SKILL_VERSION_ARCHIVE_CONFLICT' } });
  });

  it('rejects drafts missing deterministic evidence and blocks publish from rejected', async () => {
    const { app, token } = await buildTestApp();
    // No original_path and no source_path: deterministic evidence is incomplete.
    await createDraft(app, token, 'skill:rejectable', { content: '# no source path' });

    const validate = await versionAction(app, token, 'skill:rejectable', 1, 'validate');
    expect(validate.status).toBe(200);
    await expect(validate.json()).resolves.toMatchObject({
      result: {
        skill_version: {
          properties: {
            lifecycle_status: 'rejected',
            validation_status: 'failed',
            validation_failures: ['missing_source_path_evidence'],
          },
        },
      },
    });

    // Re-validating the still-broken version is a rejected noop.
    const revalidate = await versionAction(app, token, 'skill:rejectable', 1, 'validate');
    expect(revalidate.status).toBe(200);
    await expect(revalidate.json()).resolves.toMatchObject({
      task: { task: { properties: { status: 'noop' } } },
      result: { skill_version: { properties: { lifecycle_status: 'rejected' } } },
    });

    // Publish is blocked from rejected.
    const publish = await versionAction(app, token, 'skill:rejectable', 1, 'publish');
    expect(publish.status).toBe(409);
    await expect(publish.json()).resolves.toMatchObject({ error: { code: 'SKILL_VERSION_PUBLISH_CONFLICT' } });
  });
});
