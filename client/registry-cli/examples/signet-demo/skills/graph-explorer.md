---
name: Graph Explorer
description: Explore the registry graph via SPARQL.
triggers: [how is this linked, subgraph, sparql]
capabilities:
  - query nodes by entity type and edges
  - read a scoped subgraph by root URN
constraints:
  - read-only
tags: [platform, graph, topic:platform]
---
# Graph Explorer

See how agents, skills, versions, and artifacts connect.

## When to use

- You want to understand the linkage around an entity.
- You are debugging a missing link or edge.

## Inputs → Outputs

- **In:** a root URN and a depth.
- **Out:** a node/edge subgraph.

## Steps

1. `GET /v1/graph/subgraph?root_urn=…&depth=N` (or the webapp Graph page).
2. Query nodes with `sgmeta:entityType` and edges with `sgmeta:from`/`sgmeta:to`.

## Example

> **Prompt:** "Show the subgraph rooted at the Signet demo agent, depth 3."
> **Result:** the agent, its linked skill versions, and their artifacts as a graph.

## Constraints

- Fuseki is cluster-internal; use the API/webapp from a browser.
