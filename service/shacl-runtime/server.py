#!/usr/bin/env python3
"""Signet SHACL-AF runtime sidecar.

Executes authored SHACL shapes with pyshacl's advanced features — SHACL-AF
rules (TripleRule, SPARQLRule), SPARQL functions, and custom SPARQL-based
constraint components — the features no in-process JS engine in the registry
implements. The registry selects this runtime per shapes document and sends
PREPARED shapes only (targeting rewritten, sh:pattern stripped and executed
by the registry's RE2 layer), so this service never evaluates sh:pattern.

Contract (matched by the registry's pyshacl sidecar adapter):
- POST /v1/validate  { data_nquads, shapes_turtle }
    -> 200 { conforms, results: [{focusNode, path?, sourceConstraintComponent,
             severity, message?, value?}] }  (raw IRIs; deterministic order)
    -> 400 SHAPES_PARSE_ERROR / DATA_PARSE_ERROR
    -> 413 PAYLOAD_TOO_LARGE
    -> 422 VALIDATION_FAILURE   (pyshacl reported a spec-level failure)
    -> 504 VALIDATION_TIMEOUT   (the worker keeps running; concurrency-capped)
- GET /healthz       -> { ok, engine }

Advanced features are always enabled (advanced=True): without it pyshacl
silently skips rules and functions, which would read as "conforms".

Configuration (env):
- HOST (default 0.0.0.0), PORT (default 3300)
- SHACL_RUNTIME_TOKEN: when set, /v1/validate requires the exact bearer
  token; unset = open (local development), matching the Tessera sidecar
  pattern.
- VALIDATE_TIMEOUT_SECONDS (default 30), MAX_BODY_BYTES (default 2_000_000),
  MAX_CONCURRENCY (default 4).
"""

from __future__ import annotations

import json
import os
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pyshacl
from rdflib import Graph, URIRef
from rdflib.namespace import SH

SERVICE_VERSION = "0.1.0"
ENGINE_ID = f"pyshacl@{pyshacl.__version__}"


class ValidationFailureError(Exception):
    """pyshacl reported a SHACL spec-level failure (not non-conformance)."""


class PayloadError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    token: str | None
    validate_timeout_seconds: float
    max_body_bytes: int
    max_concurrency: int

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Config":
        source = env if env is not None else dict(os.environ)
        token = (source.get("SHACL_RUNTIME_TOKEN") or "").strip() or None
        return cls(
            host=source.get("HOST", "0.0.0.0"),
            port=int(source.get("PORT", "3300")),
            token=token,
            validate_timeout_seconds=float(source.get("VALIDATE_TIMEOUT_SECONDS", "30")),
            max_body_bytes=int(source.get("MAX_BODY_BYTES", "2000000")),
            max_concurrency=int(source.get("MAX_CONCURRENCY", "4")),
        )


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


def validate_payload(data_nquads: str, shapes_turtle: str) -> tuple[bool, list[dict[str, Any]]]:
    try:
        shapes_graph = Graph().parse(data=shapes_turtle, format="turtle")
    except Exception as err:  # noqa: BLE001 - surfaced as a structured 400
        raise PayloadError("SHAPES_PARSE_ERROR", f"Shapes Turtle failed to parse: {err}") from err
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


def make_handler(config: Config, executor: ThreadPoolExecutor) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = f"signet-shacl-runtime/{SERVICE_VERSION}"

        def log_message(self, format: str, *args: Any) -> None:
            sys.stderr.write(
                json.dumps({"level": "info", "msg": format % args, "client": self.address_string()}) + "\n"
            )

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _error(self, status: int, code: str, message: str) -> None:
            self._send_json(status, {"error": {"code": code, "message": message}})

        def _authorized(self) -> bool:
            if config.token is None:
                return True
            header = self.headers.get("authorization", "")
            return header == f"Bearer {config.token}"

        def do_GET(self) -> None:  # noqa: N802 - stdlib naming
            if self.path == "/healthz":
                self._send_json(200, {"ok": True, "engine": ENGINE_ID, "service_version": SERVICE_VERSION})
                return
            self._error(404, "NOT_FOUND", "Unknown path.")

        def do_POST(self) -> None:  # noqa: N802 - stdlib naming
            if self.path != "/v1/validate":
                self._error(404, "NOT_FOUND", "Unknown path.")
                return
            if not self._authorized():
                self._error(401, "AUTH_UNAUTHORIZED", "Missing or invalid bearer token.")
                return
            try:
                length = int(self.headers.get("content-length", "0"))
            except ValueError:
                self._error(400, "VALIDATION_ERROR", "Invalid content-length.")
                return
            if length <= 0 or length > config.max_body_bytes:
                self._error(413, "PAYLOAD_TOO_LARGE", f"Body must be 1..{config.max_body_bytes} bytes.")
                return
            try:
                parsed = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception:  # noqa: BLE001 - structured error
                self._error(400, "VALIDATION_ERROR", "Body must be a JSON object.")
                return
            if not isinstance(parsed, dict) or not isinstance(parsed.get("data_nquads"), str) or not isinstance(
                parsed.get("shapes_turtle"), str
            ):
                self._error(400, "VALIDATION_ERROR", "data_nquads and shapes_turtle must be strings.")
                return

            future = executor.submit(validate_payload, parsed["data_nquads"], parsed["shapes_turtle"])
            try:
                conforms, results = future.result(timeout=config.validate_timeout_seconds)
            except FuturesTimeoutError:
                # The worker thread keeps running (Python cannot cancel it);
                # concurrency is capped, and the caller fails closed.
                self._error(504, "VALIDATION_TIMEOUT", "Validation exceeded the configured timeout.")
                return
            except PayloadError as err:
                self._error(400, err.code, str(err))
                return
            except ValidationFailureError as err:
                self._error(422, "VALIDATION_FAILURE", str(err))
                return
            except Exception as err:  # noqa: BLE001 - structured error
                traceback.print_exc()
                self._error(500, "INTERNAL_ERROR", f"Validation failed: {err}")
                return
            self._send_json(200, {"conforms": conforms, "results": results})

    return Handler


def create_server(config: Config, host: str | None = None, port: int | None = None) -> ThreadingHTTPServer:
    executor = ThreadPoolExecutor(max_workers=config.max_concurrency, thread_name_prefix="validate")
    handler = make_handler(config, executor)
    return ThreadingHTTPServer((host or config.host, port if port is not None else config.port), handler)


def main() -> None:
    config = Config.from_env()
    server = create_server(config)
    print(
        json.dumps(
            {
                "level": "info",
                "msg": "shacl-runtime listening",
                "engine": ENGINE_ID,
                "host": config.host,
                "port": server.server_address[1],
                "auth": "token" if config.token else "open",
            }
        ),
        flush=True,
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        thread.join()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
