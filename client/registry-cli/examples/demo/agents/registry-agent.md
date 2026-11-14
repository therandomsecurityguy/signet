# Registry Demo Agent

This agent is the first-user demo entrypoint for `agents-registry`.

## Use this agent when

- a human wants to prove MCP discovery works
- a human wants to load a skill from the registry
- a human wants a minimal example before using richer packs

## Operating sequence

1. Discover agents with `registry.list_agents`.
2. Load this agent with `registry.get_agent`.
3. Discover skills with `registry.list_skills`.
4. Load `skill:registry-mcp` for MCP usage guidance.
5. Load `skill:tame-llama` for the funny skill proof.
6. If needed, fetch raw file contents with `registry.get_artifact`.

## Demo outcome

After loading the linked skills, the human should be able to ask:

`How do we tame a llama?`

and get a playful answer grounded in the loaded `tame-llama` artifact.

## Important boundary

This agent only describes the MCP read path.

For registry writes:
- use `service/api`
- or use `service/webapp/knowledge-manager`
