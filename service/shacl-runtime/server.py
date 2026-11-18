#!/usr/bin/env python3
"""Signet SHACL-AF runtime sidecar.

Executes authored SHACL shapes with pyshacl's advanced features — SHACL-AF
rules (TripleRule, SPARQLRule), SPARQL functions, and custom SPARQL-based
constraint components — the features no in-process JS engine in the registry
implements. The registry selects this runtime per shapes document and sends
PREPARED shapes only (targeting rewritten, sh:pattern stripped and executed
by the registry's RE2 layer), so this service never evaluates sh:pattern.

Execution model: every validation runs in a worker SUBPROCESS with rlimits
(memory best-effort per platform, CPU backstop, no files, bounded fds);
timeouts hard-kill the worker, so no runaway work lingers or holds capacity.
The HTTP process never executes pyshacl itself.

Contract (matched by the registry's pyshacl sidecar adapter):
- POST /v1/validate  { data_nquads, shapes_turtle }
    -> 200 { conforms, results: [{focusNode, path?, sourceConstraintComponent,
             severity, message?, value?}] }  (raw IRIs; deterministic order)
    -> 400 SHAPES_PARSE_ERROR / DATA_PARSE_ERROR / FEDERATED_QUERY_REJECTED
    -> 413 PAYLOAD_TOO_LARGE
    -> 422 VALIDATION_FAILURE   (pyshacl reported a spec-level failure)
    -> 500 VALIDATION_ABORTED   (worker died mid-validation: crash or rlimit)
    -> 504 VALIDATION_TIMEOUT   (the worker was terminated; capacity released)
    -> 507 RESOURCE_LIMIT       (validation exceeded the memory limit)
- GET /healthz       -> { ok, engine, service_version, workers }

Advanced features are always enabled (advanced=True): without it pyshacl
silently skips rules and functions, which would read as "conforms".

Configuration (env):
- HOST (default 0.0.0.0), PORT (default 3300)
- SHACL_RUNTIME_TOKEN: when set, /v1/validate requires the exact bearer
  token; unset = open (local development), matching the Tessera sidecar
  pattern.
- VALIDATE_TIMEOUT_SECONDS (default 30), MAX_BODY_BYTES (default 2_000_000),
  MAX_CONCURRENCY (default 4), QUEUE_LIMIT (default 32)
- Worker limits: MAX_MEMORY_MB (default 1024; enforced on Linux, best-effort
  where the kernel rejects RLIMIT_AS), MAX_CPU_SECONDS (default 300, hard
  backstop), MAX_NOFILE (default 64).
"""

from __future__ import annotations

import hmac
import json
import multiprocessing
import os
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from engine import ENGINE_ID, PayloadError, ValidationFailureError
from worker import WorkerLimits, child_main

SERVICE_VERSION = "0.2.0"

# Extra wall-clock allowance over the validation timeout for worker spawn and
# transfer; the child-side poll is the authoritative timeout.
SPAWN_GRACE_SECONDS = 10.0

# Retire a worker once it has consumed this fraction of its CPU backstop, so
# long-lived workers cannot accumulate to the RLIMIT_CPU kill mid-request.
CHILD_RETIRE_CPU_FRACTION = 0.5

PAYLOAD_ERROR_CODES = frozenset({"SHAPES_PARSE_ERROR", "DATA_PARSE_ERROR", "FEDERATED_QUERY_REJECTED"})


class ValidationTimeoutError(Exception):
    """The worker exceeded the validation timeout and was killed."""


class ValidationAbortedError(Exception):
    """The worker died mid-validation (crash, rlimit kill, protocol EOF)."""


class ResourceLimitError(Exception):
    """The worker hit the memory limit while validating."""


def _multiprocessing_context() -> multiprocessing.context.BaseContext:
    """Forkserver with engine/worker preloaded (child spawn ~5ms), else spawn.

    Forkserver is safe to start from the threaded HTTP process (unlike fork)
    and preloading pays the pyshacl import once per process, not per worker.
    """
    try:
        context = multiprocessing.get_context("forkserver")
        context.set_forkserver_preload(["engine", "worker"])
        return context
    except (ValueError, AttributeError):  # pragma: no cover - platform fallback
        return multiprocessing.get_context("spawn")


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    token: str | None
    validate_timeout_seconds: float
    request_timeout_seconds: float
    max_body_bytes: int
    max_concurrency: int
    queue_limit: int
    max_memory_mb: int
    max_cpu_seconds: int
    max_nofile: int

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Config":
        source = env if env is not None else dict(os.environ)
        token = (source.get("SHACL_RUNTIME_TOKEN") or "").strip() or None
        config = cls(
            host=source.get("HOST", "0.0.0.0"),
            port=int(source.get("PORT", "3300")),
            token=token,
            validate_timeout_seconds=float(source.get("VALIDATE_TIMEOUT_SECONDS", "30")),
            request_timeout_seconds=float(source.get("REQUEST_TIMEOUT_SECONDS", "15")),
            max_body_bytes=int(source.get("MAX_BODY_BYTES", "2000000")),
            max_concurrency=int(source.get("MAX_CONCURRENCY", "4")),
            queue_limit=int(source.get("QUEUE_LIMIT", "32")),
            max_memory_mb=int(source.get("MAX_MEMORY_MB", "1024")),
            max_cpu_seconds=int(source.get("MAX_CPU_SECONDS", "300")),
            max_nofile=int(source.get("MAX_NOFILE", "64")),
        )
        # Fail fast on nonsensical caps instead of running with them.
        for field_name in (
            "validate_timeout_seconds",
            "request_timeout_seconds",
            "max_body_bytes",
            "max_concurrency",
            "max_memory_mb",
            "max_cpu_seconds",
            "max_nofile",
        ):
            if getattr(config, field_name) <= 0:
                raise ValueError(f"{field_name} must be positive, got {getattr(config, field_name)}")
        if config.queue_limit < 0:
            raise ValueError(f"queue_limit must be non-negative, got {config.queue_limit}")
        return config


