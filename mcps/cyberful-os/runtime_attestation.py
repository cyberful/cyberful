#!/usr/bin/env python3
# ── Unified Runtime Capability Attestation ────────────────────────
# Proves that one image contains the native Ghidra, ZAP, browser, bridge, and
#   supervisor components required before an engagement may start.
# → mcps/cyberful-os/Dockerfile — executes this contract during every image build.
# @docs/runtimes/cyberful-os.md
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

REQUIRED_ZAP_ADDONS = (
    "ascanrules",
    "spiderAjax",
    "authhelper",
    "graphql",
    "mcp",
    "oast",
    "openapi",
    "pscanrules",
    "reports",
    "websocket",
)


def command_succeeds(command: list[str]) -> bool:
    return subprocess.run(command, check=False, capture_output=True).returncode == 0


def expected_decompiler_directory() -> str:
    machine = platform.machine().lower()
    if machine in {"aarch64", "arm64"}:
        return "linux_arm_64"
    if machine in {"x86_64", "amd64"}:
        return "linux_x86_64"
    raise RuntimeError(f"unsupported runtime architecture: {machine}")


def report() -> dict[str, object]:
    decompiler = Path(
        "/usr/share/ghidra/Ghidra/Features/Decompiler/os",
        expected_decompiler_directory(),
        "decompile",
    )
    files = {
        "runtime_supervisor": Path("/opt/cyberful/runtime-supervisor"),
        "tls_canary": Path("/opt/cyberful/tls-canary"),
        "zap": Path("/zap/zap-x.sh"),
        "zap_distribution": Path("/zap", f"zap-{os.environ.get('CYBERFUL_ZAP_VERSION', '')}.jar"),
        "zap_bridge": Path("/opt/cyberful/zap/zap_bridge.mjs"),
        "ghidra_service": Path("/opt/cyberful/ghidra/ghidra_mcp.py"),
        "ghidra_bridge": Path("/opt/cyberful/ghidra/ghidra_bridge.py"),
        "ghidra_decompiler": decompiler,
        "native_security": Path("/opt/cyberful-os/native_security.py"),
    }
    commands = {
        name: shutil.which(name) or ""
        for name in (
            "bundle",
            "curl",
            "file",
            "firefox-esr",
            "gem",
            "git",
            "node",
            "openssl",
            "ruby",
            "tini",
            "Xvfb",
            "xvfb-run",
            "xauth",
            "xclip",
            "xxd",
            "7zz",
        )
    }
    missing = [name for name, path in files.items() if not path.is_file()]
    missing.extend(name for name, path in commands.items() if not path)
    plugin_directory = Path("/zap/plugin")
    missing.extend(
        f"zap-addon-{addon}"
        for addon in REQUIRED_ZAP_ADDONS
        if not next(plugin_directory.glob(f"{addon}-*.zap"), None)
    )
    try:
        importlib.import_module("pyghidra")
    except (ImportError, OSError, RuntimeError):
        missing.append("pyghidra")
    node_version = subprocess.run(
        [commands["node"], "--version"] if commands["node"] else ["false"],
        check=False,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if not node_version.startswith("v24."):
        missing.append("node-24")
    if decompiler.is_file() and commands.get("file"):
        description = subprocess.run(
            [commands["file"], str(decompiler)],
            check=False,
            capture_output=True,
            text=True,
        ).stdout
        expected_elf = "ARM aarch64" if expected_decompiler_directory() == "linux_arm_64" else "x86-64"
        if expected_elf not in description:
            missing.append("ghidra-decompiler-native-elf")
    elif decompiler.is_file():
        missing.append("file")
    checks = {
        "core_capabilities": command_succeeds(
            [sys.executable, "/opt/cyberful-os/cyberful_os_mcp.py", "--verify-capabilities"]
        ),
        "zap_bridge_syntax": bool(commands["node"])
        and command_succeeds([commands["node"], "--check", "/opt/cyberful/zap/zap_bridge.mjs"]),
        "ghidra_bridge_syntax": command_succeeds(
            [sys.executable, "-m", "py_compile", "/opt/cyberful/ghidra/ghidra_bridge.py"]
        ),
        "supervisor_syntax": command_succeeds(
            [sys.executable, "-m", "py_compile", "/opt/cyberful/runtime-supervisor"]
        ),
        "tls_canary_syntax": command_succeeds(
            [sys.executable, "-m", "py_compile", "/opt/cyberful/tls-canary"]
        ),
        "native_security_syntax": command_succeeds(
            [sys.executable, "-m", "py_compile", "/opt/cyberful-os/native_security.py"]
        ),
    }
    user_namespace = command_succeeds(["unshare", "--user", "--map-root-user", "true"])
    missing.extend(name.replace("_", "-") for name, passed in checks.items() if not passed)
    limitations = [] if user_namespace else [{
        "code": "USER_NAMESPACE_DENIED",
        "capability": "nested_user_namespace",
        "detail": "The host kernel or container runtime denied unshare --user --map-root-user.",
    }]
    return {
        "architecture": platform.machine(),
        "status": "available" if not missing else "unavailable",
        "missing": sorted(missing),
        "files": {name: str(path) for name, path in files.items()},
        "commands": commands,
        "checks": checks,
        "limitations": limitations,
        "user_namespace": {"available": user_namespace},
        "node_version": node_version,
    }


def main() -> int:
    result = report()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["status"] == "available" else 1


if __name__ == "__main__":
    raise SystemExit(main())
