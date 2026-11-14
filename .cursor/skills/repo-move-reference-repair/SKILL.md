---
name: repo-move-reference-repair
description: Repairs code and documentation after a folder, service, or package is moved or renamed. Use when paths change in this repository, especially for `service/*`, `infra/`, `domain/`, or docs moves that require import fixes, tsconfig updates, README repairs, AGENTS updates, `_devagents` traceability updates, and verification.
---
# Repo Move Reference Repair

## Goal
After a move or rename, make the repository consistent again across:
- runtime imports
- build config
- service docs
- agent docs
- `_devagents` history

## Use this skill when
- a directory moved, such as `connect/mcp` -> `service/mcp`
- a package or service was renamed
- docs still reference an old path
- TypeScript import depth changed after a move

## Workflow
1. Confirm the old path and new path explicitly.
2. Search for both paths across the repo.
3. Update code references first:
   - relative imports
   - `tsconfig.json`
   - `package.json` scripts
   - runtime env defaults that depend on relative paths
4. Update documentation references next:
   - root `README.md`
   - service `README.md`
   - `AGENTS.md`
   - `infra/*`
   - `../../../../_devagents/agents-registry/projects/**/*`
5. Re-run verification from the moved service/package.
6. Do a final search for the old path and explain any remaining generated matches.

## Files to check in this repo
- `README.md`
- `service/*/README.md`
- `service/*/package.json`
- `service/*/tsconfig.json`
- `service/*/src/**/*`
- `service/*/scripts/**/*`
- `service/*/AGENTS.md`
- `infra/**/*`
- `../../../../_devagents/agents-registry/projects/**/*`

## Repository-specific checks

### TypeScript service move
When `service/mcp` or another TS service moves:
- re-check relative imports to sibling services such as `service/registry`
- re-check `rootDir` / `include` in `tsconfig.json`
- re-check `dist/...` paths in `package.json` scripts
- if Docker is involved, re-check build context and `dockerfile` paths

### Docs and traceability
When a path changes, update all three layers:
- human docs: `README.md`, `service/*/README.md`, `infra/README.md`
- agent docs: `AGENTS.md`, `infra/AGENTS.md`
- devagent history: `../../../../_devagents/agents-registry/projects/README.md` and affected `worksession-*`

### Common miss cases
- examples in code fences
- `_devagents` path history
- `README.md` titles that still use the old folder name
- generated start/build script paths

## Validation
- search for the old path again
- run the moved service's validation commands
- if a server moved, verify its health endpoint or startup logs

For `service/mcp`, the default validation is:

```bash
npm run lint
npm run typecheck
npm test
```

## Output checklist
- [ ] old path removed from source/docs
- [ ] imports compile
- [ ] docs point to the new path
- [ ] `_devagents` chronology still makes sense
- [ ] verification ran successfully

## Example
If `service/mcp` moves again:
- update `service/mcp/src/**/*` relative imports
- update `service/mcp/tsconfig.json`
- update `service/mcp/package.json`
- update root/service/infra READMEs
- update `../../../../_devagents/agents-registry/projects/worksession-*`
- run MCP validation from the new location
