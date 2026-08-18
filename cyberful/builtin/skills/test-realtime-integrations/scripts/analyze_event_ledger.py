#!/usr/bin/env python3
# ── Deterministic Realtime Event Ledger Analysis ────────────────
# Validates bounded stream observations and identifies delivery-policy mismatch,
# duplicate, missing, reordered, and replayed event evidence without connecting.
# → cyberful/builtin/skills/test-realtime-integrations/assets/event-ledger.schema.json — input contract.
# → cyberful/builtin/skills/test-realtime-integrations/tests/test_analyze_event_ledger.py — coverage.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any, Final


MAX_INPUT_BYTES: Final = 8_388_608
MAX_STREAMS: Final = 10_000
MAX_OBSERVATIONS: Final = 250_000
MAX_EXPECTED_EVENTS: Final = 100_000
MAX_TEXT: Final = 2_048
EXPECTED_VALUES: Final = frozenset(("deliver", "reject"))
ACTUAL_VALUES: Final = frozenset(("delivered", "rejected", "indeterminate"))


class EventLedgerError(ValueError):
    """Raised when an event ledger or path violates the analysis contract."""


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise EventLedgerError("workspace must be an existing directory")
    return workspace


def _confined_path(workspace: Path, value: str, *, must_exist: bool) -> Path:
    canonical_workspace = workspace.resolve(strict=True)
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise EventLedgerError("paths must be non-traversing and relative to the workspace")
    cursor = canonical_workspace
    for component in requested.parts:
        cursor = cursor / component
        if cursor.is_symlink():
            raise EventLedgerError(f"path component is a symbolic link: {component}")
    resolved = (canonical_workspace / requested).resolve(strict=must_exist)
    try:
        resolved.relative_to(canonical_workspace)
    except ValueError as error:
        raise EventLedgerError("path escapes the workspace") from error
    return resolved


def _read(path: Path) -> bytes:
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
        raise EventLedgerError(f"input must be a regular file no larger than {MAX_INPUT_BYTES} bytes")
    raw = path.read_bytes()
    if len(raw) > MAX_INPUT_BYTES:
        raise EventLedgerError(f"input exceeds the {MAX_INPUT_BYTES}-byte limit")
    return raw


