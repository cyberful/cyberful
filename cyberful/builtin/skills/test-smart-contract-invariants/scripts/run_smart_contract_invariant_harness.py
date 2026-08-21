#!/usr/bin/env python3
# ── Offline Smart-Contract Invariant Harness ───────────────────
# Snapshots a bounded local Foundry project, runs one fixed offline test
#   campaign under an OS network-denial sandbox, and publishes raw evidence.
# → cyberful/builtin/skills/test-smart-contract-invariants/scripts/manifest.json — execution contract.
# → cyberful/builtin/skills/test-smart-contract-invariants/assets/smart-contract-invariant-campaign.schema.json — input contract.
# → cyberful/builtin/skills/test-smart-contract-invariants/tests/test_run_smart_contract_invariant_harness.py — behavioral tests.
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
import re
import selectors
import secrets
import signal
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable, Final


TRUSTED_COMMAND: Final = "forge"
MAX_INPUT_BYTES: Final = 262_144
MAX_EVIDENCE_BYTES: Final = 4_194_304
MAX_STDOUT_BYTES: Final = 1_048_576
MAX_STDERR_BYTES: Final = 65_536
MAX_VERSION_BYTES: Final = 4_096
MAX_FILES: Final = 20_000
MAX_TOTAL_BYTES: Final = 536_870_912
MAX_TIMEOUT_SECONDS: Final = 180
REPORT_RESERVE_SECONDS: Final = 1.0
TEST_PATTERN: Final = re.compile(r"^[A-Za-z0-9_.*+?^$()|\[\]{}\\-]+$")
FUZZ_SEED: Final = re.compile(r"^0x[0-9a-fA-F]{64}$")
CONFIG_FIELDS: Final = frozenset({
    "$schema", "campaign_id", "scope_reference", "source_directory",
    "test_pattern", "fuzz_seed", "max_files", "max_total_bytes",
    "timeout_seconds", "stdout_limit_bytes",
})
PASSTHROUGH_ENVIRONMENT: Final = ("PATH",)
RUNTIME_CACHE_ENVIRONMENT: Final = ("SVM_HOME", "FOUNDRY_DIR", "XDG_CACHE_HOME")
FIXED_ENVIRONMENT: Final = {
    "FOUNDRY_DISABLE_NIGHTLY_WARNING": "1",
    "FOUNDRY_FFI": "false",
    "FOUNDRY_OFFLINE": "true",
    "NO_COLOR": "1",
}


class HarnessError(ValueError):
    """Raised when local input or execution violates the harness contract."""


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


@dataclass(frozen=True)
class DirectoryHandle:
    path: Path
    relative: Path
    descriptor: int


@dataclass(frozen=True)
class OutputTarget:
    path: Path
    relative: Path
    name: str
    parent_descriptor: int


SandboxFactory = Callable[[list[str]], NetworkSandbox]


# ── Local Attribution Never Grants Execution Authority ─────────
# The campaign file identifies a local source tree and records a mission
# reference for later evidence attribution. Neither value grants authority:
# the host must already have staged the project inside the engagement workarea.
# Paths remain confined below that workspace, self-asserted authority fields are
# rejected, and no payload value can select a binary, network route, or secret.
# ─────────────────────────────────────────────────────────────────


def _text(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise HarnessError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized.encode("utf-8")) > maximum or any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise HarnessError(f"{label} exceeds its boundary or contains control characters")
    return normalized


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise HarnessError(f"{label} must be an integer between {minimum} and {maximum}")
    return value


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise HarnessError("workspace must be an existing directory")
    return workspace


def _confined(workspace: Path, value: str, *, must_exist: bool) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise HarnessError("paths must be relative and non-traversing")
    cursor = workspace
    for component in requested.parts:
        cursor /= component
        if cursor.is_symlink():
            raise HarnessError(f"path component is a symbolic link: {component}")
    resolved = (workspace / requested).resolve(strict=must_exist)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise HarnessError("path escapes workspace") from error
    return resolved


