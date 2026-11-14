/**
 * LLM-based semantic validation (advisory, evidence-producing).
 *
 * The LLM layer analyzes free-text claims, descriptions, and examples
 * for overclaiming, ambiguity, example-capability inconsistency, and
 * missing ontology terms. Critical rule: this layer is evidence-
 * producing, never authoritative — every finding is advisory
 * (Warning severity) and must never silently replace the deterministic
 * graph-shape, policy, and ontology layers.
 *
 * The validator is model-agnostic: `LlmValidator` is a port. The default
 * implementation is a deterministic heuristic analyzer that runs offline
 * and produces the same evidence shape (scorecards, prompt, rationale,
 * confidence) a real LLM backend would. An HTTP-backed validator can be
 * wired via configuration to call an actual model endpoint.
 */

export type LlmValidationInput = {
  entity_type: 'SKILL_VERSION' | 'AGENT_VERSION';
  publication_urn: string;
  display_name?: string;
  description?: string;
  capability_claims: string[];
  examples: string[];
  known_concepts: string[];
};

export type LlmValidationScorecard = {
  dimension: 'overclaim' | 'ambiguity' | 'example_consistency' | 'term_coverage';
  score: number;
  rationale: string;
};

export type LlmValidationResult = {
  validator: string;
  prompt: string;
  scorecards: LlmValidationScorecard[];
  confidence: number;
  suggestions: {
    missing_ontology_terms: string[];
    policy_warnings: string[];
  };
  warnings: string[];
};

export interface LlmValidator {
  validate(input: LlmValidationInput): Promise<LlmValidationResult>;
}

const VAGUE_TERMS = [
  'etc',
  'and more',
  'various',
  'stuff',
  'things',
  'best',
  'fastest',
  'everything',
  'anything',
  'seamless',
  'robust',
  'cutting-edge',
  'world-class',
  'state-of-the-art',
];

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'into', 'over', 'under', 'between', 'through',
  'using', 'used', 'uses', 'use', 'and', 'or', 'the', 'a', 'an', 'of', 'to',
  'in', 'on', 'for', 'by', 'is', 'are', 'be', 'as', 'at', 'it', 'its',
  'safely', 'securely', 'easily', 'quickly', 'simply',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function claimTokens(claim: string): string[] {
  return claim.split('-').filter((token) => token.length > 1);
}

/**
 * Rough morphological match: exact token equality, or a common prefix of
 * at least 5 characters (covers reporting/reports, processing/processes
 * without a full stemmer).
 */
function tokensMatch(left: string, right: string): boolean {
  if (left === right) return true;
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1;
  }
  return prefix >= 5;
}

