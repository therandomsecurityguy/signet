---
name: Access Review
description: Run periodic Okta group and API-key access reviews for the registry.
triggers: [who can access, access review, joiners/movers/leavers]
capabilities:
  - enumerate admin and viewer group membership
  - audit and revoke API keys
constraints:
  - requires an admin principal
tags: [security, access, topic:security]
---
# Access Review

Attest who can read or administer the registry, and prune stale credentials.

## When to use

- Quarterly access reviews, or after a joiner/mover/leaver.
- An incident review needs the current access list.

## Inputs → Outputs

- **In:** the Okta groups `app_signet_admin` / `app_signet_viewer`.
- **Out:** an access attestation plus a list of revoked stale keys.

## Steps

1. Enumerate group membership (managed in Okta / Serval).
2. List active API keys: `GET /v1/api-keys` (metadata only).
3. Revoke keys with no owner or recent use: `DELETE /v1/api-keys/{keyId}`.

## Example

> **Prompt:** "Who administers Signet, and which API keys are stale?"
> **Result:** the admin roster plus keys flagged for revocation.

## Constraints

- Never assign users directly to the app; use the role groups.
- API-key metadata is admin-only.
