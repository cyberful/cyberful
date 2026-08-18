#!/usr/bin/env python3
# ── Offline Network Scan Reconciliation ─────────────────────────
# Converts bounded Nmap XML and Masscan JSON evidence into one stable endpoint
# inventory while preserving source identity and scanner disagreement.
# → cyberful/builtin/skills/operate-network-recon/assets/network-scan-manifest.schema.json — input contract.
# → cyberful/builtin/skills/operate-network-recon/tests/test_reconcile_network_scans.py — coverage.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import os
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any, Final
import xml.etree.ElementTree as ET


MAX_MANIFEST_BYTES: Final = 1_048_576
MAX_SOURCE_BYTES: Final = 16_777_216
MAX_SOURCES: Final = 32
MAX_ENDPOINTS: Final = 200_000
MAX_TEXT: Final = 1_024
SOURCE_KINDS: Final = frozenset(("nmap-xml", "masscan-json"))


class ReconciliationError(ValueError):
    """Raised when a manifest, source, or path violates the helper contract."""


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise ReconciliationError("workspace must be an existing directory")
    return workspace


def _confined_path(workspace: Path, value: str, *, must_exist: bool) -> Path:
    canonical_workspace = workspace.resolve(strict=True)
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise ReconciliationError("paths must be non-traversing and relative to the workspace")
    cursor = canonical_workspace
    for component in requested.parts:
        cursor = cursor / component
        if cursor.is_symlink():
            raise ReconciliationError(f"path component is a symbolic link: {component}")
    resolved = (canonical_workspace / requested).resolve(strict=must_exist)
    try:
        resolved.relative_to(canonical_workspace)
    except ValueError as error:
        raise ReconciliationError("path escapes the workspace") from error
    return resolved


def _read_regular(path: Path, limit: int) -> bytes:
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
        raise ReconciliationError(f"{path.name} must be a regular file no larger than {limit} bytes")
    raw = path.read_bytes()
    if len(raw) > limit:
        raise ReconciliationError(f"{path.name} exceeds the {limit}-byte limit")
    return raw


