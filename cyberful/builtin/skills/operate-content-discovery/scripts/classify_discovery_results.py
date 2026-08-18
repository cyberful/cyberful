#!/usr/bin/env python3
# ── Offline Content Discovery Classification ────────────────────
# Normalizes bounded ffuf JSON runs and compares their response signatures
# against explicit per-profile baselines without issuing target requests.
# → cyberful/builtin/skills/operate-content-discovery/assets/discovery-run-manifest.schema.json — input contract.
# → cyberful/builtin/skills/operate-content-discovery/tests/test_classify_discovery_results.py — coverage.
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


MAX_MANIFEST_BYTES: Final = 1_048_576
MAX_SOURCE_BYTES: Final = 32_000_000
MAX_SOURCES: Final = 32
MAX_RESULTS: Final = 250_000
MAX_TEXT: Final = 2_048


class ClassificationError(ValueError):
    """Raised when discovery evidence violates the bounded input contract."""


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise ClassificationError("workspace must be an existing directory")
    return workspace


def _confined_path(workspace: Path, value: str, *, must_exist: bool) -> Path:
    canonical_workspace = workspace.resolve(strict=True)
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise ClassificationError("paths must be non-traversing and relative to the workspace")
    cursor = canonical_workspace
    for component in requested.parts:
        cursor = cursor / component
        if cursor.is_symlink():
            raise ClassificationError(f"path component is a symbolic link: {component}")
    resolved = (canonical_workspace / requested).resolve(strict=must_exist)
    try:
        resolved.relative_to(canonical_workspace)
    except ValueError as error:
        raise ClassificationError("path escapes the workspace") from error
    return resolved


def _read(path: Path, limit: int) -> bytes:
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
        raise ClassificationError(f"{path.name} must be a regular file no larger than {limit} bytes")
    raw = path.read_bytes()
    if len(raw) > limit:
        raise ClassificationError(f"{path.name} exceeds the {limit}-byte limit")
    return raw


