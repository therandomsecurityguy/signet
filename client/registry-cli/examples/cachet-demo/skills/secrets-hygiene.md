---
name: Secrets Hygiene
description: Handle Cloudflare Access service tokens and API keys safely.
triggers: [onboard a client, rotate a credential, secret leaked]
capabilities:
  - issue and rotate API keys
  - rotate the Cloudflare Access service token
constraints:
  - never store secrets in git or shell history
tags: [security, secrets, topic:security]
---
# Secrets Hygiene

Issue, store, and rotate registry credentials without leaking them.

## When to use

- Onboarding a machine client that needs a service token or API key.
- A credential may have leaked.

## Inputs → Outputs

- **In:** a client identity (agent/CLI) that needs access.
- **Out:** credentials stored in 1Password / the secret manager, never in git.

## Steps

1. Store secrets in 1Password or the environment secret manager.
2. Service token: taint `cloudflare_zero_trust_access_service_token.cachet_machines`, then update clients.
3. API key: `POST /v1/api-keys/{keyId}/rotate`; revoke with `DELETE /v1/api-keys/{keyId}`.

## Example

> **Prompt:** "Rotate the API key for the analytics agent."
> **Result:** a new `agk_` secret returned once; the old secret stops resolving.

## Constraints

- The API stores only a scrypt digest; plaintext is shown once.
