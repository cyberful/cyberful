#!/usr/bin/env python3
# ── Unified Engagement Runtime Supervisor ─────────────────────────
# Owns optional ZAP and Ghidra children inside one engagement container while
#   leaving the privileged cyberful-os execution environment available.
# → cyberful/src/subsystem/engagement-runtime.ts — supplies validated service policy.
# @docs/runtimes/cyberful-os.md
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

RUN_DIRECTORY = Path("/run/cyberful")
SHUTDOWN_TIMEOUT_SECONDS = 10.0
VALID_BOOLEAN_VALUES = {"0": False, "1": True, "false": False, "true": True, "no": False, "yes": True}


@dataclass(frozen=True)
class Service:
    name: str
    command: tuple[str, ...]
    environment: dict[str, str]


def environment_boolean(name: str) -> bool:
    source = os.environ.get(name, "0").strip().lower()
    if source not in VALID_BOOLEAN_VALUES:
        raise ValueError(f"{name} must be one of: 1, true, yes, 0, false, no")
    return VALID_BOOLEAN_VALUES[source]


def runtime_identity() -> tuple[int, int]:
    uid_source = os.environ.get("CYBERFUL_RUNTIME_UID", "1000")
    gid_source = os.environ.get("CYBERFUL_RUNTIME_GID", "1000")
    if not uid_source.isdecimal() or not gid_source.isdecimal():
        raise ValueError("CYBERFUL_RUNTIME_UID and CYBERFUL_RUNTIME_GID must be decimal integers")
    uid = int(uid_source)
    gid = int(gid_source)
    if not 1 <= uid <= 2_147_483_647 or not 1 <= gid <= 2_147_483_647:
        raise ValueError("runtime UID and GID must be positive 32-bit integers")
    return uid, gid


def service_environment(overrides: dict[str, str]) -> dict[str, str]:
    environment = os.environ.copy()
    environment.update(overrides)
    return environment


def service_definitions(uid: int, gid: int) -> list[Service]:
    privilege = (
        "setpriv",
        f"--reuid={uid}",
        f"--regid={gid}",
        "--clear-groups",
        "--no-new-privs",
    )
    services: list[Service] = []
    if environment_boolean("CYBERFUL_ZAP_ENABLED"):
        zap_home = Path("/var/lib/cyberful/zap")
        zap_home.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chown(zap_home, uid, gid)
        services.append(
            Service(
                name="zap",
                command=(
                    *privilege,
                    "xvfb-run",
                    "--auto-servernum",
                    "--server-args=-screen 0 1280x1024x24 -nolisten tcp",
                    "/usr/local/bin/cyberful-zap",
                ),
                environment=service_environment({"HOME": str(zap_home)}),
            )
        )
    if environment_boolean("CYBERFUL_GHIDRA_ENABLED"):
        ghidra_home = Path(os.environ.get("CYBER_GHIDRA_STORE", "/ghidra/store")) / "home"
        ghidra_home.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chown(ghidra_home, uid, gid)
        services.append(
            Service(
                name="ghidra",
                command=(
                    *privilege,
                    "/opt/cyberful-os-venv/bin/python",
                    "/opt/cyberful/ghidra/ghidra_mcp.py",
                ),
                environment=service_environment({"HOME": str(ghidra_home)}),
            )
        )
    return services


