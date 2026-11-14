---
name: Governance Audit
description: Audit the registry's governance log and transparency checkpoints.
triggers: [prove a release, when did this change, transparency check]
capabilities:
  - read inclusion proofs from the governance log
  - read transparency checkpoints and witnesses
constraints:
  - read-only
tags: [security, audit, topic:security]
---
# Governance Audit

Prove that a lifecycle operation happened, and verify the transparency log.

## When to use

- You need an immutable record of a publish/certify/revoke.
- You are verifying checkpoint consistency with witnesses.

## Inputs → Outputs

- **In:** a log id, checkpoint, or a specific version.
- **Out:** inclusion proofs, checkpoint history, and witness observations.

## Steps

1. Read the append-only log: `GET /v1/governance-log*` (inclusion proofs).
2. Read transparency state: `/v1/transparency-logs/{logId}/...`.
3. Replay a version's provenance: `.../provenance`.

## Example

> **Prompt:** "Prove that skill:governance-audit was certified, with an inclusion proof."
> **Result:** the governance event digest and its Merkle inclusion proof.

## Constraints

- Read-only; digests are staged via the Tessera sidecar when configured.
