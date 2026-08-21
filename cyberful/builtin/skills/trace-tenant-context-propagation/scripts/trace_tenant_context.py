#!/usr/bin/env python3
# ── Bounded Offline Tenant Context Trace ────────────────────────
# Normalizes tenant-binding artifacts and records changes and non-null context
#   divergences without network access or an authorization verdict.
# → cyberful/builtin/skills/trace-tenant-context-propagation/assets/tenant-context.schema.json — input contract.
# → cyberful/builtin/skills/trace-tenant-context-propagation/tests/test_trace_tenant_context.py — CLI coverage.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
from typing import Any, Final


MAX_INPUT_BYTES: Final = 1_048_576
MAX_OUTPUT_BYTES: Final = 1_048_576
MAX_EVENTS: Final = 128
MAX_TEXT: Final = 512
MAX_TIMEOUT_SECONDS: Final = 15.0
BOUNDARIES: Final = frozenset(("ingress", "gateway", "service", "cache", "queue", "job", "repository", "storage", "response"))
CONTEXT_FIELDS: Final = ("authenticated_tenant", "asserted_tenant", "routed_tenant", "resource_tenant", "cache_partition", "job_tenant", "data_partition")


class TraceError(ValueError):
    """Raised when an artifact violates the tenant trace contract."""


def _deadline(timeout_seconds: float) -> float:
    if not 0.1 <= timeout_seconds <= MAX_TIMEOUT_SECONDS:
        raise TraceError(f"timeout must be between 0.1 and {MAX_TIMEOUT_SECONDS} seconds")
    return time.monotonic() + timeout_seconds


def _check_deadline(deadline: float) -> None:
    if time.monotonic() > deadline:
        raise TraceError("global analysis deadline exceeded")


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise TraceError("workspace must be an existing directory")
    return workspace


def _confined(workspace: Path, value: str, *, must_exist: bool) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise TraceError("paths must be non-traversing and relative to the workspace")
    cursor = workspace
    for component in requested.parts:
        cursor = cursor / component
        if cursor.is_symlink():
            raise TraceError(f"path component is a symbolic link: {component}")
    resolved = (workspace / requested).resolve(strict=must_exist)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise TraceError("path escapes the workspace") from error
    return resolved


