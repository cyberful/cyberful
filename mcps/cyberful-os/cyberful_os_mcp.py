#!/usr/bin/env python3
# ── cyberful-os Security Tool MCP Server ─────────────────────────────
# Exposes the verified cyberful-os tool catalog over stdio JSON-RPC and runs each
# invocation inside one lazily created, workspace-mounted cyberful-os container.
# It validates arguments, bounds time and retained output, streams sanitized
# progress, and keeps diagnostics off the protocol channel.
# → mcps/cyberful-os/scripts/container_ctl.py — manages the same named runtime.
# @docs/runtimes/cyberful-os.md
# ─────────────────────────────────────────────────────────────────────

from __future__ import annotations

import json
import hashlib
import importlib.util
import math
import os
import re
import selectors
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.parse
from dataclasses import dataclass
from types import FrameType
from typing import Any, BinaryIO, Callable, Iterator

# ── Bound Every Tool Call Before It Reaches Docker ────────────────────
# MCP requests arrive as client-controlled JSON. Shared defaults and caps form
# one policy boundary that every container command passes through before a host
# process starts. Timeout and retained output are therefore canonicalized once
# instead of depending on the individual tool handler.
# ──────────────────────────────────────────────────────────────────────

SERVER_NAME = "cyberful-os"
SERVER_VERSION = "0.2.0"
DEFAULT_TIMEOUT_SECONDS = 120
MAX_TIMEOUT_SECONDS = 3600
DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
DOCKER_CONTROL_OUTPUT_BYTES = 64 * 1024
MAX_BATCH_REQUESTS = 32
MAX_JSON_LINE_BYTES = 2 * 1024 * 1024
MAX_JSON_DEPTH = 20
MAX_JSON_ARRAY_ITEMS = 256
MAX_JSON_OBJECT_PROPERTIES = 256
MAX_JSON_STRING_CHARS = 1024 * 1024
MAX_PARSE_INPUT_BYTES = 2 * 1024 * 1024
MAX_LIBRARY_RESULT_CHARS = 1024 * 1024
MAX_WORDLIST_SCAN_ENTRIES = 10_000
MAX_WORDLIST_PREVIEW_BYTES = 1024 * 1024
MAX_WORDLIST_PREVIEW_FILE_BYTES = 64 * 1024
MAX_EXTRA_ENV_VARS = 64
MAX_ENV_VALUE_BYTES = 32 * 1024
DEFAULT_IMAGE = "cyberful-os:latest"
PROGRESS_INTERVAL_SECONDS = 0.25
PROGRESS_PREVIEW_BYTES = 64 * 1024
PASSTHROUGH_ENV_KEYS = ()
NO_TELEMETRY_ENV = {
    "DISABLE_UPDATE_CHECK": "true",
    "DO_NOT_TRACK": "1",
    "GRYPE_CHECK_FOR_APP_UPDATE": "false",
    "PDCP_API_KEY": "",
    "SEMGREP_SEND_METRICS": "off",
    "SYFT_CHECK_FOR_APP_UPDATE": "false",
}
CURRENT_PROGRESS_TOKEN: Any | None = None
LAST_PROGRESS_AT = 0.0
PROGRESS_SEQUENCE = 0
NUCLEI_MAX_TEMPLATES = 40
NUCLEI_MAX_RATE = 5
NUCLEI_EXCLUDED_TAGS = "dos,fuzz,bruteforce,headless,oast,interactsh,intrusive"
STRICT_PREFLIGHT_ENV = "CYBERFUL_OS_STRICT_PREFLIGHT"
WORKAREA_ROOT_ENV = "CYBERFUL_SUBSYSTEM_WORKAREA_ROOT"
ANSI_OSC_RE = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)")
ANSI_CSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
ANSI_SINGLE_RE = re.compile(r"\x1b[@-Z\\-_]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# ── Speak JSON-RPC On Stdout And Diagnostics On Stderr ────────────────
# MCP clients parse stdout as a protocol stream, so diagnostics belong only on
# stderr. Every response and notification is serialized through one helper,
# producing exactly one JSON object per line. Log text can therefore never be
# interleaved with a partially written JSON-RPC message.
# ──────────────────────────────────────────────────────────────────────


def eprint(message: str) -> None:
    print(f"[{SERVER_NAME}] {message}", file=sys.stderr, flush=True)


def send(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def notify(method: str, params: dict[str, Any]) -> None:
    send({"jsonrpc": "2.0", "method": method, "params": params})


# ── Return Terminal Output As Plain MCP Text ──────────────────────────
# Security tools often emit ANSI controls, OSC titles, carriage returns, and
# progress redraws. The same sanitizer handles progress previews and final
# results, keeping their text readable while removing controls that could alter
# a client's terminal rather than describe the command output.
# ──────────────────────────────────────────────────────────────────────

def sanitize_terminal_text(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    normalized = ANSI_OSC_RE.sub("", normalized)
    normalized = ANSI_CSI_RE.sub("", normalized)
    normalized = ANSI_SINGLE_RE.sub("", normalized)
    return CONTROL_RE.sub("", normalized)


def progress_output(output: str, *, force: bool = False) -> None:
    global LAST_PROGRESS_AT, PROGRESS_SEQUENCE
    output = sanitize_terminal_text(output)
    if CURRENT_PROGRESS_TOKEN is None or not output:
        return

    now = time.monotonic()
    if not force and now - LAST_PROGRESS_AT < PROGRESS_INTERVAL_SECONDS:
        return

    LAST_PROGRESS_AT = now
    PROGRESS_SEQUENCE += 1
    notify(
        "notifications/progress",
        {
            "progressToken": CURRENT_PROGRESS_TOKEN,
            "progress": PROGRESS_SEQUENCE,
            "message": output,
        },
    )


def ok(message_id: Any, result: dict[str, Any]) -> None:
    send({"jsonrpc": "2.0", "id": message_id, "result": result})


def err(message_id: Any, code: int, message: str, data: Any | None = None) -> None:
    payload: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        payload["data"] = data
    send({"jsonrpc": "2.0", "id": message_id, "error": payload})


def env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value else default


def env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be one of true, false, 1, 0, yes, no, on, or off")


def int_arg(value: Any, default: int, minimum: int, maximum: int) -> int:
    if value is None:
        return default
    if type(value) is not int or value < minimum or value > maximum:
        raise ValueError(f"expected an integer between {minimum} and {maximum}")
    return value


def project_root() -> str:
    return os.path.abspath(env("CYBERFUL_OS_WORKSPACE", os.getcwd()))


def mount_dir() -> str:
    return env("CYBERFUL_OS_MOUNT", "/workspace")


def default_container_cwd() -> str:
    """Working directory for container tools when the caller passes no explicit `cwd`.

    Default it to the container path matching THIS MCP process's OWN working directory, not the mount
    root. The Expert gateway runs cyberful-os inside the phase workarea (a subdirectory of the mounted
    workspace, inherited from claude's cwd), so a tool's relative output (`-o file`, a download) then
    lands in the workarea instead of leaking to the mounted repo root. Falls back to the mount root
    when the process cwd is the workspace root itself or outside it (e.g. the TUI, run at the repo root).
    """
    mount = mount_dir()
    cwd = os.getcwd()
    # ── Container CWD Mirrors This MCP Process ─────────────────────────
    # The container mounts the repository root, while this MCP may start inside a
    # phase workarea below it. An explicit workspace wins; otherwise the nearest
    # checked-in Cyberful built-ins identify the mount root. Mapping failure falls
    # back to the mount itself instead of inventing an unsafe relative directory.
    # ────────────────────────────────────────────────────────────────────
    root = os.environ.get("CYBERFUL_OS_WORKSPACE")
    if not root:
        probe = cwd
        while True:
            if os.path.isfile(os.path.join(probe, "packages", "cyberful", "builtin", "cyberful.json")):
                root = probe
                break
            parent = os.path.dirname(probe)
            if parent == probe:
                return mount
            probe = parent
    try:
        rel = os.path.relpath(cwd, os.path.abspath(root))
    except (OSError, ValueError):
        return mount
    if rel == os.curdir or rel.startswith(os.pardir):
        return mount
    return os.path.join(mount, rel)


def container_name() -> str:
    return env("CYBERFUL_OS_CONTAINER", "cyberful-os")


def image_name() -> str:
    return env("CYBERFUL_OS_IMAGE", DEFAULT_IMAGE)


def docker_extra_args() -> list[str]:
    raw = os.environ.get("CYBERFUL_OS_DOCKER_ARGS", "")
    return shlex.split(raw) if raw else []


# ── Preserve The User's Docker Endpoint Choice ────────────────────────
# Docker Desktop's socket is useful as a fallback on macOS, but it must not
# override an explicit DOCKER_HOST, DOCKER_CONTEXT, or a configured non-default
# context. Endpoint detection is centralized before any subprocess environment
# is built, making that precedence stable and directly testable.
# ──────────────────────────────────────────────────────────────────────

def default_docker_config() -> str:
    return os.path.join(
        env("XDG_STATE_HOME", os.path.join(os.path.expanduser("~"), ".local", "state")),
        "cyberful-os",
        "mcp",
        "cyberful-os",
        "docker-config",
    )


def docker_config_dir(next_env: dict[str, str]) -> str:
    return next_env.get("DOCKER_CONFIG") or os.path.join(os.path.expanduser("~"), ".docker")


def configured_docker_context(next_env: dict[str, str]) -> str:
    if next_env.get("DOCKER_CONTEXT"):
        return next_env["DOCKER_CONTEXT"]

    config_path = os.path.join(docker_config_dir(next_env), "config.json")
    try:
        with open(config_path, "r", encoding="utf-8") as handle:
            config = json.load(handle)
    except FileNotFoundError:
        return ""
    except OSError as exc:
        raise RuntimeError(f"Docker configuration cannot be read: {config_path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"Docker configuration is invalid JSON: {config_path}") from exc

    if not isinstance(config, dict):
        raise ValueError(f"Docker configuration must contain a JSON object: {config_path}")
    context = config.get("currentContext")
    if context is None:
        return ""
    if not isinstance(context, str):
        raise ValueError(f"Docker currentContext must be a string: {config_path}")
    return context


def has_explicit_docker_endpoint(next_env: dict[str, str]) -> bool:
    if next_env.get("DOCKER_HOST") or next_env.get("DOCKER_CONTEXT"):
        return True
    context = configured_docker_context(next_env)
    return bool(context and context != "default")


def ensure_docker_config(docker_config: str) -> None:
    os.makedirs(docker_config, exist_ok=True)
    config_path = os.path.join(docker_config, "config.json")
    if not os.path.exists(config_path):
        with open(config_path, "w", encoding="utf-8") as handle:
            handle.write('{"auths":{}}\n')


def docker_environment() -> dict[str, str]:
    next_env = os.environ.copy()
    docker_config = os.environ.get("CYBERFUL_OS_DOCKER_CONFIG")
    if docker_config:
        ensure_docker_config(docker_config)
        next_env["DOCKER_CONFIG"] = docker_config

    desktop_sock = os.path.join(os.path.expanduser("~"), ".docker", "run", "docker.sock")
    if not has_explicit_docker_endpoint(next_env) and os.path.exists(desktop_sock):
        next_env["DOCKER_HOST"] = f"unix://{desktop_sock}"
    return next_env


# ── Tool Calls Cannot Re-enable Background Traffic ──────────────────
# The image disables the known update and metrics paths of its bundled tools,
# but docker exec environment overrides take precedence over image defaults.
# Callers may still pass provider credentials and scan configuration; the fixed
# no-telemetry keys are reapplied last so one invocation cannot weaken policy.
# This protects every dedicated tool and the shell fallback at one boundary.
# ─────────────────────────────────────────────────────────────────────

def inherited_container_env(extra_env: dict[str, str] | None) -> dict[str, str]:
    next_env = {key: os.environ[key] for key in PASSTHROUGH_ENV_KEYS if os.environ.get(key)}
    if extra_env:
        next_env.update(normalize_extra_env(extra_env) or {})
    next_env.update(NO_TELEMETRY_ENV)
    return next_env


# ── Create The cyberful-os Runtime Lazily And Reuse It ───────────────
# Tool listing and initialization should not start Docker. The first real tool
# call inspects the named container, starts or safely recreates it when needed,
# and verifies a reused workspace mount once. Later exec calls can then rely on
# one live mounted runtime without introducing import-time side effects.
# ──────────────────────────────────────────────────────────────────────


# ── Docker Control Output Is Bounded Before Parsing ──────────────────
# Container probes are host subprocesses even though they are not user tools.
# They share the streaming runner so a verbose daemon or wrapper cannot retain
# unlimited output before an image id, state, or container id is inspected.
# Timeout preserves subprocess.run semantics, while truncation fails closed
# instead of accepting a partial identity or diagnostic as authoritative state.
# ──────────────────────────────────────────────────────────────────────


def docker(argv: list[str], *, timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS) -> subprocess.CompletedProcess[bytes]:
    command = ["docker", *argv]
    result = run_process(
        command,
        timeout_seconds=timeout_seconds,
        extra_env=docker_environment(),
        max_output_bytes=DOCKER_CONTROL_OUTPUT_BYTES,
        emit_progress=False,
    )
    stdout = result.stdout.encode("utf-8")
    stderr = result.stderr.encode("utf-8")
    if result.timed_out:
        raise subprocess.TimeoutExpired(command, timeout_seconds, output=stdout, stderr=stderr)
    if result.truncated:
        raise RuntimeError(f"Docker control output exceeded {DOCKER_CONTROL_OUTPUT_BYTES} bytes")
    return subprocess.CompletedProcess(
        command,
        result.exit_code if result.exit_code is not None else 1,
        stdout,
        stderr,
    )


# ── Reused Container Mount Is Attested Once Per MCP Process ───────────
# A container inherited from a previous run may retain a bind mount whose host
# directory was recreated with a new inode. The first tool call verifies that
# mount before reuse. Containers created by this process cannot acquire that
# stale state, so repeated probes would only add Docker round trips.
# ──────────────────────────────────────────────────────────────────────
_mount_verified = False


def container_mount_healthy(name: str) -> bool:
    # ── Health Probe Uses The Real Tool Working Directory ──────────────
    # A no-op command executes with the same working directory as every real tool.
    # A detached workspace bind mount then triggers runc's namespace guard here,
    # before an ordinary user command fails opaquely with exit 128. A live mount
    # completes successfully without modifying the workspace or container state.
    # ────────────────────────────────────────────────────────────────────
    probe = docker(["exec", "-w", mount_dir(), name, "true"], timeout_seconds=30)
    return probe.returncode == 0


def ensure_container(timeout_seconds: int) -> None:
    global _mount_verified
    name = container_name()
    inspect = docker(["container", "inspect", "--format", "{{.Image}} {{.State.Running}}", name], timeout_seconds=30)
    if inspect.returncode == 0:
        container_image, _, running = inspect.stdout.decode("utf-8", errors="replace").strip().partition(" ")
        # ── Reuse Requires The Current Container Image ─────────────────
        # A named container can outlive the image build that created it. Reusing it
        # after a rebuild would silently omit newly installed tools. When both image
        # identities resolve and differ, remove the stale container and recreate it;
        # if the desired image cannot be inspected, preserve the working container.
        # ─────────────────────────────────────────────────────────────────
        current = docker(["image", "inspect", "--format", "{{.Id}}", image_name()], timeout_seconds=30)
        current_image = current.stdout.decode("utf-8", errors="replace").strip() if current.returncode == 0 else ""
        if current_image and container_image and container_image != current_image:
            docker(["rm", "-f", name], timeout_seconds=60)
        else:
            if running != "true":
                start = docker(["start", name], timeout_seconds=60)
                if start.returncode != 0:
                    raise RuntimeError(start.stderr.decode("utf-8", errors="replace").strip())
            if _mount_verified or container_mount_healthy(name):
                _mount_verified = True
                return
            docker(["rm", "-f", name], timeout_seconds=60)

    workspace = project_root()
    target = mount_dir()
    args = [
        "run",
        "-d",
        "--name",
        name,
        "--hostname",
        name,
        "-w",
        target,
        "-v",
        f"{workspace}:{target}",
        "--cap-add=NET_ADMIN",
        "--cap-add=SYS_PTRACE",
        *docker_extra_args(),
        image_name(),
        "sleep",
        "infinity",
    ]
    run = docker(args, timeout_seconds=max(60, timeout_seconds))
    if run.returncode != 0:
        stderr = run.stderr.decode("utf-8", errors="replace").strip()
        stdout = run.stdout.decode("utf-8", errors="replace").strip()
        primary_error = RuntimeError(stderr or stdout or "docker run failed")

        # ── Failed Creation Cannot Retain A Named Container ─────────────
        # Docker may create the named container before runc rejects its hostname,
        # mount, working directory, or process. A non-zero `docker run` therefore
        # does not prove that no resource exists. Remove the exact owned name before
        # returning the startup failure; a missing name is already clean, while a
        # real cleanup failure is reported without replacing the primary cause.
        # ─────────────────────────────────────────────────────────────────
        try:
            cleanup = docker(["rm", "-f", name], timeout_seconds=60)
        except (RuntimeError, subprocess.TimeoutExpired) as cleanup_error:
            raise RuntimeError(f"docker run failed and cleanup could not complete: {cleanup_error}") from primary_error
        cleanup_detail = cleanup.stderr.decode("utf-8", errors="replace").strip()
        if cleanup.returncode != 0 and "No such container" not in cleanup_detail:
            raise RuntimeError(
                f"docker run failed and cleanup exited with status {cleanup.returncode}: "
                f"{cleanup_detail or 'no diagnostic'}"
            ) from primary_error
        raise primary_error
    _mount_verified = True  # a freshly created container has a live mount


# ── Capture Long-Running Tool Output Without Unbounded Memory ─────────
# Pentest tools can run for minutes and redraw status continuously. The runner
# streams progress from the most recent output window while tracking total bytes
# independently. Only a bounded stdout/stderr prefix survives for the final MCP
# response, and the truncation bit records when discarded output existed.
# ──────────────────────────────────────────────────────────────────────


@dataclass
class CommandResult:
    target: str
    command: str
    exit_code: int | None
    timed_out: bool
    duration_ms: int
    stdout: str
    stderr: str
    truncated: bool


def trim_streams(stdout: bytes, stderr: bytes, max_bytes: int) -> tuple[str, str, bool]:
    combined = len(stdout) + len(stderr)
    truncated = combined > max_bytes
    if truncated:
        stdout_budget = max_bytes // 2
        stderr_budget = max_bytes - stdout_budget
        stdout = stdout[:stdout_budget] + b"\n[stdout truncated]\n"
        stderr = stderr[:stderr_budget] + b"\n[stderr truncated]\n"
    return (
        sanitize_terminal_text(stdout.decode("utf-8", errors="replace")),
        sanitize_terminal_text(stderr.decode("utf-8", errors="replace")),
        truncated,
    )


def terminate_process(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        proc.wait()
        return
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=2)


def run_process(
    argv: list[str],
    *,
    cwd: str | None = None,
    timeout_seconds: float,
    stdin: bytes | None = None,
    extra_env: dict[str, str] | None = None,
    max_output_bytes: int,
    emit_progress: bool = True,
) -> CommandResult:
    started = time.monotonic()
    proc_env = os.environ.copy()
    if extra_env:
        proc_env.update(extra_env)

    try:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=proc_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
            shell=False,
            text=False,
            close_fds=True,
        )
    except FileNotFoundError as exc:
        return CommandResult(
            target=argv[0],
            command=" ".join(shlex.quote(part) for part in argv),
            exit_code=127,
            timed_out=False,
            duration_ms=int((time.monotonic() - started) * 1000),
            stdout="",
            stderr=str(exc),
            truncated=False,
        )

    if proc.stdin:
        try:
            if stdin:
                proc.stdin.write(stdin)
            proc.stdin.close()
        except BrokenPipeError:
            proc.stdin.close()

    stdout_bytes = bytearray()
    stderr_bytes = bytearray()
    preview_bytes = bytearray()
    stdout_seen = 0
    stderr_seen = 0
    timed_out = False
    capture_limit = max_output_bytes + 8192
    deadline = started + timeout_seconds

    selector = selectors.DefaultSelector()
    try:
        if proc.stdout:
            os.set_blocking(proc.stdout.fileno(), False)
            selector.register(proc.stdout, selectors.EVENT_READ, "stdout")
        if proc.stderr:
            os.set_blocking(proc.stderr.fileno(), False)
            selector.register(proc.stderr, selectors.EVENT_READ, "stderr")

        while selector.get_map():
            now = time.monotonic()
            if not timed_out and proc.poll() is None and now >= deadline:
                timed_out = True
                terminate_process(proc)
                timeout_text = f"\nTimed out after {timeout_seconds}s.\n".encode()
                stderr_seen += len(timeout_text)
                if len(stderr_bytes) < capture_limit:
                    stderr_bytes.extend(timeout_text[: capture_limit - len(stderr_bytes)])
                preview_bytes.extend(timeout_text)
                if len(preview_bytes) > PROGRESS_PREVIEW_BYTES:
                    del preview_bytes[:-PROGRESS_PREVIEW_BYTES]
                if emit_progress:
                    progress_output(preview_bytes.decode("utf-8", errors="replace"), force=True)

            for key, _ in selector.select(timeout=0.1):
                try:
                    chunk = os.read(key.fileobj.fileno(), 8192)
                except BlockingIOError:
                    continue

                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue

                if key.data == "stdout":
                    stdout_seen += len(chunk)
                    if len(stdout_bytes) < capture_limit:
                        stdout_bytes.extend(chunk[: capture_limit - len(stdout_bytes)])
                else:
                    stderr_seen += len(chunk)
                    if len(stderr_bytes) < capture_limit:
                        stderr_bytes.extend(chunk[: capture_limit - len(stderr_bytes)])

                preview_bytes.extend(chunk)
                if len(preview_bytes) > PROGRESS_PREVIEW_BYTES:
                    del preview_bytes[:-PROGRESS_PREVIEW_BYTES]
                if emit_progress:
                    progress_output(preview_bytes.decode("utf-8", errors="replace"))
    except BaseException:
        terminate_process(proc)
        raise
    finally:
        selector.close()
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None and not stream.closed:
                stream.close()

    exit_code = proc.wait()
    stdout, stderr, truncated = trim_streams(bytes(stdout_bytes), bytes(stderr_bytes), max_output_bytes)
    if emit_progress:
        progress_output(preview_bytes.decode("utf-8", errors="replace").strip(), force=True)
    return CommandResult(
        target=argv[0],
        command=" ".join(shlex.quote(part) for part in argv),
        exit_code=None if timed_out else exit_code,
        timed_out=timed_out,
        duration_ms=int((time.monotonic() - started) * 1000),
        stdout=stdout,
        stderr=stderr,
        truncated=truncated or stdout_seen + stderr_seen > max_output_bytes,
    )


# ── Enter The Workarea Without Betting The Exec On It ─────────────────
# docker exec pins -w to the live mount root so runc never evaluates a transient
# phase workarea as its required initial directory. Such a path can disappear
# during workarea replacement and trigger the CVE-2024-21626 guard with exit 128.
# Relative tool output should still land beside phase artifacts, so the command
# enters that workarea from inside the container. A missing directory makes the
# guarded `cd` a no-op and leaves execution at the mount root instead of turning
# a lifecycle race into failure of the entire tool call.
# ──────────────────────────────────────────────────────────────────────


def _cd_prelude(workdir: str) -> str:
    return f"cd {shlex.quote(workdir)} 2>/dev/null || true; "


def container_exec_args(inner: list[str], extra_env: dict[str, str] | None) -> list[str]:
    exec_args = ["docker", "exec", "-i", "-w", mount_dir()]
    for key, value in inherited_container_env(extra_env).items():
        exec_args.extend(["-e", f"{key}={value}"])
    exec_args.append(container_name())
    exec_args.extend(inner)
    return exec_args


def run_in_container(
    command: str,
    *,
    cwd: str | None = None,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
    extra_env: dict[str, str] | None = None,
) -> CommandResult:
    """Run a shell command inside the cyberful-os container via docker exec."""
    ensure_container(timeout_seconds)
    workdir = cwd or mount_dir()
    exec_args = container_exec_args(
        ["/bin/bash", "-lc", _cd_prelude(workdir) + command], extra_env
    )

    result = run_process(
        exec_args,
        timeout_seconds=timeout_seconds,
        max_output_bytes=max_output_bytes,
        extra_env=docker_environment(),
    )
    result.target = "cyberful-os"
    result.command = command
    return result


def run_argv_in_container(
    argv: list[str],
    *,
    cwd: str | None = None,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
    extra_env: dict[str, str] | None = None,
    stdin: bytes | None = None,
) -> CommandResult:
    """Run an argv command directly inside the cyberful-os container via docker exec."""
    ensure_container(timeout_seconds)
    workdir = cwd or mount_dir()
    exec_args = container_exec_args(
        ["/bin/sh", "-c", _cd_prelude(workdir) + 'exec "$@"', "sh", *argv], extra_env
    )

    result = run_process(
        exec_args,
        timeout_seconds=timeout_seconds,
        max_output_bytes=max_output_bytes,
        extra_env=docker_environment(),
        stdin=stdin,
    )
    result.target = "cyberful-os"
    result.command = shlex.join(argv)
    return result


def tool_result(text: str, is_error: bool = False) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": text}],
        "isError": is_error,
    }


def result_from_run(r: CommandResult) -> dict[str, Any]:
    """Format a CommandResult into an MCP tool response."""
    is_error = r.timed_out or (r.exit_code is not None and r.exit_code != 0)
    stdout = sanitize_terminal_text(r.stdout).rstrip()
    stderr = sanitize_terminal_text(r.stderr).rstrip()
    lines = [
        f"target: {r.target}",
        f"exit_code: {r.exit_code if r.exit_code is not None else 'timeout'}",
        f"duration_ms: {r.duration_ms}",
        f"timed_out: {str(r.timed_out).lower()}",
        f"truncated: {str(r.truncated).lower()}",
        "",
        "stdout:",
        stdout,
    ]
    if stderr:
        lines.extend(["", "stderr:", stderr])
    return tool_result("\n".join(lines).rstrip() + "\n", is_error=is_error)


def result_from_cli_run(spec: CliToolSpec, r: CommandResult) -> dict[str, Any]:
    """Format a CLI result and apply tool-specific failure signals."""
    result = result_from_run(r)
    if spec.name == "feroxbuster":
        combined = f"{r.stdout}\n{r.stderr}"
        if any(signal in combined for signal in FEROXBUSTER_CONNECTIVITY_FAILURES):
            result["isError"] = True
    return result


# ── Normalize Shared Container Options Once Per Tool Call ─────────────
# Individual handlers should decide only their command-specific arguments.
# Timeout, output budget, cwd, and extra environment policy are canonicalized
# before dispatch. Generated CLI tools and handwritten helpers therefore receive
# the same bounded internal representation regardless of their public schema.
# ──────────────────────────────────────────────────────────────────────

def normalize_extra_env(value: Any) -> dict[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("env must be an object of string values")
    if len(value) > MAX_EXTRA_ENV_VARS:
        raise ValueError(f"env exceeds {MAX_EXTRA_ENV_VARS} variables")
    normalized: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(key, str) or ENV_NAME_RE.fullmatch(key) is None:
            raise ValueError(f"invalid environment variable name: {key!r}")
        if not isinstance(item, str):
            raise ValueError(f"environment variable {key} must be a string")
        if "\x00" in item or len(item.encode("utf-8")) > MAX_ENV_VALUE_BYTES:
            raise ValueError(f"environment variable {key} exceeds its safe value boundary")
        normalized[key] = item
    return normalized


def safe_container_args(args: dict[str, Any]) -> tuple[int, int, str, dict[str, str] | None]:
    timeout_seconds = int_arg(args.get("timeout_seconds"), DEFAULT_TIMEOUT_SECONDS, 1, MAX_TIMEOUT_SECONDS)
    max_output_bytes = int_arg(args.get("max_output_bytes"), DEFAULT_MAX_OUTPUT_BYTES, 1024, MAX_OUTPUT_BYTES)
    cwd = args.get("cwd") or default_container_cwd()
    extra_env = normalize_extra_env(args.get("env"))
    return timeout_seconds, max_output_bytes, cwd, extra_env


# ── Keep Handler Schemas Beside Their Execution Rules ─────────────────
# Handwritten tools declare the client-facing shape next to the code that
# consumes it. Although the final registry is rebuilt after catalog validation,
# this local pairing lets reviewers compare accepted input with the handler's
# actual normalization and failure behavior in one place.
# ──────────────────────────────────────────────────────────────────────

ToolHandler = Callable[[dict[str, Any]], dict[str, Any]]
ToolEntry = tuple[str, str, dict[str, Any], ToolHandler]
TOOL_REGISTRY: list[ToolEntry] = []

ACTIVE_CLI_CATEGORIES = frozenset(
    {
        "active-directory",
        "credentials",
        "exploitation",
        "fuzzing",
        "mobile",
        "reversing",
        "supply-chain",
        "windows",
    }
)
ACTIVE_CLI_TOOLS = frozenset(
    {
        "bettercap",
        "commix",
        "ffuf",
        "graphqlmap",
        "nikto",
        "nuclei",
        "responder",
        "sqlmap",
        "wfuzz",
    }
)
EVIDENCE_CLI_TOOLS = frozenset({"tcpdump", "tshark"})
RECON_CLI_TOOLS = frozenset(
    {
        "amass",
        "dirb",
        "feroxbuster",
        "gobuster",
        "httpx",
        "masscan",
        "nmap",
        "rustscan",
        "subfinder",
        "theharvester",
        "whatweb",
    }
)


# ── Fallback Roles Are Catalog Metadata, Not Prompt Heuristics ─────────
# A local assist should discover the catalog on demand and use the general shell
# without paying the prefill cost of every dedicated command schema. Recovery
# retains active tools because it may own the whole interrupted phase. Roles are
# derived from the verified first-party registry and emitted in MCP metadata,
# never guessed from prose; the gateway applies the mode-specific allowlist at
# both listing and call time.
# ──────────────────────────────────────────────────────────────────────
def _fallback_tool_roles(name: str) -> list[str]:
    if name == "shell":
        return ["shell"]
    if name == "tool_inventory":
        return ["evidence"]
    if name in {"requests", "bs4", "lxml"}:
        return ["active", "evidence"]
    spec = next((candidate for candidate in CLI_TOOL_SPECS if candidate.name == name), None)
    if spec is None:
        return []
    if name in RECON_CLI_TOOLS or spec.category in {"dns", "osint"}:
        return ["recon"]
    if name in EVIDENCE_CLI_TOOLS:
        return ["active", "evidence"]
    if name in ACTIVE_CLI_TOOLS or spec.category in ACTIVE_CLI_CATEGORIES:
        return ["active"]
    return []


def register_tool(name: str, description: str, schema: dict[str, Any]) -> Callable[[ToolHandler], ToolHandler]:
    """Decorator that registers a tool handler."""
    def decorator(handler: ToolHandler) -> ToolHandler:
        TOOL_REGISTRY.append((name, description, schema, handler))
        return handler
    return decorator


# ── Tool Schemas Are Runtime Boundaries ──────────────────────────────
# The catalog's JSON schemas are enforced before a handler can create Docker
# state or start a command. Recursive validation covers required and unknown
# fields as well as nested additional-property schemas. Shared limits also bound
# permissive JSON objects, strings, arrays, depth, and total encoded input.
# Malformed calls become ordinary MCP tool errors and leave the server usable.
# ──────────────────────────────────────────────────────────────────────

def _input_error(path_label: str, message: str) -> None:
    raise ValueError(f"invalid tool arguments at {path_label}: {message}")


def _add_json_bytes(state: list[int], value: Any, path_label: str) -> None:
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        _input_error(path_label, f"value is not JSON serializable ({exc})")
    state[0] += len(encoded.encode("utf-8"))
    if state[0] > MAX_JSON_LINE_BYTES:
        _input_error(path_label, f"encoded arguments exceed {MAX_JSON_LINE_BYTES} bytes")


def _validate_schema_value(
    value: Any,
    schema: dict[str, Any],
    path_label: str,
    depth: int,
    state: list[int],
) -> None:
    if depth > MAX_JSON_DEPTH:
        _input_error(path_label, f"nesting exceeds {MAX_JSON_DEPTH} levels")

    choices = schema.get("enum")
    if choices is not None and not any(type(value) is type(choice) and value == choice for choice in choices):
        _input_error(path_label, f"expected one of {', '.join(json.dumps(choice) for choice in choices)}")

    expected_type = schema.get("type")
    if expected_type == "integer" and type(value) is not int:
        _input_error(path_label, "expected an integer")
    if expected_type == "number" and (
        type(value) not in {int, float} or (type(value) is float and not math.isfinite(value))
    ):
        _input_error(path_label, "expected a finite number")
    if expected_type == "string" and not isinstance(value, str):
        _input_error(path_label, f"expected string, got {type(value).__name__}")
    if expected_type == "boolean" and type(value) is not bool:
        _input_error(path_label, f"expected boolean, got {type(value).__name__}")
    if expected_type == "array" and not isinstance(value, list):
        _input_error(path_label, f"expected array, got {type(value).__name__}")
    if expected_type == "object" and not isinstance(value, dict):
        _input_error(path_label, f"expected object, got {type(value).__name__}")

    if isinstance(value, str):
        _add_json_bytes(state, value, path_label)
        maximum = min(schema.get("maxLength", MAX_JSON_STRING_CHARS), MAX_JSON_STRING_CHARS)
        if len(value) > maximum:
            _input_error(path_label, f"string exceeds {maximum} characters")
        minimum = schema.get("minLength")
        if minimum is not None and len(value) < minimum:
            _input_error(path_label, f"string must contain at least {minimum} characters")
        pattern = schema.get("pattern")
        if pattern and re.search(pattern, value) is None:
            _input_error(path_label, f"string does not match {pattern}")
        return

    if type(value) in {int, float}:
        _add_json_bytes(state, value, path_label)
        if type(value) is float and not math.isfinite(value):
            _input_error(path_label, "expected a finite number")
        minimum = schema.get("minimum")
        maximum = schema.get("maximum")
        if minimum is not None and value < minimum:
            _input_error(path_label, f"value must be at least {minimum}")
        if maximum is not None and value > maximum:
            _input_error(path_label, f"value must be at most {maximum}")
        return

    if value is None or type(value) is bool:
        _add_json_bytes(state, value, path_label)
        return

    if isinstance(value, list):
        state[0] += 2
        maximum = min(schema.get("maxItems", MAX_JSON_ARRAY_ITEMS), MAX_JSON_ARRAY_ITEMS)
        if len(value) > maximum:
            _input_error(path_label, f"array exceeds {maximum} items")
        minimum = schema.get("minItems")
        if minimum is not None and len(value) < minimum:
            _input_error(path_label, f"array must contain at least {minimum} items")
        item_schema = schema.get("items") or {}
        for index, item in enumerate(value):
            if index:
                state[0] += 1
            _validate_schema_value(item, item_schema, f"{path_label}[{index}]", depth + 1, state)
        return

    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        _input_error(path_label, "expected a JSON object with string keys")
    if len(value) > MAX_JSON_OBJECT_PROPERTIES:
        _input_error(path_label, f"object exceeds {MAX_JSON_OBJECT_PROPERTIES} properties")

    state[0] += 2
    required = schema.get("required") or []
    for key in required:
        if key not in value:
            property_schema = (schema.get("properties") or {}).get(key, {})
            if property_schema.get("type") == "string" and property_schema.get("minLength") == 1:
                _input_error(path_label, f"`{key}` must be a non-empty string")
            _input_error(path_label, f"missing required property {key}")
    properties = schema.get("properties") or {}
    additional = schema.get("additionalProperties", True)
    for index, (key, item) in enumerate(value.items()):
        state[0] += (1 if index else 0) + len(json.dumps(key, ensure_ascii=False).encode("utf-8")) + 1
        if state[0] > MAX_JSON_LINE_BYTES:
            _input_error(path_label, f"encoded arguments exceed {MAX_JSON_LINE_BYTES} bytes")
        if key in properties:
            item_schema = properties[key]
        elif additional is False:
            _input_error(path_label, f"unknown property {key}")
        else:
            item_schema = additional if isinstance(additional, dict) else {}
        _validate_schema_value(item, item_schema, f"{path_label}.{key}", depth + 1, state)


def validate_tool_arguments(schema: dict[str, Any], args: Any) -> dict[str, Any]:
    _validate_schema_value(args, schema, "arguments", 0, [0])
    if not isinstance(args, dict):
        _input_error("arguments", "expected an object")
    return args


def _std_options() -> dict[str, Any]:
    return {
        "timeout_seconds": {
            "type": "integer",
            "minimum": 1,
            "maximum": MAX_TIMEOUT_SECONDS,
            "default": DEFAULT_TIMEOUT_SECONDS,
            "description": "Wall‑clock timeout for this command.",
        },
        "max_output_bytes": {
            "type": "integer",
            "minimum": 1024,
            "maximum": MAX_OUTPUT_BYTES,
            "default": DEFAULT_MAX_OUTPUT_BYTES,
            "description": "Maximum combined stdout/stderr bytes returned (default 262144; maximum 4194304).",
        },
        "cwd": {
            "type": "string",
            "description": "Working directory inside the container (default: /workspace).",
        },
    }


# ── Keep Arbitrary Shell Execution Explicitly Named ───────────────────
# Most clients should call a dedicated lowercase tool so argv validation can
# avoid shell parsing. A fallback remains available for genuine catalog gaps,
# but its public name and description identify the less-structured boundary and
# prevent callers from mistaking a shell string for the normal execution path.
# ──────────────────────────────────────────────────────────────────────


@register_tool(
    "shell",
    "Fallback only: execute an arbitrary shell command inside the Docker cyberful-os container when no dedicated lowercase tool fits.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "command": {
                "type": "string",
                "minLength": 1,
                "description": "Shell command to execute with bash -lc in cyberful-os.",
            },
            "cwd": {
                "type": "string",
                "description": "Working directory inside the container. Defaults to /workspace.",
            },
            "timeout_seconds": {
                "type": "integer",
                "minimum": 1,
                "maximum": MAX_TIMEOUT_SECONDS,
                "default": DEFAULT_TIMEOUT_SECONDS,
                "description": "Wall-clock timeout for the command.",
            },
            "max_output_bytes": {
                "type": "integer",
                "minimum": 1024,
                "maximum": MAX_OUTPUT_BYTES,
                "default": DEFAULT_MAX_OUTPUT_BYTES,
                "description": "Maximum combined stdout/stderr bytes returned (default 262144; maximum 4194304).",
            },
            "env": {
                "type": "object",
                "additionalProperties": {"type": "string"},
                "description": "Extra environment variables for this command.",
            },
        },
        "required": ["command"],
    },
)
def handle_shell(args: dict[str, Any]) -> dict[str, Any]:
    command = args.get("command")
    if not isinstance(command, str) or not command.strip():
        return tool_result("`command` must be a non-empty string.\n", is_error=True)
    to, mo, cwd, env_map = safe_container_args(args)
    r = run_in_container(command, cwd=cwd, timeout_seconds=to, max_output_bytes=mo, extra_env=env_map)
    return result_from_run(r)


