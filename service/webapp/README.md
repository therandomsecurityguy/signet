## `service/webapp` — Human-Facing UI Surfaces

This directory holds browser-facing human interfaces for **Cachet** (formerly `agents-registry`).

Current surface:
- `knowledge-manager/`
  - thin registry-admin and ontology-authoring launchpad
  - browses registry metadata through `service/api`
  - now exposes browser-based registry write flows over `service/api`
  - now exposes skill lifecycle actions over the management plane
  - now keeps a minimal server-side session so operators authenticate once per browser session
  - now aligns browser session acquisition to the `service/api` auth mode (`api_key`, `okta`, or `dual`)
  - now persists browser sessions server-side in SQLite so management sessions survive restart
  - integrates with VocBench / Semantic Turkey as a companion path
  - intentionally does not yet unify Okta/browser auth with the companion ontology-authoring runtime

### Current boundary
- `service/webapp` is **not** the canonical management plane
- `service/api` remains the canonical external management plane
- `service/webapp` should consume `service/api`, not `service/registry` directly
- VocBench / Semantic Turkey remain the authority for ontology authoring where used
- Okta/browser auth alignment currently applies to the registry-admin surface, not to direct ontology access inside the companion tooling

### Get value fast

```bash
cd cachet/service/webapp/knowledge-manager
npm install
npm run dev
```

Then open:

```text
http://localhost:3200
```

Current operator value:
- browse agents and skills
- inspect agent and skill details
- register agents and skills
- create skill drafts through the management-plane lifecycle API
- validate, publish, promote, deprecate, and certify skill versions from the browser
- authenticate once to the webapp management session instead of re-pasting a bearer token per action
- prefer Okta-style browser session acquisition in `okta` or `dual` mode, while keeping API-key mode as the local fallback
- keep ontology work as a separate companion path

### Local compose path

```bash
cd cachet/infra
make up
```

This brings up the narrow beta stack including the webapp.

If you also want the optional VocBench / Semantic Turkey companion:

```bash
cd cachet/infra
make up-knowledge
```

### Related docs
- `service/webapp/knowledge-manager/README.md`
- `service/webapp/knowledge-manager/VOCBENCH_SEMANTIC_TURKEY_LOCAL_DEV_GUIDE.md`
- `docs/beta-v1-readiness.md`
