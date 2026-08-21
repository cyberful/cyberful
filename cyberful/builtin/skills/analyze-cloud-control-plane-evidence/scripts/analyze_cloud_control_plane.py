#!/usr/bin/env python3
# ── Offline Cloud Control-Plane Evidence Analyzer ───────────
# Reconciles bounded normalized snapshots by immutable resource identity and
#   emits deterministic drift observations without querying a cloud provider.
# → cyberful/builtin/skills/analyze-cloud-control-plane-evidence/assets/cloud-control-plane-input.schema.json — input.
# → cyberful/builtin/skills/analyze-cloud-control-plane-evidence/assets/cloud-control-plane-evidence.schema.json — output.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
from typing import Any, Final


INPUT_SCHEMA: Final = "assets/cloud-control-plane-input.schema.json"
MAX_REQUEST_BYTES: Final = 1_048_576
MAX_SNAPSHOT_BYTES: Final = 8_388_608
MAX_RESOURCES: Final = 10_000
MAX_OUTPUT_BYTES: Final = 4_194_304
TIMEOUT_SECONDS: Final = 20.0
SHA256: Final = re.compile(r"^[a-f0-9]{64}$")
PROVIDERS: Final = frozenset(("aws", "azure", "gcp", "kubernetes", "other"))
RESOURCE_FIELDS: Final = ("kind", "region", "public", "principals", "policy_sha256", "encrypted", "logging", "lifecycle")


class AnalysisError(ValueError):
    """Raised when input or output violates the offline evidence boundary."""


@dataclass(frozen=True)
class Resource:
    resource_id: str
    kind: str
    region: str
    public: bool
    principals: tuple[str, ...]
    policy_sha256: str | None
    encrypted: bool | None
    logging: bool | None
    lifecycle: str


@dataclass(frozen=True)
class Snapshot:
    snapshot_id: str
    path: str
    provider: str
    account: str
    captured_at: str
    file_sha256: str
    resources: dict[str, Resource]


# ── Snapshot Evidence Is Confined And Deterministic ─────────────
# The request identifies existing normalized JSON artifacts but cannot select a
# collector, provider command, or network route. Symlinks and traversal are
# rejected, every snapshot is fully validated before comparison, and adjacent
# snapshots must share provider/account identity. Canonical ordering and a single
# monotonic deadline make repeated analysis reproducible and end-to-end bounded.
# ─────────────────────────────────────────────────────────────────
def _deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise AnalysisError("cloud control-plane analysis exceeded its global deadline")


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise AnalysisError("workspace must be an existing directory")
    return workspace


def _confined(workspace: Path, value: str, *, exists: bool) -> Path:
    workspace = workspace.resolve(strict=True)
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


def _read(path: Path, maximum: int, workspace: Path, deadline: float) -> tuple[Any, bytes, Path, tuple[int, int]]:
    expected = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(expected.st_mode) or expected.st_size > maximum:
        raise AnalysisError("input must be a bounded regular file")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        canonical = path.resolve(strict=True)
        try:
            canonical.relative_to(workspace.resolve(strict=True))
        except ValueError as error:
            raise AnalysisError("input resolved outside workspace") from error
        resolved = canonical.stat()
        if len({(expected.st_dev, expected.st_ino), (opened.st_dev, opened.st_ino), (resolved.st_dev, resolved.st_ino)}) != 1 or not stat.S_ISREG(opened.st_mode) or opened.st_size > maximum:
            raise AnalysisError("input identity changed while opening")
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
                raise AnalysisError("input exceeds its byte boundary")
        final = os.fstat(descriptor)
        if (final.st_dev, final.st_ino, final.st_size) != (opened.st_dev, opened.st_ino, opened.st_size) or observed != opened.st_size:
            raise AnalysisError("input changed while reading")
        raw = b"".join(chunks)
    finally:
        os.close(descriptor)
    try:
        return json.loads(raw.decode("utf-8")), raw, canonical, (opened.st_dev, opened.st_ino)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise AnalysisError(f"{path.name} must be UTF-8 JSON") from error