# ── Catalog Names Are The Stable Public API ───────────────────────────
# Real container commands may contain hyphens, capitals, or aliases. MCP names stay
# lowercase snake_case while catalog entries retain each exact executable name.
# Clients therefore see one stable naming convention without changing the argv
# passed to binaries whose spelling is part of their runtime contract.
# ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CliToolSpec:
    name: str
    command: str
    category: str
    description: str
    usage: str
    examples: tuple[str, ...] = ()
    aliases: tuple[str, ...] = ()
    expected_paths: tuple[str, ...] = ()
    optional: bool = False


@dataclass(frozen=True)
class LibraryToolSpec:
    name: str
    module: str
    description: str
    usage: str
    optional: bool = False


@dataclass(frozen=True)
class NucleiPlan:
    plan_id: str
    target: str
    filter_args: tuple[str, ...]
    template_count: int
    rate_limit: int
    output_path: str


NUCLEI_PLANS: dict[str, NucleiPlan] = {}
PREFLIGHT_REPORT: dict[str, Any] | None = None


def _cli(
    name: str,
    command: str,
    category: str,
    description: str,
    usage: str,
    *,
    examples: tuple[str, ...] = (),
    aliases: tuple[str, ...] = (),
    expected_paths: tuple[str, ...] = (),
    optional: bool = False,
) -> CliToolSpec:
    return CliToolSpec(
        name=name,
        command=command,
        category=category,
        description=description,
        usage=usage,
        examples=examples,
        aliases=aliases,
        expected_paths=expected_paths,
        optional=optional,
    )