def _object(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EventLedgerError("input must be UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise EventLedgerError("event ledger must be a JSON object")
    return value


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EventLedgerError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > MAX_TEXT or any(ord(character) < 32 for character in normalized):
        raise EventLedgerError(f"{label} exceeds its text boundary or contains control characters")
    return normalized


def _integer(value: Any, label: str, *, nullable: bool = False) -> int | None:
    if nullable and value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 1_000_000_000:
        raise EventLedgerError(f"{label} must be a non-negative bounded integer")
    return value


def _observation(value: Any, stream_index: int, observation_index: int) -> dict[str, Any]:
    required = {"observation_id", "event_id", "sequence", "delivery_order", "expected", "actual", "replay", "evidence_ref"}
    label = f"streams[{stream_index}].observations[{observation_index}]"
    if not isinstance(value, dict) or set(value) != required:
        raise EventLedgerError(f"{label} must contain exactly: {', '.join(sorted(required))}")
    expected = _text(value["expected"], f"{label}.expected")
    actual = _text(value["actual"], f"{label}.actual")
    if expected not in EXPECTED_VALUES or actual not in ACTUAL_VALUES:
        raise EventLedgerError(f"{label} contains an unsupported expected or actual decision")
    if not isinstance(value["replay"], bool):
        raise EventLedgerError(f"{label}.replay must be a boolean")
    return {
        "observation_id": _text(value["observation_id"], f"{label}.observation_id"),
        "event_id": _text(value["event_id"], f"{label}.event_id"),
        "sequence": _integer(value["sequence"], f"{label}.sequence", nullable=True),
        "delivery_order": _integer(value["delivery_order"], f"{label}.delivery_order"),
        "expected": expected,
        "actual": actual,
        "replay": value["replay"],
        "evidence_ref": _text(value["evidence_ref"], f"{label}.evidence_ref"),
    }


def _stream(value: Any, index: int) -> dict[str, Any]:
    required = {"stream_id", "principal", "tenant", "channel", "expected_event_ids", "observations"}
    label = f"streams[{index}]"
    if not isinstance(value, dict) or set(value) != required:
        raise EventLedgerError(f"{label} must contain exactly: {', '.join(sorted(required))}")
    expected_events = value["expected_event_ids"]
    observations = value["observations"]
    if not isinstance(expected_events, list) or len(expected_events) > MAX_EXPECTED_EVENTS:
        raise EventLedgerError(f"{label}.expected_event_ids must be an array of at most {MAX_EXPECTED_EVENTS} strings")
    if not isinstance(observations, list):
        raise EventLedgerError(f"{label}.observations must be an array")
    normalized_expected = [_text(item, f"{label}.expected_event_ids[{item_index}]") for item_index, item in enumerate(expected_events)]
    if len(normalized_expected) != len(set(normalized_expected)):
        raise EventLedgerError(f"{label}.expected_event_ids must be unique")
    normalized_observations = [_observation(item, index, item_index) for item_index, item in enumerate(observations)]
    observation_ids = [item["observation_id"] for item in normalized_observations]
    if len(observation_ids) != len(set(observation_ids)):
        raise EventLedgerError("observation_id values must be unique")
    delivery_orders = [item["delivery_order"] for item in normalized_observations]
    if len(delivery_orders) != len(set(delivery_orders)):
        raise EventLedgerError(f"{label}.observations must use unique delivery_order values")
    return {
        "stream_id": _text(value["stream_id"], f"{label}.stream_id"),
        "principal": _text(value["principal"], f"{label}.principal"),
        "tenant": _text(value["tenant"], f"{label}.tenant"),
        "channel": _text(value["channel"], f"{label}.channel"),
        "expected_event_ids": normalized_expected,
        "observations": normalized_observations,
    }


# ── Stream Anomalies Remain Typed Leads ─────────────────────────
# Duplicate delivery, replay, and sequence reversal have different causes and
# impact. The analyzer keeps them separate from explicit policy mismatches and
# missing expected events, so retry semantics or at-least-once delivery are not
# silently promoted into authorization or integrity vulnerabilities.
# ─────────────────────────────────────────────────────────────────
def analyze_ledger(payload: dict[str, Any], source_sha256: str) -> dict[str, Any]:
    if set(payload) - {"$schema", "streams"}:
        raise EventLedgerError("event ledger contains unknown fields")
    raw_streams = payload.get("streams")
    if not isinstance(raw_streams, list) or not raw_streams or len(raw_streams) > MAX_STREAMS:
        raise EventLedgerError(f"streams must contain between 1 and {MAX_STREAMS} entries")
    streams = [_stream(value, index) for index, value in enumerate(raw_streams)]
    if len({stream["stream_id"] for stream in streams}) != len(streams):
        raise EventLedgerError("stream ids must be unique")
    observation_ids = [observation["observation_id"] for stream in streams for observation in stream["observations"]]
    if len(observation_ids) > MAX_OBSERVATIONS:
        raise EventLedgerError(f"observations exceed the {MAX_OBSERVATIONS}-entry limit")
    duplicates = sorted(identifier for identifier, count in Counter(observation_ids).items() if count > 1)
    if duplicates:
        raise EventLedgerError(f"observation_id values must be unique: {', '.join(duplicates)}")

    summary: Counter[str] = Counter()
    analyzed_streams: list[dict[str, Any]] = []
    for stream in streams:
        classified = []
        for observation in stream["observations"]:
            if observation["actual"] == "indeterminate":
                classification = "inconclusive"
            elif observation["expected"] == "reject" and observation["actual"] == "delivered":
                classification = "unexpected-delivery-candidate"
            elif observation["expected"] == "deliver" and observation["actual"] == "rejected":
                classification = "delivery-regression"
            else:
                classification = "expected-decision-observed"
            classified.append({**observation, "classification": classification})
            summary[classification] += 1

        delivered = sorted((item for item in classified if item["actual"] == "delivered"), key=lambda item: (item["delivery_order"], item["observation_id"]))
        delivered_counts = Counter(item["event_id"] for item in delivered)
        duplicate_event_ids = sorted(event_id for event_id, count in delivered_counts.items() if count > 1)
        delivered_event_ids = set(delivered_counts)
        missing_event_ids = sorted(set(stream["expected_event_ids"]) - delivered_event_ids)
        unexpected_event_ids = sorted(delivered_event_ids - set(stream["expected_event_ids"]))
        replay_delivery_ids = sorted(item["observation_id"] for item in delivered if item["replay"])
        reordered_observation_ids: list[str] = []
        prior_sequence: int | None = None
        for observation in delivered:
            sequence = observation["sequence"]
            if sequence is None:
                continue
            if prior_sequence is not None and sequence < prior_sequence:
                reordered_observation_ids.append(observation["observation_id"])
            prior_sequence = sequence if prior_sequence is None else max(prior_sequence, sequence)

        summary["duplicate_event_ids"] += len(duplicate_event_ids)
        summary["missing_event_ids"] += len(missing_event_ids)
        summary["unexpected_event_ids"] += len(unexpected_event_ids)
        summary["replay_deliveries"] += len(replay_delivery_ids)
        summary["reordered_observations"] += len(reordered_observation_ids)
        analyzed_streams.append({
            **{key: value for key, value in stream.items() if key != "observations"},
            "observations": sorted(classified, key=lambda item: item["observation_id"]),
            "duplicate_event_ids": duplicate_event_ids,
            "missing_event_ids": missing_event_ids,
            "unexpected_event_ids": unexpected_event_ids,
            "replay_delivery_observation_ids": replay_delivery_ids,
            "reordered_observation_ids": reordered_observation_ids,
        })

    analyzed_streams.sort(key=lambda item: item["stream_id"])
    return {
        "format": "cyberful.event-ledger-analysis.v1",
        "source_sha256": source_sha256,
        "summary": {
            "stream_count": len(streams),
            "observation_count": len(observation_ids),
            "expected_decisions": summary["expected-decision-observed"],
            "unexpected_delivery_candidates": summary["unexpected-delivery-candidate"],
            "delivery_regressions": summary["delivery-regression"],
            "inconclusive": summary["inconclusive"],
            "duplicate_event_ids": summary["duplicate_event_ids"],
            "missing_event_ids": summary["missing_event_ids"],
            "unexpected_event_ids": summary["unexpected_event_ids"],
            "replay_deliveries": summary["replay_deliveries"],
            "reordered_observations": summary["reordered_observations"],
        },
        "streams": analyzed_streams,
        "interpretation": "Event anomalies require protocol semantics, retry guarantees, current authorization, durable effects, and causal reproduction before a vulnerability conclusion.",
    }


def _write_report(workspace: Path, value: str, report: dict[str, Any], source: Path) -> None:
    destination = _confined_path(workspace, value, must_exist=False)
    if destination == source:
        raise EventLedgerError("output must not replace the source event ledger")
    if not destination.parent.is_dir():
        raise EventLedgerError("output parent must be an existing directory")
    if destination.exists() and not destination.is_file():
        raise EventLedgerError("output must be a regular file or a new path")
    rendered = f"{json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False)}\n"
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=destination.parent, prefix=f".{destination.name}.", delete=False) as temporary:
            temporary_name = temporary.name
            os.chmod(temporary_name, 0o600)
            temporary.write(rendered)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, destination)
        temporary_name = None
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Analyze realtime event observations offline.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output")
    arguments = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        workspace = _workspace(arguments.workspace)
        source = _confined_path(workspace, arguments.input, must_exist=True)
        raw = _read(source)
        report = analyze_ledger(_object(raw), hashlib.sha256(raw).hexdigest())
        if arguments.output:
            _write_report(workspace, arguments.output, report, source)
        else:
            print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    except (EventLedgerError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
