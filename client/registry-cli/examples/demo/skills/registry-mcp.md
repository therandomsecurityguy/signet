# Registry MCP Demo Skill

Use this skill when a human wants to discover or load registry content through `service/mcp`.

## Purpose

This skill explains the happy-path MCP workflow for the local demo stack.

You should use the registry read-only tools in this order:
1. `registry.list_agents`
2. `registry.get_agent`
3. `registry.list_skills`
4. `registry.get_skill`
5. `registry.get_artifact` when the harness needs the raw file contents

## Install

Point the MCP client at:

```text
http://localhost:3000/mcp
```

Use the bearer token provided by `registry-operator bootstrap test`.

Example Cursor MCP config shape:

```json
{
  "mcpServers": {
    "agents-registry": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer <mcp-token>"
      }
    }
  }
}
```

## Discover

To discover the demo agent:
- call `registry.list_agents`
- look for `cursor:registry-agent`

To discover the demo skills:
- call `registry.list_skills`
- look for `skill:registry-mcp`
- look for `skill:tame-llama`

## Load

To load the agent:
- call `registry.get_agent` with the agent URN returned by `registry.list_agents`
- inspect the linked skill URNs and artifact URNs

To load a skill:
- call `registry.get_skill` with the skill URN returned by `registry.list_skills`
- if the harness needs the file body, call `registry.get_artifact` with the linked artifact URN

## Demo prompts

Use prompts like:
- `Use registry.list_agents to find the registry demo agent.`
- `Use registry.get_agent to load the registry demo agent and summarize its linked skills.`
- `Use registry.list_skills to find the tame llama skill.`
- `Use registry.get_skill to load skill:tame-llama.`

## Boundaries

- these tools are read-only
- use `service/api` or the knowledge-manager webapp for management-plane writes
- the mock-Okta browser proof is separate from the MCP discovery/load demo
