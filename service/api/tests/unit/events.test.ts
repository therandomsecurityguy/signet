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
    // Fast stream cadence so live-delivery assertions stay quick.
    EVENTS_STREAM_POLL_MS: '25',
  });
  const deps = buildAppDependencies(env);
  await deps.ready();
  const { token } = await deps.apiKeys.create({ owner_label: 'Events Writer' });
  return { app: buildApp(deps), token, deps };
}

function authHeaders(token: string) {
  return { 'content-type': 'application/json', Authorization: `Bearer ${token}` };
}

type TestApp = { request: (i: string, init?: RequestInit) => Promise<Response> | Response };

async function seedSkill(app: TestApp, token: string, skillKey: string, actions: string[]) {
  const create = await app.request('/v1/skills', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ skill_key: skillKey, artifact: { content: `# ${skillKey}` } }),
  });
  expect(create.status).toBe(201);
  const draft = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/drafts`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      author: 'seed',
      artifact: { content: `# ${skillKey} v1`, original_path: `skills/${skillKey.replaceAll(':', '-')}.md` },
    }),
  });
  expect(draft.status).toBe(200);
  for (const action of actions) {
    const res = await app.request(`/v1/skills/${encodeURIComponent(skillKey)}/versions/1/${action}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ author: 'seed' }),
    });
    if (res.status !== 200) throw new Error(`${action} on ${skillKey}: ${res.status} ${await res.text()}`);
  }
}

type EventRow = {
  position: number;
  event_type: string;
  occurred_at: string;
  actor: string;
  logical_urn: string;
  publication_urn: string;
  task_urn: string;
  event_sha256: string;
};

async function listEvents(app: TestApp, query = '') {
  const res = await app.request(`/v1/events${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { events: EventRow[]; latest_position: number | null };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for condition');
}

describe('governance event feed', () => {
  it('lists events newest-first with positions, digests, and filters', async () => {
    const { app, token } = await buildTestApp();
    await seedSkill(app, token, 'skill:evented', ['validate', 'publish', 'certify']);
    await seedSkill(app, token, 'skill:other', ['validate']);

    const all = await listEvents(app);
    expect(all.latest_position).toBe(all.events.length - 1);
    expect(all.events[0]?.event_type).toBe('validate');
    const evented = all.events.filter((event) => event.logical_urn === 'urn:sg:skill:skill:evented');
    expect(evented.map((event) => event.event_type)).toEqual(['certify', 'publish', 'validate', 'create_draft']);
    expect(evented.every((event) => /^[0-9a-f]{64}$/.test(event.event_sha256))).toBe(true);
    expect(evented[0]?.publication_urn).toBe('urn:sg:skill-version:skill:evented@v1');
    expect(evented[0]?.actor).toBe('seed');
    expect(evented[0]?.task_urn).toMatch(/^urn:sg:task:/);
    // Newest-first ordering across the whole log.
    const positions = all.events.map((event) => event.position);
    expect([...positions].sort((a, b) => b - a)).toEqual(positions);

    const byType = await listEvents(app, '?event_type=certify');
    expect(byType.events).toHaveLength(1);
    expect(byType.events[0]?.logical_urn).toBe('urn:sg:skill:skill:evented');

    const byKey = await listEvents(app, '?logical_key=skill%3Aevented');
    expect(byKey.events).toHaveLength(4);

    const byPublication = await listEvents(
      app,
      '?publication_urn=urn%3Asg%3Askill-version%3Askill%3Aevented%40v1',
    );
    expect(byPublication.events).toHaveLength(4);

    // Ascending catch-up with the position cursor.
    const catchUp = await listEvents(app, `?after_position=${evented[3]?.position ?? 0}`);
    expect(catchUp.events.length).toBeGreaterThanOrEqual(3);
    const ascending = catchUp.events.map((event) => event.position);
    expect([...ascending].sort((a, b) => a - b)).toEqual(ascending);
    expect(ascending.every((position) => position > (evented[3]?.position ?? 0))).toBe(true);
  });

  it('applies inclusive since bounds without scanning past the cutoff', async () => {
    const { app, token } = await buildTestApp();
    await seedSkill(app, token, 'skill:bound', ['validate', 'publish', 'certify']);

    const all = await listEvents(app, '?logical_key=skill%3Abound');
    const publishEvent = all.events.find((event) => event.event_type === 'publish');
    expect(publishEvent).toBeTruthy();
    const since = publishEvent?.occurred_at ?? '';
    const recent = await listEvents(app, `?logical_key=skill%3Abound&since=${encodeURIComponent(since)}`);
    expect(recent.events.map((event) => event.event_type)).toContain('certify');
    expect(recent.events.every((event) => event.occurred_at >= since)).toBe(true);
    expect(recent.events.some((event) => event.event_type === 'create_draft')).toBe(false);
  });

  it('streams catch-up and live events over SSE', async () => {
    const { app, token } = await buildTestApp();
    await seedSkill(app, token, 'skill:streamed', ['validate', 'publish']);

    const controller = new AbortController();
    const res = await app.request('/v1/events/stream?since_position=-1', { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    let text = '';
    const decoder = new TextDecoder();
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader!.read();
          if (done) break;
          text += decoder.decode(value);
        }
      } catch {
        // Aborted.
      }
    })();

    try {
      await waitFor(() => text.includes('"event_type":"validate"') && text.includes('"event_type":"publish"'));
      expect(text).toContain('id: ');
      expect(text).toContain('urn:sg:skill:skill:streamed');

      const certify = await app.request('/v1/skills/skill%3Astreamed/versions/1/certify', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ author: 'streamer' }),
      });
      expect(certify.status).toBe(200);
      await waitFor(() => text.includes('"event_type":"certify"'));
    } finally {
      controller.abort();
      await pump.catch(() => undefined);
    }
  });

  it('rejects invalid list and stream parameters', async () => {
    const { app } = await buildTestApp();
    const badLimit = await app.request('/v1/events?limit=999');
    expect(badLimit.status).toBe(400);
    const badCursor = await app.request('/v1/events/stream?since_position=abc');
    expect(badCursor.status).toBe(400);
  });
});
