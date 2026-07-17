#!/usr/bin/env python3
# ── cyberful-os Container Management CLI ───────────────────────────────
# Provides explicit status, image, lifecycle, shell, and log operations for the
# same named cyberful-os container and Docker endpoint used by the MCP server.
# → mcps/cyberful-os/cyberful_os_mcp.py — lazily owns this runtime during tool calls.
# ─────────────────────────────────────────────────────────────────────

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys

DEFAULT_IMAGE = "cyberful-os:latest"


# ── CLI Defaults Mirror The MCP Runtime ───────────────────────────────
# The management command and MCP server must resolve the same container name,
# image, workspace, and Docker endpoint. Both read the same environment contract,
# preventing `cyberful-os-container up` from creating a runtime the MCP server cannot
# find, mount, or safely reuse on its first tool call.
# ──────────────────────────────────────────────────────────────────────

def env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value else default


def run(argv: list[str], *, timeout_seconds: int | None = 120) -> int:
    print("+ " + " ".join(shlex.quote(part) for part in argv), file=sys.stderr)
    try:
        result = subprocess.run(
            argv,
            env=docker_environment(),
            stdin=None,
            stdout=None,
            stderr=None,
            timeout=timeout_seconds,
            check=False,
            shell=False,
            text=False,
        )
    except subprocess.TimeoutExpired:
        print(f"command timed out after {timeout_seconds}s", file=sys.stderr)
        return 124
    return result.returncode


# ── Failed Starts Release Their Deterministic Name ───────────────────
# Docker can register a named container before its runtime rejects startup.
# Both `docker start` and `docker run` therefore own a compensating forced
# removal when they fail. The original exit code remains the command result;
# cleanup diagnostics stay visible on stderr without turning failure into
# success or hiding that the named resource may still require attention.
# ─────────────────────────────────────────────────────────────────────

def run_container_start(argv: list[str], name: str) -> int:
    exit_code = run(argv)
    if exit_code == 0:
        return 0
    cleanup_code = run(["docker", "rm", "-f", name])
    if cleanup_code != 0:
        print(
            f"container startup exited with status {exit_code}; cleanup also exited with status {cleanup_code}",
            file=sys.stderr,
        )
    return exit_code


def default_docker_config() -> str:
    return os.path.join(
        env("XDG_STATE_HOME", os.path.join(os.path.expanduser("~"), ".local", "state")),
        "cyberful-os",
        "mcp",
        "cyberful-os",
        "docker-config",
    )


# ── Preserve The User's Docker Endpoint Choice ────────────────────────
# Docker Desktop's socket is only a fallback for local macOS setups. Explicit
# DOCKER_HOST, DOCKER_CONTEXT, or a configured non-default context must win.
# Applying that precedence once to every subprocess environment prevents a
# lifecycle command from silently switching Docker daemons between operations.
# ──────────────────────────────────────────────────────────────────────

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


def main(argv: list[str]) -> int:
    action = argv[1] if len(argv) > 1 else "status"
    name = env("CYBERFUL_OS_CONTAINER", "cyberful-os")
    image = env("CYBERFUL_OS_IMAGE", DEFAULT_IMAGE)
    workspace = os.path.abspath(env("CYBERFUL_OS_WORKSPACE", os.getcwd()))
    mount = env("CYBERFUL_OS_MOUNT", "/workspace")

    if action == "status":
        return run(["docker", "ps", "-a", "--filter", f"name=^{name}$"])
    if action == "pull":
        return run(["docker", "pull", image])
    if action == "up":
        run_new = [
            "docker", "run", "-d",
            "--name", name,
            "--hostname", name,
            "-w", mount,
            "-v", f"{workspace}:{mount}",
            "--cap-add=NET_ADMIN",
            "--cap-add=SYS_PTRACE",
            image,
            "sleep", "infinity",
        ]
        # ── Existing Names Must Match The Requested Image ────────────────
        # A deterministic container name can survive an earlier image build.
        # Starting it blindly would omit newly installed tools even though the
        # requested tag changed. Matching image identities permit reuse; a proven
        # mismatch removes the stale container before normal creation continues.
        # Each probe captures only one fixed-format identity field for one named
        # object; diagnostics are discarded rather than retained without a bound.
        # ──────────────────────────────────────────────────────────────────────
        existing = subprocess.run(
            ["docker", "container", "inspect", "--format", "{{.Image}}", name],
            env=docker_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=30,
            check=False,
            shell=False,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if existing.returncode == 0:
            current = subprocess.run(
                ["docker", "image", "inspect", "--format", "{{.Id}}", image],
                env=docker_environment(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=30,
                check=False,
                shell=False,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            if current.returncode == 0 and existing.stdout.strip() == current.stdout.strip():
                return run_container_start(["docker", "start", name], name)
            run(["docker", "rm", "-f", name])
        return run_container_start(run_new, name)
    if action == "shell":
        # The interactive terminal owns this process until the user exits it.
        return run(["docker", "exec", "-it", "-w", mount, name, "/bin/bash"], timeout_seconds=None)
    if action == "down":
        return run(["docker", "stop", name])
    if action == "rm":
        return run(["docker", "rm", "-f", name])
    if action == "logs":
        return run(["docker", "logs", name])

    print("usage: cyberful-os-container [status|pull|up|shell|down|rm|logs]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