CLI_TOOL_SPECS: tuple[CliToolSpec, ...] = (
    _cli("bettercap", "bettercap", "network", "Interactive network attack and monitoring framework for authorized LAN testing.", "Pass bettercap CLI flags in args, such as -eval commands or -iface interface selection.", examples=("--help", "-eval net.probe on; ticker on")),
    _cli("bloodhound", "bloodhound", "active-directory", "BloodHound GUI entrypoint for Active Directory attack path analysis.", "Pass the BloodHound CLI/GUI flags in args; in headless contexts prefer SharpHound/BloodHound data files in /workspace.", examples=("--help",)),
    _cli("certipy_ad", "certipy-ad", "active-directory", "Certipy for Active Directory Certificate Services enumeration and abuse testing.", "Pass certipy-ad subcommands and flags in args, for example find, auth, req, or relay options.", examples=("find -u user@example.local -p pass -dc-ip 10.0.0.5",), aliases=("certipy",)),
    _cli("dirb", "dirb", "web", "Classic web content scanner using wordlists.", "Pass the target URL and optional wordlist/flags in args. Content lists live in /usr/share/wordlists/cyberful-os/content/ — prefer the frequency-ordered raft-medium-directories.txt (paths) / raft-medium-files.txt (files) / api-endpoints.txt / api-objects.txt over the sparse dirb/common.txt so early hits surface first.", examples=("https://example.com /usr/share/wordlists/cyberful-os/content/raft-medium-directories.txt",)),
    _cli("dig", "dig", "dns", "DNS lookup utility from dnsutils for records, resolvers, and zone diagnostics.", "Pass standard dig arguments in args.", examples=("example.com MX +short", "@8.8.8.8 example.com TXT")),
    _cli("host", "host", "dns", "Simple DNS lookup utility for forward and reverse records.", "Pass host arguments in args.", examples=("example.com", "-t ns example.com")),
    _cli("nslookup", "nslookup", "dns", "Interactive or one-shot DNS query utility.", "Pass nslookup arguments in args.", examples=("-type=mx example.com",)),
    _cli("evil_winrm", "evil-winrm", "windows", "WinRM shell client for authorized Windows remote management and assessment.", "Pass evil-winrm connection flags in args, such as -i, -u, -p, -H, -S, and script paths.", examples=("-i 10.0.0.10 -u user -p password",)),
    _cli("feroxbuster", "feroxbuster", "web", "Fast recursive web content discovery scanner.", "Pass feroxbuster flags in args, including -u, -w, -x, -t, --timeout, --scan-dir-listings, and recursion settings. For internet targets prefer --timeout 15 or higher. Use --scan-dir-listings for directory listing checks; do not use the invalid --scan-dir-list flag. If feroxbuster reports that it could not connect to any target, the MCP result is treated as an error even when feroxbuster exits 0. Content lists live in /usr/share/wordlists/cyberful-os/content/ — prefer the frequency-ordered raft-medium-directories.txt (paths) / raft-medium-files.txt (files) / api-endpoints.txt / api-objects.txt over the sparse dirb/common.txt so early hits surface first.", examples=("-u https://example.com -w /usr/share/wordlists/cyberful-os/content/raft-medium-directories.txt --timeout 15 --scan-dir-listings",)),
    _cli("ffuf", "ffuf", "web", "Fast web fuzzer for paths, parameters, virtual hosts, and headers.", "Pass ffuf flags in args; include FUZZ where the wordlist value should be substituted. Content lists live in /usr/share/wordlists/cyberful-os/content/ — prefer the frequency-ordered raft-medium-directories.txt (paths) / raft-medium-files.txt (files) / api-endpoints.txt / api-objects.txt over the sparse dirb/common.txt so early hits surface first.", examples=("-u https://example.com/FUZZ -w /usr/share/wordlists/cyberful-os/content/raft-medium-directories.txt",)),
    _cli("gobuster", "gobuster", "web", "Web, DNS, S3, and virtual-host brute forcing tool.", "Pass gobuster mode and flags in args, such as dir, dns, vhost, s3, -u, -d, and -w. For dir mode, content lists live in /usr/share/wordlists/cyberful-os/content/ — prefer the frequency-ordered raft-medium-directories.txt (paths) / raft-medium-files.txt (files) / api-endpoints.txt / api-objects.txt over the sparse dirb/common.txt so early hits surface first.", examples=("dir -u https://example.com -w /usr/share/wordlists/cyberful-os/content/raft-medium-directories.txt",)),
    _cli("graphqlmap", "graphqlmap", "web", "Interactive GraphQL introspection, schema dumping, and injection console for testing GraphQL endpoints (swisskyrepo/GraphQLmap).", "Pass the endpoint with -u plus options like --method, --headers, and -v in args; graphqlmap then reads console commands from stdin (dump_via_introspection, dump_via_fragment, nosqli, mysqli, postgresqli, mssqli, or a raw GraphQL query; help, exit), so drive it non-interactively by supplying those command lines via stdin.", examples=("-u https://example.com/graphql -v",)),
    _cli("hashcat", "hashcat", "credentials", "GPU/CPU password hash recovery tool.", "Pass hashcat mode, attack type, hash file, and wordlist flags in args.", examples=("-m 0 -a 0 hashes.txt /usr/share/wordlists/cyberful-os/credentials/xato-1000.txt",)),
    _cli("hydra", "hydra", "credentials", "Network login brute-force tool for authorized protocol testing.", "Pass hydra flags in args, including -l/-L, -p/-P, target, and service module.", examples=("-L users.txt -P passwords.txt ssh://10.0.0.5",)),
    _cli("john", "john", "credentials", "John the Ripper password hash auditing and cracking tool.", "Pass john flags, hash files, formats, and wordlists in args.", examples=("--wordlist=/usr/share/wordlists/cyberful-os/credentials/xato-1000.txt hashes.txt",), aliases=("johnny",)),
    _cli("johnny", "johnny", "credentials", "Johnny GUI frontend for John the Ripper.", "Pass johnny arguments in args; this usually requires a graphical session.", examples=("--help",)),
    _cli("jwt_cracker", "jwt-cracker", "credentials", "JWT secret cracking helper installed from npm.", "Pass jwt-cracker token and options in args.", examples=("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9... alphabet",)),
    _cli("masscan", "masscan", "network", "High-speed Internet-scale TCP port scanner.", "Pass masscan targets, ports, rate, and adapter flags in args.", examples=("10.0.0.0/24 -p80,443 --rate=1000",)),
    _cli("msfconsole", "msfconsole", "exploitation", "Metasploit Framework console for modules, payloads, auxiliary checks, and post-exploitation workflows.", "Pass msfconsole flags in args; use -q -x for non-interactive command batches.", examples=("-q -x 'use auxiliary/scanner/http/title; set RHOSTS 10.0.0.5; run; exit'",)),
    _cli("msfvenom", "msfvenom", "exploitation", "Metasploit payload generator and encoder.", "Pass payload, format, architecture, and output flags in args.", examples=("-p linux/x64/shell_reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f elf -o payload.elf",)),
    _cli("msfdb", "msfdb", "exploitation", "Metasploit database management helper.", "Pass msfdb actions such as init, start, stop, status, or reinit in args.", examples=("status",)),
    _cli("msfd", "msfd", "exploitation", "Metasploit daemon entrypoint.", "Pass msfd flags in args for daemonized Metasploit service workflows.", examples=("--help",)),
    _cli("msfrpc", "msfrpc", "exploitation", "Metasploit RPC client helper.", "Pass msfrpc connection and command flags in args.", examples=("--help",)),
    _cli("msfrpcd", "msfrpcd", "exploitation", "Metasploit RPC daemon.", "Pass msfrpcd service flags in args.", examples=("-P password -S",)),
    _cli("msfupdate", "msfupdate", "exploitation", "Metasploit update helper provided by the framework package.", "Pass msfupdate flags in args.", examples=("--help",)),
    _cli("msf_egghunter", "msf-egghunter", "exploitation", "Metasploit egghunter shellcode helper.", "Pass helper flags in args.", examples=("--help",)),
    _cli("msf_exe2vba", "msf-exe2vba", "exploitation", "Metasploit helper that converts executables to VBA payload form.", "Pass input and output paths in args.", examples=("--help",)),
    _cli("msf_exe2vbs", "msf-exe2vbs", "exploitation", "Metasploit helper that converts executables to VBS payload form.", "Pass input and output paths in args.", examples=("--help",)),
    _cli("msf_find_badchars", "msf-find_badchars", "exploitation", "Metasploit helper for bad-character analysis.", "Pass payload bytes/options in args.", examples=("--help",)),
    _cli("msf_halflm_second", "msf-halflm_second", "credentials", "Metasploit helper for legacy HalfLM cracking workflows.", "Pass helper flags in args.", examples=("--help",)),
    _cli("msf_hmac_sha1_crack", "msf-hmac_sha1_crack", "credentials", "Metasploit helper for HMAC-SHA1 cracking workflows.", "Pass hash material and options in args.", examples=("--help",)),
    _cli("msf_java_deserializer", "msf-java_deserializer", "exploitation", "Metasploit Java deserialization helper.", "Pass serialized payload helper flags in args.", examples=("--help",)),
    _cli("msf_jsobfu", "msf-jsobfu", "exploitation", "Metasploit JavaScript obfuscation helper.", "Pass JavaScript input/options in args.", examples=("--help",)),
    _cli("msf_makeiplist", "msf-makeiplist", "network", "Metasploit helper for expanding and normalizing IP target lists.", "Pass IP ranges or files in args.", examples=("--help",)),
    _cli("msf_md5_lookup", "msf-md5_lookup", "credentials", "Metasploit helper for MD5 hash lookup workflows.", "Pass MD5 values/options in args.", examples=("--help",)),
    _cli("msf_metasm_shell", "msf-metasm_shell", "exploitation", "Metasploit Metasm shell helper.", "Pass helper options in args.", examples=("--help",)),
    _cli("msf_msf_irb_shell", "msf-msf_irb_shell", "exploitation", "Metasploit IRB shell helper.", "Pass helper options in args.", examples=("--help",)),
    _cli("msf_nasm_shell", "msf-nasm_shell", "exploitation", "Metasploit NASM shell helper.", "Pass assembly snippets/options in args.", examples=("--help",)),
    _cli("msf_pattern_create", "msf-pattern_create", "exploitation", "Metasploit cyclic pattern generator.", "Pass -l length and related flags in args.", examples=("-l 512",)),
    _cli("msf_pattern_offset", "msf-pattern_offset", "exploitation", "Metasploit cyclic pattern offset finder.", "Pass -q query and related flags in args.", examples=("-q 39654138",)),
    _cli("msf_pdf2xdp", "msf-pdf2xdp", "exploitation", "Metasploit PDF to XDP helper.", "Pass input/output paths in args.", examples=("--help",)),
    _cli("msf_virustotal", "msf-virustotal", "malware-analysis", "Metasploit VirusTotal lookup helper; requires an API key where applicable.", "Pass file/hash/API flags in args.", examples=("--help",)),
    _cli("nikto", "nikto", "web", "Web server vulnerability and misconfiguration scanner.", "Pass nikto flags in args, such as -h, -p, -Tuning, and output options.", examples=("-h https://example.com",)),
    _cli("nmap", "nmap", "network", "Network scanner for host discovery, port scanning, service detection, OS fingerprinting, and NSE scripts.", "Pass nmap flags and targets in args. For polite rate limiting use --max-rate <N> or --max-rate=<N>; do not use non-Nmap flags such as --rate-rate.", examples=("-sV -sC --max-rate 10 -p 22,80,443 10.0.0.5",)),
    _cli("impacket_netview", "impacket-netview", "windows", "Impacket netview helper for enumerating Windows domain hosts and shares.", "Pass impacket-netview target and authentication flags in args.", examples=("--help",)),
    _cli("impacket_rpcdump", "impacket-rpcdump", "windows", "Impacket RPC endpoint mapper dumping utility.", "Pass target binding and authentication flags in args.", examples=("ncacn_ip_tcp:10.0.0.5",)),
    _cli("impacket_samrdump", "impacket-samrdump", "windows", "Impacket SAMR enumeration utility for Windows account and group data.", "Pass target and authentication flags in args.", examples=("domain/user:pass@10.0.0.5",)),
    _cli("impacket_secretsdump", "impacket-secretsdump", "windows", "Impacket credential extraction utility for authorized Windows assessments.", "Pass target and authentication flags in args.", examples=("domain/user:pass@10.0.0.5",)),
    _cli("impacket_wmiexec", "impacket-wmiexec", "windows", "Impacket WMI remote command execution utility for authorized Windows administration/testing.", "Pass target and authentication flags in args.", examples=("domain/user:pass@10.0.0.5",)),
    _cli("responder", "responder", "network", "LLMNR/NBT-NS/mDNS poisoner and credential capture tool for authorized internal testing.", "Pass Responder interface and protocol flags in args.", examples=("-I eth0 -A",)),
    _cli("snmpwalk", "snmpwalk", "snmp", "Walk SNMP OIDs from a target agent.", "Pass SNMP version, community/auth, target, and OID args.", examples=("-v2c -c public 10.0.0.5 1.3.6.1.2.1",)),
    _cli("snmpget", "snmpget", "snmp", "Fetch specific SNMP OID values.", "Pass SNMP version, community/auth, target, and OID args.", examples=("-v2c -c public 10.0.0.5 sysDescr.0",)),
    _cli("snmpbulkget", "snmpbulkget", "snmp", "SNMP GETBULK query utility.", "Pass SNMP version, auth, target, and OID args.", examples=("-v2c -c public 10.0.0.5 1.3.6.1.2.1",)),
    _cli("snmpbulkwalk", "snmpbulkwalk", "snmp", "SNMP GETBULK tree walking utility.", "Pass SNMP version, auth, target, and OID args.", examples=("-v2c -c public 10.0.0.5 1.3.6.1.2.1",)),
    _cli("snmpgetnext", "snmpgetnext", "snmp", "Fetch the next SNMP OID after the requested object.", "Pass SNMP version, auth, target, and OID args.", examples=("-v2c -c public 10.0.0.5 sysDescr",)),
    _cli("snmpset", "snmpset", "snmp", "Set writable SNMP OID values where authorized.", "Pass SNMP auth, target, OID, type, and value args.", examples=("-v2c -c private 10.0.0.5 oid s value",)),
    _cli("snmpstatus", "snmpstatus", "snmp", "Summarize SNMP agent status.", "Pass SNMP version, auth, and target args.", examples=("-v2c -c public 10.0.0.5",)),
    _cli("snmptable", "snmptable", "snmp", "Render SNMP table data.", "Pass SNMP auth, target, and table OID args.", examples=("-v2c -c public 10.0.0.5 ifTable",)),
    _cli("snmptranslate", "snmptranslate", "snmp", "Translate SNMP OIDs and MIB names.", "Pass OID/MIB translation flags in args.", examples=("-On SNMPv2-MIB::sysDescr.0",)),
    _cli("snmptrap", "snmptrap", "snmp", "Send SNMP traps for authorized testing.", "Pass destination, auth, OID, and varbind args.", examples=("--help",)),
    _cli("snmpcheck", "snmpcheck", "snmp", "SNMP enumeration helper for common device information.", "Pass target and community flags in args.", examples=("-t 10.0.0.5 -c public",)),
    _cli("snmpconf", "snmpconf", "snmp", "SNMP configuration helper.", "Pass snmpconf flags in args.", examples=("--help",)),
    _cli("snmpdf", "snmpdf", "snmp", "Show disk space via SNMP HOST-RESOURCES-MIB.", "Pass SNMP auth and target args.", examples=("-v2c -c public 10.0.0.5",)),
    _cli("snmpdelta", "snmpdelta", "snmp", "Monitor SNMP integer counters over time.", "Pass SNMP auth, target, and OID args.", examples=("--help",)),
    _cli("snmpinform", "snmpinform", "snmp", "Send SNMP inform notifications.", "Pass destination, auth, OID, and varbind args.", examples=("--help",)),
    _cli("snmpnetstat", "snmpnetstat", "snmp", "Query network statistics via SNMP.", "Pass SNMP auth and target args.", examples=("-v2c -c public 10.0.0.5",)),
    _cli("snmpping", "snmpping", "snmp", "SNMP ping utility.", "Pass SNMP auth and target args.", examples=("--help",)),
    _cli("snmpps", "snmpps", "snmp", "Show process information via SNMP HOST-RESOURCES-MIB.", "Pass SNMP auth and target args.", examples=("-v2c -c public 10.0.0.5",)),
    _cli("snmptest", "snmptest", "snmp", "Interactive SNMP test utility.", "Pass SNMP auth and target args.", examples=("--help",)),
    _cli("snmptls", "snmptls", "snmp", "SNMP TLS/DTLS helper.", "Pass snmptls flags in args.", examples=("--help",)),
    _cli("snmpusm", "snmpusm", "snmp", "SNMPv3 user-based security model management utility.", "Pass SNMPv3 management flags in args.", examples=("--help",)),
    _cli("snmpvacm", "snmpvacm", "snmp", "SNMP view-based access control management utility.", "Pass VACM management flags in args.", examples=("--help",)),
    _cli("sqlmap", "sqlmap", "web", "SQL injection detection and exploitation framework.", "Pass sqlmap flags in args, such as -u, --data, --batch, --risk, and --level.", examples=("-u https://example.com/item?id=1 --batch",)),
    _cli("searchsploit", "searchsploit", "exploitation", "Offline Exploit-DB search client for finding public exploits and shellcode by product, version, or CVE.", "Pass search terms and searchsploit flags in args, such as -t (title), --cve, -w (web links), -x (examine), -m (mirror/copy), and --nmap. The bundled database at /usr/share/exploitdb works offline; a -u refresh is opt-in.", examples=("apache 2.4.49", "--cve 2021-41773", "-t joomla -w")),
    _cli("tcpdump", "tcpdump", "network", "Packet capture and traffic inspection utility.", "Pass tcpdump interface, filter, and write/read flags in args.", examples=("-i eth0 -nn host 10.0.0.5",)),
    _cli("traceroute", "traceroute", "network", "Network route discovery utility.", "Pass traceroute flags and target in args.", examples=("example.com",)),
    _cli("tshark", "tshark", "network", "Terminal Wireshark packet capture and protocol analysis.", "Pass tshark capture/read/filter/export flags in args.", examples=("-r capture.pcap -Y http",)),
    _cli("wfuzz", "wfuzz", "web", "Web application fuzzer for paths, params, headers, and payload positions.", "Pass wfuzz flags in args with FUZZ placeholders. Content lists live in /usr/share/wordlists/cyberful-os/content/ — prefer the frequency-ordered raft-medium-directories.txt (paths) / raft-medium-files.txt (files) / api-endpoints.txt / api-objects.txt over the sparse dirb/common.txt so early hits surface first.", examples=("-w /usr/share/wordlists/cyberful-os/content/raft-medium-directories.txt https://example.com/FUZZ",)),
    _cli("whatweb", "whatweb", "web", "Web technology fingerprinting scanner.", "Pass targets and whatweb flags in args. Results print as brief per-target lines on STDOUT by default. Do NOT pass --quiet/-q: it suppresses that logging, so a successful scan returns nothing. Use --color never for clean text, or --log-json=/dev/stdout for machine-readable JSON.", examples=("https://example.com", "--color never --log-json=/dev/stdout https://example.com")),
    _cli("whois", "whois", "osint", "WHOIS lookup client for domain and IP registration records.", "Pass query target and whois flags in args.", examples=("example.com",)),
    _cli("cewl", "cewl", "osint", "Custom wordlist generator from website content.", "Pass target URL, crawl depth, output, and auth flags in args.", examples=("-d 2 -w words.txt https://example.com",)),
    _cli("cloud_enum", "cloud_enum", "cloud", "Cloud asset enumeration tool for public S3, Azure, and GCP naming patterns.", "Pass cloud_enum flags in args, such as -k keyword and provider options.", examples=("-k example",), aliases=("cloud-enum",)),
    _cli("crunch", "crunch", "credentials", "Password wordlist generator.", "Pass min/max length, charset, pattern, and output flags in args.", examples=("8 10 abc123 -o words.txt",)),
    _cli("exiftool", "exiftool", "osint", "Metadata extraction and editing utility for files and media.", "Pass file paths and exiftool flags in args.", examples=("image.jpg", "-json document.pdf")),
    _cli("patator", "patator", "credentials", "Multi-protocol brute-force and fuzzing framework for authorized testing.", "Pass patator module and key=value options in args.", examples=("ssh_login host=10.0.0.5 user=FILE0 0=users.txt password=FILE1 1=pass.txt",)),
    _cli("proxychains4", "proxychains4", "privacy", "Run commands through proxychains for proxy/Tor-routed testing.", "Pass the command to run and its args after proxychains4 flags.", examples=("curl https://check.torproject.org",)),
    _cli("recon_ng", "recon-ng", "osint", "Recon-ng OSINT framework console.", "Pass recon-ng workspace, module, and command flags in args.", examples=("--help",)),
    _cli("s3scanner", "s3scanner", "cloud", "S3 bucket enumeration and permissions scanner.", "Pass bucket names, wordlists, and scan flags in args.", examples=("--bucket example-bucket",)),
    _cli("the_harvester", "theHarvester", "osint", "Email, subdomain, host, and people OSINT collector.", "Pass theHarvester flags in args, such as -d domain, -b source, and -l limit.", examples=("-d example.com -b all -l 100",), aliases=("theharvester",)),
    _cli("tor", "tor", "privacy", "Tor daemon for onion routing and anonymized OSINT workflows.", "Pass tor daemon flags in args; cyberful-os also provides tor_run for the bundled torrc.", examples=("--version",)),
    _cli("tor_run", "tor-run", "privacy", "cyberful-os helper that starts Tor with the bundled /etc/tor/torrc.", "Pass extra tor flags in args.", examples=("--RunAsDaemon 0",)),
    _cli("h8mail", "h8mail", "osint", "Email OSINT and breach reconnaissance tool.", "Pass h8mail target and source flags in args.", examples=("-t user@example.com",)),
    _cli("holehe", "holehe", "osint", "Check whether an email is registered across common websites.", "Pass email and holehe flags in args.", examples=("user@example.com",)),
    _cli("maigret", "maigret", "osint", "Username search across public sites.", "Pass usernames and maigret flags in args.", examples=("someusername --timeout 30",)),
    _cli("socialscan", "socialscan", "osint", "Email and username availability checks across platforms.", "Pass socialscan targets and flags in args.", examples=("user@example.com someusername",)),
    _cli("sherlock", "sherlock", "osint", "Username OSINT across social networks.", "Pass usernames and sherlock flags in args.", examples=("someusername --timeout 30",)),
    _cli("androguard", "androguard", "mobile", "Android APK and DEX analysis toolkit.", "Pass androguard subcommands and target files in args.", examples=("--help",)),
    _cli("apktool", "apktool", "mobile", "APK reverse engineering tool for decoding and rebuilding Android apps.", "Pass apktool commands such as d, b, if and file paths in args.", examples=("d app.apk -o app_decoded",)),
    _cli("ghidra", "ghidra", "reversing", "Ghidra launcher provided by the system package.", "Pass Ghidra launcher flags in args; graphical use needs a display.", examples=("--help",)),
    _cli("ghidra_run", "ghidraRun", "reversing", "Ghidra GUI launcher symlinked by cyberful-os.", "Pass Ghidra GUI flags in args; graphical use needs a display.", examples=("--help",), aliases=("ghidraRun",)),
    _cli("analyze_headless", "analyzeHeadless", "reversing", "Ghidra headless analyzer for batch reverse engineering.", "Pass project path/name, import path, script, processor, and analysis flags in args.", examples=("/workspace/ghidra_proj proj -import sample.bin -analysisTimeoutPerFile 60",), aliases=("analyzeHeadless",)),
    _cli("jadx", "jadx", "mobile", "Dex to Java decompiler for APK/DEX/JAR files.", "Pass jadx flags and input files in args.", examples=("-d out app.apk",)),
    _cli("jadx_gui", "jadx-gui", "mobile", "JADX graphical decompiler launcher.", "Pass jadx-gui flags and files in args; graphical use needs a display.", examples=("app.apk",)),
    _cli("radare2", "radare2", "reversing", "Radare2 reverse engineering framework entrypoint.", "Pass radare2 flags and target files in args.", examples=("-A sample.bin",), aliases=("r2",)),
    _cli("r2", "r2", "reversing", "Short radare2 entrypoint.", "Pass r2 flags and target files in args.", examples=("-A sample.bin",)),
    _cli("r2agent", "r2agent", "reversing", "Radare2 agent service helper.", "Pass r2agent flags in args.", examples=("--help",)),
    _cli("r2pm", "r2pm", "reversing", "Radare2 package manager.", "Pass r2pm commands in args.", examples=("-l",)),
    _cli("r2r", "r2r", "reversing", "Radare2 regression test runner/helper.", "Pass r2r flags in args.", examples=("--help",)),
    _cli("r2sdb", "r2sdb", "reversing", "Radare2 sdb database helper.", "Pass r2sdb flags and database paths in args.", examples=("--help",)),
    _cli("rabin2", "rabin2", "reversing", "Binary metadata, imports, symbols, strings, and section inspection from radare2.", "Pass rabin2 flags and binary paths in args.", examples=("-I sample.bin", "-zz sample.bin")),
    _cli("radiff2", "radiff2", "reversing", "Binary diffing utility from radare2.", "Pass radiff2 flags and file paths in args.", examples=("old.bin new.bin",)),
    _cli("rafind2", "rafind2", "reversing", "Binary pattern search utility from radare2.", "Pass search pattern and file args.", examples=("-s password sample.bin",)),
    _cli("ragg2", "ragg2", "reversing", "Radare2 shellcode and binary generation helper.", "Pass ragg2 flags in args.", examples=("--help",)),
    _cli("rahash2", "rahash2", "reversing", "Hashing and entropy utility from radare2.", "Pass rahash2 flags and file paths in args.", examples=("-a sha256 sample.bin",)),
    _cli("rapatch2", "rapatch2", "reversing", "Binary patch application helper from radare2.", "Pass patch script and file args.", examples=("--help",)),
    _cli("rarun2", "rarun2", "reversing", "Runtime profile runner for radare2 debugging workflows.", "Pass rarun2 profile flags/files in args.", examples=("--help",)),
    _cli("rasign2", "rasign2", "reversing", "Radare2 signature generation and management helper.", "Pass signature flags and files in args.", examples=("--help",)),
    _cli("rasm2", "rasm2", "reversing", "Assembler/disassembler helper from radare2.", "Pass architecture, bits, and code bytes/text in args.", examples=("-a x86 -b 64 'nop; ret'",)),
    _cli("ravc2", "ravc2", "reversing", "Radare2 version-control style helper.", "Pass ravc2 flags in args.", examples=("--help",)),
    _cli("rax2", "rax2", "reversing", "Radare2 base conversion and numeric helper.", "Pass numbers, encodings, or conversion flags in args.", examples=("0x41414141", "-s 414243")),
    _cli("frida", "frida", "mobile", "Frida dynamic instrumentation CLI.", "Pass Frida target, device, script, and runtime flags in args.", examples=("-U -f com.example.app -l script.js",)),
    _cli("frida_apk", "frida-apk", "mobile", "Frida APK patching/helper command from frida-tools.", "Pass APK and frida-apk flags in args.", examples=("--help",)),
    _cli("frida_compile", "frida-compile", "mobile", "Compile Frida JavaScript agents.", "Pass input script and output flags in args.", examples=("agent.js -o agent.bundle.js",)),
    _cli("frida_create", "frida-create", "mobile", "Create Frida project templates.", "Pass project/template flags in args.", examples=("--help",)),
    _cli("frida_discover", "frida-discover", "mobile", "Discover functions and APIs with Frida.", "Pass Frida target/device flags in args.", examples=("-U -n target",)),
    _cli("frida_itrace", "frida-itrace", "mobile", "Trace low-level instructions with Frida.", "Pass Frida target and trace flags in args.", examples=("--help",)),
    _cli("frida_join", "frida-join", "mobile", "Join Frida portal sessions.", "Pass frida-join flags in args.", examples=("--help",)),
    _cli("frida_kill", "frida-kill", "mobile", "Kill processes through Frida device/session selection.", "Pass device and process args.", examples=("-U target",)),
    _cli("frida_ls", "frida-ls", "mobile", "List files through Frida device filesystem access.", "Pass device and path args.", examples=("-U /",)),
    _cli("frida_ls_devices", "frida-ls-devices", "mobile", "List devices visible to Frida.", "Pass frida-ls-devices flags in args.", examples=("--help",)),
    _cli("frida_pm", "frida-pm", "mobile", "Frida package manager/helper.", "Pass frida-pm commands in args.", examples=("--help",)),
    _cli("frida_ps", "frida-ps", "mobile", "List processes on local, USB, or remote Frida devices.", "Pass Frida device flags in args.", examples=("-Uai",)),
    _cli("frida_pull", "frida-pull", "mobile", "Pull files from a Frida-connected device.", "Pass device, remote path, and local path args.", examples=("-U /data/local/tmp/file ./file",)),
    _cli("frida_push", "frida-push", "mobile", "Push files to a Frida-connected device.", "Pass device, local path, and remote path args.", examples=("-U ./file /data/local/tmp/file",)),
    _cli("frida_rm", "frida-rm", "mobile", "Remove files on a Frida-connected device.", "Pass device and remote path args.", examples=("-U /data/local/tmp/file",)),
    _cli("frida_strace", "frida-strace", "mobile", "Trace system calls with Frida.", "Pass Frida target/device flags in args.", examples=("-U -n target",)),
    _cli("frida_trace", "frida-trace", "mobile", "Trace functions and APIs with Frida.", "Pass Frida target and include/exclude flags in args.", examples=("-U -f com.example.app -j 'java.io*!*'",)),
    _cli("drozer", "drozer", "mobile", "Android security assessment framework console/client.", "Pass drozer subcommands and connection flags in args.", examples=("console connect",)),
    _cli("drozer_complete", "drozer-complete", "mobile", "Drozer shell completion helper.", "Pass drozer-complete flags in args.", examples=("--help",)),
    _cli("drozer_repository", "drozer-repository", "mobile", "Drozer module repository helper.", "Pass drozer-repository commands in args.", examples=("--help",)),
    _cli("mobsf", "mobsf", "mobile", "MobSF mobile security framework entrypoint.", "Pass MobSF server or management flags in args.", examples=("--help",)),
    _cli("objection", "objection", "mobile", "Runtime mobile exploration toolkit built on Frida.", "Pass objection target and command flags in args.", examples=("-g com.example.app explore",)),
    _cli("trivy", "trivy", "supply-chain", "Vulnerability, secret, misconfiguration, filesystem, image, and SBOM scanner.", "Pass trivy subcommands and flags in args, such as fs, image, config, --scanners, and --format.", examples=("fs --scanners vuln,secret --format table /workspace",)),
    _cli("retire", "retire", "supply-chain", "Retire.js scanner for vulnerable JavaScript libraries and Node dependencies.", "Pass retire flags in args, such as --path, --outputformat, --severity, and --exitwith.", examples=("--path /workspace --outputformat jsonsimple --exitwith 0",)),
    _cli("semgrep", "semgrep", "static-analysis", "Semgrep structural and dataflow-aware static analysis for source, custom rules, framework sinks, and audit triage.", "Pass Semgrep subcommands and flags in args. Prefer local pinned rule directories or files, include --metrics=off, emit SARIF or JSON into /workspace, and record excluded/generated paths so coverage is reproducible.", examples=("scan --config /workspace/rules --metrics=off --sarif --output /workspace/semgrep.sarif /workspace/src",)),
    _cli("syft", "syft", "supply-chain", "Syft SBOM generator for directories, archives, filesystems, and container images.", "Pass a source with an explicit scheme when ambiguity matters, then choose one or more output formats. Persist CycloneDX JSON or SPDX JSON under /workspace for correlation with lockfiles and scanner results.", examples=("scan dir:/workspace -o cyclonedx-json=/workspace/sbom.cdx.json",)),
    _cli("grype", "grype", "supply-chain", "Grype vulnerability matcher for SBOMs, directories, filesystems, archives, and container images.", "Pass an explicit source such as sbom:/workspace/sbom.cdx.json or dir:/workspace. Choose JSON or CycloneDX output, preserve the vulnerability DB status/age, and use --only-fixed or severity filters only after retaining the unfiltered evidence set.", examples=("sbom:/workspace/sbom.cdx.json --output json --file /workspace/grype.json",)),
    _cli("gitleaks", "gitleaks", "supply-chain", "Gitleaks secret discovery across Git history, working trees, directories, and stdin.", "Pass the current gitleaks subcommand (git, dir, or stdin), source path, config/baseline flags, and a machine-readable report path. Scan history and present files separately because their remediation and exposure windows differ.", examples=("git /workspace --report-format sarif --report-path /workspace/gitleaks-history.sarif --no-banner", "dir /workspace --report-format json --report-path /workspace/gitleaks-tree.json --no-banner")),
    _cli("cloudsplaining", "cloudsplaining", "cloud", "AWS IAM policy analysis for privilege escalation, data exposure, infrastructure modification, and resource-constraint gaps.", "Pass cloudsplaining subcommands and flags in args. Analyze exported account authorization details or individual policy documents, retain the raw input snapshot, and write HTML/JSON findings into /workspace.", examples=("scan --input-file /workspace/account-authorization-details.json --output /workspace/cloudsplaining", "scan-policy-file --input-file /workspace/policy.json")),
    _cli("prowler", "prowler", "cloud", "Prowler multi-provider cloud, Kubernetes, SaaS, and compliance posture assessment CLI.", "Pass the provider first, then scope by account/subscription/project, region, service, check, category, or compliance framework. Use explicit output modes and directory; broad provider-wide scans should follow a credential and scope inventory so absences are distinguishable from denied visibility.", examples=("aws --services iam s3 --output-modes json-ocsf csv --output-directory /workspace/prowler", "kubernetes --list-checks")),
    _cli("kubectl", "kubectl", "kubernetes", "Pinned Kubernetes client for API discovery, RBAC review, workload inspection, and bounded cluster evidence collection.", "Pass --kubeconfig and --context explicitly when more than one context may exist. Prefer structured -o json/yaml output and server-side discovery; kubectl is within one minor of supported v1.36 clusters and older/newer clusters may require a matching client.", examples=("--kubeconfig /workspace/kubeconfig auth can-i --list", "--kubeconfig /workspace/kubeconfig get pods -A -o json")),
    _cli("kube_bench", "kube-bench", "kubernetes", "kube-bench CIS Kubernetes benchmark evaluator with the upstream configuration corpus bundled under /opt/kube-bench/cfg.", "Pass run, benchmark/target, config directory, and JSON output flags. Direct node checks require the relevant host configuration and process/filesystem views to be mounted; otherwise use the tool against collected artifacts or run its job form in the cluster.", examples=("run --benchmark cis-1.24 --config-dir /opt/kube-bench/cfg --json",), aliases=("kube-bench",), expected_paths=("/usr/local/bin/kube-bench", "/opt/kube-bench/kube-bench")),
    _cli("jazzer", "jazzer", "fuzzing", "Coverage-guided JVM fuzzer for Java and other JVM languages with sanitizers, hooks, reproducer generation, and libFuzzer-compatible controls.", "Pass target class, classpath, corpus, instrumentation filters, sanitizer/hook options, and libFuzzer flags in args. Put corpora, crash artifacts, and exact classpaths under /workspace so crashes can be replayed deterministically.", examples=("--cp=/workspace/build/classes --target_class=com.example.ParserFuzzer /workspace/corpus -artifact_prefix=/workspace/crashes/",), expected_paths=("/usr/local/bin/jazzer", "/opt/jazzer/jazzer")),
    _cli("afl_fuzz", "afl-fuzz", "fuzzing", "AFL++ coverage-guided fuzzing engine for instrumented native targets and supported binary-only modes.", "Pass input/output directories, resource bounds, mode flags, and the target after --. Use one seed corpus per input grammar, preserve crashes/hangs/queue plus compiler command, and reproduce findings outside the fuzzer before classification.", examples=("-i /workspace/corpus -o /workspace/afl-out -m none -- /workspace/target @@",), aliases=("afl-fuzz",)),
    _cli("afl_clang_fast", "afl-clang-fast", "fuzzing", "AFL++ LLVM compiler wrapper for coverage-instrumented C targets.", "Pass normal clang compile/link arguments. Add sanitizers and hardening deliberately, keep the exact build command, and compile the harness plus target code into a dedicated fuzz binary under /workspace.", examples=("-O1 -g -fsanitize=address,undefined /workspace/harness.c /workspace/parser.c -o /workspace/target",), aliases=("afl-clang-fast",)),
    _cli("afl_clang_fastxx", "afl-clang-fast++", "fuzzing", "AFL++ LLVM compiler wrapper for coverage-instrumented C++ targets.", "Pass normal clang++ compile/link arguments, harness sources, sanitizer flags, and output path. Keep exception/RTTI settings aligned with the production parser unless the campaign is explicitly differential.", examples=("-O1 -g -fsanitize=address,undefined /workspace/harness.cc /workspace/parser.cc -o /workspace/target",), aliases=("afl-clang-fast++",)),
    _cli("afl_cmin", "afl-cmin", "fuzzing", "AFL++ corpus minimizer that retains coverage-distinct test cases.", "Pass input/output corpus paths and the target after --. Minimize only with the same binary, instrumentation, environment, and timeout intended for the campaign or coverage equivalence will be misleading.", examples=("-i /workspace/corpus-raw -o /workspace/corpus-min -- /workspace/target @@",), aliases=("afl-cmin",)),
    _cli("clang", "clang", "fuzzing", "Clang C compiler for sanitizer-enabled harnesses, libFuzzer targets, and native audit reproductions.", "Pass normal clang arguments. For libFuzzer, compile and link the harness with -fsanitize=fuzzer plus the selected bug sanitizers; use -fsanitize=fuzzer-no-link for library objects that should not pull in the driver.", examples=("-O1 -g -fsanitize=fuzzer,address,undefined /workspace/fuzz_target.c /workspace/parser.c -o /workspace/fuzz_target",)),
    _cli("clangxx", "clang++", "fuzzing", "Clang C++ compiler for sanitizer-enabled harnesses, libFuzzer targets, and native audit reproductions.", "Pass normal clang++ arguments. For libFuzzer, compile and link LLVMFuzzerTestOneInput with -fsanitize=fuzzer,address,undefined and preserve the exact compiler/runtime versions with every crash artifact.", examples=("-O1 -g -fsanitize=fuzzer,address,undefined /workspace/fuzz_target.cc /workspace/parser.cc -o /workspace/fuzz_target",), aliases=("clang++",)),
    _cli("libfuzzer_clang", "clang", "fuzzing", "Explicit C libFuzzer build entrypoint backed by Clang and the bundled compiler-rt runtime.", "Pass compile/link arguments including -fsanitize=fuzzer or -fsanitize=fuzzer-no-link. This tool names the libFuzzer workflow directly while retaining argv-only execution; it does not inject flags or hide the build recipe.", examples=("-O1 -g -fsanitize=fuzzer,address /workspace/fuzz_target.c -o /workspace/fuzz_target",)),
    _cli("libfuzzer_clangxx", "clang++", "fuzzing", "Explicit C++ libFuzzer build entrypoint backed by Clang++ and the bundled compiler-rt runtime.", "Pass compile/link arguments including -fsanitize=fuzzer and selected bug sanitizers. The resulting binary accepts libFuzzer corpus, artifact_prefix, timeout, rss_limit_mb, jobs, and workers flags directly.", examples=("-O1 -g -fsanitize=fuzzer,address,undefined /workspace/fuzz_target.cc -o /workspace/fuzz_target",), aliases=("libfuzzer-clang++",)),
    _cli("jeb", "jeb", "reversing", "Optional JEB reverse engineering suite entrypoint when installed in private builds.", "Pass JEB CLI flags in args; this tool is optional and appears missing unless JEB_INSTALLER_URL was used at image build time.", examples=("--help",), optional=True),
    _cli("testssl", "testssl", "tls", "TLS/SSL protocol, cipher suite, certificate, and configuration scanner (testssl.sh; the system package installs the binary as `testssl`). Report deprecated protocols (TLS 1.0/1.1) as a protocol-support problem, not a key-length one.", "The target (host, host:port, or https URL) MUST be the LAST argument; put all flags BEFORE it (testssl aborts with 'URI comes last' otherwise). Use --quiet --color 0 for clean machine-readable output.", examples=("https://example.com", "--quiet --color 0 --severity LOW example.com:443", "-p -S example.com:443"), expected_paths=("/usr/bin/testssl",)),
    _cli("sslscan", "sslscan", "tls", "TLS/SSL cipher suite and protocol version enumeration scanner.", "Pass the target host:port and sslscan flags in args.", examples=("example.com:443", "--no-failed example.com"), expected_paths=("/usr/bin/sslscan",)),
    _cli("nuclei", "nuclei", "web", "Raw ProjectDiscovery Nuclei CLI for expert cases not expressible through the preferred nuclei_plan + nuclei_run_scoped flow. The signed template corpus is pre-installed, so do not pass -t. Always disable update checks and OAST, hold the engagement-wide rate at or below 5 requests/second, serialize concurrency, attach the required program marker, and filter to detected technology or a concrete candidate. Preview with nuclei_templates before any raw run. Unfiltered scans are refused by policy even though this low-level wrapper remains available. Treat every hit as SUSPECTED.", "Prefer nuclei_plan followed by nuclei_run_scoped. Use this raw wrapper only when the controlled runner cannot express a justified filter; include -disable-update-check -no-interactsh -rate-limit 5 -c 1 -bulk-size 1, X-Request-ID: Bugcrowd, and explicit -tags/-id/-severity. Never run unfiltered or add intrusive/OAST templates.", examples=("-u https://example.com -id CVE-2021-3129 -disable-update-check -no-interactsh -rate-limit 5 -c 1 -bulk-size 1 -H 'X-Request-ID: Bugcrowd'",), expected_paths=("/usr/bin/nuclei", "/usr/local/bin/nuclei")),
    _cli("httpx", "httpx-pd", "web", "Fast HTTP probing, fingerprinting, and technology/title/status detection (ProjectDiscovery httpx). Telemetry-hardened: ALWAYS pass -duc (disable update check). httpx has NO per-header flags (there is no -csp, -hsts, etc.) — to inspect security headers/cookies (CSP, HSTS, Set-Cookie...) use -json with -include-response-header (-irh) and read the headers from the JSON, or use the `requests` tool. Common valid flags: -title, -tech-detect, -status-code, -web-server, -location, -json, -irh.", "Pass targets and httpx flags in args; always include -duc. For header inspection use -json -irh, not invented per-header flags.", examples=("-u https://example.com -duc -title -tech-detect -status-code -web-server", "-u https://example.com -duc -json -irh", "-l hosts.txt -duc -json"), expected_paths=("/usr/local/bin/httpx-pd",), aliases=("httpx-toolkit",)),
    _cli("subfinder", "subfinder", "dns", "Passive subdomain enumeration from public sources (ProjectDiscovery). Telemetry-hardened: ALWAYS pass -duc (disable update check).", "Pass -d <domain> and subfinder flags in args; always include -duc.", examples=("-d example.com -duc", "-d example.com -all -duc"), expected_paths=("/usr/bin/subfinder", "/usr/local/bin/subfinder")),
)


