"""SHACL-AF runtime sidecar tests.

Runs the real pyshacl engine against the spike-derived fixture: rules feeding
constraints (both TripleRule and SPARQLRule), a custom SPARQL-based constraint
component with parameter interpolation, and a SPARQL function — plus the
service contract (auth, limits, structured errors, determinism, timeout).
"""

from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.request

import pytest

import server as server_module
from server import Config, create_server

AF_SHAPES = """
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <urn:example:> .

ex:onto a <http://www.w3.org/2002/07/owl#Ontology> ;
    sh:declare [ sh:prefix "ex" ; sh:namespace "urn:example:"^^xsd:anyURI ] .

<urn:sg:shape:demo> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:rule [
        a sh:TripleRule ;
        sh:subject sh:this ;
        sh:predicate <urn:sg:property:derived_constant> ;
        sh:object ex:constant ;
    ] ;
    sh:rule [
        a sh:SPARQLRule ;
        sh:construct \"\"\"
            CONSTRUCT { $this <urn:sg:property:review_flag> "needs-review" } WHERE {
                $this <urn:sg:property:description> ?value .
                FILTER(CONTAINS(STR(?value), "TODO"))
            }
        \"\"\" ;
        sh:prefixes ex:onto ;
    ] ;
    sh:property [
        sh:path <urn:sg:property:derived_constant> ;
        sh:minCount 1 ;
        sh:message "rule-derived constant must be present" ;
    ] ;
    sh:property [
        sh:path <urn:sg:property:description> ;
        <urn:example:af#startsWith> ex:ok ;
    ] ;
    # NOTE: no shape-level sh:message here on purpose — pyshacl lets a shape
    # message override the validator's, and this fixture proves the
    # validator's own {$param}-interpolated message surfaces.
    sh:property [
        sh:path <urn:sg:property:review_flag> ;
        sh:maxCount 0 ;
        sh:message "review_flag must NOT exist" ;
    ] ;
    sh:sparql [
        sh:message "function smoke" ;
        sh:select \"\"\"
            SELECT $this WHERE {
                $this <urn:sg:property:description> ?value .
                FILTER(ex:double(2) != 4)
            }
        \"\"\" ;
        sh:prefixes ex:onto ;
    ] .

ex:StartsWithComponent a sh:ConstraintComponent ;
    sh:parameter [ sh:path <urn:example:af#startsWith> ] ;
    sh:propertyValidator ex:startsWithValidator .
ex:startsWithValidator a sh:SPARQLSelectValidator ;
    sh:message "value must start with {$startsWith}" ;
    sh:select \"\"\"
        SELECT $this ?value WHERE {
            $this $PATH ?value .
            FILTER(!STRSTARTS(STR(?value), STR($startsWith)))
        }
    \"\"\" .

ex:double a sh:SPARQLFunction ;
    sh:parameter [ sh:path <urn:example:fn#arg> ] ;
    sh:returnType xsd:integer ;
    sh:select \"\"\"
        SELECT (2 * $arg AS ?result) WHERE {}
    \"\"\" .
"""

TODO_DATA = """
<urn:sg:skill-version:demo@v1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <urn:sg:entity-type:SKILL_VERSION> .
<urn:sg:skill-version:demo@v1> <urn:sg:property:description> "has TODO inside" .
"""

CLEAN_DATA = """
<urn:sg:skill-version:demo@v1> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <urn:sg:entity-type:SKILL_VERSION> .
<urn:sg:skill-version:demo@v1> <urn:sg:property:description> "urn:example:ok clean" .
"""

CORE_SHAPES = """
@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:sg:shape:core> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:property [ sh:path <urn:sg:property:license> ; sh:minCount 1 ; sh:message "license missing" ] .
"""

CARTESIAN_RULE_SHAPES = """
@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:sg:shape:heavy> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:rule [
        a sh:SPARQLRule ;
        sh:construct \"\"\"
            CONSTRUCT { ?a <urn:sg:property:pair> ?b } WHERE {
                ?this <urn:sg:property:tags> ?a .
                ?this <urn:sg:property:tags> ?b .
            }
        \"\"\" ;
    ] .
"""


def _tag_triples(count: int) -> str:
    return "".join(
        f'<urn:sg:skill-version:demo@v1> <urn:sg:property:tags> "tag-{index}" .\n' for index in range(count)
    )