@dataclass
class _WorkerHandle:
    process: Any
    conn: Any
    busy: bool = field(default=False)


class WorkerPool:
    """Bounded pool of worker subprocesses, one validation at a time each.

    The executor thread count equals the pool capacity, so a checkout always
    finds or creates a handle; busy handles are owned exclusively by their
    request until it returns, times out (kill), or aborts (drop).
    """

    def __init__(self, config: Config) -> None:
        self._config = config
        self._context = _multiprocessing_context()
        self._lock = threading.Lock()
        self._handles: list[_WorkerHandle] = []
        self._killed = 0
        self._aborted = 0

    def _worker_limits(self) -> WorkerLimits:
        return WorkerLimits(
            memory_mb=self._config.max_memory_mb,
            cpu_seconds=self._config.max_cpu_seconds,
            nofile=self._config.max_nofile,
        )

    def _spawn_handle(self) -> _WorkerHandle:
        parent_conn, child_conn = self._context.Pipe()
        process = self._context.Process(
            target=child_main, args=(child_conn, self._worker_limits()), daemon=True
        )
        try:
            process.start()
        except Exception:
            parent_conn.close()
            child_conn.close()
            raise
        child_conn.close()
        return _WorkerHandle(process=process, conn=parent_conn)

    def _create_handle(self) -> _WorkerHandle:
        try:
            return self._spawn_handle()
        except Exception:  # noqa: BLE001 - one fallback, then fail closed
            if self._context.get_start_method() != "forkserver":
                raise
            # Forkserver can be unavailable in constrained environments; fall
            # back to spawn once (slower worker start, same isolation).
            self._context = multiprocessing.get_context("spawn")
            return self._spawn_handle()

    def _checkout(self) -> _WorkerHandle:
        with self._lock:
            for handle in list(self._handles):
                if handle.busy:
                    continue
                if not handle.process.is_alive():
                    self._drop_locked(handle, aborted=True)
                    continue
                handle.busy = True
                return handle
            if len(self._handles) >= self._config.max_concurrency:
                # Unreachable while executor size == pool capacity; fail closed.
                raise ValidationAbortedError("validation pool saturated")
            try:
                handle = self._create_handle()
            except Exception as err:  # noqa: BLE001 - fail closed per request
                raise ValidationAbortedError(f"worker could not be started: {err}") from err
            handle.busy = True
            self._handles.append(handle)
            return handle

    def _drop_locked(self, handle: _WorkerHandle, *, aborted: bool) -> None:
        if handle in self._handles:
            self._handles.remove(handle)
        try:
            handle.conn.close()
        except OSError:
            pass
        if aborted:
            self._aborted += 1

    def _kill(self, handle: _WorkerHandle, *, timeout_kill: bool, aborted: bool = False) -> None:
        with self._lock:
            if timeout_kill:
                self._killed += 1
            if aborted:
                self._aborted += 1
            handle.process.kill()
            handle.process.join(timeout=5)
            self._drop_locked(handle, aborted=False)

    def run_validation(self, data_nquads: str, shapes_turtle: str) -> tuple[bool, list[dict[str, Any]]]:
        handle = self._checkout()
        try:
            try:
                handle.conn.send({"data_nquads": data_nquads, "shapes_turtle": shapes_turtle})
                if not handle.conn.poll(self._config.validate_timeout_seconds):
                    raise ValidationTimeoutError(
                        "Validation exceeded the configured timeout and was terminated."
                    )
                result = handle.conn.recv()
            except ValidationTimeoutError:
                self._kill(handle, timeout_kill=True)
                raise
            except (EOFError, OSError, ValueError) as err:
                self._kill(handle, timeout_kill=False, aborted=True)
                raise ValidationAbortedError(
                    f"validation worker terminated unexpectedly: {err or 'connection closed'}"
                ) from err
        finally:
            handle.busy = False

        cpu_seconds = float(result.get("cpu_seconds") or 0.0)
        if cpu_seconds >= self._config.max_cpu_seconds * CHILD_RETIRE_CPU_FRACTION:
            # Recycle before the cumulative RLIMIT_CPU can kill mid-request.
            self._kill(handle, timeout_kill=False)

        if result.get("ok") is True:
            return bool(result["conforms"]), list(result["results"])
        code = str(result.get("code") or "INTERNAL_ERROR")
        message = str(result.get("message") or "validation failed")
        if code in PAYLOAD_ERROR_CODES:
            raise PayloadError(code, message)
        if code == "VALIDATION_FAILURE":
            raise ValidationFailureError(message)
        if code == "RESOURCE_LIMIT":
            # Recycle: the worker's heap state after a memory-limit event is
            # unknown; the next request gets a fresh process.
            self._kill(handle, timeout_kill=False)
            raise ResourceLimitError(message)
        raise RuntimeError(message)

    def stats(self) -> dict[str, int]:
        with self._lock:
            alive = sum(1 for handle in self._handles if handle.process.is_alive())
            return {
                "size": self._config.max_concurrency,
                "alive": alive,
                "killed": self._killed,
                "aborted": self._aborted,
            }

    def close(self) -> None:
        with self._lock:
            handles = list(self._handles)
            self._handles.clear()
        for handle in handles:
            try:
                handle.process.kill()
                handle.process.join(timeout=5)
            except Exception:  # noqa: BLE001 - best-effort teardown
                pass
            try:
                handle.conn.close()
            except OSError:
                pass


