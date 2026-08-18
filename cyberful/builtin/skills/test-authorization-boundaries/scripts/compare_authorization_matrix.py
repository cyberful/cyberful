#!/usr/bin/env python3
# ── Deterministic Authorization Observation Comparison ──────────
# Validates an offline observation ledger and groups differential outcomes
# without promoting a mechanical comparison into a vulnerability verdict.
# → cyberful/builtin/skills/test-authorization-boundaries/assets/authorization-observations.schema.json — input contract.
# → cyberful/builtin/skills/test-authorization-boundaries/tests/test_compare_authorization_matrix.py — coverage.
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


MAX_INPUT_BYTES: Final = 1_048_576
MAX_OBSERVATIONS: Final = 10_000
MAX_TEXT_CHARACTERS: Final = 1_024
MAX_EVIDENCE_REF_CHARACTERS: Final = 2_048
MAX_PROPERTIES: Final = 256

TEXT_FIELDS: Final = (
    "case_id",
    "actor",
    "identity",
    "tenant",
    "resource",
    "relationship",
    "action",
    "workflow_state",
    "assurance",
    "environment",
    "evidence_ref",
)
OBSERVATION_FIELDS: Final = frozenset((*TEXT_FIELDS, "properties", "expected", "actual"))
EXPECTED_VALUES: Final = frozenset(("allow", "deny"))
ACTUAL_VALUES: Final = frozenset(("allow", "deny", "indeterminate"))


class LedgerError(ValueError):
    """Raised when a ledger or caller-controlled path violates the contract."""


def _confined_path(workspace: Path, value: str, *, must_exist: bool) -> Path:
    canonical_workspace = workspace.resolve(strict=True)
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise LedgerError("input and output paths must be non-traversing paths relative to the workspace")

    candidate = canonical_workspace.joinpath(requested)
    cursor = canonical_workspace
    for component in requested.parts:
        cursor = cursor.joinpath(component)
        if cursor.is_symlink():
            raise LedgerError(f"path component is a symbolic link: {component}")

    resolved = candidate.resolve(strict=must_exist)
    try:
        resolved.relative_to(canonical_workspace)
    except ValueError as error:
        raise LedgerError("path escapes the workspace") from error
    return resolved


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise LedgerError("workspace must be an existing directory")
    return workspace


def _read_payload(workspace: Path, value: str) -> tuple[dict[str, Any], str, Path]:
    source = _confined_path(workspace, value, must_exist=True)
    metadata = source.stat()
    if not stat.S_ISREG(metadata.st_mode):
        raise LedgerError("input must be a regular file")
    if metadata.st_size > MAX_INPUT_BYTES:
        raise LedgerError(f"input exceeds the {MAX_INPUT_BYTES}-byte limit")

    raw = source.read_bytes()
    if len(raw) > MAX_INPUT_BYTES:
        raise LedgerError(f"input exceeds the {MAX_INPUT_BYTES}-byte limit")
    try:
        decoded = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise LedgerError("input must be UTF-8 JSON") from error
    try:
        payload = json.loads(decoded)
    except json.JSONDecodeError as error:
        raise LedgerError(f"input is not valid JSON: {error.msg}") from error
    if not isinstance(payload, dict):
        raise LedgerError("ledger must be a JSON object")
    return payload, hashlib.sha256(raw).hexdigest(), source


def _text(value: Any, label: str, *, limit: int = MAX_TEXT_CHARACTERS) -> str:
    if not isinstance(value, str) or not value.strip():
        raise LedgerError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > limit or any(ord(character) < 32 for character in normalized):
        raise LedgerError(f"{label} exceeds its text boundary or contains control characters")
    return normalized


