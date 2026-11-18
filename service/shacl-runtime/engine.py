#!/usr/bin/env python3
"""SHACL-AF validation engine (runs inside worker subprocesses only).

Pure validation core shared by the worker entrypoint: parse, guard against
federated queries, execute pyshacl with advanced=True, and project results
deterministically. This module must never be imported by the HTTP layer for
in-process execution — the server runs the engine exclusively in rlimit-bounded
worker subprocesses (see worker.py / server.py).
"""

from __future__ import annotations

import json
import re
from typing import Any

import pyshacl
from rdflib import Graph, URIRef
from rdflib.namespace import SH

ENGINE_ID = f"pyshacl@{pyshacl.__version__}"


class ValidationFailureError(Exception):
    """pyshacl reported a SHACL spec-level failure (not non-conformance)."""


class PayloadError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _sort_key(row: dict[str, Any]) -> str:
    return json.dumps(
        [
            row.get("focusNode") or "",
            row.get("path") or "",
            row.get("sourceConstraintComponent") or "",
            row.get("message") or "",
            row.get("value") or "",
        ]
    )


def _first_message(report: Graph, result: Any) -> str | None:
    messages = [str(obj) for obj in report.objects(result, SH.resultMessage)]
    if not messages:
        return None
    # rdflib iteration order is not guaranteed; pick deterministically.
    return sorted(messages)[0]


def _extract_results(report: Graph) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for result in report.objects(None, SH.result):
        focus = report.value(result, SH.focusNode)
        path = report.value(result, SH.resultPath)
        component = report.value(result, SH.sourceConstraintComponent)
        severity = report.value(result, SH.resultSeverity)
        value = report.value(result, SH.value)
        rows.append(
            {
                "focusNode": str(focus) if focus is not None else "",
                "path": str(path) if isinstance(path, URIRef) else None,
                "sourceConstraintComponent": str(component) if component is not None else "",
                "severity": str(severity) if severity is not None else "",
                "message": _first_message(report, result),
                "value": str(value) if value is not None else None,
            }
        )
    rows.sort(key=_sort_key)
    return rows


SPARQL_QUERY_PREDICATES = (SH.select, SH.construct, SH.ask, SH.update)


def reject_federated_queries(shapes_graph: Graph) -> None:
    """SSRF guard.

    pyshacl blocks SERVICE in sh:sparql constraints but EXECUTES it from
    sh:SPARQLRule constructs (probe-proven: an outbound connection is made).
    The runtime must never perform outbound requests, so every
    SPARQL-bearing literal (select/construct/ask/update — covering
    constraints, targets, rules, functions, and validators) is scanned for
    the SERVICE keyword before execution.

    The scan runs on BOTH the raw text and a comment-stripped variant: the
    stripper alone can be evaded with a '#' inside a string literal on the
    same line, and the raw scan alone would reject innocuous comment
    mentions. Over-rejection fails closed, which is acceptable here.
    """
    for predicate in SPARQL_QUERY_PREDICATES:
        for literal in shapes_graph.objects(None, predicate):
            text = str(literal)
            without_comments = re.sub(r"#[^\n]*", "", text)
            if re.search(r"(?i)\bservice\b", text) or re.search(r"(?i)\bservice\b", without_comments):
                raise PayloadError(
                    "FEDERATED_QUERY_REJECTED",
                    "SPARQL SERVICE (federated queries) is not supported: the runtime must never perform outbound requests.",
                )


def validate_payload(data_nquads: str, shapes_turtle: str) -> tuple[bool, list[dict[str, Any]]]:
    try:
        shapes_graph = Graph().parse(data=shapes_turtle, format="turtle")
    except Exception as err:  # noqa: BLE001 - surfaced as a structured 400
        raise PayloadError("SHAPES_PARSE_ERROR", f"Shapes Turtle failed to parse: {err}") from err
    reject_federated_queries(shapes_graph)
    try:
        data_graph = Graph().parse(data=data_nquads, format="nquads")
    except Exception as err:  # noqa: BLE001 - surfaced as a structured 400
        raise PayloadError("DATA_PARSE_ERROR", f"Data N-Quads failed to parse: {err}") from err

    conforms, report, _ = pyshacl.validate(
        data_graph=data_graph,
        shacl_graph=shapes_graph,
        # EXPLICIT: without advanced=True pyshacl skips rules and functions.
        advanced=True,
    )
    if type(report).__name__ == "ValidationFailure":
        raise ValidationFailureError(str(report))
    return bool(conforms), _extract_results(report)
