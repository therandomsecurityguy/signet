/**
 * Built-in graph shape as authored W3C SHACL Turtle.
 *
 * Structural rules every publishable version must satisfy before policy
 * validation runs. Executed through the authored-Turtle validation path
 * (`validatePublicationGraphWithTurtleShapes`); the legacy JSON
 * representation (`BUILTIN_GRAPH_SHAPE_DOCUMENT` in shacl-like-validator)
 * is retained as the parity-test reference — a drift guard asserts both
 * forms produce identical violations.
 *
 * Predicate IRIs use the registry's canonical encoding
 * (`sg:implementedBy` -> `urn:sg:predicate:sg-implementedBy`); see
 * sg-vocabulary.ts.
 */

import { createHash } from 'node:crypto';

export const BUILTIN_GRAPH_SHAPE_TURTLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<urn:sg:shape:registry-graph-shape/skill-version> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:property [
        sh:path <urn:sg:property:artifact_sha256> ;
        sh:minCount 1 ;
        sh:message "missing_artifact_evidence" ;
    ] ;
    sh:property [
        sh:path <urn:sg:property:source_path> ;
        sh:minCount 1 ;
        sh:message "missing_source_path_evidence" ;
    ] ;
    sh:property [
        sh:path <urn:sg:property:version> ;
        sh:minCount 1 ;
        sh:datatype xsd:integer ;
        sh:message "invalid_version_number" ;
    ] ;
    sh:property [
        sh:path <urn:sg:predicate:sg-implementedBy> ;
        sh:minCount 1 ;
        sh:class <urn:sg:entity-type:ARTIFACT> ;
        sh:message "missing_implementation_edge" ;
    ] .

<urn:sg:shape:registry-graph-shape/agent-version> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:AGENT_VERSION> ;
    sh:property [
        sh:path <urn:sg:property:artifact_sha256> ;
        sh:minCount 1 ;
        sh:message "missing_artifact_evidence" ;
    ] ;
    sh:property [
        sh:path <urn:sg:property:source_path> ;
        sh:minCount 1 ;
        sh:message "missing_source_path_evidence" ;
    ] ;
    sh:property [
        sh:path <urn:sg:property:version> ;
        sh:minCount 1 ;
        sh:datatype xsd:integer ;
        sh:message "invalid_version_number" ;
    ] ;
    sh:property [
        sh:path <urn:sg:predicate:sg-definedBy> ;
        sh:minCount 1 ;
        sh:class <urn:sg:entity-type:ARTIFACT> ;
        sh:message "missing_definition_edge" ;
    ] .
`;

/** Content digest of the built-in shapes source, recorded in validation reports. */
export const BUILTIN_GRAPH_SHAPE_SHA256 = createHash('sha256')
  .update(Buffer.from(BUILTIN_GRAPH_SHAPE_TURTLE, 'utf8'))
  .digest('hex');
