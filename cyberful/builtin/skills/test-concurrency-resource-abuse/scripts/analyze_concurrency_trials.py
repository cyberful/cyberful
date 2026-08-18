#!/usr/bin/env python3
# ── Deterministic Concurrency Trial Analysis ────────────────────
# Validates bounded sequential and concurrent trial evidence, classifies durable
# invariant outcomes, and compares matched control groups without generating load.
# → cyberful/builtin/skills/test-concurrency-resource-abuse/assets/concurrency-trials.schema.json — input contract.
# → cyberful/builtin/skills/test-concurrency-resource-abuse/tests/test_analyze_concurrency_trials.py — coverage.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any, Final


MAX_INPUT_BYTES: Final = 4_194_304
MAX_CASES: Final = 20_000
MAX_TEXT: Final = 2_048
MAX_EVIDENCE_REFS: Final = 128
MODES: Final = frozenset(("sequential", "concurrent"))


class TrialError(ValueError):
    """Raised when a trial ledger or path violates the analysis contract."""


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise TrialError("workspace must be an existing directory")
    return workspace


def _confined_path(workspace: Path, value: str, *, must_exist: bool) -> Path:
    canonical_workspace = workspace.resolve(strict=True)
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise TrialError("paths must be non-traversing and relative to the workspace")
    cursor = canonical_workspace
    for component in requested.parts:
        cursor = cursor / component
        if cursor.is_symlink():
            raise TrialError(f"path component is a symbolic link: {component}")
    resolved = (canonical_workspace / requested).resolve(strict=must_exist)
    try:
        resolved.relative_to(canonical_workspace)
    except ValueError as error:
        raise TrialError("path escapes the workspace") from error
    return resolved


def _read(path: Path) -> bytes:
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
        raise TrialError(f"input must be a regular file no larger than {MAX_INPUT_BYTES} bytes")
    raw = path.read_bytes()
    if len(raw) > MAX_INPUT_BYTES:
        raise TrialError(f"input exceeds the {MAX_INPUT_BYTES}-byte limit")
    return raw


