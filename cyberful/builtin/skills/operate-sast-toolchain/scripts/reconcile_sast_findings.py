#!/usr/bin/env python3
# ── Offline SAST Finding Reconciliation ─────────────────────────
# Normalizes bounded Semgrep JSON and SARIF evidence into stable fingerprints,
# preserving scanner provenance, duplicates, and reported execution errors.
# → cyberful/builtin/skills/operate-sast-toolchain/assets/sast-run-manifest.schema.json — input contract.
# → cyberful/builtin/skills/operate-sast-toolchain/tests/test_reconcile_sast_findings.py — coverage.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import os
import stat
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Final
from urllib.parse import unquote, urlparse


MAX_MANIFEST_BYTES: Final = 1_048_576
MAX_SOURCE_BYTES: Final = 64_000_000
MAX_SOURCES: Final = 32
MAX_FINDINGS: Final = 250_000
MAX_ERRORS: Final = 10_000
MAX_TEXT: Final = 4_096
SOURCE_KINDS: Final = frozenset(("semgrep-json", "sarif"))


class SastError(ValueError):
    """Raised when scanner evidence violates the reconciliation contract."""


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise SastError("workspace must be an existing directory")
    return workspace


def _confined_path(workspace: Path, value: str, *, must_exist: bool) -> Path:
    canonical_workspace = workspace.resolve(strict=True)
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise SastError("paths must be non-traversing and relative to the workspace")
    cursor = canonical_workspace
    for component in requested.parts:
        cursor = cursor / component
        if cursor.is_symlink():
            raise SastError(f"path component is a symbolic link: {component}")
    resolved = (canonical_workspace / requested).resolve(strict=must_exist)
    try:
        resolved.relative_to(canonical_workspace)
    except ValueError as error:
        raise SastError("path escapes the workspace") from error
    return resolved


def _read(path: Path, limit: int) -> bytes:
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
        raise SastError(f"{path.name} must be a regular file no larger than {limit} bytes")
    raw = path.read_bytes()
    if len(raw) > limit:
        raise SastError(f"{path.name} exceeds the {limit}-byte limit")
    return raw


