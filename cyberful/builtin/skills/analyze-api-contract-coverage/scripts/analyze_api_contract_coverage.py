#!/usr/bin/env python3
# ── Offline API Contract Coverage ───────────────────────────────
# Reconciles bounded OpenAPI JSON contracts with normalized implementation
#   and observation inventories without processes, network, or inference.
# → cyberful/builtin/skills/analyze-api-contract-coverage/assets/api-contract-coverage-input.schema.json — input contract.
# → cyberful/builtin/skills/analyze-api-contract-coverage/tests/test_analyze_api_contract_coverage.py — boundary tests.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
from dataclasses import dataclass
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


MAX_INPUT_BYTES: Final = 1_048_576
MAX_CONTRACT_BYTES: Final = 4_194_304
MAX_TOTAL_CONTRACT_BYTES: Final = 16_777_216
MAX_OUTPUT_BYTES: Final = 4_194_304
MAX_CONTRACTS: Final = 32
MAX_OPERATIONS: Final = 10_000
ANALYSIS_TIMEOUT_SECONDS: Final = 30
HTTP_METHODS: Final = frozenset({"get", "head", "post", "put", "patch", "delete", "options", "trace"})
OPERATION_KEY: Final = re.compile(r"^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE) /\S*$")


class AnalysisError(ValueError):
    """Raised when input, evidence, or output violates analysis bounds."""


@dataclass(frozen=True)
class Operation:
    key: str
    source: str
    pointer: str
    security: str


# ── Contract Files Are Evidence, Not An Import Graph ────────────
# Contract paths are confined below the staged workspace and every traversed
# component must be a real non-symlink file. The analyzer never follows remote
# references or local `$ref` targets, so a contract cannot expand the read set
# after the model-visible input has passed validation. File and operation caps
# bound both memory use and the evidence emitted from hostile specifications.
# ─────────────────────────────────────────────────────────────────


def _workspace(value: str) -> Path:
    path = Path(value).resolve(strict=True)
    if not path.is_dir():
        raise AnalysisError("workspace must be an existing directory")
    return path


def _confined(workspace: Path, value: str, *, exists: bool) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise AnalysisError("paths must be relative and non-traversing")
    cursor = workspace
    for part in requested.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise AnalysisError("symbolic links are not allowed")
    resolved = (workspace / requested).resolve(strict=exists)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise AnalysisError("path escapes workspace") from error
    return resolved


