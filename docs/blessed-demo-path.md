## Blessed Demo Path

This document is the source of truth for the first-user demo of Signet.

It is optimized for one coherent local story:
- bring the stack up with Docker Compose
- seed a tiny registry pack with `registry-operator`
- connect a human MCP client to `service/mcp`
- discover and load the demo agent and skills
- load the `tame-llama` skill and ask, `How do we tame a llama?`
- optionally inspect the graph in Fuseki/Jena
- optionally prove the mock-Okta browser admin lane

### What gets seeded

The blessed demo pack contains:
- one demo agent: `cursor:registry-agent`
- one MCP usage skill: `skill:registry-mcp`
- one fun content skill: `skill:tame-llama`

The agent references both skills so a human can discover the agent first, then load the linked skills through MCP.

### Prerequisites

- Docker Desktop or a compatible local Docker runtime
- Node.js 20+
- Cursor, Claude Code, or another MCP-capable client

### Step 1. Start the stack

```bash
cd signet/infra
make up
```

Health checks:

```bash
curl -s http://localhost:3000/healthz
curl -s http://localhost:3100/healthz
curl -s http://localhost:3200/healthz
```

Expected services:
- `service/mcp` on `http://localhost:3000`
- `service/api` on `http://localhost:3100`
- `service/webapp/knowledge-manager` on `http://localhost:3200`
- Fuseki/Jena on `http://localhost:3030`

Current default metadata backend:
- persistent local `json_file` graph state at `data/registry/graph/registry-state.json`
- Fuseki-backed `sparql` using the `registry` dataset remains available as the optional inspection and live-validation backend

Current default artifact backend:
- filesystem CAS under `data/registry/objects/`

### Step 2. Run the blessed bootstrap

```bash
cd signet/client/registry-cli
npm install
npm run dev -- bootstrap test --reset --force --up
```

This command is the preferred first-user path.

It will:
- seed the blessed demo manifest through `service/api`
- verify the seeded entities through `service/api`
- verify registry discovery/load through `service/mcp`
- mint local API and MCP bearer tokens when needed
- wait for `api`, `mcp`, and Fuseki/SPARQL readiness before seeding
- clear the SPARQL dataset first when the active metadata lane is `sparql` and `--reset` is used
- print ready-to-paste MCP config plus next-step prompts
- persist token-safe run artifacts under `data/registry-operator/`

### Step 3. Connect your MCP client

Use the `cursor_mcp_config` block printed by the CLI output.

The important endpoint is:

```text
http://localhost:3000/mcp
```

The MCP bearer token is the `mcp_token` printed by the bootstrap command.

### Step 4. Discover and load the demo content

The intended MCP discovery/load sequence is:

1. Discover the demo agent with `registry.list_agents`.
2. Load the demo agent with `registry.get_agent`.
3. Discover the demo skills with `registry.list_skills`.
4. Load `skill:registry-mcp` or `skill:tame-llama` with `registry.get_skill`.
5. If the harness needs raw file contents, fetch the linked artifact with `registry.get_artifact`.

Good prompt sequence for a human in Cursor or Claude Code:

1. `Use registry.list_agents to find the registry demo agent.`
2. `Use registry.get_agent to load the registry demo agent and summarize its linked skills.`
3. `Use registry.list_skills to find the tame llama skill.`
4. `Use registry.get_skill to load skill:tame-llama.`
5. `Now answer: How do we tame a llama?`

Expected outcome:
- the harness can discover the demo agent
- the harness can load both skills
- the loaded `tame-llama` artifact gives enough funny guidance for a playful answer
- `registry.get_skill` should expose the active skill-version artifact so `registry.get_artifact` can fetch the raw skill body

### Validation report check (W3C SHACL)

Every seeded skill version was validated by the W3C SHACL engine before it
was published. Inspect a seeded skill's machine-readable report (use the
api token printed by the bootstrap):

```bash
API=http://localhost:3100
TOK=<api token from the bootstrap output>
V=$(curl -s -H "authorization: Bearer $TOK" "$API/v1/skills/skill%3Atame-llama/versions/1")
for SHA in $(echo "$V" | jq -r '.governance_artifacts[] | select(.role=="validation_report") | .sha256'); do
  curl -s -H "authorization: Bearer $TOK" "$API/v1/artifacts/$SHA" \
    | jq 'select(.payload.validator == "shacl-v1") | { validator: .payload.validator,
        engine: .payload.engine, conforms: .payload.conforms,
        shapes: .payload.layers[0].shapes_format }'
done
# -> validator: "shacl-v1", engine: "rdf-validate-shacl@0.7.0", conforms: true,
#    shapes: "shacl-turtle"
```

To register and enforce an authored SHACL Turtle policy against the same
stack, see the verified walkthrough in `docs/local-demo.md`.

### Step 5. Graph inspection

Open Fuseki:

```text
http://localhost:3030
```

Then inspect the `registry` dataset with a query like:

```sparql
SELECT ?s ?p ?o
WHERE {
  ?s ?p ?o
}
LIMIT 25
```

This is the easiest human proof that the demo entities exist in graph form in the default local metadata backend.

### Default JSON lane vs optional Fuseki lane

Default local metadata lane:
- `REGISTRY_GRAPH_BACKEND=json_file` (the compose default)
- `REGISTRY_GRAPH_STATE_FILE=/workspace/data/registry/graph/registry-state.json`

Optional Fuseki/SPARQL lane (inspection and live validation):
- set `REGISTRY_GRAPH_BACKEND=sparql` in `service/api/infra/.env`
- set `REGISTRY_GRAPH_BACKEND=sparql` in `service/mcp/infra/.env`
- keep the `registry` dataset running in local Fuseki

Required env shape for the SPARQL lane:

```bash
REGISTRY_GRAPH_BACKEND=sparql
REGISTRY_SPARQL_QUERY_URL=http://registry-graph:3030/registry/sparql
REGISTRY_SPARQL_UPDATE_URL=http://registry-graph:3030/registry/update
REGISTRY_SPARQL_USERNAME=admin
REGISTRY_SPARQL_PASSWORD=admin
```

If switching between the two lanes, restart the stack:

```bash
cd signet/infra
make down
make up
```

Then re-run the same blessed bootstrap command:

```bash
cd signet/client/registry-cli
npm run dev -- bootstrap test --reset --force --up
```

The CLI report records the active graph backend lane.

### Mock-Okta browser admin proof

The blessed demo path keeps MCP usage and browser admin proof separate.

After the bootstrap succeeds, you can prove the thin admin UI path:

```bash
cd signet/service/webapp/knowledge-manager
npx playwright install chromium
npm run demo:mock-okta
```

That flow is for the registry-admin surface only.

Real Okta remains env-gated and is still documented separately in:
- `service/webapp/knowledge-manager/OKTA_BROWSER_FLOW_RUNBOOK.md`

### Reset and rerun

To clear local bind-mounted state and rerun from zero:

```bash
cd signet/client/registry-cli
npm run dev -- local reset --force
npm run dev -- bootstrap test --reset --force --up
```

The reset command also clears stored run artifacts for the blessed demo path.
