// Write scopes for registry mutations. API keys carry a subset of these;
// keys created without an explicit list receive the full set, and legacy
// keys stored with an empty list are grandfathered (treated as full access)
// until a deliberate backfill happens.

export const REGISTRY_WRITE_SCOPES = [
  'skills:write',
  'agents:write',
  'advisories:write',
  'attestations:write',
  'public-keys:write',
  'transparency-logs:write',
  'time-aware:write',
  'ontologies:write',
  'policies:write',
] as const;

export type RegistryWriteScope = (typeof REGISTRY_WRITE_SCOPES)[number];

const PATH_SCOPE_PREFIXES: ReadonlyArray<[prefix: string, scope: RegistryWriteScope]> = [
  ['/v1/skills', 'skills:write'],
  ['/v1/agents', 'agents:write'],
  ['/v1/advisories', 'advisories:write'],
  ['/v1/attestations', 'attestations:write'],
  ['/v1/public-keys', 'public-keys:write'],
  ['/v1/transparency-logs', 'transparency-logs:write'],
  ['/v1/time-aware', 'time-aware:write'],
  // Ontology packages and the de-facto vocabulary store are governance
  // surfaces (packages gate certification via ontology_version binding), so
  // they get their own scope instead of riding an unscoped path.
  ['/v1/ontology-packages', 'ontologies:write'],
  ['/v1/de-facto-terms', 'ontologies:write'],
  // Policy packages gate draft validation and certification, so they are a
  // governance surface with their own scope.
  ['/v1/policy-packages', 'policies:write'],
  // Semantic compilation feeds skill drafts; it is a skill-surface write.
  ['/v1/compile', 'skills:write'],
];

export function requiredWriteScopeForPath(path: string): RegistryWriteScope | null {
  for (const [prefix, scope] of PATH_SCOPE_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return scope;
  }
  return null;
}

// Legacy coarse scopes that historically granted writer access wholesale.
const LEGACY_FULL_ACCESS_SCOPES = new Set(['write', 'lifecycle']);

export function keyHasWriteScope(input: { scopes: string[]; required: RegistryWriteScope }): boolean {
  // Grandfathered legacy keys: empty scope lists and the pre-taxonomy
  // coarse scopes (`write`/`lifecycle`) keep full write access.
  if (input.scopes.length === 0) return true;
  if (input.scopes.some((scope) => LEGACY_FULL_ACCESS_SCOPES.has(scope))) return true;
  return input.scopes.includes(input.required);
}
