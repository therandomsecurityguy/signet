# Policy templates

Ready-to-register starting points for the most common policies, authored as
W3C SHACL Turtle (the `shapes_format: "shacl-turtle"` policy package format).
Copy one, adjust the `sh:message` texts and constraints to your wording, and
register it — no policy has to start from a blank file.

| Template | Kind | Gate fields to pass at registration |
|---|---|---|
| `description-required.ttl` | validation shape | (none; `require_validation: true` optional) |
| `human-review-required.ttl` | gate policy | `require_human_review: true` |
| `sbom-required.ttl` | gate policy | `require_sbom: true` |
| `trusted-publisher.ttl` | gate policy | `require_trusted_publisher: true` |

## Registering

The shapes document travels as a string; the lifecycle gates are top-level
fields of the same request (gates are intentionally *not* expressible inside
the Turtle — a governance gate must never depend on the shape parser reading
it):

```bash
jq -n --rawfile shapes docs/policy-templates/description-required.ttl '{
  policy_version: "policy/description-required/v1",
  author: "<you>",
  shapes_format: "shacl-turtle",
  description: "Every skill version must carry a description.",
  shapes: $shapes,
  require_validation: true
}' | curl -sS -X POST "$API/v1/policy-packages" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data-binary @-
```

Then bind the package to a version (`policy_version` on the draft) and run
`validate` — violations surface in the standard validation report with the
template's `sh:message` texts.

## Conventions the registration validates

- `sh:targetClass` over `urn:sg:entity-type:SKILL_VERSION` /
  `urn:sg:entity-type:AGENT_VERSION`,
- simple property paths (`urn:sg:property:<name>` / `urn:sg:predicate:<name>`),
- `sh:pattern` values are executed by the registry's linear-time RE2 engine
  (no backtracking constructs),
- lifecycle gates live on the package, not in the shapes.

The e2e test `service/api/tests/unit/policy-templates.test.ts` registers
every file in this directory and exercises `description-required.ttl`
end to end, so these templates stay valid as the engine evolves.
