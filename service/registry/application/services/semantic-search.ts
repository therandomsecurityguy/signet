// Deterministic semantic matching for registry search.
//
// Signals are ones the registry already produces: capability claims
// (ontology concept ids), display names, descriptions, interfaces,
// constraints, and source paths. No embeddings are required — the scorer is
// pure and explainable, and every match exposes its components so ordering
// is never a black box. An embedding retriever can layer on later behind
// the same result shape.
//
// Scoring (all deterministic):
//   +5   full-query phrase match in display_name/description
//   +4   per capability claim whose concept-id tokens are fully covered by
//        the query (cap 12) — "PII handling workflows" covers pii-handling
//   +3/+2/+2/+1/+0.5 per query token found in name/description/claims/
//        interface+constraint tokens/source path
//   +1   per prefix match (query token >= 4 chars is a prefix of a doc
//        token, or vice versa) for morphology (processor ~ processing), cap 5
//
// A document matches when its score is > 0.

export type SemanticSearchDocument = {
  logical_key: string;
  display_name?: string;
  description?: string;
  source_path?: string;
  capability_claims: string[];
  interfaces?: { inputs: string[]; outputs: string[] };
  constraints?: string[];
  /** Additional free-text tokens, e.g. an agent's harness name. */
  extra_terms?: string[];
};

export type SemanticMatch = {
  score: number;
  matched_claims: string[];
  matched_terms: string[];
  phrase_match: boolean;
};

const CLAIM_BONUS = 4;
const CLAIM_BONUS_CAP = 12;
const PHRASE_BONUS = 5;
const PREFIX_BONUS = 1;
const PREFIX_BONUS_CAP = 5;

export function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
  return Array.from(new Set(tokens));
}

export function scoreSemanticMatch(query: string, doc: SemanticSearchDocument): SemanticMatch {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return { score: 0, matched_claims: [], matched_terms: [], phrase_match: false };
  }

  const nameTokens = new Set(tokenize(doc.display_name ?? ''));
  const descriptionTokens = new Set(tokenize(doc.description ?? ''));
  const claimTokenSets = doc.capability_claims.map((claim) => ({ claim, tokens: new Set(tokenize(claim)) }));
  const claimTokens = new Set<string>();
  for (const entry of claimTokenSets) {
    for (const token of entry.tokens) claimTokens.add(token);
  }
  const interfaceTokens = new Set(
    tokenize([...(doc.interfaces?.inputs ?? []), ...(doc.interfaces?.outputs ?? []), ...(doc.constraints ?? [])].join(' ')),
  );
  const sourceTokens = new Set(tokenize(doc.source_path ?? ''));
  const extraTokens = new Set(tokenize((doc.extra_terms ?? []).join(' ')));

  const queryTokenSet = new Set(queryTokens);
  let score = 0;
  const matchedTerms = new Set<string>();

  // Full-query phrase match over the human-facing text.
  const normalizedQuery = query.trim().toLowerCase();
  const haystackPhrase = `${doc.display_name ?? ''}\n${doc.description ?? ''}`.toLowerCase();
  const phraseMatch = normalizedQuery.length > 0 && haystackPhrase.includes(normalizedQuery);
  if (phraseMatch) {
    score += PHRASE_BONUS;
  }

  // Capability claims fully covered by the query — the concept-aware signal.
  const matchedClaims: string[] = [];
  for (const entry of claimTokenSets) {
    if (entry.tokens.size === 0) continue;
    const covered = Array.from(entry.tokens).every((token) => queryTokenSet.has(token));
    if (covered) {
      matchedClaims.push(entry.claim);
    }
  }
  matchedClaims.sort();
  score += Math.min(matchedClaims.length * CLAIM_BONUS, CLAIM_BONUS_CAP);

  // Weighted token overlap.
  for (const token of queryTokens) {
    if (nameTokens.has(token)) {
      score += 3;
      matchedTerms.add(token);
    } else if (descriptionTokens.has(token)) {
      score += 2;
      matchedTerms.add(token);
    } else if (claimTokens.has(token)) {
      score += 2;
      matchedTerms.add(token);
    } else if (interfaceTokens.has(token)) {
      score += 1;
      matchedTerms.add(token);
    } else if (extraTokens.has(token)) {
      score += 2;
      matchedTerms.add(token);
    } else if (sourceTokens.has(token)) {
      score += 0.5;
      matchedTerms.add(token);
    }
  }

  // Prefix (morphology) matches for longer tokens.
  let prefixBonus = 0;
  const morphologyCandidates = new Set<string>([...nameTokens, ...descriptionTokens, ...claimTokens]);
  for (const token of queryTokens) {
    if (token.length < 4 || matchedTerms.has(token)) continue;
    for (const candidate of morphologyCandidates) {
      if (candidate.length < 4) continue;
      if (candidate.startsWith(token) || token.startsWith(candidate)) {
        prefixBonus += PREFIX_BONUS;
        matchedTerms.add(token);
        break;
      }
    }
  }
  score += Math.min(prefixBonus, PREFIX_BONUS_CAP);

  return {
    score: round4(score),
    matched_claims: matchedClaims,
    matched_terms: Array.from(matchedTerms).sort(),
    phrase_match: phraseMatch,
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
