#!/usr/bin/env python3
# ── Bounded Content Discovery Campaign ──────────────────────────
# Runs one bounded ffuf mutation axis and preserves command, version, exit,
# streams, and native JSON as raw campaign evidence.
# → cyberful/builtin/skills/operate-content-discovery/assets/content-discovery-campaign.schema.json — input contract.
# → cyberful/builtin/skills/operate-content-discovery/tests/test_run_content_discovery_campaign.py — behavior and forward tests.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
from functools import partial
import hashlib
import ipaddress
import json
import os
import resource
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Final
from urllib.parse import SplitResult, urlsplit


MAX_CONFIG_BYTES: Final = 256_000
MAX_WORDLIST_BYTES: Final = 2_000_000
MAX_REQUESTS: Final = 10_000
MAX_CONCURRENCY: Final = 50
MAX_RATE: Final = 250
MAX_OUTPUT_BYTES: Final = 16_000_000
MAX_STREAM_BYTES: Final = 1_000_000
TRUSTED_COMMAND: Final = "ffuf"
SCHEMA_REFERENCE: Final = "./content-discovery-campaign.schema.json"
PASSTHROUGH_ENVIRONMENT: Final = ("PATH", "TMPDIR", "SSL_CERT_FILE", "CURL_CA_BUNDLE")
PROXY_ENVIRONMENT: Final = {"http": "HTTP_PROXY", "https": "HTTPS_PROXY"}
NO_TELEMETRY_ENVIRONMENT: Final = {
    "DISABLE_UPDATE_CHECK": "true",
    "DO_NOT_TRACK": "1",
    "NO_COLOR": "1",
}
CONFIG_FIELDS: Final = frozenset({
    "$schema",
    "authorization_reference",
    "allowed_origins",
    "target",
    "wordlist",
    "output_directory",
    "request_limit",
    "rate_per_second",
    "concurrency",
    "timeout_seconds",
})


class CampaignError(ValueError):
    """Raised before or during a campaign that violates its bounded contract."""


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


def _integer(value: Any, label: str, lower: int, upper: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not lower <= value <= upper:
        raise CampaignError(f"{label} must be an integer from {lower} through {upper}")
    return value


def _text(value: Any, label: str, *, maximum: int = 2_048) -> str:
    if not isinstance(value, str) or not value.strip() or any(ord(character) < 32 for character in value):
        raise CampaignError(f"{label} must be a non-empty string without control characters")
    normalized = value.strip()
    if len(normalized) > maximum:
        raise CampaignError(f"{label} exceeds the {maximum}-character limit")
    return normalized


def _port(parsed: SplitResult, label: str) -> int:
    try:
        explicit = parsed.port
    except ValueError as error:
        raise CampaignError(f"{label} contains an invalid port") from error
    if explicit is not None:
        return explicit
    return 443 if parsed.scheme.lower() == "https" else 80


def _origin(value: str, label: str) -> tuple[str, str, int]:
    parsed = urlsplit(_text(value, label))
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise CampaignError(f"{label} must be an HTTP(S) origin without userinfo")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise CampaignError(f"{label} must not contain a path, query, or fragment")
    return scheme, parsed.hostname.lower().rstrip("."), _port(parsed, label)


def _validated(config: dict[str, Any], workspace: Path) -> tuple[str, str, Path, Path, int, int, int]:
    if set(config) != CONFIG_FIELDS:
        raise CampaignError(f"config fields must be exactly {', '.join(sorted(CONFIG_FIELDS))}")
    if config["$schema"] != SCHEMA_REFERENCE:
        raise CampaignError(f"$schema must be {SCHEMA_REFERENCE}")
    authorization_reference = _text(config["authorization_reference"], "authorization_reference", maximum=512)
    raw_origins = config["allowed_origins"]
    if not isinstance(raw_origins, list) or not raw_origins or not all(isinstance(item, str) for item in raw_origins):
        raise CampaignError("allowed_origins must be a non-empty string array")
    allowed_origins = {_origin(item, f"allowed_origins[{index}]") for index, item in enumerate(raw_origins)}
    if len(allowed_origins) != len(raw_origins):
        raise CampaignError("allowed_origins must contain unique effective origins")

    target = _text(config["target"], "target")
    parsed_target = urlsplit(target)
    if not parsed_target.hostname or parsed_target.username or parsed_target.password or "FUZZ" not in target:
        raise CampaignError("target must be an HTTP(S) URL without userinfo and containing FUZZ")
    target_origin = (parsed_target.scheme.lower(), parsed_target.hostname.lower().rstrip("."), _port(parsed_target, "target"))
    if target_origin not in allowed_origins:
        raise CampaignError("target scheme, host, and effective port are outside allowed_origins")

    request_limit = _integer(config["request_limit"], "request_limit", 1, MAX_REQUESTS)
    rate = _integer(config["rate_per_second"], "rate_per_second", 1, MAX_RATE)
    concurrency = _integer(config["concurrency"], "concurrency", 1, MAX_CONCURRENCY)
    timeout = _integer(config["timeout_seconds"], "timeout_seconds", 1, 300)
    if concurrency > request_limit:
        raise CampaignError("concurrency must not exceed request_limit")

    wordlist = _confined(workspace, _text(config["wordlist"], "wordlist"), must_exist=True)
    raw_wordlist = _regular_bytes(wordlist, MAX_WORDLIST_BYTES)
    entries = sum(1 for line in raw_wordlist.splitlines() if line.strip())
    if entries == 0 or entries > request_limit:
        raise CampaignError("wordlist entries must be non-zero and no greater than request_limit")
    output_directory = _confined(workspace, _text(config["output_directory"], "output_directory"), must_exist=False)
    if output_directory.exists():
        raise CampaignError("output_directory must be a new path")
    output_directory.mkdir(mode=0o700, parents=True)
    if output_directory.is_symlink() or not output_directory.is_dir():
        raise CampaignError("output_directory must be a real directory")
    return authorization_reference, target, output_directory, wordlist, rate, concurrency, timeout


def _runtime_route(target: str) -> tuple[str, str] | None:
    parsed_target = urlsplit(target)
    assert parsed_target.hostname is not None
    try:
        if ipaddress.ip_address(parsed_target.hostname).is_loopback:
            return None
    except ValueError:
        pass
    environment_name = PROXY_ENVIRONMENT[parsed_target.scheme.lower()]
    raw_proxy = os.environ.get(environment_name)
    if not raw_proxy:
        raise CampaignError(f"non-loopback target has no mission-bound {environment_name} route")
    _origin(raw_proxy, environment_name)
    return environment_name, _text(raw_proxy, environment_name)


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
    if metadata.st_size >= limit:
        raise CampaignError(f"{path.name} reached the {limit}-byte execution limit")
    return metadata.st_size


def _process_environment(route: tuple[str, str] | None) -> dict[str, str]:
    environment = {name: os.environ[name] for name in PASSTHROUGH_ENVIRONMENT if os.environ.get(name)}
    if route is not None:
        environment[route[0]] = route[1]
    environment.setdefault("PATH", "/usr/bin:/bin")
    environment.update({"LANG": "C", "LC_ALL": "C"})
    environment.update(NO_TELEMETRY_ENVIRONMENT)
    return environment


def _set_child_file_limit(limit: int) -> None:
    resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))


