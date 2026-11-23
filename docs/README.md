## Docs Index

These docs are the human-readable overview layer for **Signet**.

### Start here
- quick value and killer-app roadmap: `quick-value-roadmap.md`
- governance model: `governance-model.md`
- blessed first-user demo path: `blessed-demo-path.md`
- **adopting Signet (deployed): `adoption.md`**
- artifact storage and S3 prep: `artifact-storage.md`
- Tessera explainer and local dev plan: `tessera.md`
- Fuseki query pack: `fuseki-query-pack.md`
- graph UI plan: `graph-ui-plan.md`
- local operator guide: `local-development.md`
- local demo without AWS/Docker: `local-demo.md`
- recorded demo video (terminal + web console): `demo/signet-demo.mp4`
- service boundaries and topology: `service-map.md`
- registry graph + CAS model: `registry-model.md`
- WORM artifact storage (S3 Object Lock): `runbooks/worm-artifacts.md`
- API reference: `api-reference.md`
- SHACL-AF execution boundary (in-process vs sidecar): `shacl-af-in-process-design.md`
- MCP onboarding: `mcp-onboarding.md`
- beta v1 scope and readiness: `beta-v1-readiness.md`

### Canonical architecture shortcut
- internal core: `service/registry`
- management plane: `service/api`
- AI-facing plane: `service/mcp`
- human-facing thin UI: `service/webapp/knowledge-manager`

### Best order for a new human
1. `quick-value-roadmap.md`
2. `governance-model.md`
3. `blessed-demo-path.md`
4. `local-development.md`
5. `service-map.md`
6. `registry-model.md`

### Best order for a new agent
1. root `README.md`
2. root `AGENTS.md`
3. `service/api/AGENTS.md`
4. `infra/AGENTS.md`
5. this docs folder

### What these docs do not replace
- service entrypoint READMEs for hands-on usage
