#!/usr/bin/env python3
# ── Local Model Supply-Chain Campaign ───────────────────────────
# Runs fixed, update-disabled Syft collection over explicitly authorized local
# model artifacts and preserves bounded raw JSON evidence.
# → cyberful/builtin/skills/audit-ai-model-supply-chain/assets/model-supply-chain-campaign.schema.json — input contract.
# → cyberful/builtin/skills/audit-ai-model-supply-chain/tests/test_run_model_supply_chain_campaign.py — tests.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Final


MAX_INPUT_BYTES: Final = 1_048_576
MAX_OUTPUT_BYTES: Final = 16_777_216
MAX_ARTIFACTS: Final = 32
MAX_TREE_ENTRIES: Final = 100_000
CAMPAIGN_TIMEOUT_SECONDS: Final = 300


class CampaignError(ValueError):
    """Raised when local authority or campaign bounds are violated."""


def _confined(workspace: Path, value: str, *, exists: bool = True) -> Path:
    relative = Path(value)
    if not value or relative.is_absolute() or ".." in relative.parts:
        raise CampaignError("paths must be relative and non-traversing")
    cursor = workspace
    for part in relative.parts:
        cursor /= part
        if cursor.is_symlink():
            raise CampaignError("symbolic links are not allowed")
    path = (workspace / relative).resolve(strict=exists)
    try:
        path.relative_to(workspace)
    except ValueError as error:
        raise CampaignError("path escapes workspace") from error
    return path


def _read(path: Path) -> tuple[dict[str, Any], str]:
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
        raise CampaignError("input must be a bounded regular file")
    raw = path.read_bytes()
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CampaignError("input must be UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise CampaignError("input must be a JSON object")
    return value, hashlib.sha256(raw).hexdigest()


def _validate_artifact_tree(root: Path, deadline: float) -> None:
    pending = [root]
    entries = 0
    while pending:
        if time.monotonic() > deadline:
            raise CampaignError("model supply-chain campaign exceeded its global deadline during preflight")
        path = pending.pop()
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise CampaignError(f"artifact tree contains a symbolic link: {path.name}")
        if stat.S_ISREG(metadata.st_mode):
            entries += 1
        elif stat.S_ISDIR(metadata.st_mode):
            entries += 1
            with os.scandir(path) as iterator:
                children = sorted((Path(entry.path) for entry in iterator), key=lambda item: item.name, reverse=True)
            pending.extend(children)
        else:
            raise CampaignError(f"artifact tree contains a special file: {path.name}")
        if entries > MAX_TREE_ENTRIES:
            raise CampaignError("artifact tree exceeds the preflight entry boundary")


def _validated(payload: dict[str, Any], workspace: Path, deadline: float) -> tuple[dict[str, Any], list[tuple[str, Path]]]:
    if set(payload) != {"authority", "artifacts"}:
        raise CampaignError("input must contain exactly authority and artifacts")
    authority = payload["authority"]
    if not isinstance(authority, dict) or set(authority) != {"scope_id", "allowed_artifacts", "max_invocations"}:
        raise CampaignError("authority contract is malformed")
    allowed = authority["allowed_artifacts"]
    if not isinstance(allowed, list) or not allowed:
        raise CampaignError("allowed_artifacts must be a non-empty array")
    allowed_paths = {_confined(workspace, item) for item in allowed if isinstance(item, str)}
    if len(allowed_paths) != len(allowed):
        raise CampaignError("allowed_artifacts must contain unique relative paths")
    if not isinstance(authority["scope_id"], str) or not authority["scope_id"]:
        raise CampaignError("scope_id is required")
    maximum = authority["max_invocations"]
    if not isinstance(maximum, int) or not 1 <= maximum <= MAX_ARTIFACTS:
        raise CampaignError("max_invocations exceeds campaign limits")
    artifacts = payload["artifacts"]
    if not isinstance(artifacts, list) or not artifacts or len(artifacts) > maximum:
        raise CampaignError("artifact count exceeds authority")
    planned = []
    for index, item in enumerate(artifacts):
        if not isinstance(item, dict) or set(item) != {"id", "path"} or not isinstance(item["id"], str) or not item["id"] or not isinstance(item["path"], str):
            raise CampaignError(f"artifacts[{index}] is malformed")
        path = _confined(workspace, item["path"])
        if path not in allowed_paths:
            raise CampaignError(f"artifact is outside authority: {item['path']}")
        _validate_artifact_tree(path, deadline)
        planned.append((item["id"], path))
    return authority, planned


def _environment() -> dict[str, str]:
    result = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
    result.update({"NO_COLOR": "1", "SYFT_CHECK_FOR_APP_UPDATE": "false"})
    return result


def _signal_group(process_group: int, signal_number: int) -> None:
    try:
        os.killpg(process_group, signal_number)
    except ProcessLookupError:
        return
    except OSError as error:
        # Darwin reports EPERM when a terminated group contains only zombies;
        # there is then no signalable descendant left to clean up.
        if error.errno not in {errno.ESRCH, errno.EPERM}:
            raise


def _terminate(process: subprocess.Popen[bytes], process_group: int) -> None:
    # Do not poll or reap the group leader before both signals: retaining its PID
    # prevents reuse while orphaned descendants in the session are cleaned up.
    _signal_group(process_group, signal.SIGTERM)
    time.sleep(0.05)
    _signal_group(process_group, signal.SIGKILL)
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired as error:
        raise CampaignError("model supply-chain process group could not be reaped") from error


def _run(argv: list[str], deadline: float, limit: int) -> dict[str, Any]:
    if limit <= 0:
        raise CampaignError("raw campaign output boundary is exhausted")
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=_environment(), shell=False, start_new_session=True)
    process_group = process.pid
    stdout, stderr = bytearray(), bytearray()
    selector = selectors.DefaultSelector()
    assert process.stdout is not None and process.stderr is not None
    selector.register(process.stdout, selectors.EVENT_READ, stdout)
    selector.register(process.stderr, selectors.EVENT_READ, stderr)
    failure: CampaignError | None = None
    started = time.monotonic()
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                failure = CampaignError("model supply-chain campaign exceeded its global deadline")
                break
            for key, _ in selector.select(min(remaining, 0.2)):
                chunk = os.read(key.fileobj.fileno(), 65_536)
                if not chunk:
                    selector.unregister(key.fileobj)
                elif len(chunk) > limit - len(stdout) - len(stderr):
                    failure = CampaignError("raw campaign output exceeds the remaining boundary")
                    break
                else:
                    key.data.extend(chunk)
            if failure:
                break
    finally:
        selector.close()
        try:
            _terminate(process, process_group)
        finally:
            process.stdout.close()
            process.stderr.close()
    if failure:
        raise failure
    return {"argv": argv, "exit_code": process.returncode, "duration_ms": round((time.monotonic() - started) * 1000), "stdout": stdout.decode(errors="replace"), "stderr": stderr.decode(errors="replace")}


