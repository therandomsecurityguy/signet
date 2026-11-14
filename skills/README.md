# Cachet Skills

Distributable agent skills for the Cachet registry. These teach any agent how
to use the Cachet registry as the single source of truth for agents and skills.

## Skills

- `cachet-registry` — discover → inspect → load → trust → use against the
  Cachet registry via the MCP gateway.

## Install

Each skill is a self-contained `SKILL.md`. Copy the skill directory into your
agent repo's skills location for your harness.

### Cursor

```bash
mkdir -p .cursor/skills/cachet-registry
cp skills/cachet-registry/SKILL.md .cursor/skills/cachet-registry/SKILL.md
```

### Claude Code

Place the skill in your project's skills directory (e.g. `.claude/skills/`):

```bash
mkdir -p .claude/skills/cachet-registry
cp skills/cachet-registry/SKILL.md .claude/skills/cachet-registry/SKILL.md
```

### opencode

Place the skill in your opencode skills directory (e.g. `.opencode/skills/`):

```bash
mkdir -p .opencode/skills/cachet-registry
cp skills/cachet-registry/SKILL.md .opencode/skills/cachet-registry/SKILL.md
```

## Requirements

The skill expects the Cachet MCP gateway to be reachable (default
`http://localhost:3000/mcp`) with a bearer token. See `docs/mcp-onboarding.md`
for connection and per-harness config.

## Canonical source

The canonical skill for this repo lives at `.cursor/skills/cachet-registry/SKILL.md`.
The copy under `skills/cachet-registry/` is the distributable snapshot for
other agent repos — keep them in sync when the skill changes.
