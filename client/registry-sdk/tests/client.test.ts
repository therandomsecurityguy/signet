import { describe, expect, it } from 'vitest';

import { RegistryClient } from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(routes: Record<string, { body: unknown; status?: number }>) {
  return async (input: Request | string) => {
    const url = typeof input === 'string' ? input : input.url;
    const route = routes[url];
    if (!route) {
      return jsonResponse({ error: { code: 'NOT_FOUND', message: 'no mock route' } }, 404);
    }
    return jsonResponse(route.body, route.status ?? 200);
  };
}

describe('RegistryClient', () => {
  it('sends the bearer token and parses a list-skills response', async () => {
    let seenAuth: string | null = null;
    const fetchFn = async (input: Request | string) => {
      const req = input as Request;
      seenAuth = req.headers.get('authorization');
      return jsonResponse({ skills: [{ skill_urn: 'urn:sg:skill:demo', skill_key: 'skill:demo' }] });
    };

    const client = new RegistryClient({ baseUrl: 'http://registry.test', apiToken: 'tok-123', fetch: fetchFn });
    const result = await client.listSkills();
    expect(seenAuth).toBe('Bearer tok-123');
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].skill_key).toBe('skill:demo');
  });

  it('sends configured extra headers (Cloudflare Access service token)', async () => {
    let seen: Headers | undefined;
    const fetchFn = async (input: Request | string) => {
      const req = input as Request;
      seen = req.headers;
      return jsonResponse({ skills: [] });
    };

    const client = new RegistryClient({
      baseUrl: 'https://signet-api.example.com',
      apiToken: 'agk_x',
      headers: {
        'CF-Access-Client-Id': 'cf-id',
        'CF-Access-Client-Secret': 'cf-secret',
      },
      fetch: fetchFn,
    });
    await client.listSkills();
    expect(seen?.get('cf-access-client-id')).toBe('cf-id');
    expect(seen?.get('cf-access-client-secret')).toBe('cf-secret');
    expect(seen?.get('authorization')).toBe('Bearer agk_x');
  });

  it('interpolates path params for getSkill', async () => {
    const fetchFn = mockFetch({
      'http://registry.test/v1/skills/skill%3Ademo': {
        body: { skill: { urn: 'urn:sg:skill:demo', properties: {} } },
      },
    });
    const client = new RegistryClient({ baseUrl: 'http://registry.test', fetch: fetchFn });
    const result = await client.getSkill('skill:demo');
    expect(result.skill.urn).toBe('urn:sg:skill:demo');
  });

  it('throws RegistryClientError on an error response', async () => {
    const fetchFn = mockFetch({
      'http://registry.test/v1/skills/skill%3Amissing': {
        body: { error: { code: 'SKILL_NOT_FOUND', message: 'Skill not found.' } },
        status: 404,
      },
    });
    const client = new RegistryClient({ baseUrl: 'http://registry.test', fetch: fetchFn });
    await expect(client.getSkill('skill:missing')).rejects.toMatchObject({
      name: 'RegistryClientError',
      status: 404,
      code: 'SKILL_NOT_FOUND',
    });
  });

  it('exposes typed read methods for agents and transparency', async () => {
    const fetchFn = mockFetch({
      'http://registry.test/v1/agents': { body: { agents: [] } },
      'http://registry.test/v1/transparency-logs': { body: { logs: [] } },
      'http://registry.test/v1/public-keys': { body: { keys: [] } },
    });
    const client = new RegistryClient({ baseUrl: 'http://registry.test', fetch: fetchFn });
    await expect(client.listAgents()).resolves.toEqual({ agents: [] });
    await expect(client.listTransparencyLogs()).resolves.toEqual({ logs: [] });
    await expect(client.listPublicKeys()).resolves.toEqual({ keys: [] });
  });

  it('exposes typed gate-hints methods for skills and agents', async () => {
    const hints = {
      publication_urn: 'urn:sg:skill-version:skill:demo@v1',
      policy_version: 'policy/demo/v1',
      gates: [
        {
          gate: 'require_human_review',
          operation: 'publish',
          applicable: true,
          satisfied: false,
          reason: 'review_status is unset',
        },
      ],
      would_publish: false,
      would_certify: true,
    };
    const fetchFn = mockFetch({
      'http://registry.test/v1/skills/skill%3Ademo/versions/1/gate-hints': { body: hints },
      'http://registry.test/v1/agents/agent%3Ademo/versions/2/gate-hints': {
        body: { ...hints, publication_urn: 'urn:sg:agent-version:agent:demo@v2' },
      },
    });
    const client = new RegistryClient({ baseUrl: 'http://registry.test', fetch: fetchFn });
    const skillHints = await client.getSkillGateHints('skill:demo', 1);
    expect(skillHints.would_publish).toBe(false);
    expect(skillHints.gates[0]?.gate).toBe('require_human_review');
    const agentHints = await client.getAgentGateHints('agent:demo', 2);
    expect(agentHints.publication_urn).toBe('urn:sg:agent-version:agent:demo@v2');
  });
});
