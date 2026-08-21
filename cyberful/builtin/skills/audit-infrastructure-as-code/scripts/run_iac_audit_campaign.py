#!/usr/bin/env python3
# ── Offline Infrastructure-As-Code Audit Campaign ───────────────
# Runs a fixed Checkov command over a confined local tree and preserves raw,
# bounded, deterministic evidence without inheriting network or secret routes.
# → cyberful/builtin/skills/audit-infrastructure-as-code/scripts/manifest.json — execution contract.
# → cyberful/builtin/skills/audit-infrastructure-as-code/assets/iac-audit-campaign.schema.json — input contract.
# → cyberful/builtin/skills/audit-infrastructure-as-code/tests/test_run_iac_audit_campaign.py — refusal and execution coverage.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
import base64
import ctypes
from dataclasses import dataclass
import errno
import hashlib
import json
import os
import platform
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable, Final


MAX_INPUT_BYTES: Final = 262_144
MAX_EVIDENCE_BYTES: Final = 4_194_304
MAX_STDOUT_BYTES: Final = 1_048_576
MAX_STDERR_BYTES: Final = 65_536
MAX_VERSION_BYTES: Final = 4_096
MAX_FILES: Final = 20_000
MAX_TOTAL_BYTES: Final = 536_870_912
MAX_TIMEOUT_SECONDS: Final = 120
REPORT_RESERVE_SECONDS: Final = 1.0
TRUSTED_COMMAND: Final = "checkov"
CONFIG_FIELDS: Final = frozenset({
    "$schema", "campaign_id", "scope_reference", "source_directory",
    "max_files", "max_total_bytes", "timeout_seconds", "stdout_limit_bytes",
})
PASSTHROUGH_ENVIRONMENT: Final = ("PATH",)
NO_TELEMETRY_ENVIRONMENT: Final = {
    "CHECKOV_SKIP_DOWNLOAD": "1",
    "DISABLE_UPDATE_CHECK": "true",
    "DO_NOT_TRACK": "1",
    "NO_COLOR": "1",
}


class CampaignError(ValueError):
    """Raised when campaign input or execution violates the offline contract."""


@dataclass(frozen=True)
class ProcessResult:
    return_code: int | None
    stdout: bytes
    stderr: bytes
    timed_out: bool
    limit_exceeded: str | None


@dataclass(frozen=True)
class NetworkSandbox:
    argv: list[str]
    mechanism: str
    preexec_fn: Callable[[], None] | None


SandboxFactory = Callable[[list[str]], NetworkSandbox]


