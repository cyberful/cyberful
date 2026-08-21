#!/usr/bin/env python3
# ── Deterministic Transaction State Trace ───────────────────────
# Reconstructs bounded transaction state and value from local evidence,
#   preserving causal gaps and repeat indicators without active traffic.
# → cyberful/builtin/skills/trace-transaction-state/assets/transaction-events.schema.json — input contract.
# → cyberful/builtin/skills/trace-transaction-state/tests/test_run_transaction_trace.py — boundary coverage.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
from typing import Any, Final


MAX_INPUT_BYTES: Final = 2_097_152
MAX_OUTPUT_BYTES: Final = 4_194_304
MAX_TRANSACTIONS: Final = 512
MAX_EVENTS: Final = 8_192
MAX_EVENTS_PER_TRANSACTION: Final = 2_048
MAX_TEXT: Final = 2_048
MAX_ID: Final = 256
MAX_CORRELATIONS: Final = 32
MAX_AMOUNT_MINOR: Final = 1_000_000_000_000_000
TRACE_TIMEOUT_SECONDS: Final = 10
CURRENCY_PATTERN = re.compile(r"^[A-Z]{3}$")
TRANSACTION_FIELDS: Final = frozenset(("transaction_id", "currency", "expected_terminal_state", "expected_net_delta_minor", "events"))
EVENT_FIELDS: Final = frozenset(("event_id", "sequence", "component", "kind", "state_before", "state_after", "amount_delta_minor", "idempotency_key", "correlation_ids", "durable_effect", "evidence_ref"))


class TraceError(ValueError):
    """Raised when local transaction evidence violates the trace contract."""


@dataclass(frozen=True)
class TransactionEvent:
    event_id: str
    sequence: int
    component: str
    kind: str
    state_before: str
    state_after: str
    amount_delta_minor: int
    idempotency_key: str | None
    correlation_ids: tuple[str, ...]
    durable_effect: str
    evidence_ref: str


@dataclass(frozen=True)
class Transaction:
    transaction_id: str
    currency: str
    expected_terminal_state: str
    expected_net_delta_minor: int
    events: tuple[TransactionEvent, ...]


def _text(value: Any, label: str, *, maximum: int = MAX_TEXT) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TraceError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > maximum or any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise TraceError(f"{label} exceeds its text boundary or contains control characters")
    return normalized


