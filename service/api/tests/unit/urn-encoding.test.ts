import { describe, expect, it } from 'vitest';

import {
  harnessUrn,
  provAgentUrn,
  toolUrn,
} from '../../../registry/domain/signet/db/graph/freeform/registry/urn.js';

// Free-text names must be percent-encoded before they become IRIs: Fuseki
// rejects triples whose IRIs contain spaces, which crashed lifecycle
// operations (review/validate/publish) *after* their state was committed
// whenever an author had a space in their name ("Dana Reviewer").
describe('free-text urn builders', () => {
  it('percent-encodes names so IRI-validating backends accept them', () => {
    expect(provAgentUrn('Dana Reviewer')).toBe('urn:sg:prov-agent:Dana%20Reviewer');
    expect(provAgentUrn('security reviewer #2')).toBe('urn:sg:prov-agent:security%20reviewer%20%232');
    expect(harnessUrn('Claude Code')).toBe('urn:sg:harness:Claude%20Code');
    expect(toolUrn('My Tool')).toBe('urn:sg:tool:My%20Tool');
  });

  it('leaves machine-style names unchanged so existing nodes stay addressable', () => {
    expect(provAgentUrn('registry-operator')).toBe('urn:sg:prov-agent:registry-operator');
    expect(provAgentUrn('pablo')).toBe('urn:sg:prov-agent:pablo');
    expect(harnessUrn('cursor')).toBe('urn:sg:harness:cursor');
    expect(toolUrn('registry-mcp')).toBe('urn:sg:tool:registry-mcp');
  });
});