def _read_input(workspace: Path, value: str) -> tuple[dict[str, Any], bytes, Path]:
    source = _confined(workspace, value, must_exist=True)
    metadata = source.lstat()
    if source.is_symlink() or not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
        raise HarnessError("input must be a bounded regular file")
    raw = source.read_bytes()
    if len(raw) > MAX_INPUT_BYTES:
        raise HarnessError("input exceeds its byte boundary")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HarnessError("input must be UTF-8 JSON") from error
    if not isinstance(payload, dict):
        raise HarnessError("input must be a JSON object")
    return payload, raw, source


def _relative_path(value: str, label: str) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise HarnessError(f"{label} must be relative and non-traversing")
    return requested


def _same_inode(first: os.stat_result, second: os.stat_result) -> bool:
    return (first.st_dev, first.st_ino, stat.S_IFMT(first.st_mode)) == (second.st_dev, second.st_ino, stat.S_IFMT(second.st_mode))


def _stable_file_identity(metadata: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (metadata.st_dev, metadata.st_ino, stat.S_IFMT(metadata.st_mode), metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns)


def _open_root_directory(path: Path) -> int:
    expected = path.lstat()
    if path.is_symlink() or not stat.S_ISDIR(expected.st_mode):
        raise HarnessError("workspace must be an existing real directory")
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
    opened = os.fstat(descriptor)
    if not stat.S_ISDIR(opened.st_mode) or not _same_inode(expected, opened):
        os.close(descriptor)
        raise HarnessError("workspace changed while opening")
    return descriptor


def _open_child_directory(parent_descriptor: int, name: str, expected: os.stat_result | None = None) -> int:
    observed = expected or os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    if not stat.S_ISDIR(observed.st_mode):
        raise HarnessError(f"source contains a symbolic link or special directory: {name}")
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_descriptor)
    except OSError as error:
        raise HarnessError(f"directory changed while opening {name}") from error
    opened = os.fstat(descriptor)
    if not stat.S_ISDIR(opened.st_mode) or not _same_inode(observed, opened):
        os.close(descriptor)
        raise HarnessError(f"directory changed while opening {name}")
    return descriptor


def _open_directory(workspace: Path, relative: Path) -> DirectoryHandle:
    descriptor = _open_root_directory(workspace)
    try:
        for component in relative.parts:
            next_descriptor = _open_child_directory(descriptor, component)
            os.close(descriptor)
            descriptor = next_descriptor
        return DirectoryHandle(workspace / relative, relative, descriptor)
    except BaseException:
        os.close(descriptor)
        raise