LIBRARY_TOOL_SPECS: tuple[LibraryToolSpec, ...] = (
    LibraryToolSpec("requests", "requests", "HTTP client capability backed by Python requests inside the cyberful-os container.", "Fetch an HTTP(S) URL with method, headers, params, body, TLS, redirect, and timeout options."),
    LibraryToolSpec("bs4", "bs4", "HTML parsing and CSS selector extraction backed by Beautiful Soup inside the cyberful-os container.", "Extract text, attributes, or HTML fragments from inline HTML or a file in /workspace."),
    LibraryToolSpec("lxml", "lxml", "HTML/XML parsing and XPath extraction backed by lxml inside the cyberful-os container.", "Evaluate XPath against inline content or a file in /workspace."),
)


def _validate_lowercase_tool_name(name: str) -> None:
    allowed = set("abcdefghijklmnopqrstuvwxyz0123456789_")
    if name != name.lower() or not name or any(ch not in allowed for ch in name):
        raise ValueError(f"invalid lowercase MCP tool name: {name}")


def _validate_catalog() -> None:
    names: set[str] = set()
    for spec in CLI_TOOL_SPECS:
        _validate_lowercase_tool_name(spec.name)
        if spec.name in names:
            raise ValueError(f"duplicate MCP tool name: {spec.name}")
        names.add(spec.name)
    for spec in LIBRARY_TOOL_SPECS:
        _validate_lowercase_tool_name(spec.name)
        if spec.name in names:
            raise ValueError(f"duplicate MCP tool name: {spec.name}")
        names.add(spec.name)
    for reserved in (
        "capability_attestation",
        "nuclei_plan",
        "nuclei_run_scoped",
        "nuclei_templates",
        "tool_inventory",
        "wordlists",
        "shell",
    ):
        if reserved in names:
            raise ValueError(f"reserved MCP tool name collides with catalog: {reserved}")


