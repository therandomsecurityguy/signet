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
  const { token } = await deps.apiKeys.create({ owner_label: 'Review Writer' });
  return { app: buildApp(deps), token };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

const REVIEW_POLICY = {
  require_human_review: true,
  shapes: [{ id: 'policy/reviewed', target: { entity_type: 'SKILL_VERSION' } }],
};

async function createDraft(
  app: { request: (i: string, init?: RequestInit) => Promise<Response> | Response },
  token: string,
  skillKey: string,
  policyVersion?: string,
) {
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'pablo',
      artifact: { content: `# ${skillKey}`, original_path: `skills/${skillKey.replace(':', '-')}.md` },
      ...(policyVersion ? { governance: { policy_version: policyVersion } } : {}),
    }),
  });
  expect(draft.status).toBe(200);
}

describe('human review workflow', () => {
  it('records review decisions as first-class evidence on validated versions', async () => {
    const { app, token } = await buildTestApp();
    await createDraft(app, token, 'skill:reviewable');
    expect(
      (
        await app.request('/v1/skills/skill:reviewable/versions/1/validate', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ author: 'pablo' }),
        })
      ).status,
    ).toBe(200);

    const review = await app.request('/v1/skills/skill:reviewable/versions/1/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ decision: 'approve', author: 'dana', review_role: 'domain-expert', note: 'claims are accurate' }),
    });
    expect(review.status).toBe(200);
    await expect(review.json()).resolves.toMatchObject({
      result: {
        skill_version: {
          properties: {
            review_status: 'approved',
            reviewed_by: 'dana',
            review_role: 'domain-expert',
            review_note: 'claims are accurate',
          },
        },
        governance_artifacts: expect.arrayContaining([expect.objectContaining({ role: 'review_evidence' })]),
      },
    });

    // Rejected review is recorded too.
    await createDraft(app, token, 'skill:review-reject');
    expect(
      (
        await app.request('/v1/skills/skill:review-reject/versions/1/validate', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ author: 'pablo' }),
        })
      ).status,
    ).toBe(200);
    const reject = await app.request('/v1/skills/skill:review-reject/versions/1/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ decision: 'reject', author: 'dana', note: 'overclaimed' }),
    });
    expect(reject.status).toBe(200);
    await expect(reject.json()).resolves.toMatchObject({
      result: { skill_version: { properties: { review_status: 'rejected' } } },
    });
  });

  it('rejects reviews on versions that are not validated or published', async () => {
    const { app, token } = await buildTestApp();
    await createDraft(app, token, 'skill:review-draft');
    const review = await app.request('/v1/skills/skill:review-draft/versions/1/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ decision: 'approve', author: 'dana' }),
    });
    expect(review.status).toBe(409);
    await expect(review.json()).resolves.toMatchObject({ error: { code: 'SKILL_VERSION_REVIEW_CONFLICT' } });
  });

  it('gates publish and certify on human review when the policy requires it', async () => {
    const { app, token } = await buildTestApp();
    expect(
      (
        await app.request('/v1/policy-packages', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ policy_version: 'reviewed-policy/v1', author: 'pablo', shapes: REVIEW_POLICY }),
        })
      ).status,
    ).toBe(201);

    await createDraft(app, token, 'skill:gated', 'reviewed-policy/v1');
    expect(
      (
        await app.request('/v1/skills/skill:gated/versions/1/validate', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ author: 'pablo' }),
        })
      ).status,
    ).toBe(200);

    // Publish is blocked until a human approves.
    const blockedPublish = await app.request('/v1/skills/skill:gated/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(blockedPublish.status).toBe(409);
    await expect(blockedPublish.json()).resolves.toMatchObject({
      error: { code: 'SKILL_VERSION_PUBLISH_CONFLICT', message: expect.stringContaining('Human review approval') },
    });

    // Approve, then publish succeeds.
    expect(
      (
        await app.request('/v1/skills/skill:gated/versions/1/review', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ decision: 'approve', author: 'dana', review_role: 'security-reviewer' }),
        })
      ).status,
    ).toBe(200);
    const publish = await app.request('/v1/skills/skill:gated/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(publish.status).toBe(200);

    // A rejected review blocks publish too.
    await createDraft(app, token, 'skill:gated-rejected', 'reviewed-policy/v1');
    expect(
      (
        await app.request('/v1/skills/skill:gated-rejected/versions/1/validate', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ author: 'pablo' }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request('/v1/skills/skill:gated-rejected/versions/1/review', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ decision: 'reject', author: 'dana' }),
        })
      ).status,
    ).toBe(200);
    const rejectedPublish = await app.request('/v1/skills/skill:gated-rejected/versions/1/publish', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'pablo' }),
    });
    expect(rejectedPublish.status).toBe(409);
  });

  it('supports agent version reviews and serves the pending review queue', async () => {
    const { app, token } = await buildTestApp();

    const createAgent = await app.request('/v1/agents', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        agent_key: 'agent:reviewable',
        source_path: 'agents/reviewable.md',
        artifact: { content: '# agent', original_path: 'agents/reviewable.md' },
      }),
    });
    expect(createAgent.status).toBe(201);

    // The published agent version appears in the pending queue.
    const pendingBefore = await app.request('/v1/reviews/pending');
    expect(pendingBefore.status).toBe(200);
    const beforeBody = (await pendingBefore.json()) as { pending: Array<{ publication_urn: string; entity_type: string }> };
    expect(beforeBody.pending.some((p) => p.publication_urn === 'urn:tg:agent-version:agent:reviewable@v1')).toBe(true);

    // Review the agent version (published state is reviewable).
    const review = await app.request('/v1/agents/agent:reviewable/versions/1/review', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ decision: 'approve', author: 'dana', review_role: 'ops-reviewer' }),
    });
    expect(review.status).toBe(200);
    await expect(review.json()).resolves.toMatchObject({
      result: {
        agent_version: { properties: { review_status: 'approved', reviewed_by: 'dana' } },
        governance_artifacts: expect.arrayContaining([expect.objectContaining({ role: 'review_evidence' })]),
      },
    });

    // Approved versions leave the queue.
    const pendingAfter = await app.request('/v1/reviews/pending');
    const afterBody = (await pendingAfter.json()) as { pending: Array<{ publication_urn: string }> };
    expect(afterBody.pending.some((p) => p.publication_urn === 'urn:tg:agent-version:agent:reviewable@v1')).toBe(false);
  });
});
