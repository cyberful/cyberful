#!/usr/bin/env python3
# ── Authorized Supply-Chain Tool Campaign ───────────────────────
# Runs a bounded, update-disabled set of artifact scanners and preserves each
# native JSON stream plus command, version, exit code, and digest evidence.
# → cyberful/builtin/skills/operate-supply-chain-toolchain/assets/supply-chain-campaign.schema.json — input contract.
# → cyberful/builtin/skills/operate-supply-chain-toolchain/tests/test_run_supply_chain_campaign.py — behavior and forward tests.
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
from typing import Any, Final, Mapping


MAX_CONFIG_BYTES: Final = 256_000
MAX_OUTPUT_BYTES: Final = 64_000_000
MAX_STREAM_BYTES: Final = 2_000_000
TOOLS: Final = ("syft", "grype", "trivy", "gitleaks")
TRUSTED_COMMANDS: Final = {tool: tool for tool in TOOLS}
CONFIG_FIELDS: Final = frozenset({"authorized", "artifact", "output_directory", "tools", "max_tool_runs", "timeout_seconds"})
PASSTHROUGH_ENVIRONMENT: Final = ("PATH", "TMPDIR")
NO_TELEMETRY_ENVIRONMENT: Final = {
    "DISABLE_UPDATE_CHECK": "true",
    "DO_NOT_TRACK": "1",
    "GRYPE_CHECK_FOR_APP_UPDATE": "false",
    "GRYPE_DB_AUTO_UPDATE": "false",
    "NO_COLOR": "1",
    "SYFT_CHECK_FOR_APP_UPDATE": "false",
    "TRIVY_SKIP_DB_UPDATE": "true",
}


class CampaignError(ValueError):
    """Raised before or during an invalid bounded supply-chain campaign."""


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise CampaignError("workspace must be an existing directory")
    return workspace


def _confined(workspace: Path, value: str, *, must_exist: bool) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise CampaignError("paths must be non-traversing and relative to the workspace")
    cursor = workspace
    for component in requested.parts:
        cursor /= component
        if cursor.is_symlink():
            raise CampaignError(f"path component is a symbolic link: {component}")
    resolved = (workspace / requested).resolve(strict=must_exist)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise CampaignError("path escapes the workspace") from error
    return resolved


def _regular_bytes(path: Path, limit: int) -> bytes:
    metadata = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
        raise CampaignError(f"{path.name} must be a regular file no larger than {limit} bytes")
    raw = path.read_bytes()
    if len(raw) > limit:
        raise CampaignError(f"{path.name} exceeds the {limit}-byte limit")
    return raw