def _text(value: Any, label: str, maximum: int, *, empty: bool = False, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or (not empty and not value) or len(value.encode()) > maximum:
        raise AnalysisError(f"{label} must be a bounded string")
    return value


def _request(payload: Any) -> tuple[dict[str, Any], ...]:
    if not isinstance(payload, dict) or set(payload) != {"$schema", "snapshots"} or payload.get("$schema") != INPUT_SCHEMA:
        raise AnalysisError("input contract or $schema is malformed")
    snapshots = payload["snapshots"]
    if not isinstance(snapshots, list) or not 2 <= len(snapshots) <= 16:
        raise AnalysisError("snapshots must contain 2..16 entries")
    fields = {"id", "path", "provider", "account", "captured_at"}
    normalized: list[dict[str, Any]] = []
    identifiers: set[str] = set()
    for index, item in enumerate(snapshots):
        if not isinstance(item, dict) or set(item) != fields:
            raise AnalysisError(f"snapshots[{index}] is malformed")
        snapshot_id = _text(item["id"], f"snapshots[{index}].id", 128)
        path = _text(item["path"], f"snapshots[{index}].path", 512)
        provider = _text(item["provider"], f"snapshots[{index}].provider", 32)
        account = _text(item["account"], f"snapshots[{index}].account", 256)
        captured_at = _text(item["captured_at"], f"snapshots[{index}].captured_at", 64)
        assert snapshot_id and path and provider and account and captured_at
        if provider not in PROVIDERS or snapshot_id in identifiers:
            raise AnalysisError("snapshot provider is unsupported or id is duplicated")
        try:
            moment = datetime.fromisoformat(captured_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise AnalysisError(f"snapshots[{index}].captured_at is invalid") from error
        if moment.tzinfo is None:
            raise AnalysisError(f"snapshots[{index}].captured_at must include a timezone")
        identifiers.add(snapshot_id)
        normalized.append({"id": snapshot_id, "path": path, "provider": provider, "account": account, "captured_at": captured_at})
    for before, after in zip(normalized, normalized[1:]):
        if (before["provider"], before["account"]) != (after["provider"], after["account"]):
            raise AnalysisError("adjacent snapshots must share provider and account identity")
        before_time = datetime.fromisoformat(before["captured_at"].replace("Z", "+00:00"))
        after_time = datetime.fromisoformat(after["captured_at"].replace("Z", "+00:00"))
        if before_time >= after_time:
            raise AnalysisError("snapshot capture times must increase strictly")
    return tuple(normalized)


def _strings(value: Any, label: str, deadline: float) -> tuple[str, ...]:
    if not isinstance(value, list) or len(value) > 256:
        raise AnalysisError(f"{label} must be a bounded string array")
    normalized: list[str] = []
    for item in value:
        _deadline(deadline)
        text = _text(item, label, 512, empty=True)
        assert text is not None
        normalized.append(text)
    if len(set(normalized)) != len(normalized):
        raise AnalysisError(f"{label} must not contain duplicates")
    return tuple(sorted(normalized))


def _snapshot(workspace: Path, descriptor: dict[str, Any], deadline: float) -> tuple[Snapshot, Path, tuple[int, int]]:
    path = _confined(workspace, descriptor["path"], exists=True)
    document, raw, canonical, identity = _read(path, MAX_SNAPSHOT_BYTES, workspace, deadline)
    if not isinstance(document, dict) or set(document) != {"resources"}:
        raise AnalysisError(f"{descriptor['path']} snapshot is malformed")
    raw_resources = document["resources"]
    if not isinstance(raw_resources, list) or len(raw_resources) > MAX_RESOURCES:
        raise AnalysisError(f"{descriptor['path']} resources exceed their boundary")
    resources: dict[str, Resource] = {}
    fields = {"id", "kind", "region", "public", "principals", "policy_sha256", "encrypted", "logging", "lifecycle"}
    for index, item in enumerate(raw_resources):
        _deadline(deadline)
        if not isinstance(item, dict) or set(item) != fields:
            raise AnalysisError(f"{descriptor['path']} resources[{index}] is malformed")
        resource_id = _text(item["id"], "resource id", 512)
        kind = _text(item["kind"], "resource kind", 128)
        region = _text(item["region"], "resource region", 128, empty=True)
        policy = _text(item["policy_sha256"], "policy sha256", 64, nullable=True)
        lifecycle = _text(item["lifecycle"], "resource lifecycle", 64)
        assert resource_id and kind and region is not None and lifecycle
        if resource_id in resources or (policy is not None and not SHA256.fullmatch(policy)):
            raise AnalysisError(f"{descriptor['path']} contains a duplicate id or malformed digest")
        if not isinstance(item["public"], bool) or not (item["encrypted"] is None or isinstance(item["encrypted"], bool)) or not (item["logging"] is None or isinstance(item["logging"], bool)):
            raise AnalysisError(f"{descriptor['path']} contains malformed boolean evidence")
        resources[resource_id] = Resource(resource_id, kind, region, item["public"], _strings(item["principals"], "principals", deadline), policy, item["encrypted"], item["logging"], lifecycle)
    return Snapshot(descriptor["id"], descriptor["path"], descriptor["provider"], descriptor["account"], descriptor["captured_at"], hashlib.sha256(raw).hexdigest(), resources), canonical, identity


def _summary(snapshot: Snapshot) -> dict[str, Any]:
    return {"id": snapshot.snapshot_id, "path": snapshot.path, "provider": snapshot.provider, "account": snapshot.account, "captured_at": snapshot.captured_at, "sha256": snapshot.file_sha256, "resources": len(snapshot.resources)}


def analyze(payload: Any, digest: str, workspace: Path, *, deadline: float, output_limit: int = MAX_OUTPUT_BYTES) -> dict[str, Any]:
    snapshots: list[Snapshot] = []
    snapshot_paths: set[Path] = set()
    snapshot_identities: set[tuple[int, int]] = set()
    for descriptor in _request(payload):
        _deadline(deadline)
        snapshot, canonical, identity = _snapshot(workspace, descriptor, deadline)
        if canonical in snapshot_paths or identity in snapshot_identities:
            raise AnalysisError("snapshot inputs must be canonically and inode-distinct")
        snapshot_paths.add(canonical)
        snapshot_identities.add(identity)
        snapshots.append(snapshot)
    transitions: list[dict[str, Any]] = []
    for before, after in zip(snapshots, snapshots[1:]):
        for resource_id in sorted(set(before.resources) | set(after.resources)):
            _deadline(deadline)
            old = before.resources.get(resource_id)
            new = after.resources.get(resource_id)
            if old is None:
                transitions.append({"from_snapshot": before.snapshot_id, "to_snapshot": after.snapshot_id, "resource_id": resource_id, "change": "added", "fields": []})
            elif new is None:
                transitions.append({"from_snapshot": before.snapshot_id, "to_snapshot": after.snapshot_id, "resource_id": resource_id, "change": "removed", "fields": []})
            else:
                changed = [field for field in RESOURCE_FIELDS if getattr(old, field) != getattr(new, field)]
                if changed:
                    transitions.append({"from_snapshot": before.snapshot_id, "to_snapshot": after.snapshot_id, "resource_id": resource_id, "change": "changed", "fields": changed})
    report = {"format": "cyberful.cloud-control-plane-evidence.raw.v1", "input_sha256": digest, "snapshots": [_summary(snapshot) for snapshot in snapshots], "transitions": transitions, "counts": {"snapshots": len(snapshots), "transitions": len(transitions)}}
    _deadline(deadline)
    rendered = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode()
    if not 1 <= output_limit <= MAX_OUTPUT_BYTES or len(rendered) > output_limit:
        raise AnalysisError("cloud control-plane evidence exceeds the output boundary")
    return report


def _write(path: Path, report: dict[str, Any], deadline: float, output_limit: int = MAX_OUTPUT_BYTES, parent_identity: tuple[int, int] | None = None) -> None:
    if path.exists():
        raise AnalysisError("output path already exists")
    _deadline(deadline)
    rendered = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode()
    if len(rendered) > output_limit:
        raise AnalysisError("cloud control-plane evidence exceeds the output boundary")
    parent_expected = path.parent.lstat()
    expected_identity = parent_identity or (parent_expected.st_dev, parent_expected.st_ino)
    parent_descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    temporary_name = f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp"
    temporary_descriptor: int | None = None
    try:
        parent_opened = os.fstat(parent_descriptor)
        if not stat.S_ISDIR(parent_opened.st_mode) or (parent_opened.st_dev, parent_opened.st_ino) != expected_identity:
            raise AnalysisError("output parent identity changed")
        temporary_descriptor = os.open(temporary_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent_descriptor)
        view = memoryview(rendered)
        while view:
            view = view[os.write(temporary_descriptor, view):]
        os.fsync(temporary_descriptor)
        _deadline(deadline)
        try:
            os.link(temporary_name, path.name, src_dir_fd=parent_descriptor, dst_dir_fd=parent_descriptor, follow_symlinks=False)
        except FileExistsError as error:
            raise AnalysisError("output path appeared before publication") from error
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
    parser = argparse.ArgumentParser(description="Analyze bounded cloud control-plane snapshots offline.")
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
            raise AnalysisError("output must be new, distinct, and below an existing directory")
        parent_metadata = destination.parent.lstat()
        payload, raw, canonical_source, source_identity = _read(source, MAX_REQUEST_BYTES, workspace, deadline)
        source_now = source.stat()
        if canonical_source != source or source_identity != (source_now.st_dev, source_now.st_ino):
            raise AnalysisError("input canonical identity changed")
        _write(destination, analyze(payload, hashlib.sha256(raw).hexdigest(), workspace, deadline=deadline), deadline, parent_identity=(parent_metadata.st_dev, parent_metadata.st_ino))
        return 0
    except (AnalysisError, OSError) as error:
        print(f"cloud control-plane analysis error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
