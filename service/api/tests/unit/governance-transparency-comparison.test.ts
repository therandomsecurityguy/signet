import { describe, expect, it } from 'vitest';

import {
  summarizeGovernanceTransparencyComparison,
  type GovernanceTransparencyComparisonInput,
} from '../../../registry/application/services/governance-transparency-comparison.js';

const URN_A = 'urn:sg:artifact:sha256:a';
const URN_B = 'urn:sg:artifact:sha256:b';

function entry(
  leaf: string,
  derived?: string,
  payload?: { log_leaf_index: number; event_artifact_urn: string },
) {
  return {
    leaf_hash: leaf,
    record_leaf_hash: derived ?? leaf,
    ...(payload ? { payload } : {}),
  };
}

function input(overrides: Partial<GovernanceTransparencyComparisonInput> = {}): GovernanceTransparencyComparisonInput {
  return {
    log_id: 'registry-governance',
    internal_events: [
      { leaf_index: 0, event_artifact_urn: URN_A },
      { leaf_index: 1, event_artifact_urn: URN_B },
    ],
    companion_entries: [
      entry('envelope-intent'),
      entry('anchor-a', 'anchor-a', { log_leaf_index: 0, event_artifact_urn: URN_A }),
      entry('anchor-b', 'anchor-b', { log_leaf_index: 1, event_artifact_urn: URN_B }),
      entry('report-intent'),
    ],
    compared_at: '2026-11-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('governance transparency comparison (anchor matching)', () => {
  it('is consistent when every internal event is anchored (companion may carry extras)', () => {
    const result = summarizeGovernanceTransparencyComparison(input());
    expect(result.status).toBe('consistent');
    expect(result.internal_events_anchored).toBe(2);
    expect(result.missing_anchor_count).toBe(0);
    expect(result.missing_anchors).toEqual([]);
    expect(result.companion_records_verified).toBe(4);
    expect(result.companion_record_mismatches).toEqual([]);
    expect(result.internal_tree_size).toBe(2);
    expect(result.companion_tree_size).toBe(4);
  });

  it('reports companion_empty when nothing was staged', () => {
    const result = summarizeGovernanceTransparencyComparison(input({ companion_entries: [] }));
    expect(result.status).toBe('companion_empty');
    expect(result.missing_anchor_count).toBe(2);
    expect(result.missing_anchors).toHaveLength(2);
  });

  it('flags unanchored or mis-indexed events as divergent', () => {
    const missingUrn = summarizeGovernanceTransparencyComparison(
      input({
        companion_entries: [
          entry('anchor-a', 'anchor-a', { log_leaf_index: 0, event_artifact_urn: URN_A }),
          entry('anchor-b', 'anchor-b', { log_leaf_index: 1, event_artifact_urn: 'urn:sg:artifact:sha256:other' }),
        ],
      }),
    );
    expect(missingUrn.status).toBe('divergent');
    expect(missingUrn.internal_events_anchored).toBe(1);
    expect(missingUrn.missing_anchors).toEqual([{ leaf_index: 1, event_artifact_urn: URN_B }]);

    const wrongIndex = summarizeGovernanceTransparencyComparison(
      input({
        companion_entries: [
          entry('anchor-a', 'anchor-a', { log_leaf_index: 0, event_artifact_urn: URN_A }),
          entry('anchor-b', 'anchor-b', { log_leaf_index: 7, event_artifact_urn: URN_B }),
        ],
      }),
    );
    expect(wrongIndex.status).toBe('divergent');
    expect(wrongIndex.missing_anchors).toEqual([{ leaf_index: 1, event_artifact_urn: URN_B }]);
  });

  it('flags lying companion leaf hashes (record re-derivation) as divergent', () => {
    const result = summarizeGovernanceTransparencyComparison(
      input({
        companion_entries: [
          entry('anchor-a', 'anchor-a', { log_leaf_index: 0, event_artifact_urn: URN_A }),
          entry('anchor-b', 'not-b', { log_leaf_index: 1, event_artifact_urn: URN_B }),
        ],
      }),
    );
    expect(result.status).toBe('divergent');
    expect(result.internal_events_anchored).toBe(2);
    expect(result.companion_records_verified).toBe(1);
    expect(result.companion_record_mismatches).toEqual([
      { companion_leaf_index: 1, companion_leaf_hash: 'anchor-b', derived_leaf_hash: 'not-b' },
    ]);
  });

  it('caps reported missing anchors but counts them all', () => {
    const internal = Array.from({ length: 25 }, (_, index) => ({
      leaf_index: index,
      event_artifact_urn: `urn:sg:artifact:sha256:${index}`,
    }));
    const result = summarizeGovernanceTransparencyComparison(
      input({ internal_events: internal, companion_entries: [] }),
    );
    expect(result.status).toBe('companion_empty');
    expect(result.missing_anchor_count).toBe(25);
    expect(result.missing_anchors).toHaveLength(10);
  });
});
