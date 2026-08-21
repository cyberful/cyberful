#!/usr/bin/env python3
# ── Offline Secret Propagation Trace ─────────────────────────────
# Correlates supplied secret fingerprints with bounded JSON snapshots while
#   retaining only artifact identities, JSON pointers, and digests.
# → cyberful/builtin/skills/trace-secret-propagation/assets/secret-propagation-input.schema.json — input contract.
# → cyberful/builtin/skills/trace-secret-propagation/tests/test_trace_secret_propagation.py — boundary tests.
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
import time
from typing import Any, Final, Iterator


INPUT_SCHEMA: Final = "assets/secret-propagation-input.schema.json"
MAX_REQUEST_BYTES: Final = 1_048_576
MAX_ARTIFACT_BYTES: Final = 1_048_576
MAX_TOTAL_BYTES: Final = 16_777_216
MAX_OUTPUT_BYTES: Final = 2_097_152
MAX_NODES: Final = 200_000
MAX_OCCURRENCES: Final = 4_096
TIMEOUT_SECONDS: Final = 15
SHA256: Final = re.compile(r"^[a-f0-9]{64}$")


class TraceError(ValueError):
    """Raised when trace input, evidence, or output violates a boundary."""


@dataclass(frozen=True)
class Artifact:
    identifier: str
    path: str
    system: str
    captured_at: str


@dataclass(frozen=True)
class Marker:
    identifier: str
    sha256: str
    allowed_locations: tuple[tuple[str, str], ...]


# ── Snapshot Reads Never Expand The Declared Evidence Set ────────
# Request paths are relative, non-traversing, and checked component by component
# before any artifact is read. Artifacts are bounded regular JSON files and are
# never interpreted as import graphs, templates, or references. Fingerprints are
# compared only with scalar strings, so the output cannot reproduce secret bytes.
# The same monotonic deadline covers validation, reads, traversal, and publication.
# ─────────────────────────────────────────────────────────────────


def _deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise TraceError("secret propagation trace exceeded its global deadline")


def _workspace(value: str) -> Path:
    path = Path(value).resolve(strict=True)
    if not path.is_dir():
        raise TraceError("workspace must be an existing directory")
    return path


def _confined(workspace: Path, value: str, *, exists: bool) -> Path:
    workspace = workspace.resolve(strict=True)
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise TraceError("paths must be relative and non-traversing")
    cursor = workspace
    for part in requested.parts:
        cursor /= part
        if cursor.is_symlink():
            raise TraceError("symbolic links are not allowed")
    resolved = (workspace / requested).resolve(strict=exists)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise TraceError("path escapes workspace") from error
    return resolved


def _read_json(path: Path, maximum: int, workspace: Path, deadline: float) -> tuple[Any, bytes, Path, tuple[int, int]]:
    expected = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(expected.st_mode) or expected.st_size > maximum:
        raise TraceError("input must be a bounded regular file")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        canonical = path.resolve(strict=True)
        try:
            canonical.relative_to(workspace.resolve(strict=True))
        except ValueError as error:
            raise TraceError("input resolved outside workspace") from error
        resolved = canonical.stat()
        identities = {(expected.st_dev, expected.st_ino), (opened.st_dev, opened.st_ino), (resolved.st_dev, resolved.st_ino)}
        if len(identities) != 1 or not stat.S_ISREG(opened.st_mode) or opened.st_size > maximum:
            raise TraceError("input identity changed while opening")
        chunks: list[bytes] = []
        observed = 0
        while True:
            _deadline(deadline)
            chunk = os.read(descriptor, min(65_536, maximum + 1 - observed))
            if not chunk:
                break
            chunks.append(chunk)
            observed += len(chunk)
            if observed > maximum:
                raise TraceError("input exceeds its byte boundary")
        final = os.fstat(descriptor)
        if (final.st_dev, final.st_ino, final.st_size) != (opened.st_dev, opened.st_ino, opened.st_size) or observed != opened.st_size:
            raise TraceError("input changed while reading")
        raw = b"".join(chunks)
    finally:
        os.close(descriptor)
    try:
        return json.loads(raw.decode("utf-8")), raw, canonical, (opened.st_dev, opened.st_ino)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise TraceError(f"{path.name} must be UTF-8 JSON") from error


def _text(value: Any, label: str, maximum: int, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value) or len(value.encode()) > maximum:
        raise TraceError(f"{label} must be a bounded string")
    return value


