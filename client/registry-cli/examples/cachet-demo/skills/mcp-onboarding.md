---
name: MCP Onboarding
description: Connect an MCP harness to the registry and load an artifact.
triggers: [connect an agent, mcp setup, load a skill]
capabilities:
  - configure a remote MCP client
  - load agents/skills/artifacts over MCP
constraints:
  - read-only
tags: [registry, mcp, topic:registry]
---
# MCP Onboarding

Point an MCP-capable harness at Cachet and load real artifacts.

## When to use

- You are connecting Claude Code, Cursor, opencode, or another MCP client.
- A user wants an agent to discover and load registry content.

## Inputs → Outputs

- **In:** a Cloudflare Access service token + an `agk_` API key.
- **Out:** a working MCP connection that can call `registry.*` tools.

## Steps

1. Get the service token and API key (see `docs/adoption.md`).
2. Configure the harness with `CF-Access-Client-Id`/`CF-Access-Client-Secret` and `Authorization: Bearer agk_…`.
3. Discover with `registry.list_agents` / `registry.list_skills`, then load with `registry.get_artifact`.

## Example

> **Prompt:** "Load the Cachet demo agent and its skills."
> **Result:** the agent plus its linked skill URNs and artifact bodies.

## Constraints

- The MCP plane is read-only; writes go through `service/api`.