def _open_output_target(workspace: Path, value: str) -> OutputTarget:
    relative = _relative_path(value, "output")
    if not relative.parts or relative.name in {"", "."}:
        raise HarnessError("output must name a new regular file")
    parent_relative = relative.parent if relative.parent != Path(".") else Path()
    parent = _open_directory(workspace, parent_relative)
    try:
        try:
            os.stat(relative.name, dir_fd=parent.descriptor, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise HarnessError("output must be a new path")
        return OutputTarget(workspace / relative, relative, relative.name, parent.descriptor)
    except BaseException:
        os.close(parent.descriptor)
        raise


def _validated(payload: dict[str, Any]) -> tuple[str, str, Path, str, str, int, int, int, int]:
    if set(payload) != CONFIG_FIELDS:
        raise HarnessError(f"input fields must be exactly {', '.join(sorted(CONFIG_FIELDS))}")
    if payload["$schema"] != "assets/smart-contract-invariant-campaign.schema.json":
        raise HarnessError("$schema must identify the packaged campaign schema")
    campaign_id = _text(payload["campaign_id"], "campaign_id", 256)
    scope_reference = _text(payload["scope_reference"], "scope_reference", 512)
    source = _relative_path(_text(payload["source_directory"], "source_directory", 1024), "source_directory")
    test_pattern = _text(payload["test_pattern"], "test_pattern", 256)
    if not TEST_PATTERN.fullmatch(test_pattern):
        raise HarnessError("test_pattern contains unsupported regex characters")
    fuzz_seed = _text(payload["fuzz_seed"], "fuzz_seed", 66)
    if not FUZZ_SEED.fullmatch(fuzz_seed):
        raise HarnessError("fuzz_seed must be a 32-byte hexadecimal value")
    max_files = _integer(payload["max_files"], "max_files", 1, MAX_FILES)
    max_bytes = _integer(payload["max_total_bytes"], "max_total_bytes", 1, MAX_TOTAL_BYTES)
    timeout = _integer(payload["timeout_seconds"], "timeout_seconds", 1, MAX_TIMEOUT_SECONDS)
    stdout_limit = _integer(payload["stdout_limit_bytes"], "stdout_limit_bytes", 1024, MAX_STDOUT_BYTES)
    return campaign_id, scope_reference, source, test_pattern, fuzz_seed.lower(), max_files, max_bytes, timeout, stdout_limit


def _check_deadline(deadline: float, stage: str) -> None:
    if time.monotonic() >= deadline:
        raise HarnessError(f"harness deadline expired during {stage}")


# ── The Tool Reads A Stable, Immutable Source Snapshot ─────────
# Every directory and file is traversed relative to a stable descriptor with
# O_NOFOLLOW. Device and inode identity must still match the inventory record,
# preventing root, directory, and file swaps from changing the copied bytes. The
# tool receives only the read-only copy; build output is private to this run.
# ─────────────────────────────────────────────────────────────────


def _copy_regular_at(parent_descriptor: int, name: str, destination: Path, expected: os.stat_result, deadline: float) -> bytes:
    try:
        descriptor = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_descriptor)
    except OSError as error:
        raise HarnessError(f"source changed while opening {name}") from error
    output_descriptor: int | None = None
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or _stable_file_identity(opened) != _stable_file_identity(expected):
            raise HarnessError(f"source changed while opening {name}")
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
                raise HarnessError(f"source changed while reading {name}")
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(output_descriptor, view)
                view = view[written:]
        final = os.fstat(descriptor)
        if observed != expected.st_size or _stable_file_identity(final) != _stable_file_identity(expected):
            raise HarnessError(f"source changed while reading {name}")
        os.fsync(output_descriptor)
        os.fchmod(output_descriptor, 0o400)
        return digest.digest()
    finally:
        if output_descriptor is not None:
            os.close(output_descriptor)
        os.close(descriptor)


def _snapshot_directory(source_descriptor: int, destination: Path, prefix: tuple[str, ...], entries: list[tuple[str, int, bytes]], totals: dict[str, int], max_files: int, max_bytes: int, deadline: float) -> None:
    _check_deadline(deadline, "source inventory")
    starting_metadata = os.fstat(source_descriptor)
    try:
        names = sorted(os.listdir(source_descriptor))
    except OSError as error:
        raise HarnessError("source directory changed during inventory") from error
    for name in names:
        _check_deadline(deadline, "source inventory")
        try:
            metadata = os.stat(name, dir_fd=source_descriptor, follow_symlinks=False)
        except OSError as error:
            raise HarnessError(f"source changed during inventory: {name}") from error
        relative_parts = (*prefix, name)
        relative = Path(*relative_parts).as_posix()
        if stat.S_ISDIR(metadata.st_mode):
            child_descriptor = _open_child_directory(source_descriptor, name, metadata)
            child_destination = destination / name
            child_destination.mkdir(mode=0o700)
            try:
                _snapshot_directory(child_descriptor, child_destination, relative_parts, entries, totals, max_files, max_bytes, deadline)
            finally:
                os.close(child_descriptor)
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise HarnessError(f"source contains a symbolic link or special file: {name}")
        if totals["files"] >= max_files:
            raise HarnessError("source exceeds max_files before execution")
        totals["bytes"] += metadata.st_size
        if totals["bytes"] > max_bytes:
            raise HarnessError("source exceeds max_total_bytes before execution")
        content_digest = _copy_regular_at(source_descriptor, name, destination / name, metadata, deadline)
        totals["files"] += 1
        entries.append((relative, metadata.st_size, content_digest))
    ending_metadata = os.fstat(source_descriptor)
    if not _same_inode(starting_metadata, ending_metadata) or (starting_metadata.st_mtime_ns, starting_metadata.st_ctime_ns) != (ending_metadata.st_mtime_ns, ending_metadata.st_ctime_ns):
        raise HarnessError("source directory changed during snapshot")


