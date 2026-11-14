import { z } from 'zod';

const WildcardList = z.array(z.string().min(1));
const DataSourceRuleSchema = z.object({
  databases: WildcardList.default(['*']),
  schemas: WildcardList.default(['*']),
  tables: WildcardList.default(['*']),
});

const DataSourcesSchema = z
  .object({
    snowflake: DataSourceRuleSchema.optional(),
    athena: DataSourceRuleSchema.optional(),
    motherduck: DataSourceRuleSchema.optional(),
  })
  .default({});

export const AuthzRulesSchema = z.object({
  rules: z.array(
    z.object({
      id: z.string().min(1),
      when: z.object({
        any_group: z.array(z.string().min(1)).default([]),
      }),
      allow: z.object({
        tools: z.array(z.string().min(1)).default([]),
        data_sources: DataSourcesSchema,
      }),
    }),
  ),
});

export type AuthzRules = z.infer<typeof AuthzRulesSchema>;

export function parseAuthzRules(json: string | undefined): AuthzRules | null {
  if (!json) return null;
  const parsed = JSON.parse(json) as unknown;
  return AuthzRulesSchema.parse(parsed);
}

export function matchAuthzRule(input: {
  rules: AuthzRules;
  groups: string[];
}): AuthzRules['rules'][number] | null {
  for (const rule of input.rules.rules) {
    if (rule.when.any_group.length === 0) continue;
    if (rule.when.any_group.some((g) => input.groups.includes(g))) return rule;
  }
  return null;
}

export function matchesPattern(allowed: string[], value: string | undefined): boolean {
  if (allowed.includes('*')) return true;
  if (!value) return false;
  return allowed.includes(value);
}