def _text(value: Any, label: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise TraceError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > MAX_TEXT or any(ord(character) < 32 for character in normalized):
        raise TraceError(f"{label} exceeds its text boundary or contains control characters")
    return normalized


def _context(value: Any, label: str) -> dict[str, str | None]:
    if not isinstance(value, dict) or set(value) != set(CONTEXT_FIELDS):
        raise TraceError(f"{label} contains missing or unknown fields")
    return {field: _text(value[field], f"{label}.{field}", nullable=True) for field in CONTEXT_FIELDS}


def _event(value: Any, index: int) -> dict[str, Any]:
    required = {"event_id", "order", "component", "boundary", "evidence_sha256", "context"}
    if not isinstance(value, dict) or set(value) != required:
        raise TraceError(f"events[{index}] contains missing or unknown fields")
    order = value["order"]
    if not isinstance(order, int) or isinstance(order, bool) or not 0 <= order <= 1_000_000:
        raise TraceError(f"events[{index}].order must be an integer between 0 and 1000000")
    boundary = _text(value["boundary"], f"events[{index}].boundary")
    if boundary not in BOUNDARIES:
        raise TraceError(f"events[{index}].boundary is unsupported")
    evidence_sha256 = _text(value["evidence_sha256"], f"events[{index}].evidence_sha256")
    if len(evidence_sha256) != 64 or any(character not in "0123456789abcdef" for character in evidence_sha256):
        raise TraceError(f"events[{index}].evidence_sha256 must be a lowercase SHA-256 digest")
    return {
        "event_id": _text(value["event_id"], f"events[{index}].event_id"),
        "order": order,
        "component": _text(value["component"], f"events[{index}].component"),
        "boundary": boundary,
        "evidence_sha256": evidence_sha256,
        "context": _context(value["context"], f"events[{index}].context"),
    }


def _load(workspace: Path, relative: str, deadline: float) -> tuple[dict[str, Any], bytes, Path]:
    source = _confined(workspace, relative, must_exist=True)
    metadata = source.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
        raise TraceError(f"input must be a regular file no larger than {MAX_INPUT_BYTES} bytes")
    raw = source.read_bytes()
    _check_deadline(deadline)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TraceError("input must be UTF-8 JSON") from error
    if not isinstance(payload, dict):
        raise TraceError("input must be a JSON object")
    return payload, raw, source


def _divergences(context: dict[str, str | None]) -> list[str]:
    values = {value for value in context.values() if value is not None}
    if len(values) <= 1:
        return []
    return [field for field in CONTEXT_FIELDS if context[field] is not None]


def _analyze(payload: dict[str, Any], raw: bytes, deadline: float) -> dict[str, Any]:
    if set(payload) != {"$schema", "trace_id", "events"}:
        raise TraceError("input must contain exactly $schema, trace_id, and events")
    trace_id = _text(payload["trace_id"], "trace_id")
    values = payload["events"]
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_EVENTS:
        raise TraceError(f"events must contain between 1 and {MAX_EVENTS} entries")
    events = [_event(value, index) for index, value in enumerate(values)]
    event_ids = [event["event_id"] for event in events]
    orders = [event["order"] for event in events]
    if len(event_ids) != len(set(event_ids)) or len(orders) != len(set(orders)):
        raise TraceError("event_id and order must each be unique")
    previous: dict[str, str | None] | None = None
    output_events: list[dict[str, Any]] = []
    for event in sorted(events, key=lambda item: (item["order"], item["event_id"])):
        _check_deadline(deadline)
        context = event["context"]
        changes = list(CONTEXT_FIELDS) if previous is None else [field for field in CONTEXT_FIELDS if previous[field] != context[field]]
        output_events.append({**event, "changes": changes, "divergences": _divergences(context)})
        previous = context
    return {
        "format": "cyberful.tenant-context-evidence.v1",
        "trace_id": trace_id,
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "limits": {"input_bytes": MAX_INPUT_BYTES, "output_bytes": MAX_OUTPUT_BYTES, "events": MAX_EVENTS},
        "events": output_events,
        "interpretation": "Raw normalized tenant-context changes and divergences; canonical mappings and authorization impact require review.",
    }


def _write_bounded(
    workspace: Path,
    relative: str,
    payload: dict[str, Any],
    deadline: float,
    source: Path,
) -> None:
    destination = _confined(workspace, relative, must_exist=False)
    if destination == source or not destination.parent.is_dir():
        raise TraceError("output must differ from input and have an existing parent directory")
    descriptor, temporary_name = tempfile.mkstemp(prefix=".tenant-trace-", dir=destination.parent)
    temporary = Path(temporary_name)
    total = 0
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", errors="strict") as stream:
            for chunk in json.JSONEncoder(sort_keys=True, separators=(",", ":")).iterencode(payload):
                _check_deadline(deadline)
                encoded = chunk.encode("utf-8")
                total += len(encoded)
                if total + 1 > MAX_OUTPUT_BYTES:
                    raise TraceError(f"output exceeds the {MAX_OUTPUT_BYTES}-byte limit")
                stream.write(chunk)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize bounded tenant-context artifacts offline.")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    arguments = parser.parse_args()
    try:
        deadline = _deadline(arguments.timeout_seconds)
        workspace = _workspace(arguments.workspace)
        payload, raw, source = _load(workspace, arguments.input, deadline)
        evidence = _analyze(payload, raw, deadline)
        _write_bounded(workspace, arguments.output, evidence, deadline, source)
    except (OSError, TraceError) as error:
        print(f"tenant context trace refused: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
