# Signet Registry API Reference

The Signet registry API (`service/api`) is the programmatic management plane for
agents and skills. It is the canonical write/publication authority and the
source of truth for the typed SDK.

- **Base URL (local):** `http://localhost:3100`
- **OpenAPI spec:** `GET /v1/openapi.json` (OpenAPI 3.1)
- **Swagger UI:** `GET /v1/docs`
- **Auth:** `Authorization: Bearer <token>` on all write routes (and reads that
  require a principal)

> **Deployed:** `https://signet-api.example.com` behind
> Cloudflare Access. See `adoption.md` for the CF-Access service-token headers
> and API-key setup.

## Quickstart

### Create a write API key

```bash
cd service/api
npm run create-api-key -- --owner-label "Jane Doe"
```

### List skills (curl)

```bash
curl -s http://localhost:3100/v1/skills
```

### Create a skill (curl, authenticated)

```bash
curl -s -X POST http://localhost:3100/v1/skills \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer <token>" \
  -d '{
    "skill_key": "skill:example",
    "display_name": "Example Skill",
    "artifact": {
      "content": "# Skill file\n\nhello",
      "encoding": "utf8",
      "media_type": "text/markdown",
      "original_path": "skills/example.md"
    }
  }'
```

### Use the typed SDK

```ts
import { RegistryClient } from '@signet-registry/sdk';

const client = new RegistryClient({ baseUrl: 'http://localhost:3100', apiToken: '<token>' });
const skills = await client.listSkills();
const skill = await client.getSkill('skill:example');
const verification = await client.getSkillVerification('skill:example', 1);
```

## Auth modes

- `AUTH_MODE=api_key` (default): opaque bearer API keys from `npm run create-api-key`
- `AUTH_MODE=okta`: Okta access tokens
- `AUTH_MODE=dual`: tokens starting with `agk_` are API keys; others are Okta

## Endpoints

### Service / meta
| Method | Path | Description |
|---|---|---|
| GET | `/healthz` | Liveness |
| GET | `/readyz` | Readiness |
| GET | `/v1` | Service boundary descriptor |
| GET | `/v1/openapi.json` | Generated OpenAPI 3.1 spec |
| GET | `/v1/docs` | Swagger UI |
| GET | `/v1/session` | Resolve current principal |

### Agents
| Method | Path | Description |
|---|---|---|
| GET | `/v1/agents` | List agents |
| GET | `/v1/agents/{agentKey}` | Get agent |
| POST | `/v1/agents` | Create agent (idempotent) |
| GET | `/v1/agents/{agentKey}/versions` | List agent versions |
| GET | `/v1/agents/{agentKey}/active` | Resolve active version |
| GET | `/v1/agents/{agentKey}/versions/{version}/publication-envelope` | Publication envelope |
| GET | `/v1/agents/{agentKey}/versions/{version}/verification` | Publication verification |
| GET | `/v1/agents/{agentKey}/versions/{version}/provenance` | PROV-O provenance (structured or `?format=jsonld`) |
| POST | `/v1/agents/{agentKey}/versions/{version}/provenance/signatures` | Attach a detached provenance signature |
| GET | `/v1/agents/{agentKey}/versions/{version}/report-signatures` | Validation-report signatures, re-verified on read |
| POST | `/v1/agents/{agentKey}/versions/{version}/report-signatures` | Attach a signature over a report's canonical RDF |
| POST | `/v1/agents/{agentKey}/drafts` | Create draft version |
| POST | `/v1/agents/{agentKey}/versions/{version}/signatures` | Attach detached signature |
| POST | `/v1/agents/{agentKey}/versions/{version}/validate` | Validate version |
| POST | `/v1/agents/{agentKey}/versions/{version}/publish` | Publish version |
| POST | `/v1/agents/{agentKey}/versions/{version}/promote` | Promote to active |
| POST | `/v1/agents/{agentKey}/versions/{version}/deprecate` | Deprecate version |
| POST | `/v1/agents/{agentKey}/versions/{version}/certify` | Certify version |
| POST | `/v1/agents/{agentKey}/versions/{version}/revoke` | Revoke version |
| POST | `/v1/agents/{agentKey}/versions/{version}/archive` | Archive version |
| POST | `/v1/agents/{agentKey}/versions/{version}/review` | Human review decision |

