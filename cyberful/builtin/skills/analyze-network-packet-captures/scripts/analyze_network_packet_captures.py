#!/usr/bin/env python3
# ── Offline Classic PCAP Evidence Analysis ──────────────────────
# Validates and summarizes bounded classic PCAP snapshots without invoking a
#   dissector, resolving names, opening sockets, or assigning attack meaning.
# → cyberful/builtin/skills/analyze-network-packet-captures/assets/packet-capture-analysis.schema.json — input contract.
# → cyberful/builtin/skills/analyze-network-packet-captures/tests/test_analyze_network_packet_captures.py — parser tests.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile
import time
from typing import Any, Final


MAX_CONFIG_BYTES: Final = 262_144
MAX_FILES: Final = 32
MAX_PACKETS: Final = 1_000_000
MAX_TOTAL_BYTES: Final = 268_435_456
MAX_OUTPUT_BYTES: Final = 4_194_304
MAX_TIMEOUT_SECONDS: Final = 120
FIELDS: Final = frozenset({"$schema", "analysis_id", "scope_reference", "capture_files", "max_packets", "max_total_bytes", "timeout_seconds", "output_limit_bytes"})
MAGIC: Final = {b"\xd4\xc3\xb2\xa1": ("<", "little", "microseconds", 1_000_000), b"\xa1\xb2\xc3\xd4": (">", "big", "microseconds", 1_000_000), b"\x4d\x3c\xb2\xa1": ("<", "little", "nanoseconds", 1_000_000_000), b"\xa1\xb2\x3c\x4d": (">", "big", "nanoseconds", 1_000_000_000)}


class AnalysisError(ValueError):
    """Raised when capture evidence violates the bounded parser contract."""


def _deadline(deadline: float, stage: str) -> None:
    if time.monotonic() >= deadline:
        raise AnalysisError(f"analysis deadline expired during {stage}")


