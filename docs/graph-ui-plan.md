## Graph UI Plan

This document evaluates how to provide a graphic UI for the contents of the Jena/Fuseki-backed registry metadata.

## Goal

Give humans a practical visual way to inspect:
- agents
- skills
- skill versions
- artifacts
- links between them

without turning `service/webapp/knowledge-manager` into a full ontology editor or generic graph platform.

## Current reality

Today we already have:
- Fuseki UI for dataset/query administration
- a SPARQL query pack for direct inspection
- `service/webapp/knowledge-manager` for registry-admin flows

What was missing was:
- a visual relationship browser
- easy node/link exploration without hand-writing SPARQL

Status: the webapp now ships a cytoscape.js graph explorer at `/graph` (with `View graph` links from agent/skill detail pages) backed by `GET /v1/graph/subgraph` — the recommended Option 4 and delivery Phases 2–3 below are implemented.

## Options

### Option 1. Use Fuseki UI only

Pros:
- zero extra code
- already deployed
- good for dataset administration and direct SPARQL execution

Cons:
- not a graphic relationship explorer
- too low-level for most operators
- JSON-property blobs are awkward to inspect manually

Verdict:
- necessary baseline
- not sufficient as the main human graph UI

### Option 2. Embed YASGUI for querying

YASGUI is a mature open-source SPARQL GUI.

Pros:
- fast path to a much better query experience
- tabbed query editor
- result visualization
- works directly against Fuseki
- easier than building a SPARQL IDE ourselves

Cons:
- still query-first, not graph-first
- does not by itself solve visual node-link browsing
- may need light integration work around auth, layout, and defaults

Verdict:
- strong candidate for the query side
- not enough by itself for a graphic graph explorer

### Option 3. Reuse an RDF graph explorer

There are OSS RDF graph viewers and small Fuseki-adjacent projects that can render RDF relationships visually.

Pros:
- faster than inventing a graph visualization stack from zero
- already aligned to RDF/SPARQL concepts

Cons:
- uneven maintenance quality
- unknown fit for our registry-specific JSON-property graph shape
- likely still needs adaptation and embedding effort

Verdict:
- worth evaluating as a spike
- do not bet the product direction on an unproven third-party explorer

### Option 4. Add a lightweight embedded graph view to `knowledge-manager`

Use the existing webapp and add a graph visualization page fed by curated API endpoints or SPARQL-backed views.

Rendering candidates:
- `cytoscape.js`
- `vis-network`
- `d3-force`

Pros:
- full control over the exact human experience
- can tailor views to the registry domain instead of generic RDF triples
- can start with a narrow “agent/skill/version/artifact” graph and grow from there
- keeps the graph UI close to the current admin surface

Cons:
- some frontend work
- need to design graph filtering, node labeling, and edge semantics
- risk of overbuilding if done too broadly too early

Verdict:
- best long-term fit
- but should start narrow and curated

## Recommendation

Do not start with raw D3 alone.

Recommended path:
1. Keep Fuseki UI as the admin/query baseline.
2. Add a query-friendly shortcut layer:
   - already started via `docs/fuseki-query-pack.md`
   - optionally embed YASGUI later for advanced users
3. Build a narrow embedded graph page in `service/webapp/knowledge-manager` using a lightweight graph library.

Best default library choice:
- `cytoscape.js`

Why:
- purpose-built for graph visualization
- easier than raw D3 for node/edge interaction
- good support for filtering, layouts, hover, and click interactions
- simpler to keep maintainable in a thin operator-facing webapp

## Proposed UX shape

Add a new page in `knowledge-manager`, for example:

```text
/graph
```

Initial capabilities:
- show nodes for:
  - agents
  - skills
  - skill versions
  - artifacts
- show edges for:
  - `tg:usesSkill`
  - `tg:hasVersion`
  - `tg:implementedBy`
  - `tg:definedBy`
  - `tg:runsOn`
- click a node to inspect:
  - URN
  - entity type
  - selected properties
- filters:
  - by entity type
  - by demo entities only
  - by starting root like one agent or one skill

## Data access strategy

Preferred:
- do not point the browser directly at Fuseki first
- expose a curated read model through `service/api`

Why:
- preserves clear service boundaries
- easier to shape node labels and edge types
- easier to enforce future auth rules
- avoids leaking raw graph-store details into browser code

Suggested first endpoint family:
- `GET /v1/graph/subgraph?root_urn=...&depth=...`
- or a registry-specific read endpoint like:
  - `GET /v1/skills/:skillKey/graph`
  - `GET /v1/agents/:agentKey/graph`

The endpoint can internally query the registry core / graph store and return:
- nodes
- edges
- lightweight labels

## Delivery phases

### Phase 1. Operator-friendly querying
- keep current Fuseki UI
- keep `docs/fuseki-query-pack.md`
- optionally add embedded YASGUI later

### Phase 2. Narrow graph explorer
- add `/graph`
- add demo-entity-only graph view
- render only core registry relationships

### Phase 3. Contextual graph exploration
- “View graph” from agent detail page
- “View graph” from skill detail page
- breadcrumb/rooted graph navigation

### Phase 4. Advanced graph UX
- search
- expand neighbors
- graph filters
- export selected subgraph

## What not to do first

Do not:
- build a full ontology editor here
- build a fully generic RDF graph workbench from scratch
- expose raw Fuseki internals directly as the main operator UX
- start with custom D3 if a simpler graph library will do

## Final recommendation

Best practical path:
- near-term query UX: Fuseki + query pack, optionally YASGUI
- near-term visual UX: embed a small `cytoscape.js` graph page into `knowledge-manager`
- backend shape: curated graph read endpoints from `service/api`

That gives us:
- low risk
- useful operator value soon
- clean separation of metadata graph, artifact bytes, and human-facing views
