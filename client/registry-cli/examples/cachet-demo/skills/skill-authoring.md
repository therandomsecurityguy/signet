---
name: Skill Authoring
description: Author a new skill version and drive it through the lifecycle.
triggers: [add a skill, new version, publish a skill]
capabilities:
  - create a skill draft with a CAS artifact
  - run validate / publish / certify
constraints:
  - requires an admin principal
tags: [registry, lifecycle, topic:registry]
---
# Skill Authoring

Turn a markdown file into a versioned, certified registry skill.

## When to use

- You are adding a new skill to the registry.
- You need to ship an update as a new version of an existing skill.

## Inputs → Outputs

- **In:** `skill_key`, artifact bytes, and lineage metadata (source path, commit, tag).
- **Out:** a draft → validated → published → certified skill version.

## Steps

1. Create a draft: `POST /v1/skills/{skillKey}/drafts` with the artifact.
2. Validate: `POST /v1/skills/{skillKey}/versions/{version}/validate`.
3. Publish: `.../publish`, then `.../certify`.

## Example

> **Prompt:** "Add skill:hello-world from this markdown and publish it."
> **Result:** v1 is created, validated, published, and certified; the active version updates.

## Constraints

- Writes require Okta `app_cachet_admin` or a write-scoped `agk_` key.
- Validation failures are recorded and block the `draft → validated` transition.