### Skills
| Method | Path | Description |
|---|---|---|
| GET | `/v1/skills` | List skills |
| GET | `/v1/skills/{skillKey}` | Get skill |
| POST | `/v1/skills` | Create skill (idempotent) |
| GET | `/v1/skills/{skillKey}/versions` | List skill versions |
| GET | `/v1/skills/{skillKey}/versions/{version}` | Get skill version |
| GET | `/v1/skills/{skillKey}/active` | Resolve active version |
| GET | `/v1/skills/{skillKey}/versions/{version}/publication-envelope` | Publication envelope |
| GET | `/v1/skills/{skillKey}/versions/{version}/verification` | Publication verification |
| GET | `/v1/skills/{skillKey}/versions/{version}/provenance` | PROV-O provenance (structured or `?format=jsonld`) |
| POST | `/v1/skills/{skillKey}/versions/{version}/provenance/signatures` | Attach a detached provenance signature |
| GET | `/v1/skills/{skillKey}/versions/{version}/report-signatures` | Validation-report signatures, re-verified on read |
| POST | `/v1/skills/{skillKey}/versions/{version}/report-signatures` | Attach a signature over a report's canonical RDF |
| POST | `/v1/skills/{skillKey}/drafts` | Create draft version |
| POST | `/v1/skills/{skillKey}/versions/{version}/signatures` | Attach detached signature |
| POST | `/v1/skills/{skillKey}/versions/{version}/validate` | Validate version |
| POST | `/v1/skills/{skillKey}/versions/{version}/publish` | Publish version |
| POST | `/v1/skills/{skillKey}/versions/{version}/promote` | Promote to active |
| POST | `/v1/skills/{skillKey}/versions/{version}/deprecate` | Deprecate version |
| POST | `/v1/skills/{skillKey}/versions/{version}/certify` | Certify version |
| POST | `/v1/skills/{skillKey}/versions/{version}/revoke` | Revoke version |
| POST | `/v1/skills/{skillKey}/versions/{version}/archive` | Archive version |
| POST | `/v1/skills/{skillKey}/versions/{version}/review` | Human review decision |

### Trust / transparency
| Method | Path | Description |
|---|---|---|
| GET | `/v1/public-keys` | List trusted public keys |
| GET | `/v1/public-keys/{keyRef}` | Get trusted public key |
| POST | `/v1/public-keys` | Register trusted public key |
| POST | `/v1/public-keys/{keyRef}/revoke` | Revoke trusted public key |
| GET | `/v1/transparency-logs` | List transparency logs |
| GET | `/v1/transparency-logs/{logId}` | Get transparency log |
| GET | `/v1/transparency-logs/{logId}/verification` | Log verification |
| GET | `/v1/transparency-logs/{logId}/timeline` | Log timeline |
| POST | `/v1/transparency-logs` | Create transparency log |
| POST | `/v1/transparency-logs/{logId}/witnesses` | Add witness |
| POST | `/v1/transparency-logs/{logId}/checkpoints` | Register checkpoint |
| POST | `/v1/transparency-logs/{logId}/observations` | Record observation |
| POST | `/v1/transparency-logs/reconcile` | Reconcile a publication against the native companion log |
| POST | `/v1/transparency-logs/{logId}/gossip-events` | Record gossip event |
| GET | `/v1/governance-log` | Internal governance Merkle log |
| GET | `/v1/governance-log/proofs/{leafIndex}` | Inclusion proof |
| GET | `/v1/governance-log/replay` | Verifier replay |

Publication verification responses include frozen-envelope fields:
`publication_envelope_artifact_present`,
`publication_envelope_artifact_sha256_matches`, and
`live_envelope_matches_frozen_artifact`. The envelope response exposes
`publication_envelope_artifact_urn` and `publication_envelope_sha256`; see
`docs/registry-model.md` for the freeze semantics.

### Provenance evidence

`GET .../versions/:v/provenance` returns the structured PROV view plus an
`evidence` block: `canonical_rdf_sha256` (SHA-256 over the RDFC-1.0
canonical N-Quads of the export) and `canonical_rdf_artifact_urn` (fetch the
canonical bytes via `GET /v1/artifacts/{sha256}`). `?format=jsonld` serves
the same triple list as a PROV-O JSON-LD document.

Detached signatures over the canonical export are attached at
`POST .../versions/:v/provenance/signatures` with
`{ signer, key_ref, algorithm, signature, provenance_sha256? }`:

- the key must resolve to a trusted, unexpired public key and the signature
  must verify over the **current** canonical export; an explicit
  `provenance_sha256` that is not current is rejected as stale
  (`..._PROVENANCE_SIGNATURE_STALE`) — re-fetch and re-sign;
- identical re-attach is idempotent; a different valid signature from the
  same key over the same digest returns `409 ..._CONFLICT`;
- reads re-verify every signature and return `provenance_signatures[]` rows
  with `verdict: "valid" | "invalid" | "stale"` (`stale` = verified over an
  earlier export that the trail has since outgrown; the signed export stays
  retrievable at its digest), plus `all_provenance_signatures_verified`
  (at least one signature, none invalid) and `current_provenance_signed`.

Validation report artifacts (linked via `sg:validatedBy`) carry an `rdf`
block: `format: "jsonld"`, a `sh:ValidationReport` document mapping each
layer and `sh:ValidationResult` 1:1 (SHACL result vocabulary; layer
metadata as `urn:sg:` literals), plus its own `canonical_rdf_sha256` and
canonical artifact (RDFC-1.0 over the same triple list).

Report signatures set `{ report_artifact_urn, signer, key_ref, algorithm,
signature }` at `POST .../versions/:v/report-signatures`: the target must
be one of the version's SHACL report artifacts, the key must be trusted
and unexpired, and the signature must verify over the report's canonical
N-Quads bytes (reports are immutable — verdicts are `valid`/`invalid`,
never stale). `GET .../report-signatures` returns
`report_signatures[]` rows re-verified on every read
(`report_artifact_present`, `canonical_artifact_present`,
`trusted_public_key_resolved`, `cryptographic_verification_passed`,
`verdict`); `registry-operator verify report-signatures [--strict]`
reproduces the verdicts locally.

### Policy / ontology / vocabulary

| Method | Path | Description |
|---|---|---|
| GET | `/v1/policy-packages` | List policy packages |
| GET | `/v1/policy-packages/{policyVersion}` | Get policy package |
| POST | `/v1/policy-packages` | Create policy package |
| GET | `/v1/ontology-packages` | List ontology packages |
| GET | `/v1/ontology-packages/{ontologyVersion}` | Get ontology package |
| POST | `/v1/ontology-packages` | Create ontology package |

Ontology packages come in two authoring formats:

- **Legacy JSON documents** (omit `ontology_format`): `{ kind:
  "registry_shape" | "skill_area", concepts: [{ id, label?, parents? }],
  disjoint: [[a, b]] }` — the kind lives inside the document.
- **Authored OWL Turtle** (`ontology_format: "owl-turtle"`, `ontology` is
  a Turtle string, `ontology_kind` required): a totally-projected subset —
  `owl:Class` concepts, `rdfs:subClassOf` between declared classes,
  `owl:disjointWith` (symmetric, normalized), `rdfs:label`, an optional
  `urn:sg:property:concept-id` override, and an `owl:Ontology` header.
  Concept ids default to class-IRI local names; ambiguous ids are refused.
  Registration rejects everything outside the subset (`owl:equivalentClass`,
  unions/intersections/complements/restrictions, `owl:imports`,
  `owl:AllDisjointClasses`, `skos:*`, external or blank-node superclasses)
  — a normative ontology is never silently narrowed.

Details include `ontology_format`, `canonical_rdf_sha256` (RDFC-1.0 digest
over the format-independent semantic projection — equivalent JSON and OWL
documents digest identically) and `canonical_rdf_artifact_urn` (fetch via
`GET /v1/artifacts/{sha256}`). De-facto promotion from authored OWL
ontologies is refused (v1).
| POST | `/v1/compile/skill` | Compile markdown/tool manifest to capability claims |
| GET | `/v1/de-facto-terms` | List de facto vocabulary candidates |
| POST | `/v1/de-facto-terms/{term}/review` | Review a de facto term |
| GET | `/v1/reviews/pending` | Pending human-review queue |

Policy packages come in two authoring formats, selected with
`shapes_format`:

- **Legacy JSON shape documents** (omit `shapes_format`): the historical
  format. Lifecycle gates (`require_human_review`, `require_validation`,
  `require_signature`, `require_trusted_publisher`,
  `require_build_provenance`, `require_sbom`) live inside the shapes
  document.