def _observation(value: Any, index: int) -> dict[str, Any]:
    label = f"observations[{index}]"
    if not isinstance(value, dict):
        raise LedgerError(f"{label} must be an object")
    unknown = set(value) - OBSERVATION_FIELDS
    missing = OBSERVATION_FIELDS - set(value)
    if unknown:
        raise LedgerError(f"{label} contains unknown fields: {', '.join(sorted(unknown))}")
    if missing:
        raise LedgerError(f"{label} is missing fields: {', '.join(sorted(missing))}")

    result = {field: _text(value[field], f"{label}.{field}") for field in TEXT_FIELDS}
    result["evidence_ref"] = _text(
        value["evidence_ref"],
        f"{label}.evidence_ref",
        limit=MAX_EVIDENCE_REF_CHARACTERS,
    )

    properties = value["properties"]
    if not isinstance(properties, list) or len(properties) > MAX_PROPERTIES:
        raise LedgerError(f"{label}.properties must be an array of at most {MAX_PROPERTIES} strings")
    result["properties"] = [
        _text(property_name, f"{label}.properties[{property_index}]")
        for property_index, property_name in enumerate(properties)
    ]

    expected = value["expected"]
    actual = value["actual"]
    if expected not in EXPECTED_VALUES:
        raise LedgerError(f"{label}.expected must be allow or deny")
    if actual not in ACTUAL_VALUES:
        raise LedgerError(f"{label}.actual must be allow, deny, or indeterminate")
    result["expected"] = expected
    result["actual"] = actual
    return result


def compare_ledger(payload: dict[str, Any], source_sha256: str) -> dict[str, Any]:
    unknown = set(payload) - {"$schema", "observations"}
    if unknown:
        raise LedgerError(f"ledger contains unknown fields: {', '.join(sorted(unknown))}")
    observations = payload.get("observations")
    if not isinstance(observations, list) or len(observations) > MAX_OBSERVATIONS:
        raise LedgerError(f"observations must be an array of at most {MAX_OBSERVATIONS} entries")

    normalized = [_observation(observation, index) for index, observation in enumerate(observations)]
    case_ids = [observation["case_id"] for observation in normalized]
    duplicates = sorted(case_id for case_id, count in Counter(case_ids).items() if count > 1)
    if duplicates:
        raise LedgerError(f"case_id values must be unique: {', '.join(duplicates)}")

    controls: list[dict[str, Any]] = []
    violations: list[dict[str, Any]] = []
    inconclusive: list[dict[str, Any]] = []
    for observation in normalized:
        actual = observation["actual"]
        expected = observation["expected"]
        if actual == "indeterminate":
            inconclusive.append({**observation, "classification": "inconclusive"})
        elif actual == expected:
            controls.append({**observation, "classification": "expected-decision-observed"})
        elif expected == "deny":
            violations.append({**observation, "classification": "authorization-bypass-candidate"})
        else:
            violations.append({**observation, "classification": "authorization-regression"})

    return {
        "format": "cyberful.authorization-comparison.v1",
        "source_sha256": source_sha256,
        "summary": {
            "total": len(normalized),
            "controls": len(controls),
            "violations": len(violations),
            "inconclusive": len(inconclusive),
        },
        "controls": controls,
        "violations": violations,
        "inconclusive": inconclusive,
        "interpretation": (
            "Mechanical classifications organize observed decisions only; confirm authorization policy, reproducibility, "
            "security effect, and impact before reporting a vulnerability."
        ),
    }


def _write_report(workspace: Path, value: str, report: dict[str, Any], source: Path) -> None:
    destination = _confined_path(workspace, value, must_exist=False)
    if destination == source:
        raise LedgerError("output must not replace the source observation ledger")
    if not destination.parent.is_dir():
        raise LedgerError("output parent must be an existing directory")
    if destination.exists() and not destination.is_file():
        raise LedgerError("output must be a regular file or a new path")

    rendered = f"{json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False)}\n"
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            delete=False,
        ) as temporary:
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


def _arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare a Cyberful authorization-observation ledger offline.")
    parser.add_argument("--workspace", default=".", help="Workspace that confines input and output paths.")
    parser.add_argument("--input", required=True, help="Workspace-relative observation ledger.")
    parser.add_argument("--output", help="Workspace-relative report path; omit to write JSON to stdout.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    arguments = _arguments(sys.argv[1:] if argv is None else argv)
    try:
        workspace = _workspace(arguments.workspace)
        payload, source_sha256, source = _read_payload(workspace, arguments.input)
        report = compare_ledger(payload, source_sha256)
        if arguments.output:
            _write_report(workspace, arguments.output, report, source)
        else:
            print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    except (LedgerError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