def _json_object(raw: bytes, label: str) -> dict[str, Any]:
    try:
        decoded = raw.decode("utf-8")
        value = json.loads(decoded)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReconciliationError(f"{label} must be UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise ReconciliationError(f"{label} must be a JSON object")
    return value


def _text(value: Any, label: str, *, optional: bool = False) -> str:
    if optional and (value is None or value == ""):
        return ""
    if not isinstance(value, str) or not value.strip():
        raise ReconciliationError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > MAX_TEXT or any(ord(character) < 32 for character in normalized):
        raise ReconciliationError(f"{label} exceeds its text boundary or contains control characters")
    return normalized


def _source(value: Any, index: int) -> dict[str, str]:
    label = f"sources[{index}]"
    required = {"id", "kind", "path", "vantage", "observed_at"}
    if not isinstance(value, dict) or set(value) != required:
        raise ReconciliationError(f"{label} must contain exactly: {', '.join(sorted(required))}")
    result = {field: _text(value[field], f"{label}.{field}") for field in required}
    if result["kind"] not in SOURCE_KINDS:
        raise ReconciliationError(f"{label}.kind must be nmap-xml or masscan-json")
    return result


def _endpoint(source: dict[str, str], **fields: Any) -> dict[str, Any]:
    return {
        "address": str(fields.get("address", "")),
        "hostname": str(fields.get("hostname", "")),
        "port": int(fields.get("port", 0)),
        "protocol": str(fields.get("protocol", "")),
        "state": str(fields.get("state", "unknown")),
        "service": str(fields.get("service", "")),
        "product": str(fields.get("product", "")),
        "version": str(fields.get("version", "")),
        "tunnel": str(fields.get("tunnel", "")),
        "reason": str(fields.get("reason", "")),
        "source_id": source["id"],
        "source_kind": source["kind"],
        "vantage": source["vantage"],
        "observed_at": source["observed_at"],
    }


def _parse_nmap(raw: bytes, source: dict[str, str]) -> list[dict[str, Any]]:
    lowered = raw.lower()
    if b"<!doctype" in lowered or b"<!entity" in lowered:
        raise ReconciliationError("Nmap XML must not contain DTD or entity declarations")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as error:
        raise ReconciliationError("Nmap source is not valid XML") from error
    endpoints: list[dict[str, Any]] = []
    for host in root.findall("host"):
        address_nodes = [item for item in host.findall("address") if item.get("addr")]
        addresses = [
            item.get("addr", "")
            for address_type in ("ipv4", "ipv6")
            for item in address_nodes
            if item.get("addrtype") == address_type
        ]
        if not addresses:
            addresses = [item.get("addr", "") for item in address_nodes]
        if not addresses:
            continue
        hostname_node = host.find("hostnames/hostname")
        hostname = hostname_node.get("name", "") if hostname_node is not None else ""
        for port in host.findall("ports/port"):
            state_node = port.find("state")
            service_node = port.find("service")
            try:
                port_number = int(port.get("portid", "0"))
            except ValueError as error:
                raise ReconciliationError("Nmap portid must be an integer") from error
            if port_number < 1 or port_number > 65_535:
                raise ReconciliationError("Nmap portid is outside 1..65535")
            endpoints.append(
                _endpoint(
                    source,
                    address=addresses[0],
                    hostname=hostname,
                    port=port_number,
                    protocol=port.get("protocol", ""),
                    state=state_node.get("state", "unknown") if state_node is not None else "unknown",
                    reason=state_node.get("reason", "") if state_node is not None else "",
                    service=service_node.get("name", "") if service_node is not None else "",
                    product=service_node.get("product", "") if service_node is not None else "",
                    version=service_node.get("version", "") if service_node is not None else "",
                    tunnel=service_node.get("tunnel", "") if service_node is not None else "",
                )
            )
    return endpoints


def _parse_masscan(raw: bytes, source: dict[str, str]) -> list[dict[str, Any]]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReconciliationError("Masscan source must be UTF-8 JSON") from error
    records = value if isinstance(value, list) else [value]
    endpoints: list[dict[str, Any]] = []
    for record_index, record in enumerate(records):
        if not isinstance(record, dict) or not isinstance(record.get("ip"), str):
            raise ReconciliationError(f"Masscan record {record_index} must contain an ip string")
        ports = record.get("ports")
        if not isinstance(ports, list):
            raise ReconciliationError(f"Masscan record {record_index}.ports must be an array")
        for port_index, port in enumerate(ports):
            if not isinstance(port, dict) or not isinstance(port.get("port"), int):
                raise ReconciliationError(f"Masscan record {record_index}.ports[{port_index}] is malformed")
            if port["port"] < 1 or port["port"] > 65_535:
                raise ReconciliationError("Masscan port is outside 1..65535")
            endpoints.append(
                _endpoint(
                    source,
                    address=record["ip"],
                    port=port["port"],
                    protocol=port.get("proto", ""),
                    state=port.get("status", "unknown"),
                    reason=port.get("reason", ""),
                    service=port.get("service", {}).get("name", "") if isinstance(port.get("service"), dict) else "",
                )
            )
    return endpoints


# ── Disagreement Is Evidence, Not A Winner Selection ─────────────
# Scanner state differs with timing, probe shape, retries, and network policy.
# The reconciler therefore retains every normalized observation and records only
# state sets that conflict for one endpoint tuple. It never chooses one scanner
# as authoritative or promotes an open port into a vulnerability conclusion.
# ─────────────────────────────────────────────────────────────────
def reconcile_manifest(payload: dict[str, Any], workspace: Path, manifest_sha256: str) -> dict[str, Any]:
    if set(payload) - {"$schema", "sources"}:
        raise ReconciliationError("manifest contains unknown fields")
    raw_sources = payload.get("sources")
    if not isinstance(raw_sources, list) or not raw_sources or len(raw_sources) > MAX_SOURCES:
        raise ReconciliationError(f"sources must contain between 1 and {MAX_SOURCES} entries")
    sources = [_source(value, index) for index, value in enumerate(raw_sources)]
    source_ids = [source["id"] for source in sources]
    if len(source_ids) != len(set(source_ids)):
        raise ReconciliationError("source ids must be unique")

    endpoints: list[dict[str, Any]] = []
    source_digests: list[dict[str, str]] = []
    for source in sources:
        path = _confined_path(workspace, source["path"], must_exist=True)
        raw = _read_regular(path, MAX_SOURCE_BYTES)
        source_digests.append({"id": source["id"], "sha256": hashlib.sha256(raw).hexdigest()})
        parsed = _parse_nmap(raw, source) if source["kind"] == "nmap-xml" else _parse_masscan(raw, source)
        endpoints.extend(parsed)
        if len(endpoints) > MAX_ENDPOINTS:
            raise ReconciliationError(f"normalized endpoints exceed the {MAX_ENDPOINTS}-entry limit")

    endpoints.sort(key=lambda item: (item["address"], item["port"], item["protocol"], item["source_id"]))
    states: defaultdict[tuple[str, int, str], set[str]] = defaultdict(set)
    for endpoint in endpoints:
        states[(endpoint["address"], endpoint["port"], endpoint["protocol"])].add(endpoint["state"])
    disagreements = [
        {"address": key[0], "port": key[1], "protocol": key[2], "states": sorted(values)}
        for key, values in sorted(states.items())
        if len(values) > 1
    ]
    return {
        "format": "cyberful.network-reconciliation.v1",
        "manifest_sha256": manifest_sha256,
        "sources": sorted(source_digests, key=lambda item: item["id"]),
        "summary": {
            "source_count": len(sources),
            "observation_count": len(endpoints),
            "endpoint_count": len(states),
            "disagreement_count": len(disagreements),
        },
        "endpoints": endpoints,
        "disagreements": disagreements,
        "interpretation": "Scanner disagreement requires a same-vantage protocol check; this report is inventory evidence, not a vulnerability verdict.",
    }


def _write_report(workspace: Path, value: str, report: dict[str, Any], protected_sources: set[Path]) -> None:
    destination = _confined_path(workspace, value, must_exist=False)
    if destination in protected_sources:
        raise ReconciliationError("output must not replace the manifest or input evidence")
    if not destination.parent.is_dir():
        raise ReconciliationError("output parent must be an existing directory")
    if destination.exists() and not destination.is_file():
        raise ReconciliationError("output must be a regular file or a new path")
    rendered = f"{json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False)}\n"
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=destination.parent, prefix=f".{destination.name}.", delete=False) as temporary:
            temporary_name = temporary.name
            os.chmod(temporary_name, 0o600)
            temporary.write(rendered)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, destination)
        temporary_name = None
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Reconcile Nmap XML and Masscan JSON evidence offline.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True, help="Workspace-relative reconciliation manifest.")
    parser.add_argument("--output", help="Workspace-relative report path; omit for stdout.")
    arguments = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        workspace = _workspace(arguments.workspace)
        manifest_path = _confined_path(workspace, arguments.input, must_exist=True)
        raw = _read_regular(manifest_path, MAX_MANIFEST_BYTES)
        payload = _json_object(raw, "manifest")
        report = reconcile_manifest(payload, workspace, hashlib.sha256(raw).hexdigest())
        if arguments.output:
            protected_sources = {manifest_path, *(_confined_path(workspace, source["path"], must_exist=True) for source in payload["sources"])}
            _write_report(workspace, arguments.output, report, protected_sources)
        else:
            print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    except (ReconciliationError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
