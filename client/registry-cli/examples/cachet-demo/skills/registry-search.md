---
name: Registry Search
description: Find agents and skills in the Cachet registry by keyword.
triggers: [discover, find a skill, does this exist]
capabilities:
  - search the registry corpus
  - list registered agents and skills
constraints:
  - read-only
tags: [registry, discovery, topic:registry]
---
# Registry Search

Find what is already registered before you build or duplicate it.

## When to use

- You are about to author a skill and want to check for an existing one.
- A user asks "is there a skill for …?".

## Inputs → Outputs

- **In:** a keyword or short phrase.
- **Out:** ranked `skill`/`agent` hits with keys and descriptions.

## Steps

1. `registry.search` with the phrase (or `GET /v1/skills`, `GET /v1/agents`).
2. Inspect the top hit with `registry.get_skill` / `registry.get_agent`.

## Example

> **Prompt:** "Find skills related to provenance."
> **Result:** `skill:provenance-audit` — returns its key, display name, and description to inspect next.

## Constraints

- Read-only; writes go through `service/api` or the knowledge-manager webapp.
