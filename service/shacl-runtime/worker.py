#!/usr/bin/env python3
"""SHACL-AF worker entrypoint (child process of the sidecar).

One pyshacl validation at a time per worker process, under rlimits set at
startup. The parent kills the process on timeout (hard cancellation — a
thread could never be cancelled), so a worker must never be shared for
concurrent work and must own no state beyond the connection.

Protocol (parent -> child -> parent, pickled via multiprocessing.Connection):
- task:   {"data_nquads": str, "shapes_turtle": str}
- None:   graceful shutdown request
- result: {"ok": True, "conforms": bool, "results": [...], "cpu_seconds": f}
        | {"ok": False, "code": str, "message": str, "cpu_seconds": f}

Resource limits (`_apply_limits`):
- RLIMIT_CPU: backstop on total process CPU (a runaway SPARQL evaluation
  cannot outlive it even if the parent dies mid-request)
- RLIMIT_NOFILE: the validating context needs no new sockets/FDs
- RLIMIT_CORE=0: a crashing worker leaves no core file (note: RLIMIT_FSIZE
  is deliberately NOT zeroed — the worker's stderr may be a regular file
  (container log capture, test harnesses), and an FSIZE cap would kill the
  worker with SIGXFSZ on its first diagnostic write)
- RLIMIT_AS: memory cap. Best-effort by platform: Linux enforces it; the
  macOS kernel rejects the setrlimit entirely (EINVAL) — a warning is logged
  and execution continues (kill/CPU limits still bound the child).
"""

from __future__ import annotations

import json
import sys
import traceback
from dataclasses import dataclass
from typing import Any

try:  # POSIX only; the runtime targets Linux/macOS deployments.
    import resource
except ImportError:  # pragma: no cover - non-POSIX platform
    resource = None  # type: ignore[assignment]

from engine import PayloadError, ValidationFailureError, validate_payload

CPU_HARD_LIMIT_GRACE_SECONDS = 30


def _log(payload: dict[str, Any]) -> None:
    sys.stderr.write(json.dumps(payload) + "\n")
    sys.stderr.flush()


@dataclass(frozen=True)
class WorkerLimits:
    memory_mb: int
    cpu_seconds: int
    nofile: int


def _apply_limits(limits: WorkerLimits) -> None:
    if resource is None:  # pragma: no cover - non-POSIX platform
        _log({"level": "warning", "msg": "resource limits unavailable on this platform"})
        return
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (limits.nofile, limits.nofile))
    resource.setrlimit(
        resource.RLIMIT_CPU,
        (limits.cpu_seconds, limits.cpu_seconds + CPU_HARD_LIMIT_GRACE_SECONDS),
    )
    memory_bytes = limits.memory_mb * 1024 * 1024
    try:
        resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    except (ValueError, OSError) as err:
        # macOS rejects RLIMIT_AS/LIMIT_DATA with EINVAL regardless of value.
        # The process boundary, timeout kill, and RLIMIT_CPU remain enforced.
        _log(
            {
                "level": "warning",
                "msg": "memory rlimit unavailable on this platform",
                "error": str(err),
                "memory_mb": limits.memory_mb,
            }
        )


def _cpu_seconds_used() -> float:
    if resource is None:  # pragma: no cover - non-POSIX platform
        return 0.0
    usage = resource.getrusage(resource.RUSAGE_SELF)
    return float(usage.ru_utime + usage.ru_stime)


def child_main(conn: Any, limits: WorkerLimits) -> None:
    _apply_limits(limits)
    while True:
        try:
            task = conn.recv()
        except EOFError:
            return
        if task is None:
            return
        try:
            conforms, results = validate_payload(task["data_nquads"], task["shapes_turtle"])
            conn.send(
                {
                    "ok": True,
                    "conforms": conforms,
                    "results": results,
                    "cpu_seconds": _cpu_seconds_used(),
                }
            )
        except PayloadError as err:
            conn.send(
                {"ok": False, "code": err.code, "message": str(err), "cpu_seconds": _cpu_seconds_used()}
            )
        except ValidationFailureError as err:
            conn.send(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILURE",
                    "message": str(err),
                    "cpu_seconds": _cpu_seconds_used(),
                }
            )
        except MemoryError:
            conn.send(
                {
                    "ok": False,
                    "code": "RESOURCE_LIMIT",
                    "message": "validation exceeded the memory limit",
                    "cpu_seconds": _cpu_seconds_used(),
                }
            )
        except Exception as err:  # noqa: BLE001 - structured error, fail closed
            traceback.print_exc()
            conn.send(
                {
                    "ok": False,
                    "code": "INTERNAL_ERROR",
                    "message": f"Validation failed: {err}",
                    "cpu_seconds": _cpu_seconds_used(),
                }
            )