function buildPrompt(input: LlmValidationInput): string {
  return [
    `Analyze the following ${input.entity_type} publication for overclaiming, ambiguity, example-capability consistency, and missing ontology terms.`,
    `Publication: ${input.publication_urn}`,
    input.display_name ? `Name: ${input.display_name}` : null,
    input.description ? `Description: ${input.description}` : null,
    `Declared capability claims: ${input.capability_claims.join(', ') || '(none)'}`,
    input.examples.length > 0 ? `Examples: ${input.examples.join(' | ')}` : null,
    `Known ontology concepts: ${input.known_concepts.join(', ') || '(none resolved)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Deterministic heuristic validator (default, offline). Produces the
 * same evidence artifact shape as an LLM backend: scorecards per
 * dimension, a constructed prompt, rationale, confidence, and
 * suggestions. Confidence is deliberately low — heuristics approximate
 * judgment, they do not replace it.
 */
export class HeuristicLlmValidator implements LlmValidator {
  async validate(input: LlmValidationInput): Promise<LlmValidationResult> {
    const prompt = buildPrompt(input);
    const warnings: string[] = [];
    const policyWarnings: string[] = [];
    const text = `${input.display_name ?? ''} ${input.description ?? ''}`.toLowerCase();
    const textTokens = new Set(tokenize(text));

    // Overclaim detection: claims whose tokens are not grounded in the
    // free-text description may be unsupported.
    const unsupported: string[] = [];
    for (const claim of input.capability_claims) {
      const tokens = claimTokens(claim);
      const grounded = tokens.some((token) => [...textTokens].some((textToken) => tokensMatch(token, textToken)));
      if (!grounded && text.trim().length > 0) {
        unsupported.push(claim);
        warnings.push(`capability claim may be unsupported by the description: ${claim}`);
      }
    }
    const overclaimScore = input.capability_claims.length === 0 ? 0.5 : 1 - unsupported.length / input.capability_claims.length;

    // Ambiguity detection: vague or superlative language in free text.
    const vagueHits = VAGUE_TERMS.filter((term) => text.includes(term));
    for (const hit of vagueHits) {
      warnings.push(`ambiguous or unverifiable language in description: "${hit}"`);
    }
    const ambiguityScore = text.trim().length === 0 ? 0.5 : Math.max(0, 1 - vagueHits.length / 3);

    // Example-capability consistency: examples referencing terms that are
    // not declared as claims.
    const claimSet = new Set(input.capability_claims);
    const inconsistentExamples: string[] = [];
    for (const example of input.examples) {
      const exampleTokens = tokenize(example);
      const unmatched = exampleTokens.filter((token) => token.includes('-') && !claimSet.has(token));
      if (unmatched.length > 0) {
        inconsistentExamples.push(example);
        warnings.push(`example references capabilities not declared as claims: ${unmatched.join(', ')}`);
      }
    }
    const exampleScore = input.examples.length === 0 ? 1 : 1 - inconsistentExamples.length / input.examples.length;

    // Term coverage: domain-looking tokens absent from claims and known
    // concepts are suggested as missing ontology terms.
    const knownSet = new Set([...input.known_concepts, ...input.capability_claims]);
    const missingTerms = [...textTokens]
      .filter((token) => token.includes('-') && !knownSet.has(token))
      .slice(0, 10);
    if (missingTerms.length > 0) {
      policyWarnings.push(`description terms not covered by claims or ontology: ${missingTerms.join(', ')}`);
    }
    const coverageScore = 1 - Math.min(1, missingTerms.length / 5);

    return {
      validator: 'llm-heuristic-v1',
      prompt,
      scorecards: [
        {
          dimension: 'overclaim',
          score: Math.round(overclaimScore * 100) / 100,
          rationale:
            unsupported.length > 0
              ? `claims not grounded in the description: ${unsupported.join(', ')}`
              : 'all claims are grounded in the description',
        },
        {
          dimension: 'ambiguity',
          score: Math.round(ambiguityScore * 100) / 100,
          rationale:
            vagueHits.length > 0
              ? `vague or superlative language found: ${vagueHits.join(', ')}`
              : 'no vague or superlative language found',
        },
        {
          dimension: 'example_consistency',
          score: Math.round(exampleScore * 100) / 100,
          rationale:
            input.examples.length === 0
              ? 'no examples provided'
              : inconsistentExamples.length > 0
                ? `examples referencing undeclared capabilities: ${inconsistentExamples.length}`
                : 'examples are consistent with declared claims',
        },
        {
          dimension: 'term_coverage',
          score: Math.round(coverageScore * 100) / 100,
          rationale:
            missingTerms.length > 0
              ? `potential missing ontology terms: ${missingTerms.join(', ')}`
              : 'description terms are covered by claims or ontology',
        },
      ],
      confidence: 0.5,
      suggestions: {
        missing_ontology_terms: missingTerms,
        policy_warnings: policyWarnings,
      },
      warnings,
    };
  }
}

/**
 * HTTP-backed LLM validator seam: posts the analysis input to a
 * configured model endpoint expecting an LlmValidationResult-shaped
 * JSON response. The heuristic validator remains the fallback when the
 * endpoint is unreachable, so validation is never blocked by the model.
 *
 * Security notes:
 * - the endpoint URL is operator-configured (LLM_VALIDATOR_URL), never
 *   derived from submission data; only http: and https: schemes are
 *   accepted and requests carry a timeout (SSRF mitigation)
 * - the model's JSON response is untrusted: every field is rebuilt from
 *   whitelisted keys with primitive type checks, so hostile payloads
 *   cannot smuggle prototype-polluting keys or unexpected structures
 *   into registry state
 */
export class HttpLlmValidator implements LlmValidator {
  private readonly url: string;

  constructor(
    private readonly deps: { url: string; model?: string; fallback?: LlmValidator },
  ) {
    let parsed: URL;
    try {
      parsed = new URL(deps.url);
    } catch {
      throw new Error(`LLM validator URL is not a valid URL: ${deps.url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`LLM validator URL must use http: or https: (got ${parsed.protocol})`);
    }
    this.url = parsed.toString();
  }

  async validate(input: LlmValidationInput): Promise<LlmValidationResult> {
    const prompt = buildPrompt(input);
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ prompt, input, ...(this.deps.model ? { model: this.deps.model } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`LLM validator endpoint failed (${response.status})`);
      }
      const payload: unknown = await response.json();
      return sanitizeModelResponse(payload, this.deps.model ?? 'llm-http-v1', prompt);
    } catch {
      const fallback = this.deps.fallback ?? new HeuristicLlmValidator();
      return await fallback.validate(input);
    }
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Rebuild an LlmValidationResult from an untrusted model response using
 * only whitelisted keys and primitive values. Arbitrary objects from the
 * payload (including __proto__-named keys) are never passed through.
 */
function sanitizeModelResponse(payload: unknown, validator: string, prompt: string): LlmValidationResult {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const scorecards: LlmValidationResult['scorecards'] = [];
  if (Array.isArray(record['scorecards'])) {
    for (const item of record['scorecards']) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      const dimension = entry['dimension'];
      if (
        dimension !== 'overclaim' &&
        dimension !== 'ambiguity' &&
        dimension !== 'example_consistency' &&
        dimension !== 'term_coverage'
      ) {
        continue;
      }
      scorecards.push({
        dimension,
        score: Math.min(1, Math.max(0, asFiniteNumber(entry['score'], 0.5))),
        rationale: typeof entry['rationale'] === 'string' ? entry['rationale'].slice(0, 2_000) : '',
      });
    }
  }
  const suggestions =
    record['suggestions'] && typeof record['suggestions'] === 'object' && !Array.isArray(record['suggestions'])
      ? (record['suggestions'] as Record<string, unknown>)
      : {};
  return {
    validator,
    prompt,
    scorecards,
    confidence: Math.min(1, Math.max(0, asFiniteNumber(record['confidence'], 0.5))),
    suggestions: {
      missing_ontology_terms: asStringArray(suggestions['missing_ontology_terms']).slice(0, 50),
      policy_warnings: asStringArray(suggestions['policy_warnings']).slice(0, 50),
    },
    warnings: asStringArray(record['warnings']).slice(0, 100),
  };
}