def _decode_object(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ClassificationError(f"{label} must be UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise ClassificationError(f"{label} must be a JSON object")
    return value


def _text(value: Any, label: str, *, optional: bool = False) -> str:
    if optional and (value is None or value == ""):
        return ""
    if not isinstance(value, str) or not value.strip():
        raise ClassificationError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > MAX_TEXT or any(ord(character) < 32 for character in normalized):
        raise ClassificationError(f"{label} exceeds its text boundary or contains control characters")
    return normalized


def _source(value: Any, index: int) -> dict[str, Any]:
    required = {"id", "path", "profile", "mutation_axis", "baseline"}
    label = f"sources[{index}]"
    if not isinstance(value, dict) or set(value) != required:
        raise ClassificationError(f"{label} must contain exactly: {', '.join(sorted(required))}")
    if not isinstance(value["baseline"], bool):
        raise ClassificationError(f"{label}.baseline must be a boolean")
    return {
        "id": _text(value["id"], f"{label}.id"),
        "path": _text(value["path"], f"{label}.path"),
        "profile": _text(value["profile"], f"{label}.profile"),
        "mutation_axis": _text(value["mutation_axis"], f"{label}.mutation_axis"),
        "baseline": value["baseline"],
    }


def _integer(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ClassificationError(f"{label} must be a non-negative integer")
    return value


def _signature(result: dict[str, Any], label: str) -> tuple[int, int, int, int, str, str]:
    return (
        _integer(result.get("status"), f"{label}.status"),
        _integer(result.get("length"), f"{label}.length"),
        _integer(result.get("words"), f"{label}.words"),
        _integer(result.get("lines"), f"{label}.lines"),
        _text(result.get("redirectlocation"), f"{label}.redirectlocation", optional=True),
        _text(result.get("content-type"), f"{label}.content-type", optional=True),
    )


def _signature_object(signature: tuple[int, int, int, int, str, str]) -> dict[str, Any]:
    return {
        "status": signature[0],
        "length": signature[1],
        "words": signature[2],
        "lines": signature[3],
        "redirect": signature[4],
        "content_type": signature[5],
    }


def _ffuf_results(raw: bytes, source: dict[str, Any]) -> list[dict[str, Any]]:
    payload = _decode_object(raw, f"ffuf source {source['id']}")
    results = payload.get("results")
    if not isinstance(results, list):
        raise ClassificationError(f"ffuf source {source['id']} must contain a results array")
    normalized: list[dict[str, Any]] = []
    for index, result in enumerate(results):
        label = f"ffuf source {source['id']}.results[{index}]"
        if not isinstance(result, dict):
            raise ClassificationError(f"{label} must be an object")
        raw_input = result.get("input", {})
        if not isinstance(raw_input, dict):
            raise ClassificationError(f"{label}.input must be an object")
        input_values = {str(key): str(value) for key, value in sorted(raw_input.items(), key=lambda item: str(item[0]))}
        signature = _signature(result, label)
        normalized.append(
            {
                "source_id": source["id"],
                "profile": source["profile"],
                "mutation_axis": source["mutation_axis"],
                "baseline": source["baseline"],
                "url": _text(result.get("url"), f"{label}.url", optional=True),
                "input": input_values,
                "signature": _signature_object(signature),
                "_signature": signature,
            }
        )
    return normalized


# ── Baselines Are Profile-Specific Evidence ─────────────────────
# Authentication, routing, and mutation shape can each change a soft-404 or
# wildcard response. Signatures are therefore compared only within the same
# profile and mutation axis. An unmatched signature is a differential candidate,
# not proof that the mutated resource exists or is security-relevant.
# ─────────────────────────────────────────────────────────────────
def classify_manifest(payload: dict[str, Any], workspace: Path, manifest_sha256: str) -> dict[str, Any]:
    if set(payload) - {"$schema", "sources"}:
        raise ClassificationError("manifest contains unknown fields")
    raw_sources = payload.get("sources")
    if not isinstance(raw_sources, list) or not raw_sources or len(raw_sources) > MAX_SOURCES:
        raise ClassificationError(f"sources must contain between 1 and {MAX_SOURCES} entries")
    sources = [_source(value, index) for index, value in enumerate(raw_sources)]
    source_ids = [source["id"] for source in sources]
    if len(source_ids) != len(set(source_ids)):
        raise ClassificationError("source ids must be unique")

    observations: list[dict[str, Any]] = []
    digests: list[dict[str, str]] = []
    for source in sources:
        path = _confined_path(workspace, source["path"], must_exist=True)
        raw = _read(path, MAX_SOURCE_BYTES)
        digests.append({"id": source["id"], "sha256": hashlib.sha256(raw).hexdigest()})
        observations.extend(_ffuf_results(raw, source))
        if len(observations) > MAX_RESULTS:
            raise ClassificationError(f"results exceed the {MAX_RESULTS}-entry limit")

    baselines: defaultdict[tuple[str, str], set[tuple[int, int, int, int, str, str]]] = defaultdict(set)
    for observation in observations:
        if observation["baseline"]:
            baselines[(observation["profile"], observation["mutation_axis"])].add(observation["_signature"])

    classified: list[dict[str, Any]] = []
    counts: Counter[str] = Counter()
    for observation in observations:
        key = (observation["profile"], observation["mutation_axis"])
        if observation["baseline"]:
            classification = "baseline"
        elif not baselines[key]:
            classification = "uncalibrated"
        elif observation["_signature"] in baselines[key]:
            classification = "baseline-like"
        else:
            classification = "differential-candidate"
        counts[classification] += 1
        classified.append({key: value for key, value in observation.items() if key != "_signature"} | {"classification": classification})

    classified.sort(key=lambda item: (item["profile"], item["mutation_axis"], item["source_id"], item["url"], json.dumps(item["input"], sort_keys=True)))
    return {
        "format": "cyberful.discovery-classification.v1",
        "manifest_sha256": manifest_sha256,
        "sources": sorted(digests, key=lambda item: item["id"]),
        "summary": {
            "source_count": len(sources),
            "result_count": len(classified),
            "baseline": counts["baseline"],
            "baseline_like": counts["baseline-like"],
            "differential_candidates": counts["differential-candidate"],
            "uncalibrated": counts["uncalibrated"],
        },
        "results": classified,
        "interpretation": "Differential candidates require replay and application-level interpretation; response shape alone does not prove resource existence or impact.",
    }


def _write_report(workspace: Path, value: str, report: dict[str, Any], protected_sources: set[Path]) -> None:
    destination = _confined_path(workspace, value, must_exist=False)
    if destination in protected_sources:
        raise ClassificationError("output must not replace the manifest or input evidence")
    if not destination.parent.is_dir():
        raise ClassificationError("output parent must be an existing directory")
    if destination.exists() and not destination.is_file():
        raise ClassificationError("output must be a regular file or a new path")
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
    parser = argparse.ArgumentParser(description="Classify ffuf results against explicit baselines offline.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output")
    arguments = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        workspace = _workspace(arguments.workspace)
        manifest_path = _confined_path(workspace, arguments.input, must_exist=True)
        raw = _read(manifest_path, MAX_MANIFEST_BYTES)
        payload = _decode_object(raw, "manifest")
        report = classify_manifest(payload, workspace, hashlib.sha256(raw).hexdigest())
        if arguments.output:
            protected_sources = {manifest_path, *(_confined_path(workspace, source["path"], must_exist=True) for source in payload["sources"])}
            _write_report(workspace, arguments.output, report, protected_sources)
        else:
            print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    except (ClassificationError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
