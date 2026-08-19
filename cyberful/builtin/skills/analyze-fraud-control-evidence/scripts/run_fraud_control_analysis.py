#!/usr/bin/env python3
# ── Deterministic Fraud Control Evidence Analysis ────────────────
# Validates and compares a bounded local fraud-control observation ledger
#   while preserving raw evidence references and avoiding behavioral verdicts.
# → cyberful/builtin/skills/analyze-fraud-control-evidence/assets/fraud-control-observations.schema.json — input contract.
# → cyberful/builtin/skills/analyze-fraud-control-evidence/tests/test_run_fraud_control_analysis.py — boundary coverage.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
from typing import Any, Final


MAX_INPUT_BYTES: Final = 2_097_152
MAX_OUTPUT_BYTES: Final = 4_194_304
MAX_OBSERVATIONS: Final = 4_096
MAX_EXPECTED_CONTROLS: Final = 256
MAX_TEXT: Final = 2_048
MAX_ID: Final = 256
MAX_LIST_ITEMS: Final = 32
ANALYSIS_TIMEOUT_SECONDS: Final = 10
DECISIONS: Final = ("allow", "challenge", "deny", "review", "error", "not-applicable")
STAGES: Final = frozenset(("enrollment", "authentication", "transaction-initiation", "authorization", "execution", "post-transaction", "recovery", "review"))
OBSERVATION_FIELDS: Final = frozenset(("observation_id", "scenario_id", "control_id", "sequence", "stage", "channel", "actor", "expected_decision", "observed_decision", "reason_codes", "signal_refs", "durable_effect", "evidence_ref"))


class AnalysisError(ValueError):
    """Raised when local evidence violates the bounded analysis contract."""


@dataclass(frozen=True)
class Observation:
    observation_id: str
    scenario_id: str
    control_id: str
    sequence: int
    stage: str
    channel: str
    actor: str
    expected_decision: str
    observed_decision: str
    reason_codes: tuple[str, ...]
    signal_refs: tuple[str, ...]
    durable_effect: str
    evidence_ref: str


def _text(value: Any, label: str, *, maximum: int = MAX_TEXT) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AnalysisError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > maximum or any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise AnalysisError(f"{label} exceeds its text boundary or contains control characters")
    return normalized


