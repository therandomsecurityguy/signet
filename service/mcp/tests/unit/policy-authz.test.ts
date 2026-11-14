import { describe, expect, it } from 'vitest';

import { DefaultPolicyService } from '../../src/infrastructure/policy/default-policy-service.js';
import { loadEnv } from '../../src/infrastructure/config/env.js';
import { ToolName } from '../../src/domain/tools/tool-names.js';
import type { ApiKeyPrincipal, OktaUserPrincipal } from '../../src/domain/principal/principal.js';

describe('policy authz (phase 9)', () => {
  it('denies access to a data source not allowed by entitlement rule', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      AUTHZ_RULES_JSON: JSON.stringify({
        rules: [
          {
            id: 'rule-1',
            when: { any_group: ['analytics'] },
            allow: {
              tools: [ToolName.DataQuery],
              data_sources: {
                snowflake: { databases: ['*'], schemas: ['*'], tables: ['*'] },
              },
            },
          },
        ],
      }),
    });
    const policy = new DefaultPolicyService(env);

    const principal: OktaUserPrincipal = {
      type: 'okta_user',
      id: 'u1',
      scopes: [],
      groups: ['analytics'],
      claims: {},
      authMethod: 'okta_access_token',
    };

    const decision = await policy.evaluate({
      tool_name: ToolName.DataQuery,
      principal,
      parsed_input: { data_source: 'athena', sql: 'select 1' },
    });

    expect(decision.effect).toBe('deny');
    expect(decision.reason).toBe('source_not_allowed');
  });

  it('allows select 1 when data source is allowed', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      AUTHZ_RULES_JSON: JSON.stringify({
        rules: [
          {
            id: 'rule-1',
            when: { any_group: ['analytics'] },
            allow: {
              tools: [ToolName.DataQuery],
              data_sources: {
                snowflake: { databases: ['*'], schemas: ['*'], tables: ['*'] },
              },
            },
          },
        ],
      }),
    });
    const policy = new DefaultPolicyService(env);

    const principal: OktaUserPrincipal = {
      type: 'okta_user',
      id: 'u1',
      scopes: [],
      groups: ['analytics'],
      claims: {},
      authMethod: 'okta_access_token',
    };

    const decision = await policy.evaluate({
      tool_name: ToolName.DataQuery,
      principal,
      parsed_input: { data_source: 'snowflake', sql: 'select 1' },
    });

    expect(decision.effect).toBe('allow');
  });

  it('allows a registry tool when explicitly granted by entitlement rule', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      AUTHZ_RULES_JSON: JSON.stringify({
        rules: [
          {
            id: 'rule-1',
            when: { any_group: ['catalog'] },
            allow: {
              tools: [ToolName.RegistryGetAgent],
              data_sources: {},
            },
          },
        ],
      }),
    });
    const policy = new DefaultPolicyService(env);

    const principal: OktaUserPrincipal = {
      type: 'okta_user',
      id: 'u1',
      scopes: [],
      groups: ['catalog'],
      claims: {},
      authMethod: 'okta_access_token',
    };

    const decision = await policy.evaluate({
      tool_name: ToolName.RegistryGetAgent,
      principal,
      parsed_input: { agent_urn: 'urn:sg:agent:cursor:blackbox' },
    });

    expect(decision.effect).toBe('allow');
  });

  it('denies a registry tool when not explicitly granted by entitlement rule', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      AUTHZ_RULES_JSON: JSON.stringify({
        rules: [
          {
            id: 'rule-1',
            when: { any_group: ['catalog'] },
            allow: {
              tools: [ToolName.RegistryListAgents],
              data_sources: {},
            },
          },
        ],
      }),
    });
    const policy = new DefaultPolicyService(env);

    const principal: OktaUserPrincipal = {
      type: 'okta_user',
      id: 'u1',
      scopes: [],
      groups: ['catalog'],
      claims: {},
      authMethod: 'okta_access_token',
    };

    const decision = await policy.evaluate({
      tool_name: ToolName.RegistryGetAgent,
      principal,
      parsed_input: { agent_urn: 'urn:sg:agent:cursor:blackbox' },
    });

    expect(decision.effect).toBe('deny');
    expect(decision.reason).toBe('tool_not_allowed');
  });

  it('applies entitlement rules to api-key principals (fail closed without a matching rule)', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      AUTHZ_RULES_JSON: JSON.stringify({
        rules: [
          {
            id: 'rule-1',
            when: { any_group: ['analytics'] },
            allow: {
              tools: [ToolName.DataQuery],
              data_sources: {
                snowflake: { databases: ['*'], schemas: ['*'], tables: ['*'] },
              },
            },
          },
        ],
      }),
    });
    const policy = new DefaultPolicyService(env);

    const principal: ApiKeyPrincipal = {
      type: 'api_key',
      id: 'agk-1',
      scopes: ['read'],
      groups: [],
      claims: {},
      authMethod: 'api_key',
    };

    const decision = await policy.evaluate({
      tool_name: ToolName.DataQuery,
      principal,
      parsed_input: { data_source: 'snowflake', sql: 'select 1' },
    });

    expect(decision.effect).toBe('deny');
    expect(decision.reason).toBe('no_matching_entitlement');
  });

  it('fails closed when a FROM statement cannot be parsed into object refs', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      AUTHZ_RULES_JSON: JSON.stringify({
        rules: [
          {
            id: 'rule-1',
            when: { any_group: ['analytics'] },
            allow: {
              tools: [ToolName.DataQuery],
              data_sources: {
                snowflake: { databases: ['*'], schemas: ['*'], tables: ['allowed'] },
              },
            },
          },
        ],
      }),
    });
    const policy = new DefaultPolicyService(env);

    const principal: OktaUserPrincipal = {
      type: 'okta_user',
      id: 'u1',
      scopes: [],
      groups: ['analytics'],
      claims: {},
      authMethod: 'okta_access_token',
    };

    const decision = await policy.evaluate({
      tool_name: ToolName.DataQuery,
      principal,
      parsed_input: { data_source: 'snowflake', sql: 'select * from (select 1) sub' },
    });

    expect(decision.effect).toBe('deny');
    expect(decision.reason).toBe('unparseable_object_refs');
  });

  it('checks backticked table references against the allowlist', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      AUTHZ_RULES_JSON: JSON.stringify({
        rules: [
          {
            id: 'rule-1',
            when: { any_group: ['analytics'] },
            allow: {
              tools: [ToolName.DataQuery],
              data_sources: {
                snowflake: { databases: ['*'], schemas: ['*'], tables: ['users'] },
              },
            },
          },
        ],
      }),
    });
    const policy = new DefaultPolicyService(env);

    const principal: OktaUserPrincipal = {
      type: 'okta_user',
      id: 'u1',
      scopes: [],
      groups: ['analytics'],
      claims: {},
      authMethod: 'okta_access_token',
    };

    const allowed = await policy.evaluate({
      tool_name: ToolName.DataQuery,
      principal,
      parsed_input: { data_source: 'snowflake', sql: 'select * from `users`' },
    });
    expect(allowed.effect).toBe('allow');

    const denied = await policy.evaluate({
      tool_name: ToolName.DataQuery,
      principal,
      parsed_input: { data_source: 'snowflake', sql: 'select * from `secret_table`' },
    });
    expect(denied.effect).toBe('deny');
    expect(denied.reason).toBe('table_not_allowed');
  });
});