def atomic_json(target: Path, payload: object) -> None:
    temporary = target.with_suffix(f"{target.suffix}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, target)


def write_state(service: str, state: str, *, pid: int | None = None, exit_code: int | None = None) -> dict[str, object]:
    payload: dict[str, object] = {"status": state}
    if pid is not None:
        payload["pid"] = pid
    if exit_code is not None:
        payload["exit_code"] = exit_code
    atomic_json(RUN_DIRECTORY / f"{service}.json", payload)
    return payload


def write_runtime_status(services: dict[str, dict[str, object]], status: str = "running") -> None:
    if any(service.get("status") in {"failed", "exited"} for service in services.values()):
        status = "degraded"
    atomic_json(
        RUN_DIRECTORY / "status.json",
        {"pid": os.getpid(), "services": services, "status": status},
    )


def terminate_children(children: dict[str, subprocess.Popen[bytes]]) -> None:
    for child in children.values():
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + SHUTDOWN_TIMEOUT_SECONDS
    for child in children.values():
        remaining = max(0.0, deadline - time.monotonic())
        try:
            child.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()


def service_is_healthy(name: str, environment: dict[str, str]) -> bool:
    if name == "zap":
        api_key = environment.get("CYBER_ZAP_API_KEY", "")
        if not api_key:
            return False
        request = urllib.request.Request(
            f"http://127.0.0.1:8080/JSON/core/view/version/?apikey={api_key}",
            headers={"Host": "zap"},
        )
        try:
            with urllib.request.urlopen(request, timeout=1) as response:
                return response.status == 200
        except (OSError, urllib.error.URLError):
            return False
    if name == "ghidra":
        try:
            with socket.create_connection(("127.0.0.1", 47100), timeout=1) as connection:
                key = environment.get("CYBER_GHIDRA_MCP_KEY", "")
                if not key:
                    return False
                connection.sendall(key.encode("utf-8") + b"\n")
                connection.sendall(b'{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
                response = connection.makefile("rb").readline(4096)
            parsed = json.loads(response)
            return parsed.get("id") == 1 and parsed.get("result") == {}
        except (OSError, ValueError, json.JSONDecodeError):
            return False
    return False


def main() -> int:
    try:
        uid, gid = runtime_identity()
        services = service_definitions(uid, gid)
    except (OSError, ValueError) as error:
        print(f"runtime supervisor configuration failed: {error}", file=sys.stderr)
        return 2

    RUN_DIRECTORY.mkdir(mode=0o755, parents=True, exist_ok=True)
    children: dict[str, subprocess.Popen[bytes]] = {}
    definitions: dict[str, Service] = {}
    states: dict[str, dict[str, object]] = {}
    next_healthcheck: dict[str, float] = {}
    stopping = False

    def request_shutdown(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, request_shutdown)
    signal.signal(signal.SIGTERM, request_shutdown)

    for service in services:
        try:
            child = subprocess.Popen(
                service.command,
                env=service.environment,
                stdin=subprocess.DEVNULL,
                stdout=None,
                stderr=None,
                shell=False,
                start_new_session=True,
            )
        except OSError as error:
            states[service.name] = write_state(service.name, "failed")
            print(f"{service.name} failed to start: {error}", file=sys.stderr)
            continue
        children[service.name] = child
        definitions[service.name] = service
        next_healthcheck[service.name] = time.monotonic()
        states[service.name] = write_state(service.name, "starting", pid=child.pid)

    write_state("runtime", "running", pid=os.getpid())
    write_runtime_status(states)
    try:
        while not stopping:
            for name, child in list(children.items()):
                exit_code = child.poll()
                if exit_code is None:
                    continue
                states[name] = write_state(name, "exited", pid=child.pid, exit_code=exit_code)
                write_runtime_status(states)
                print(f"{name} exited with status {exit_code}; automatic restart is disabled", file=sys.stderr)
                del children[name]
                next_healthcheck.pop(name, None)
            now = time.monotonic()
            for name, child in children.items():
                if states[name].get("status") != "starting" or now < next_healthcheck[name]:
                    continue
                next_healthcheck[name] = now + 1.0
                if service_is_healthy(name, definitions[name].environment):
                    states[name] = write_state(name, "ready", pid=child.pid)
                    write_runtime_status(states)
            time.sleep(0.25)
    finally:
        write_runtime_status(states, "stopping")
        terminate_children(children)
        for name, child in children.items():
            states[name] = write_state(name, "stopped", pid=child.pid, exit_code=child.returncode)
        write_state("runtime", "stopped", pid=os.getpid())
        write_runtime_status(states, "stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
