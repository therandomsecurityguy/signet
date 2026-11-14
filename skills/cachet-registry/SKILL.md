---
name: cachet-registry
description: Discover, inspect, load, trust, and use skills and agents from the Cachet registry via the MCP gateway. Use when you need to find a capability that already exists, load its real implementation, verify its certification/provenance before relying on it, or onboard onto the Cachet registry as a new agent.
---
# Cachet Registry

## Goal
Use the Cachet registry as the single source of truth for agents and skills.
Follow the canonical happy path — **discover → inspect → load → trust → use** —
so you never duplicate a capability that already exists, and you only rely on
artifacts whose certification and provenance you have checked.

## Use this skill when
- You need a capability (skill, runbook, process knowledge) and want to check whether it already exists before writing it yourself.
- You want to load the real implementation of a skill or agent.
- You need to verify that a skill/agent is current, certified, and trustworthy before using it.
- You are onboarding onto the Cachet registry as a new agent.

## Connect
All reads go through the MCP gateway (`service/mcp`) at `http://localhost:3000/mcp`
(Streamable HTTP transport) with `Authorization: Bearer <token>`.
See `docs/mcp-onboarding.md` for per-harness config (Claude Code, Cursor, opencode, generic MCP clients).

## Canonical flow

### 1. Discover
Find what already exists. Do not write a new skill until you have searched.
- `registry.search` — search skills and agents by name, key, or description. Start here.
- `registry.list_skills` / `registry.list_agents` — browse the full catalog.

Example: `registry.search` with `{ "query": "infra bootstrap", "type": "all" }`.

### 2. Inspect
Understand a candidate before loading it.
- `registry.get_skill` — get a skill and its linked artifacts (and active version).
- `registry.get_agent` — get an agent and its linked skills/artifacts/harnesses.

Check the metadata: does it do what you need? Is there an active version?

### 3. Load and verify bytes
Fetch the real implementation bytes and make them prove themselves.
- `registry.get_artifact` — fetch an artifact (content-addressed file) by sha256/URN. The response re-hashes the bytes; treat `digest_verified: false` as untrusted.

### 4. Trust
Verify the publication before relying on the artifact.
- `registry.verify_publication` — envelope digests, frozen-envelope artifact, detached signatures, and transparency proofs for a version. Treat anything other than `verification_status: verified` as untrusted.
- `registry.get_attestations` — build provenance and SBOM attestations attached to the version.
- `registry.get_provenance` — PROV-O provenance chain and audit replay.

Check: is the version `certified` (not just `draft`/`published`)? Are the
verification verdicts clean (frozen-envelope digest match, signatures valid)?
If trust signals are missing, or the version is deprecated/revoked (some
environments deny revoked reads outright), do not use it — surface that to
the human instead.

### 5. Use
Only after discover → inspect → load → trust:
- Apply the loaded skill/agent content to your task.
- Cite the `skill_key`/`agent_key` and version you used so the human can trace it.

## Recertify
Certification is not permanent. If you rely on a skill long-term, note that it
may need recertification (versions can be deprecated, revoked, or superseded).
Re-run the trust step when a skill changes.

## Tools reference (read-only)
- `registry.search`
- `registry.list_agents` / `registry.get_agent`
- `registry.list_skills` / `registry.get_skill`
- `registry.get_artifact`
- `registry.verify_publication`
- `registry.get_attestations`
- `registry.get_provenance`

The MCP gateway is a read-only trust surface. It does not publish, certify,
revoke, or supersede registry state — those go through the management-plane API
(`service/api`) with operator credentials, not from agent workflows.

## Output checklist
- [ ] Searched the registry before writing anything new
- [ ] Inspected the candidate's metadata and active version
- [ ] Loaded the real artifact bytes
- [ ] Verified certification status and provenance chain
- [ ] Cited the skill/agent key and version used