def _snapshot(source: DirectoryHandle, destination: Path, max_files: int, max_bytes: int, deadline: float) -> dict[str, Any]:
    destination.mkdir(mode=0o700)
    entries: list[tuple[str, int, bytes]] = []
    totals = {"files": 0, "bytes": 0}
    _snapshot_directory(source.descriptor, destination, (), entries, totals, max_files, max_bytes, deadline)
    if not entries:
        raise HarnessError("source_directory must contain at least one regular file")
    digest = hashlib.sha256()
    for relative, size, content_digest in entries:
        encoded = relative.encode("utf-8")
        digest.update(len(encoded).to_bytes(4, "big"))
        digest.update(encoded)
        digest.update(size.to_bytes(8, "big"))
        digest.update(content_digest)
    for snapshot_directory, _, _ in os.walk(destination, topdown=False):
        os.chmod(snapshot_directory, 0o500)
    return {"path": source.relative.as_posix(), "files": totals["files"], "bytes": totals["bytes"], "sha256": digest.hexdigest()}


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


def _validated_runtime_cache_environment() -> dict[str, str]:
    preserved: dict[str, str] = {}
    for name in RUNTIME_CACHE_ENVIRONMENT:
        raw = os.environ.get(name)
        if raw is None:
            continue
        if not raw or len(raw.encode("utf-8")) > 4096 or any(ord(character) < 32 or ord(character) == 127 for character in raw):
            raise HarnessError(f"runtime-owned {name} is malformed")
        requested = Path(raw)
        if not requested.is_absolute():
            raise HarnessError(f"runtime-owned {name} must be an absolute directory")
        try:
            requested_metadata = requested.lstat()
            if requested.is_symlink():
                raise HarnessError(f"runtime-owned {name} must not itself be a symbolic link")
            path = requested.resolve(strict=True)
            if not stat.S_ISDIR(requested_metadata.st_mode) or not path.is_dir():
                raise HarnessError(f"runtime-owned {name} must identify a directory")
        except FileNotFoundError as error:
            raise HarnessError(f"runtime-owned {name} does not exist") from error
        preserved[name] = str(path)
    return preserved


def _process_environment(home: Path) -> tuple[dict[str, str], list[str]]:
    environment = {name: os.environ[name] for name in PASSTHROUGH_ENVIRONMENT if os.environ.get(name)}
    environment.setdefault("PATH", "/usr/bin:/bin")
    environment.update({"HOME": str(home), "TMPDIR": str(home), "LANG": "C", "LC_ALL": "C"})
    runtime_caches = _validated_runtime_cache_environment()
    environment.update(runtime_caches)
    environment.update(FIXED_ENVIRONMENT)
    return environment, sorted(runtime_caches)


class _SockFilter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]


class _SockFprog(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ushort), ("filter", ctypes.POINTER(_SockFilter))]