def _load_config(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(_regular_bytes(path, MAX_CONFIG_BYTES).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CampaignError("config must be UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise CampaignError("config must be a JSON object")
    if set(value) != CONFIG_FIELDS:
        raise CampaignError(f"config fields must be exactly {', '.join(sorted(CONFIG_FIELDS))}")
    return value


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or any(ord(character) < 32 for character in value):
        raise CampaignError(f"{label} must be a non-empty string without control characters")
    return value.strip()


def _integer(value: Any, label: str, lower: int, upper: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not lower <= value <= upper:
        raise CampaignError(f"{label} must be an integer from {lower} through {upper}")
    return value


def _validated(config: dict[str, Any], workspace: Path) -> tuple[Path, Path, list[str], int]:
    if set(config) != CONFIG_FIELDS:
        raise CampaignError(f"config fields must be exactly {', '.join(sorted(CONFIG_FIELDS))}")
    if config["authorized"] is not True:
        raise CampaignError("campaign requires explicit authorized=true")
    artifact = _confined(workspace, _text(config["artifact"], "artifact"), must_exist=True)
    if artifact.is_symlink() or (not artifact.is_file() and not artifact.is_dir()):
        raise CampaignError("artifact must be a regular file or directory")
    output_directory = _confined(workspace, _text(config["output_directory"], "output_directory"), must_exist=False)
    if output_directory.exists():
        raise CampaignError("output_directory must be a new path")
    output_directory.mkdir(mode=0o700, parents=True)
    if output_directory.is_symlink() or not output_directory.is_dir():
        raise CampaignError("output_directory must be a real directory")
    raw_tools = config["tools"]
    if not isinstance(raw_tools, list) or not raw_tools or not all(isinstance(item, str) for item in raw_tools):
        raise CampaignError("tools must be a non-empty string array")
    tools = list(dict.fromkeys(raw_tools))
    if len(tools) != len(raw_tools) or any(tool not in TOOLS for tool in tools):
        raise CampaignError(f"tools must contain unique members of {', '.join(TOOLS)}")
    max_tool_runs = _integer(config["max_tool_runs"], "max_tool_runs", 1, len(TOOLS))
    if len(tools) > max_tool_runs:
        raise CampaignError("selected tools exceed max_tool_runs")
    timeout = _integer(config["timeout_seconds"], "timeout_seconds", 1, 900)
    return artifact, output_directory, tools, timeout


def _command(tool: str, binary: str, artifact: Path, output: Path) -> list[str]:
    if tool == "syft":
        return [binary, "scan", str(artifact), "-o", "json"]
    if tool == "grype":
        return [binary, str(artifact), "-o", "json"]
    if tool == "trivy":
        return [binary, "filesystem", "--skip-db-update", "--skip-java-db-update", "--format", "json", str(artifact)]
    return [binary, "detect", "--no-banner", "--no-color", "--source", str(artifact), "--report-format", "json", "--report-path", str(output)]


def _terminate(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def _monitored_size(path: Path, limit: int) -> int:
    if not path.exists() and not path.is_symlink():
        return 0
    metadata = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise CampaignError(f"{path.name} must remain a regular non-symlink output")
    if metadata.st_size > limit:
        raise CampaignError(f"{path.name} exceeded the {limit}-byte execution limit")
    return metadata.st_size


def _process_environment() -> dict[str, str]:
    environment = {name: os.environ[name] for name in PASSTHROUGH_ENVIRONMENT if os.environ.get(name)}
    environment.setdefault("PATH", "/usr/bin:/bin")
    environment.update({"LANG": "C", "LC_ALL": "C"})
    environment.update(NO_TELEMETRY_ENVIRONMENT)
    return environment


def _run(
    command: list[str],
    timeout: int,
    *,
    stdout_limit: int,
    stderr_limit: int = MAX_STREAM_BYTES,
    monitored: tuple[tuple[Path, int], ...] = (),
) -> tuple[int, bytes, bytes]:
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=_process_environment(), shell=False, start_new_session=True)
    except OSError as error:
        raise CampaignError(f"could not start {command[0]}: {error}") from error
    if process.stdout is None or process.stderr is None:
        _terminate(process)
        raise CampaignError("tool streams were not available")

    selector = selectors.DefaultSelector()
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    limits = {"stdout": stdout_limit, "stderr": stderr_limit}
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    deadline = time.monotonic() + timeout
    try:
        while process.poll() is None or selector.get_map():
            if time.monotonic() >= deadline:
                raise CampaignError(f"tool exceeded timeout_seconds={timeout}")
            for path, limit in monitored:
                _monitored_size(path, limit)
            for key, _ in selector.select(timeout=0.05):
                label = key.data
                chunk = os.read(key.fileobj.fileno(), 65_536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                buffers[label].extend(chunk)
                if len(buffers[label]) > limits[label]:
                    raise CampaignError(f"tool {label} exceeded the {limits[label]}-byte execution limit")
        process.wait()
    except BaseException:
        _terminate(process)
        for path, limit in monitored:
            if path.exists() and not path.is_symlink() and path.stat().st_size > limit:
                path.unlink()
        raise
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()
    return process.returncode, bytes(buffers["stdout"]), bytes(buffers["stderr"])


def _atomic_bytes(path: Path, raw: bytes) -> None:
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=f".{path.name}.", delete=False) as temporary:
            temporary_name = temporary.name
            os.chmod(temporary_name, 0o600)
            temporary.write(raw)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, path)
        temporary_name = None
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    _atomic_bytes(path, f"{json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False)}\n".encode())


def _campaign(config: dict[str, Any], workspace: Path, commands: Mapping[str, str]) -> dict[str, Any]:
    workspace = workspace.resolve(strict=True)
    artifact, output_directory, tools, timeout = _validated(config, workspace)
    evidence: list[dict[str, Any]] = []
    total_output_bytes = 0
    for tool in tools:
        output = output_directory / f"{tool}.json"
        remaining = MAX_OUTPUT_BYTES - total_output_bytes
        command = _command(tool, commands[tool], artifact, output)
        try:
            _, version_stdout, version_stderr = _run([commands[tool], "--version"], min(timeout, 10), stdout_limit=MAX_STREAM_BYTES)
            version = (version_stdout or version_stderr).decode("utf-8", errors="replace").strip()[:500]
        except CampaignError:
            version = "unavailable"
        monitored = ((output, remaining),) if tool == "gitleaks" else ()
        exit_code, stdout, stderr = _run(command, timeout, stdout_limit=remaining, monitored=monitored)
        if tool != "gitleaks":
            _atomic_bytes(output, stdout)
        if not output.exists() or output.is_symlink():
            raise CampaignError(f"{tool} did not produce native JSON evidence")
        raw = _regular_bytes(output, remaining)
        total_output_bytes += len(raw)
        os.chmod(output, 0o600)
        evidence.append({
            "tool": tool,
            "version": version,
            "command": command,
            "exit_code": exit_code,
            "raw_output": {"path": str(output.relative_to(workspace)), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()},
            "stdout": stdout.decode("utf-8", errors="replace")[:MAX_STREAM_BYTES],
            "stderr": stderr.decode("utf-8", errors="replace"),
        })
    record = {"format": "cyberful.supply-chain-campaign.v1", "artifact": str(artifact.relative_to(workspace)), "runs": evidence}
    _atomic_json(output_directory / "campaign-record.json", record)
    failures = [item for item in evidence if item["exit_code"] != 0 and not (item["tool"] == "gitleaks" and item["exit_code"] == 1)]
    if failures:
        raise CampaignError("one or more tools failed; raw evidence was preserved")
    return record


def run_campaign(config: dict[str, Any], workspace: Path) -> dict[str, Any]:
    """Run commands with fixed names resolved from the trusted runtime PATH."""

    return _campaign(config, workspace, TRUSTED_COMMANDS)


def _run_campaign_for_test(config: dict[str, Any], workspace: Path, commands: Mapping[str, str]) -> dict[str, Any]:
    """Inject synthetic executables only for isolated unit tests."""

    if set(commands) != set(config.get("tools", [])):
        raise CampaignError("test command injection must exactly match selected tools")
    return _campaign(config, workspace, commands)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run an authorized, bounded supply-chain artifact campaign.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--config", required=True)
    arguments = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        workspace = _workspace(arguments.workspace)
        record = run_campaign(_load_config(_confined(workspace, arguments.config, must_exist=True)), workspace)
        print(json.dumps(record, sort_keys=True))
    except (CampaignError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