def _run(command: list[str], timeout: int, environment: dict[str, str], *, monitored: tuple[tuple[Path, int], ...] = ()) -> tuple[int, bytes, bytes]:
    file_size_limit = max((limit for _, limit in monitored), default=0)
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            shell=False,
            start_new_session=True,
            preexec_fn=partial(_set_child_file_limit, file_size_limit) if file_size_limit else None,
        )
    except OSError as error:
        raise CampaignError(f"could not start {command[0]}: {error}") from error
    if process.stdout is None or process.stderr is None:
        _terminate(process)
        raise CampaignError("tool streams were not available")

    selector = selectors.DefaultSelector()
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    limits = {"stdout": MAX_STREAM_BYTES, "stderr": MAX_STREAM_BYTES}
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    deadline = time.monotonic() + timeout
    try:
        while process.poll() is None or selector.get_map():
            if time.monotonic() >= deadline:
                raise CampaignError(f"campaign exceeded timeout_seconds={timeout}")
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


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False) as temporary:
            temporary_name = temporary.name
            os.chmod(temporary_name, 0o600)
            json.dump(value, temporary, indent=2, sort_keys=True, ensure_ascii=False)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, path)
        temporary_name = None
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


def _campaign(config: dict[str, Any], workspace: Path, command_name: str) -> dict[str, Any]:
    workspace = workspace.resolve(strict=True)
    authorization_reference, target, output_directory, wordlist, rate, concurrency, timeout = _validated(config, workspace)
    route = _runtime_route(target)
    environment = _process_environment(route)
    native_output = output_directory / "ffuf-results.json"
    command = [
        command_name,
        "-noninteractive",
        "-s",
        "-u",
        target,
        "-w",
        str(wordlist),
        "-rate",
        str(rate),
        "-t",
        str(concurrency),
        "-timeout",
        str(timeout),
        "-of",
        "json",
        "-o",
        str(native_output),
    ]
    if route is not None:
        command.extend(("-x", route[1]))
    try:
        _, version_stdout, version_stderr = _run([command_name, "-V"], min(timeout, 10), environment)
        version = (version_stdout or version_stderr).decode("utf-8", errors="replace").strip()[:500]
    except CampaignError:
        version = "unavailable"
    exit_code, stdout, stderr = _run(command, timeout, environment, monitored=((native_output, MAX_OUTPUT_BYTES),))
    if not native_output.exists() or native_output.is_symlink():
        raise CampaignError("ffuf did not produce ffuf-results.json")
    raw = _regular_bytes(native_output, MAX_OUTPUT_BYTES)
    os.chmod(native_output, 0o600)
    record = {
        "format": "cyberful.content-discovery-campaign.v1",
        "authorization_reference": authorization_reference,
        "command": command,
        "tool_version": version,
        "exit_code": exit_code,
        "wordlist": {"path": str(wordlist.relative_to(workspace)), "sha256": hashlib.sha256(wordlist.read_bytes()).hexdigest()},
        "raw_output": {"path": str(native_output.relative_to(workspace)), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()},
        "stdout": stdout.decode("utf-8", errors="replace"),
        "stderr": stderr.decode("utf-8", errors="replace"),
    }
    _atomic_json(output_directory / "campaign-record.json", record)
    if exit_code != 0:
        raise CampaignError(f"ffuf exited with code {exit_code}; raw evidence was preserved")
    return record


def run_campaign(config: dict[str, Any], workspace: Path) -> dict[str, Any]:
    """Run with the fixed command resolved from the trusted runtime PATH."""

    return _campaign(config, workspace, TRUSTED_COMMAND)


def _run_campaign_for_test(config: dict[str, Any], workspace: Path, command_path: str) -> dict[str, Any]:
    """Inject a synthetic executable only for isolated unit and forward tests."""

    return _campaign(config, workspace, command_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run one mission-routed, bounded ffuf content-discovery campaign.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--config", required=True)
    arguments = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        workspace = _workspace(arguments.workspace)
        report = run_campaign(_load_config(_confined(workspace, arguments.config, must_exist=True)), workspace)
        print(json.dumps(report, sort_keys=True))
    except (CampaignError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
