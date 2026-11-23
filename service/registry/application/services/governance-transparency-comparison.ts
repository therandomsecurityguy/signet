/**
 * Cross-log comparison: anchoring of the registry's internal governance
 * Merkle log in the companion Tessera log.
 *
 * The two logs are NOT byte-comparable: the internal log hashes canonical
 * governance-event bytes, while the companion stages canonical append-intent
 * records whose payload embeds the internal log position
 * (`log_leaf_index`) and the event artifact urn (`event_artifact_urn`). The
 * meaningful, checkable invariant is ANCHOR MATCHING: every internal
 * governance event (position + artifact urn) must be anchored by a companion
 * record carrying the same position and urn — i.e. the transparency
 * companion actually committed everything the registry's own log promises,
 * and nothing was reordered.
 *
 * Companion entries are additionally re-derived: each entry's claimed leaf
 * hash is recomputed from the record bytes the sidecar served, so a lying
 * leaf hash is reported rather than trusted.
 */

export type GovernanceTransparencyMissingAnchor = {
  leaf_index: number;
  event_artifact_urn: string;
};

export type GovernanceTransparencyRecordMismatch = {
  companion_leaf_index: number;
  companion_leaf_hash: string;
  derived_leaf_hash: string;
};

export type GovernanceTransparencyComparisonInput = {
  log_id: string;
  internal_events: Array<{ leaf_index: number; event_artifact_urn: string }>;
  companion_entries: Array<{
    leaf_hash: string;
    record_leaf_hash: string;
    payload?: { log_leaf_index?: number; event_artifact_urn?: string };
  }>;
  compared_at: string;
};

export type GovernanceTransparencyComparisonResult = {
  log_id: string;
  internal_tree_size: number;
  companion_tree_size: number;
  /** Internal events anchored by a companion record (same index + urn). */
  internal_events_anchored: number;
  missing_anchors: GovernanceTransparencyMissingAnchor[];
  missing_anchor_count: number;
  /** Companion entries whose claimed leaf hash equals the re-derived one. */
  companion_records_verified: number;
  companion_record_mismatches: GovernanceTransparencyRecordMismatch[];
  status: 'consistent' | 'companion_empty' | 'divergent';
  compared_at: string;
};

const MAX_REPORTED = 10;

export function summarizeGovernanceTransparencyComparison(
  input: GovernanceTransparencyComparisonInput,
): GovernanceTransparencyComparisonResult {
  const internalEvents = input.internal_events;
  const companionEntries = input.companion_entries;

  let anchored = 0;
  const missing: GovernanceTransparencyMissingAnchor[] = [];
  let missingCount = 0;
  for (const event of internalEvents) {
    const found = companionEntries.some(
      (entry) =>
        entry.payload?.log_leaf_index === event.leaf_index &&
        entry.payload?.event_artifact_urn === event.event_artifact_urn,
    );
    if (found) {
      anchored += 1;
      continue;
    }
    missingCount += 1;
    if (missing.length < MAX_REPORTED) {
      missing.push({ leaf_index: event.leaf_index, event_artifact_urn: event.event_artifact_urn });
    }
  }

  let companionRecordsVerified = 0;
  const recordMismatches: GovernanceTransparencyRecordMismatch[] = [];
  for (let index = 0; index < companionEntries.length; index += 1) {
    const entry = companionEntries[index] as { leaf_hash: string; record_leaf_hash: string };
    if (entry.leaf_hash === entry.record_leaf_hash) {
      companionRecordsVerified += 1;
      continue;
    }
    if (recordMismatches.length < MAX_REPORTED) {
      recordMismatches.push({
        companion_leaf_index: index,
        companion_leaf_hash: entry.leaf_hash,
        derived_leaf_hash: entry.record_leaf_hash,
      });
    }
  }

  let status: GovernanceTransparencyComparisonResult['status'];
  if (companionEntries.length === 0 && internalEvents.length > 0) {
    status = 'companion_empty';
  } else if (missingCount > 0 || recordMismatches.length > 0) {
    status = 'divergent';
  } else {
    status = 'consistent';
  }

  return {
    log_id: input.log_id,
    internal_tree_size: internalEvents.length,
    companion_tree_size: companionEntries.length,
    internal_events_anchored: anchored,
    missing_anchors: missing,
    missing_anchor_count: missingCount,
    companion_records_verified: companionRecordsVerified,
    companion_record_mismatches: recordMismatches,
    status,
    compared_at: input.compared_at,
  };
}