def _install_linux_network_filter() -> None:
    architectures = {
        "x86_64": (0xC000003E, (41, 42, 43, 44, 45, 46, 47, 49, 50, 51, 52, 53, 54, 55, 288, 299, 307, 425, 426, 427)),
        "aarch64": (0xC00000B7, (198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 242, 243, 269, 425, 426, 427)),
        "arm64": (0xC00000B7, (198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 242, 243, 269, 425, 426, 427)),
    }
    selected = architectures.get(platform.machine().lower())
    if selected is None:
        raise OSError(errno.ENOTSUP, "network-none sandbox is unsupported on this Linux architecture")
    audit_arch, blocked_calls = selected
    deny = 0x00050000 | errno.EACCES
    instructions = [
        _SockFilter(0x20, 0, 0, 4),
        _SockFilter(0x15, 1, 0, audit_arch),
        _SockFilter(0x06, 0, 0, 0x80000000),
        _SockFilter(0x20, 0, 0, 0),
        _SockFilter(0x45, 0, 1, 0x40000000),
        _SockFilter(0x06, 0, 0, deny),
    ]
    for syscall_number in blocked_calls:
        instructions.extend((_SockFilter(0x15, 0, 1, syscall_number), _SockFilter(0x06, 0, 0, deny)))
    instructions.append(_SockFilter(0x06, 0, 0, 0x7FFF0000))
    filters = (_SockFilter * len(instructions))(*instructions)
    program = _SockFprog(len(instructions), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.prctl(22, 2, ctypes.cast(ctypes.byref(program), ctypes.c_void_p)) != 0:
        raise OSError(ctypes.get_errno() or errno.EPERM, "could not install the network-none seccomp filter")


def _install_macos_network_filter() -> None:
    sandbox = ctypes.CDLL(None, use_errno=True)
    sandbox.sandbox_init.restype = ctypes.c_int
    sandbox.sandbox_init.argtypes = (ctypes.c_char_p, ctypes.c_uint64, ctypes.POINTER(ctypes.c_char_p))
    error_buffer = ctypes.c_char_p()
    if sandbox.sandbox_init(b"(version 1)(allow default)(deny network*)", 0, ctypes.byref(error_buffer)) != 0:
        message = error_buffer.value.decode("utf-8", errors="replace") if error_buffer.value else "sandbox_init failed"
        if error_buffer.value and hasattr(sandbox, "sandbox_free_error"):
            sandbox.sandbox_free_error(error_buffer)
        raise OSError(errno.EPERM, message)


def _network_sandbox(argv: list[str]) -> NetworkSandbox:
    if sys.platform == "darwin":
        return NetworkSandbox(argv, "sandbox-init-deny-network", _install_macos_network_filter)
    if sys.platform.startswith("linux"):
        return NetworkSandbox(argv, "seccomp-bpf-deny-network", _install_linux_network_filter)
    raise HarnessError("network-none sandbox is unsupported on this platform")


# ── One Deadline And One Process Group Own Every Child ─────────
# Version discovery, compilation, test execution, stream draining, and evidence
# publication all share one monotonic deadline. Each child starts a new session;
# cleanup signals the group even when its leader has already exited, then reaps
# the leader after escalation. Output is truncated at the read boundary, so a
# noisy compiler or counterexample cannot exceed the retained evidence budget.
# ─────────────────────────────────────────────────────────────────


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
        raise HarnessError("Foundry process group could not be reaped") from error


def _read_stream(descriptor: int) -> bytes:
    return os.read(descriptor, 65_536)


def _run_process(argv: list[str], *, deadline: float, stdout_limit: int, stderr_limit: int, environment: dict[str, str], cwd: Path, sandbox_factory: SandboxFactory) -> ProcessResult:
    if time.monotonic() >= deadline:
        return ProcessResult(None, b"", b"", True, None)
    sandbox = sandbox_factory(argv)
    try:
        process = subprocess.Popen(sandbox.argv, cwd=cwd, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, start_new_session=True, preexec_fn=sandbox.preexec_fn)
    except (OSError, subprocess.SubprocessError) as error:
        raise HarnessError(f"could not start {Path(argv[0]).name}: {error}") from error
    if process.stdout is None or process.stderr is None:
        _terminate_group(process)
        raise HarnessError("tool streams were unavailable")
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
            for key, _ in selector.select(timeout=min(0.05, max(0.0, deadline - time.monotonic()))):
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


def _process_evidence(argv: list[str], result: ProcessResult) -> dict[str, Any]:
    return {"argv": argv, "exit_code": result.return_code, "timed_out": result.timed_out, "limit_exceeded": result.limit_exceeded, "stdout": _stream(result.stdout), "stderr": _stream(result.stderr)}


def _atomic_json(target: OutputTarget, value: dict[str, Any], deadline: float) -> None:
    _check_deadline(deadline, "evidence serialization")
    raw = f"{json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False)}\n".encode("utf-8")
    if len(raw) > MAX_EVIDENCE_BYTES:
        raise HarnessError("evidence exceeds the package output boundary")
    _check_deadline(deadline, "evidence serialization")
    temporary_name: str | None = None
    descriptor: int | None = None
    published = False
    try:
        for _ in range(16):
            temporary_name = f".{target.name}.{secrets.token_hex(12)}.tmp"
            try:
                descriptor = os.open(temporary_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=target.parent_descriptor)
                break
            except FileExistsError:
                temporary_name = None
        if descriptor is None or temporary_name is None:
            raise HarnessError("could not allocate a private evidence file")
        view = memoryview(raw)
        while view:
            _check_deadline(deadline, "evidence write")
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        _check_deadline(deadline, "evidence publication")
        try:
            os.link(temporary_name, target.name, src_dir_fd=target.parent_descriptor, dst_dir_fd=target.parent_descriptor, follow_symlinks=False)
        except FileExistsError as error:
            raise HarnessError("output path was created before publication") from error
        published = True
        os.fsync(target.parent_descriptor)
        _check_deadline(deadline, "evidence publication")
        os.unlink(temporary_name, dir_fd=target.parent_descriptor)
        temporary_name = None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if temporary_name is not None:
            if published:
                try:
                    temporary_metadata = os.stat(temporary_name, dir_fd=target.parent_descriptor, follow_symlinks=False)
                    output_metadata = os.stat(target.name, dir_fd=target.parent_descriptor, follow_symlinks=False)
                    if _same_inode(temporary_metadata, output_metadata):
                        os.unlink(target.name, dir_fd=target.parent_descriptor)
                except FileNotFoundError:
                    pass
            try:
                os.unlink(temporary_name, dir_fd=target.parent_descriptor)
            except FileNotFoundError:
                pass


def _offline_compiler_missing(result: ProcessResult) -> bool:
    if result.return_code in {None, 0}:
        return False
    message = (result.stdout + b"\n" + result.stderr).decode("utf-8", errors="replace").lower()
    compiler = "solc" in message or "compiler" in message
    absent = any(marker in message for marker in ("not installed", "not found", "missing", "unavailable", "cannot install", "can't install"))
    return compiler and absent and "offline" in message


def _campaign(payload: dict[str, Any], raw_input: bytes, workspace: Path, output: OutputTarget, command: str, sandbox_factory: SandboxFactory = _network_sandbox) -> dict[str, Any]:
    started = time.monotonic()
    campaign_id, scope_reference, source_relative, test_pattern, fuzz_seed, max_files, max_bytes, timeout, stdout_limit = _validated(payload)
    deadline = started + timeout
    execution_deadline = max(started, deadline - REPORT_RESERVE_SECONDS)
    _check_deadline(execution_deadline, "campaign preflight")
    source_parts = source_relative.parts
    if output.relative.parts[:len(source_parts)] == source_parts:
        raise HarnessError("output must not be inside source_directory")
    recorded_command = [TRUSTED_COMMAND, "test", "--offline", "--root", "<snapshot>/source", "--out", "<private>/out", "--cache-path", "<private>/cache", "--match-test", test_pattern, "--fuzz-seed", fuzz_seed, "-vvv"]
    sandbox_mechanism = sandbox_factory([command, "--version"]).mechanism
    source = _open_directory(workspace, source_relative)
    try:
        with tempfile.TemporaryDirectory(prefix="cyberful-foundry-") as campaign_directory:
            campaign_root = Path(campaign_directory)
            home = campaign_root / "home"
            home.mkdir(mode=0o700)
            snapshot = campaign_root / "snapshot" / "source"
            try:
                snapshot.parent.mkdir(mode=0o700)
                source_inventory = _snapshot(source, snapshot, max_files, max_bytes, execution_deadline)
                environment, runtime_cache_names = _process_environment(home)
                version_argv = [command, "--version"]
                version_result = _run_process(version_argv, deadline=execution_deadline, stdout_limit=MAX_VERSION_BYTES, stderr_limit=MAX_VERSION_BYTES, environment=environment, cwd=campaign_root, sandbox_factory=sandbox_factory)
                if version_result.return_code != 0 or version_result.timed_out or version_result.limit_exceeded is not None:
                    raise HarnessError("Foundry version probe did not complete inside the network-none sandbox")
                out_directory = campaign_root / "out"
                cache_directory = campaign_root / "cache"
                executed_command = [command, "test", "--offline", "--root", str(snapshot), "--out", str(out_directory), "--cache-path", str(cache_directory), "--match-test", test_pattern, "--fuzz-seed", fuzz_seed, "-vvv"]
                result = _run_process(executed_command, deadline=execution_deadline, stdout_limit=stdout_limit, stderr_limit=MAX_STDERR_BYTES, environment=environment, cwd=campaign_root, sandbox_factory=sandbox_factory)
                if _offline_compiler_missing(result):
                    raise HarnessError("required Solidity compiler is unavailable in the runtime-owned offline cache")
            finally:
                _unlock_snapshot(snapshot)
    finally:
        os.close(source.descriptor)
    evidence = {
        "format": "cyberful.smart-contract-invariant-evidence.v1",
        "campaign_id": campaign_id,
        "scope_reference": scope_reference,
        "input_sha256": hashlib.sha256(raw_input).hexdigest(),
        "source": source_inventory,
        "network_sandbox": {"network": "none", "mechanism": sandbox_mechanism},
        "tool": {"name": TRUSTED_COMMAND, "runtime_cache_environment": runtime_cache_names, "version_probe": _process_evidence([TRUSTED_COMMAND, "--version"], version_result)},
        "command": recorded_command,
        "result": _process_evidence(recorded_command, result),
        "limits": {"timeout_seconds": timeout, "stdout_bytes": stdout_limit, "stderr_bytes": MAX_STDERR_BYTES},
    }
    _atomic_json(output, evidence, deadline)
    return evidence


def _run_campaign_for_test(payload: dict[str, Any], raw_input: bytes, workspace: Path, output: Path, command: str, sandbox_factory: SandboxFactory | None = None) -> dict[str, Any]:
    """Inject a fixture executable without exposing command choice to campaign JSON."""
    fixture_sandbox = sandbox_factory or (lambda argv: NetworkSandbox(argv, "test-fixture-no-network-route", None))
    owned_workspace = workspace.resolve(strict=True)
    try:
        relative_output = output.resolve(strict=False).relative_to(owned_workspace).as_posix()
    except ValueError as error:
        raise HarnessError("output must remain inside workspace") from error
    target = _open_output_target(owned_workspace, relative_output)
    try:
        return _campaign(payload, raw_input, owned_workspace, target, command, fixture_sandbox)
    finally:
        os.close(target.parent_descriptor)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a bounded offline Foundry invariant harness")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(argv)
    try:
        workspace = _workspace(arguments.workspace)
        payload, raw_input, input_path = _read_input(workspace, arguments.input)
        output = _open_output_target(workspace, arguments.output)
        if output.path == input_path:
            raise HarnessError("output must differ from input")
        try:
            _campaign(payload, raw_input, workspace, output, TRUSTED_COMMAND)
        finally:
            os.close(output.parent_descriptor)
    except (HarnessError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(output.relative.as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
