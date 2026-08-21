#!/usr/bin/env python3
# ── Embedded Pi Release Updater ─────────────────────────────────────────
# Resolves the latest Pi release, updates Cyberful's in-process dependencies,
# rebases its adapter patch, and installs a binary that attests that exact build.
# → cyberful/src/runtime-version.ts — exposes the private binary attestation.
# → cyberful/script/build.ts — performs the first embedded-version check.
# @docs/development/README.md
# ──────────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Final, cast


REPOSITORY_ROOT: Final = Path(__file__).resolve().parent.parent
ROOT_MANIFEST: Final = REPOSITORY_ROOT / "package.json"
CYBERFUL_MANIFEST: Final = REPOSITORY_ROOT / "cyberful" / "package.json"
BUN_LOCKFILE: Final = REPOSITORY_ROOT / "bun.lock"
PI_CODING_PACKAGE: Final = "@earendil-works/pi-coding-agent"
PI_AGENT_PACKAGE: Final = "@earendil-works/pi-agent-core"
PI_AI_PACKAGE: Final = "@earendil-works/pi-ai"
RUNTIME_VERSION_ARGUMENT: Final = "--cyberful-runtime-version"
SEMANTIC_VERSION: Final = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


class UpdateError(RuntimeError):
    """Reports an actionable update or verification failure."""


@dataclass(frozen=True)
class RepositoryState:
    agent_version: str
    ai_version: str
    ai_override: str
    patch_relative: Path


def log(message: str) -> None:
    print(f"[update-pi] {message}", file=sys.stderr, flush=True)


def command_environment() -> dict[str, str]:
    environment = dict(os.environ)
    environment.update(
        {
            "NO_UPDATE_NOTIFIER": "1",
            "NPM_CONFIG_AUDIT": "false",
            "NPM_CONFIG_FUND": "false",
            "NPM_CONFIG_UPDATE_NOTIFIER": "false",
            "PI_TELEMETRY": "0",
        }
    )
    return environment


