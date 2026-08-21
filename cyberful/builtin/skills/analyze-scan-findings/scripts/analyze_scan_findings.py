#!/usr/bin/env python3
# ── Offline Scan Finding Correlation ────────────────────────────
# Snapshots bounded SARIF or normalized JSON exports and groups exact evidence
#   without inheriting scanner severity as verified vulnerability impact.
# → cyberful/builtin/skills/analyze-scan-findings/assets/scan-finding-analysis.schema.json — input contract.
# → cyberful/builtin/skills/analyze-scan-findings/tests/test_analyze_scan_findings.py — correlation tests.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
from typing import Any, Final


MAX_CONFIG_BYTES: Final = 262_144
MAX_FILES: Final = 32
MAX_FINDINGS: Final = 100_000
MAX_TOTAL_BYTES: Final = 67_108_864
MAX_OUTPUT_BYTES: Final = 8_388_608
MAX_TIMEOUT_SECONDS: Final = 60
MAX_LOCATIONS: Final = 32
MAX_RUNS: Final = 256
MAX_FINGERPRINTS: Final = 64
MAX_SUPPRESSIONS: Final = 64
MAX_SUPPRESSION_NODES: Final = 2_048
FIELDS: Final = frozenset({"$schema", "analysis_id", "scope_reference", "scan_files", "max_findings", "max_total_bytes", "timeout_seconds", "output_limit_bytes"})
LEVELS: Final = frozenset({"none", "note", "warning", "error", "unknown"})


class AnalysisError(ValueError):
    """Raised when scanner evidence violates the bounded correlation contract."""


def _deadline(deadline: float, stage: str) -> None:
    if time.monotonic() >= deadline:
        raise AnalysisError(f"analysis deadline expired during {stage}")