def _example_args_json(example: str) -> str:
    try:
        parts = shlex.split(example)
    except ValueError:
        parts = [example]
    return json.dumps({"args": parts}, ensure_ascii=False)


def _cli_tool_description(spec: CliToolSpec) -> str:
    examples = (
        "; example tool calls: " + " | ".join(f"`{_example_args_json(example)}`" for example in spec.examples)
        if spec.examples
        else ""
    )
    aliases = f" Aliases/related commands: {', '.join(spec.aliases)}." if spec.aliases else ""
    optional = " Optional tool: returns a clear error if the binary is not installed." if spec.optional else ""
    return (
        f"{spec.description} Category: {spec.category}. Runs `{spec.command}` inside the cyberful-os container. "
        f"{spec.usage} `args` MUST be a JSON array of strings, without the command name. "
        f"Never pass `args` as a shell string, raw CLI text, or an unquoted command line.{examples}.{aliases}{optional}"
    )


def _cli_tool_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "args": {
                "type": "array",
                "items": {"type": "string"},
                "default": [],
                "description": "CLI arguments passed to the binary, excluding the command name. Must be a JSON array of strings, e.g. [\"-sV\", \"--max-rate\", \"10\", \"target.example\"]. Do not pass a single shell string.",
                "examples": [["-sV", "--max-rate", "10", "target.example"]],
            },
            "stdin": {
                "type": "string",
                "description": "Optional text sent to the process on stdin.",
            },
            "env": {
                "type": "object",
                "additionalProperties": {"type": "string"},
                "description": "Extra environment variables for this command.",
            },
            **_std_options(),
        },
        "required": [],
    }


FEROXBUSTER_CONNECTIVITY_FAILURES = (
    "ERROR: Could not connect to any target provided",
)


# ── Convert JSON Arguments Into argv Before Execution ─────────────────
# Dedicated CLI tools accept only an array of strings plus optional stdin. That
# shape is narrowed before docker exec is assembled, and each token remains one
# argv element through process launch. Malformed input fails at the MCP boundary
# instead of being reinterpreted by an intermediate shell.
# ──────────────────────────────────────────────────────────────────────

def _argv_from_args(spec: CliToolSpec, args: dict[str, Any]) -> tuple[list[str], bytes | None, dict[str, Any] | None]:
    raw_args = args.get("args", [])
    if raw_args is None:
        raw_args = []
    if not isinstance(raw_args, list):
        return [], None, {"error": "`args` must be an array of strings."}
    if not all(isinstance(item, str) for item in raw_args):
        return [], None, {"error": "Every item in `args` must be a string."}

    stdin_value = args.get("stdin")
    if stdin_value is not None and not isinstance(stdin_value, str):
        return [], None, {"error": "`stdin` must be a string when provided."}

    stdin_bytes = stdin_value.encode("utf-8") if isinstance(stdin_value, str) else None
    return [spec.command, *raw_args], stdin_bytes, None


def _make_cli_handler(spec: CliToolSpec) -> ToolHandler:
    def handler(args: dict[str, Any]) -> dict[str, Any]:
        argv, stdin_bytes, error = _argv_from_args(spec, args)
        if error:
            return tool_result(error["error"] + "\n", is_error=True)

        to, mo, cwd, env_map = safe_container_args(args)
        r = run_argv_in_container(
            argv,
            cwd=cwd,
            timeout_seconds=to,
            max_output_bytes=mo,
            extra_env=env_map,
            stdin=stdin_bytes,
        )
        if spec.optional and r.exit_code in {126, 127}:
            return tool_result(
                f"optional tool `{spec.name}` uses command `{spec.command}`, but it is not installed in this container image.\n",
                is_error=True,
            )
        return result_from_cli_run(spec, r)

    return handler


def _command_status(commands: list[str], args: dict[str, Any]) -> dict[str, str]:
    if not commands:
        return {}
    quoted = " ".join(shlex.quote(command) for command in sorted(set(commands)))
    script = (
        f"for command in {quoted}; do "
        "path=$(command -v \"$command\" 2>/dev/null || true); "
        "printf '%s\\t%s\\n' \"$command\" \"$path\"; "
        "done"
    )
    to, mo, cwd, env_map = safe_container_args(args)
    r = run_in_container(script, cwd=cwd, timeout_seconds=to, max_output_bytes=mo, extra_env=env_map)
    status: dict[str, str] = {}
    for line in r.stdout.splitlines():
        command, _, path = line.partition("\t")
        if command:
            status[command] = path
    return status


def _library_status(modules: list[str], args: dict[str, Any]) -> dict[str, str]:
    payload = json.dumps({"modules": sorted(set(modules))}).encode("utf-8")
    script = r"""
import importlib.util
import json
import sys

payload = json.load(sys.stdin)
status = {}
for module in payload.get("modules", []):
    spec = importlib.util.find_spec(module)
    status[module] = spec.origin if spec and spec.origin else ""
print(json.dumps(status, sort_keys=True))
"""
    to, mo, cwd, env_map = safe_container_args(args)
    r = run_argv_in_container(
        ["python3", "-c", script],
        cwd=cwd,
        timeout_seconds=to,
        max_output_bytes=mo,
        extra_env=env_map,
        stdin=payload,
    )
    if r.exit_code != 0:
        return {}
    try:
        parsed = json.loads(r.stdout)
    except json.JSONDecodeError:
        return {}
    return {str(key): str(value) for key, value in parsed.items()}


# ── The Published Catalog Must Match The Runtime Image ───────────────
# A tool definition is a promise to the model. Advertising a command that the
# selected image cannot execute turns planning into trial-and-error and can hide
# an incomplete or stale build until late in an engagement. The same report is
# used by the Docker build, runtime preflight, MCP inventory, and tests so none
# of those boundaries can disagree about which required capability is missing.
# ──────────────────────────────────────────────────────────────────────


