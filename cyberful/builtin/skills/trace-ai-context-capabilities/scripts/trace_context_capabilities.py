#!/usr/bin/env python3
# ── Offline Context-Capability Trace ─────────────────────────────
# Validates a bounded AI event ledger and emits deterministic typed causal edges.
# → cyberful/builtin/skills/trace-ai-context-capabilities/assets/context-capability-ledger.schema.json — input contract.
# → cyberful/builtin/skills/trace-ai-context-capabilities/tests/test_trace_context_capabilities.py — tests.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import os
import stat
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Final


MAX_INPUT_BYTES: Final = 8_388_608
MAX_OUTPUT_BYTES: Final = 8_388_608
MAX_EVENTS: Final = 20_000
ANALYSIS_TIMEOUT_SECONDS: Final = 30
EVENT_TYPES: Final = frozenset(("instruction", "retrieval", "memory-read", "memory-write", "model-call", "tool-discovery", "tool-request", "policy-decision", "approval", "tool-result", "delegation", "fallback", "output-consumer"))
EDGE_TYPES: Final = frozenset(("contains", "retrieved_from", "derived_from", "selected", "requested", "canonicalized_to", "approved", "executed_as", "returned_to", "persisted_as", "delegated_to", "fell_back_to"))


class TraceError(ValueError):
    """Raised when an event ledger violates the deterministic trace contract."""


def _confined(workspace: Path, value: str, *, exists: bool) -> Path:
    relative = Path(value)
    if not value or relative.is_absolute() or ".." in relative.parts:
        raise TraceError("paths must be relative and non-traversing")
    cursor = workspace
    for part in relative.parts:
        cursor /= part
        if cursor.is_symlink():
            raise TraceError("symbolic links are not allowed")
    path = (workspace / relative).resolve(strict=exists)
    try:
        path.relative_to(workspace)
    except ValueError as error:
        raise TraceError("path escapes workspace") from error
    return path


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 1024 or any(ord(character) < 32 for character in value):
        raise TraceError(f"{label} must be bounded non-empty text")
    return value


def _ensure_acyclic(events: list[dict[str, Any]], event_by_id: dict[str, dict[str, Any]], deadline: float) -> None:
    indegree = {event["id"]: 0 for event in events}
    children: dict[str, list[str]] = {event["id"]: [] for event in events}
    for event in events:
        for parent in event["parents"]:
            if parent in event_by_id:
                indegree[event["id"]] += 1
                children[parent].append(event["id"])
    ready = [identifier for identifier, count in indegree.items() if count == 0]
    heapq.heapify(ready)
    visited = 0
    while ready:
        if time.monotonic() > deadline:
            raise TraceError("context trace exceeded its global deadline")
        identifier = heapq.heappop(ready)
        visited += 1
        for child in sorted(children[identifier]):
            indegree[child] -= 1
            if indegree[child] == 0:
                heapq.heappush(ready, child)
    if visited != len(events):
        cyclic = sorted(identifier for identifier, count in indegree.items() if count > 0)
        raise TraceError(f"causal graph contains a cycle involving: {', '.join(cyclic[:8])}")


def trace(payload: dict[str, Any], digest: str, *, deadline_seconds: float = ANALYSIS_TIMEOUT_SECONDS) -> dict[str, Any]:
    if set(payload) != {"scope_id", "events"} or not isinstance(payload["events"], list) or not payload["events"] or len(payload["events"]) > MAX_EVENTS:
        raise TraceError("ledger must contain scope_id and a bounded non-empty events array")
    scope_id = _text(payload["scope_id"], "scope_id")
    deadline = time.monotonic() + deadline_seconds
    events = []
    identifiers: set[str] = set()
    for index, raw in enumerate(payload["events"]):
        if time.monotonic() > deadline:
            raise TraceError("context trace exceeded its global deadline")
        required = {"id", "type", "actor", "tenant", "parents", "edge", "payload_ref"}
        if not isinstance(raw, dict) or set(raw) != required:
            raise TraceError(f"events[{index}] is malformed")
        identifier = _text(raw["id"], f"events[{index}].id")
        if identifier in identifiers:
            raise TraceError(f"duplicate event id: {identifier}")
        identifiers.add(identifier)
        event_type = _text(raw["type"], f"events[{index}].type")
        edge = _text(raw["edge"], f"events[{index}].edge")
        if event_type not in EVENT_TYPES or edge not in EDGE_TYPES:
            raise TraceError(f"events[{index}] uses an unsupported type or edge")
        raw_parents = raw["parents"]
        if not isinstance(raw_parents, list) or len(raw_parents) > 64:
            raise TraceError(f"events[{index}].parents is malformed")
        parents = [_text(parent, f"events[{index}].parents[]") for parent in raw_parents]
        if len(parents) != len(set(parents)):
            raise TraceError(f"events[{index}].parents must be unique")
        if identifier in parents:
            raise TraceError(f"events[{index}] contains a self-edge")
        parents.sort()
        events.append({"id": identifier, "type": event_type, "actor": _text(raw["actor"], f"events[{index}].actor"), "tenant": _text(raw["tenant"], f"events[{index}].tenant"), "parents": parents, "edge": edge, "payload_ref": _text(raw["payload_ref"], f"events[{index}].payload_ref")})
    event_by_id = {event["id"]: event for event in events}
    _ensure_acyclic(events, event_by_id, deadline)
    edges = []
    gaps = []
    for event in events:
        if time.monotonic() > deadline:
            raise TraceError("context trace exceeded its global deadline")
        for parent in event["parents"]:
            if parent not in event_by_id:
                gaps.append({"kind": "missing-parent", "missing_parent_id": parent, "child_id": event["id"], "edge": event["edge"]})
            else:
                edges.append({"from": parent, "to": event["id"], "type": event["edge"]})
    edges.sort(key=lambda item: (item["from"], item["to"], item["type"]))
    gaps.sort(key=lambda item: (item["missing_parent_id"], item["child_id"], item["edge"]))
    events.sort(key=lambda item: item["id"])
    cross_tenant = sorted({event["id"] for event in events if any(parent in event_by_id and event_by_id[parent]["tenant"] != event["tenant"] for parent in event["parents"])})
    return {"format": "cyberful.ai-context-capability-trace.raw.v1", "input_sha256": digest, "scope_id": scope_id, "events": events, "edges": edges, "gaps": gaps, "leads": {"cross_tenant_event_ids": cross_tenant}}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Trace a bounded AI context-capability event ledger offline.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        workspace = Path(args.workspace).resolve(strict=True)
        source = _confined(workspace, args.input, exists=True)
        destination = _confined(workspace, args.output, exists=False)
        if destination == source or not destination.parent.is_dir():
            raise TraceError("output must be distinct with an existing parent")
        metadata = source.stat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
            raise TraceError("input must be a bounded regular file")
        raw = source.read_bytes()
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise TraceError("input must be a JSON object")
        report = trace(payload, hashlib.sha256(raw).hexdigest())
        rendered = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode()
        if len(rendered) > MAX_OUTPUT_BYTES:
            raise TraceError("trace output exceeds its boundary")
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile("wb", dir=destination.parent, prefix=f".{destination.name}.", delete=False) as handle:
                temporary = handle.name
                os.chmod(temporary, 0o600)
                handle.write(rendered)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, destination)
            temporary = None
        finally:
            if temporary:
                Path(temporary).unlink(missing_ok=True)
        return 0
    except (TraceError, OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        print(f"context trace error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
