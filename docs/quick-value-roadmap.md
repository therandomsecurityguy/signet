## Quick Value Roadmap

This document answers four human questions:

1. Why should people inside the company care about this project?
2. What can it already do today?
3. What are the strongest “killer app” directions?
4. What future worksessions should we execute to make those directions real?

## Project promise

**Signet** should become the trusted internal open-source layer that helps humans and AI agents:
- discover useful skills
- load the actual implementation artifacts
- understand provenance and trust
- access approved data and process capabilities safely
- reuse certified operational knowledge instead of reinventing it

The registry matters when it reduces time-to-value, not only when it stores metadata.

## Quick value today

### 1. Trusted MCP discovery and load
Today the project already provides:
- an MCP-facing registry plane in `service/mcp`
- registry discovery/load over:
  - `registry.list_agents`
  - `registry.get_agent`
  - `registry.list_skills`
  - `registry.get_skill`
  - `registry.get_artifact`
- linked artifact content for real demo skills

Human value:
- a harness user can find what exists
- load what matters
- inspect enough metadata and bytes to decide whether to trust and use it

### 2. Thin human registry admin surface
Today the project also provides:
- a browser admin surface in `service/webapp/knowledge-manager`
- registry browsing for agents and skills
- lifecycle actions for skill versions
- graph exploration and Fuseki query shortcuts

Human value:
- operators can inspect and manage registry metadata without only using curl or raw Fuseki

### 3. Read-only data access gateway base
The MCP/tool plane already has the base for a practical data-access story:
- `data.query`
- `data.list_tables`
- `data.describe_table`

Current connector direction:
- MotherDuck
- Snowflake
- Athena

Human value:
- the foundation exists for “ask questions over approved data sources through trusted tools”