def _text(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AnalysisError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > maximum or any(ord(character) < 32 for character in normalized):
        raise AnalysisError(f"{label} exceeds its text boundary")
    return normalized


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise AnalysisError(f"{label} must be between {minimum} and {maximum}")
    return value


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise AnalysisError("workspace must be an existing directory")
    return workspace


def _confined(workspace: Path, value: str, *, exists: bool) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise AnalysisError("paths must be relative and non-traversing")
    cursor = workspace
    for component in requested.parts:
        cursor /= component
        if cursor.is_symlink():
            raise AnalysisError("symbolic links are not allowed")
    resolved = (workspace / requested).resolve(strict=exists)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise AnalysisError("path escapes workspace") from error
    return resolved


def _snapshot(path: Path, maximum: int, deadline: float) -> bytes:
    if maximum < 1:
        raise AnalysisError("capture files exceed max_total_bytes")
    expected = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(expected.st_mode) or expected.st_size > maximum:
        raise AnalysisError(f"{path.name} must be a bounded regular non-symlink file")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino):
            raise AnalysisError(f"{path.name} changed before snapshot")
        chunks = []
        observed = 0
        while True:
            _deadline(deadline, "capture snapshot")
            chunk = os.read(descriptor, min(65_536, maximum - observed + 1))
            if not chunk:
                break
            observed += len(chunk)
            if observed > maximum or observed > expected.st_size:
                raise AnalysisError(f"{path.name} exceeds its byte boundary")
            chunks.append(chunk)
        final = os.fstat(descriptor)
        if observed != expected.st_size or (final.st_dev, final.st_ino, final.st_size) != (expected.st_dev, expected.st_ino, expected.st_size):
            raise AnalysisError(f"{path.name} changed during snapshot")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _json(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AnalysisError(f"{label} must be UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise AnalysisError(f"{label} must contain a JSON object")
    return value


def _config(value: dict[str, Any]) -> tuple[str, str, list[str], int, int, int, int]:
    if set(value) != FIELDS or value["$schema"] != "./packet-capture-analysis.schema.json":
        raise AnalysisError("input fields or schema identity are invalid")
    files = value["capture_files"]
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise AnalysisError("capture_files must be a bounded non-empty array")
    normalized = [_text(item, "capture_files[]", 1024) for item in files]
    if len(set(normalized)) != len(normalized):
        raise AnalysisError("capture_files must not contain duplicates")
    return (_text(value["analysis_id"], "analysis_id", 256), _text(value["scope_reference"], "scope_reference", 512), sorted(normalized), _integer(value["max_packets"], "max_packets", 1, MAX_PACKETS), _integer(value["max_total_bytes"], "max_total_bytes", 24, MAX_TOTAL_BYTES), _integer(value["timeout_seconds"], "timeout_seconds", 1, MAX_TIMEOUT_SECONDS), _integer(value["output_limit_bytes"], "output_limit_bytes", 1024, MAX_OUTPUT_BYTES))


def _protocols(packet: bytes, link_type: int, counts: Counter[str]) -> None:
    if link_type != 1 or len(packet) < 14:
        counts["unclassified"] += 1
        return
    counts["ethernet"] += 1
    ether_type = int.from_bytes(packet[12:14], "big")
    if ether_type == 0x0800 and len(packet) >= 34:
        counts["ipv4"] += 1
        protocol = packet[23]
    elif ether_type == 0x86DD and len(packet) >= 54:
        counts["ipv6"] += 1
        protocol = packet[20]
    elif ether_type == 0x0806:
        counts["arp"] += 1
        return
    else:
        counts["other-ethertype"] += 1
        return
    counts[{1: "icmp", 6: "tcp", 17: "udp", 58: "icmpv6"}.get(protocol, "other-ip-protocol")] += 1


def _timestamp(seconds: int, fraction: int, precision: str) -> str:
    width = 6 if precision == "microseconds" else 9
    return f"{seconds}.{fraction:0{width}d}"


def _parse(raw: bytes, path: str, remaining_packets: int, deadline: float) -> dict[str, Any]:
    if len(raw) < 24 or raw[:4] not in MAGIC:
        raise AnalysisError(f"{path} is not a supported classic PCAP")
    endian, byte_order, precision, fraction_base = MAGIC[raw[:4]]
    major, minor, _, _, snaplen, link_type = struct.unpack_from(f"{endian}HHiIII", raw, 4)
    if major != 2 or snaplen < 1:
        raise AnalysisError(f"{path} has an unsupported PCAP header")
    offset = 24
    packets = 0
    captured_bytes = 0
    original_bytes = 0
    previous: tuple[int, int] | None = None
    first: str | None = None
    last: str | None = None
    non_monotonic = False
    truncated = 0
    buckets: Counter[str] = Counter()
    protocols: Counter[str] = Counter()
    while offset < len(raw):
        _deadline(deadline, "packet parsing")
        if len(raw) - offset < 16:
            raise AnalysisError(f"{path} ends inside a packet header")
        seconds, fraction, included, original = struct.unpack_from(f"{endian}IIII", raw, offset)
        offset += 16
        if fraction >= fraction_base or included > snaplen or original < included or included > len(raw) - offset:
            raise AnalysisError(f"{path} contains an invalid packet record")
        packets += 1
        if packets > remaining_packets:
            raise AnalysisError("capture records exceed max_packets")
        packet = raw[offset:offset + included]
        offset += included
        captured_bytes += included
        original_bytes += original
        truncated += int(included < original)
        current = (seconds, fraction)
        non_monotonic = non_monotonic or (previous is not None and current < previous)
        previous = current
        rendered = _timestamp(seconds, fraction, precision)
        first = rendered if first is None else first
        last = rendered
        bucket = "le-64" if included <= 64 else "le-128" if included <= 128 else "le-512" if included <= 512 else "le-1500" if included <= 1500 else "gt-1500"
        buckets[bucket] += 1
        _protocols(packet, link_type, protocols)
    tags = []
    if truncated:
        tags.append("capture-contains-truncated-packets")
    if non_monotonic:
        tags.append("timestamps-not-monotonic")
    if link_type != 1:
        tags.append("link-type-not-shallow-decoded")
    return {"path": path, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "byte_order": byte_order, "timestamp_precision": precision, "version": f"{major}.{minor}", "snaplen": snaplen, "link_type": link_type, "packets": packets, "captured_bytes": captured_bytes, "original_bytes": original_bytes, "first_timestamp": first, "last_timestamp": last, "length_buckets": dict(sorted(buckets.items())), "protocol_counts": dict(sorted(protocols.items())), "evidence_tags": sorted(tags)}


def _analyze(config: dict[str, Any], digest: str, workspace: Path, deadline: float) -> tuple[dict[str, Any], int]:
    workspace = workspace.resolve(strict=True)
    analysis_id, scope_reference, files, max_packets, max_bytes, timeout, output_limit = _config(config)
    captures = []
    total_bytes = 0
    total_packets = 0
    for relative in files:
        _deadline(deadline, "capture enumeration")
        raw = _snapshot(_confined(workspace, relative, exists=True), max_bytes - total_bytes, deadline)
        total_bytes += len(raw)
        capture = _parse(raw, relative, max_packets - total_packets, deadline)
        total_packets += capture["packets"]
        captures.append(capture)
    protocol_counts: Counter[str] = Counter()
    tag_counts: Counter[str] = Counter()
    for capture in captures:
        protocol_counts.update(capture["protocol_counts"])
        tag_counts.update(capture["evidence_tags"])
    report = {"format": "cyberful.packet-capture-evidence.v1", "analysis_id": analysis_id, "scope_reference": scope_reference, "input_sha256": digest, "captures": captures, "summary": {"files": len(captures), "packets": total_packets, "captured_bytes": sum(item["captured_bytes"] for item in captures), "original_bytes": sum(item["original_bytes"] for item in captures), "protocol_counts": dict(sorted(protocol_counts.items())), "evidence_tags": dict(sorted(tag_counts.items()))}, "limits": {"packets": max_packets, "input_bytes": max_bytes, "output_bytes": output_limit, "timeout_seconds": timeout}, "interpretation": "Capture metadata and protocol counts describe evidence quality and composition; they are not attack or vulnerability verdicts."}
    return report, output_limit


def _write(path: Path, value: dict[str, Any], limit: int, deadline: float) -> None:
    _deadline(deadline, "evidence serialization")
    raw = f"{json.dumps(value, indent=2, sort_keys=True)}\n".encode()
    if len(raw) > limit:
        raise AnalysisError("packet evidence exceeds output_limit_bytes")
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
            temporary = handle.name
            os.chmod(temporary, 0o600)
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        _deadline(deadline, "evidence publication")
        os.link(temporary, path)
        Path(temporary).unlink()
        temporary = None
    finally:
        if temporary:
            Path(temporary).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Analyze bounded classic PCAP evidence offline")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(argv)
    started = time.monotonic()
    try:
        workspace = _workspace(arguments.workspace)
        source = _confined(workspace, arguments.input, exists=True)
        output = _confined(workspace, arguments.output, exists=False)
        if output.exists() or output == source or not output.parent.is_dir():
            raise AnalysisError("output must be new, distinct, and below an existing directory")
        raw = _snapshot(source, MAX_CONFIG_BYTES, started + MAX_TIMEOUT_SECONDS)
        config = _json(raw, "input")
        deadline = started + _integer(config.get("timeout_seconds"), "timeout_seconds", 1, MAX_TIMEOUT_SECONDS)
        report, limit = _analyze(config, hashlib.sha256(raw).hexdigest(), workspace, deadline)
        _write(output, report, limit, deadline)
    except (AnalysisError, OSError) as error:
        print(f"packet capture analysis error: {error}", file=sys.stderr)
        return 2
    print(output.relative_to(workspace).as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