def _capability_report(
    command_paths: dict[str, str],
    module_paths: dict[str, str],
    smoke: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    tools: list[dict[str, Any]] = []
    for spec in CLI_TOOL_SPECS:
        path = command_paths.get(spec.command, "")
        tools.append(
            {
                "name": spec.name,
                "kind": "cli",
                "command": spec.command,
                "category": spec.category,
                "optional": spec.optional,
                "status": "available" if path else "optional-disabled" if spec.optional else "missing",
                "path": path or None,
            }
        )
    for spec in LIBRARY_TOOL_SPECS:
        path = module_paths.get(spec.module, "")
        tools.append(
            {
                "name": spec.name,
                "kind": "library",
                "module": spec.module,
                "category": "library",
                "optional": spec.optional,
                "status": "available" if path else "optional-disabled" if spec.optional else "missing",
                "path": path or None,
            }
        )

    missing = [tool["name"] for tool in tools if tool["status"] == "missing"]
    failed_smoke = [name for name, result in (smoke or {}).items() if not result.get("ok")]
    return {
        "status": "available" if not missing and not failed_smoke else "degraded",
        "required": len([tool for tool in tools if not tool["optional"]]),
        "available": len([tool for tool in tools if tool["status"] == "available"]),
        "optional_disabled": len([tool for tool in tools if tool["status"] == "optional-disabled"]),
        "missing": missing,
        "failed_smoke": failed_smoke,
        "smoke": smoke or {},
        "tools": tools,
    }


def local_capability_report() -> dict[str, Any]:
    command_paths = {spec.command: shutil.which(spec.command) or "" for spec in CLI_TOOL_SPECS}
    module_paths: dict[str, str] = {}
    for spec in LIBRARY_TOOL_SPECS:
        module = importlib.util.find_spec(spec.module)
        module_paths[spec.module] = module.origin if module and module.origin else ""
    return _capability_report(command_paths, module_paths)


def _container_smoke(args: dict[str, Any], command: str, argv: list[str], timeout_seconds: int) -> dict[str, Any]:
    if not any(spec.command == command for spec in CLI_TOOL_SPECS):
        return {"ok": False, "error": "command is not in the cyberful-os catalog"}
    _, mo, cwd, env_map = safe_container_args(args)
    result = run_argv_in_container(
        argv,
        cwd=cwd,
        timeout_seconds=timeout_seconds,
        max_output_bytes=min(mo, 32 * 1024),
        extra_env=env_map,
    )
    output = sanitize_terminal_text((result.stdout + "\n" + result.stderr).strip())
    return {
        "ok": result.exit_code == 0 and not result.timed_out,
        "exit_code": result.exit_code,
        "timed_out": result.timed_out,
        "version": output[:1000] or None,
    }


def container_capability_report(args: dict[str, Any]) -> dict[str, Any]:
    command_paths = _command_status([spec.command for spec in CLI_TOOL_SPECS], args)
    module_paths = _library_status([spec.module for spec in LIBRARY_TOOL_SPECS], args)
    smoke: dict[str, dict[str, Any]] = {}
    if command_paths.get("nuclei"):
        smoke["nuclei"] = _container_smoke(args, "nuclei", ["nuclei", "-version"], 30)
    if command_paths.get("msfconsole"):
        smoke["metasploit"] = _container_smoke(
            args,
            "msfconsole",
            ["msfconsole", "-q", "-x", "version; exit"],
            120,
        )
    return _capability_report(command_paths, module_paths, smoke)


def _write_capability_attestation(report: dict[str, Any]) -> None:
    root = os.environ.get(WORKAREA_ROOT_ENV, "").strip()
    if not root or not os.path.isabs(root):
        return
    directory = os.path.join(root, "raw", "operations")
    os.makedirs(directory, exist_ok=True)
    target = os.path.join(directory, "capabilities.json")
    temporary = f"{target}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, target)


def verify_local_capabilities() -> int:
    report = local_capability_report()
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["status"] == "available" else 1


def ensure_strict_preflight() -> None:
    global PREFLIGHT_REPORT
    if not env_bool(STRICT_PREFLIGHT_ENV, False):
        return
    if PREFLIGHT_REPORT and PREFLIGHT_REPORT["status"] == "available":
        return
    PREFLIGHT_REPORT = container_capability_report({})
    _write_capability_attestation(PREFLIGHT_REPORT)
    if PREFLIGHT_REPORT["status"] == "available":
        return
    missing = ", ".join(PREFLIGHT_REPORT["missing"]) or "none"
    failed_smoke = ", ".join(PREFLIGHT_REPORT["failed_smoke"]) or "none"
    raise RuntimeError(
        "cyberful-os capability preflight failed before the phase started. "
        f"Missing required tools/libraries: {missing}. Failed smoke probes: {failed_smoke}. "
        "Rebuild the cyberful-os image and relaunch; no partial phase is safe to continue."
    )


@register_tool(
    "capability_attestation",
    "Attest the live cyberful-os image against every required CLI and Python-library capability, including Nuclei and Metasploit smoke probes. This is read-only and writes no target traffic.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {**_std_options()},
        "required": [],
    },
)
def handle_capability_attestation(args: dict[str, Any]) -> dict[str, Any]:
    report = container_capability_report(args)
    _write_capability_attestation(report)
    return tool_result(json.dumps(report, indent=2, sort_keys=True) + "\n", is_error=report["status"] != "available")


@register_tool(
    "tool_inventory",
    "List cyberful-os MCP tools, real commands/modules, aliases, categories, expected paths, optional flags, and live availability.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "category": {
                "type": "string",
                "description": "Optional category filter, such as network, web, osint, mobile, reversing, snmp, or supply-chain.",
            },
            "include_status": {
                "type": "boolean",
                "default": True,
                "description": "Resolve command/module availability inside the current container.",
            },
            **_std_options(),
        },
        "required": [],
    },
)
def handle_tool_inventory(args: dict[str, Any]) -> dict[str, Any]:
    category = args.get("category")
    include_status = args.get("include_status", True)
    cli_specs = [spec for spec in CLI_TOOL_SPECS if not category or spec.category == category]
    library_specs = [spec for spec in LIBRARY_TOOL_SPECS if not category or category == "library"]

    command_paths = _command_status([spec.command for spec in cli_specs], args) if include_status else {}
    module_paths = _library_status([spec.module for spec in library_specs], args) if include_status else {}

    tools: list[dict[str, Any]] = []
    for spec in cli_specs:
        path = command_paths.get(spec.command, "")
        tools.append(
            {
                "name": spec.name,
                "kind": "cli",
                "command": spec.command,
                "category": spec.category,
                "aliases": list(spec.aliases),
                "expected_paths": list(spec.expected_paths),
                "optional": spec.optional,
                "installed": bool(path) if include_status else None,
                "path": path if include_status else None,
                "usage": spec.usage,
                "examples": list(spec.examples),
                "description": spec.description,
            }
        )
    for spec in library_specs:
        path = module_paths.get(spec.module, "")
        tools.append(
            {
                "name": spec.name,
                "kind": "library",
                "module": spec.module,
                "category": "library",
                "installed": bool(path) if include_status else None,
                "path": path if include_status else None,
                "usage": spec.usage,
                "description": spec.description,
            }
        )
    if not category or category == "meta":
        tools.extend(
            [
                {
                    "name": "capability_attestation",
                    "kind": "capability",
                    "category": "meta",
                    "installed": True if include_status else None,
                    "path": None,
                    "usage": "Verify every required catalog command and Python module, including Nuclei and Metasploit smoke probes.",
                    "description": "Runtime image/catalog attestation used by preflight and diagnostics.",
                },
                {
                    "name": "tool_inventory",
                    "kind": "meta",
                    "category": "meta",
                    "installed": True if include_status else None,
                    "path": None,
                    "usage": "List the MCP registry, real command/module mappings, aliases, categories, and availability.",
                    "description": "Inventory for the cyberful-os MCP registry.",
                },
                {
                    "name": "wordlists",
                    "kind": "capability",
                    "category": "meta",
                    "installed": True if include_status else None,
                    "path": None,
                    "usage": "List and preview cyberful-os credential and discovery wordlists.",
                    "description": "Wordlist inventory and preview capability.",
                },
                {
                    "name": "shell",
                    "kind": "fallback",
                    "category": "meta",
                    "installed": True if include_status else None,
                    "path": None,
                    "usage": "Run an arbitrary bash command only when no dedicated lowercase tool fits.",
                    "description": "Fallback shell execution tool.",
                },
                {
                    "name": "nuclei_templates",
                    "kind": "capability",
                    "category": "meta",
                    "installed": True if include_status else None,
                    "path": None,
                    "usage": "Preview how many nuclei templates a -tags/-id/-severity filter selects before scanning (side-effect-free `nuclei -tl`).",
                    "description": "Nuclei template-filter preview (count + list) — run before a `nuclei` scan to avoid blasting the full corpus.",
                },
                {
                    "name": "nuclei_plan",
                    "kind": "capability",
                    "category": "meta",
                    "installed": True if include_status else None,
                    "path": None,
                    "usage": "Build a side-effect-free, bounded Nuclei plan from an HTTP or HTTPS target and explicit tags, template IDs, or severities.",
                    "description": "Validates scope shape, previews the corpus, and issues an opaque plan ID only for 1-40 matching templates.",
                },
                {
                    "name": "nuclei_run_scoped",
                    "kind": "capability",
                    "category": "meta",
                    "installed": True if include_status else None,
                    "path": None,
                    "usage": "Execute a previously validated nuclei_plan by plan ID; raw Nuclei flags are not accepted.",
                    "description": "Bounded Nuclei runner with the Bugcrowd marker, no OAST, no redirects, <=5 req/s, and serialized requests.",
                },
            ]
        )

    payload = {
        "count": len(tools),
        "include_status": include_status,
        "category": category or "all",
        "tools": tools,
    }
    return tool_result(json.dumps(payload, indent=2, sort_keys=True) + "\n")


@register_tool(
    "requests",
    "Fetch HTTP(S) resources using Python requests inside the cyberful-os container. Use this for scripted OSINT, authenticated fetches, API checks, and response capture — prefer it over curl+grep/byte-window scraping when you need the body or headers. For JSON-capable endpoints (REST APIs, and framework debug/exception pages), set headers {\"Accept\": \"application/json\"} to receive the STRUCTURED JSON directly instead of scraping JSON embedded in HTML. Bodies are capped at max_body_chars (default 65536, max 1048576) and the result sets body_truncated=true when cut — raise max_body_chars (don't byte-window) to capture the full payload.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "url": {"type": "string", "description": "HTTP or HTTPS URL to request."},
            "method": {"type": "string", "default": "GET", "description": "HTTP method, for example GET, POST, PUT, PATCH, DELETE, or HEAD."},
            "headers": {"type": "object", "additionalProperties": {"type": "string"}, "description": "Optional request headers."},
            "params": {"type": "object", "additionalProperties": {"type": "string"}, "description": "Optional query parameters."},
            "data": {"type": "string", "description": "Optional raw request body."},
            "json_body": {"type": "object", "description": "Optional JSON request body."},
            "request_timeout": {"type": "integer", "minimum": 1, "maximum": 300, "default": 30, "description": "Requests library timeout in seconds."},
            "verify_tls": {"type": "boolean", "default": True, "description": "Verify TLS certificates."},
            "follow_redirects": {"type": "boolean", "default": True, "description": "Follow HTTP redirects."},
            "max_body_chars": {"type": "integer", "minimum": 0, "maximum": 1048576, "default": 65536, "description": "Maximum response text characters returned."},
            **_std_options(),
        },
        "required": ["url"],
    },
)
def handle_requests_tool(args: dict[str, Any]) -> dict[str, Any]:
    url = args.get("url")
    if not isinstance(url, str) or not url:
        return tool_result("`url` must be a non-empty string.\n", is_error=True)

    payload = json.dumps(args).encode("utf-8")
    script = r"""
import codecs
import json
import sys
import requests

args = json.load(sys.stdin)
max_body_chars = int(args.get("max_body_chars", 65536))
with requests.request(
    method=str(args.get("method") or "GET").upper(),
    url=args["url"],
    headers=args.get("headers") or None,
    params=args.get("params") or None,
    data=args.get("data"),
    json=args.get("json_body"),
    timeout=int(args.get("request_timeout") or 30),
    verify=args.get("verify_tls", True),
    allow_redirects=args.get("follow_redirects", True),
    stream=True,
) as response:
    encoding = response.encoding or "utf-8"
    try:
        decoder = codecs.getincrementaldecoder(encoding)(errors="replace")
    except LookupError:
        encoding = "utf-8"
        decoder = codecs.getincrementaldecoder(encoding)(errors="replace")
    body_parts = []
    retained_chars = 0
    body_truncated = False
    for chunk in response.iter_content(chunk_size=16384, decode_unicode=False):
        if not chunk:
            continue
        decoded = decoder.decode(chunk)
        remaining = max_body_chars - retained_chars
        if len(decoded) > remaining:
            body_parts.append(decoded[:max(0, remaining)])
            body_truncated = True
            break
        body_parts.append(decoded)
        retained_chars += len(decoded)
    if not body_truncated:
        tail = decoder.decode(b"", final=True)
        remaining = max_body_chars - retained_chars
        if len(tail) > remaining:
            body_parts.append(tail[:max(0, remaining)])
            body_truncated = True
        else:
            body_parts.append(tail)
    result = {
        "url": response.url,
        "status_code": response.status_code,
        "reason": response.reason,
        "headers": dict(response.headers),
        "elapsed_seconds": response.elapsed.total_seconds(),
        "encoding": encoding,
        "body_truncated": body_truncated,
        "body": "".join(body_parts),
    }
print(json.dumps(result, indent=2, sort_keys=True))
"""
    to, mo, cwd, env_map = safe_container_args(args)
    r = run_argv_in_container(["python3", "-c", script], cwd=cwd, timeout_seconds=to, max_output_bytes=mo, extra_env=env_map, stdin=payload)
    return result_from_run(r)


@register_tool(
    "bs4",
    "Parse HTML using Beautiful Soup inside the cyberful-os container. Use this to extract text, attributes, links, forms, or matching HTML fragments from fetched or saved content.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "html": {"type": "string", "description": "Inline HTML content. Provide either html or path."},
            "path": {"type": "string", "description": "Path to an HTML file inside the container. Provide either html or path."},
            "selector": {"type": "string", "description": "CSS selector to extract. Defaults to title, a, form, input, script, and meta if omitted."},
            "attribute": {"type": "string", "description": "Attribute to extract from matching elements, such as href, src, action, name, or content."},
            "text_only": {"type": "boolean", "default": True, "description": "Return element text instead of HTML when attribute is not set."},
            "parser": {"type": "string", "default": "html.parser", "description": "Beautiful Soup parser name, for example html.parser or lxml."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 100, "description": "Maximum matching elements returned."},
            **_std_options(),
        },
        "required": [],
    },
)
def handle_bs4_tool(args: dict[str, Any]) -> dict[str, Any]:
    payload = json.dumps({
        **args,
        "_max_input_bytes": MAX_PARSE_INPUT_BYTES,
        "_max_result_chars": MAX_LIBRARY_RESULT_CHARS,
    }).encode("utf-8")
    script = r"""
import json
import sys
from pathlib import Path
from bs4 import BeautifulSoup

args = json.load(sys.stdin)
html = args.get("html")
max_input_bytes = int(args["_max_input_bytes"])
max_result_chars = int(args["_max_result_chars"])
if html is not None and len(html.encode("utf-8")) > max_input_bytes:
    raise SystemExit(f"Inline HTML exceeds the {max_input_bytes}-byte parser limit.")
if html is None and args.get("path"):
    with Path(args["path"]).open("rb") as handle:
        raw = handle.read(max_input_bytes + 1)
    if len(raw) > max_input_bytes:
        raise SystemExit(f"HTML file exceeds the {max_input_bytes}-byte parser limit.")
    html = raw.decode("utf-8", errors="replace")
if html is None:
    raise SystemExit("Either html or path is required.")
selector = args.get("selector") or "title, a, form, input, script, meta"
attribute = args.get("attribute")
text_only = bool(args.get("text_only", True))
limit = int(args.get("limit") or 100)
soup = BeautifulSoup(html, args.get("parser") or "html.parser")
items = []
retained_chars = 0
matches = soup.select(selector, limit=limit + 1)
result_truncated = len(matches) > limit
for element in matches[:limit]:
    if attribute:
        value = element.get(attribute)
    elif text_only:
        value = element.get_text(" ", strip=True)
    else:
        value = str(element)
    item = {"name": element.name, "value": value, "attrs": dict(element.attrs)}
    item_chars = len(json.dumps(item, ensure_ascii=False))
    if retained_chars + item_chars > max_result_chars:
        result_truncated = True
        break
    retained_chars += item_chars
    items.append(item)
print(json.dumps({
    "count": len(items),
    "selector": selector,
    "items": items,
    "result_truncated": result_truncated,
}, indent=2, sort_keys=True))
"""
    to, mo, cwd, env_map = safe_container_args(args)
    r = run_argv_in_container(["python3", "-c", script], cwd=cwd, timeout_seconds=to, max_output_bytes=mo, extra_env=env_map, stdin=payload)
    return result_from_run(r)


@register_tool(
    "lxml",
    "Parse HTML/XML and evaluate XPath using lxml inside the cyberful-os container. Use this for structured extraction from pages, XML APIs, manifests, and mobile/static-analysis outputs.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "content": {"type": "string", "description": "Inline HTML/XML content. Provide either content or path."},
            "path": {"type": "string", "description": "Path to an HTML/XML file inside the container. Provide either content or path."},
            "xpath": {"type": "string", "description": "XPath expression to evaluate."},
            "mode": {"type": "string", "enum": ["html", "xml"], "default": "html", "description": "Parse mode."},
            "namespaces": {"type": "object", "additionalProperties": {"type": "string"}, "description": "Optional XPath namespace map."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 100, "description": "Maximum results returned."},
            **_std_options(),
        },
        "required": ["xpath"],
    },
)
def handle_lxml_tool(args: dict[str, Any]) -> dict[str, Any]:
    xpath = args.get("xpath")
    if not isinstance(xpath, str) or not xpath:
        return tool_result("`xpath` must be a non-empty string.\n", is_error=True)

    payload = json.dumps({
        **args,
        "_max_input_bytes": MAX_PARSE_INPUT_BYTES,
        "_max_result_chars": MAX_LIBRARY_RESULT_CHARS,
    }).encode("utf-8")
    script = r"""
import json
import sys
from pathlib import Path
from lxml import etree, html as lxml_html

args = json.load(sys.stdin)
content = args.get("content")
max_input_bytes = int(args["_max_input_bytes"])
max_result_chars = int(args["_max_result_chars"])
if content is not None and len(content.encode("utf-8")) > max_input_bytes:
    raise SystemExit(f"Inline document exceeds the {max_input_bytes}-byte parser limit.")
if content is None and args.get("path"):
    with Path(args["path"]).open("rb") as handle:
        raw = handle.read(max_input_bytes + 1)
    if len(raw) > max_input_bytes:
        raise SystemExit(f"Document file exceeds the {max_input_bytes}-byte parser limit.")
    content = raw.decode("utf-8", errors="replace")
if content is None:
    raise SystemExit("Either content or path is required.")
mode = args.get("mode") or "html"
if mode == "html":
    root = lxml_html.fromstring(content)
else:
    parser = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False)
    root = etree.fromstring(content.encode("utf-8"), parser=parser)
raw_matches = root.xpath(args["xpath"], namespaces=args.get("namespaces") or None)
matches = raw_matches if isinstance(raw_matches, list) else [raw_matches]
limit = int(args.get("limit") or 100)
items = []
retained_chars = 0
result_truncated = len(matches) > limit
for item in matches[:limit]:
    if isinstance(item, etree._Element):
        value = etree.tostring(item, encoding="unicode", pretty_print=False)
    else:
        value = str(item)
    value_chars = len(json.dumps(value, ensure_ascii=False))
    if retained_chars + value_chars > max_result_chars:
        result_truncated = True
        break
    retained_chars += value_chars
    items.append(value)
print(json.dumps({
    "count": len(items),
    "xpath": args["xpath"],
    "items": items,
    "result_truncated": result_truncated,
}, indent=2, sort_keys=True))
"""
    to, mo, cwd, env_map = safe_container_args(args)
    r = run_argv_in_container(["python3", "-c", script], cwd=cwd, timeout_seconds=to, max_output_bytes=mo, extra_env=env_map, stdin=payload)
    return result_from_run(r)