def _object(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TrialError("input must be UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise TrialError("trial ledger must be a JSON object")
    return value


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TrialError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > MAX_TEXT or any(ord(character) < 32 for character in normalized):
        raise TrialError(f"{label} exceeds its text boundary or contains control characters")
    return normalized


def _count(value: Any, label: str, *, minimum: int = 0) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > 1_000_000:
        raise TrialError(f"{label} must be an integer between {minimum} and 1000000")
    return value


def _case(value: Any, index: int) -> dict[str, Any]:
    required = {"case_id", "control_group", "invariant", "mode", "attempts", "successful_responses", "durable_effects", "expected_max_durable_effects", "settled", "final_state", "evidence_refs"}
    label = f"cases[{index}]"
    if not isinstance(value, dict) or set(value) != required:
        raise TrialError(f"{label} must contain exactly: {', '.join(sorted(required))}")
    mode = _text(value["mode"], f"{label}.mode")
    if mode not in MODES:
        raise TrialError(f"{label}.mode must be sequential or concurrent")
    if not isinstance(value["settled"], bool):
        raise TrialError(f"{label}.settled must be a boolean")
    evidence_refs = value["evidence_refs"]
    if not isinstance(evidence_refs, list) or not evidence_refs or len(evidence_refs) > MAX_EVIDENCE_REFS:
        raise TrialError(f"{label}.evidence_refs must contain between 1 and {MAX_EVIDENCE_REFS} strings")
    result = {
        "case_id": _text(value["case_id"], f"{label}.case_id"),
        "control_group": _text(value["control_group"], f"{label}.control_group"),
        "invariant": _text(value["invariant"], f"{label}.invariant"),
        "mode": mode,
        "attempts": _count(value["attempts"], f"{label}.attempts", minimum=1),
        "successful_responses": _count(value["successful_responses"], f"{label}.successful_responses"),
        "durable_effects": _count(value["durable_effects"], f"{label}.durable_effects"),
        "expected_max_durable_effects": _count(value["expected_max_durable_effects"], f"{label}.expected_max_durable_effects"),
        "settled": value["settled"],
        "final_state": _text(value["final_state"], f"{label}.final_state"),
        "evidence_refs": [_text(item, f"{label}.evidence_refs[{item_index}]") for item_index, item in enumerate(evidence_refs)],
    }
    if result["successful_responses"] > result["attempts"]:
        raise TrialError(f"{label}.successful_responses cannot exceed attempts")
    return result


# ── Durable State Decides The Mechanical Classification ─────────
# Concurrent success responses can be ambiguous when one operation is later
# rolled back or reconciled. The helper therefore compares only settled durable
# effects with the declared invariant bound, preserving response/state mismatch
# as a separate lead and leaving exploitability and business impact to review.
# ─────────────────────────────────────────────────────────────────
def analyze_trials(payload: dict[str, Any], source_sha256: str) -> dict[str, Any]:
    if set(payload) - {"$schema", "cases"}:
        raise TrialError("trial ledger contains unknown fields")
    raw_cases = payload.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases or len(raw_cases) > MAX_CASES:
        raise TrialError(f"cases must contain between 1 and {MAX_CASES} entries")
    cases = [_case(value, index) for index, value in enumerate(raw_cases)]
    duplicates = sorted(case_id for case_id, count in Counter(case["case_id"] for case in cases).items() if count > 1)
    if duplicates:
        raise TrialError(f"case_id values must be unique: {', '.join(duplicates)}")

    counts: Counter[str] = Counter()
    classified: list[dict[str, Any]] = []
    groups: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for case in cases:
        if not case["settled"]:
            classification = "inconclusive-unsettled"
        elif case["durable_effects"] > case["expected_max_durable_effects"]:
            classification = "invariant-violation-candidate"
        elif case["successful_responses"] > case["expected_max_durable_effects"]:
            classification = "response-state-mismatch"
        else:
            classification = "expected-bound-observed"
        classified_case = {**case, "classification": classification}
        classified.append(classified_case)
        groups[case["control_group"]].append(classified_case)
        counts[classification] += 1

    comparisons = []
    for control_group, group_cases in sorted(groups.items()):
        sequential = [case for case in group_cases if case["mode"] == "sequential" and case["settled"]]
        concurrent = [case for case in group_cases if case["mode"] == "concurrent" and case["settled"]]
        comparisons.append({
            "control_group": control_group,
            "sequential_case_ids": sorted(case["case_id"] for case in sequential),
            "concurrent_case_ids": sorted(case["case_id"] for case in concurrent),
            "sequential_max_durable_effects": max((case["durable_effects"] for case in sequential), default=None),
            "concurrent_max_durable_effects": max((case["durable_effects"] for case in concurrent), default=None),
            "comparison_available": bool(sequential and concurrent),
        })

    classified.sort(key=lambda item: item["case_id"])
    return {
        "format": "cyberful.concurrency-trial-analysis.v1",
        "source_sha256": source_sha256,
        "summary": {
            "case_count": len(cases),
            "expected_bound_observed": counts["expected-bound-observed"],
            "invariant_violation_candidates": counts["invariant-violation-candidate"],
            "response_state_mismatches": counts["response-state-mismatch"],
            "inconclusive": counts["inconclusive-unsettled"],
        },
        "cases": classified,
        "control_group_comparisons": comparisons,
        "interpretation": "Mechanical classifications require reproducibility, causal attribution, durable-state confirmation, and impact analysis before reporting a race or resource-abuse vulnerability.",
    }


def _write_report(workspace: Path, value: str, report: dict[str, Any], source: Path) -> None:
    destination = _confined_path(workspace, value, must_exist=False)
    if destination == source:
        raise TrialError("output must not replace the source trial ledger")
    if not destination.parent.is_dir():
        raise TrialError("output parent must be an existing directory")
    if destination.exists() and not destination.is_file():
        raise TrialError("output must be a regular file or a new path")
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
    parser = argparse.ArgumentParser(description="Analyze bounded sequential and concurrent trial evidence offline.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output")
    arguments = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        workspace = _workspace(arguments.workspace)
        source = _confined_path(workspace, arguments.input, must_exist=True)
        raw = _read(source)
        report = analyze_trials(_object(raw), hashlib.sha256(raw).hexdigest())
        if arguments.output:
            _write_report(workspace, arguments.output, report, source)
        else:
            print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    except (TrialError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