- **Authored W3C SHACL Turtle** (`shapes_format: "shacl-turtle"`, `shapes`
  is a Turtle string): shapes target entity types with `sh:targetClass`
  over `urn:sg:entity-type:` IRIs and use simple `urn:sg:property:` /
  `urn:sg:predicate:` paths; explicit node targeting and complex paths are
  rejected at registration, and `sh:pattern` is RE2-compiled up front
  (backreferences and lookarounds unsupported). Lifecycle gates are
  top-level request fields in this format.

Authored policies may additionally use SPARQL features, executed on the
`shacl-engine` hybrid adapter with its SPARQL plugin always loaded:

- **Node-shape `sh:sparql` constraints**: `sh:select` required;
  `sh:prefixes` must resolve to `sh:declare` blocks (`sh:prefix` +
  xsd:anyURI `sh:namespace`) in the document; `$this` binds the focus
  node, `?path`/`?value` results are carried into the report, and
  `{$this}`-style placeholders are interpolated in messages.
- **SPARQL-based targets**: `sh:target` must reference a node declaring
  `sh:select`; results are focus-filtered, so edge targets (for example
  version-to-version lineage targets sharing the entity type) are never
  validated incidentally.

Registration rejects: property-shape `sh:sparql` (the engine evaluates
those outside the W3C prebinding model — put the constraint on the node
shape and traverse in the query), `REGEX(` inside SPARQL (backtracking
XPath regex; the RE2-backed `sh:pattern` remains the regex path), and
`sh:rule` / `sh:function` / `sh:js` (not executed by the engine — a policy
is never accepted with features that would be silently ignored).
Validation report policy layers record the engine that ran them
(`rdf-validate-shacl@…` or `shacl-engine@…+sparql`).

Example (legacy JSON document, gates inside the document):

```json
{
  "policy_version": "strict/v1",
  "author": "pablo",
  "shapes": {
    "shapes": [
      {
        "id": "policy/description",
        "target": { "entity_type": "SKILL_VERSION" },
        "properties": [
          { "path": "description", "minCount": 1, "message": "description_required_by_policy" }
        ]
      }
    ],
    "require_validation": true
  }
}
```

Example (authored Turtle):

```json
{
  "policy_version": "demo-shacl/v1",
  "author": "demo",
  "shapes_format": "shacl-turtle",
  "require_validation": true,
  "shapes": "@prefix sh: <http://www.w3.org/ns/shacl#> .\n<urn:policy:description> a sh:NodeShape ;\n    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;\n    sh:property [ sh:path <urn:sg:property:description> ; sh:minCount 1 ; sh:message \"description_required_by_policy\" ] ."
}
```

Draft validation executes the built-in graph shape and the resolved policy
as W3C SHACL Core and stores a machine-readable report per run
(`validator: shacl-v1`, engine id, per-layer `shapes_format` /
`shapes_sha256`), linked to the version via `sg:validatedBy`; see
`docs/governance-model.md` for the validation rules.

### Artifacts
| Method | Path | Description |
|---|---|---|
| GET | `/v1/artifacts/{sha256}` | Fetch content-addressed artifact bytes |

`GET /v1/artifacts/{sha256}` returns the raw object bytes with
`Content-Digest` (RFC 9530, `sha-256=:...:`) and
`x-artifact-digest-verified: true`. HEAD returns the same headers with no body.
A stored object that fails its digest verification is never transported: the
endpoint answers `409 ARTIFACT_DIGEST_MISMATCH` instead (independent of the
CAS `warn`/`enforce` mode). Unknown digests return `404`, malformed digests
`400`. Bytes and metadata stay separate planes; this endpoint is transport
only.

### Attestations
| Method | Path | Description |
|---|---|---|
| POST | `/v1/attestations` | Attach a verified DSSE/in-toto attestation to a publication |
| GET | `/v1/skills/{skillKey}/versions/{version}/attestations` | List skill publication attestations |
| GET | `/v1/agents/{agentKey}/versions/{version}/attestations` | List agent publication attestations |

`POST /v1/attestations` ingests a **DSSE envelope** whose payload is a JSON
in-toto statement (SLSA provenance, SPDX/CycloneDX SBOM, scan results). The
signature is verified over the DSSE PAE bytes against a **trusted registry
key** (`key_ref`), the statement `predicateType` is recorded, and — when the
statement declares subjects — at least one `sha256` subject digest must match
an artifact of the publication. Only verified evidence is stored, as a CAS
artifact linked `sg:attestedBy`, and it is folded into the publication
verification payload (`attestations`,
`all_attestation_signatures_valid`). Rejections: `404` unknown publication;
`409` `ATTESTATION_TRUSTED_KEY_NOT_FOUND`, `ATTESTATION_SIGNATURE_INVALID`,
`ATTESTATION_PAYLOAD_INVALID`, `ATTESTATION_PREDICATE_TYPE_REQUIRED`,
`ATTESTATION_SUBJECT_MISMATCH`, `ATTESTATION_CONFLICT`.