def _text(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AnalysisError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > maximum or any(ord(character) < 32 for character in normalized):
        raise AnalysisError(f"{label} exceeds its text boundary")
    return normalized


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise AnalysisError(f"{label} must be between {minimum} and {maximum}")
    return value


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise AnalysisError("workspace must be an existing directory")
    return workspace


def _confined(workspace: Path, value: str, *, exists: bool) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise AnalysisError("paths must be relative and non-traversing")
    cursor = workspace
    for component in requested.parts:
        cursor /= component
        if cursor.is_symlink():
            raise AnalysisError("symbolic links are not allowed")
    resolved = (workspace / requested).resolve(strict=exists)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise AnalysisError("path escapes workspace") from error
    return resolved


def _snapshot(path: Path, maximum: int, deadline: float) -> bytes:
    if maximum < 1:
        raise AnalysisError("scan files exceed max_total_bytes")
    expected = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(expected.st_mode) or expected.st_size > maximum:
        raise AnalysisError(f"{path.name} must be a bounded regular non-symlink file")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino):
            raise AnalysisError(f"{path.name} changed before snapshot")
        chunks = []
        observed = 0
        while True:
            _deadline(deadline, "scan snapshot")
            chunk = os.read(descriptor, min(65_536, maximum - observed + 1))
            if not chunk:
                break
            observed += len(chunk)
            if observed > maximum or observed > expected.st_size:
                raise AnalysisError(f"{path.name} exceeds its byte boundary")
            chunks.append(chunk)
        final = os.fstat(descriptor)
        if observed != expected.st_size or (final.st_dev, final.st_ino, final.st_size) != (expected.st_dev, expected.st_ino, expected.st_size):
            raise AnalysisError(f"{path.name} changed during snapshot")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _json(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AnalysisError(f"{label} must be UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise AnalysisError(f"{label} must contain a JSON object")
    return value


def _config(value: dict[str, Any]) -> tuple[str, str, list[tuple[str, str]], int, int, int, int]:
    if set(value) != FIELDS or value["$schema"] != "./scan-finding-analysis.schema.json":
        raise AnalysisError("input fields or schema identity are invalid")
    raw_files = value["scan_files"]
    if not isinstance(raw_files, list) or not 1 <= len(raw_files) <= MAX_FILES:
        raise AnalysisError("scan_files must be a bounded non-empty array")
    files = []
    for item in raw_files:
        if not isinstance(item, dict) or set(item) != {"path", "format"}:
            raise AnalysisError("scan_files entries must contain only path and format")
        path = _text(item["path"], "scan_files[].path", 1024)
        format_name = item["format"]
        if format_name not in {"sarif-2.1", "normalized-json"}:
            raise AnalysisError("scan_files[].format is unsupported")
        files.append((path, format_name))
    if len({path for path, _ in files}) != len(files):
        raise AnalysisError("scan file paths must not repeat")
    return (_text(value["analysis_id"], "analysis_id", 256), _text(value["scope_reference"], "scope_reference", 512), sorted(files), _integer(value["max_findings"], "max_findings", 1, MAX_FINDINGS), _integer(value["max_total_bytes"], "max_total_bytes", 1, MAX_TOTAL_BYTES), _integer(value["timeout_seconds"], "timeout_seconds", 1, MAX_TIMEOUT_SECONDS), _integer(value["output_limit_bytes"], "output_limit_bytes", 1024, MAX_OUTPUT_BYTES))


def _location(uri: Any, line: Any, label: str) -> dict[str, Any]:
    rendered_uri = _text(uri, f"{label}.uri", 2048)
    rendered_line = None if line is None else _integer(line, f"{label}.line", 1, 2_147_483_647)
    return {"uri": rendered_uri, "line": rendered_line}


def _occurrence(source: str, evidence_ref: str, rule_id: Any, level: Any, message: Any, locations: list[dict[str, Any]], fingerprint: str | None, suppressed: bool) -> dict[str, Any]:
    rule = _text(rule_id, "rule_id", 512)
    rendered_level = level if isinstance(level, str) and level in LEVELS else "unknown"
    rendered_message = _text(message, "message", 16384)
    message_digest = hashlib.sha256(rendered_message.encode()).hexdigest()
    ordered_locations = sorted(locations, key=lambda item: (item["uri"], item["line"] or 0))
    location_key = json.dumps(ordered_locations, sort_keys=True, separators=(",", ":"))
    if fingerprint:
        fingerprint_digest = hashlib.sha256(fingerprint.encode()).hexdigest()
        correlation_basis = "supplied-fingerprint"
        material = f"fingerprint\0{fingerprint_digest}"
    else:
        fingerprint_digest = None
        correlation_basis = "structural-fallback"
        material = f"structure\0{rule}\0{location_key}\0{message_digest}"
    correlation_key = hashlib.sha256(material.encode()).hexdigest()
    return {"source": source, "evidence_ref": evidence_ref, "rule_id": rule, "level": rendered_level, "message_sha256": message_digest, "locations": ordered_locations, "fingerprint_sha256": fingerprint_digest, "correlation_key": correlation_key, "correlation_basis": correlation_basis, "suppressed": suppressed}


def _selected_fingerprint(fingerprints: Any, partial: Any, deadline: float) -> str | None:
    if not isinstance(fingerprints, dict) or not isinstance(partial, dict):
        raise AnalysisError("SARIF fingerprints must be objects")
    if len(fingerprints) + len(partial) > MAX_FINGERPRINTS:
        raise AnalysisError("SARIF fingerprints exceed their count boundary")
    selected: str | None = None
    for mapping in (fingerprints, partial):
        for key in sorted(mapping):
            _deadline(deadline, "SARIF fingerprint parsing")
            rendered_key = _text(key, "SARIF fingerprint key", 256)
            rendered_value = _text(mapping[key], "SARIF fingerprint value", 2048)
            candidate = f"{rendered_key}:{rendered_value}"
            selected = candidate if selected is None or candidate < selected else selected
    return selected


def _suppression_nodes(value: Any, deadline: float, remaining: int, depth: int = 0) -> int:
    _deadline(deadline, "SARIF suppression parsing")
    if remaining < 1 or depth > 8:
        raise AnalysisError("SARIF suppressions exceed their structural boundary")
    consumed = 1
    if isinstance(value, str):
        _text(value, "SARIF suppression text", 2048)
    elif isinstance(value, dict):
        if len(value) > 64:
            raise AnalysisError("SARIF suppression object exceeds its field boundary")
        for key in sorted(value):
            _text(key, "SARIF suppression key", 256)
            used = _suppression_nodes(value[key], deadline, remaining - consumed, depth + 1)
            consumed += used
            if consumed > remaining:
                raise AnalysisError("SARIF suppressions exceed their structural boundary")
    elif isinstance(value, list):
        if len(value) > 64:
            raise AnalysisError("SARIF suppression array exceeds its item boundary")
        for item in value:
            used = _suppression_nodes(item, deadline, remaining - consumed, depth + 1)
            consumed += used
            if consumed > remaining:
                raise AnalysisError("SARIF suppressions exceed their structural boundary")
    elif value is not None and not isinstance(value, (bool, int, float)):
        raise AnalysisError("SARIF suppression contains an unsupported value")
    return consumed


def _sarif(document: dict[str, Any], source: str, remaining: int, deadline: float) -> list[dict[str, Any]]:
    if document.get("version") != "2.1.0" or not isinstance(document.get("runs"), list):
        raise AnalysisError(f"{source} must be SARIF 2.1.0")
    if len(document["runs"]) > MAX_RUNS:
        raise AnalysisError("SARIF runs exceed their count boundary")
    occurrences = []
    for run_index, run in enumerate(document["runs"]):
        _deadline(deadline, "SARIF run parsing")
        if not isinstance(run, dict) or not isinstance(run.get("results", []), list):
            raise AnalysisError(f"{source} contains a malformed SARIF run")
        results = run.get("results", [])
        if len(results) > remaining - len(occurrences):
            raise AnalysisError("scan results exceed max_findings")
        for result_index, result in enumerate(results):
            _deadline(deadline, "SARIF parsing")
            if len(occurrences) >= remaining or not isinstance(result, dict):
                raise AnalysisError("scan results exceed max_findings or contain a malformed result")
            message = result.get("message")
            message_text = message.get("text") if isinstance(message, dict) else None
            raw_locations = result.get("locations", [])
            if not isinstance(raw_locations, list) or len(raw_locations) > MAX_LOCATIONS:
                raise AnalysisError("SARIF result locations exceed their boundary")
            locations = []
            for location_index, item in enumerate(raw_locations):
                physical = item.get("physicalLocation") if isinstance(item, dict) else None
                artifact = physical.get("artifactLocation") if isinstance(physical, dict) else None
                region = physical.get("region", {}) if isinstance(physical, dict) else {}
                if not isinstance(artifact, dict) or not isinstance(region, dict):
                    raise AnalysisError("SARIF location is malformed")
                locations.append(_location(artifact.get("uri"), region.get("startLine"), f"locations[{location_index}]"))
            suppressions = result.get("suppressions", [])
            if not isinstance(suppressions, list) or len(suppressions) > MAX_SUPPRESSIONS:
                raise AnalysisError("SARIF suppressions exceed their count boundary")
            remaining_nodes = MAX_SUPPRESSION_NODES
            for suppression in suppressions:
                if not isinstance(suppression, dict):
                    raise AnalysisError("SARIF suppression entries must be objects")
                used = _suppression_nodes(suppression, deadline, remaining_nodes)
                remaining_nodes -= used
            fingerprint = _selected_fingerprint(result.get("fingerprints", {}), result.get("partialFingerprints", {}), deadline)
            occurrences.append(_occurrence(source, f"{source}#/runs/{run_index}/results/{result_index}", result.get("ruleId"), result.get("level", "unknown"), message_text, locations, fingerprint, bool(suppressions)))
    return occurrences


def _normalized(document: dict[str, Any], source: str, remaining: int, deadline: float) -> list[dict[str, Any]]:
    if set(document) != {"findings"} or not isinstance(document["findings"], list):
        raise AnalysisError(f"{source} must contain only a findings array")
    if len(document["findings"]) > remaining:
        raise AnalysisError("scan results exceed max_findings")
    occurrences = []
    required = {"rule_id", "level", "message", "locations", "fingerprint", "suppressed", "evidence_ref"}
    for index, item in enumerate(document["findings"]):
        _deadline(deadline, "normalized finding parsing")
        if not isinstance(item, dict) or set(item) != required or not isinstance(item["suppressed"], bool):
            raise AnalysisError("normalized finding contains missing or unknown fields")
        if item["fingerprint"] is not None and not isinstance(item["fingerprint"], str):
            raise AnalysisError("normalized fingerprint must be a string or null")
        raw_locations = item["locations"]
        if not isinstance(raw_locations, list) or len(raw_locations) > MAX_LOCATIONS:
            raise AnalysisError("normalized locations exceed their boundary")
        locations = []
        for location_index, location in enumerate(raw_locations):
            if not isinstance(location, dict) or set(location) != {"uri", "line"}:
                raise AnalysisError("normalized location is malformed")
            locations.append(_location(location["uri"], location["line"], f"locations[{location_index}]"))
        occurrences.append(_occurrence(source, _text(item["evidence_ref"], f"findings[{index}].evidence_ref", 2048), item["rule_id"], item["level"], item["message"], locations, item["fingerprint"], item["suppressed"]))
    return occurrences


def _analyze(config: dict[str, Any], digest: str, workspace: Path, deadline: float) -> tuple[dict[str, Any], int]:
    workspace = workspace.resolve(strict=True)
    analysis_id, scope_reference, files, max_findings, max_bytes, timeout, output_limit = _config(config)
    sources = []
    occurrences = []
    total_bytes = 0
    for relative, format_name in files:
        _deadline(deadline, "scan enumeration")
        raw = _snapshot(_confined(workspace, relative, exists=True), max_bytes - total_bytes, deadline)
        total_bytes += len(raw)
        document = _json(raw, relative)
        parsed = _sarif(document, relative, max_findings - len(occurrences), deadline) if format_name == "sarif-2.1" else _normalized(document, relative, max_findings - len(occurrences), deadline)
        occurrences.extend(parsed)
        sources.append({"path": relative, "format": format_name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "findings": len(parsed)})
    ordered = sorted(occurrences, key=lambda item: (item["correlation_key"], item["source"], item["evidence_ref"]))
    by_key: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for occurrence in ordered:
        by_key[occurrence["correlation_key"]].append(occurrence)
    groups = []
    for key, members in sorted(by_key.items()):
        _deadline(deadline, "finding grouping")
        locations = {(location["uri"], location["line"]) for member in members for location in member["locations"]}
        groups.append({"group_id": key, "correlation_basis": members[0]["correlation_basis"], "occurrences": len(members), "sources": sorted({member["source"] for member in members}), "rule_ids": sorted({member["rule_id"] for member in members}), "levels": sorted({member["level"] for member in members}), "locations": [{"uri": uri, "line": line} for uri, line in sorted(locations, key=lambda item: (item[0], item[1] or 0))], "evidence_refs": sorted({member["evidence_ref"] for member in members}), "suppressed_occurrences": sum(member["suppressed"] for member in members)})
    level_counts = Counter(item["level"] for item in ordered)
    basis_counts = Counter(group["correlation_basis"] for group in groups)
    report = {"format": "cyberful.scan-finding-evidence.v1", "analysis_id": analysis_id, "scope_reference": scope_reference, "input_sha256": digest, "sources": sources, "occurrences": ordered, "groups": groups, "summary": {"files": len(sources), "occurrences": len(ordered), "groups": len(groups), "levels": dict(sorted(level_counts.items())), "suppressed": sum(item["suppressed"] for item in ordered), "cross_source_groups": sum(len(group["sources"]) > 1 for group in groups), "correlation_bases": dict(sorted(basis_counts.items()))}, "limits": {"findings": max_findings, "input_bytes": max_bytes, "output_bytes": output_limit, "timeout_seconds": timeout}, "interpretation": "Correlation groups organize scanner evidence only; scanner level, repetition, or suppression is not verified vulnerability impact."}
    return report, output_limit


def _write(path: Path, value: dict[str, Any], limit: int, deadline: float) -> None:
    _deadline(deadline, "evidence serialization")
    raw = f"{json.dumps(value, indent=2, sort_keys=True)}\n".encode()
    if len(raw) > limit:
        raise AnalysisError("scan evidence exceeds output_limit_bytes")
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
            temporary = handle.name
            os.chmod(temporary, 0o600)
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        _deadline(deadline, "evidence publication")
        os.link(temporary, path)
        Path(temporary).unlink()
        temporary = None
    finally:
        if temporary:
            Path(temporary).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Normalize bounded scanner evidence offline")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(argv)
    started = time.monotonic()
    try:
        workspace = _workspace(arguments.workspace)
        source = _confined(workspace, arguments.input, exists=True)
        output = _confined(workspace, arguments.output, exists=False)
        if output.exists() or output == source or not output.parent.is_dir():
            raise AnalysisError("output must be new, distinct, and below an existing directory")
        raw = _snapshot(source, MAX_CONFIG_BYTES, started + MAX_TIMEOUT_SECONDS)
        config = _json(raw, "input")
        deadline = started + _integer(config.get("timeout_seconds"), "timeout_seconds", 1, MAX_TIMEOUT_SECONDS)
        report, limit = _analyze(config, hashlib.sha256(raw).hexdigest(), workspace, deadline)
        _write(output, report, limit, deadline)
    except (AnalysisError, OSError) as error:
        print(f"scan finding analysis error: {error}", file=sys.stderr)
        return 2
    print(output.relative_to(workspace).as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
