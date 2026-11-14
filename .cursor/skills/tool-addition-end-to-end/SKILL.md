---
name: tool-addition-end-to-end
description: Adds a canonical tool end-to-end in the MCP gateway. Use when creating or extending `data.*` or `registry.*` tools in `service/mcp`, including contracts, tool names, tool registry, execute dispatch, routes, MCP exposure, tests, docs, and audit-safe behavior.
---
# Tool Addition End To End

## Goal
Add a tool once, with the canonical Tool API as the source of truth, then expose it through HTTP and MCP without duplicating business logic.

## Use this skill when
- adding a new `data.*` tool
- adding a new `registry.*` tool
- extending MCP tool exposure
- updating tool contracts and tests together

## Repository rule
The canonical order is:
1. contract
2. tool name
3. tool registry
4. application dispatch / connector port
5. HTTP route behavior
6. MCP exposure
7. tests
8. docs

Do not start from the MCP adapter. The MCP layer stays thin.

## Files to inspect
- `service/mcp/src/contracts/tools/*`
- `service/mcp/src/domain/tools/tool-names.ts`
- `service/mcp/src/domain/tools/tool-registry.ts`
- `service/mcp/src/application/usecases/execute-tool.ts`
- `service/mcp/src/application/ports/*`
- `service/mcp/src/app/routes/tools.ts`
- `service/mcp/src/app/routes/mcp.ts`
- `service/mcp/tests/unit/*`
- `service/mcp/tests/contract/*`

## Workflow
1. Define input/output contracts under `src/contracts/tools/`.
2. Add or extend the tool name enum/constants.
3. Register the tool in `ToolRegistry.buildDefault()`.
4. Wire the use case dispatch in `execute-tool.ts`.
5. Extend connector ports/adapters if the tool needs a new backend method.
6. Ensure HTTP Tool API picks it up through the shared use case.
7. Ensure MCP picks it up from the same registry.
8. Add tests for:
   - registry presence
   - execute path
   - route behavior
   - MCP contract parity if the tool is exposed there
9. Update README/docs if the tool is user-facing.

## Repository-specific notes

### ToolRegistry
`ToolRegistry` is the source of truth for:
- name
- description
- version
- risk tier
- input schema
- output schema

### ExecuteToolUseCase
Keep dispatch explicit. In this repo, a switch statement is acceptable because tool count is small and stable.

### MCP route
`service/mcp/src/app/routes/mcp.ts` should register tools by iterating the registry and pass through the canonical Zod schemas.

### Auditing and shaping
When the tool returns large payloads:
- redact or hash sensitive inputs
- add truncation/shaping only in the use case layer
- do not bypass audit publication

## Validation
For `service/mcp`:

```bash
npm run lint
npm run typecheck
npm test
```

Pay special attention to:
- tool registry tests
- execute-tool tests
- tool route tests
- MCP tool-list contract tests

## Output checklist
- [ ] contracts added
- [ ] tool name added
- [ ] tool registered
- [ ] use case dispatch updated
- [ ] connector port/adapter updated if needed
- [ ] HTTP route path works
- [ ] MCP exposes the same tool
- [ ] tests updated
- [ ] docs updated
