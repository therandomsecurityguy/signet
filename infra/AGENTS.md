# `infra/` guidance for agents

Use this directory as the source of truth for local system infrastructure.

## What lives here
- `docker-compose.yml`: baseline service topology and shared wiring.
- `docker-compose.override.yml`: local developer tweaks only.
- `Makefile`: standard operator shortcuts (`make up`, `make down`, `make logs`).
- `.env` / `.env.example`: compose-level env.

## Rules
- Keep per-service Dockerfiles and service env files inside each service:
  - `service/mcp/infra/`
  - `service/api/infra/`
  - `service/registry/infra/`
- Keep system-level concerns in this folder:
  - service orchestration
  - network wiring
  - cross-service shared volume wiring
- For local tweaks, prefer the override file instead of mutating base compose.
- Do not encode production-only assumptions in local compose.

## Local operation
Run commands from `projects/agents-registry/infra`:

```bash
make up
make logs S=mcp
make down
```
