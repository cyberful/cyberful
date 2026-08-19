#!/usr/bin/env python3
# ── Bounded SAST Campaign ───────────────────────────────────────
# Runs local Semgrep configs over explicitly authorized workspace roots and
# preserves bounded raw JSON and stderr for later reachability analysis.
# → cyberful/builtin/skills/operate-sast-toolchain/assets/sast-campaign.schema.json — input contract.
# → cyberful/builtin/skills/operate-sast-toolchain/tests/test_run_sast_campaign.py — behavior tests.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
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
MAX_SCANS: Final = 64
CAMPAIGN_TIMEOUT_SECONDS: Final = 300
READ_CHUNK_BYTES: Final = 65_536


class CampaignError(ValueError):
    """Raised when the SAST campaign violates its local authority contract."""


def _workspace(value: str) -> Path:
    path = Path(value).resolve(strict=True)
    if not path.is_dir():
        raise CampaignError("workspace must be an existing directory")
    return path


def _confined(workspace: Path, value: str, *, exists: bool = True) -> Path:
    relative = Path(value)
    if not value or relative.is_absolute() or ".." in relative.parts:
        raise CampaignError("paths must be relative and non-traversing")
    cursor = workspace
    for part in relative.parts:
        cursor = cursor / part
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
        raise CampaignError("input must be an object")
    return value, hashlib.sha256(raw).hexdigest()


def _plan(payload: dict[str, Any], workspace: Path) -> tuple[dict[str, Any], list[tuple[str, Path, Path]]]:
    if set(payload) != {"authority", "scans"}:
        raise CampaignError("input must contain exactly authority and scans")
    authority = payload["authority"]
    scans = payload["scans"]
    if not isinstance(authority, dict) or set(authority) != {"scope_id", "allowed_roots", "max_invocations", "max_jobs"}:
        raise CampaignError("authority contract is malformed")
    allowed = authority["allowed_roots"]
    if not isinstance(allowed, list) or not allowed or not all(isinstance(item, str) and item for item in allowed):
        raise CampaignError("allowed_roots must be a non-empty array")
    allowed_paths = {str(_confined(workspace, item)) for item in allowed}
    if not isinstance(authority["scope_id"], str) or not authority["scope_id"]:
        raise CampaignError("scope_id is required")
    if not isinstance(authority["max_invocations"], int) or not 1 <= authority["max_invocations"] <= MAX_SCANS:
        raise CampaignError("max_invocations exceeds campaign limits")
    if not isinstance(authority["max_jobs"], int) or not 1 <= authority["max_jobs"] <= 8:
        raise CampaignError("max_jobs must be in 1..8")
    if not isinstance(scans, list) or not scans or len(scans) > authority["max_invocations"]:
        raise CampaignError("scan count exceeds authority")
    planned = []
    for index, scan in enumerate(scans):
        if not isinstance(scan, dict) or set(scan) != {"id", "root", "config"}:
            raise CampaignError(f"scans[{index}] is malformed")
        root = _confined(workspace, scan["root"])
        config = _confined(workspace, scan["config"])
        if str(root) not in allowed_paths:
            raise CampaignError(f"scan root is outside authority: {scan['root']}")
        if not config.is_file():
            raise CampaignError("Semgrep config must be a regular local file")
        if not isinstance(scan["id"], str) or not scan["id"]:
            raise CampaignError("scan id is required")
        planned.append((scan["id"], root, config))
    return authority, planned


def _tool_environment() -> dict[str, str]:
    environment = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
    environment.update({"NO_COLOR": "1", "SEMGREP_SEND_METRICS": "off"})
    return environment


def _terminate(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=2)
    except ProcessLookupError:
        return
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=2)


def _execute(argv: list[str], deadline: float, output_limit: int) -> dict[str, Any]:
    if output_limit <= 0:
        raise CampaignError("campaign output budget is exhausted")
    started = time.monotonic()
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, shell=False, env=_tool_environment())
    stdout = bytearray()
    stderr = bytearray()
    selector = selectors.DefaultSelector()
    assert process.stdout is not None and process.stderr is not None
    selector.register(process.stdout, selectors.EVENT_READ, stdout)
    selector.register(process.stderr, selectors.EVENT_READ, stderr)
    failure: CampaignError | None = None
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                failure = CampaignError("SAST campaign exceeded its global deadline")
                break
            events = selector.select(timeout=min(remaining, 0.2))
            for key, _ in events:
                chunk = os.read(key.fileobj.fileno(), READ_CHUNK_BYTES)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                if len(chunk) > output_limit - len(stdout) - len(stderr):
                    failure = CampaignError("raw Semgrep output exceeds the remaining output boundary")
                    break
                key.data.extend(chunk)
            if failure is not None:
                break
        if failure is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                failure = CampaignError("SAST campaign exceeded its global deadline")
            else:
                try:
                    process.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    failure = CampaignError("SAST campaign exceeded its global deadline")
    finally:
        selector.close()
        _terminate(process)
        process.stdout.close()
        process.stderr.close()
    if failure is not None:
        raise failure
    return {"argv": argv, "exit_code": process.returncode, "duration_ms": round((time.monotonic() - started) * 1000), "stdout": stdout.decode("utf-8", errors="replace"), "stderr": stderr.decode("utf-8", errors="replace")}


def run_campaign(payload: dict[str, Any], digest: str, workspace: Path, *, executable: str = "semgrep", deadline_seconds: float = CAMPAIGN_TIMEOUT_SECONDS) -> dict[str, Any]:
    workspace = workspace.resolve(strict=True)
    authority, planned = _plan(payload, workspace)
    deadline = time.monotonic() + deadline_seconds
    budget = MAX_OUTPUT_BYTES
    version_run = _execute([executable, "--version"], deadline, budget)
    budget -= len(version_run["stdout"].encode()) + len(version_run["stderr"].encode())
    version = (version_run["stdout"] or version_run["stderr"]).strip()[:500]
    executions = []
    for scan_id, root, config in planned:
        argv = [executable, "scan", "--metrics=off", "--json", "--jobs", str(authority["max_jobs"]), "--config", str(config), "--", str(root)]
        execution = _execute(argv, deadline, budget)
        budget -= len(execution["stdout"].encode()) + len(execution["stderr"].encode())
        executions.append({"scan_id": scan_id, **execution})
    return {"format": "cyberful.sast-campaign.raw.v1", "input_sha256": digest, "scope_id": authority["scope_id"], "tool": {"name": "semgrep", "version": version}, "environment": {"network": "none", "inherited": sorted(_tool_environment()), "telemetry_enabled": False}, "executions": executions}


def _write(path: Path, report: dict[str, Any]) -> None:
    raw = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode()
    if len(raw) > MAX_OUTPUT_BYTES:
        raise CampaignError("report exceeds the output boundary")
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
    parser = argparse.ArgumentParser(description="Run an authorized local Semgrep campaign.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        workspace = _workspace(args.workspace)
        source = _confined(workspace, args.input)
        destination = _confined(workspace, args.output, exists=False)
        if source == destination or not destination.parent.is_dir():
            raise CampaignError("output must be distinct with an existing parent")
        payload, digest = _read(source)
        _write(destination, run_campaign(payload, digest, workspace))
        return 0
    except (CampaignError, OSError) as error:
        print(f"SAST campaign error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