def _text(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CampaignError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > maximum or any(ord(character) < 32 for character in normalized):
        raise CampaignError(f"{label} exceeds its text boundary or contains control characters")
    return normalized


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise CampaignError(f"{label} must be an integer between {minimum} and {maximum}")
    return value


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


def _read_input(workspace: Path, value: str) -> tuple[dict[str, Any], bytes, Path]:
    source = _confined(workspace, value, must_exist=True)
    metadata = source.lstat()
    if source.is_symlink() or not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
        raise CampaignError(f"input must be a regular file no larger than {MAX_INPUT_BYTES} bytes")
    raw = source.read_bytes()
    if len(raw) > MAX_INPUT_BYTES:
        raise CampaignError(f"input exceeds the {MAX_INPUT_BYTES}-byte limit")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CampaignError("input must be UTF-8 JSON") from error
    if not isinstance(payload, dict):
        raise CampaignError("input must be a JSON object")
    return payload, raw, source


def _output_path(workspace: Path, value: str) -> Path:
    output = _confined(workspace, value, must_exist=False)
    if output.exists() or output.is_symlink():
        raise CampaignError("output must be a new regular-file path")
    parent = output.parent
    metadata = parent.lstat()
    if parent.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
        raise CampaignError("output parent must be an existing real directory")
    return output


def _validated(payload: dict[str, Any], workspace: Path) -> tuple[str, str, Path, int, int, int, int]:
    if set(payload) != CONFIG_FIELDS:
        raise CampaignError(f"input fields must be exactly {', '.join(sorted(CONFIG_FIELDS))}")
    if payload["$schema"] != "./iac-audit-campaign.schema.json":
        raise CampaignError("$schema must identify the packaged campaign schema")
    campaign_id = _text(payload["campaign_id"], "campaign_id", 256)
    scope_reference = _text(payload["scope_reference"], "scope_reference", 512)
    source_value = _text(payload["source_directory"], "source_directory", 1024)
    source = _confined(workspace, source_value, must_exist=True)
    metadata = source.lstat()
    if source.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
        raise CampaignError("source_directory must be a real directory")
    max_files = _integer(payload["max_files"], "max_files", 1, MAX_FILES)
    max_bytes = _integer(payload["max_total_bytes"], "max_total_bytes", 1, MAX_TOTAL_BYTES)
    timeout = _integer(payload["timeout_seconds"], "timeout_seconds", 1, MAX_TIMEOUT_SECONDS)
    stdout_limit = _integer(payload["stdout_limit_bytes"], "stdout_limit_bytes", 1024, MAX_STDOUT_BYTES)
    return campaign_id, scope_reference, source, max_files, max_bytes, timeout, stdout_limit


def _check_deadline(deadline: float, stage: str) -> None:
    if time.monotonic() >= deadline:
        raise CampaignError(f"campaign deadline expired during {stage}")


def _copy_regular_file(source: Path, destination: Path, expected: os.stat_result, deadline: float) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(source, flags)
    output_descriptor: int | None = None
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino):
            raise CampaignError(f"source changed while opening {source.name}")
        output_descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        digest = hashlib.sha256()
        observed = 0
        while True:
            _check_deadline(deadline, "snapshot copy")
            chunk = os.read(descriptor, 65_536)
            if not chunk:
                break
            observed += len(chunk)
            if observed > expected.st_size:
                raise CampaignError(f"source changed while reading {source.name}")
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(output_descriptor, view)
                view = view[written:]
        final = os.fstat(descriptor)
        if observed != expected.st_size or (final.st_dev, final.st_ino, final.st_size) != (expected.st_dev, expected.st_ino, expected.st_size):
            raise CampaignError(f"source changed while reading {source.name}")
        os.fsync(output_descriptor)
        os.chmod(destination, 0o400)
        return digest.digest()
    finally:
        if output_descriptor is not None:
            os.close(output_descriptor)
        os.close(descriptor)


def _snapshot(workspace: Path, root: Path, destination: Path, max_files: int, max_bytes: int, deadline: float) -> dict[str, Any]:
    destination.mkdir(mode=0o700)
    entries: list[tuple[str, int, bytes]] = []
    total_bytes = 0
    for directory, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
        _check_deadline(deadline, "source inventory")
        directory_names.sort()
        file_names.sort()
        directory_path = Path(directory)
        relative_directory = directory_path.relative_to(root)
        snapshot_directory = destination / relative_directory
        for name in directory_names:
            candidate = directory_path / name
            metadata = candidate.lstat()
            if candidate.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
                raise CampaignError(f"source contains a non-directory or symbolic-link component: {candidate.name}")
            (snapshot_directory / name).mkdir(mode=0o700)
        for name in file_names:
            _check_deadline(deadline, "source inventory")
            candidate = directory_path / name
            metadata = candidate.lstat()
            if candidate.is_symlink() or not stat.S_ISREG(metadata.st_mode):
                raise CampaignError(f"source contains a symbolic link or special file: {candidate.name}")
            if len(entries) >= max_files:
                raise CampaignError("source exceeds max_files before tool execution")
            total_bytes += metadata.st_size
            if total_bytes > max_bytes:
                raise CampaignError("source exceeds max_total_bytes before tool execution")
            relative = candidate.relative_to(root).as_posix()
            entries.append((relative, metadata.st_size, _copy_regular_file(candidate, snapshot_directory / name, metadata, deadline)))
    if not entries:
        raise CampaignError("source_directory must contain at least one regular file")
    digest = hashlib.sha256()
    for relative, size, content_digest in entries:
        encoded = relative.encode("utf-8")
        digest.update(len(encoded).to_bytes(4, "big"))
        digest.update(encoded)
        digest.update(size.to_bytes(8, "big"))
        digest.update(content_digest)
    for snapshot_directory, _, _ in os.walk(destination, topdown=False):
        os.chmod(snapshot_directory, 0o500)
    return {
        "path": root.relative_to(workspace).as_posix(),
        "files": len(entries),
        "bytes": total_bytes,
        "sha256": digest.hexdigest(),
    }