def _read_json(path: Path, maximum: int) -> tuple[dict[str, Any], bytes]:
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > maximum:
        raise AnalysisError("input must be a bounded regular file")
    raw = path.read_bytes()
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AnalysisError(f"{path.name} must be UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise AnalysisError(f"{path.name} must contain a JSON object")
    return value, raw


def _operation_inventory(value: Any, label: str) -> frozenset[str]:
    if not isinstance(value, list) or len(value) > MAX_OPERATIONS:
        raise AnalysisError(f"{label} must be an array with at most {MAX_OPERATIONS} entries")
    if not all(isinstance(item, str) and OPERATION_KEY.fullmatch(item) for item in value):
        raise AnalysisError(f"{label} contains a non-canonical operation key")
    if len(set(value)) != len(value):
        raise AnalysisError(f"{label} must not contain duplicates")
    return frozenset(value)


def _request(payload: dict[str, Any]) -> tuple[list[str], frozenset[str], frozenset[str]]:
    if set(payload) != {"contract_files", "implementation_operations", "observed_operations"}:
        raise AnalysisError("input contract is malformed")
    files = payload["contract_files"]
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_CONTRACTS or not all(isinstance(item, str) and item for item in files):
        raise AnalysisError("contract_files must be a bounded non-empty string array")
    if len(set(files)) != len(files):
        raise AnalysisError("contract_files must not contain duplicates")
    implementation = _operation_inventory(payload["implementation_operations"], "implementation_operations")
    observed = _operation_inventory(payload["observed_operations"], "observed_operations")
    return sorted(files), implementation, observed


def _security(document: dict[str, Any], operation: dict[str, Any]) -> str:
    value = operation["security"] if "security" in operation else document.get("security")
    if value is None:
        return "unspecified"
    if not isinstance(value, list) or not all(isinstance(requirement, dict) for requirement in value):
        raise AnalysisError("OpenAPI security must be an array of requirement objects")
    return "explicitly-anonymous" if not value or any(not requirement for requirement in value) else "declared"


def _contract_operations(document: dict[str, Any], source: str) -> list[Operation]:
    openapi = document.get("openapi")
    swagger = document.get("swagger")
    if not ((isinstance(openapi, str) and openapi.startswith("3.")) or swagger == "2.0"):
        raise AnalysisError(f"{source} must be OpenAPI 3.x or Swagger 2.0 JSON")
    paths = document.get("paths")
    if not isinstance(paths, dict):
        raise AnalysisError(f"{source} paths must be an object")
    operations: list[Operation] = []
    for path_name in sorted(paths):
        path_item = paths[path_name]
        if not isinstance(path_name, str) or not path_name.startswith("/") or not isinstance(path_item, dict):
            raise AnalysisError(f"{source} contains a malformed path item")
        escaped_path = path_name.replace("~", "~0").replace("/", "~1")
        for method in sorted(HTTP_METHODS.intersection(path_item)):
            operation = path_item[method]
            if not isinstance(operation, dict):
                raise AnalysisError(f"{source} operation {method.upper()} {path_name} must be an object")
            key = f"{method.upper()} {path_name}"
            operations.append(Operation(key, source, f"#/paths/{escaped_path}/{method}", _security(document, operation)))
            if len(operations) > MAX_OPERATIONS:
                raise AnalysisError("contract operation count exceeds its boundary")
    return operations


def _check_deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise AnalysisError("API contract analysis exceeded its global deadline")


def run_analysis(
    payload: dict[str, Any],
    digest: str,
    workspace: Path,
    *,
    deadline_seconds: float = ANALYSIS_TIMEOUT_SECONDS,
    output_limit_bytes: int = MAX_OUTPUT_BYTES,
    deadline: float | None = None,
) -> dict[str, Any]:
    workspace = workspace.resolve(strict=True)
    deadline = time.monotonic() + deadline_seconds if deadline is None else deadline
    files, implementation, observed = _request(payload)
    _check_deadline(deadline)
    operations: dict[str, Operation] = {}
    contracts: list[dict[str, Any]] = []
    total_bytes = 0
    for relative in files:
        _check_deadline(deadline)
        path = _confined(workspace, relative, exists=True)
        document, raw = _read_json(path, MAX_CONTRACT_BYTES)
        total_bytes += len(raw)
        if total_bytes > MAX_TOTAL_CONTRACT_BYTES:
            raise AnalysisError("contract bytes exceed the cumulative input boundary")
        extracted = _contract_operations(document, relative)
        for operation in extracted:
            if operation.key in operations:
                raise AnalysisError(f"operation collision across contracts: {operation.key}")
            operations[operation.key] = operation
        contracts.append({"path": relative, "sha256": hashlib.sha256(raw).hexdigest(), "operations": len(extracted)})
    contract_keys = frozenset(operations)
    rows = [{"key": item.key, "source": item.source, "pointer": item.pointer, "security": item.security} for item in sorted(operations.values(), key=lambda item: item.key)]
    gaps = {
        "undocumented_implementation": sorted(implementation - contract_keys),
        "unimplemented_contract": sorted(contract_keys - implementation),
        "unexercised_contract": sorted(contract_keys - observed),
        "explicitly_anonymous": sorted(item.key for item in operations.values() if item.security == "explicitly-anonymous"),
    }
    report = {
        "format": "cyberful.api-contract-coverage.raw.v1",
        "input_sha256": digest,
        "contracts": contracts,
        "operations": rows,
        "gaps": gaps,
        "counts": {"contracts": len(contracts), "contract_operations": len(contract_keys), "implementation_operations": len(implementation), "observed_operations": len(observed)},
    }
    _check_deadline(deadline)
    rendered = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode()
    if not 1 <= output_limit_bytes <= MAX_OUTPUT_BYTES or len(rendered) > output_limit_bytes:
        raise AnalysisError("coverage evidence exceeds the output boundary")
    return report


def _write(path: Path, value: dict[str, Any], deadline: float) -> None:
    _check_deadline(deadline)
    if path.exists():
        raise AnalysisError("output path already exists")
    rendered = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    if len(rendered) > MAX_OUTPUT_BYTES:
        raise AnalysisError("coverage evidence exceeds the output boundary")
    _check_deadline(deadline)
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
            temporary = handle.name
            os.chmod(temporary, 0o600)
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        _check_deadline(deadline)
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary:
            Path(temporary).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Analyze bounded OpenAPI JSON coverage offline.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(argv)
    try:
        deadline = time.monotonic() + ANALYSIS_TIMEOUT_SECONDS
        workspace = _workspace(arguments.workspace)
        source = _confined(workspace, arguments.input, exists=True)
        destination = _confined(workspace, arguments.output, exists=False)
        if source == destination or not destination.parent.is_dir() or destination.exists():
            raise AnalysisError("output must be new, distinct, and below an existing directory")
        payload, raw = _read_json(source, MAX_INPUT_BYTES)
        _check_deadline(deadline)
        report = run_analysis(payload, hashlib.sha256(raw).hexdigest(), workspace, deadline=deadline)
        _write(destination, report, deadline)
        return 0
    except (AnalysisError, OSError) as error:
        print(f"API contract coverage error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