def run_campaign(payload: dict[str, Any], digest: str, workspace: Path, *, deadline_seconds: float = CAMPAIGN_TIMEOUT_SECONDS) -> dict[str, Any]:
    workspace = workspace.resolve(strict=True)
    deadline = time.monotonic() + deadline_seconds
    authority, artifacts = _validated(payload, workspace, deadline)
    budget = MAX_OUTPUT_BYTES
    version_run = _run(["syft", "version", "-o", "json"], deadline, budget)
    budget -= len(version_run["stdout"].encode()) + len(version_run["stderr"].encode())
    runs = []
    for artifact_id, path in artifacts:
        _validate_artifact_tree(path, deadline)
        run = _run(["syft", "scan", str(path), "-o", "json"], deadline, budget)
        budget -= len(run["stdout"].encode()) + len(run["stderr"].encode())
        runs.append({"artifact_id": artifact_id, **run})
    return {"format": "cyberful.ai-model-supply-chain.raw.v1", "input_sha256": digest, "scope_id": authority["scope_id"], "tool": {"name": "syft", "version_raw": version_run["stdout"][:2048]}, "environment": {"network": "none", "telemetry_enabled": False}, "runs": runs}


def _write(path: Path, report: dict[str, Any]) -> None:
    raw = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode()
    if len(raw) > MAX_OUTPUT_BYTES:
        raise CampaignError("report exceeds output boundary")
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
            temporary = handle.name
            os.chmod(temporary, 0o600)
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary:
            Path(temporary).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a bounded offline model supply-chain campaign.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        workspace = Path(args.workspace).resolve(strict=True)
        source = _confined(workspace, args.input)
        output = _confined(workspace, args.output, exists=False)
        if output == source or not output.parent.is_dir():
            raise CampaignError("output must be distinct with an existing parent")
        payload, digest = _read(source)
        _write(output, run_campaign(payload, digest, workspace))
        return 0
    except (CampaignError, OSError) as error:
        print(f"model supply-chain campaign error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