@register_tool(
    "wordlists",
    "List and preview cyberful-os credential and content-discovery wordlists inside the container, including /usr/share/wordlists/cyberful-os/credentials, /usr/share/wordlists/cyberful-os/content (frequency-ordered raft/API lists), and /opt/cred-tools/common-creds.txt.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "paths": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional files or directories to inspect. Defaults to cyberful-os credential and content-discovery wordlists, common creds, and dirb common wordlist.",
            },
            "preview_lines": {"type": "integer", "minimum": 0, "maximum": 100, "default": 5, "description": "Number of leading lines to preview per file."},
            "max_files": {"type": "integer", "minimum": 1, "maximum": 500, "default": 100, "description": "Maximum files returned."},
            **_std_options(),
        },
        "required": [],
    },
)
def handle_wordlists(args: dict[str, Any]) -> dict[str, Any]:
    payload = json.dumps({
        **args,
        "_max_scan_entries": MAX_WORDLIST_SCAN_ENTRIES,
        "_max_preview_bytes": MAX_WORDLIST_PREVIEW_BYTES,
        "_max_preview_file_bytes": MAX_WORDLIST_PREVIEW_FILE_BYTES,
    }).encode("utf-8")
    script = r"""
import json
import os
import sys
from pathlib import Path

args = json.load(sys.stdin)
paths = args.get("paths") or [
    "/usr/share/wordlists/cyberful-os/credentials",
    "/usr/share/wordlists/cyberful-os/content",
    "/opt/cred-tools/common-creds.txt",
    "/usr/share/wordlists/dirb/common.txt",
]
preview_lines = int(args.get("preview_lines", 5))
max_files = int(args.get("max_files", 100))
scan_limit = min(int(args["_max_scan_entries"]), max(1000, max_files * 20))
max_preview_bytes = int(args["_max_preview_bytes"])
max_preview_file_bytes = int(args["_max_preview_file_bytes"])
files = []
scanned_entries = 0
scan_truncated = False
preview_stats = {"bytes": 0, "exhausted": False}

def append_file(candidate):
    preview = []
    preview_truncated = False
    if preview_lines and preview_stats["bytes"] < max_preview_bytes:
        try:
            budget = min(max_preview_file_bytes, max_preview_bytes - preview_stats["bytes"])
            with candidate.open("rb") as handle:
                raw = handle.read(budget + 1)
            retained = raw[:budget]
            preview_stats["bytes"] += len(retained)
            lines = retained.decode("utf-8", errors="replace").splitlines()
            preview = lines[:preview_lines]
            preview_truncated = len(raw) > budget or len(lines) > preview_lines
        except OSError:
            preview = []
    elif preview_lines:
        preview_stats["exhausted"] = True
        preview_truncated = True
    if preview_stats["bytes"] >= max_preview_bytes:
        preview_stats["exhausted"] = True
    try:
        size = candidate.stat().st_size
    except OSError:
        size = None
    files.append({
        "path": str(candidate),
        "size_bytes": size,
        "preview": preview,
        "preview_truncated": preview_truncated,
    })

for raw in paths:
    if len(files) >= max_files or scan_truncated:
        break
    path = Path(raw)
    if path.is_file():
        append_file(path)
        continue
    if not path.is_dir():
        continue
    stack = [path]
    while stack and len(files) < max_files:
        directory = stack.pop()
        try:
            entries = os.scandir(directory)
        except OSError:
            continue
        with entries:
            for entry in entries:
                if scanned_entries >= scan_limit:
                    scan_truncated = True
                    break
                scanned_entries += 1
                try:
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(Path(entry.path))
                    elif entry.is_file(follow_symlinks=False):
                        append_file(Path(entry.path))
                except OSError:
                    continue
                if len(files) >= max_files:
                    break
        if scan_truncated:
            break
print(json.dumps({
    "count": len(files),
    "files": files,
    "scanned_entries": scanned_entries,
    "scan_limit": scan_limit,
    "scan_truncated": scan_truncated,
    "file_limit_reached": len(files) >= max_files,
    "preview_bytes_retained": preview_stats["bytes"],
    "preview_budget_exhausted": preview_stats["exhausted"],
}, indent=2, sort_keys=True))
"""
    to, mo, cwd, env_map = safe_container_args(args)
    r = run_argv_in_container(["python3", "-c", script], cwd=cwd, timeout_seconds=to, max_output_bytes=mo, extra_env=env_map, stdin=payload)
    return result_from_run(r)


# ── Broad Template Previews Preserve The Count, Not Every Path ────────
# A broad filter can match thousands of templates and exhaust the MCP output
# budget before the caller learns that its scope is unsafe. The match count is
# the decision signal, so broad results retain only a sample and narrowing advice.
# A properly scoped result remains below the cap and returns every matched path.
# ──────────────────────────────────────────────────────────────────────

def _render_template_list(template_lines: list[str], count: int, list_cap: int = 40) -> list[str]:
    if not count:
        return []
    if count > list_cap:
        return [
            f"templates (first {list_cap} of {count} — list capped to keep this preview compact):",
            *template_lines[:list_cap],
            f"… +{count - list_cap} more not listed. Narrow -tags/-id/-severity to the tech/versions you "
            "actually detected and re-preview; aim for a count in the low tens before you scan.",
        ]
    return ["templates:", *template_lines]


def handle_nuclei_templates(args: dict[str, Any]) -> dict[str, Any]:
    raw_args = args.get("args", [])
    if raw_args is None:
        raw_args = []
    if not isinstance(raw_args, list):
        return tool_result("`args` must be an array of strings.\n", is_error=True)
    if not all(isinstance(item, str) for item in raw_args):
        return tool_result("Every item in `args` must be a string.\n", is_error=True)

    # ── Nuclei Preview Is Deliberately Side-Effect Free ────────────────
    # Template-list mode resolves the same caller-provided filters without sending
    # traffic to a target. Update checks stay disabled explicitly, and no target is
    # accepted or synthesized. The resulting count is therefore a safe preview of
    # the corpus that a later, separately authorized scan would load. Nuclei may
    # mix banner text and template paths across both streams, so only YAML path
    # lines contribute to the reported count.
    # ────────────────────────────────────────────────────────────────────
    argv = ["nuclei", "-tl", "-disable-update-check", *raw_args]
    to, mo, cwd, env_map = safe_container_args(args)
    r = run_argv_in_container(argv, cwd=cwd, timeout_seconds=to, max_output_bytes=mo, extra_env=env_map)

    template_lines = [
        ln for ln in (r.stdout + "\n" + r.stderr).splitlines()
        if ln.strip().endswith((".yaml", ".yml"))
    ]
    count = len(template_lines)
    count_str = (
        f"{count}+ (output truncated — raise max_output_bytes for the exact list)"
        if r.truncated else str(count)
    )
    failed = r.timed_out or (r.exit_code is not None and r.exit_code != 0)

    if r.timed_out:
        summary = (
            f"[nuclei_templates] Timed out after {to}s before the list finished. "
            "Narrow the filter or raise timeout_seconds. Side-effect-free: -tl only lists templates, it never scans."
        )
    elif failed:
        summary = (
            f"[nuclei_templates] nuclei exited {r.exit_code} — your filter flags are probably invalid; fix them and retry. "
            "Side-effect-free: -tl only lists templates, it never scans a target."
        )
    elif count == 0:
        summary = (
            "[nuclei_templates] WARNING: 0 templates match this filter — it selected NOTHING (too narrow, wrong -tags/-id, or a typo). "
            "Fix the filter before scanning: a 0-match preview means the scan would test nothing."
        )
    else:
        summary = (
            f"[nuclei_templates] {count_str} templates match this filter — an upper bound on what a `nuclei` scan with these flags will load "
            "(the scan also applies nuclei's default exclusions, so it may run somewhat fewer). "
            "Side-effect-free: -tl lists templates and exits, no request is sent to any target. "
            "If this number is in the hundreds or thousands the filter is too broad (an unfiltered scan runs thousands of templates) — "
            "narrow -tags/-id/-severity to the tech and versions you actually detected."
        )

    lines = [summary, "", f"command: {r.command}", ""]
    lines.extend(_render_template_list(template_lines, count))
    if (failed or count == 0) and r.stderr.strip():
        lines.extend(["", "stderr:", r.stderr.rstrip()])
    return tool_result("\n".join(lines).rstrip() + "\n", is_error=failed)


# ── Turn A Broad Scanner Into A Reviewed, Bounded Operation ──────────
# The raw Nuclei wrapper remains available for expert use. These two additional
# tools provide the preferred path: planning performs only an offline template
# listing, while execution accepts an opaque plan ID rather than caller-chosen
# flags. This makes the runtime bounds inspectable and prevents the approved
# target/filter from drifting between preview and scan.
# ──────────────────────────────────────────────────────────────────────


def _nuclei_filter_args(args: dict[str, Any]) -> tuple[list[str], str | None]:
    token = re.compile(r"^[A-Za-z0-9_.:-]+$")
    filters: list[str] = []
    for field, flag in (("tags", "-tags"), ("template_ids", "-id")):
        values = args.get(field, [])
        if values is None:
            values = []
        if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
            return [], f"`{field}` must be an array of strings."
        normalized = [value.strip() for value in values if value.strip()]
        if len(normalized) > 20 or any(not token.fullmatch(value) for value in normalized):
            return [], f"`{field}` accepts at most 20 simple names containing letters, digits, dot, colon, underscore, or hyphen."
        if normalized:
            filters.extend([flag, ",".join(sorted(set(normalized)))])

    severities = args.get("severities", [])
    if severities is None:
        severities = []
    allowed_severities = {"info", "low", "medium", "high", "critical", "unknown"}
    if not isinstance(severities, list) or not all(isinstance(value, str) for value in severities):
        return [], "`severities` must be an array of strings."
    normalized_severities = [value.strip().lower() for value in severities if value.strip()]
    if any(value not in allowed_severities for value in normalized_severities):
        return [], "`severities` contains an unsupported value."
    if normalized_severities:
        filters.extend(["-severity", ",".join(sorted(set(normalized_severities)))])
    if not filters:
        return [], "Provide at least one tag, template ID, or severity; unfiltered plans are refused."
    return filters, None


def _nuclei_web_target(value: Any) -> tuple[str, str | None]:
    if not isinstance(value, str) or not value.strip() or len(value) > 2048:
        return "", "`target` must be a non-empty HTTP or HTTPS URL no longer than 2048 characters."
    target = value.strip()
    parsed = urllib.parse.urlsplit(target)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or not parsed.hostname:
        return "", "`target` must be an absolute HTTP or HTTPS URL."
    if parsed.username or parsed.password or parsed.fragment:
        return "", "`target` must not contain credentials or a URL fragment."
    try:
        parsed.port
    except ValueError:
        return "", "`target` contains an invalid port."
    return urllib.parse.urlunsplit(parsed._replace(scheme=scheme)), None


def _preview_nuclei_filters(filter_args: list[str], args: dict[str, Any]) -> tuple[CommandResult, list[str]]:
    to, mo, cwd, env_map = safe_container_args(args)
    result = run_argv_in_container(
        ["nuclei", "-tl", "-disable-update-check", *filter_args],
        cwd=cwd,
        timeout_seconds=to,
        max_output_bytes=mo,
        extra_env=env_map,
    )
    templates = [
        line.strip()
        for line in (result.stdout + "\n" + result.stderr).splitlines()
        if line.strip().endswith((".yaml", ".yml"))
    ]
    return result, templates


