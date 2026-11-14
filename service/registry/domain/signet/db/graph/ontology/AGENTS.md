# Ontology packages

This directory holds example normative ontology documents for the
registry's dual ontology system:

- `registry-shape.ontology.json` — governs lifecycle, publication,
  evidence, and certification vocabulary (`kind: registry_shape`)
- `skill-area-example.ontology.json` — domain capability concepts that
  skill/agent `capability_claims` bind to, plus prohibited (disjoint)
  combinations (`kind: skill_area`)

Document format:

```json
{
  "kind": "registry_shape | skill_area",
  "concepts": [{ "id": "concept-id", "label": "...", "parents": ["parent-id"] }],
  "disjoint": [["concept-a", "concept-b"]]
}
```

Rules:
- ontology authoring stays externalized to VocBench / Semantic Turkey;
  these files are importable examples, not an authoring surface
- packages are registered as versioned CAS artifacts via
  `POST /v1/ontology-packages` and resolved by `ontology_version`
- only `skill_area` packages are executed against capability claims at
  validation time; `registry_shape` packages are governance evidence
- claims that bind to no known concept fail validation and are recorded
  as de facto vocabulary candidates in the validation report
- de facto mining and promotion workflows remain future work

Use `service/registry/domain/signet/entity` and
`service/registry/domain/signet/relation` for the code-level graph
vocabulary.
