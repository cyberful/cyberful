#!/usr/bin/env python3
# ── Native Security Laboratory Operations ───────────────────────────
# Implements bounded firmware, debugger, crash, fuzzing, diff, protocol,
#   fingerprint, and native-static workflows inside an engagement-owned runtime.
# → mcps/cyberful-os/cyberful_os_mcp.py — publishes these operations through MCP.
# ─────────────────────────────────────────────────────────────────────

from __future__ import annotations

import bz2
import gzip
import hashlib
import ipaddress
import json
import lzma
import os
import re
import select
import selectors
import shutil
import signal
import socket
import stat
import tarfile
import tempfile
import threading
import subprocess
import time
import urllib.request
import urllib.parse
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

WORKSPACE = Path(os.environ.get("CYBERFUL_OS_MOUNT", "/workspace")).resolve()
STATE = WORKSPACE / "raw" / "native-security"
LABS = WORKSPACE / ".cyberful-native" / "labs"
SNAPSHOTS = WORKSPACE / ".cyberful-native" / "snapshots"
IDENTIFIER = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$")
PROCESSES: dict[str, subprocess.Popen[bytes]] = {}
DEBUGGERS: dict[str, subprocess.Popen[str]] = {}
DEBUGGER_STATES: dict[str, dict[str, Any]] = {}
FIREFOX_SESSIONS: dict[str, dict[str, Any]] = {}
CLIPBOARD_OWNERS: dict[str, subprocess.Popen[bytes]] = {}
PROCESS_META: dict[str, dict[str, Any]] = {}
DEBUGGER_LOCK = threading.RLock()
MAX_FILES = 20_000
MAX_CAPTURE = 2 * 1024 * 1024
MAX_ARCHIVE_FILE_SIZE = MAX_CAPTURE * 128
CPP_SOURCE_SUFFIXES = frozenset({".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".ixx", ".cppm"})


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError(f"{label} must match {IDENTIFIER.pattern}")
    return value


def _path(value: Any, *, exists: bool = False) -> Path:
    if not isinstance(value, str) or not value:
        raise ValueError("path must be a non-empty string")
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = WORKSPACE / candidate
    candidate = candidate.resolve(strict=exists)
    if candidate != WORKSPACE and WORKSPACE not in candidate.parents:
        raise ValueError("path must remain inside /workspace")
    return candidate


def _argv(value: Any) -> list[str]:
    if not isinstance(value, list) or not value or len(value) > 256:
        raise ValueError("argv must be a non-empty array with at most 256 items")
    if not all(isinstance(item, str) and item and "\0" not in item for item in value):
        raise ValueError("argv entries must be non-empty strings without NUL")
    return list(value)


def _run(
    argv: list[str],
    cwd: Path | None = None,
    timeout: int = 120,
    stdin: bytes | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    if timeout < 1 or timeout > 3600:
        raise ValueError("timeout_seconds must be between 1 and 3600")
    result = subprocess.run(
        argv,
        cwd=str(cwd or WORKSPACE),
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
        env=env,
    )
    stdout = result.stdout[:MAX_CAPTURE].decode("utf-8", "replace")
    stderr = result.stderr[:MAX_CAPTURE].decode("utf-8", "replace")
    return {"argv": argv, "exit_code": result.returncode, "stdout": stdout, "stderr": stderr}


def _command(name: str) -> str:
    resolved = shutil.which(name)
    if not resolved:
        raise ValueError(f"required command is unavailable: {name}")
    return resolved


def _process_state(proc: subprocess.Popen[Any]) -> str:
    code = proc.poll()
    return "running" if code is None else "exited"


def _record(family: str, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    directory = STATE / family
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = f"{int(time.time() * 1000)}-{operation}.json"
    target = directory / stamp
    target.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    target.chmod(0o600)
    return {**payload, "evidence_path": str(target.relative_to(WORKSPACE))}


def _manifest(root: Path) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    for candidate in sorted(root.rglob("*")):
        if len(files) >= MAX_FILES:
            break
        if not candidate.is_file() or candidate.is_symlink():
            continue
        digest = hashlib.sha256()
        with candidate.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        files.append({"path": str(candidate.relative_to(root)), "size": candidate.stat().st_size, "sha256": digest.hexdigest()})
    return files


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def firmware_lab(args: dict[str, Any]) -> dict[str, Any]:
    operation = args["operation"]
    lab_id = _identifier(args.get("lab_id", "firmware"), "lab_id")
    root = LABS / lab_id / "firmware"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if operation == "import":
        source = _path(args.get("path"), exists=True)
        if not source.is_file():
            raise ValueError("firmware import path must be a file")
        target = root / "input" / source.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        return _record("firmware", operation, {"lab_id": lab_id, "path": str(target.relative_to(WORKSPACE))})
    source = _path(args.get("path", str(root)), exists=True)
    if operation == "identify":
        return _record("firmware", operation, {"lab_id": lab_id, "result": _run(["file", "-b", str(source)])})
    if operation == "unpack":
        output = root / "unpacked"
        output.mkdir(parents=True, exist_ok=True)
        result = _run(["unblob", str(source), "--extract-dir", str(output)], timeout=int(args.get("timeout_seconds", 600)))
        if result["exit_code"] != 0:
            result = _run(["binwalk", "--extract", "--directory", str(output), str(source)], timeout=int(args.get("timeout_seconds", 600)))
        return _record("firmware", operation, {"lab_id": lab_id, "output": str(output.relative_to(WORKSPACE)), "result": result})
    if operation in {"manifest", "checkpoint"}:
        files = _manifest(source)
        return _record("firmware", operation, {"lab_id": lab_id, "root": str(source.relative_to(WORKSPACE)), "files": files, "truncated": len(files) >= MAX_FILES})
    if operation == "diff":
        other = _path(args.get("other_path"), exists=True)
        left = {item["path"]: item["sha256"] for item in _manifest(source)}
        right = {item["path"]: item["sha256"] for item in _manifest(other)}
        return _record("firmware", operation, {"lab_id": lab_id, "added": sorted(right.keys() - left.keys()), "removed": sorted(left.keys() - right.keys()), "changed": sorted(key for key in left.keys() & right.keys() if left[key] != right[key])})
    pattern = r"(?:/etc/init\.d|systemd|inetd|lighttpd|nginx|apache|dropbear|sshd|telnetd|httpd)" if operation == "find_services" else r"(?:cgi-bin|/api/|route|listen|socket|port)"
    result = _run(["rg", "-n", "-i", "--max-count", "200", pattern, str(source)], timeout=int(args.get("timeout_seconds", 120)))
    return _record("firmware", operation, {"lab_id": lab_id, "result": result})


# ── Harnesses Fail Before They Become Processes ────────────────────
# Parse-only checks cover shell and JavaScript without executing either file.
# Native binaries are checked for architecture, ELF ABI, dependencies, symbols,
# and optional build identity. Source harnesses compile against their real headers;
# callers cannot replace opaque structures with guessed storage declarations.
# ─────────────────────────────────────────────────────────────────────
def harness_validate(args: dict[str, Any]) -> dict[str, Any]:
    operation = args["operation"]
    source = _path(args.get("path"), exists=True)
    timeout = int(args.get("timeout_seconds", 120))
    checks: list[dict[str, Any]] = []
    if operation == "shell":
        shell = str(args.get("shell", "bash"))
        command = _command(shell) if "/" not in shell else str(Path(shell).resolve(strict=True))
        if not Path(command).is_file() or not os.access(command, os.X_OK):
            raise ValueError("selected shell must be an executable file")
        checks.append({"name": "shell_parse", **_run([command, "-n", str(source)], timeout=timeout)})
    elif operation == "javascript":
        checks.append({"name": "javascript_parse", **_run([_command("node"), "--check", str(source)], timeout=timeout)})
    elif operation == "native_source":
        compiler = str(args.get("compiler", "cc"))
        command = _command(compiler) if "/" not in compiler else str(Path(compiler).resolve(strict=True))
        if not Path(command).is_file() or not os.access(command, os.X_OK):
            raise ValueError("selected compiler must be an executable file")
        include_dirs = args.get("include_dirs", [])
        if not isinstance(include_dirs, list) or not all(isinstance(item, str) for item in include_dirs):
            raise ValueError("include_dirs must be an array of paths")
        argv = [command, "-fsyntax-only", *[f"-I{_path(item, exists=True)}" for item in include_dirs], str(source)]
        checks.append({"name": "native_source_compile", **_run(argv, timeout=timeout)})
    else:
        if not source.is_file():
            raise ValueError("native executable validation requires a regular file")
        header = _run([_command("readelf"), "-h", str(source)], timeout=timeout)
        dependencies = _run([_command("ldd"), str(source)], timeout=timeout)
        if dependencies["exit_code"] != 0 and "not a dynamic executable" in (dependencies["stdout"] + dependencies["stderr"]).lower():
            dependencies = {**dependencies, "exit_code": 0, "static": True}
        symbols = _run([_command("nm"), "-D", "--defined-only", str(source)], timeout=timeout)
        checks.extend([
            {"name": "elf_header", **header},
            {"name": "dynamic_dependencies", **dependencies},
            {"name": "dynamic_symbols", **symbols},
        ])
        expected_arch = args.get("expected_architecture")
        if expected_arch is not None and str(expected_arch).lower() not in header["stdout"].lower():
            checks.append({"name": "expected_architecture", "exit_code": 1, "expected": str(expected_arch)})
        required_symbols = args.get("required_symbols", [])
        if not isinstance(required_symbols, list) or not all(isinstance(item, str) and item for item in required_symbols):
            raise ValueError("required_symbols must be an array of non-empty strings")
        missing_symbols = [item for item in required_symbols if re.search(rf"\b{re.escape(item)}(?:@@?\S+)?$", symbols["stdout"], re.M) is None]
        checks.append({"name": "required_symbols", "exit_code": 0 if not missing_symbols else 1, "missing": missing_symbols})
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        expected_identity = args.get("expected_build_sha256")
        checks.append({
            "name": "build_identity",
            "exit_code": 0 if expected_identity is None or expected_identity == digest else 1,
            "sha256": digest,
            **({"expected": expected_identity} if expected_identity is not None else {}),
        })
    valid = all(check.get("exit_code") == 0 for check in checks)
    return _record("harness", operation, {
        "operation": operation,
        "path": str(source.relative_to(WORKSPACE)),
        "valid": valid,
        "checks": checks,
    })


def _automatic_harness_validation(argv: list[str], timeout: int) -> dict[str, Any] | None:
    executable = Path(argv[0])
    if not executable.is_absolute():
        resolved = shutil.which(argv[0])
        executable = Path(resolved) if resolved else executable
    if executable.name in {"bash", "sh", "zsh"} and len(argv) > 1:
        return harness_validate({"operation": "shell", "path": argv[1], "shell": str(executable), "timeout_seconds": timeout})
    if executable.name in {"node", "nodejs"} and len(argv) > 1:
        return harness_validate({"operation": "javascript", "path": argv[1], "timeout_seconds": timeout})
    try:
        bounded = _path(str(executable), exists=True)
    except (ValueError, FileNotFoundError):
        return None
    with bounded.open("rb") as handle:
        header = handle.read(4)
    if bounded.is_file() and header == b"\x7fELF":
        return harness_validate({"operation": "native_executable", "path": str(bounded), "timeout_seconds": timeout})
    return None


# ── Multi-Format Archives Publish Only Complete Safe Trees ─────────
# Signatures, rather than attacker-controlled suffixes, select ZIP, TAR-family,
# single-stream compression, or the bounded native 7-Zip path. TAR members are
# copied directly without links, devices, traversal, or inherited permissions.
# Every engine writes a fresh temporary tree that is validated before an atomic
# rename publishes it, so failures cannot leave a plausible partial result.
# ─────────────────────────────────────────────────────────────────────
def _archive_timeout(args: dict[str, Any]) -> int:
    timeout = int(args.get("timeout_seconds", 300))
    if timeout < 1 or timeout > 3600:
        raise ValueError("timeout_seconds must be between 1 and 3600")
    return timeout


def _archive_member_path(name: str) -> Path:
    if not name or "\0" in name:
        raise ValueError("archive contains an empty or NUL-bearing member path")
    portable = name.replace("\\", "/")
    member = PurePosixPath(portable)
    if member.is_absolute() or re.match(r"^[A-Za-z]:", portable) or ".." in member.parts:
        raise ValueError(f"archive member escapes its destination: {name}")
    parts = tuple(part for part in member.parts if part not in {"", "."})
    if not parts:
        return Path(".")
    return Path(*parts)


def _archive_format(source: Path) -> tuple[str, int]:
    with source.open("rb") as handle:
        header = handle.read(1024 * 1024)
    prefix = header.find(b"PK\x03\x04")
    if prefix == 0 or header.startswith((b"PK\x05\x06", b"PK\x07\x08")):
        return "zip", max(prefix, 0)
    try:
        with tarfile.open(source, "r:*") as archive:
            archive.next()
        if header.startswith(b"\x1f\x8b"):
            return "tar.gz", 0
        if header.startswith(b"BZh"):
            return "tar.bz2", 0
        if header.startswith(b"\xfd7zXZ\x00"):
            return "tar.xz", 0
        return "tar", 0
    except (tarfile.TarError, OSError, EOFError):
        pass
    if prefix > 0:
        return "zip", prefix
    signatures = (
        (b"7z\xbc\xaf'\x1c", "7z"),
        (b"Rar!\x1a\x07", "rar"),
        (b"MSCF", "cab"),
        (b"!<arch>\n", "ar"),
        (b"\x28\xb5\x2f\xfd", "tar.zst"),
        (b"\x1f\x8b", "gzip"),
        (b"BZh", "bzip2"),
        (b"\xfd7zXZ\x00", "xz"),
    )
    for signature, format_name in signatures:
        if header.startswith(signature):
            return format_name, 0
    raise ValueError("unsupported or malformed archive format")


def _archive_result(engine: str, detail: str) -> dict[str, Any]:
    return {
        "argv": [f"python:{engine}"],
        "exit_code": 0,
        "stdout": detail,
        "stderr": "",
    }


def _tar_entries(source: Path, deadline: float) -> tuple[list[tarfile.TarInfo], list[dict[str, Any]]]:
    members: list[tarfile.TarInfo] = []
    entries: list[dict[str, Any]] = []
    seen: set[Path] = set()
    try:
        with tarfile.open(source, "r:*") as archive:
            for member in archive:
                if time.monotonic() > deadline:
                    raise ValueError("archive operation exceeded timeout_seconds")
                if len(members) >= MAX_FILES:
                    raise ValueError("archive exceeds its entry safety bound")
                relative = _archive_member_path(member.name)
                if relative in seen and relative != Path("."):
                    raise ValueError(f"archive contains a duplicate member path: {member.name}")
                if not member.isdir() and not member.isreg():
                    raise ValueError(f"archive contains a link or special member: {member.name}")
                if member.isreg() and member.size > MAX_ARCHIVE_FILE_SIZE:
                    raise ValueError("archive extraction exceeds its per-file safety bound")
                seen.add(relative)
                members.append(member)
                entries.append({"path": str(relative), "size": member.size, "type": "directory" if member.isdir() else "file"})
    except (tarfile.TarError, OSError, EOFError) as error:
        raise ValueError(f"archive inspection failed with tarfile: {error}") from error
    return members, entries


def _extract_tar(source: Path, destination: Path, members: list[tarfile.TarInfo], deadline: float) -> None:
    try:
        with tarfile.open(source, "r:*") as archive:
            for member in members:
                if time.monotonic() > deadline:
                    raise ValueError("archive operation exceeded timeout_seconds")
                relative = _archive_member_path(member.name)
                target = destination / relative
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                reader = archive.extractfile(member)
                if reader is None:
                    raise ValueError(f"archive member could not be read: {member.name}")
                written = 0
                with reader, target.open("xb") as output:
                    while chunk := reader.read(1024 * 1024):
                        written += len(chunk)
                        if written > MAX_ARCHIVE_FILE_SIZE:
                            raise ValueError("archive extraction exceeds its per-file safety bound")
                        if time.monotonic() > deadline:
                            raise ValueError("archive operation exceeded timeout_seconds")
                        output.write(chunk)
                if written != member.size:
                    raise ValueError(f"archive member size changed during extraction: {member.name}")
    except (tarfile.TarError, OSError, EOFError) as error:
        raise ValueError(f"archive extraction failed with tarfile: {error}") from error


def _stream_name(source: Path, format_name: str) -> str:
    suffixes = {"gzip": ".gz", "bzip2": ".bz2", "xz": ".xz"}
    name = source.name
    suffix = suffixes[format_name]
    if name.lower().endswith(suffix):
        name = name[:-len(suffix)]
    return name or "content"


def _consume_stream(source: Path, format_name: str, deadline: float, target: Path | None = None) -> int:
    openers = {"gzip": gzip.open, "bzip2": bz2.open, "xz": lzma.open}
    written = 0
    output = None
    try:
        if target is not None:
            output = target.open("xb")
        with openers[format_name](source, "rb") as reader:
            while chunk := reader.read(1024 * 1024):
                written += len(chunk)
                if written > MAX_ARCHIVE_FILE_SIZE:
                    raise ValueError("archive extraction exceeds its per-file safety bound")
                if time.monotonic() > deadline:
                    raise ValueError("archive operation exceeded timeout_seconds")
                if output is not None:
                    output.write(chunk)
    except (OSError, EOFError, lzma.LZMAError) as error:
        raise ValueError(f"archive stream failed with {format_name}: {error}") from error
    finally:
        if output is not None:
            output.close()
    return written


def _extract_stream(source: Path, destination: Path, format_name: str, deadline: float) -> list[dict[str, Any]]:
    target = destination / _stream_name(source, format_name)
    written = _consume_stream(source, format_name, deadline, target)
    return [{"path": target.name, "size": written}]


def _seven_zip_entries(listing: dict[str, Any]) -> list[dict[str, Any]]:
    if listing["exit_code"] != 0:
        raise ValueError(f"archive inspection failed with 7zz: {listing['stderr'] or listing['stdout']}")
    if len(listing["stdout"].encode("utf-8")) >= MAX_CAPTURE:
        raise ValueError("archive listing exceeds its output safety bound")
    body = listing["stdout"].split("----------", 1)[-1]
    entries: list[dict[str, Any]] = []
    seen: set[Path] = set()
    for block in re.split(r"\n\s*\n", body.strip()):
        properties = dict(line.split(" = ", 1) for line in block.splitlines() if " = " in line)
        name = properties.get("Path")
        if not name:
            continue
        relative = _archive_member_path(name)
        if relative in seen:
            raise ValueError(f"archive contains a duplicate member path: {name}")
        attributes = properties.get("Attributes", "")
        if "Symbolic Link" in properties or "Hard Link" in properties or re.search(r"(?:^|\s)l[rwx-]{9}(?:\s|$)", attributes):
            raise ValueError(f"archive contains a link member: {name}")
        try:
            size = int(properties.get("Size", "0"))
        except ValueError as error:
            raise ValueError(f"archive contains an invalid member size: {name}") from error
        if size < 0 or size > MAX_ARCHIVE_FILE_SIZE:
            raise ValueError("archive extraction exceeds its per-file safety bound")
        if len(entries) >= MAX_FILES:
            raise ValueError("archive exceeds its entry safety bound")
        entries.append({"path": str(relative), "size": size, "type": "directory" if attributes.startswith("D") else "file"})
        seen.add(relative)
    return entries


def _zip_entries(source: Path) -> list[dict[str, Any]] | None:
    entries: list[dict[str, Any]] = []
    seen: set[Path] = set()
    try:
        with zipfile.ZipFile(source) as archive:
            for member in archive.infolist():
                if len(entries) >= MAX_FILES:
                    raise ValueError("archive exceeds its entry safety bound")
                relative = _archive_member_path(member.filename)
                if relative in seen:
                    raise ValueError(f"archive contains a duplicate member path: {member.filename}")
                mode = member.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise ValueError(f"archive contains a link member: {member.filename}")
                if member.file_size > MAX_ARCHIVE_FILE_SIZE:
                    raise ValueError("archive extraction exceeds its per-file safety bound")
                entries.append({"path": str(relative), "size": member.file_size, "type": "directory" if member.is_dir() else "file"})
                seen.add(relative)
    except (zipfile.BadZipFile, zipfile.LargeZipFile):
        return None
    return entries


def _expand_tar_zstd(
    source: Path,
    destination: Path,
    deadline: float,
) -> tuple[dict[str, Any], Path, list[tarfile.TarInfo], list[dict[str, Any]]]:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ValueError("archive operation exceeded timeout_seconds")
    result = _run([_command("7zz"), "x", "-y", f"-o{destination}", str(source)], timeout=max(1, int(remaining)))
    if result["exit_code"] != 0:
        raise ValueError(f"archive extraction failed with 7zz: {result['stderr'] or result['stdout']}")
    compressed_files = _safe_archive_tree(destination)
    if len(compressed_files) != 1:
        raise ValueError("tar.zst expansion must produce exactly one TAR stream")
    inner = destination / compressed_files[0]["path"]
    members, entries = _tar_entries(inner, deadline)
    return result, inner, members, entries


def _safe_archive_tree(root: Path) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    for candidate in sorted(root.rglob("*")):
        if candidate.is_symlink():
            raise ValueError("archive extraction produced a symbolic link")
        if candidate.is_dir():
            continue
        if not candidate.is_file():
            raise ValueError("archive extraction produced a special file")
        relative = candidate.relative_to(root)
        if len(files) >= MAX_FILES or candidate.stat().st_size > MAX_ARCHIVE_FILE_SIZE:
            raise ValueError("archive extraction exceeds its file or per-file safety bound")
        files.append({"path": str(relative), "size": candidate.stat().st_size})
    return files


def archive_extract(args: dict[str, Any]) -> dict[str, Any]:
    operation = args["operation"]
    source = _path(args.get("path"), exists=True)
    if not source.is_file():
        raise ValueError("archive path must be a regular file")
    timeout = _archive_timeout(args)
    deadline = time.monotonic() + timeout
    format_name, prefix = _archive_format(source)
    if format_name.startswith("tar") and format_name != "tar.zst":
        members, entries = _tar_entries(source, deadline)
        if operation == "inspect":
            result = _archive_result("tarfile", f"{len(entries)} archive entries inspected")
            return _record("archives", operation, {
                "path": str(source.relative_to(WORKSPACE)),
                "format": format_name,
                "prepended_bytes": 0,
                "engine": "tarfile",
                "entries_preview": entries[:500],
                "truncated": len(entries) > 500,
                "result": result,
            })
        return _extract_archive_to_output(args, source, format_name, prefix, "tarfile", deadline, members=members)
    if format_name in {"gzip", "bzip2", "xz"}:
        if operation == "inspect":
            size = _consume_stream(source, format_name, deadline)
            entry = {"path": _stream_name(source, format_name), "size": size, "type": "file"}
            result = _archive_result(format_name, "single compressed stream inspected")
            return _record("archives", operation, {
                "path": str(source.relative_to(WORKSPACE)),
                "format": format_name,
                "prepended_bytes": 0,
                "engine": format_name,
                "entries_preview": [entry],
                "truncated": False,
                "result": result,
            })
        return _extract_archive_to_output(args, source, format_name, prefix, format_name, deadline)
    if format_name in {"7z", "rar", "cab", "ar", "tar.zst"}:
        listing = _run([_command("7zz"), "l", "-slt", str(source)], timeout=timeout)
        entries = _seven_zip_entries(listing)
        if operation == "inspect":
            engine = "7zz"
            result = listing
            if format_name == "tar.zst":
                temporary = Path(tempfile.mkdtemp(prefix=".cyberful-archive-", dir=source.parent))
                try:
                    expansion, _inner, _members, entries = _expand_tar_zstd(source, temporary, deadline)
                    result = {**listing, "inner_expansion": expansion}
                    engine = "7zz+tarfile"
                finally:
                    shutil.rmtree(temporary)
            return _record("archives", operation, {
                "path": str(source.relative_to(WORKSPACE)),
                "format": format_name,
                "prepended_bytes": 0,
                "engine": engine,
                "entries_preview": entries[:500],
                "truncated": len(entries) > 500,
                "result": result,
            })
        return _extract_archive_to_output(args, source, format_name, prefix, "7zz", deadline, listing=listing)
    entries = _zip_entries(source)
    validation_listing = None
    if entries is None:
        validation_listing = _run([_command("7zz"), "l", "-slt", str(source)], timeout=timeout)
        entries = _seven_zip_entries(validation_listing)
    if operation == "inspect":
        ordinary = _run([_command("unzip"), "-Z1", str(source)], timeout=timeout)
        engine = "unzip"
        listing = ordinary
        if prefix > 0 or ordinary["exit_code"] == 2:
            listing = validation_listing or _run([_command("7zz"), "l", "-slt", str(source)], timeout=timeout)
            engine = "7zz"
        return _record("archives", operation, {
            "path": str(source.relative_to(WORKSPACE)),
            "format": format_name,
            "prepended_bytes": prefix,
            "engine": engine,
            "entries_preview": entries[:500],
            "truncated": len(entries) > 500,
            "result": listing,
        })
    return _extract_archive_to_output(args, source, format_name, prefix, "zip", deadline)


def _extract_archive_to_output(
    args: dict[str, Any],
    source: Path,
    format_name: str,
    prefix: int,
    engine: str,
    deadline: float,
    *,
    members: list[tarfile.TarInfo] | None = None,
    listing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    output = _path(args.get("output"))
    if output.exists():
        raise ValueError("archive output must not already exist")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".cyberful-archive-", dir=output.parent))
    try:
        timeout = max(1, int(deadline - time.monotonic()))
        if engine == "tarfile":
            if members is None:
                raise ValueError("archive TAR inventory is unavailable")
            _extract_tar(source, temporary, members, deadline)
            result = _archive_result("tarfile", f"{len(members)} archive entries extracted")
        elif engine in {"gzip", "bzip2", "xz"}:
            files = _extract_stream(source, temporary, engine, deadline)
            result = _archive_result(engine, "single compressed stream extracted")
        elif engine == "7zz":
            if listing is None:
                raise ValueError("archive 7-Zip inventory is unavailable")
            _seven_zip_entries(listing)
            if format_name == "tar.zst":
                result, inner, inner_members, _entries = _expand_tar_zstd(source, temporary, deadline)
                expanded = Path(tempfile.mkdtemp(prefix=".cyberful-archive-", dir=output.parent))
                try:
                    _extract_tar(inner, expanded, inner_members, deadline)
                except BaseException:
                    shutil.rmtree(expanded)
                    raise
                shutil.rmtree(temporary)
                temporary = expanded
                engine = "7zz+tarfile"
            else:
                result = _run([_command("7zz"), "x", "-y", f"-o{temporary}", str(source)], timeout=timeout)
                if result["exit_code"] != 0:
                    raise ValueError(f"archive extraction failed with 7zz: {result['stderr'] or result['stdout']}")
        else:
            result = _run([_command("unzip"), "-qq", str(source), "-d", str(temporary)], timeout=timeout)
            engine = "unzip"
            if prefix > 0 or result["exit_code"] == 2:
                shutil.rmtree(temporary)
                temporary = Path(tempfile.mkdtemp(prefix=".cyberful-archive-", dir=output.parent))
                result = _run([_command("7zz"), "x", "-y", f"-o{temporary}", str(source)], timeout=timeout)
                engine = "7zz"
            if result["exit_code"] != 0:
                raise ValueError(f"archive extraction failed with {engine}: {result['stderr'] or result['stdout']}")
        files = files if engine in {"gzip", "bzip2", "xz"} else _safe_archive_tree(temporary)
        os.replace(temporary, output)
        return _record("archives", "extract", {
            "path": str(source.relative_to(WORKSPACE)),
            "output": str(output.relative_to(WORKSPACE)),
            "format": format_name,
            "prepended_bytes": prefix,
            "engine": engine,
            "files": files,
            "result": result,
        })
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def native_lab(args: dict[str, Any]) -> dict[str, Any]:
    operation = args["operation"]
    lab_id = _identifier(args.get("lab_id", "native"), "lab_id")
    root = LABS / lab_id
    if operation == "create":
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        unshare = shutil.which("unshare")
        namespace = (
            _run([unshare, "--user", "--map-root-user", "true"], timeout=10)
            if unshare
            else {"argv": ["unshare"], "exit_code": 127, "stdout": "", "stderr": "unshare is unavailable"}
        )
        return _record("labs", operation, {
            "lab_id": lab_id,
            "root": str(root.relative_to(WORKSPACE)),
            "user_namespace": {
                "available": namespace["exit_code"] == 0,
                "limitation": None if namespace["exit_code"] == 0 else {
                    "code": "USER_NAMESPACE_DENIED",
                    "detail": (namespace["stderr"] or namespace["stdout"]).strip(),
                },
            },
        })
    if operation == "start_process":
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        process_id = _identifier(args.get("process_id", "target"), "process_id")
        key = f"{lab_id}:{process_id}"
        if key in PROCESSES and PROCESSES[key].poll() is None:
            raise ValueError("process is already running")
        argv = _argv(args.get("argv"))
        validation = _automatic_harness_validation(argv, int(args.get("timeout_seconds", 120)))
        if validation is not None and not validation["valid"]:
            raise ValueError(f"mandatory harness validation failed; inspect {validation['evidence_path']}")
        log = root / f"{process_id}.log"
        handle = log.open("ab")
        proc = subprocess.Popen(argv, cwd=str(root), stdin=subprocess.DEVNULL, stdout=handle, stderr=subprocess.STDOUT, start_new_session=True)
        handle.close()
        PROCESSES[key] = proc
        PROCESS_META[key] = {"argv": argv, "log": str(log.relative_to(WORKSPACE)), "started_at": time.time()}
        return _record("labs", operation, {
            "lab_id": lab_id,
            "process_id": process_id,
            "pid": proc.pid,
            "log": str(log.relative_to(WORKSPACE)),
            "validation": validation,
        })
    if operation == "stop_process":
        process_id = _identifier(args.get("process_id", "target"), "process_id")
        key = f"{lab_id}:{process_id}"
        proc = PROCESSES.pop(key, None)
        if proc and proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
        meta = PROCESS_META.pop(key, None)
        return _record("labs", operation, {"lab_id": lab_id, "process_id": process_id, "stopped": proc is not None, "metadata": meta})
    if operation in {"status", "diagnostics"}:
        processes = []
        for key, proc in sorted(PROCESSES.items()):
            if not key.startswith(f"{lab_id}:"):
                continue
            process_id = key.split(":", 1)[1]
            processes.append({
                "process_id": process_id,
                "pid": proc.pid,
                "state": _process_state(proc),
                "exit_code": proc.poll(),
                **PROCESS_META.get(key, {}),
            })
        residue = [] if not root.exists() else [str(item.relative_to(root)) for item in sorted(root.rglob("*")) if item.is_file()][:500]
        return _record("labs", operation, {
            "lab_id": lab_id,
            "root": str(root.relative_to(WORKSPACE)),
            "architecture": os.uname().machine,
            "display": os.environ.get("DISPLAY"),
            "processes": processes,
            "residue": residue,
        })
    if operation == "readiness":
        process_id = _identifier(args.get("process_id", "target"), "process_id")
        proc = PROCESSES.get(f"{lab_id}:{process_id}")
        port = int(args.get("port", 0))
        port_ready = True
        if port:
            if port < 1 or port > 65535:
                raise ValueError("port must be between 1 and 65535")
            with socket.socket() as probe:
                probe.settimeout(0.5)
                port_ready = probe.connect_ex(("127.0.0.1", port)) == 0
        file_ready = True
        if args.get("path"):
            candidate = _path(args["path"])
            file_ready = candidate.is_file()
        return _record("labs", operation, {
            "lab_id": lab_id,
            "process_id": process_id,
            "process_ready": bool(proc and proc.poll() is None),
            "port_ready": port_ready,
            "file_ready": file_ready,
            "ready": bool(proc and proc.poll() is None and port_ready and file_ready),
        })
    if operation == "file_rendezvous":
        candidate = _path(args.get("path"))
        timeout = min(300, int(args.get("timeout_seconds", 30)))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not candidate.is_file():
            time.sleep(0.05)
        ready = candidate.is_file()
        return _record("labs", operation, {
            "lab_id": lab_id,
            "path": str(candidate.relative_to(WORKSPACE)),
            "ready": ready,
            "size": candidate.stat().st_size if ready else None,
        })
    snapshot_id = _identifier(args.get("snapshot_id", "latest"), "snapshot_id")
    snapshot = SNAPSHOTS / lab_id / snapshot_id
    if operation == "snapshot":
        if not root.is_dir():
            raise ValueError("lab does not exist")
        if snapshot.exists():
            shutil.rmtree(snapshot)
        snapshot.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(root, snapshot, symlinks=True)
        return _record("labs", operation, {"lab_id": lab_id, "snapshot_id": snapshot_id})
    if operation == "restore":
        if not snapshot.is_dir():
            raise ValueError("snapshot does not exist")
        if root.exists():
            shutil.rmtree(root)
        shutil.copytree(snapshot, root, symlinks=True)
        return _record("labs", operation, {"lab_id": lab_id, "snapshot_id": snapshot_id})
    if operation == "network_status":
        return _record("labs", operation, {"lab_id": lab_id, "result": _run(["ss", "-lntup"])})
    for key in [item for item in PROCESSES if item.startswith(f"{lab_id}:")]:
        native_lab({"operation": "stop_process", "lab_id": lab_id, "process_id": key.split(":", 1)[1]})
    if root.exists():
        shutil.rmtree(root)
    return _record("labs", operation, {"lab_id": lab_id, "destroyed": True, "cleanup_residue": root.exists()})


def _gdb_read(proc: subprocess.Popen[str], timeout: float = 5.0, until: re.Pattern[bytes] | None = None) -> str:
    if proc.stdout is None:
        raise ValueError("debugger output is unavailable")
    deadline = time.monotonic() + timeout
    chunks: list[bytes] = []
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ)
    try:
        while time.monotonic() < deadline:
            if not selector.select(max(0.0, deadline - time.monotonic())):
                break
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                break
            chunks.append(chunk)
            retained = b"".join(chunks)
            if (until.search(retained) if until else b"(gdb)" in chunk) or len(retained) >= MAX_CAPTURE:
                break
    finally:
        selector.close()
    return b"".join(chunks)[-MAX_CAPTURE:].decode("utf-8", "replace")


def _gdb_command(
    proc: subprocess.Popen[str],
    command: str,
    timeout: float = 5.0,
    until: re.Pattern[bytes] | None = None,
    token: int | None = None,
) -> str:
    if proc.stdin is None:
        raise ValueError("debugger input is unavailable")
    wire = f"{token}{command}" if token is not None else command
    proc.stdin.write(wire + "\n")
    proc.stdin.flush()
    output = _gdb_read(proc, timeout, until)
    if token is not None and re.search(rf"(?:^|\n){token}\^(?:done|running|connected|exit)(?:,|\n|\r)", output) is None:
        if re.search(rf"(?:^|\n){token}\^error,", output):
            raise ValueError(f"debugger command failed: {output.strip()}")
        raise ValueError(f"debugger response did not match command token {token}")
    if re.search(r"(?:^|\n)(?:\d+)?\^error,", output):
        raise ValueError(f"debugger command failed: {output.strip()}")
    return output


def _session_command(session_id: str, proc: subprocess.Popen[str], command: str, timeout: float = 5.0) -> str:
    meta = DEBUGGER_STATES[session_id]
    token = int(meta["next_token"])
    meta["next_token"] = token + 1
    until = re.compile(rf"(?:^|\n){token}\^(?:done|running|connected|exit|error)[\s\S]*?\(gdb\)".encode())
    return _gdb_command(proc, command, timeout, until, token)


def _debugger_observed_state(output: str, current: str) -> str:
    if re.search(r"(?:\*stopped,reason=\"exited|=thread-group-exited)", output):
        return "exited"
    if re.search(r"\*(?:stopped),", output):
        return "stopped"
    if re.search(r"\^(?:running)|\*running", output):
        return "running"
    return current


def _close_debugger(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    if proc.stdin is not None:
        try:
            proc.stdin.write("-gdb-exit\n")
            proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=2)


def native_debug(args: dict[str, Any]) -> dict[str, Any]:
    operation = args["operation"]
    session_id = _identifier(args.get("session_id", "debug"), "session_id")
    proc = DEBUGGERS.get(session_id)
    with DEBUGGER_LOCK:
        if operation in {"launch", "attach"}:
            if proc and proc.poll() is None:
                raise ValueError("debug session is already active")
            argv = [_command("gdb-multiarch"), "--quiet", "--interpreter=mi2"]
            if operation == "launch":
                target = _path(args.get("path"), exists=True)
                argv.append(str(target))
            else:
                pid = int(args.get("pid", 0))
                if pid <= 0 or not any(child.pid == pid and child.poll() is None for child in PROCESSES.values()):
                    raise ValueError("attach is limited to a running native_lab process")
                argv.extend(["--pid", str(pid)])
            proc = subprocess.Popen(argv, cwd=str(WORKSPACE), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, start_new_session=True)
            DEBUGGERS[session_id] = proc
            DEBUGGER_STATES[session_id] = {
                "state": "stopped",
                "next_token": 1,
                "signal_policy": {"SIGSYS": {"stop": True, "print": True, "pass": False}},
            }
            try:
                output = _gdb_read(proc)
                output += _session_command(session_id, proc, '-interpreter-exec console "handle SIGSYS stop print nopass"')
                if operation == "launch":
                    if args.get("target_args"):
                        command = "-exec-arguments " + " ".join(json.dumps(item) for item in _argv(args["target_args"]))
                        output += _session_command(session_id, proc, command)
                    output += _session_command(session_id, proc, '-interpreter-exec console "starti"', timeout=10.0)
                    DEBUGGER_STATES[session_id]["state"] = _debugger_observed_state(output, "stopped")
            except Exception:
                DEBUGGERS.pop(session_id, None)
                DEBUGGER_STATES.pop(session_id, None)
                _close_debugger(proc)
                raise
            return _record("debug", operation, {
                "session_id": session_id,
                "pid": proc.pid,
                "state": DEBUGGER_STATES[session_id]["state"],
                "signal_policy": DEBUGGER_STATES[session_id]["signal_policy"],
                "output": output,
            })
        if operation in {"close", "detach"} and (not proc or proc.poll() is not None):
            DEBUGGERS.pop(session_id, None)
            DEBUGGER_STATES.pop(session_id, None)
            return _record("debug", operation, {"session_id": session_id, "state": "closed", "already_closed": True})
        if not proc or proc.poll() is not None or proc.stdin is None:
            raise ValueError("debug session is not active")
        meta = DEBUGGER_STATES[session_id]
        if operation == "status":
            if proc.poll() is not None:
                meta["state"] = "exited"
            return _record("debug", operation, {"session_id": session_id, **meta, "pid": proc.pid, "exit_code": proc.poll()})
        if operation == "wait":
            output = _gdb_read(proc, float(args.get("timeout_seconds", 10)), re.compile(rb"(?:\*stopped|=thread-group-exited)[\s\S]*\(gdb\)"))
            meta["state"] = _debugger_observed_state(output, str(meta["state"]))
            return _record("debug", operation, {"session_id": session_id, "state": meta["state"], "output": output})
        if operation == "signal_policy":
            name = str(args.get("signal", "SIGSYS"))
            if re.fullmatch(r"SIG[A-Z0-9]+", name) is None:
                raise ValueError("signal must be a symbolic SIG name")
            policy = {
                "stop": bool(args.get("stop", True)),
                "print": bool(args.get("print", True)),
                "pass": bool(args.get("pass", False)),
            }
            words = ["stop" if policy["stop"] else "nostop", "print" if policy["print"] else "noprint", "pass" if policy["pass"] else "nopass"]
            output = _session_command(session_id, proc, f'-interpreter-exec console "handle {name} {" ".join(words)}"')
            meta["signal_policy"][name] = policy
            return _record("debug", operation, {"session_id": session_id, "state": meta["state"], "signal_policy": meta["signal_policy"], "output": output})
        commands = {
            "breakpoint": f"-break-insert {args.get('location', 'main')}",
            "continue": "-exec-continue",
            "registers": "-data-list-register-values x",
            "stack": "-stack-list-frames",
            "memory": f"-data-read-memory-bytes {args.get('address', '0')} {int(args.get('length', 64))}",
            "backtrace": "-stack-list-frames",
        }
        if operation in {"close", "detach"}:
            output = ""
            if operation == "detach":
                output = _session_command(session_id, proc, "-target-detach")
            _close_debugger(proc)
            DEBUGGERS.pop(session_id, None)
            DEBUGGER_STATES.pop(session_id, None)
            return _record("debug", operation, {"session_id": session_id, "state": "closed", "output": output})
        if operation == "continue" and meta["state"] != "stopped":
            raise ValueError(f"continue requires stopped state; current state is {meta['state']}")
        output = _session_command(session_id, proc, commands[operation], 10.0 if operation == "continue" else 5.0)
        meta["state"] = _debugger_observed_state(output, str(meta["state"]))
        return _record("debug", operation, {"session_id": session_id, "state": meta["state"], "output": output})


def _marionette_packet(sock: socket.socket) -> Any:
    prefix = bytearray()
    while b":" not in prefix:
        chunk = sock.recv(1)
        if not chunk:
            raise ValueError("Marionette closed while reading a packet length")
        prefix.extend(chunk)
        if len(prefix) > 12:
            raise ValueError("Marionette packet length is invalid")
    length_text, _, initial = bytes(prefix).partition(b":")
    if not length_text.isdigit():
        raise ValueError("Marionette packet length is not numeric")
    length = int(length_text)
    if length < 1 or length > MAX_CAPTURE:
        raise ValueError("Marionette packet exceeds the response bound")
    payload = bytearray(initial)
    while len(payload) < length:
        chunk = sock.recv(length - len(payload))
        if not chunk:
            raise ValueError("Marionette closed during a packet")
        payload.extend(chunk)
    return json.loads(payload.decode("utf-8"))


def _marionette_command(session: dict[str, Any], method: str, params: dict[str, Any]) -> Any:
    sock: socket.socket = session["socket"]
    command_id = int(session["next_id"])
    session["next_id"] = command_id + 1
    payload = json.dumps([0, command_id, method, params], separators=(",", ":")).encode("utf-8")
    sock.sendall(str(len(payload)).encode("ascii") + b":" + payload)
    response = _marionette_packet(sock)
    if not isinstance(response, list) or len(response) != 4 or response[0] != 1 or response[1] != command_id:
        raise ValueError(f"Marionette returned a mismatched response for command {command_id}")
    if response[2] is not None:
        raise ValueError(f"Marionette {method} failed: {response[2]}")
    result = response[3]
    if isinstance(result, dict) and set(result) == {"value"}:
        return result["value"]
    return result


def _firefox_context(session: dict[str, Any], context: str) -> None:
    if context not in {"content", "chrome"}:
        raise ValueError("Firefox context must be content or chrome")
    if session["context"] == context:
        return
    _marionette_command(session, "Marionette:SetContext", {"value": context})
    session["context"] = context


def _terminate_owned_process(proc: subprocess.Popen[Any] | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=2)


def _proc_identity(pid: int) -> dict[str, Any] | None:
    proc = Path("/proc") / str(pid)
    try:
        stat = (proc / "stat").read_text("utf-8")
        closing = stat.rfind(")")
        fields = stat[closing + 2:].split()
        executable = str((proc / "exe").resolve(strict=True))
        return {
            "pid": pid,
            "ppid": int(fields[1]),
            "process_group_id": int(fields[2]),
            "session_id": int(fields[3]),
            "executable": executable,
        }
    except (IndexError, OSError, ValueError):
        return None


def _firefox_process_identity(session: dict[str, Any]) -> dict[str, Any]:
    launcher_pid = int(session["firefox"].pid)
    expected = str(session["executable"])
    records: list[dict[str, Any]] = []
    proc_root = Path("/proc")
    if proc_root.is_dir():
        for candidate in proc_root.iterdir():
            if not candidate.name.isdigit():
                continue
            record = _proc_identity(int(candidate.name))
            if record and (record["pid"] == launcher_pid or record["process_group_id"] == launcher_pid):
                records.append(record)
    records.sort(key=lambda item: int(item["pid"]))
    exact_pids = [int(item["pid"]) for item in records if item["executable"] == expected]
    return {
        "launcher_pid": launcher_pid,
        "process_group_id": launcher_pid,
        "expected_executable": expected,
        "expected_build_sha256": session["build_sha256"],
        "exact_executable_pids": exact_pids,
        "processes": records,
        "inventory_state": "observed" if records else "unavailable",
    }


def _firefox_websocket_url(capabilities: Any) -> str | None:
    source = capabilities
    if isinstance(source, dict) and isinstance(source.get("capabilities"), dict):
        source = source["capabilities"]
    value = source.get("webSocketUrl") if isinstance(source, dict) else None
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("Firefox returned a non-string webSocketUrl capability")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"ws", "wss"} or not parsed.hostname or parsed.port is None:
        raise ValueError("Firefox returned an invalid WebDriver BiDi endpoint")
    try:
        loopback = ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        loopback = parsed.hostname == "localhost"
    if not loopback:
        raise ValueError("Firefox WebDriver BiDi endpoint must remain on loopback")
    return value


# ── Firefox Sessions Own Every Privileged Browser Resource ────────
# One managed object owns Xvfb, profile, Firefox, discovered port, Marionette
# socket, context, windows, and teardown. The active port file is read and then
# TCP-probed; chrome context adds Firefox's required system-access flag. Context
# changes are restored explicitly so one command cannot poison its successor.
# ─────────────────────────────────────────────────────────────────────
def firefox_lab(args: dict[str, Any]) -> dict[str, Any]:
    operation = args["operation"]
    session_id = _identifier(args.get("session_id", "firefox"), "session_id")
    session = FIREFOX_SESSIONS.get(session_id)
    if operation == "launch":
        if session and session["firefox"].poll() is None:
            raise ValueError("Firefox lab session is already active")
        executable_value = args.get("executable")
        if not isinstance(executable_value, str) or not executable_value:
            raise ValueError("Firefox executable must be a non-empty path")
        executable = Path(executable_value).resolve(strict=True)
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise ValueError("Firefox executable must be an executable regular file")
        build_sha256 = _file_sha256(executable)
        expected_build_sha256 = args.get("expected_build_sha256")
        if expected_build_sha256 is not None and expected_build_sha256 != build_sha256:
            raise ValueError("Firefox executable SHA-256 does not match expected_build_sha256")
        context = str(args.get("context", "content"))
        if context not in {"content", "chrome"}:
            raise ValueError("Firefox context must be content or chrome")
        root = LABS / "firefox" / session_id
        if root.exists():
            shutil.rmtree(root)
        profile = root / "profile"
        profile.mkdir(parents=True, mode=0o700)
        xvfb = subprocess.Popen(
            [_command("Xvfb"), "-displayfd", "1", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            if xvfb.stdout is None:
                raise ValueError("Xvfb display output is unavailable")
            ready, _, _ = select.select([xvfb.stdout], [], [], 5)
            display_number = xvfb.stdout.readline().strip() if ready else ""
            if not display_number.isdigit():
                raise ValueError("Xvfb did not publish a display number")
        except Exception:
            _terminate_owned_process(xvfb)
            raise
        display = f":{display_number}"
        log_path = root / "firefox.log"
        log = log_path.open("ab")
        argv = [str(executable), "--no-remote", "--profile", str(profile), "--marionette"]
        if context == "chrome":
            argv.append("-remote-allow-system-access")
        firefox = subprocess.Popen(
            argv,
            cwd=str(root),
            env={**os.environ, "DISPLAY": display},
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        log.close()
        port_file = profile / "MarionetteActivePort"
        timeout = min(120, int(args.get("timeout_seconds", 30)))
        deadline = time.monotonic() + timeout
        port = 0
        while time.monotonic() < deadline and firefox.poll() is None:
            if port_file.is_file():
                match = re.search(r"\d+", port_file.read_text("utf-8", errors="replace"))
                if match:
                    port = int(match.group())
                    with socket.socket() as probe:
                        probe.settimeout(0.2)
                        if probe.connect_ex(("127.0.0.1", port)) == 0:
                            break
            time.sleep(0.05)
        if not port or firefox.poll() is not None:
            _terminate_owned_process(firefox)
            _terminate_owned_process(xvfb)
            raise ValueError("Firefox did not publish a reachable MarionetteActivePort")
        sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        sock.settimeout(10)
        session = {
            "firefox": firefox,
            "xvfb": xvfb,
            "socket": sock,
            "next_id": 1,
            "context": "content",
            "profile": profile,
            "root": root,
            "display": display,
            "port": port,
            "log": log_path,
            "system_access": context == "chrome",
            "executable": executable,
            "build_sha256": build_sha256,
            "marionette_active": True,
            "handles": [],
        }
        FIREFOX_SESSIONS[session_id] = session
        try:
            greeting = _marionette_packet(sock)
            bidi = bool(args.get("bidi", True))
            always_match = {"webSocketUrl": True} if bidi else {}
            capabilities = _marionette_command(
                session,
                "WebDriver:NewSession",
                {"capabilities": {"alwaysMatch": always_match}},
            )
            web_socket_url = _firefox_websocket_url(capabilities)
            if bidi and web_socket_url is None:
                raise ValueError("Firefox did not advertise the requested WebDriver BiDi endpoint")
            _firefox_context(session, context)
            session["handles"] = _marionette_command(session, "WebDriver:GetWindowHandles", {})
            session["web_socket_url"] = web_socket_url
            session["capabilities"] = capabilities
        except Exception:
            firefox_lab({"operation": "close", "session_id": session_id})
            raise
        return _record("firefox", operation, {
            "session_id": session_id,
            "pid": firefox.pid,
            "build_sha256": build_sha256,
            "display": display,
            "profile": str(profile.relative_to(WORKSPACE)),
            "port": port,
            "context": session["context"],
            "greeting": greeting,
            "capabilities": capabilities,
            "web_socket_url": session["web_socket_url"],
            "handles": session["handles"],
            "process_identity": _firefox_process_identity(session),
            "log": str(log_path.relative_to(WORKSPACE)),
        })
    if operation == "close":
        if not session:
            return _record("firefox", operation, {"session_id": session_id, "closed": True, "already_closed": True})
        try:
            if session.get("marionette_active", True):
                _marionette_command(session, "WebDriver:DeleteSession", {})
        except (OSError, ValueError):
            pass
        try:
            session["socket"].close()
        finally:
            _terminate_owned_process(session.get("firefox"))
            _terminate_owned_process(session.get("xvfb"))
            FIREFOX_SESSIONS.pop(session_id, None)
        return _record("firefox", operation, {
            "session_id": session_id,
            "closed": True,
            "cleanup_residue": bool(session["firefox"].poll() is None or session["xvfb"].poll() is None),
        })
    if not session or session["firefox"].poll() is not None:
        raise ValueError("Firefox lab session is not active")
    if operation == "status":
        if session.get("marionette_active", True):
            session["handles"] = _marionette_command(session, "WebDriver:GetWindowHandles", {})
        return _record("firefox", operation, {
            "session_id": session_id,
            "state": "running",
            "pid": session["firefox"].pid,
            "display": session["display"],
            "profile": str(session["profile"].relative_to(WORKSPACE)),
            "port": session["port"],
            "context": session["context"],
            "handles": session["handles"],
            "marionette_active": session.get("marionette_active", True),
            "web_socket_url": session.get("web_socket_url"),
            "build_sha256": session["build_sha256"],
            "process_identity": _firefox_process_identity(session),
            "log": str(session["log"].relative_to(WORKSPACE)),
        })
    if operation == "handoff_bidi":
        if not session.get("web_socket_url"):
            raise ValueError("Firefox lab session has no advertised WebDriver BiDi endpoint")
        if not session.get("marionette_active", True):
            return _record("firefox", operation, {
                "session_id": session_id,
                "web_socket_url": session["web_socket_url"],
                "already_handed_off": True,
                "process_identity": _firefox_process_identity(session),
            })
        session["handles"] = _marionette_command(session, "WebDriver:GetWindowHandles", {})
        session["socket"].close()
        session["marionette_active"] = False
        return _record("firefox", operation, {
            "session_id": session_id,
            "web_socket_url": session["web_socket_url"],
            "handles": session["handles"],
            "marionette_active": False,
            "process_identity": _firefox_process_identity(session),
        })
    if not session.get("marionette_active", True):
        raise ValueError("Firefox Marionette transport was handed off to WebDriver BiDi")
    if operation == "new_window":
        window_type = str(args.get("type", "tab"))
        if window_type not in {"tab", "window"}:
            raise ValueError("new window type must be tab or window")
        result = _marionette_command(session, "WebDriver:NewWindow", {"type": window_type})
        handle = result.get("handle") if isinstance(result, dict) else result
        _marionette_command(session, "WebDriver:SwitchToWindow", {"handle": handle})
        session["handles"] = _marionette_command(session, "WebDriver:GetWindowHandles", {})
        return _record("firefox", operation, {"session_id": session_id, "handle": handle, "type": window_type})
    original_context = str(session["context"])
    default_context = "content" if operation == "navigate" else "chrome" if operation == "set_permission" else original_context
    requested_context = str(args.get("context", default_context))
    try:
        _firefox_context(session, requested_context)
        if operation == "navigate":
            result = _marionette_command(session, "WebDriver:Navigate", {"url": str(args.get("url"))})
        elif operation == "execute":
            script = args.get("script")
            values = args.get("args", [])
            if not isinstance(script, str) or not script:
                raise ValueError("Firefox execute script must be non-empty")
            if not isinstance(values, list):
                raise ValueError("Firefox execute args must be an array")
            result = _marionette_command(session, "WebDriver:ExecuteScript", {
                "script": script,
                "args": values,
                "newSandbox": False,
                "sandbox": None,
                "line": 0,
                "filename": "cyberful-firefox-lab",
            })
        else:
            origin = str(args.get("origin"))
            permission = str(args.get("permission"))
            action = int(args.get("action", 1))
            script = """
              const principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin(arguments[0]);
              Services.perms.addFromPrincipal(principal, arguments[1], arguments[2]);
              return Services.perms.testExactPermissionFromPrincipal(principal, arguments[1]);
            """
            result = _marionette_command(session, "WebDriver:ExecuteScript", {
                "script": script,
                "args": [origin, permission, action],
                "newSandbox": False,
                "sandbox": None,
                "line": 0,
                "filename": "cyberful-permission-seed",
            })
            if result != action:
                raise ValueError("Firefox permission readback did not match the requested action")
        return _record("firefox", operation, {"session_id": session_id, "context": requested_context, "result": result})
    finally:
        _firefox_context(session, original_context)


def _clipboard_display(args: dict[str, Any]) -> str:
    session_id = args.get("session_id")
    if session_id is not None:
        session = FIREFOX_SESSIONS.get(_identifier(session_id, "session_id"))
        if not session:
            raise ValueError("Firefox lab session is not active")
        return str(session["display"])
    display = str(args.get("display", os.environ.get("DISPLAY", "")))
    if not re.fullmatch(r":\d+(?:\.\d+)?", display):
        raise ValueError("display must be an X11 display such as :99")
    return display


def _set_clipboard_owner(owner_id: str, display: str, content: bytes) -> subprocess.Popen[bytes]:
    previous = CLIPBOARD_OWNERS.pop(owner_id, None)
    _terminate_owned_process(previous)
    proc = subprocess.Popen(
        [_command("xclip"), "-selection", "clipboard", "-in", "-quiet", "-target", "UTF8_STRING"],
        env={**os.environ, "DISPLAY": display},
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    if proc.stdin is None:
        _terminate_owned_process(proc)
        raise ValueError("xclip input is unavailable")
    proc.stdin.write(content)
    proc.stdin.close()
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise ValueError("xclip failed to own the clipboard")
        try:
            probe = subprocess.run(
                [_command("xclip"), "-selection", "clipboard", "-out", "-target", "TARGETS"],
                env={**os.environ, "DISPLAY": display},
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=1,
                check=False,
            )
            if probe.returncode == 0 and b"UTF8_STRING" in probe.stdout:
                break
        except subprocess.TimeoutExpired:
            pass
        time.sleep(0.05)
    else:
        _terminate_owned_process(proc)
        raise ValueError("xclip did not publish UTF8_STRING ownership before the readiness deadline")
    CLIPBOARD_OWNERS[owner_id] = proc
    return proc


# ── X11 Clipboard State Never Enters Durable Evidence ─────────────
# The wrapper can own synthetic UTF-8 text and inspect only TARGETS metadata.
# Status reports process ownership, not clipboard contents. Cleanup replaces the
# prior owner with an empty synthetic selection, so real clipboard data is never
# read into Python state or written through the evidence recorder.
# ─────────────────────────────────────────────────────────────────────
def x11_clipboard(args: dict[str, Any]) -> dict[str, Any]:
    operation = args["operation"]
    owner_id = _identifier(args.get("owner_id", args.get("session_id", "clipboard")), "owner_id")
    display = _clipboard_display(args)
    if operation == "set":
        text = args.get("text")
        if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_CAPTURE:
            raise ValueError("clipboard text must be UTF-8 text within the capture bound")
        proc = _set_clipboard_owner(owner_id, display, text.encode("utf-8"))
        return {"owner_id": owner_id, "display": display, "owned": True, "pid": proc.pid, "bytes": len(text.encode("utf-8"))}
    if operation == "targets":
        result = _run(
            [_command("xclip"), "-selection", "clipboard", "-out", "-target", "TARGETS"],
            timeout=10,
            env={**os.environ, "DISPLAY": display},
        )
        return {"owner_id": owner_id, "display": display, "targets": result["stdout"].splitlines(), "exit_code": result["exit_code"]}
    if operation == "clear":
        proc = _set_clipboard_owner(owner_id, display, b"")
        return {"owner_id": owner_id, "display": display, "cleared": True, "pid": proc.pid}
    proc = CLIPBOARD_OWNERS.get(owner_id)
    return {"owner_id": owner_id, "display": display, "owned": bool(proc and proc.poll() is None), "pid": proc.pid if proc and proc.poll() is None else None}


def crash_triage(args: dict[str, Any]) -> dict[str, Any]:
    operation = args["operation"]
    path = _path(args.get("path", "."), exists=True)
    if operation == "collect":
        result = _run(["file", "-b", str(path)])
    elif operation == "reproduce":
        result = _run(_argv(args.get("argv")), cwd=path if path.is_dir() else path.parent, timeout=int(args.get("timeout_seconds", 120)), stdin=(args.get("stdin", "").encode()))
    elif operation == "symbolize":
        binary = _path(args.get("binary"), exists=True)
        addresses = args.get("addresses", [])
        if not isinstance(addresses, list) or not all(isinstance(item, str) for item in addresses):
            raise ValueError("addresses must be an array of strings")
        result = _run(["llvm-symbolizer", "--obj", str(binary), *addresses])
    elif operation == "minimize":
        output = _path(args.get("output"))
        output.parent.mkdir(parents=True, exist_ok=True)
        result = _run(["afl-tmin", "-i", str(path), "-o", str(output), "--", *_argv(args.get("argv"))], timeout=int(args.get("timeout_seconds", 600)))
    elif operation in {"classify", "deduplicate"}:
        candidates = [path] if path.is_file() else sorted(item for item in path.rglob("*") if item.is_file())[:1000]
        findings: list[dict[str, Any]] = []
        for candidate in candidates:
            text = candidate.read_text("utf-8", "replace")[:MAX_CAPTURE]
            normalized = re.sub(r"0x[0-9a-fA-F]+|\b\d+\b", "#", text)
            signature = hashlib.sha256(normalized.encode()).hexdigest()
            category = "memory-corruption" if re.search(r"ASAN|heap-use-after|buffer-overflow|SIGSEGV", text, re.I) else "unknown"
            findings.append({"path": str(candidate.relative_to(WORKSPACE)), "category": category, "signature": signature, "duplicate_key": signature[:24], "text_preview": text[:4096]})
        if operation == "classify":
            if len(findings) != 1:
                raise ValueError("classify path must be a file")
            result = findings[0]
        else:
            groups: dict[str, list[str]] = {}
            for finding in findings:
                groups.setdefault(str(finding["duplicate_key"]), []).append(str(finding["path"]))
            result = {"files": len(findings), "groups": [{"duplicate_key": key, "paths": values, "count": len(values)} for key, values in sorted(groups.items())]}
    else:
        destination = STATE / "crashes" / "artifacts" / path.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if path.is_dir():
            if destination.exists():
                shutil.rmtree(destination)
            shutil.copytree(path, destination, symlinks=True)
        else:
            shutil.copy2(path, destination)
        result = {"exported": str(destination.relative_to(WORKSPACE))}
    return _record("crashes", operation, {"result": result})


def fuzz_campaign(args: dict[str, Any]) -> dict[str, Any]:
    operation = args["operation"]
    campaign_id = _identifier(args.get("campaign_id", "campaign"), "campaign_id")
    root = LABS / "fuzz" / campaign_id
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = f"fuzz:{campaign_id}"
    proc = PROCESSES.get(key)
    if operation == "start":
        if proc and proc.poll() is None:
            raise ValueError("campaign is already running")
        log = (root / "campaign.log").open("ab")
        proc = subprocess.Popen(_argv(args.get("argv")), cwd=str(root), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        log.close()
        PROCESSES[key] = proc
    elif operation in {"pause", "resume", "stop"}:
        if not proc or proc.poll() is not None:
            raise ValueError("campaign is not running")
        if operation == "pause":
            os.killpg(proc.pid, signal.SIGSTOP)
        elif operation == "resume":
            os.killpg(proc.pid, signal.SIGCONT)
        else:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=2)
            PROCESSES.pop(key, None)
    crashes = sorted(str(item.relative_to(root)) for item in root.rglob("crashes/*") if item.is_file())[:100]
    payload = {"campaign_id": campaign_id, "running": bool(proc and proc.poll() is None), "pid": proc.pid if proc else None, "crashes": crashes}
    if operation == "coverage":
        if not args.get("path") or not args.get("argv"):
            raise ValueError("coverage requires path and argv")
        input_path = _path(args["path"], exists=True)
        map_path = root / "coverage.map"
        payload["coverage"] = _run(["afl-showmap", "-o", str(map_path), "--", *_argv(args["argv"])], stdin=input_path.read_bytes(), timeout=int(args.get("timeout_seconds", 120)))
    if operation == "checkpoint":
        checkpoint = SNAPSHOTS / "fuzz" / f"{campaign_id}-{int(time.time())}"
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(root, checkpoint)
        payload["checkpoint"] = str(checkpoint.relative_to(WORKSPACE))
    return _record("fuzz", operation, payload)


def binary_diff(args: dict[str, Any]) -> dict[str, Any]:
    operation = args["operation"]
    left = _path(args.get("left"), exists=True)
    right = _path(args.get("right"), exists=True)
    command = ["radiff2", "-C" if operation in {"changed_functions", "changed_calls", "security_candidates"} else "-s", str(left), str(right)]
    result = _run(command, timeout=int(args.get("timeout_seconds", 300)))
    if operation in {"changed_constants", "security_candidates"}:
        left_strings = set(_run(["strings", str(left)])["stdout"].splitlines())
        right_strings = set(_run(["strings", str(right)])["stdout"].splitlines())
        result["changed_strings"] = "\n".join(sorted(left_strings ^ right_strings))[:MAX_CAPTURE]
    return _record("binary-diff", operation, {"left": str(left.relative_to(WORKSPACE)), "right": str(right.relative_to(WORKSPACE)), "heuristic": operation == "security_candidates", "result": result})


def _loopback_host(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def protocol_campaign(args: dict[str, Any]) -> dict[str, Any]:
    operation = args["operation"]
    campaign_id = _identifier(args.get("campaign_id", "protocol"), "campaign_id")
    root = LABS / "protocol" / campaign_id
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if operation == "import_zap_request":
        request = args.get("request")
        if not isinstance(request, str) or not request:
            raise ValueError("request must be non-empty text exported from ZAP")
        (root / "request.txt").write_text(request, encoding="utf-8")
        payload = {"campaign_id": campaign_id, "bytes": len(request.encode())}
    elif operation == "build_corpus":
        values = args.get("values", [])
        if not isinstance(values, list) or not all(isinstance(item, str) for item in values):
            raise ValueError("values must be an array of strings")
        corpus = root / "corpus"
        corpus.mkdir(exist_ok=True)
        for index, value in enumerate(values[:256]):
            (corpus / f"seed-{index:04d}").write_text(value, encoding="utf-8")
        payload = {"campaign_id": campaign_id, "seeds": min(len(values), 256)}
    elif operation == "mutate":
        value = str(args.get("value", ""))
        mutations = [value, value + "\0", value * 2, value.replace("0", "-1"), value + "A" * 256]
        payload = {"campaign_id": campaign_id, "mutations": mutations}
    elif operation == "paired_timing":
        control = str(args.get("control_url", ""))
        candidate = str(args.get("candidate_url", ""))
        if not control.startswith(("http://", "https://")) or not candidate.startswith(("http://", "https://")):
            raise ValueError("paired timing requires HTTP(S) URLs")
        hosts = [urllib.parse.urlparse(url).hostname for url in (control, candidate)]
        remote = any(host and not _loopback_host(host) for host in hosts)
        proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
        if remote and not proxy:
            raise ValueError("remote paired timing requires the host-owned HTTP proxy")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy} if proxy else {}))
        samples = max(1, min(int(args.get("samples", 3)), 10))
        timings: dict[str, list[float]] = {"control": [], "candidate": []}
        for _ in range(samples):
            for label, url in (("control", control), ("candidate", candidate)):
                started = time.monotonic()
                with opener.open(url, timeout=10) as response:
                    response.read(4096)
                timings[label].append(time.monotonic() - started)
        payload = {"campaign_id": campaign_id, "timings": timings, "delta_seconds": sum(timings["candidate"]) / samples - sum(timings["control"]) / samples}
    elif operation == "classify_anomaly":
        delta = float(args.get("delta_seconds", 0))
        payload = {"campaign_id": campaign_id, "classification": "timing-anomaly" if abs(delta) >= float(args.get("threshold_seconds", 0.5)) else "no-anomaly", "delta_seconds": delta}
    else:
        if root.exists():
            shutil.rmtree(root)
        payload = {"campaign_id": campaign_id, "stopped": True}
    return _record("protocol", operation, payload)


def appliance_fingerprint(args: dict[str, Any]) -> dict[str, Any]:
    operation = args["operation"]
    observations = args.get("observations", [])
    if not isinstance(observations, list):
        raise ValueError("observations must be an array")
    normalized = [item for item in observations[:1000] if isinstance(item, dict)]
    versions = sorted(set(re.findall(r"\b(?:v)?\d+(?:\.\d+){1,3}(?:[-_a-zA-Z0-9.]*)?", json.dumps(normalized))))
    fingerprints: dict[str, list[dict[str, Any]]] = {}
    for item in normalized:
        key = hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()[:16]
        fingerprints.setdefault(key, []).append(item)
    clusters = [{"fingerprint": key, "count": len(items), "assets": sorted({str(item.get("asset", item.get("host", "unknown"))) for item in items})} for key, items in sorted(fingerprints.items())]
    assets: dict[str, set[str]] = {}
    for item in normalized:
        asset = str(item.get("asset", item.get("host", "unknown")))
        assets.setdefault(asset, set()).update(re.findall(r"\b(?:v)?\d+(?:\.\d+){1,3}(?:[-_a-zA-Z0-9.]*)?", json.dumps(item)))
    if operation in {"observe", "cluster_hosts"}:
        result: Any = {"clusters": clusters}
    elif operation == "compare_assets":
        result = {"assets": [{"asset": asset, "versions": sorted(found)} for asset, found in sorted(assets.items())], "shared_versions": sorted(set.intersection(*assets.values())) if assets else []}
    elif operation == "infer_version":
        result = {"candidates": [{"version": version, "support": sum(version in found for found in assets.values())} for version in versions], "confidence": "observed" if versions else "unknown"}
    else:
        result = {"matrix": [{"asset": asset, "versions": sorted(found)} for asset, found in sorted(assets.items())], "versions": versions}
    payload = {"operation": operation, "observations": len(normalized), "result": result}
    return _record("fingerprints", operation, payload)


# ── Source Analyzers Never Receive Binary Inputs ────────────────────
# Cppcheck accepts an explicitly named extensionless ELF, emits decoded binary
# bytes as parser diagnostics, and may still exit successfully. The workflow
# therefore classifies the input before any analyzer subprocess starts. Source
# trees are admitted only after bounded discovery finds a recognized C/C++ file;
# uncertainty or the discovery ceiling returns an honest unsupported result.
# ─────────────────────────────────────────────────────────────────────
def _cpp_source_input_kind(root: Path) -> tuple[bool, str]:
    if root.is_file():
        with root.open("rb") as handle:
            if handle.read(4) == b"\x7fELF":
                return False, "elf-binary"
        return (True, "source-file") if root.suffix.lower() in CPP_SOURCE_SUFFIXES else (False, "non-source-file")
    if not root.is_dir():
        return False, "unsupported-path"
    inspected = 0
    for candidate in root.rglob("*"):
        if inspected >= MAX_FILES:
            return False, "source-discovery-limit"
        if not candidate.is_file() or candidate.is_symlink():
            continue
        inspected += 1
        if candidate.suffix.lower() in CPP_SOURCE_SUFFIXES:
            return True, "source-tree"
    return False, "source-tree-without-c-or-cpp"


def native_static_analysis(args: dict[str, Any]) -> dict[str, Any]:
    operation = args["operation"]
    root = _path(args.get("path", "."), exists=True)
    if operation == "import_compile_db":
        database = root if root.name == "compile_commands.json" else root / "compile_commands.json"
        parsed = json.loads(database.read_text("utf-8"))
        if not isinstance(parsed, list):
            raise ValueError("compile_commands.json must contain an array")
        result: Any = {"entries": len(parsed), "path": str(database.relative_to(WORKSPACE))}
    elif operation == "run_checks":
        supported, input_kind = _cpp_source_input_kind(root)
        if not supported:
            return _record("static", operation, {
                "root": str(root.relative_to(WORKSPACE)),
                "result": {
                    "status": "unsupported",
                    "input_kind": input_kind,
                    "analyzers_invoked": [],
                    "reason": "run_checks requires a C/C++ source file or a directory containing C/C++ source files",
                },
            })
        database = root / "compile_commands.json" if root.is_dir() else root.parent / "compile_commands.json"
        clang_tidy: Any = {"skipped": "compile_commands.json is required"}
        if database.is_file():
            parsed = json.loads(database.read_text("utf-8"))
            sources = [] if not isinstance(parsed, list) else [str(_path(item.get("file"), exists=True)) for item in parsed[:100] if isinstance(item, dict) and isinstance(item.get("file"), str)]
            clang_tidy = _run(["clang-tidy", "-p", str(database.parent), *sources], timeout=int(args.get("timeout_seconds", 600))) if sources else {"skipped": "compile database contains no bounded source files"}
        result = {
            "cppcheck": _run(["cppcheck", "--enable=warning,style,performance,portability", "--template=gcc", str(root)], timeout=int(args.get("timeout_seconds", 600))),
            "clang_tidy": clang_tidy,
        }
    else:
        pattern = r"\b(printf|fprintf|sprintf|snprintf|syslog|execl|execle|open|read|recv|strcpy|memcpy)\s*\(" if operation == "inspect_variadic_calls" else r"\b(getenv|argv|read|recv|fgets|scanf)\b|\b(system|exec|popen|eval|memcpy|strcpy)\b"
        result = _run(["rg", "-n", "--glob", "*.{c,cc,cpp,cxx,h,hpp}", pattern, str(root)], timeout=int(args.get("timeout_seconds", 120)))
    return _record("static", operation, {"root": str(root.relative_to(WORKSPACE)), "result": result})


HANDLERS = {
    "firmware_lab": firmware_lab,
    "native_lab": native_lab,
    "native_debug": native_debug,
    "crash_triage": crash_triage,
    "fuzz_campaign": fuzz_campaign,
    "binary_diff": binary_diff,
    "protocol_campaign": protocol_campaign,
    "appliance_fingerprint": appliance_fingerprint,
    "native_static_analysis": native_static_analysis,
    "harness_validate": harness_validate,
    "archive_extract": archive_extract,
    "firefox_lab": firefox_lab,
    "x11_clipboard": x11_clipboard,
}

OPERATIONS = {
    "firmware_lab": ["import", "identify", "unpack", "manifest", "diff", "find_services", "find_routes", "checkpoint"],
    "native_lab": ["create", "start_process", "stop_process", "status", "readiness", "file_rendezvous", "diagnostics", "snapshot", "restore", "network_status", "destroy"],
    "native_debug": ["launch", "attach", "status", "breakpoint", "continue", "wait", "signal_policy", "registers", "stack", "memory", "backtrace", "detach", "close"],
    "crash_triage": ["collect", "reproduce", "symbolize", "classify", "deduplicate", "minimize", "export_evidence"],
    "fuzz_campaign": ["start", "status", "coverage", "crashes", "checkpoint", "pause", "resume", "stop"],
    "binary_diff": ["compare_programs", "changed_functions", "changed_calls", "changed_constants", "security_candidates"],
    "protocol_campaign": ["import_zap_request", "build_corpus", "mutate", "paired_timing", "classify_anomaly", "stop"],
    "appliance_fingerprint": ["observe", "cluster_hosts", "compare_assets", "infer_version", "build_version_matrix"],
    "native_static_analysis": ["import_compile_db", "run_checks", "trace_source_sink", "inspect_variadic_calls"],
    "harness_validate": ["shell", "javascript", "native_executable", "native_source"],
    "archive_extract": ["inspect", "extract"],
    "firefox_lab": ["launch", "status", "new_window", "navigate", "execute", "set_permission", "handoff_bidi", "close"],
    "x11_clipboard": ["set", "targets", "status", "clear"],
}


SCHEMA_FIELDS: dict[str, dict[str, Any]] = {
    "lab_id": {"type": "string", "pattern": IDENTIFIER.pattern},
    "campaign_id": {"type": "string", "pattern": IDENTIFIER.pattern},
    "session_id": {"type": "string", "pattern": IDENTIFIER.pattern},
    "process_id": {"type": "string", "pattern": IDENTIFIER.pattern},
    "snapshot_id": {"type": "string", "pattern": IDENTIFIER.pattern},
    "owner_id": {"type": "string", "pattern": IDENTIFIER.pattern},
    "path": {"type": "string", "minLength": 1},
    "other_path": {"type": "string", "minLength": 1},
    "left": {"type": "string", "minLength": 1},
    "right": {"type": "string", "minLength": 1},
    "binary": {"type": "string", "minLength": 1},
    "output": {"type": "string", "minLength": 1},
    "executable": {"type": "string", "minLength": 1},
    "argv": {"type": "array", "minItems": 1, "maxItems": 256, "items": {"type": "string", "minLength": 1}},
    "target_args": {"type": "array", "maxItems": 256, "items": {"type": "string", "minLength": 1}},
    "addresses": {"type": "array", "maxItems": 1024, "items": {"type": "string"}},
    "values": {"type": "array", "maxItems": 256, "items": {"type": "string"}},
    "observations": {"type": "array", "maxItems": 1000, "items": {"type": "object"}},
    "request": {"type": "string"},
    "value": {"type": "string"},
    "stdin": {"type": "string"},
    "text": {"type": "string"},
    "location": {"type": "string"},
    "address": {"type": "string"},
    "control_url": {"type": "string"},
    "candidate_url": {"type": "string"},
    "url": {"type": "string", "minLength": 1},
    "script": {"type": "string", "minLength": 1},
    "args": {"type": "array", "maxItems": 256, "items": {}},
    "origin": {"type": "string", "minLength": 1},
    "permission": {"type": "string", "minLength": 1},
    "action": {"type": "integer", "minimum": 0, "maximum": 16},
    "context": {"type": "string", "enum": ["content", "chrome"]},
    "type": {"type": "string", "enum": ["tab", "window"]},
    "display": {"type": "string", "pattern": r"^:\d+(?:\.\d+)?$"},
    "shell": {"type": "string", "minLength": 1},
    "compiler": {"type": "string", "minLength": 1},
    "include_dirs": {"type": "array", "maxItems": 128, "items": {"type": "string", "minLength": 1}},
    "expected_architecture": {"type": "string", "minLength": 1},
    "expected_build_sha256": {"type": "string", "pattern": r"^[a-f0-9]{64}$"},
    "required_symbols": {"type": "array", "maxItems": 1024, "items": {"type": "string", "minLength": 1}},
    "signal": {"type": "string", "pattern": r"^SIG[A-Z0-9]+$"},
    "stop": {"type": "boolean"},
    "print": {"type": "boolean"},
    "pass": {"type": "boolean"},
    "pid": {"type": "integer", "minimum": 1},
    "port": {"type": "integer", "minimum": 1, "maximum": 65535},
    "length": {"type": "integer", "minimum": 1, "maximum": 1048576},
    "samples": {"type": "integer", "minimum": 1, "maximum": 10},
    "delta_seconds": {"type": "number"},
    "threshold_seconds": {"type": "number", "minimum": 0},
    "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 3600},
    "bidi": {"type": "boolean"},
}


def _operation_schema(operation: str, fields: tuple[str, ...], required: tuple[str, ...] = ()) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {"operation": {"type": "string", "enum": [operation]}, **{name: SCHEMA_FIELDS[name] for name in fields}},
        "required": ["operation", *required],
    }


OPERATION_FIELDS: dict[str, dict[str, tuple[tuple[str, ...], tuple[str, ...]]]] = {
    "firmware_lab": {
        "import": (("lab_id", "path"), ("path",)), "identify": (("lab_id", "path"), ()),
        "unpack": (("lab_id", "path", "timeout_seconds"), ()), "manifest": (("lab_id", "path"), ()),
        "diff": (("lab_id", "path", "other_path"), ("other_path",)), "find_services": (("lab_id", "path", "timeout_seconds"), ()),
        "find_routes": (("lab_id", "path", "timeout_seconds"), ()), "checkpoint": (("lab_id", "path"), ()),
    },
    "native_lab": {
        "create": (("lab_id",), ()), "start_process": (("lab_id", "process_id", "argv", "timeout_seconds"), ("argv",)),
        "stop_process": (("lab_id", "process_id"), ()), "status": (("lab_id",), ()),
        "readiness": (("lab_id", "process_id", "port", "path"), ()), "file_rendezvous": (("lab_id", "path", "timeout_seconds"), ("path",)),
        "diagnostics": (("lab_id",), ()), "snapshot": (("lab_id", "snapshot_id"), ()),
        "restore": (("lab_id", "snapshot_id"), ()), "network_status": (("lab_id",), ()), "destroy": (("lab_id",), ()),
    },
    "native_debug": {
        "launch": (("session_id", "path", "target_args"), ("path",)), "attach": (("session_id", "pid"), ("pid",)),
        "status": (("session_id",), ()), "breakpoint": (("session_id", "location"), ()), "continue": (("session_id",), ()),
        "wait": (("session_id", "timeout_seconds"), ()), "signal_policy": (("session_id", "signal", "stop", "print", "pass"), ()),
        "registers": (("session_id",), ()), "stack": (("session_id",), ()),
        "memory": (("session_id", "address", "length"), ()), "backtrace": (("session_id",), ()),
        "detach": (("session_id",), ()), "close": (("session_id",), ()),
    },
    "crash_triage": {operation: (("path", "binary", "addresses", "output", "argv", "stdin", "timeout_seconds"), ()) for operation in OPERATIONS["crash_triage"]},
    "fuzz_campaign": {operation: (("campaign_id", "argv", "path", "timeout_seconds"), ()) for operation in OPERATIONS["fuzz_campaign"]},
    "binary_diff": {operation: (("left", "right", "timeout_seconds"), ("left", "right")) for operation in OPERATIONS["binary_diff"]},
    "protocol_campaign": {operation: (("campaign_id", "request", "values", "value", "control_url", "candidate_url", "samples", "delta_seconds", "threshold_seconds"), ()) for operation in OPERATIONS["protocol_campaign"]},
    "appliance_fingerprint": {operation: (("observations",), ()) for operation in OPERATIONS["appliance_fingerprint"]},
    "native_static_analysis": {operation: (("path", "timeout_seconds"), ()) for operation in OPERATIONS["native_static_analysis"]},
    "harness_validate": {
        "shell": (("path", "shell", "timeout_seconds"), ("path",)), "javascript": (("path", "timeout_seconds"), ("path",)),
        "native_executable": (("path", "expected_architecture", "expected_build_sha256", "required_symbols", "timeout_seconds"), ("path",)),
        "native_source": (("path", "compiler", "include_dirs", "timeout_seconds"), ("path",)),
    },
    "archive_extract": {
        "inspect": (("path", "timeout_seconds"), ("path",)), "extract": (("path", "output", "timeout_seconds"), ("path", "output")),
    },
    "firefox_lab": {
        "launch": (("session_id", "executable", "expected_build_sha256", "context", "bidi", "timeout_seconds"), ("executable",)), "status": (("session_id",), ()),
        "new_window": (("session_id", "type"), ()), "navigate": (("session_id", "url", "context"), ("url",)),
        "execute": (("session_id", "script", "args", "context"), ("script",)),
        "set_permission": (("session_id", "origin", "permission", "action"), ("origin", "permission", "action")),
        "handoff_bidi": (("session_id",), ()),
        "close": (("session_id",), ()),
    },
    "x11_clipboard": {
        "set": (("owner_id", "session_id", "display", "text"), ("text",)), "targets": (("owner_id", "session_id", "display"), ()),
        "status": (("owner_id", "session_id", "display"), ()), "clear": (("owner_id", "session_id", "display"), ()),
    },
}


SCHEMAS = {
    name: {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "operation": {"type": "string", "enum": list(operations)},
            **{
                field: SCHEMA_FIELDS[field]
                for field in sorted({field for fields, _required in operations.values() for field in fields})
            },
        },
        "oneOf": [
            _operation_schema(operation, fields, required)
            for operation, (fields, required) in operations.items()
        ]
    }
    for name, operations in OPERATION_FIELDS.items()
}


def invoke(name: str, args: dict[str, Any]) -> dict[str, Any]:
    if os.environ.get("CYBERFUL_OS_IN_CONTAINER") != "1":
        raise ValueError("native-security tools require the engagement-owned cyberful-os container")
    operation = args.get("operation")
    if operation not in OPERATIONS[name]:
        raise ValueError(f"operation must be one of: {', '.join(OPERATIONS[name])}")
    return HANDLERS[name](args)


def shutdown() -> None:
    for session_id in list(FIREFOX_SESSIONS):
        firefox_lab({"operation": "close", "session_id": session_id})
    for proc in list(CLIPBOARD_OWNERS.values()):
        _terminate_owned_process(proc)
    CLIPBOARD_OWNERS.clear()
    for proc in list(DEBUGGERS.values()):
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
    DEBUGGERS.clear()
    DEBUGGER_STATES.clear()
    for proc in list(PROCESSES.values()):
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
    deadline = time.monotonic() + 5
    for proc in list(PROCESSES.values()):
        try:
            proc.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=2)
    PROCESSES.clear()
    PROCESS_META.clear()
