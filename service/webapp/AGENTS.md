A webapp for the admins and user of the registry.
Users can be Admins, Internal Staff Members, or External Public.

Very simple UI, reuse something foss that is robust/solid that you know of after a research.

Current scope note:
- this webapp/knowledge-manager track is not part of the narrow beta-v1 promise by default
- the first credible beta is agent-facing via `service/mcp` plus operator-facing via `service/api`
- if this webapp grows into a real product surface, it must first lock the authority boundary with the registry graph/CAS and any VocBench / Semantic Turkey-managed knowledge assets
- do not assume Okta/browser auth for the registry-admin surface automatically extends to Semantic Turkey / VocBench ontology access
- treat real Okta-backed ontology access as intentionally deferred unless the user explicitly makes it the focus

Current implementation note:
- `knowledge-manager/` now exists as a thin runnable launchpad over `service/api`
- it may also expose a very small Semantic Turkey / VocBench companion integration path
- it is still not a full ontology authoring product inside this repo