def _integer(value: Any, label: str, *, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise TraceError(f"{label} must be an integer between {minimum} and {maximum}")
    return value


def _text_list(value: Any, label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or len(value) > MAX_CORRELATIONS:
        raise TraceError(f"{label} must be an array with at most {MAX_CORRELATIONS} entries")
    normalized = tuple(_text(item, f"{label}[]", maximum=MAX_ID) for item in value)
    if len(set(normalized)) != len(normalized):
        raise TraceError(f"{label} must not contain duplicates")
    return tuple(sorted(normalized))


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise TraceError("workspace must be an existing directory")
    return workspace


def _confined_path(workspace: Path, value: str, *, must_exist: bool) -> Path:
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


def _read_json(workspace: Path, value: str) -> tuple[dict[str, Any], bytes, Path]:
    source = _confined_path(workspace, value, must_exist=True)
    metadata = source.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
        raise TraceError(f"input must be a regular file no larger than {MAX_INPUT_BYTES} bytes")
    raw = source.read_bytes()
    if len(raw) > MAX_INPUT_BYTES:
        raise TraceError(f"input must be no larger than {MAX_INPUT_BYTES} bytes")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TraceError("input must be UTF-8 JSON") from error
    if not isinstance(payload, dict):
        raise TraceError("input must be a JSON object")
    return payload, raw, source


def _event(value: Any, transaction_index: int, event_index: int) -> TransactionEvent:
    label = f"transactions[{transaction_index}].events[{event_index}]"
    if not isinstance(value, dict) or set(value) != EVENT_FIELDS:
        raise TraceError(f"{label} contains missing or unknown fields")
    raw_idempotency = value["idempotency_key"]
    if raw_idempotency is not None and not isinstance(raw_idempotency, str):
        raise TraceError(f"{label}.idempotency_key must be a string or null")
    idempotency_key = None if raw_idempotency is None else _text(raw_idempotency, f"{label}.idempotency_key", maximum=MAX_ID)
    return TransactionEvent(
        event_id=_text(value["event_id"], f"{label}.event_id", maximum=MAX_ID),
        sequence=_integer(value["sequence"], f"{label}.sequence", minimum=0, maximum=1_000_000_000),
        component=_text(value["component"], f"{label}.component", maximum=MAX_ID),
        kind=_text(value["kind"], f"{label}.kind", maximum=MAX_ID),
        state_before=_text(value["state_before"], f"{label}.state_before", maximum=MAX_ID),
        state_after=_text(value["state_after"], f"{label}.state_after", maximum=MAX_ID),
        amount_delta_minor=_integer(value["amount_delta_minor"], f"{label}.amount_delta_minor", minimum=-MAX_AMOUNT_MINOR, maximum=MAX_AMOUNT_MINOR),
        idempotency_key=idempotency_key,
        correlation_ids=_text_list(value["correlation_ids"], f"{label}.correlation_ids"),
        durable_effect=_text(value["durable_effect"], f"{label}.durable_effect"),
        evidence_ref=_text(value["evidence_ref"], f"{label}.evidence_ref"),
    )


def _transaction(value: Any, index: int) -> Transaction:
    label = f"transactions[{index}]"
    if not isinstance(value, dict) or set(value) != TRANSACTION_FIELDS:
        raise TraceError(f"{label} contains missing or unknown fields")
    currency = _text(value["currency"], f"{label}.currency", maximum=3)
    if not CURRENCY_PATTERN.fullmatch(currency):
        raise TraceError(f"{label}.currency must be a three-letter uppercase code")
    raw_events = value["events"]
    if not isinstance(raw_events, list) or not raw_events or len(raw_events) > MAX_EVENTS_PER_TRANSACTION:
        raise TraceError(f"{label}.events must contain between 1 and {MAX_EVENTS_PER_TRANSACTION} entries")
    return Transaction(
        transaction_id=_text(value["transaction_id"], f"{label}.transaction_id", maximum=MAX_ID),
        currency=currency,
        expected_terminal_state=_text(value["expected_terminal_state"], f"{label}.expected_terminal_state", maximum=MAX_ID),
        expected_net_delta_minor=_integer(value["expected_net_delta_minor"], f"{label}.expected_net_delta_minor", minimum=-MAX_AMOUNT_MINOR, maximum=MAX_AMOUNT_MINOR),
        events=tuple(_event(event, index, event_index) for event_index, event in enumerate(raw_events)),
    )


def _validate_payload(payload: dict[str, Any]) -> tuple[str, str, tuple[Transaction, ...]]:
    if set(payload) != {"$schema", "engagement_id", "authorization_reference", "transactions"}:
        raise TraceError("input contains missing or unknown fields")
    if payload["$schema"] != "./transaction-events.schema.json":
        raise TraceError("$schema must reference ./transaction-events.schema.json")
    raw_transactions = payload["transactions"]
    if not isinstance(raw_transactions, list) or not raw_transactions or len(raw_transactions) > MAX_TRANSACTIONS:
        raise TraceError(f"transactions must contain between 1 and {MAX_TRANSACTIONS} entries")
    transactions = tuple(_transaction(value, index) for index, value in enumerate(raw_transactions))
    identifiers = [transaction.transaction_id for transaction in transactions]
    if len(set(identifiers)) != len(identifiers):
        raise TraceError("transaction_id values must be unique")
    if sum(len(transaction.events) for transaction in transactions) > MAX_EVENTS:
        raise TraceError(f"transaction events exceed the {MAX_EVENTS}-event total limit")
    return (
        _text(payload["engagement_id"], "engagement_id", maximum=MAX_ID),
        _text(payload["authorization_reference"], "authorization_reference"),
        transactions,
    )


def _check_deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise TraceError("trace exceeded its global deadline")


# ── Ordering Evidence Is Stronger Than Wall-Clock Guesswork ─────
# Each transaction is ordered by its local sequence and stable identifiers so
# equivalent input produces the same trace. State continuity, repeated event
# identifiers, idempotency-key reuse, and value differences remain separate
# observations because they have different owners and benign explanations.
# The trace preserves durable-effect references but never claims that a retry,
# compensation, or mismatch produced fraud without authoritative confirmation.
# ─────────────────────────────────────────────────────────────────
def run_trace(payload: dict[str, Any], source_sha256: str, deadline: float) -> dict[str, Any]:
    engagement_id, authorization_reference, transactions = _validate_payload(payload)
    traces: list[dict[str, Any]] = []
    event_count = 0
    for transaction in sorted(transactions, key=lambda item: item.transaction_id):
        _check_deadline(deadline)
        ordered = tuple(sorted(transaction.events, key=lambda item: (item.sequence, item.event_id, item.component, item.kind)))
        event_count += len(ordered)
        continuity_gaps = []
        for previous, current in zip(ordered, ordered[1:]):
            _check_deadline(deadline)
            if previous.state_after != current.state_before:
                continuity_gaps.append({
                    "previous_event_id": previous.event_id,
                    "next_event_id": current.event_id,
                    "previous_state_after": previous.state_after,
                    "next_state_before": current.state_before,
                })

        event_counts = Counter(event.event_id for event in ordered)
        duplicate_event_ids = [
            {"event_id": event_id, "count": count, "sequences": [event.sequence for event in ordered if event.event_id == event_id]}
            for event_id, count in sorted(event_counts.items())
            if count > 1
        ]
        by_idempotency: dict[str, list[TransactionEvent]] = defaultdict(list)
        for event in ordered:
            if event.idempotency_key is not None:
                by_idempotency[event.idempotency_key].append(event)
        idempotency_reuse = [
            {
                "idempotency_key": key,
                "event_ids": [event.event_id for event in grouped],
                "components": sorted({event.component for event in grouped}),
                "kinds": sorted({event.kind for event in grouped}),
                "amount_delta_minor": sum(event.amount_delta_minor for event in grouped),
            }
            for key, grouped in sorted(by_idempotency.items())
            if len(grouped) > 1
        ]
        rendered_events = []
        for event in ordered:
            rendered = asdict(event)
            rendered["correlation_ids"] = list(event.correlation_ids)
            rendered_events.append(rendered)
        observed_net = sum(event.amount_delta_minor for event in ordered)
        observed_terminal = ordered[-1].state_after
        traces.append({
            "transaction_id": transaction.transaction_id,
            "currency": transaction.currency,
            "trace": rendered_events,
            "continuity_gaps": continuity_gaps,
            "duplicate_event_ids": duplicate_event_ids,
            "idempotency_reuse": idempotency_reuse,
            "computed": {
                "expected_terminal_state": transaction.expected_terminal_state,
                "observed_terminal_state": observed_terminal,
                "terminal_state_matches": observed_terminal == transaction.expected_terminal_state,
                "expected_net_delta_minor": transaction.expected_net_delta_minor,
                "observed_net_delta_minor": observed_net,
                "net_delta_matches": observed_net == transaction.expected_net_delta_minor,
            },
        })

    return {
        "format": "cyberful.transaction-trace.v1",
        "engagement_id": engagement_id,
        "authorization_reference": authorization_reference,
        "source_sha256": source_sha256,
        "limits": {"transactions": MAX_TRANSACTIONS, "events": MAX_EVENTS, "output_bytes": MAX_OUTPUT_BYTES, "timeout_seconds": TRACE_TIMEOUT_SECONDS},
        "summary": {
            "transaction_count": len(traces),
            "event_count": event_count,
            "transactions_with_continuity_gaps": sum(bool(item["continuity_gaps"]) for item in traces),
            "transactions_with_duplicate_event_ids": sum(bool(item["duplicate_event_ids"]) for item in traces),
            "transactions_with_idempotency_reuse": sum(bool(item["idempotency_reuse"]) for item in traces),
            "terminal_state_mismatches": sum(not item["computed"]["terminal_state_matches"] for item in traces),
            "net_value_mismatches": sum(not item["computed"]["net_delta_matches"] for item in traces),
        },
        "transactions": traces,
        "interpretation": "Deterministic causal trace only; reconcile delivery, retries, deduplication, compensation, settlement, and authoritative ledger state before reaching a fraud or vulnerability conclusion.",
    }


def _write_report(destination: Path, report: dict[str, Any], deadline: float) -> None:
    if not destination.parent.is_dir():
        raise TraceError("output parent must be an existing directory")
    _check_deadline(deadline)
    rendered = f"{json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False)}\n".encode("utf-8")
    _check_deadline(deadline)
    if len(rendered) > MAX_OUTPUT_BYTES:
        raise TraceError(f"rendered trace exceeds the {MAX_OUTPUT_BYTES}-byte limit")
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=destination.parent, prefix=f".{destination.name}.", delete=False) as temporary:
            temporary_name = temporary.name
            os.chmod(temporary_name, 0o600)
            temporary.write(rendered)
            temporary.flush()
            os.fsync(temporary.fileno())
        _check_deadline(deadline)
        os.replace(temporary_name, destination)
        temporary_name = None
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build a deterministic bounded transaction trace from local evidence.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        workspace = _workspace(arguments.workspace)
        payload, raw, source = _read_json(workspace, arguments.input)
        destination = _confined_path(workspace, arguments.output, must_exist=False)
        if destination == source:
            raise TraceError("output must not replace the source evidence")
        deadline = time.monotonic() + TRACE_TIMEOUT_SECONDS
        report = run_trace(payload, hashlib.sha256(raw).hexdigest(), deadline)
        _check_deadline(deadline)
        _write_report(destination, report, deadline)
    except (TraceError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