def _integer(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 1_000_000_000:
        raise AnalysisError(f"{label} must be an integer between 0 and 1000000000")
    return value


def _text_list(value: Any, label: str, *, maximum_items: int = MAX_LIST_ITEMS, maximum_text: int = MAX_TEXT) -> tuple[str, ...]:
    if not isinstance(value, list) or len(value) > maximum_items:
        raise AnalysisError(f"{label} must be an array with at most {maximum_items} entries")
    normalized = tuple(_text(item, f"{label}[]", maximum=maximum_text) for item in value)
    if len(set(normalized)) != len(normalized):
        raise AnalysisError(f"{label} must not contain duplicates")
    return tuple(sorted(normalized))


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise AnalysisError("workspace must be an existing directory")
    return workspace


def _confined_path(workspace: Path, value: str, *, must_exist: bool) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise AnalysisError("paths must be non-traversing and relative to the workspace")
    cursor = workspace
    for component in requested.parts:
        cursor = cursor / component
        if cursor.is_symlink():
            raise AnalysisError(f"path component is a symbolic link: {component}")
    resolved = (workspace / requested).resolve(strict=must_exist)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise AnalysisError("path escapes the workspace") from error
    return resolved


def _read_json(workspace: Path, value: str) -> tuple[dict[str, Any], bytes, Path]:
    source = _confined_path(workspace, value, must_exist=True)
    metadata = source.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
        raise AnalysisError(f"input must be a regular file no larger than {MAX_INPUT_BYTES} bytes")
    raw = source.read_bytes()
    if len(raw) > MAX_INPUT_BYTES:
        raise AnalysisError(f"input must be no larger than {MAX_INPUT_BYTES} bytes")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AnalysisError("input must be UTF-8 JSON") from error
    if not isinstance(payload, dict):
        raise AnalysisError("input must be a JSON object")
    return payload, raw, source


def _observation(value: Any, index: int, expected_controls: frozenset[str]) -> Observation:
    label = f"observations[{index}]"
    if not isinstance(value, dict) or set(value) != OBSERVATION_FIELDS:
        raise AnalysisError(f"{label} contains missing or unknown fields")
    control_id = _text(value["control_id"], f"{label}.control_id", maximum=MAX_ID)
    if control_id not in expected_controls:
        raise AnalysisError(f"{label}.control_id is not declared in expected_controls")
    stage = _text(value["stage"], f"{label}.stage", maximum=64)
    if stage not in STAGES:
        raise AnalysisError(f"{label}.stage is unsupported")
    expected_decision = _text(value["expected_decision"], f"{label}.expected_decision", maximum=32)
    observed_decision = _text(value["observed_decision"], f"{label}.observed_decision", maximum=32)
    if expected_decision not in DECISIONS or observed_decision not in DECISIONS:
        raise AnalysisError(f"{label} contains an unsupported decision")
    return Observation(
        observation_id=_text(value["observation_id"], f"{label}.observation_id", maximum=MAX_ID),
        scenario_id=_text(value["scenario_id"], f"{label}.scenario_id", maximum=MAX_ID),
        control_id=control_id,
        sequence=_integer(value["sequence"], f"{label}.sequence"),
        stage=stage,
        channel=_text(value["channel"], f"{label}.channel", maximum=MAX_ID),
        actor=_text(value["actor"], f"{label}.actor", maximum=MAX_ID),
        expected_decision=expected_decision,
        observed_decision=observed_decision,
        reason_codes=_text_list(value["reason_codes"], f"{label}.reason_codes"),
        signal_refs=_text_list(value["signal_refs"], f"{label}.signal_refs"),
        durable_effect=_text(value["durable_effect"], f"{label}.durable_effect"),
        evidence_ref=_text(value["evidence_ref"], f"{label}.evidence_ref"),
    )


def _validate_payload(payload: dict[str, Any]) -> tuple[str, str, tuple[str, ...], tuple[Observation, ...]]:
    if set(payload) != {"$schema", "engagement_id", "authorization_reference", "expected_controls", "observations"}:
        raise AnalysisError("input contains missing or unknown fields")
    if payload["$schema"] != "./fraud-control-observations.schema.json":
        raise AnalysisError("$schema must reference ./fraud-control-observations.schema.json")
    expected_controls = _text_list(payload["expected_controls"], "expected_controls", maximum_items=MAX_EXPECTED_CONTROLS, maximum_text=MAX_ID)
    if not expected_controls:
        raise AnalysisError("expected_controls must not be empty")
    raw_observations = payload["observations"]
    if not isinstance(raw_observations, list) or not raw_observations or len(raw_observations) > MAX_OBSERVATIONS:
        raise AnalysisError(f"observations must contain between 1 and {MAX_OBSERVATIONS} entries")
    observations = tuple(_observation(value, index, frozenset(expected_controls)) for index, value in enumerate(raw_observations))
    identifiers = [observation.observation_id for observation in observations]
    if len(set(identifiers)) != len(identifiers):
        raise AnalysisError("observation_id values must be unique")
    return (
        _text(payload["engagement_id"], "engagement_id", maximum=MAX_ID),
        _text(payload["authorization_reference"], "authorization_reference"),
        expected_controls,
        observations,
    )


def _check_deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise AnalysisError("analysis exceeded its global deadline")


def _decision_counts(values: list[str]) -> dict[str, int]:
    counts = Counter(values)
    return {decision: counts[decision] for decision in DECISIONS}


# ── Comparisons Organize Evidence Without Declaring Fraud ────────
# The ledger contains expected and observed control decisions, not ground truth
# about a person's intent. The analyzer therefore emits exact comparisons,
# coverage, and same-scenario conflicts while retaining every evidence pointer.
# Sorting makes equivalent ledgers reproducible across runs and input ordering.
# A reviewer must still reconcile policy versions, enforcement, and durable state
# before treating a mismatch as a security or fraud-control failure.
# ─────────────────────────────────────────────────────────────────
def run_analysis(payload: dict[str, Any], source_sha256: str, deadline: float) -> dict[str, Any]:
    engagement_id, authorization_reference, expected_controls, observations = _validate_payload(payload)
    ordered = tuple(sorted(observations, key=lambda item: (item.scenario_id, item.control_id, item.sequence, item.observation_id)))
    _check_deadline(deadline)

    by_control: dict[str, list[Observation]] = defaultdict(list)
    by_scenario_control: dict[tuple[str, str], list[Observation]] = defaultdict(list)
    analyzed: list[dict[str, Any]] = []
    for observation in ordered:
        _check_deadline(deadline)
        by_control[observation.control_id].append(observation)
        by_scenario_control[(observation.scenario_id, observation.control_id)].append(observation)
        rendered = asdict(observation)
        rendered["reason_codes"] = list(observation.reason_codes)
        rendered["signal_refs"] = list(observation.signal_refs)
        rendered["comparison"] = "match" if observation.expected_decision == observation.observed_decision else "mismatch"
        analyzed.append(rendered)

    control_coverage = []
    for control_id in sorted(by_control):
        _check_deadline(deadline)
        control_observations = by_control[control_id]
        matches = sum(item.expected_decision == item.observed_decision for item in control_observations)
        control_coverage.append({
            "control_id": control_id,
            "observation_count": len(control_observations),
            "stages": sorted({item.stage for item in control_observations}),
            "channels": sorted({item.channel for item in control_observations}),
            "matches": matches,
            "mismatches": len(control_observations) - matches,
        })

    conflicts = []
    for (scenario_id, control_id), grouped in sorted(by_scenario_control.items()):
        _check_deadline(deadline)
        decisions = sorted({item.observed_decision for item in grouped})
        if len(decisions) > 1:
            conflicts.append({
                "scenario_id": scenario_id,
                "control_id": control_id,
                "observed_decisions": decisions,
                "observation_ids": sorted(item.observation_id for item in grouped),
            })

    observed_controls = sorted(by_control)
    matches = sum(item.expected_decision == item.observed_decision for item in ordered)
    return {
        "format": "cyberful.fraud-control-analysis.v1",
        "engagement_id": engagement_id,
        "authorization_reference": authorization_reference,
        "source_sha256": source_sha256,
        "limits": {"observations": MAX_OBSERVATIONS, "output_bytes": MAX_OUTPUT_BYTES, "timeout_seconds": ANALYSIS_TIMEOUT_SECONDS},
        "summary": {
            "observation_count": len(ordered),
            "expected_decisions": _decision_counts([item.expected_decision for item in ordered]),
            "observed_decisions": _decision_counts([item.observed_decision for item in ordered]),
            "matches": matches,
            "mismatches": len(ordered) - matches,
        },
        "coverage": {
            "expected_controls": list(expected_controls),
            "observed_controls": observed_controls,
            "missing_controls": sorted(set(expected_controls) - set(observed_controls)),
            "controls": control_coverage,
        },
        "conflicts": conflicts,
        "observations": analyzed,
        "interpretation": "Deterministic evidence organization only; reconcile policy version, signal freshness, enforcement, and authoritative durable effects before reaching a fraud or vulnerability conclusion.",
    }


def _write_report(destination: Path, report: dict[str, Any], deadline: float) -> None:
    if not destination.parent.is_dir():
        raise AnalysisError("output parent must be an existing directory")
    _check_deadline(deadline)
    rendered = f"{json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False)}\n".encode("utf-8")
    _check_deadline(deadline)
    if len(rendered) > MAX_OUTPUT_BYTES:
        raise AnalysisError(f"rendered analysis exceeds the {MAX_OUTPUT_BYTES}-byte limit")
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
    parser = argparse.ArgumentParser(description="Analyze bounded local fraud-control evidence deterministically.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        workspace = _workspace(arguments.workspace)
        payload, raw, source = _read_json(workspace, arguments.input)
        destination = _confined_path(workspace, arguments.output, must_exist=False)
        if destination == source:
            raise AnalysisError("output must not replace the source evidence")
        deadline = time.monotonic() + ANALYSIS_TIMEOUT_SECONDS
        report = run_analysis(payload, hashlib.sha256(raw).hexdigest(), deadline)
        _check_deadline(deadline)
        _write_report(destination, report, deadline)
    except (AnalysisError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
