---
name: local-infra-bootstrap
description: Creates or extends local development infrastructure for this repository. Use when adding a new service, Dockerfile, service env files, root compose wiring, compose overrides, shared volumes, Makefile shortcuts, or local-development docs for signet.
---
# Local Infra Bootstrap

## Goal
Set up fast local development infrastructure with:
- per-service `infra/` files
- root compose orchestration
- shared mounts and networking
- repeatable operator commands
- matching human and agent docs

## Use this skill when
- adding a new service such as `service/api`
- containerizing an existing service
- wiring shared `data/` or cross-service mounts
- adding `docker-compose.override.yml`
- introducing `make up` / `make down` / `make logs`

## Layout rules for this repo

### Per service
Keep service-specific infra inside the service:
- `service/<name>/infra/Dockerfile`
- `service/<name>/infra/.env`
- `service/<name>/infra/.env.example`

### System level
Keep cross-service orchestration in `infra/`:
- `infra/docker-compose.yml`
- `infra/docker-compose.override.yml`
- `infra/.env`
- `infra/.env.example`
- `infra/Makefile`
- `infra/README.md`
- `infra/AGENTS.md`

## Local development defaults
- bind-mount source code for fast iteration
- bind-mount `data/` for shared runtime state
- use a named `node_modules` volume for Node services
- keep local-only ergonomics in the override file, not the base compose file
- prefer `make` as the main operator entrypoint

## Workflow
1. Identify the service runtime:
   - working directory
   - dev command
   - build command
   - env file needs
2. Create the per-service Dockerfile and env files.
3. Wire the service into `infra/docker-compose.yml`.
4. Put local-only tweaks into `infra/docker-compose.override.yml`.
5. Add or update `infra/Makefile`.
6. Document the workflow for humans and agents.
7. Validate compose rendering and, if possible, bring up the stack.

## Repository-specific implementation notes

### Existing stack expectations
- `service/api` is the management plane (lifecycle + governance over
  `service/registry`); `service/mcp` is the read-only AI-facing plane;
  `service/webapp/knowledge-manager` is the browser surface
- `service/registry` is the canonical core library (no standalone HTTP
  runtime); `service/tessera-sidecar` and `service/tessera-runtime` are the
  Go transparency services used by compose and the chart
- local run paths: `scripts/demo-local.sh` (host processes, no Docker),
  `infra/` compose, and the Helm chart with `charts/signet/values-local.yaml`
  (kind/OrbStack)
- shared runtime data lives under `data/`; the chart mounts one shared PVC in
  api + mcp so graph state and CAS stay visible to both planes

### Node service advice
- set `HOST=0.0.0.0` if the service must be reachable from Docker port publishing
- use a named `node_modules` volume to avoid host/container mismatch
- if file watching is flaky in containers, use `CHOKIDAR_USEPOLLING=1` in the override file

### Compose layering
- base compose: topology, networks, shared wiring
- override compose: local TTY, host mappings, delegated mounts, watch-specific env

## Validation
Run from `infra/`:

```bash
make config
make up
make ps
make logs S=mcp
```

If the main service is MCP, also validate from `service/mcp/`:

```bash
npm run lint
npm run typecheck
npm test
```

If you touched the chart or the host demo path, also run:

```bash
helm lint charts/signet -f charts/signet/values-local.yaml
scripts/demo-local.sh demo
```

## Output checklist
- [ ] service Dockerfile exists
- [ ] service `.env` and `.env.example` exist
- [ ] service is wired into base compose
- [ ] local-only tweaks live in override compose
- [ ] `Makefile` exposes normal operator commands
- [ ] `infra/README.md` and `infra/AGENTS.md` are updated
- [ ] service README references the infra entrypoint