### 4. Transparency and trust inspection
Today the project also provides a real first transparency/governance trust layer:
- trusted `PUBLIC_KEY`, `TRANSPARENCY_LOG`, and `TRANSPARENCY_WITNESS` records
- checkpoint registration, checkpoint history, and append-only consistency validation
- witness attestations and quorum-aware verification (distinct-witness counting; per-log key independence enforced — one key material per party, same key across different logs allowed)
- cross-log witness coverage reporting from cryptographic evidence (checkpoints witnessed per log, recency, cross-log totals — no scoring)
- observed checkpoints, disagreement evidence, and split-view-style detection surfaces
- witness gossip events and timeline-style provenance views (fail-closed: attached witnesses only, source checkpoint evidence required, verified relay chains with consistent hop depths surfaced as `relayed_from_event_urn`)
- signed-note checkpoint ingestion that preserves raw note bytes while normalizing the checkpoint, with fail-closed transparency-dev spec key-identity binding (Ed25519 name-bound key hash) alongside the legacy SPKI-hint format; the native sidecar emits spec notes in note mode (fixture-verified against golang's note library)
- fuller multi-signature parsing plus stronger observation/gossip provenance; waxing-style witness cosignatures on signed notes are verified against attached witnesses with fail-closed handling and distinct-witness quorum counting, and the native sidecar serves the C2SP tlog-tiles read API (checkpoint, hash tiles, entry bundles, fixture-verified against transparency-dev's layout packages)

Human value:
- operators can inspect why a checkpoint is trusted, not only whether it is trusted
- humans and agents can follow the trust story across time instead of only reading the current verdict
- the project now has the start of a real network-aware transparency model, not only lifecycle metadata

## Killer app candidates

These are the strongest near-term value paths.

### Killer app A. MCP access to trusted data skills

Story:
- a human opens Cursor or Claude Code
- discovers a certified data skill
- that skill tells the harness which approved tools and data sources to use
- the harness can then read data safely from approved sources

Examples:
- “show me daily revenue from MotherDuck”
- “list Snowflake tables for this domain”
- “describe the Athena table behind this dashboard”

What makes it valuable:
- fast time-to-first-answer
- less tribal knowledge
- safer access path than ad hoc credentials and one-off scripts

### Killer app B. Trusted process skills for content and data pipelines

Story:
- a human discovers a skill for an operational process
- the skill encodes how to run a process safely and repeatedly
- the skill links to the actual artifact/runbook/implementation

Examples:
- semantic sync / ontology maintenance flows
- content pipeline procedures
- data publishing or promotion checklists
- operational recovery playbooks

What makes it valuable:
- turns fragile runbooks into discoverable, linked, trustable assets

### Killer app C. Intent-driven workflow creation

Story:
- a human states an intent like:
  - “create a new stream processor with SDK v3”
  - “bootstrap a new pipeline”
  - “wire a content flow”
- the system discovers and orchestrates the needed certified skills
- future automation executes the steps with strong traceability

What makes it valuable:
- moves the registry from catalog to execution-enablement layer

### Killer app D. Cross-source access layer beyond the first three connectors

Current likely expansion targets:
- Pinot
- Kafka
- Kinesis

What makes it valuable:
- the same discovery/trust surface can front more than only warehouse-style systems
- helps unify structured data access and streaming/process access under one internal mental model

## Skill happy path

A good skill experience should be:

1. Discoverable
2. Loadable
3. Understandable
4. Trustable
5. Usable
6. Certifiable
7. Recertifiable

For humans and agents, that means a strong happy path looks like:

1. Discover a skill by intent or domain.
2. Inspect metadata:
   - owner
   - description
   - source path
   - provenance
   - lifecycle status
3. Load the linked artifact body.
4. Understand the expected usage pattern.
5. Use the skill with the relevant MCP tools or operational workflow.
6. See whether it is certified and who certified it.
7. Feed back reliability signals for later recertification.

## Trust and certification

This project should treat trust as a first-class concern.

Skill metadata should eventually make it easy to answer:
- who owns this skill?
- what does it operate on?
- when was it last verified?
- what environment was it validated in?
- which connectors, systems, or datasets does it depend on?
- who certified it?
- is it currently recommended, deprecated, or stale?

### Existing lifecycle base
The registry now has a full certification state machine for skills and agents:
- draft, validated, rejected, published, certified, deprecated, revoked, archived
- deterministic draft rejection with recorded validation failures
- supersession guards (revoked snapshots are never superseded)
- full agent-version lifecycle parity with skills

### Delivered trust layer
Certification is now operationally meaningful, not a boolean flag:
- certification bound to concrete policy and ontology versions
- optional certification expiry
- certification evidence artifacts linked via `sg:certificationEvidence`
- validation and review evidence linked via `sg:validatedBy` and `sg:reviewedBy`
- W3C SHACL policy validation: legacy JSON shape documents and authored SHACL Turtle policies execute as W3C SHACL Core (`rdf-validate-shacl`) with RE2-governed patterns, and authored policies may use SPARQL constraints and SPARQL-based targets (SPARQL-capable hybrid engine with the plugin always loaded; registration refuses unexecuted features); SHACL-AF rules, SPARQL functions, and custom SPARQL-based constraint components execute on the optional pyshacl runtime sidecar (`service/shacl-runtime`, prepared shapes only, fail-closed without it); validation reports record the validator, engine version per layer, and per-layer shapes fingerprints
- canonical provenance export + signatures: PROV-O export with an RDFC-1.0 canonical digest and content-addressed artifact (plus `?format=jsonld`), detached signatures with `valid`/`stale`/`invalid` verdicts re-computed on every read, and local verification via the operator CLI and the SDK
- validation reports as standardized RDF: `sh:ValidationReport` JSON-LD with its own canonical digest and artifact; report artifacts are signable by trusted keys over that canonical RDF and re-verified (`valid`/`invalid` — reports are immutable), with provenance exports, provenance signatures, report RDF, and report signatures all covered by Tessera append intents + reconciliation
- first-class RDF/OWL vocabularies: ontology packages can be authored as OWL Turtle (tight, totally-projected subset with registration-time refusals) alongside legacy JSON; every package carries an RDFC-1.0 format-independent canonical semantic digest + artifact recorded on details and the validation report; claim validation rejects disjoint combinations transitively through the subclass hierarchy (with the disjoint ancestor pair as evidence); bound skill-area ontologies are exposed to SHACL execution (claim concept IRIs + subclass taxonomy for `sh:class` hierarchy semantics), and de-facto promotion defaults to the source's format (authored-OWL sources keep class IRIs via a deterministic writer) with a one-way cross-format legacy JSON → authored OWL conversion (`target_ontology_format`; the reverse direction is refused)

Examples of remaining certification metadata:
- certification scope
- environment verified
- trust tier
- supported connectors / systems

## Recommended future worksessions

These are proposed worksessions for future implementation. They are not yet completed.

### Worksession 38. Human entrypoint and product-story hardening

Goal:
- finish reshaping the project docs around quick value and internal adoption

Outputs:
- stronger root README
- clearer “what works today” story
- clearer “what is next” story

### Worksession 39. Data-access golden path

Goal:
- create one great happy path for data access through MCP

Suggested slice:
- one MotherDuck happy path
- one Snowflake happy path
- one Athena happy path
- operator docs and demo prompts

### Worksession 40. Skill trust and certification metadata

Goal:
- deepen certification beyond a thin lifecycle event

Suggested slice:
- trust fields
- certification evidence model
- recertification posture
- “safe to use” read surfaces

### Worksession 41. Process and content-pipeline skills

Goal:
- make process skills first-class and demonstrably useful

Suggested slice:
- content-pipeline example skill pack
- process/task lineage view
- operational happy path docs

### Worksession 42. SDK v3 killer-app specification

Goal:
- specify the intent-driven workflow story for “create a new stream processor with SDK v3”

Suggested slice:
- end-to-end user story
- required skills
- required MCP/tool interactions
- trust/certification checkpoints

### Worksession 43. Connector expansion specification

Goal:
- define how Pinot, Kafka, and Kinesis fit the model

Suggested slice:
- connector contract direction
- read-only vs operational boundaries
- registry metadata fields needed for these systems

### Worksession 44. Graph UX deepening

Goal:
- make the graph explorer more useful for daily operator work

Suggested slice:
- edge-type filters
- demo-only toggle
- expand-neighbors interaction
- better node detail navigation

### Worksession 45. Beta trustability package

Goal:
- prepare a credible internal beta around trusted discovery/load and approved data/process skills

Suggested slice:
- stronger trust docs
- stronger operational readiness checks
- stronger certification workflows

## Practical recommendation

If the project wants quick internal adoption, the best short path is:

1. Make one or two killer apps work extremely well.
2. Make their skills obviously trustworthy.
3. Make discovery/load dead simple through MCP.
4. Keep the graph and metadata explainable to humans.

The strongest immediate bet is:
- trusted MCP data access over approved sources
- plus a smaller operational/process skill story
- while continuing the trust/transparency line far enough to validate a realistic sample graph against a persistent backend

That gives “quick time to great value” much faster than trying to make the registry solve every knowledge-management problem at once.
