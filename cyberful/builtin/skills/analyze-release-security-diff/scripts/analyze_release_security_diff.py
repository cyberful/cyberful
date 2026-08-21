#!/usr/bin/env python3
# ── Offline Release Security Diff ────────────────────────────────
# Compares two bounded release manifests by immutable artifact identity and
#   emits deterministic trust-boundary deltas without external processes.
# → cyberful/builtin/skills/analyze-release-security-diff/assets/release-security-diff-input.schema.json — input contract.
# → cyberful/builtin/skills/analyze-release-security-diff/tests/test_analyze_release_security_diff.py — boundary tests.
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
from typing import Any, Final


INPUT_SCHEMA: Final = "assets/release-security-diff-input.schema.json"
MAX_REQUEST_BYTES: Final = 1_048_576
MAX_MANIFEST_BYTES: Final = 4_194_304
MAX_ARTIFACTS: Final = 10_000
MAX_OUTPUT_BYTES: Final = 2_097_152
TIMEOUT_SECONDS: Final = 15
SHA256: Final = re.compile(r"^[a-f0-9]{64}$")


class DiffError(ValueError):
    """Raised when release input or output violates an offline boundary."""


@dataclass(frozen=True)
class Artifact:
    path: str
    sha256: str
    provenance_sha256: str | None
    signer: str | None
    permissions: tuple[str, ...]
    dependencies: tuple[str, ...]


@dataclass(frozen=True)
class Release:
    path: str
    file_sha256: str
    release_id: str
    source_revision: str
    artifacts: dict[str, Artifact]
    canonical_path: Path
    identity: tuple[int, int]


# ── Release Comparison Uses Immutable Evidence Only ──────────────
# The request names exactly two confined manifests and cannot cause dependency
# resolution, signature verification, or network access. Artifact paths are logical
# identities inside those manifests, while file reads remain rooted in the staged
# workspace. Canonical sorting makes identical evidence produce identical output,
# and one monotonic deadline includes validation, comparison, fsync, and publication.
# ─────────────────────────────────────────────────────────────────


def _deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise DiffError("release security diff exceeded its global deadline")


def _workspace(value: str) -> Path:
    path = Path(value).resolve(strict=True)
    if not path.is_dir():
        raise DiffError("workspace must be an existing directory")
    return path


def _confined(workspace: Path, value: str, *, exists: bool) -> Path:
    workspace = workspace.resolve(strict=True)
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise DiffError("paths must be relative and non-traversing")
    cursor = workspace
    for part in requested.parts:
        cursor /= part
        if cursor.is_symlink():
            raise DiffError("symbolic links are not allowed")
    resolved = (workspace / requested).resolve(strict=exists)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise DiffError("path escapes workspace") from error
    return resolved


def _read(path: Path, maximum: int, workspace: Path, deadline: float) -> tuple[Any, bytes, Path, tuple[int, int]]:
    expected = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(expected.st_mode) or expected.st_size > maximum:
        raise DiffError("input must be a bounded regular file")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        canonical = path.resolve(strict=True)
        try:
            canonical.relative_to(workspace.resolve(strict=True))
        except ValueError as error:
            raise DiffError("input resolved outside workspace") from error
        resolved = canonical.stat()
        if len({(expected.st_dev, expected.st_ino), (opened.st_dev, opened.st_ino), (resolved.st_dev, resolved.st_ino)}) != 1 or not stat.S_ISREG(opened.st_mode) or opened.st_size > maximum:
            raise DiffError("input identity changed while opening")
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
                raise DiffError("input exceeds its byte boundary")
        final = os.fstat(descriptor)
        if (final.st_dev, final.st_ino, final.st_size) != (opened.st_dev, opened.st_ino, opened.st_size) or observed != opened.st_size:
            raise DiffError("input changed while reading")
        raw = b"".join(chunks)
    finally:
        os.close(descriptor)
    try:
        return json.loads(raw.decode("utf-8")), raw, canonical, (opened.st_dev, opened.st_ino)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise DiffError(f"{path.name} must be UTF-8 JSON") from error


