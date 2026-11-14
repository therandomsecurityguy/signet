---
name: Provenance Audit
description: Inspect the PROV-O provenance and certification evidence for a version.
triggers: [can I trust this, where did this come from, audit]
capabilities:
  - read PROV-O derivation chains
  - read verification and certification evidence
constraints:
  - read-only
tags: [registry, trust, topic:registry]
---
# Provenance Audit

Prove where a version came from and that it was certified.

## When to use

- You are about to use a skill and want to verify its origin.
- An auditor asks who/what produced a version and which operations ran.

## Inputs → Outputs

- **In:** `skill_key` + `version` (or an agent key).
- **Out:** a `derivation_chain`, entity/activity/agent records, and replay metadata.

## Steps

1. `GET /v1/skills/{skillKey}/versions/{version}/provenance`.
2. Cross-check `.../verification` and the publication envelope.
3. For the append-only trail, query `/v1/governance-log*`.

## Example

> **Prompt:** "Show how skill:provenance-audit v1 was produced and certified."
> **Result:** the PROV-O chain (draft → validate → publish → certify) with the certifying agent.

## Constraints

- Read-only; digests are staged via the Tessera sidecar when configured.