def _object(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SastError(f"{label} must be UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise SastError(f"{label} must be a JSON object")
    return value


def _text(value: Any, label: str, *, optional: bool = False) -> str:
    if optional and (value is None or value == ""):
        return ""
    if not isinstance(value, str) or not value.strip():
        raise SastError(f"{label} must be a non-empty string")
    normalized = " ".join(value.split())
    if len(normalized) > MAX_TEXT:
        normalized = f"{normalized[: MAX_TEXT - 1].rstrip()}…"
    if any(ord(character) < 32 for character in normalized):
        raise SastError(f"{label} contains control characters")
    return normalized


def _source(value: Any, index: int) -> dict[str, str]:
    required = {"id", "kind", "path", "scanner", "source_root"}
    label = f"sources[{index}]"
    if not isinstance(value, dict) or set(value) != required:
        raise SastError(f"{label} must contain exactly: {', '.join(sorted(required))}")
    if not isinstance(value["source_root"], str):
        raise SastError(f"{label}.source_root must be a string")
    result = {field: _text(value[field], f"{label}.{field}", optional=field == "source_root") for field in required}
    if result["kind"] not in SOURCE_KINDS:
        raise SastError(f"{label}.kind must be semgrep-json or sarif")
    return result


def _line(value: Any, label: str) -> int:
    if value is None:
        return 0
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise SastError(f"{label} must be a non-negative integer")
    return value


def _portable_path(value: Any, source_root: str) -> tuple[str, bool]:
    raw = _text(value, "reported artifact path", optional=True)
    if not raw:
        return "unknown", False
    parsed = urlparse(raw)
    decoded = unquote(parsed.path if parsed.scheme == "file" else raw).replace("\\", "/")
    normalized_root = source_root.replace("\\", "/").rstrip("/")
    if normalized_root and (decoded == normalized_root or decoded.startswith(f"{normalized_root}/")):
        relative = decoded[len(normalized_root) :].lstrip("/") or "."
        return PurePosixPath(relative).as_posix(), False
    if decoded.startswith("/") or (len(decoded) > 2 and decoded[1] == ":"):
        return PurePosixPath(decoded).name or "unknown", True
    if ".." in PurePosixPath(decoded).parts:
        return PurePosixPath(decoded).name or "unknown", True
    return PurePosixPath(decoded).as_posix(), False


def _finding(source: dict[str, str], rule_id: Any, path: Any, start: Any, end: Any, message: Any, severity: Any) -> dict[str, Any]:
    portable_path, path_redacted = _portable_path(path, source["source_root"])
    normalized = {
        "rule_id": _text(rule_id, "rule id", optional=True) or "unknown-rule",
        "path": portable_path,
        "path_redacted": path_redacted,
        "start_line": _line(start, "start line"),
        "end_line": _line(end, "end line"),
        "message": _text(message, "message", optional=True),
        "severity": _text(severity, "severity", optional=True).lower(),
        "scanner": source["scanner"],
        "source_id": source["id"],
    }
    material = "\0".join((normalized["rule_id"], normalized["path"], str(normalized["start_line"]), str(normalized["end_line"]), normalized["message"]))
    return {"fingerprint": hashlib.sha256(material.encode("utf-8")).hexdigest(), **normalized}


def _semgrep(payload: dict[str, Any], source: dict[str, str]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    raw_results = payload.get("results", [])
    raw_errors = payload.get("errors", [])
    if not isinstance(raw_results, list) or not isinstance(raw_errors, list):
        raise SastError("Semgrep results and errors must be arrays")
    findings: list[dict[str, Any]] = []
    for index, result in enumerate(raw_results):
        if not isinstance(result, dict):
            raise SastError(f"Semgrep results[{index}] must be an object")
        extra = result.get("extra", {})
        start = result.get("start", {})
        end = result.get("end", {})
        if not isinstance(extra, dict) or not isinstance(start, dict) or not isinstance(end, dict):
            raise SastError(f"Semgrep results[{index}] contains malformed location or metadata")
        findings.append(_finding(source, result.get("check_id"), result.get("path"), start.get("line"), end.get("line"), extra.get("message"), extra.get("severity")))
    errors = [
        {"source_id": source["id"], "message": _text(error.get("message"), "Semgrep error", optional=True) if isinstance(error, dict) else _text(str(error), "Semgrep error")}
        for error in raw_errors
    ]
    return findings, errors


def _sarif(payload: dict[str, Any], source: dict[str, str]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    runs = payload.get("runs")
    if not isinstance(runs, list):
        raise SastError("SARIF must contain a runs array")
    findings: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for run_index, run in enumerate(runs):
        if not isinstance(run, dict):
            raise SastError(f"SARIF runs[{run_index}] must be an object")
        results = run.get("results", [])
        if not isinstance(results, list):
            raise SastError(f"SARIF runs[{run_index}].results must be an array")
        for result_index, result in enumerate(results):
            if not isinstance(result, dict):
                raise SastError(f"SARIF result {run_index}:{result_index} must be an object")
            message = result.get("message", {})
            locations = result.get("locations", [])
            physical: dict[str, Any] = {}
            if isinstance(locations, list) and locations and isinstance(locations[0], dict):
                candidate = locations[0].get("physicalLocation", {})
                physical = candidate if isinstance(candidate, dict) else {}
            artifact = physical.get("artifactLocation", {})
            region = physical.get("region", {})
            findings.append(
                _finding(
                    source,
                    result.get("ruleId"),
                    artifact.get("uri") if isinstance(artifact, dict) else None,
                    region.get("startLine") if isinstance(region, dict) else None,
                    region.get("endLine") if isinstance(region, dict) else None,
                    message.get("text") if isinstance(message, dict) else None,
                    result.get("level"),
                )
            )
        invocations = run.get("invocations", [])
        if isinstance(invocations, list):
            for invocation in invocations:
                if isinstance(invocation, dict) and invocation.get("executionSuccessful") is False:
                    errors.append({"source_id": source["id"], "message": "SARIF invocation reported executionSuccessful=false"})
    return findings, errors


# ── Fingerprints Collapse Evidence, Not Security Meaning ─────────
# Exact rule, portable path, location, and normalized message identify repeated
# scanner observations. Sources are merged only for that mechanical identity;
# reachability, authority, exploitability, and scanner-specific semantics remain
# outside this helper and require source review or runtime confirmation.
# ─────────────────────────────────────────────────────────────────
def reconcile_manifest(payload: dict[str, Any], workspace: Path, manifest_sha256: str) -> dict[str, Any]:
    if set(payload) - {"$schema", "sources"}:
        raise SastError("manifest contains unknown fields")
    raw_sources = payload.get("sources")
    if not isinstance(raw_sources, list) or not raw_sources or len(raw_sources) > MAX_SOURCES:
        raise SastError(f"sources must contain between 1 and {MAX_SOURCES} entries")
    sources = [_source(value, index) for index, value in enumerate(raw_sources)]
    if len({source["id"] for source in sources}) != len(sources):
        raise SastError("source ids must be unique")

    all_findings: list[dict[str, Any]] = []
    all_errors: list[dict[str, str]] = []
    digests: list[dict[str, str]] = []
    for source in sources:
        path = _confined_path(workspace, source["path"], must_exist=True)
        raw = _read(path, MAX_SOURCE_BYTES)
        digests.append({"id": source["id"], "sha256": hashlib.sha256(raw).hexdigest()})
        parsed = _object(raw, f"source {source['id']}")
        findings, errors = _semgrep(parsed, source) if source["kind"] == "semgrep-json" else _sarif(parsed, source)
        all_findings.extend(findings)
        all_errors.extend(errors)
        if len(all_findings) > MAX_FINDINGS or len(all_errors) > MAX_ERRORS:
            raise SastError("normalized findings or errors exceed the configured limit")

    groups: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for finding in all_findings:
        groups[finding["fingerprint"]].append(finding)
    reconciled: list[dict[str, Any]] = []
    for fingerprint, matches in sorted(groups.items()):
        representative = sorted(matches, key=lambda item: (item["source_id"], item["scanner"]))[0]
        reconciled.append({
            **{key: value for key, value in representative.items() if key != "source_id"},
            "sources": sorted({match["source_id"] for match in matches}),
            "scanners": sorted({match["scanner"] for match in matches}),
            "observation_count": len(matches),
        })
    all_errors.sort(key=lambda item: (item["source_id"], item["message"]))
    return {
        "format": "cyberful.sast-reconciliation.v1",
        "manifest_sha256": manifest_sha256,
        "sources": sorted(digests, key=lambda item: item["id"]),
        "summary": {
            "source_count": len(sources),
            "observation_count": len(all_findings),
            "unique_finding_count": len(reconciled),
            "duplicate_observation_count": len(all_findings) - len(reconciled),
            "error_count": len(all_errors),
        },
        "findings": reconciled,
        "errors": all_errors,
        "interpretation": "Fingerprints deduplicate scanner observations only; confirm reachability, control placement, security effect, and impact independently.",
    }


def _write_report(workspace: Path, value: str, report: dict[str, Any], protected_sources: set[Path]) -> None:
    destination = _confined_path(workspace, value, must_exist=False)
    if destination in protected_sources:
        raise SastError("output must not replace the manifest or input evidence")
    if not destination.parent.is_dir():
        raise SastError("output parent must be an existing directory")
    if destination.exists() and not destination.is_file():
        raise SastError("output must be a regular file or a new path")
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
    parser = argparse.ArgumentParser(description="Reconcile Semgrep JSON and SARIF evidence offline.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output")
    arguments = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        workspace = _workspace(arguments.workspace)
        manifest_path = _confined_path(workspace, arguments.input, must_exist=True)
        raw = _read(manifest_path, MAX_MANIFEST_BYTES)
        payload = _object(raw, "manifest")
        report = reconcile_manifest(payload, workspace, hashlib.sha256(raw).hexdigest())
        if arguments.output:
            protected_sources = {manifest_path, *(_confined_path(workspace, source["path"], must_exist=True) for source in payload["sources"])}
            _write_report(workspace, arguments.output, report, protected_sources)
        else:
            print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    except (SastError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