### Time-aware / graph
| Method | Path | Description |
|---|---|---|
| GET | `/v1/time-aware/commits` | List commits |
| GET | `/v1/time-aware/commits/{commitId}` | Get commit |
| GET | `/v1/time-aware/refs` | List refs |
| GET | `/v1/time-aware/refs/{refName}` | Get ref |
| GET | `/v1/time-aware/tags` | List tags |
| GET | `/v1/time-aware/tags/{tagName}` | Get tag |
| GET | `/v1/time-aware/workspaces` | List workspaces |
| GET | `/v1/time-aware/workspaces/{workspaceId}` | Get workspace |
| GET | `/v1/time-aware/manifests` | List artifact manifests |
| GET | `/v1/time-aware/retention-roots` | List retention roots |
| GET | `/v1/time-aware/retention-roots/{rootId}/analysis` | Retention analysis |
| GET | `/v1/time-aware/retention-roots/{rootId}/gc-plan` | GC plan preview |
| GET | `/v1/time-aware/gc-jobs` | List GC jobs |
| POST | `/v1/time-aware/gc-jobs` | Create GC job |
| POST | `/v1/time-aware/gc-jobs/{jobId}/execute` | Execute GC job |
| POST | `/v1/time-aware/refs/{refName}/workspaces/{workspaceId}/draft` | Create draft workspace |
| GET | `/v1/graph/subgraph` | Read graph subgraph |

## Error model

Errors use a stable machine-readable shape:

```json
{
  "error": {
    "code": "SKILL_NOT_FOUND",
    "message": "Skill not found."
  }
}
```

Common codes:
- `VALIDATION_ERROR` — request failed schema validation (400)
- `AUTH_UNAUTHENTICATED` — missing/invalid bearer token (401)
- `AUTH_FORBIDDEN` — authenticated but not allowed (403)
- `*_NOT_FOUND` — entity not found (404)
- `*_CONFLICT` — conflicting state (409)
- `INTERNAL_ERROR` — unexpected failure (500)

## API-key management (self-serve)

Admin-only and Okta-authenticated — API keys cannot manage API keys.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/api-keys` | Mint a key (secret returned once) |
| `GET` | `/v1/api-keys` | List key metadata (never the secret) |
| `POST` | `/v1/api-keys/{keyId}/rotate` | Issue a new secret for an existing key |
| `DELETE` | `/v1/api-keys/{keyId}` | Revoke a key |

Create body: `{ owner_label, scopes?: ["read"|"write"|"lifecycle"|<area>:write], ttl_days? }`.
Default scope is `read`; default TTL is `API_KEY_DEFAULT_TTL_DAYS`. Secrets are
stored only as `scrypt` hashes with a random per-key salt and the
`API_KEY_PEPPER` mixed into the salt material (the pepper is required in
production); legacy pepper-salted hashes are verified and upgraded in place on
their first successful use. The plaintext token (`agk_<key_id>_<secret>`) is
returned once.

**Write scopes** are fine-grained per area: `skills:write`, `agents:write`,
`advisories:write`, `attestations:write`, `public-keys:write`,
`transparency-logs:write`, `time-aware:write`, `ontologies:write`,
`policies:write`. A write requires the scope for
its area; the legacy coarse scopes `write`/`lifecycle` (and keys stored
without any scopes) grant full write access. Reads are not scope-gated.

Enforcement is controlled by `SCOPE_ENFORCEMENT`: `enforce` (default) rejects
writes from keys missing the required scope with `403 INSUFFICIENT_SCOPE`;
`warn` records a `scope_warning` auth event and allows the request (compat
mode for migration windows).

## Lifecycle states

Versions move through: `draft → validated → published → certified`, with
`rejected`, `deprecated`, `revoked`, and `archived` as terminal/alternate
states. Certification is bound to concrete policy and ontology versions.

## Related

- `service/api/README.md` — operator guide and local setup
- `client/registry-sdk/README.md` — typed SDK usage
- `docs/governance-model.md` — governance and trust model
