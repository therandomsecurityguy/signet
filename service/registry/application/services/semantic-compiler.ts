/**
 * Semantic compiler: normalizes human-readable and machine-readable
 * skill/agent source claims into a typed proposal for the registry.
 *
 * Supported inputs:
 * - markdown skill files with a small YAML-like frontmatter subset
 *   (scalar keys, inline lists, block lists) plus heading/bullet
 *   extraction from the markdown body
 * - JSON tool manifests (name, description, capabilities, tools,
 *   inputs/outputs, constraints)
 *
 * The compiler is evidence-producing, not authoritative: it emits a
 * normalized proposal (capability claims, interfaces, constraints) and
 * warnings. Extracted claims are mapped against a normative skill-area
 * ontology; unmapped terms surface as de facto vocabulary candidates
 * and never silently become normative concepts.
 */

import type { OntologyDocument } from './ontology-validator.js';

export type CompiledSkillClaim = {
  skill_key?: string;
  display_name?: string;
  description?: string;
  capability_claims: string[];
  interfaces: { inputs: string[]; outputs: string[] };
  constraints: string[];
  warnings: string[];
};

export class SemanticCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticCompileError';
  }
}

/** Normalize a free-text term toward ontology concept-id style. */
export function normalizeClaimTerm(term: string): string {
  return term.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (documented subset)
// ---------------------------------------------------------------------------

type FrontmatterValue = string | string[];

/**
 * Parse a frontmatter block into key/value pairs. Supported subset:
 * - `key: scalar value`
 * - `key: [item, item]` (inline list)
 * - `key:` followed by indented `- item` lines (block list)
 * - `# comments` and blank lines are ignored
 * Anything more complex is a parse error (fail closed, never guess).
 */
export function parseFrontmatter(block: string): Record<string, FrontmatterValue> {
  const result: Record<string, FrontmatterValue> = {};
  const lines = block.split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    index += 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      throw new SemanticCompileError(`Unsupported frontmatter line: ${line.trim()}`);
    }
    const key = match[1] as string;
    const rest = (match[2] as string).trim();
    if (rest.startsWith('[')) {
      if (!rest.endsWith(']')) {
        throw new SemanticCompileError(`Malformed inline list for frontmatter key: ${key}`);
      }
      const items = rest
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
        .filter((item) => item.length > 0);
      result[key] = items;
      continue;
    }
    if (rest.length > 0) {
      result[key] = rest.replace(/^['"]|['"]$/g, '');
      continue;
    }
    // Block list: following indented `- item` lines.
    const items: string[] = [];
    while (index < lines.length) {
      const itemLine = lines[index] as string;
      const itemMatch = /^\s+-\s+(.+)$/.exec(itemLine);
      if (!itemMatch) break;
      items.push((itemMatch[1] as string).trim().replace(/^['"]|['"]$/g, ''));
      index += 1;
    }
    if (items.length === 0) {
      throw new SemanticCompileError(`Frontmatter key has no value: ${key}`);
    }
    result[key] = items;
  }
  return result;
}

function splitFrontmatter(content: string): { frontmatter: Record<string, FrontmatterValue>; body: string } {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(content);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  return { frontmatter: parseFrontmatter(match[1] as string), body: match[2] as string };
}

function asStringList(value: FrontmatterValue | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function extractBodySection(body: string, headingNames: string[]): string[] {
  const lines = body.split('\n');
  const items: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (headingMatch) {
      const title = (headingMatch[2] as string).trim().toLowerCase();
      inSection = headingNames.some((name) => title === name || title.startsWith(`${name} `));
      continue;
    }
    if (inSection) {
      const bullet = /^[-*]\s+(.+)$/.exec(line.trim());
      if (bullet) items.push((bullet[1] as string).trim());
    }
  }
  return items;
}

function extractTitle(body: string): string | undefined {
  for (const line of body.split('\n')) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    if (match) return (match[1] as string).trim();
  }
  return undefined;
}

function extractFirstParagraph(body: string): string | undefined {
  const lines = body.split('\n');
  const paragraph: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (!trimmed) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  return paragraph.length > 0 ? paragraph.join(' ') : undefined;
}

// ---------------------------------------------------------------------------
// Compilers
// ---------------------------------------------------------------------------

export function compileMarkdownSkill(content: string): CompiledSkillClaim {
  const warnings: string[] = [];
  const { frontmatter, body } = splitFrontmatter(content);

  const title = extractTitle(body);
  const description = extractFirstParagraph(body);
  const bodyCapabilities = extractBodySection(body, ['capabilities', 'capability claims']);
  const bodyConstraints = extractBodySection(body, ['constraints', 'behavioral constraints', 'restrictions']);

  const rawClaims = [
    ...asStringList(frontmatter['capabilities']),
    ...asStringList(frontmatter['capability_claims']),
    ...bodyCapabilities,
  ];
  const capability_claims: string[] = [];
  for (const raw of rawClaims) {
    const normalized = normalizeClaimTerm(raw);
    if (!normalized) {
      warnings.push(`dropped empty capability claim: ${JSON.stringify(raw)}`);
      continue;
    }
    if (normalized !== raw.trim()) {
      warnings.push(`normalized capability claim ${JSON.stringify(raw)} to ${JSON.stringify(normalized)}`);
    }
    if (!capability_claims.includes(normalized)) {
      capability_claims.push(normalized);
    }
  }

  const rawKey = frontmatter['skill_key'] ?? frontmatter['name'];
  const displayName = frontmatter['display_name'] ?? frontmatter['title'] ?? title;
  const compiled: CompiledSkillClaim = {
    capability_claims,
    interfaces: {
      inputs: asStringList(frontmatter['inputs']),
      outputs: asStringList(frontmatter['outputs']),
    },
    constraints: [...asStringList(frontmatter['constraints']), ...bodyConstraints],
    warnings,
  };
  if (typeof rawKey === 'string' && rawKey.length > 0) compiled.skill_key = rawKey;
  if (typeof displayName === 'string' && displayName.length > 0) compiled.display_name = displayName;
  const descriptionValue = frontmatter['description'] ?? description;
  if (typeof descriptionValue === 'string' && descriptionValue.length > 0) compiled.description = descriptionValue;
  if (capability_claims.length === 0) {
    warnings.push('no capability claims extracted from markdown source');
  }
  return compiled;
}

export function compileToolManifest(content: string): CompiledSkillClaim {
  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch {
    throw new SemanticCompileError('Tool manifest is not valid JSON.');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new SemanticCompileError('Tool manifest must be a JSON object.');
  }
  const record = manifest as Record<string, unknown>;
  const warnings: string[] = [];

  const rawClaims: string[] = [];
  for (const key of ['capabilities', 'capability_claims']) {
    const value = record[key];
    if (Array.isArray(value)) {
      rawClaims.push(...value.filter((item): item is string => typeof item === 'string'));
    }
  }
  const tools = record['tools'];
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool && typeof tool === 'object' && typeof (tool as Record<string, unknown>)['name'] === 'string') {
        rawClaims.push((tool as Record<string, unknown>)['name'] as string);
      }
    }
  }

  const capability_claims: string[] = [];
  for (const raw of rawClaims) {
    const normalized = normalizeClaimTerm(raw);
    if (!normalized) {
      warnings.push(`dropped empty capability claim: ${JSON.stringify(raw)}`);
      continue;
    }
    if (normalized !== raw.trim()) {
      warnings.push(`normalized capability claim ${JSON.stringify(raw)} to ${JSON.stringify(normalized)}`);
    }
    if (!capability_claims.includes(normalized)) {
      capability_claims.push(normalized);
    }
  }

  const stringList = (key: string): string[] => {
    const value = record[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  };
  const rawKey = record['skill_key'] ?? record['name'] ?? record['key'];
  const displayName = record['display_name'] ?? record['title'];
  const compiled: CompiledSkillClaim = {
    capability_claims,
    interfaces: { inputs: stringList('inputs'), outputs: stringList('outputs') },
    constraints: stringList('constraints'),
    warnings,
  };
  if (typeof rawKey === 'string' && rawKey.length > 0) compiled.skill_key = rawKey;
  if (typeof displayName === 'string' && displayName.length > 0) compiled.display_name = displayName;
  if (typeof record['description'] === 'string' && record['description'].length > 0) {
    compiled.description = record['description'];
  }
  if (capability_claims.length === 0) {
    warnings.push('no capability claims extracted from tool manifest');
  }
  return compiled;
}

/**
 * Map extracted claims against a normative skill-area ontology. Claims
 * binding to known concepts are mapped; the rest are de facto vocabulary
 * candidates (never silently promoted).
 */
export function mapClaimsToOntology(
  claims: string[],
  document: OntologyDocument,
): { mapped: string[]; unmapped: string[] } {
  const known = new Set(document.concepts.map((concept) => concept.id));
  const mapped: string[] = [];
  const unmapped: string[] = [];
  for (const claim of claims) {
    if (known.has(claim)) {
      mapped.push(claim);
    } else {
      unmapped.push(claim);
    }
  }
  return { mapped, unmapped };
}