def handle_nuclei_plan(args: dict[str, Any]) -> dict[str, Any]:
    unexpected = sorted(
        set(args) - {"target", "tags", "template_ids", "severities", "max_templates", "rate_limit", "timeout_seconds", "max_output_bytes", "cwd"}
    )
    if unexpected:
        return tool_result(f"Unsupported nuclei_plan fields: {', '.join(unexpected)}. Raw Nuclei flags are not accepted.\n", is_error=True)
    target, target_error = _nuclei_web_target(args.get("target"))
    if target_error:
        return tool_result(target_error + "\n", is_error=True)
    filter_args, filter_error = _nuclei_filter_args(args)
    if filter_error:
        return tool_result(filter_error + "\n", is_error=True)

    rate_limit = int_arg(args.get("rate_limit"), NUCLEI_MAX_RATE, 1, NUCLEI_MAX_RATE)
    max_templates = int_arg(args.get("max_templates"), NUCLEI_MAX_TEMPLATES, 1, NUCLEI_MAX_TEMPLATES)
    result, templates = _preview_nuclei_filters(filter_args, args)
    if result.timed_out or result.exit_code != 0:
        return tool_result(
            "Nuclei could not validate this filter offline; no plan was created.\n\n"
            + result_from_run(result)["content"][0]["text"],
            is_error=True,
        )
    if result.truncated:
        return tool_result(
            "The offline template preview was truncated, so its size cannot be attested; narrow the filter and plan again.\n",
            is_error=True,
        )
    if not templates:
        return tool_result("The offline filter matched zero templates; no plan was created.\n", is_error=True)
    if len(templates) > max_templates:
        return tool_result(
            f"The offline filter matched {len(templates)} templates, above this plan's limit of {max_templates}; narrow it and plan again.\n",
            is_error=True,
        )

    canonical = json.dumps(
        {
            "target": target,
            "filter_args": filter_args,
            "template_count": len(templates),
            "rate_limit": rate_limit,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    plan_id = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    plan = NucleiPlan(
        plan_id=plan_id,
        target=target,
        filter_args=tuple(filter_args),
        template_count=len(templates),
        rate_limit=rate_limit,
        output_path=f"raw/operations/nuclei/{plan_id}.jsonl",
    )
    NUCLEI_PLANS[plan_id] = plan
    return tool_result(
        json.dumps(
            {
                "status": "ready",
                "side_effect_free": True,
                "plan_id": plan.plan_id,
                "target": plan.target,
                "filter_args": list(plan.filter_args),
                "template_count": plan.template_count,
                "templates": templates,
                "rate_limit": plan.rate_limit,
                "output_path": plan.output_path,
                "next_tool": "nuclei_run_scoped",
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )


def handle_nuclei_run_scoped(args: dict[str, Any]) -> dict[str, Any]:
    unexpected = sorted(set(args) - {"plan_id", "timeout_seconds", "max_output_bytes", "cwd"})
    if unexpected:
        return tool_result(f"Unsupported nuclei_run_scoped fields: {', '.join(unexpected)}. Raw Nuclei flags are not accepted.\n", is_error=True)
    plan_id = args.get("plan_id")
    if not isinstance(plan_id, str) or not re.fullmatch(r"[0-9a-f]{64}", plan_id):
        return tool_result("`plan_id` must be the ID returned by nuclei_plan.\n", is_error=True)
    plan = NUCLEI_PLANS.get(plan_id)
    if not plan:
        return tool_result("This Nuclei plan is unknown or already consumed; create a fresh nuclei_plan.\n", is_error=True)

    to, mo, cwd, env_map = safe_container_args(args)
    directory = os.path.dirname(plan.output_path)
    prepared = run_argv_in_container(
        ["mkdir", "-p", directory],
        cwd=cwd,
        timeout_seconds=min(to, 30),
        max_output_bytes=min(mo, 32 * 1024),
        extra_env=env_map,
    )
    if prepared.exit_code != 0 or prepared.timed_out:
        return tool_result("Could not prepare the bounded Nuclei output directory.\n", is_error=True)

    result = run_argv_in_container(
        [
            "nuclei",
            "-u",
            plan.target,
            *plan.filter_args,
            "-disable-update-check",
            "-no-interactsh",
            "-dr",
            "-rate-limit",
            str(plan.rate_limit),
            "-c",
            "1",
            "-bulk-size",
            "1",
            "-exclude-tags",
            NUCLEI_EXCLUDED_TAGS,
            "-H",
            "X-Request-ID: Bugcrowd",
            "-jsonl",
            "-silent",
            "-o",
            plan.output_path,
        ],
        cwd=cwd,
        timeout_seconds=to,
        max_output_bytes=mo,
        extra_env=env_map,
    )
    counted = run_argv_in_container(
        [
            "python3",
            "-c",
            "import pathlib,sys; p=pathlib.Path(sys.argv[1]); print(sum(1 for line in p.open(encoding='utf-8', errors='replace') if line.strip()) if p.is_file() else 0)",
            plan.output_path,
        ],
        cwd=cwd,
        timeout_seconds=min(to, 30),
        max_output_bytes=min(mo, 32 * 1024),
        extra_env=env_map,
    )
    try:
        suspected_count = max(0, int(counted.stdout.strip())) if counted.exit_code == 0 else 0
    except ValueError:
        suspected_count = 0
    NUCLEI_PLANS.pop(plan_id, None)
    prefix = (
        f"plan_id: {plan.plan_id}\n"
        f"template_count: {plan.template_count}\n"
        f"rate_limit: {plan.rate_limit}\n"
        f"output_path: {plan.output_path}\n"
        f"lead_count: {suspected_count}\n"
        f"suspected_count: {suspected_count}\n"
        "confirmed_count: 0\n"
        "classification: every emitted match is SUSPECTED until independently reproduced and verified\n\n"
    )
    rendered = result_from_run(result)
    return tool_result(prefix + rendered["content"][0]["text"], is_error=bool(rendered.get("isError")))


_validate_catalog()

# ── Rebuild Registry From The Verified Catalog ────────────────────────
# Import-time validation proves that generated tool names are unique and MCP
# safe. Only after that proof does the code clear the temporary decorator
# registry and rebuild it from the catalog. The lowercase per-binary API is thus
# the sole public surface exposed to MCP clients.
# ──────────────────────────────────────────────────────────────────────
TOOL_REGISTRY.clear()
register_tool(
    "capability_attestation",
    "Attest the live cyberful-os image against every required CLI and Python-library capability, including Nuclei and Metasploit smoke probes. This is read-only and writes no target traffic.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {**_std_options()},
        "required": [],
    },
)(handle_capability_attestation)
register_tool(
    "tool_inventory",
    "List cyberful-os MCP tools, real commands/modules, aliases, categories, expected paths, optional flags, and live availability.",
    handle_tool_inventory.__dict__.get("_schema", {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "category": {"type": "string", "description": "Optional category filter."},
            "include_status": {"type": "boolean", "default": True, "description": "Resolve availability inside the current container."},
            **_std_options(),
        },
        "required": [],
    }),
)(handle_tool_inventory)
for _spec in CLI_TOOL_SPECS:
    register_tool(_spec.name, _cli_tool_description(_spec), _cli_tool_schema())(_make_cli_handler(_spec))
register_tool(
    "nuclei_templates",
    "Preview how many nuclei templates a filter selects BEFORE you scan — call this first whenever you plan a `nuclei` run. Runs `nuclei -tl -disable-update-check` plus your filter flags inside the cyberful-os container and returns the matching template count and list. Side-effect-free: -tl only lists templates and exits — it sends NO request to any target. Pass the SAME -tags/-id/-severity flags you will pass to the `nuclei` scan, as a JSON array of strings in `args`; the count and list are then an upper bound on what that scan will load (a scan also applies nuclei's default exclusions). Do NOT pass -t, -u, a target, or -l — the signed corpus is pre-installed and auto-resolved, and -tl/-disable-update-check are added for you. Read the count before scanning: a count in the hundreds or thousands means your filter is too broad (an unfiltered nuclei scan runs thousands of templates); a count of 0 means the filter matched nothing and must be fixed.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "args": {
                "type": "array",
                "items": {"type": "string"},
                "default": [],
                "description": "Template FILTER flags to preview, as a JSON array of strings — the SAME -tags/-id/-severity you will pass to the `nuclei` scan (e.g. [\"-tags\",\"laravel\"] or [\"-id\",\"CVE-2021-3129\"]). Do NOT include -t, -u, -l, or a target; -tl and -disable-update-check are added automatically and the pre-installed corpus is auto-resolved.",
                "examples": [["-tags", "laravel"], ["-id", "CVE-2021-3129"]],
            },
            **_std_options(),
        },
        "required": [],
    },
)(handle_nuclei_templates)
register_tool(
    "nuclei_plan",
    "Preferred Nuclei planning tool. Performs only an offline template listing, refuses unfiltered or broad selections, and returns an opaque one-use plan ID for nuclei_run_scoped. It sends no target traffic.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "target": {
                "type": "string",
                "description": "Authorized absolute HTTP or HTTPS target URL. Credentials and fragments are refused.",
            },
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": 20,
                "description": "Nuclei tags tied to detected technology, such as wordpress or cve.",
            },
            "template_ids": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": 20,
                "description": "Exact Nuclei template IDs tied to a concrete candidate.",
            },
            "severities": {
                "type": "array",
                "items": {"type": "string", "enum": ["info", "low", "medium", "high", "critical", "unknown"]},
                "description": "Optional severities. At least one tags/template_ids/severities filter is required.",
            },
            "max_templates": {
                "type": "integer",
                "minimum": 1,
                "maximum": NUCLEI_MAX_TEMPLATES,
                "default": NUCLEI_MAX_TEMPLATES,
                "description": "Maximum offline-matched templates accepted by this plan; hard-capped at 40.",
            },
            "rate_limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": NUCLEI_MAX_RATE,
                "default": NUCLEI_MAX_RATE,
                "description": "Maximum planned request rate; hard-capped at 5 requests/second.",
            },
            **_std_options(),
        },
        "required": ["target"],
    },
)(handle_nuclei_plan)
register_tool(
    "nuclei_run_scoped",
    "Execute exactly one previously validated nuclei_plan. This tool accepts no raw Nuclei flags and enforces the Bugcrowd marker, no OAST, no redirects, at most 5 requests/second, concurrency 1, bulk size 1, and exclusion of intrusive template tags. Treat every hit as SUSPECTED.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "plan_id": {
                "type": "string",
                "pattern": "^[0-9a-f]{64}$",
                "description": "Opaque one-use ID returned by nuclei_plan.",
            },
            **_std_options(),
        },
        "required": ["plan_id"],
    },
)(handle_nuclei_run_scoped)
register_tool(
    "requests",
    "Fetch HTTP(S) resources using Python requests inside the cyberful-os container. Use this for scripted OSINT, authenticated fetches, API checks, and response capture — prefer it over curl+grep/byte-window scraping when you need the body or headers. For JSON-capable endpoints (REST APIs, and framework debug/exception pages), set headers {\"Accept\": \"application/json\"} to receive the STRUCTURED JSON directly instead of scraping JSON embedded in HTML. Bodies are capped at max_body_chars (default 65536, max 1048576) and the result sets body_truncated=true when cut — raise max_body_chars (don't byte-window) to capture the full payload.",
    handle_requests_tool.__dict__.get("_schema", {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "url": {"type": "string", "description": "HTTP or HTTPS URL to request."},
            "method": {"type": "string", "default": "GET", "description": "HTTP method."},
            "headers": {"type": "object", "additionalProperties": {"type": "string"}, "description": "Optional request headers."},
            "params": {"type": "object", "additionalProperties": {"type": "string"}, "description": "Optional query parameters."},
            "data": {"type": "string", "description": "Optional raw request body."},
            "json_body": {"type": "object", "description": "Optional JSON request body."},
            "request_timeout": {"type": "integer", "minimum": 1, "maximum": 300, "default": 30, "description": "Requests timeout in seconds."},
            "verify_tls": {"type": "boolean", "default": True, "description": "Verify TLS certificates."},
            "follow_redirects": {"type": "boolean", "default": True, "description": "Follow HTTP redirects."},
            "max_body_chars": {"type": "integer", "minimum": 0, "maximum": 1048576, "default": 65536, "description": "Maximum response characters returned."},
            **_std_options(),
        },
        "required": ["url"],
    }),
)(handle_requests_tool)
register_tool(
    "bs4",
    "Parse HTML using Beautiful Soup inside the cyberful-os container. Use this to extract text, attributes, links, forms, or matching HTML fragments from fetched or saved content.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "html": {"type": "string", "description": "Inline HTML content. Provide either html or path."},
            "path": {"type": "string", "description": "Path to an HTML file inside the container. Provide either html or path."},
            "selector": {"type": "string", "description": "CSS selector to extract."},
            "attribute": {"type": "string", "description": "Attribute to extract from matching elements."},
            "text_only": {"type": "boolean", "default": True, "description": "Return element text instead of HTML when attribute is not set."},
            "parser": {"type": "string", "default": "html.parser", "description": "Beautiful Soup parser name."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 100, "description": "Maximum matching elements returned."},
            **_std_options(),
        },
        "required": [],
    },
)(handle_bs4_tool)
register_tool(
    "lxml",
    "Parse HTML/XML and evaluate XPath using lxml inside the cyberful-os container. Use this for structured extraction from pages, XML APIs, manifests, and mobile/static-analysis outputs.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "content": {"type": "string", "description": "Inline HTML/XML content. Provide either content or path."},
            "path": {"type": "string", "description": "Path to an HTML/XML file inside the container. Provide either content or path."},
            "xpath": {"type": "string", "description": "XPath expression to evaluate."},
            "mode": {"type": "string", "enum": ["html", "xml"], "default": "html", "description": "Parse mode."},
            "namespaces": {"type": "object", "additionalProperties": {"type": "string"}, "description": "Optional XPath namespace map."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 100, "description": "Maximum results returned."},
            **_std_options(),
        },
        "required": ["xpath"],
    },
)(handle_lxml_tool)
register_tool(
    "wordlists",
    "List and preview cyberful-os credential and discovery wordlists inside the container.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "paths": {"type": "array", "items": {"type": "string"}, "description": "Optional files or directories to inspect."},
            "preview_lines": {"type": "integer", "minimum": 0, "maximum": 100, "default": 5, "description": "Number of leading lines to preview per file."},
            "max_files": {"type": "integer", "minimum": 1, "maximum": 500, "default": 100, "description": "Maximum files returned."},
            **_std_options(),
        },
        "required": [],
    },
)(handle_wordlists)
register_tool(
    "shell",
    "Fallback only: execute an arbitrary shell command inside the Docker cyberful-os container when no dedicated lowercase tool fits.",
    {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "command": {"type": "string", "minLength": 1, "description": "Shell command to execute with bash -lc in cyberful-os."},
            "cwd": {"type": "string", "description": "Working directory inside the container. Defaults to /workspace."},
            "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": MAX_TIMEOUT_SECONDS, "default": DEFAULT_TIMEOUT_SECONDS, "description": "Wall-clock timeout for the command."},
            "max_output_bytes": {"type": "integer", "minimum": 1024, "maximum": MAX_OUTPUT_BYTES, "default": DEFAULT_MAX_OUTPUT_BYTES, "description": "Maximum combined stdout/stderr bytes returned."},
            "env": {"type": "object", "additionalProperties": {"type": "string"}, "description": "Extra environment variables for this command."},
        },
        "required": ["command"],
    },
)(handle_shell)


# ── Publish The Runtime Contract Back To MCP Clients ──────────────────
# Initialization and resource reads expose the same registry and container
# defaults used by execution. Capability text is derived rather than copied, so
# client-facing names, image, mount, and lifecycle policy remain synchronized
# with the values the handlers will actually use.
# ──────────────────────────────────────────────────────────────────────


def capabilities_text() -> str:
    registry = _exposed_tool_registry()
    tool_names = "\n".join(f"- `{name}`: {desc}" for name, desc, _, _ in registry)
    return f"""# {SERVER_NAME} capabilities

This MCP server exposes {len(registry)} tools:

{tool_names}

All tools run inside Docker container `{container_name()}` using image `{image_name()}`.

Container defaults:
- workspace mount: `{project_root()}` -> `{mount_dir()}`
- default cwd: `{mount_dir()}`
- lifecycle: created on first tool call, then reused.
- capabilities: `--cap-add=NET_ADMIN --cap-add=SYS_PTRACE`

Environment variables:
- `CYBERFUL_OS_WORKSPACE` – host workspace path (default: cwd)
- `CYBERFUL_OS_MOUNT` – container mount point (default: /workspace)
- `CYBERFUL_OS_CONTAINER` – container name (default: cyberful-os)
- `CYBERFUL_OS_IMAGE` – Docker image tag (default: {DEFAULT_IMAGE})
- `CYBERFUL_OS_DOCKER_ARGS` – extra `docker run` arguments
- `CYBERFUL_OS_DOCKER_CONFIG` – Docker config directory
"""


def _exposed_tool_registry() -> list[ToolEntry]:
    if not PREFLIGHT_REPORT:
        return TOOL_REGISTRY
    disabled = {
        tool["name"]
        for tool in PREFLIGHT_REPORT.get("tools", [])
        if tool.get("status") == "optional-disabled"
    }
    return [tool for tool in TOOL_REGISTRY if tool[0] not in disabled]


def tool_result_from_exception(exc: Exception) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": f"error: {type(exc).__name__}: {exc}\n"}],
        "isError": True,
    }


# ── Fail Tool Calls As Tool Results, Not Server Crashes ───────────────
# The JSON-RPC server should survive malformed arguments and tool failures.
# Tool-call exceptions become MCP error results and release progress state in a
# finalizer. Protocol-level mistakes remain JSON-RPC errors, allowing clients to
# distinguish a failed security command from an invalid protocol request.
# ──────────────────────────────────────────────────────────────────────

def handle_tool_call(params: dict[str, Any]) -> dict[str, Any]:
    global CURRENT_PROGRESS_TOKEN, LAST_PROGRESS_AT, PROGRESS_SEQUENCE
    if not isinstance(params, dict):
        return tool_result("tool call params must be an object.\n", is_error=True)
    name = params.get("name")
    if not isinstance(name, str) or not name or len(name) > 128:
        return tool_result("tool name must be a non-empty string of at most 128 characters.\n", is_error=True)
    raw_args = params.get("arguments", {})
    if not isinstance(raw_args, dict):
        return tool_result("tool arguments must be an object.\n", is_error=True)
    meta_value = params.get("_meta", {})
    if not isinstance(meta_value, dict):
        return tool_result("tool call _meta must be an object.\n", is_error=True)
    meta = meta_value
    progress_token = meta.get("progressToken")
    if type(progress_token) not in {str, int, type(None)} or (
        isinstance(progress_token, str) and len(progress_token) > 256
    ):
        return tool_result("progressToken must be a string or integer of at most 256 characters.\n", is_error=True)
    previous_progress_token = CURRENT_PROGRESS_TOKEN
    CURRENT_PROGRESS_TOKEN = progress_token
    LAST_PROGRESS_AT = 0.0
    PROGRESS_SEQUENCE = 0

    try:
        for tname, tdesc, tschema, handler in _exposed_tool_registry():
            if tname == name:
                try:
                    args = validate_tool_arguments(tschema, raw_args)
                    return handler(args)
                except Exception as exc:
                    return tool_result_from_exception(exc)

        return tool_result(f"unknown tool: {name}\n", is_error=True)
    finally:
        CURRENT_PROGRESS_TOKEN = previous_progress_token


def handle_request(message: dict[str, Any]) -> None:
    message_id = message.get("id")
    method = message.get("method")
    params = message.get("params") or {}

    if message_id is None:
        return

    try:
        if method == "initialize":
            ensure_strict_preflight()
            requested = params.get("protocolVersion") if isinstance(params, dict) else None
            ok(
                message_id,
                {
                    "protocolVersion": requested or "2025-06-18",
                    "capabilities": {"tools": {}, "resources": {}},
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                    "instructions": capabilities_text(),
                },
            )
        elif method == "ping":
            ok(message_id, {})
        elif method == "tools/list":
            tools_list = []
            for tname, tdesc, tschema, _ in _exposed_tool_registry():
                tools_list.append({
                    "name": tname,
                    "description": tdesc,
                    "inputSchema": tschema,
                    "_meta": {
                        "cyberful.dev/tool-profile": {
                            "version": 1,
                            "roles": _fallback_tool_roles(tname),
                        }
                    },
                })
            ok(message_id, {"tools": tools_list})
        elif method == "tools/call":
            ok(message_id, handle_tool_call(params if isinstance(params, dict) else {}))
        elif method == "resources/list":
            ok(
                message_id,
                {
                    "resources": [
                        {
                            "uri": "mcp://cyberful-os/capabilities",
                            "name": "cyberful-os capabilities",
                            "description": "Full tool listing and container defaults.",
                            "mimeType": "text/markdown",
                        }
                    ]
                },
            )
        elif method == "resources/read":
            uri = params.get("uri") if isinstance(params, dict) else None
            if uri != "mcp://cyberful-os/capabilities":
                err(message_id, -32602, f"unknown resource: {uri}")
            else:
                ok(
                    message_id,
                    {
                        "contents": [
                            {
                                "uri": uri,
                                "mimeType": "text/markdown",
                                "text": capabilities_text(),
                            }
                        ]
                    },
                )
        elif method in {"prompts/list", "completion/complete"}:
            ok(message_id, {"prompts": []} if method == "prompts/list" else {"completion": {"values": []}})
        else:
            err(message_id, -32601, f"method not found: {method}")
    except Exception as exc:
        eprint(f"{method} failed: {type(exc).__name__}: {exc}")
        if method == "tools/call":
            ok(message_id, tool_result_from_exception(exc))
        else:
            err(message_id, -32000, str(exc))


def request_shutdown(_signum: int, _frame: FrameType | None) -> None:
    raise KeyboardInterrupt


# ── Stdio Framing Is Bounded Before JSON Decoding ────────────────────
# A client-controlled line is measured as bytes before UTF-8 or JSON parsing.
# Oversized input is discarded through its newline without retaining the tail,
# allowing the next request to proceed. Decoded batches receive a separate item
# cap so one compact frame cannot schedule unbounded sequential Docker work.
# Invalid framing remains a JSON-RPC error and never reaches a tool handler.
# ──────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class InputLine:
    text: str | None = None
    error: str | None = None


def bounded_json_lines(stream: BinaryIO, max_bytes: int = MAX_JSON_LINE_BYTES) -> Iterator[InputLine]:
    if type(max_bytes) is not int or max_bytes < 1:
        raise ValueError("max_bytes must be a positive integer")
    while True:
        raw = stream.readline(max_bytes + 1)
        if not raw:
            return
        has_newline = raw.endswith(b"\n")
        if len(raw) > max_bytes and not has_newline:
            while raw and not raw.endswith(b"\n"):
                raw = stream.readline(64 * 1024)
            yield InputLine(error=f"input line exceeds {max_bytes} bytes")
            continue
        payload = raw[:-1] if has_newline else raw
        if payload.endswith(b"\r"):
            payload = payload[:-1]
        try:
            yield InputLine(text=payload.decode("utf-8", errors="strict"))
        except UnicodeDecodeError:
            yield InputLine(error="input line is not valid UTF-8")


def request_envelope_error(message: Any) -> str | None:
    try:
        _validate_schema_value(message, {}, "request", 0, [0])
    except ValueError as exc:
        return str(exc).replace("invalid tool arguments at ", "invalid request at ", 1)
    if not isinstance(message, dict):
        return "request must be an object"
    if message.get("jsonrpc") != "2.0":
        return 'jsonrpc must equal "2.0"'
    method = message.get("method")
    if not isinstance(method, str) or not method or len(method) > 128:
        return "method must be a non-empty string of at most 128 characters"
    params = message.get("params")
    if "params" in message and not isinstance(params, dict):
        return "params must be an object"
    message_id = message.get("id")
    if "id" in message and message_id is not None and type(message_id) not in {str, int}:
        return "id must be a string, integer, null, or omitted"
    return None


def reject_nonfinite_json(value: str) -> None:
    raise ValueError(f"non-finite JSON number {value} is not allowed")


def main() -> int:
    if "--verify-capabilities" in sys.argv[1:]:
        return verify_local_capabilities()
    signal.signal(signal.SIGINT, request_shutdown)
    signal.signal(signal.SIGTERM, request_shutdown)
    eprint("stdio server started")
    try:
        for input_line in bounded_json_lines(sys.stdin.buffer):
            if input_line.error:
                eprint(input_line.error)
                err(None, -32600, input_line.error)
                continue
            line = (input_line.text or "").strip()
            if not line:
                continue
            try:
                message = json.loads(line, parse_constant=reject_nonfinite_json)
            except (json.JSONDecodeError, RecursionError, ValueError) as exc:
                eprint(f"invalid JSON: {exc}")
                err(None, -32700, "parse error")
                continue

            messages = message if isinstance(message, list) else [message]
            if not messages:
                err(None, -32600, "request batch must not be empty")
                continue
            if len(messages) > MAX_BATCH_REQUESTS:
                err(None, -32600, f"request batch exceeds {MAX_BATCH_REQUESTS} items")
                continue
            for item in messages:
                envelope_error = request_envelope_error(item)
                if envelope_error:
                    message_id = item.get("id") if isinstance(item, dict) else None
                    err(message_id, -32600, envelope_error)
                    continue
                handle_request(item)
    except KeyboardInterrupt:
        eprint("shutdown requested")
    finally:
        eprint("stdio closed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
