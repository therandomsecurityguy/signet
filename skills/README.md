# Signet Skills

Distributable agent skills for the Signet registry. These teach any agent how
to use the Signet registry as the single source of truth for agents and skills.

## Skills

- `signet-registry` — discover → inspect → load → trust → use against the
  Signet registry via the MCP gateway.

## Install

Each skill is a self-contained `SKILL.md`. Copy the skill directory into your
agent repo's skills location for your harness.

### Cursor

```bash
mkdir -p .cursor/skills/signet-registry
cp skills/signet-registry/SKILL.md .cursor/skills/signet-registry/SKILL.md
```

### Claude Code

Place the skill in your project's skills directory (e.g. `.claude/skills/`):

```bash
mkdir -p .claude/skills/signet-registry
cp skills/signet-registry/SKILL.md .claude/skills/signet-registry/SKILL.md
```

### opencode

Place the skill in your opencode skills directory (e.g. `.opencode/skills/`):

```bash
mkdir -p .opencode/skills/signet-registry
cp skills/signet-registry/SKILL.md .opencode/skills/signet-registry/SKILL.md
```

## Requirements

The skill expects the Signet MCP gateway to be reachable (default
`http://localhost:3000/mcp`) with a bearer token. See `docs/mcp-onboarding.md`
for connection and per-harness config.

## Canonical source

The canonical skill for this repo lives at `.cursor/skills/signet-registry/SKILL.md`.
The copy under `skills/signet-registry/` is the distributable snapshot for
other agent repos — keep them in sync when the skill changes.