def run(
    command: list[str],
    *,
    timeout_seconds: int,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            command,
            cwd=REPOSITORY_ROOT,
            env=command_environment(),
            stdin=subprocess.DEVNULL if capture else None,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
            check=False,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as error:
        raise UpdateError(f"command timed out after {timeout_seconds}s: {' '.join(command)}") from error
    except OSError as error:
        raise UpdateError(f"could not execute {command[0]}: {error}") from error

    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()[-4_096:]
        suffix = f": {detail}" if detail else ""
        raise UpdateError(f"command exited with status {result.returncode}: {' '.join(command)}{suffix}")
    return result


def load_object(path: Path) -> dict[str, object]:
    try:
        with path.open("r", encoding="utf-8", errors="strict") as handle:
            value: object = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise UpdateError(f"could not read JSON object {path}: {error}") from error
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise UpdateError(f"expected a JSON object in {path}")
    return cast(dict[str, object], value)


def require_mapping(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise UpdateError(f"expected object at {label}")
    return cast(dict[str, object], value)


def require_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise UpdateError(f"expected non-empty string at {label}")
    return value


def safe_patch_path(value: str) -> Path:
    relative = Path(value)
    if relative.is_absolute() or not relative.parts or relative.parts[0] != "patches" or ".." in relative.parts:
        raise UpdateError(f"unsafe pi-ai patch path: {value}")
    absolute = REPOSITORY_ROOT / relative
    if not absolute.is_file() or absolute.is_symlink():
        raise UpdateError(f"missing regular pi-ai patch: {value}")
    return relative


def repository_state() -> RepositoryState:
    root = load_object(ROOT_MANIFEST)
    cyberful = load_object(CYBERFUL_MANIFEST)
    dependencies = require_mapping(cyberful.get("dependencies"), "cyberful.dependencies")
    overrides = require_mapping(cyberful.get("overrides"), "cyberful.overrides")
    patched = require_mapping(root.get("patchedDependencies"), "patchedDependencies")
    pi_patches = [
        require_string(path, f"patchedDependencies.{key}")
        for key, path in patched.items()
        if key.startswith(f"{PI_AI_PACKAGE}@")
    ]
    if len(pi_patches) != 1:
        raise UpdateError("expected exactly one versioned pi-ai patch registration")
    return RepositoryState(
        agent_version=require_string(dependencies.get(PI_AGENT_PACKAGE), f"dependencies.{PI_AGENT_PACKAGE}"),
        ai_version=require_string(dependencies.get(PI_AI_PACKAGE), f"dependencies.{PI_AI_PACKAGE}"),
        ai_override=require_string(overrides.get(PI_AI_PACKAGE), f"overrides.{PI_AI_PACKAGE}"),
        patch_relative=safe_patch_path(pi_patches[0]),
    )


def write_json_atomic(path: Path, value: dict[str, object]) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", errors="strict", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        temporary.chmod(path.stat().st_mode & 0o777)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def latest_pi_version() -> str:
    latest = run(
        ["npm", "view", f"{PI_CODING_PACKAGE}@latest", "version"],
        timeout_seconds=30,
        capture=True,
    ).stdout.strip()
    if not SEMANTIC_VERSION.fullmatch(latest):
        raise UpdateError(f"npm returned an invalid latest Pi version: {latest}")
    for package in (PI_AGENT_PACKAGE, PI_AI_PACKAGE):
        published = run(
            ["npm", "view", f"{package}@{latest}", "version"],
            timeout_seconds=30,
            capture=True,
        ).stdout.strip()
        if published != latest:
            raise UpdateError(f"{package}@{latest} is not published")
    return latest


def target_patch_path(version: str) -> Path:
    return Path(f"patches/@earendil-works%2Fpi-ai@{version}.patch")


def prepare_manifests(version: str) -> None:
    root = load_object(ROOT_MANIFEST)
    cyberful = load_object(CYBERFUL_MANIFEST)
    dependencies = require_mapping(cyberful.get("dependencies"), "cyberful.dependencies")
    overrides = require_mapping(cyberful.get("overrides"), "cyberful.overrides")
    patched = require_mapping(root.get("patchedDependencies"), "patchedDependencies")

    dependencies[PI_AGENT_PACKAGE] = version
    dependencies[PI_AI_PACKAGE] = version
    overrides[PI_AI_PACKAGE] = version
    for key in tuple(patched):
        if key.startswith(f"{PI_AI_PACKAGE}@"):
            del patched[key]

    write_json_atomic(ROOT_MANIFEST, root)
    write_json_atomic(CYBERFUL_MANIFEST, cyberful)


# ── Patch Rebasing Is Transactional ─────────────────────────────────────────────
# A Pi release changes both package bytes and Bun's versioned patch identity.
# The prior reviewed diff is applied to an unpatched target package with the
# system patch engine, syntax-checked, then committed through Bun so the new
# diff has exact target context. Manifests, lockfile, and patch are backed up
# together; any failed install, rebase, or commit restores the complete set.
# ─────────────────────────────────────────────────────────────────────
def update_repository(state: RepositoryState, version: str) -> None:
    target_relative = target_patch_path(version)
    target_absolute = REPOSITORY_ROOT / target_relative
    current_absolute = REPOSITORY_ROOT / state.patch_relative
    if target_relative != state.patch_relative and target_absolute.exists():
        raise UpdateError(f"target patch already exists: {target_relative}")

    with tempfile.TemporaryDirectory(prefix="cyberful-update-pi-") as backup_name:
        backup = Path(backup_name)
        shutil.copy2(ROOT_MANIFEST, backup / "package.json")
        shutil.copy2(CYBERFUL_MANIFEST, backup / "cyberful-package.json")
        shutil.copy2(BUN_LOCKFILE, backup / "bun.lock")
        shutil.copy2(current_absolute, backup / "pi-ai.patch")
        try:
            prepare_manifests(version)
            if target_relative == state.patch_relative:
                current_absolute.unlink()
            log(f"installing the unpatched Pi {version} packages")
            run(["bun", "install"], timeout_seconds=600)
            log(f"rebasing Cyberful's Pi diagnostics patch onto {version}")
            run(["bun", "patch", f"{PI_AI_PACKAGE}@{version}"], timeout_seconds=120, capture=True)
            editable = REPOSITORY_ROOT / "node_modules" / PI_AI_PACKAGE
            run(
                [
                    "patch",
                    "-N",
                    "-t",
                    "-V",
                    "never",
                    "-d",
                    str(editable),
                    "-p1",
                    "-i",
                    str(backup / "pi-ai.patch"),
                ],
                timeout_seconds=60,
            )
            adapter = editable / "dist" / "api" / "openai-codex-responses.js"
            adapter.with_suffix(f"{adapter.suffix}.orig").unlink(missing_ok=True)
            adapter.with_suffix(f"{adapter.suffix}.rej").unlink(missing_ok=True)
            run(["node", "--check", str(adapter)], timeout_seconds=30, capture=True)
            run(
                ["bun", "patch", "--commit", f"node_modules/{PI_AI_PACKAGE}"],
                timeout_seconds=600,
                capture=True,
            )
            generated = repository_state().patch_relative
            if generated != target_relative or not target_absolute.is_file():
                raise UpdateError(f"Bun registered an unexpected pi-ai patch: {generated}")
            if current_absolute != target_absolute:
                current_absolute.unlink()
        except (Exception, KeyboardInterrupt):
            shutil.copy2(backup / "package.json", ROOT_MANIFEST)
            shutil.copy2(backup / "cyberful-package.json", CYBERFUL_MANIFEST)
            shutil.copy2(backup / "bun.lock", BUN_LOCKFILE)
            if target_absolute != current_absolute:
                target_absolute.unlink(missing_ok=True)
            shutil.copy2(backup / "pi-ai.patch", current_absolute)
            log("restored the original Pi manifests, patch, and lockfile after the failed update")
            try:
                run(["bun", "install", "--frozen-lockfile"], timeout_seconds=600, capture=True)
            except UpdateError as rollback_error:
                log(f"node_modules could not be rematerialized after rollback: {rollback_error}")
            raise


def package_version(directory: Path) -> str:
    manifest = load_object(directory / "package.json")
    return require_string(manifest.get("version"), f"{directory}/package.json.version")


def verify_local_runtime(version: str) -> None:
    state = repository_state()
    expected_patch = target_patch_path(version)
    if (
        state.agent_version != version
        or state.ai_version != version
        or state.ai_override != version
        or state.patch_relative != expected_patch
    ):
        raise UpdateError(
            f"repository Pi mismatch: agent={state.agent_version}, ai={state.ai_version}, "
            f"override={state.ai_override}, patch={state.patch_relative}"
        )

    agent_directory = REPOSITORY_ROOT / "cyberful" / "node_modules" / PI_AGENT_PACKAGE
    ai_directory = REPOSITORY_ROOT / "cyberful" / "node_modules" / PI_AI_PACKAGE
    if package_version(agent_directory) != version or package_version(ai_directory) != version:
        raise UpdateError("Bun materialized Pi packages that differ from the repository pins")
    adapter = ai_directory / "dist" / "api" / "openai-codex-responses.js"
    run(["node", "--check", str(adapter)], timeout_seconds=30, capture=True)
    try:
        adapter_text = adapter.read_text(encoding="utf-8", errors="strict")
    except OSError as error:
        raise UpdateError(f"could not inspect patched Pi adapter: {error}") from error
    for marker in ("provider_request_failure", "hasCodexCyberPolicy"):
        if marker not in adapter_text:
            raise UpdateError(f"the Cyberful pi-ai patch is missing marker: {marker}")


def decode_runtime_probe(raw: str, source: str) -> dict[str, str]:
    try:
        value: object = json.loads(raw)
    except json.JSONDecodeError as error:
        raise UpdateError(f"{source} returned invalid runtime-version JSON") from error
    payload = require_mapping(value, source)
    return {
        "piAgentCore": require_string(payload.get("piAgentCore"), f"{source}.piAgentCore"),
        "piAi": require_string(payload.get("piAi"), f"{source}.piAi"),
    }


# ── The Installed Binary Must Attest The Same In-Process Pi ───────────────────
# Cyberful imports Pi as libraries and never delegates AgentRun ownership to a
# global command. The build pipeline checks its freshly compiled host binary;
# this updater then invokes the separately installed file through a private
# version probe. Success requires both embedded packages to equal the registry
# release and proves that installation did not select a stale build artifact.
# ────────────────────────────────────────────────────────────────────
def verify_installed_binary(version: str) -> Path:
    executable_name = "cyberful.exe" if os.name == "nt" else "cyberful"
    installed = Path.home() / ".cyberful" / "bin" / executable_name
    if not installed.is_file():
        raise UpdateError(f"Cyberful installer did not create {installed}")
    probe = run([str(installed), RUNTIME_VERSION_ARGUMENT], timeout_seconds=60, capture=True)
    reported = decode_runtime_probe(probe.stdout.strip(), str(installed))
    expected = {"piAgentCore": version, "piAi": version}
    if reported != expected:
        raise UpdateError(f"installed Cyberful embeds {reported}, expected {expected}")
    run([str(installed), "--version"], timeout_seconds=60, capture=True)
    return installed


def required_tools() -> None:
    for executable in ("bun", "make", "node", "npm", "patch"):
        if shutil.which(executable) is None:
            raise UpdateError(f"required executable is not on PATH: {executable}")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Update only the Pi runtime embedded in Cyberful and attest the installed binary."
    )
    parser.add_argument("--dry-run", action="store_true", help="resolve latest and print intended changes")
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    required_tools()
    if not ROOT_MANIFEST.is_file() or not CYBERFUL_MANIFEST.is_file() or not BUN_LOCKFILE.is_file():
        raise UpdateError(f"script is not inside a complete Cyberful checkout: {REPOSITORY_ROOT}")

    current = repository_state()
    latest = latest_pi_version()
    target_patch = target_patch_path(latest)
    update_required = (
        current.agent_version != latest
        or current.ai_version != latest
        or current.ai_override != latest
        or current.patch_relative != target_patch
    )
    log(f"latest published Pi release: {latest}")
    if update_required:
        log(f"Cyberful Pi pins will move from agent={current.agent_version}, ai={current.ai_version} to {latest}")
    else:
        log("Cyberful already pins the latest Pi package family")

    if arguments.dry_run:
        action = "update manifests, rebase the patch, and regenerate bun.lock" if update_required else "verify the frozen Bun build"
        log(f"dry run: would {action}")
        log(f"dry run: would type-check, build, install, and attest Cyberful with embedded Pi {latest}")
        log("dry run: would not install, update, invoke, or link the global pi command")
        return 0

    if update_required:
        update_repository(current, latest)
    else:
        log(f"materializing Pi {latest} from the frozen Bun lockfile")
        run(["bun", "install", "--frozen-lockfile"], timeout_seconds=600)
    verify_local_runtime(latest)
    log(f"type-checking Cyberful against Pi {latest}")
    run(["make", "typecheck"], timeout_seconds=600)
    log(f"building and installing Cyberful with Pi {latest} embedded")
    run(["make", "install"], timeout_seconds=1_200)
    installed = verify_installed_binary(latest)
    log(f"verified {installed}: embedded pi-agent-core={latest}, pi-ai={latest}")
    log("the global pi command was not touched")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("[update-pi] interrupted", file=sys.stderr)
        raise SystemExit(130) from None
    except (UpdateError, OSError, ValueError) as error:
        print(f"[update-pi] error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
