## Fuseki Query Pack

This is a copy-paste SPARQL query pack for inspecting the live `registry` dataset in local Fuseki.

Open:

```text
http://localhost:3030
```

Use dataset:

```text
registry
```

## Important note about the current graph shape

The current graph adapter stores:
- node type under `urn:sg:meta:entityType`
- node properties as a JSON literal under `urn:sg:meta:properties`
- edges as separate edge nodes with:
  - `urn:sg:meta:from`
  - `urn:sg:meta:to`
  - `urn:sg:meta:predicate`
  - edge properties as JSON

So these queries are great for inspection, but they are intentionally a little more mechanical than a hand-authored ontology would be.

## Shared prefixes

```sparql
PREFIX sgmeta: <urn:sg:meta:>
```

## 1. Count nodes by entity type

```sparql
PREFIX sgmeta: <urn:sg:meta:>

SELECT ?entity_type (COUNT(?urn) AS ?count)
WHERE {
  ?urn sgmeta:entityType ?entity_type .
}
GROUP BY ?entity_type
ORDER BY ?entity_type
```

## 2. List all agents

```sparql
PREFIX sgmeta: <urn:sg:meta:>

SELECT ?urn ?props
WHERE {
  ?urn sgmeta:entityType "AGENT" ;
       sgmeta:properties ?props .
}
ORDER BY STR(?urn)
```

## 3. List all skills

```sparql
PREFIX sgmeta: <urn:sg:meta:>

SELECT ?urn ?props
WHERE {
  ?urn sgmeta:entityType "SKILL" ;
       sgmeta:properties ?props .
}
ORDER BY STR(?urn)
```

## 4. List all skill versions

```sparql
PREFIX sgmeta: <urn:sg:meta:>

SELECT ?urn ?props
WHERE {
  ?urn sgmeta:entityType "SKILL_VERSION" ;
       sgmeta:properties ?props .
}
ORDER BY STR(?urn)
```

## 5. List all artifact nodes

```sparql
PREFIX sgmeta: <urn:sg:meta:>

SELECT ?urn ?props
WHERE {
  ?urn sgmeta:entityType "ARTIFACT" ;
       sgmeta:properties ?props .
}
ORDER BY STR(?urn)
```

## 6. List all relationship edges

```sparql
PREFIX sgmeta: <urn:sg:meta:>

SELECT ?edge ?from ?to ?predicate ?props
WHERE {
  ?edge sgmeta:from ?from ;
        sgmeta:to ?to ;
        sgmeta:predicate ?predicate ;
        sgmeta:properties ?props .
}
ORDER BY STR(?from) STR(?predicate) STR(?to)
```

## 7. List only artifact-linking edges

This shows both:
- `sg:implementedBy`
- `sg:definedBy`

```sparql
PREFIX sgmeta: <urn:sg:meta:>

SELECT ?from ?predicate ?to
WHERE {
  ?edge sgmeta:from ?from ;
        sgmeta:to ?to ;
        sgmeta:predicate ?predicate .
  FILTER (?predicate IN ("sg:implementedBy", "sg:definedBy"))
}
ORDER BY STR(?from) STR(?to)
```

## 8. Trace the demo agent to its linked skill and artifact nodes

```sparql
PREFIX sgmeta: <urn:sg:meta:>

SELECT ?predicate ?to ?to_type ?to_props
WHERE {
  BIND(<urn:sg:agent:cursor:registry-agent> AS ?agent)
  ?edge sgmeta:from ?agent ;
        sgmeta:to ?to ;
        sgmeta:predicate ?predicate .
  ?to sgmeta:entityType ?to_type ;
      sgmeta:properties ?to_props .
}
ORDER BY STR(?predicate) STR(?to)
```

## 9. Trace the `tame-llama` logical skill to its versions

```sparql
PREFIX sgmeta: <urn:sg:meta:>

SELECT ?version ?version_props
WHERE {
  BIND(<urn:sg:skill:skill:tame-llama> AS ?skill)
  ?edge sgmeta:from ?skill ;
        sgmeta:to ?version ;
        sgmeta:predicate "sg:hasVersion" .
  ?version sgmeta:entityType "SKILL_VERSION" ;
           sgmeta:properties ?version_props .
}
ORDER BY STR(?version)
```

## 10. Trace the active `tame-llama` version to its artifact

This uses the current JSON-property style and looks for `"active":true` in the version property blob.

```sparql
PREFIX sgmeta: <urn:sg:meta:>

SELECT ?version ?version_props ?artifact ?artifact_props
WHERE {
  BIND(<urn:sg:skill:skill:tame-llama> AS ?skill)

  ?has_version_edge sgmeta:from ?skill ;
                    sgmeta:to ?version ;
                    sgmeta:predicate "sg:hasVersion" .

  ?version sgmeta:entityType "SKILL_VERSION" ;
           sgmeta:properties ?version_props .

  FILTER(CONTAINS(STR(?version_props), "\"active\":true"))

  ?implemented_by_edge sgmeta:from ?version ;
                       sgmeta:to ?artifact ;
                       sgmeta:predicate "sg:implementedBy" .

  ?artifact sgmeta:entityType "ARTIFACT" ;
            sgmeta:properties ?artifact_props .
}
```

## 11. Show all demo artifacts with original paths

This is handy when matching graph metadata to files under `data/registry/objects/`.

```sparql
PREFIX sgmeta: <urn:sg:meta:>

SELECT ?artifact ?artifact_props
WHERE {
  ?artifact sgmeta:entityType "ARTIFACT" ;
            sgmeta:properties ?artifact_props .

  FILTER(
    CONTAINS(STR(?artifact_props), "client/registry-cli/examples/demo/")
  )
}
ORDER BY STR(?artifact)
```

## 12. Show only the blessed demo entities

```sparql
PREFIX sgmeta: <urn:sg:meta:>

SELECT ?urn ?entity_type ?props
WHERE {
  ?urn sgmeta:entityType ?entity_type ;
       sgmeta:properties ?props .

  FILTER(
    CONTAINS(STR(?urn), "cursor:registry-agent") ||
    CONTAINS(STR(?urn), "skill:registry-mcp") ||
    CONTAINS(STR(?urn), "skill:tame-llama")
  )
}
ORDER BY STR(?urn)
```

## Quick mental model

This query pack applies when the optional Fuseki/SPARQL lane is active. The default local metadata backend is the persistent `json_file` graph state; Fuseki is the opt-in inspection and live-validation backend.

For the SPARQL lane:
- Fuseki stores metadata and relationships
- the artifact store holds raw bytes
- the graph points to artifacts by `artifact_urn` and `sha256`

That means:
- inspect meaning in Fuseki
- inspect bytes in `data/registry/objects/` or later in S3