def _text(value: Any, label: str, maximum: int, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not value or len(value.encode()) > maximum:
        raise DiffError(f"{label} must be a bounded string")
    return value


def _strings(value: Any, label: str, maximum_items: int, maximum_text: int, deadline: float) -> tuple[str, ...]:
    if not isinstance(value, list) or len(value) > maximum_items:
        raise DiffError(f"{label} must be a bounded string array")
    for item in value:
        _deadline(deadline)
        if not isinstance(item, str) or len(item.encode()) > maximum_text:
            raise DiffError(f"{label} must be a bounded string array")
    if len(set(value)) != len(value):
        raise DiffError(f"{label} must not contain duplicates")
    return tuple(sorted(value))


def _request(payload: Any) -> tuple[str, str]:
    if not isinstance(payload, dict) or set(payload) != {"$schema", "baseline", "candidate"} or payload["$schema"] != INPUT_SCHEMA:
        raise DiffError("input contract or $schema is malformed")
    baseline = _text(payload["baseline"], "baseline", 512)
    candidate = _text(payload["candidate"], "candidate", 512)
    assert baseline is not None and candidate is not None
    if baseline == candidate:
        raise DiffError("baseline and candidate must be distinct")
    return baseline, candidate


def _release(workspace: Path, relative: str, deadline: float) -> Release:
    path = _confined(workspace, relative, exists=True)
    document, raw, canonical, identity = _read(path, MAX_MANIFEST_BYTES, workspace, deadline)
    if not isinstance(document, dict) or set(document) != {"release_id", "source_revision", "artifacts"}:
        raise DiffError(f"{relative} release manifest is malformed")
    raw_artifacts = document["artifacts"]
    if not isinstance(raw_artifacts, list) or len(raw_artifacts) > MAX_ARTIFACTS:
        raise DiffError(f"{relative} artifacts exceed their boundary")
    artifacts: dict[str, Artifact] = {}
    for index, raw_artifact in enumerate(raw_artifacts):
        _deadline(deadline)
        required = {"path", "sha256", "provenance_sha256", "signer", "permissions", "dependencies"}
        if not isinstance(raw_artifact, dict) or set(raw_artifact) != required:
            raise DiffError(f"{relative} artifacts[{index}] is malformed")
        logical_path = _text(raw_artifact["path"], "artifact path", 512)
        digest = _text(raw_artifact["sha256"], "artifact sha256", 64)
        provenance = _text(raw_artifact["provenance_sha256"], "provenance sha256", 64, nullable=True)
        signer = _text(raw_artifact["signer"], "signer", 512, nullable=True)
        assert logical_path is not None and digest is not None
        if not SHA256.fullmatch(digest) or (provenance is not None and not SHA256.fullmatch(provenance)) or logical_path in artifacts:
            raise DiffError(f"{relative} contains a malformed digest or duplicate artifact")
        artifacts[logical_path] = Artifact(logical_path, digest, provenance, signer, _strings(raw_artifact["permissions"], "permissions", 256, 256, deadline), _strings(raw_artifact["dependencies"], "dependencies", 2048, 512, deadline))
    release_id = _text(document["release_id"], "release_id", 128)
    revision = _text(document["source_revision"], "source_revision", 256)
    assert release_id is not None and revision is not None
    return Release(relative, hashlib.sha256(raw).hexdigest(), release_id, revision, artifacts, canonical, identity)


def run_diff(payload: Any, digest: str, workspace: Path, *, deadline: float, output_limit: int = MAX_OUTPUT_BYTES) -> dict[str, Any]:
    baseline_path, candidate_path = _request(payload)
    _deadline(deadline)
    baseline = _release(workspace, baseline_path, deadline)
    _deadline(deadline)
    candidate = _release(workspace, candidate_path, deadline)
    if baseline.canonical_path == candidate.canonical_path or baseline.identity == candidate.identity:
        raise DiffError("baseline and candidate must be canonically and inode-distinct")
    changes: list[dict[str, Any]] = []
    for logical_path in sorted(set(baseline.artifacts) | set(candidate.artifacts)):
        _deadline(deadline)
        before = baseline.artifacts.get(logical_path)
        after = candidate.artifacts.get(logical_path)
        if before is None:
            changes.append({"path": logical_path, "change": "added", "fields": []})
        elif after is None:
            changes.append({"path": logical_path, "change": "removed", "fields": []})
        else:
            fields = [field for field in ("sha256", "provenance_sha256", "signer", "permissions", "dependencies") if getattr(before, field) != getattr(after, field)]
            if fields:
                changes.append({"path": logical_path, "change": "changed", "fields": fields})
    summary = lambda release: {"path": release.path, "sha256": release.file_sha256, "release_id": release.release_id, "source_revision": release.source_revision, "artifacts": len(release.artifacts)}
    report = {
        "format": "cyberful.release-security-diff.raw.v1", "input_sha256": digest,
        "baseline": summary(baseline), "candidate": summary(candidate), "changes": changes,
        "counts": {kind: sum(item["change"] == kind for item in changes) for kind in ("added", "removed", "changed")},
    }
    _deadline(deadline)
    rendered = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode()
    if not 1 <= output_limit <= MAX_OUTPUT_BYTES or len(rendered) > output_limit:
        raise DiffError("release diff evidence exceeds the output boundary")
    return report


def _write(path: Path, value: dict[str, Any], deadline: float, output_limit: int = MAX_OUTPUT_BYTES, parent_identity: tuple[int, int] | None = None) -> None:
    if path.exists():
        raise DiffError("output path already exists")
    _deadline(deadline)
    rendered = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    if len(rendered) > output_limit:
        raise DiffError("release diff evidence exceeds the output boundary")
    parent_expected = path.parent.lstat()
    expected_identity = parent_identity or (parent_expected.st_dev, parent_expected.st_ino)
    parent_descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    temporary_name = f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp"
    temporary_descriptor: int | None = None
    try:
        parent_opened = os.fstat(parent_descriptor)
        if not stat.S_ISDIR(parent_opened.st_mode) or (parent_opened.st_dev, parent_opened.st_ino) != expected_identity:
            raise DiffError("output parent identity changed")
        temporary_descriptor = os.open(temporary_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent_descriptor)
        view = memoryview(rendered)
        while view:
            view = view[os.write(temporary_descriptor, view):]
        os.fsync(temporary_descriptor)
        _deadline(deadline)
        try:
            os.link(temporary_name, path.name, src_dir_fd=parent_descriptor, dst_dir_fd=parent_descriptor, follow_symlinks=False)
        except FileExistsError as error:
            raise DiffError("output path appeared before publication") from error
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
    parser = argparse.ArgumentParser(description="Compare bounded release manifests offline.")
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
            raise DiffError("output must be new, distinct, and below an existing directory")
        parent_metadata = destination.parent.lstat()
        payload, raw, canonical_source, source_identity = _read(source, MAX_REQUEST_BYTES, workspace, deadline)
        source_now = source.stat()
        if canonical_source != source or source_identity != (source_now.st_dev, source_now.st_ino):
            raise DiffError("input canonical identity changed")
        report = run_diff(payload, hashlib.sha256(raw).hexdigest(), workspace, deadline=deadline)
        _write(destination, report, deadline, parent_identity=(parent_metadata.st_dev, parent_metadata.st_ino))
        return 0
    except (DiffError, OSError) as error:
        print(f"release security diff error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