def _request(payload: Any) -> tuple[tuple[Artifact, ...], tuple[Marker, ...]]:
    if not isinstance(payload, dict) or set(payload) != {"$schema", "artifacts", "markers"} or payload["$schema"] != INPUT_SCHEMA:
        raise TraceError("input contract or $schema is malformed")
    raw_artifacts = payload["artifacts"]
    raw_markers = payload["markers"]
    if not isinstance(raw_artifacts, list) or not 1 <= len(raw_artifacts) <= 32:
        raise TraceError("artifacts must be a bounded non-empty array")
    artifacts: list[Artifact] = []
    for index, raw in enumerate(raw_artifacts):
        if not isinstance(raw, dict) or set(raw) != {"id", "path", "system", "captured_at"}:
            raise TraceError(f"artifacts[{index}] is malformed")
        artifacts.append(Artifact(_text(raw["id"], "artifact id", 128), _text(raw["path"], "artifact path", 512), _text(raw["system"], "artifact system", 256), _text(raw["captured_at"], "captured_at", 64)))
    if len({item.identifier for item in artifacts}) != len(artifacts) or len({item.path for item in artifacts}) != len(artifacts):
        raise TraceError("artifact identifiers and paths must be unique")
    if not isinstance(raw_markers, list) or not 1 <= len(raw_markers) <= 64:
        raise TraceError("markers must be a bounded non-empty array")
    markers: list[Marker] = []
    artifact_ids = {item.identifier for item in artifacts}
    for index, raw in enumerate(raw_markers):
        if not isinstance(raw, dict) or set(raw) != {"id", "sha256", "allowed_locations"}:
            raise TraceError(f"markers[{index}] is malformed")
        digest = _text(raw["sha256"], "marker sha256", 64)
        locations = raw["allowed_locations"]
        if not SHA256.fullmatch(digest) or not isinstance(locations, list) or len(locations) > 32:
            raise TraceError(f"markers[{index}] has malformed digest or locations")
        normalized: list[tuple[str, str]] = []
        for location in locations:
            if not isinstance(location, dict) or set(location) != {"artifact_id", "pointer_prefix"}:
                raise TraceError("allowed location is malformed")
            artifact_id = _text(location["artifact_id"], "allowed artifact", 128)
            pointer = _text(location["pointer_prefix"], "pointer prefix", 512, allow_empty=True)
            if artifact_id not in artifact_ids or (pointer and not pointer.startswith("/")):
                raise TraceError("allowed location exceeds declared artifacts or JSON pointers")
            normalized.append((artifact_id, pointer))
        markers.append(Marker(_text(raw["id"], "marker id", 128), digest, tuple(sorted(set(normalized)))))
    if len({item.identifier for item in markers}) != len(markers) or len({item.sha256 for item in markers}) != len(markers):
        raise TraceError("marker identifiers and digests must be unique")
    return tuple(artifacts), tuple(markers)