def make_handler(
    config: Config, executor: ThreadPoolExecutor, pool: WorkerPool
) -> type[BaseHTTPRequestHandler]:
    # Bounded in-flight work: max_concurrency workers plus a finite queue.
    # Slots are released when the FUTURE completes (not when the response is
    # written); a timed-out validation completes at the kill, so no runaway
    # work holds capacity.
    slots = threading.BoundedSemaphore(config.max_concurrency + config.queue_limit)

    class Handler(BaseHTTPRequestHandler):
        server_version = f"signet-shacl-runtime/{SERVICE_VERSION}"
        # socketserver applies this to the connection: slow or stalled
        # clients are dropped instead of pinning handler threads (slowloris).
        timeout = config.request_timeout_seconds

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
            # constant-time comparison: do not leak the token via timing
            return hmac.compare_digest(header.encode("utf-8"), f"Bearer {config.token}".encode("utf-8"))

        def do_GET(self) -> None:  # noqa: N802 - stdlib naming
            if self.path == "/healthz":
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "engine": ENGINE_ID,
                        "service_version": SERVICE_VERSION,
                        "workers": pool.stats(),
                    },
                )
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

            if not slots.acquire(blocking=False):
                self._error(503, "SHACL_RUNTIME_BUSY", "The runtime is at capacity; retry shortly.")
                return
            future = executor.submit(pool.run_validation, parsed["data_nquads"], parsed["shapes_turtle"])
            future.add_done_callback(lambda _future: slots.release())
            try:
                conforms, results = future.result(
                    timeout=config.validate_timeout_seconds + SPAWN_GRACE_SECONDS
                )
            except (FuturesTimeoutError, ValidationTimeoutError):
                self._error(504, "VALIDATION_TIMEOUT", "Validation exceeded the configured timeout.")
                return
            except ValidationAbortedError as err:
                self._error(500, "VALIDATION_ABORTED", str(err))
                return
            except ResourceLimitError as err:
                self._error(507, "RESOURCE_LIMIT", str(err))
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


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    """Threading server that logs handler errors as one JSON line instead of
    dumping tracebacks (request timeouts are expected client behavior)."""

    def handle_error(self, request: Any, client_address: Any) -> None:  # noqa: ARG002 - stdlib signature
        sys.stderr.write(
            json.dumps({"level": "error", "msg": "request handler error", "client": str(client_address)}) + "\n"
        )


class RuntimeServer(QuietThreadingHTTPServer):
    """HTTP server owning the worker pool + executor lifetime."""

    def __init__(
        self,
        address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        pool: WorkerPool,
        executor: ThreadPoolExecutor,
    ) -> None:
        self.validation_pool = pool
        self.validation_executor = executor
        super().__init__(address, handler)

    def server_close(self) -> None:
        self.validation_pool.close()
        self.validation_executor.shutdown(wait=False, cancel_futures=True)
        super().server_close()


def create_server(config: Config, host: str | None = None, port: int | None = None) -> ThreadingHTTPServer:
    pool = WorkerPool(config)
    executor = ThreadPoolExecutor(max_workers=config.max_concurrency, thread_name_prefix="validate")
    handler = make_handler(config, executor, pool)
    return RuntimeServer((host or config.host, port if port is not None else config.port), handler, pool, executor)


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
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
