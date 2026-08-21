#!/usr/bin/env python3
# ── Authorized Network Recon Campaign ───────────────────────────
# Executes bounded Nmap connect scans from an explicit authority contract and
# retains raw stdout/stderr without interpreting a service as a vulnerability.
# → cyberful/builtin/skills/operate-network-recon/assets/network-recon-campaign.schema.json — input contract.
# → cyberful/builtin/skills/operate-network-recon/tests/test_run_network_recon_campaign.py — forward tests.
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
MAX_OUTPUT_BYTES: Final = 4_194_304
MAX_TARGETS: Final = 256
MAX_PORTS: Final = 4_096
CAMPAIGN_TIMEOUT_SECONDS: Final = 120
READ_CHUNK_BYTES: Final = 65_536


class CampaignError(ValueError):
    """Raised when authority, input, or execution violates campaign bounds."""


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise CampaignError("workspace must be an existing directory")
    return workspace


def _confined(workspace: Path, value: str, *, exists: bool) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise CampaignError("paths must be relative and non-traversing")
    cursor = workspace
    for part in requested.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise CampaignError("symbolic links are not allowed")
    resolved = (workspace / requested).resolve(strict=exists)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise CampaignError("path escapes workspace") from error
    return resolved


def _read_json(path: Path) -> tuple[dict[str, Any], str]:
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


def _port(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 65_535:
        raise CampaignError("ports must be integers in 1..65535")
    return value


def _validated(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if set(payload) != {"authority", "targets"}:
        raise CampaignError("input must contain exactly authority and targets")
    authority = payload["authority"]
    targets = payload["targets"]
    if not isinstance(authority, dict) or set(authority) != {"scope_id", "allowed_hosts", "allowed_ports", "max_requests"}:
        raise CampaignError("authority contract is malformed")
    allowed_hosts = authority["allowed_hosts"]
    allowed_ports = authority["allowed_ports"]
    if not isinstance(allowed_hosts, list) or not allowed_hosts or not all(isinstance(item, str) and item for item in allowed_hosts):
        raise CampaignError("allowed_hosts must be a non-empty string array")
    if not isinstance(allowed_ports, list) or not allowed_ports:
        raise CampaignError("allowed_ports must be a non-empty port array")
    port_set = {_port(item) for item in allowed_ports}
    max_requests = authority["max_requests"]
    if not isinstance(max_requests, int) or not 1 <= max_requests <= MAX_PORTS:
        raise CampaignError("max_requests exceeds the campaign boundary")
    if not isinstance(authority["scope_id"], str) or not authority["scope_id"]:
        raise CampaignError("scope_id is required")
    if not isinstance(targets, list) or not targets or len(targets) > MAX_TARGETS:
        raise CampaignError("targets must be a bounded non-empty array")
    normalized: list[dict[str, Any]] = []
    request_count = 0
    for index, item in enumerate(targets):
        if not isinstance(item, dict) or set(item) != {"host", "ports"}:
            raise CampaignError(f"targets[{index}] is malformed")
        host = item["host"]
        if host not in allowed_hosts:
            raise CampaignError(f"target host is outside authority: {host}")
        ports = sorted({_port(port) for port in item["ports"]}) if isinstance(item["ports"], list) else []
        if not ports or not set(ports).issubset(port_set):
            raise CampaignError(f"targets[{index}] contains a port outside authority")
        request_count += len(ports)
        normalized.append({"host": host, "ports": ports})
    if request_count > max_requests:
        raise CampaignError("campaign request count exceeds authority")
    return authority, normalized


def _tool_environment() -> dict[str, str]:
    environment = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
    environment["NO_COLOR"] = "1"
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


def _run(argv: list[str], deadline: float, output_limit: int) -> dict[str, Any]:
    if output_limit <= 0:
        raise CampaignError("campaign output budget is exhausted")
    started = time.monotonic()
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=_tool_environment(), start_new_session=True, shell=False)
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
                failure = CampaignError("network campaign exceeded its global deadline")
                break
            events = selector.select(timeout=min(remaining, 0.2))
            for key, _ in events:
                chunk = os.read(key.fileobj.fileno(), READ_CHUNK_BYTES)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                if len(chunk) > output_limit - len(stdout) - len(stderr):
                    failure = CampaignError("raw command output exceeds the remaining output boundary")
                    break
                key.data.extend(chunk)
            if failure is not None:
                break
        if failure is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                failure = CampaignError("network campaign exceeded its global deadline")
            else:
                try:
                    process.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    failure = CampaignError("network campaign exceeded its global deadline")
    finally:
        selector.close()
        _terminate(process)
        process.stdout.close()
        process.stderr.close()
    if failure is not None:
        raise failure
    return {"argv": argv, "exit_code": process.returncode, "duration_ms": round((time.monotonic() - started) * 1000), "stdout": stdout.decode("utf-8", errors="replace"), "stderr": stderr.decode("utf-8", errors="replace")}


def run_campaign(payload: dict[str, Any], digest: str, *, executable: str = "nmap", deadline_seconds: float = CAMPAIGN_TIMEOUT_SECONDS) -> dict[str, Any]:
    authority, targets = _validated(payload)
    deadline = time.monotonic() + deadline_seconds
    budget = MAX_OUTPUT_BYTES
    version_run = _run([executable, "--version"], deadline, budget)
    budget -= len(version_run["stdout"].encode()) + len(version_run["stderr"].encode())
    version = (version_run["stdout"] or version_run["stderr"]).strip()[:500]
    executions = []
    for target in targets:
        remaining_seconds = max(1, int(deadline - time.monotonic()))
        argv = [executable, "-n", "-Pn", "-sT", "--max-retries", "1", "--host-timeout", f"{remaining_seconds}s", "-p", ",".join(str(port) for port in target["ports"]), "-oX", "-", "--", target["host"]]
        execution = _run(argv, deadline, budget)
        budget -= len(execution["stdout"].encode()) + len(execution["stderr"].encode())
        executions.append(execution)
    return {"format": "cyberful.network-recon-campaign.raw.v1", "input_sha256": digest, "scope_id": authority["scope_id"], "tool": {"name": "nmap", "version": version}, "environment": {"inherited": sorted(_tool_environment()), "proxy_inherited": False, "ca_inherited": False, "telemetry_enabled": False}, "executions": executions}


def _write(path: Path, value: dict[str, Any]) -> None:
    rendered = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    if len(rendered) > MAX_OUTPUT_BYTES:
        raise CampaignError("campaign report exceeds output boundary")
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
            temporary = handle.name
            os.chmod(temporary, 0o600)
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary:
            Path(temporary).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run an authorized bounded Nmap campaign.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        workspace = _workspace(args.workspace)
        source = _confined(workspace, args.input, exists=True)
        destination = _confined(workspace, args.output, exists=False)
        if source == destination or not destination.parent.is_dir():
            raise CampaignError("output must be a distinct path with an existing parent")
        payload, digest = _read_json(source)
        _write(destination, run_campaign(payload, digest))
        return 0
    except (CampaignError, OSError) as error:
        print(f"network campaign error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