def _pointer_component(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def _nodes(value: Any) -> Iterator[tuple[str, Any]]:
    stack: list[tuple[str, Any]] = [("", value)]
    while stack:
        pointer, node = stack.pop()
        yield pointer, node
        if isinstance(node, list):
            for index in range(len(node) - 1, -1, -1):
                stack.append((f"{pointer}/{index}", node[index]))
        elif isinstance(node, dict):
            for key in sorted(node, reverse=True):
                stack.append((f"{pointer}/{_pointer_component(str(key))}", node[key]))


def _allowed(marker: Marker, artifact_id: str, pointer: str) -> bool:
    return any(allowed_artifact == artifact_id and (not prefix or pointer == prefix or pointer.startswith(f"{prefix}/")) for allowed_artifact, prefix in marker.allowed_locations)


def run_trace(payload: Any, digest: str, workspace: Path, *, deadline: float, output_limit: int = MAX_OUTPUT_BYTES) -> dict[str, Any]:
    artifacts, markers = _request(payload)
    _deadline(deadline)
    by_digest = {marker.sha256: marker for marker in markers}
    artifact_rows: list[dict[str, Any]] = []
    occurrences: list[dict[str, Any]] = []
    total_bytes = 0
    nodes = 0
    artifact_identities: set[tuple[int, int]] = set()
    artifact_paths: set[Path] = set()
    for artifact in artifacts:
        _deadline(deadline)
        path = _confined(workspace, artifact.path, exists=True)
        document, raw, canonical, identity = _read_json(path, MAX_ARTIFACT_BYTES, workspace, deadline)
        if canonical in artifact_paths or identity in artifact_identities:
            raise TraceError("artifact inputs must be canonically and inode-distinct")
        artifact_paths.add(canonical)
        artifact_identities.add(identity)
        total_bytes += len(raw)
        if total_bytes > MAX_TOTAL_BYTES:
            raise TraceError("artifact bytes exceed the cumulative input boundary")
        artifact_rows.append({"id": artifact.identifier, "path": artifact.path, "system": artifact.system, "captured_at": artifact.captured_at, "sha256": hashlib.sha256(raw).hexdigest()})
        for pointer, value in _nodes(document):
            nodes += 1
            _deadline(deadline)
            if nodes > MAX_NODES:
                raise TraceError("snapshot node count exceeds the analysis boundary")
            if not isinstance(value, str):
                continue
            value_digest = hashlib.sha256(value.encode()).hexdigest()
            marker = by_digest.get(value_digest)
            if marker is not None:
                occurrences.append({"marker_id": marker.identifier, "artifact_id": artifact.identifier, "pointer": pointer, "value_sha256": value_digest, "allowed": _allowed(marker, artifact.identifier, pointer)})
                if len(occurrences) > MAX_OCCURRENCES:
                    raise TraceError("secret occurrences exceed the output boundary")
    occurrences.sort(key=lambda item: (item["marker_id"], item["artifact_id"], item["pointer"]))
    report = {
        "format": "cyberful.secret-propagation.raw.v1", "input_sha256": digest,
        "artifacts": artifact_rows, "occurrences": occurrences,
        "counts": {"artifacts": len(artifacts), "markers": len(markers), "occurrences": len(occurrences), "unexpected": sum(not item["allowed"] for item in occurrences)},
    }
    _deadline(deadline)
    rendered = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode()
    if not 1 <= output_limit <= MAX_OUTPUT_BYTES or len(rendered) > output_limit:
        raise TraceError("secret propagation evidence exceeds the output boundary")
    return report


def _write(path: Path, value: dict[str, Any], deadline: float, output_limit: int = MAX_OUTPUT_BYTES, parent_identity: tuple[int, int] | None = None) -> None:
    if path.exists():
        raise TraceError("output path already exists")
    _deadline(deadline)
    rendered = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    if len(rendered) > output_limit:
        raise TraceError("secret propagation evidence exceeds the output boundary")
    parent_expected = path.parent.lstat()
    expected_identity = parent_identity or (parent_expected.st_dev, parent_expected.st_ino)
    parent_descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    temporary_name = f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp"
    temporary_descriptor: int | None = None
    try:
        parent_opened = os.fstat(parent_descriptor)
        if not stat.S_ISDIR(parent_opened.st_mode) or (parent_opened.st_dev, parent_opened.st_ino) != expected_identity:
            raise TraceError("output parent identity changed")
        temporary_descriptor = os.open(temporary_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent_descriptor)
        view = memoryview(rendered)
        while view:
            view = view[os.write(temporary_descriptor, view):]
        os.fsync(temporary_descriptor)
        _deadline(deadline)
        try:
            os.link(temporary_name, path.name, src_dir_fd=parent_descriptor, dst_dir_fd=parent_descriptor, follow_symlinks=False)
        except FileExistsError as error:
            raise TraceError("output path appeared before publication") from error
        os.fsync(parent_descriptor)
    finally:
        if temporary_descriptor is not None:
            os.close(temporary_descriptor)
        try:
            os.unlink(temporary_name, dir_fd=parent_descriptor)
        except FileNotFoundError:
            pass
        os.close(parent_descriptor)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Trace secret fingerprints through bounded offline JSON snapshots.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(argv)
    deadline = time.monotonic() + TIMEOUT_SECONDS
    try:
        workspace = _workspace(arguments.workspace)
        source = _confined(workspace, arguments.input, exists=True)
        destination = _confined(workspace, arguments.output, exists=False)
        if source == destination or destination.exists() or not destination.parent.is_dir():
            raise TraceError("output must be new, distinct, and below an existing directory")
        parent_metadata = destination.parent.lstat()
        payload, raw, canonical_source, source_identity = _read_json(source, MAX_REQUEST_BYTES, workspace, deadline)
        if canonical_source != source or source_identity != (source.stat().st_dev, source.stat().st_ino):
            raise TraceError("input canonical identity changed")
        report = run_trace(payload, hashlib.sha256(raw).hexdigest(), workspace, deadline=deadline)
        _write(destination, report, deadline, parent_identity=(parent_metadata.st_dev, parent_metadata.st_ino))
        return 0
    except (TraceError, OSError) as error:
        print(f"secret propagation trace error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