@pytest.fixture()
def service(request):
    overrides = getattr(request, "param", {})
    config = Config.from_env(
        {
            "SHACL_RUNTIME_TOKEN": overrides.get("token", ""),
            "VALIDATE_TIMEOUT_SECONDS": str(overrides.get("timeout", 30)),
            "REQUEST_TIMEOUT_SECONDS": str(overrides.get("request_timeout", 15)),
            "MAX_BODY_BYTES": str(overrides.get("max_body", 2_000_000)),
            "MAX_CONCURRENCY": str(overrides.get("max_concurrency", 4)),
            "QUEUE_LIMIT": str(overrides.get("queue_limit", 32)),
            "MAX_MEMORY_MB": str(overrides.get("memory", 1024)),
            "MAX_CPU_SECONDS": str(overrides.get("cpu", 300)),
            "MAX_NOFILE": str(overrides.get("nofile", 64)),
        }
    )
    server = create_server(config, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    yield base_url, config
    server.shutdown()
    server.server_close()


def call(base_url: str, path: str, *, body: dict | None = None, token: str | None = None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(base_url + path, data=data, method="POST" if data else "GET")
    if data is not None:
        request.add_header("content-type", "application/json")
    if token is not None:
        request.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read().decode("utf-8"))


def validate(base_url: str, data: str, shapes: str, token: str | None = None):
    return call(base_url, "/v1/validate", body={"data_nquads": data, "shapes_turtle": shapes}, token=token)


def test_healthz(service):
    status, body = call(service[0], "/healthz")
    assert status == 200
    assert body["ok"] is True
    assert body["engine"].startswith("pyshacl@")
    assert body["workers"]["size"] == service[1].max_concurrency
    assert body["workers"]["killed"] == 0
    assert body["workers"]["aborted"] == 0


def test_core_validation(service):
    status, body = validate(service[0], TODO_DATA, CORE_SHAPES)
    assert status == 200
    assert body["conforms"] is False
    assert body["results"] == [
        {
            "focusNode": "urn:sg:skill-version:demo@v1",
            "path": "urn:sg:property:license",
            "sourceConstraintComponent": "http://www.w3.org/ns/shacl#MinCountConstraintComponent",
            "severity": "http://www.w3.org/ns/shacl#Violation",
            "message": "license missing",
            "value": None,
        }
    ]


def test_advanced_rules_and_components_and_functions(service):
    status, body = validate(service[0], TODO_DATA, AF_SHAPES)
    assert status == 200
    assert body["conforms"] is False
    components = [row["sourceConstraintComponent"] for row in body["results"]]
    # The TripleRule-derived constant satisfied its minCount (no violation),
    # the SPARQLRule-derived review_flag tripped maxCount 0 (proving
    # inference feeds validation), the custom component fired with its
    # authored IRI, and the function smoke constraint produced nothing
    # (ex:double applied).
    assert components.count("http://www.w3.org/ns/shacl#MaxCountConstraintComponent") == 1
    assert components.count("urn:example:StartsWithComponent") == 1
    assert "function smoke" not in [row["message"] for row in body["results"]]

    flag_row = next(row for row in body["results"] if row["path"] == "urn:sg:property:review_flag")
    assert flag_row["message"] == "review_flag must NOT exist"

    custom_row = next(row for row in body["results"] if row["sourceConstraintComponent"] == "urn:example:StartsWithComponent")
    assert custom_row["value"] == "has TODO inside"
    assert custom_row["message"] == "value must start with urn:example:ok"

    clean_status, clean_body = validate(service[0], CLEAN_DATA, AF_SHAPES)
    assert clean_status == 200
    assert clean_body["conforms"] is True
    assert clean_body["results"] == []


def test_deterministic_results(service):
    _, first = validate(service[0], TODO_DATA, AF_SHAPES)
    _, second = validate(service[0], TODO_DATA, AF_SHAPES)
    assert first["results"] == second["results"]


@pytest.mark.parametrize("service", [{"token": "s3cret"}], indirect=True)
def test_auth_required_when_token_set(service):
    status, body = validate(service[0], TODO_DATA, CORE_SHAPES)
    assert status == 401
    assert body["error"]["code"] == "AUTH_UNAUTHORIZED"

    status, body = validate(service[0], TODO_DATA, CORE_SHAPES, token="s3cret")
    assert status == 200


def test_parse_errors_are_structured(service):
    status, body = validate(service[0], TODO_DATA, "not turtle")
    assert status == 400
    assert body["error"]["code"] == "SHAPES_PARSE_ERROR"

    status, body = validate(service[0], "not nquads", CORE_SHAPES)
    assert status == 400
    assert body["error"]["code"] == "DATA_PARSE_ERROR"

    status, body = call(service[0], "/v1/validate", body={"data_nquads": 1, "shapes_turtle": "x"})
    assert status == 400
    assert body["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize("service", [{"max_body": 64}], indirect=True)
def test_payload_limits(service):
    status, body = validate(service[0], TODO_DATA, CORE_SHAPES)
    assert status == 413
    assert body["error"]["code"] == "PAYLOAD_TOO_LARGE"


@pytest.mark.parametrize("service", [{"timeout": 0.25}], indirect=True)
def test_validation_timeout_hard_kills_worker(service):
    status, body = validate(service[0], TODO_DATA + _tag_triples(300), CARTESIAN_RULE_SHAPES)
    assert status == 504
    assert body["error"]["code"] == "VALIDATION_TIMEOUT"

    # Hard cancellation, not abandonment: the worker was killed (accounted in
    # /healthz) and the pool recycles — capacity is usable immediately, with a
    # fresh worker that completes a normal validation.
    workers = call(service[0], "/healthz")[1]["workers"]
    assert workers["killed"] >= 1
    status, body = validate(service[0], TODO_DATA, CORE_SHAPES)
    assert status == 200
    assert body["conforms"] is False


RULE_SERVICE_SHAPES = """
@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:sg:shape:ssrf> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:rule [
        a sh:SPARQLRule ;
        sh:construct \"\"\"
            CONSTRUCT { ?this <urn:sg:property:x> ?o } WHERE {
                SERVICE <http://169.254.169.254/latest/meta-data/> { ?s ?p ?o }
            }
        \"\"\" ;
    ] .
"""


def test_federated_queries_are_rejected(service):
    # pyshacl blocks SERVICE in sh:sparql constraints but EXECUTES it from
    # sh:SPARQLRule constructs; the runtime rejects it everywhere.
    status, body = validate(service[0], TODO_DATA, RULE_SERVICE_SHAPES)
    assert status == 400
    assert body["error"]["code"] == "FEDERATED_QUERY_REJECTED"

    constraint_service = """
@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:sg:shape:svc> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:sparql [
        sh:select "SELECT $this WHERE { SERVICE <http://127.0.0.1:9/> { ?s ?p ?o } }" ;
    ] .
"""
    status, body = validate(service[0], TODO_DATA, constraint_service)
    assert status == 400
    assert body["error"]["code"] == "FEDERATED_QUERY_REJECTED"

    # Evasion attempt: a '#' inside a string literal would defeat a
    # comment-stripping-only scan; the dual scan still catches it.
    evasion = """
@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:sg:shape:evade> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:sparql [
        sh:select "SELECT $this WHERE { FILTER(STRSTARTS(\\"x#y\\", \\"x\\")) SERVICE <http://127.0.0.1:9/> { ?s ?p ?o } }" ;
    ] .
"""
    status, body = validate(service[0], TODO_DATA, evasion)
    assert status == 400
    assert body["error"]["code"] == "FEDERATED_QUERY_REJECTED"

    # Benign mentions outside SPARQL-bearing literals are not scanned.
    benign = """
@prefix sh: <http://www.w3.org/ns/shacl#> .
<urn:sg:shape:benign> a sh:NodeShape ;
    sh:targetClass <urn:sg:entity-type:SKILL_VERSION> ;
    sh:property [ sh:path <urn:sg:property:license> ; sh:minCount 1 ; sh:message "run a service check" ] .
"""
    status, body = validate(service[0], TODO_DATA, benign)
    assert status == 200
    assert body["results"][0]["message"] == "run a service check"


@pytest.mark.parametrize("service", [{"max_concurrency": 1, "queue_limit": 0}], indirect=True)
def test_busy_when_at_capacity(service, monkeypatch):
    started = threading.Event()
    release = threading.Event()

    def fake_run_validation(self, data: str, shapes: str):  # noqa: ARG001 - contract stub
        started.set()
        release.wait(10)
        return True, []

    monkeypatch.setattr(server_module.WorkerPool, "run_validation", fake_run_validation)
    base_url = service[0]
    outcome: dict[str, tuple[int, dict]] = {}

    worker = threading.Thread(target=lambda: outcome.setdefault("first", validate(base_url, TODO_DATA, CORE_SHAPES)))
    worker.start()
    assert started.wait(5), "the first validation should occupy the only slot"

    status, body = validate(base_url, TODO_DATA, CORE_SHAPES)
    assert status == 503
    assert body["error"]["code"] == "SHACL_RUNTIME_BUSY"

    release.set()
    worker.join(10)
    assert outcome["first"][0] == 200


@pytest.mark.skipif(sys.platform != "linux", reason="RLIMIT_AS is only enforced on Linux")
@pytest.mark.parametrize("service", [{"memory": 128}], indirect=True)
def test_memory_limit_fails_closed_and_recycles_worker(service):
    # Baseline python:3.15 + pyshacl is ~54MB VmSize; 600 tags with the
    # cartesian rule need hundreds of MB, so the 128MB cap trips well before
    # the (default) timeout while the follow-up tiny validation still fits.
    status, body = validate(service[0], TODO_DATA + _tag_triples(600), CARTESIAN_RULE_SHAPES)
    assert status in {500, 507}
    assert body["error"]["code"] in {"RESOURCE_LIMIT", "VALIDATION_ABORTED"}

    # The service stays healthy and the pool recycles to a fresh worker.
    workers = call(service[0], "/healthz")[1]["workers"]
    assert workers["size"] == service[1].max_concurrency
    status, body = validate(service[0], TODO_DATA, CORE_SHAPES)
    assert status == 200
    assert body["conforms"] is False