def _unlock_snapshot(root: Path) -> None:
    if not root.exists():
        return
    for directory, _, file_names in os.walk(root, topdown=False):
        directory_path = Path(directory)
        for name in file_names:
            try:
                os.chmod(directory_path / name, 0o600)
            except FileNotFoundError:
                pass
        os.chmod(directory_path, 0o700)


def _process_environment(home: Path) -> dict[str, str]:
    environment = {name: os.environ[name] for name in PASSTHROUGH_ENVIRONMENT if os.environ.get(name)}
    environment.setdefault("PATH", "/usr/bin:/bin")
    environment.update({"HOME": str(home), "TMPDIR": str(home), "LANG": "C", "LC_ALL": "C"})
    environment.update(NO_TELEMETRY_ENVIRONMENT)
    return environment


class _SockFilter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]


class _SockFprog(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ushort), ("filter", ctypes.POINTER(_SockFilter))]


def _install_linux_network_filter() -> None:
    architectures = {
        "x86_64": (0xC000003E, (41, 42, 43, 44, 45, 46, 47, 49, 50, 51, 52, 53, 54, 55, 288, 299, 307)),
        "aarch64": (0xC00000B7, (198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 242, 243, 269)),
        "arm64": (0xC00000B7, (198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 242, 243, 269)),
    }
    selected = architectures.get(platform.machine().lower())
    if selected is None:
        raise OSError(errno.ENOTSUP, "network-none sandbox is unsupported on this Linux architecture")
    audit_arch, blocked_calls = selected
    instructions = [
        _SockFilter(0x20, 0, 0, 4),
        _SockFilter(0x15, 1, 0, audit_arch),
        _SockFilter(0x06, 0, 0, 0x80000000),
        _SockFilter(0x20, 0, 0, 0),
    ]
    for syscall_number in blocked_calls:
        instructions.extend((_SockFilter(0x15, 0, 1, syscall_number), _SockFilter(0x06, 0, 0, 0x00050000 | errno.EACCES)))
    instructions.append(_SockFilter(0x06, 0, 0, 0x7FFF0000))
    filters = (_SockFilter * len(instructions))(*instructions)
    program = _SockFprog(len(instructions), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    program_pointer = ctypes.cast(ctypes.byref(program), ctypes.c_void_p)
    if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.prctl(22, 2, program_pointer) != 0:
        failure = ctypes.get_errno() or errno.EPERM
        raise OSError(failure, "could not install the network-none seccomp filter")


def _install_macos_network_filter() -> None:
    sandbox = ctypes.CDLL(None, use_errno=True)
    sandbox.sandbox_init.restype = ctypes.c_int
    sandbox.sandbox_init.argtypes = (ctypes.c_char_p, ctypes.c_uint64, ctypes.POINTER(ctypes.c_char_p))
    error_buffer = ctypes.c_char_p()
    profile = b"(version 1)(allow default)(deny network*)"
    if sandbox.sandbox_init(profile, 0, ctypes.byref(error_buffer)) != 0:
        message = error_buffer.value.decode("utf-8", errors="replace") if error_buffer.value else "sandbox_init failed"
        if error_buffer.value and hasattr(sandbox, "sandbox_free_error"):
            sandbox.sandbox_free_error(error_buffer)
        raise OSError(errno.EPERM, message)


def _network_sandbox(argv: list[str]) -> NetworkSandbox:
    if sys.platform == "darwin":
        return NetworkSandbox(argv, "sandbox-init-deny-network", _install_macos_network_filter)
    if sys.platform.startswith("linux"):
        return NetworkSandbox(argv, "seccomp-bpf-deny-network", _install_linux_network_filter)
    raise CampaignError("network-none sandbox is unsupported on this platform")


def _signal_group(process_group: int, signal_number: int) -> None:
    try:
        os.killpg(process_group, signal_number)
    except ProcessLookupError:
        return
    except OSError as error:
        if error.errno not in {errno.ESRCH, errno.EPERM}:
            raise


def _terminate_group(process: subprocess.Popen[bytes]) -> None:
    _signal_group(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        pass
    _signal_group(process.pid, signal.SIGKILL)
    try:
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired as error:
        raise CampaignError("tool process group could not be reaped") from error


def _read_stream(descriptor: int) -> bytes:
    return os.read(descriptor, 65_536)


def _run_process(
    argv: list[str],
    *,
    deadline: float,
    stdout_limit: int,
    stderr_limit: int,
    environment: dict[str, str],
    cwd: Path,
    sandbox_factory: SandboxFactory = _network_sandbox,
) -> ProcessResult:
    if time.monotonic() >= deadline:
        return ProcessResult(None, b"", b"", True, None)
    sandbox = sandbox_factory(argv)
    try:
        process = subprocess.Popen(
            sandbox.argv,
            cwd=cwd,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            start_new_session=True,
            preexec_fn=sandbox.preexec_fn,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise CampaignError(f"could not start {Path(argv[0]).name}: {error}") from error
    if process.stdout is None or process.stderr is None:
        _terminate_group(process)
        raise CampaignError("tool streams were unavailable")

    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    limits = {"stdout": stdout_limit, "stderr": stderr_limit}
    timed_out = False
    exceeded: str | None = None
    termination_error: BaseException | None = None
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                timed_out = True
                break
            ready = selector.select(timeout=min(0.05, max(0.0, deadline - time.monotonic())))
            for key, _ in ready:
                label = key.data
                chunk = _read_stream(key.fileobj.fileno())
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                remaining = limits[label] - len(buffers[label])
                buffers[label].extend(chunk[:remaining])
                if len(chunk) > remaining:
                    exceeded = label
                    break
            if exceeded is not None:
                break
    finally:
        try:
            _terminate_group(process)
        except BaseException as error:
            termination_error = error
        finally:
            selector.close()
            process.stdout.close()
            process.stderr.close()
        if termination_error is not None:
            raise termination_error
    return ProcessResult(process.returncode, bytes(buffers["stdout"]), bytes(buffers["stderr"]), timed_out, exceeded)


def _stream(raw: bytes) -> dict[str, Any]:
    return {"base64": base64.b64encode(raw).decode("ascii"), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def _atomic_json(path: Path, value: dict[str, Any], deadline: float) -> None:
    _check_deadline(deadline, "evidence serialization")
    raw = f"{json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False)}\n".encode("utf-8")
    _check_deadline(deadline, "evidence serialization")
    if len(raw) > MAX_EVIDENCE_BYTES:
        raise CampaignError(f"evidence exceeds the {MAX_EVIDENCE_BYTES}-byte package limit")
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=f".{path.name}.", delete=False) as temporary:
            temporary_name = temporary.name
            os.chmod(temporary_name, 0o600)
            temporary.write(raw)
            temporary.flush()
            os.fsync(temporary.fileno())
        _check_deadline(deadline, "evidence publication")
        os.replace(temporary_name, path)
        temporary_name = None
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


def _campaign(
    payload: dict[str, Any],
    raw_input: bytes,
    workspace: Path,
    output: Path,
    command: str,
    sandbox_factory: SandboxFactory = _network_sandbox,
) -> dict[str, Any]:
    campaign_id, scope_reference, source, max_files, max_bytes, timeout, stdout_limit = _validated(payload, workspace)
    started = time.monotonic()
    deadline = started + timeout
    execution_deadline = max(started, deadline - REPORT_RESERVE_SECONDS)
    try:
        output.relative_to(source)
    except ValueError:
        pass
    else:
        raise CampaignError("output must not be inside source_directory")
    recorded_command = [
        TRUSTED_COMMAND, "--directory", "<snapshot>/source", "--output", "json", "--quiet",
        "--compact", "--download-external-modules", "false",
    ]
    sandbox_mechanism = sandbox_factory([command, "--version"]).mechanism
    with tempfile.TemporaryDirectory(prefix="cyberful-iac-") as campaign_directory:
        campaign_root = Path(campaign_directory)
        home = campaign_root / "home"
        home.mkdir(mode=0o700)
        snapshot = campaign_root / "snapshot" / "source"
        try:
            snapshot.parent.mkdir(mode=0o700)
            source_inventory = _snapshot(workspace, source, snapshot, max_files, max_bytes, execution_deadline)
            environment = _process_environment(home)
            version_result = _run_process([command, "--version"], deadline=execution_deadline, stdout_limit=MAX_VERSION_BYTES, stderr_limit=MAX_VERSION_BYTES, environment=environment, cwd=campaign_root, sandbox_factory=sandbox_factory)
            if version_result.return_code != 0 or version_result.timed_out or version_result.limit_exceeded is not None:
                raise CampaignError("tool version probe did not complete inside the network-none sandbox")
            executed_command = [command, "--directory", str(snapshot), "--output", "json", "--quiet", "--compact", "--download-external-modules", "false"]
            result = _run_process(executed_command, deadline=execution_deadline, stdout_limit=stdout_limit, stderr_limit=MAX_STDERR_BYTES, environment=environment, cwd=campaign_root, sandbox_factory=sandbox_factory)
        finally:
            _unlock_snapshot(snapshot)
    evidence = {
        "format": "cyberful.iac-audit-evidence.v1",
        "campaign_id": campaign_id,
        "scope_reference": scope_reference,
        "input_sha256": hashlib.sha256(raw_input).hexdigest(),
        "source": source_inventory,
        "network_sandbox": {"network": "none", "mechanism": sandbox_mechanism},
        "tool": {
            "name": TRUSTED_COMMAND,
            "version_probe": {
                "argv": [TRUSTED_COMMAND, "--version"],
                "exit_code": version_result.return_code,
                "timed_out": version_result.timed_out,
                "limit_exceeded": version_result.limit_exceeded,
                "stdout": _stream(version_result.stdout),
                "stderr": _stream(version_result.stderr),
            },
        },
        "command": recorded_command,
        "result": {
            "exit_code": result.return_code,
            "timed_out": result.timed_out,
            "limit_exceeded": result.limit_exceeded,
            "stdout": _stream(result.stdout),
            "stderr": _stream(result.stderr),
        },
        "limits": {"timeout_seconds": timeout, "stdout_bytes": stdout_limit, "stderr_bytes": MAX_STDERR_BYTES},
        "interpretation": "Raw tool output is evidence to review; a nonzero exit or policy result is not independently a verified vulnerability.",
    }
    _atomic_json(output, evidence, deadline)
    return evidence


def _run_campaign_for_test(
    payload: dict[str, Any],
    raw_input: bytes,
    workspace: Path,
    output: Path,
    command: str,
    sandbox_factory: SandboxFactory | None = None,
) -> dict[str, Any]:
    """Inject a fixture executable without making command selection model-controlled."""
    fixture_sandbox = sandbox_factory or (lambda argv: NetworkSandbox(argv, "test-fixture-no-network-route", None))
    return _campaign(payload, raw_input, workspace.resolve(strict=True), output, command, fixture_sandbox)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a bounded offline infrastructure-as-code audit")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(argv)
    try:
        workspace = _workspace(arguments.workspace)
        payload, raw_input, input_path = _read_input(workspace, arguments.input)
        output = _output_path(workspace, arguments.output)
        if output == input_path:
            raise CampaignError("output must differ from input")
        _campaign(payload, raw_input, workspace, output, TRUSTED_COMMAND)
    except (CampaignError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(output.relative_to(workspace).as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
