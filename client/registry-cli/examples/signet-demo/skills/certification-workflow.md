---
name: Certification Workflow
description: Validate, publish, and certify a version against policy and ontology packages.
triggers: [certify, release a version, policy checks]
capabilities:
  - run graph-shape and policy validation
  - bind certification to policy/ontology versions
constraints:
  - requires an admin principal
tags: [registry, lifecycle, topic:registry]
---
# Certification Workflow

Gate a release on policy and ontology, then certify it.

## When to use

- A skill version is ready for review and release.
- You need certification bound to concrete policy/ontology versions.

## Inputs → Outputs

- **In:** a validated skill version.
- **Out:** a certified version, with the policy/ontology versions recorded as evidence.

## Steps

1. Validate: `.../validate` — records machine-readable violations (with violation paths) and gates `draft → validated`.
2. Publish: `.../publish`.
3. Certify: `.../certify` — bound to the active policy and ontology packages.

## Example

> **Prompt:** "Certify the active version of skill:certification-workflow and show the evidence."
> **Result:** the version moves to `certified` with the policy/ontology versions used.

## Constraints

- Requires an admin principal; certification is bound to registered packages.
