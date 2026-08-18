#!/usr/bin/env python3
# ── Offline Supply-Chain Inventory Reconciliation ───────────────
# Correlates bounded Syft, Grype, and Trivy JSON evidence by package identity,
# keeping inventory disagreement distinct from advisory observations.
# → cyberful/builtin/skills/operate-supply-chain-toolchain/assets/supply-chain-manifest.schema.json — input contract.
# → cyberful/builtin/skills/operate-supply-chain-toolchain/tests/test_reconcile_supply_chain_inventory.py — coverage.
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


MAX_MANIFEST_BYTES: Final = 1_048_576
MAX_SOURCE_BYTES: Final = 128_000_000
MAX_SOURCES: Final = 24
MAX_PACKAGES: Final = 500_000
MAX_VULNERABILITIES: Final = 500_000
MAX_TEXT: Final = 4_096
SOURCE_KINDS: Final = frozenset(("syft-json", "grype-json", "trivy-json"))


class SupplyChainError(ValueError):
    """Raised when supply-chain evidence violates the bounded contract."""


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise SupplyChainError("workspace must be an existing directory")
    return workspace


def _confined_path(workspace: Path, value: str, *, must_exist: bool) -> Path:
    canonical_workspace = workspace.resolve(strict=True)
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise SupplyChainError("paths must be non-traversing and relative to the workspace")
    cursor = canonical_workspace
    for component in requested.parts:
        cursor = cursor / component
        if cursor.is_symlink():
            raise SupplyChainError(f"path component is a symbolic link: {component}")
    resolved = (canonical_workspace / requested).resolve(strict=must_exist)
    try:
        resolved.relative_to(canonical_workspace)
    except ValueError as error:
        raise SupplyChainError("path escapes the workspace") from error
    return resolved


def _read(path: Path, limit: int) -> bytes:
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
        raise SupplyChainError(f"{path.name} must be a regular file no larger than {limit} bytes")
    raw = path.read_bytes()
    if len(raw) > limit:
        raise SupplyChainError(f"{path.name} exceeds the {limit}-byte limit")
    return raw


def _object(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SupplyChainError(f"{label} must be UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise SupplyChainError(f"{label} must be a JSON object")
    return value


def _text(value: Any, label: str, *, optional: bool = False) -> str:
    if optional and (value is None or value == ""):
        return ""
    if not isinstance(value, str) or not value.strip():
        raise SupplyChainError(f"{label} must be a non-empty string")
    normalized = " ".join(value.split())
    if len(normalized) > MAX_TEXT:
        normalized = f"{normalized[: MAX_TEXT - 1].rstrip()}…"
    return normalized


def _source(value: Any, index: int) -> dict[str, str]:
    required = {"id", "kind", "path", "artifact"}
    label = f"sources[{index}]"
    if not isinstance(value, dict) or set(value) != required:
        raise SupplyChainError(f"{label} must contain exactly: {', '.join(sorted(required))}")
    result = {field: _text(value[field], f"{label}.{field}") for field in required}
    if result["kind"] not in SOURCE_KINDS:
        raise SupplyChainError(f"{label}.kind must be syft-json, grype-json, or trivy-json")
    return result


def _package(source: dict[str, str], name: Any, version: Any, purl: Any, locations: list[str]) -> dict[str, Any]:
    normalized_name = _text(name, "package name")
    normalized_version = _text(version, "package version", optional=True)
    normalized_purl = _text(purl, "package purl", optional=True)
    identity = normalized_purl or f"name:{normalized_name.lower()}@{normalized_version}"
    return {
        "identity": identity,
        "name": normalized_name,
        "version": normalized_version,
        "purl": normalized_purl,
        "artifact": source["artifact"],
        "source_id": source["id"],
        "locations": sorted(set(locations)),
    }


def _locations(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        if isinstance(item, dict):
            candidate = item.get("path") or item.get("RealPath") or item.get("Path")
            if isinstance(candidate, str) and candidate.strip():
                result.append(_text(candidate, "package location"))
        elif isinstance(item, str) and item.strip():
            result.append(_text(item, "package location"))
    return result


def _vulnerability(source: dict[str, str], package: dict[str, Any], identifier: Any, severity: Any, fixed_versions: list[str]) -> dict[str, Any]:
    return {
        "identity": f"{_text(identifier, 'vulnerability id')}|{package['artifact']}|{package['identity']}",
        "id": _text(identifier, "vulnerability id"),
        "severity": _text(severity, "vulnerability severity", optional=True).lower(),
        "artifact": package["artifact"],
        "package_identity": package["identity"],
        "package_name": package["name"],
        "installed_version": package["version"],
        "fixed_versions": sorted(set(fixed_versions)),
        "source_id": source["id"],
    }


def _syft(payload: dict[str, Any], source: dict[str, str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool]:
    artifacts = payload.get("artifacts")
    if not isinstance(artifacts, list):
        raise SupplyChainError("Syft source must contain an artifacts array")
    packages = []
    for index, artifact in enumerate(artifacts):
        if not isinstance(artifact, dict):
            raise SupplyChainError(f"Syft artifacts[{index}] must be an object")
        packages.append(_package(source, artifact.get("name"), artifact.get("version"), artifact.get("purl"), _locations(artifact.get("locations"))))
    return packages, [], True


def _grype(payload: dict[str, Any], source: dict[str, str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool]:
    matches = payload.get("matches")
    if not isinstance(matches, list):
        raise SupplyChainError("Grype source must contain a matches array")
    packages: list[dict[str, Any]] = []
    vulnerabilities: list[dict[str, Any]] = []
    for index, match in enumerate(matches):
        if not isinstance(match, dict) or not isinstance(match.get("artifact"), dict) or not isinstance(match.get("vulnerability"), dict):
            raise SupplyChainError(f"Grype matches[{index}] is malformed")
        artifact = match["artifact"]
        vulnerability = match["vulnerability"]
        package = _package(source, artifact.get("name"), artifact.get("version"), artifact.get("purl"), _locations(artifact.get("locations")))
        fix = vulnerability.get("fix", {})
        fixed = fix.get("versions", []) if isinstance(fix, dict) else []
        fixed_versions = [_text(value, "Grype fixed version") for value in fixed] if isinstance(fixed, list) else []
        packages.append(package)
        vulnerabilities.append(_vulnerability(source, package, vulnerability.get("id"), vulnerability.get("severity"), fixed_versions))
    return packages, vulnerabilities, False


def _trivy(payload: dict[str, Any], source: dict[str, str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool]:
    results = payload.get("Results")
    if not isinstance(results, list):
        raise SupplyChainError("Trivy source must contain a Results array")
    packages: list[dict[str, Any]] = []
    vulnerabilities: list[dict[str, Any]] = []
    inventory_capable = False
    for result_index, result in enumerate(results):
        if not isinstance(result, dict):
            raise SupplyChainError(f"Trivy Results[{result_index}] must be an object")
        raw_packages = result.get("Packages", [])
        if "Packages" in result:
            inventory_capable = True
        if not isinstance(raw_packages, list):
            raise SupplyChainError(f"Trivy Results[{result_index}].Packages must be an array")
        for raw_package in raw_packages:
            if not isinstance(raw_package, dict):
                raise SupplyChainError("Trivy package must be an object")
            identifier = raw_package.get("Identifier", {})
            purl = identifier.get("PURL") if isinstance(identifier, dict) else raw_package.get("PURL")
            packages.append(_package(source, raw_package.get("Name"), raw_package.get("Version"), purl, _locations(raw_package.get("Locations"))))
        raw_vulnerabilities = result.get("Vulnerabilities", [])
        if not isinstance(raw_vulnerabilities, list):
            raise SupplyChainError(f"Trivy Results[{result_index}].Vulnerabilities must be an array")
        for raw_vulnerability in raw_vulnerabilities:
            if not isinstance(raw_vulnerability, dict):
                raise SupplyChainError("Trivy vulnerability must be an object")
            identifier = raw_vulnerability.get("PkgIdentifier", {})
            purl = identifier.get("PURL") if isinstance(identifier, dict) else None
            package = _package(source, raw_vulnerability.get("PkgName"), raw_vulnerability.get("InstalledVersion"), purl, [result.get("Target", "")] if result.get("Target") else [])
            fixed = raw_vulnerability.get("FixedVersion", "")
            fixed_versions = [_text(item, "Trivy fixed version") for item in str(fixed).split(",") if item.strip()]
            packages.append(package)
            vulnerabilities.append(_vulnerability(source, package, raw_vulnerability.get("VulnerabilityID"), raw_vulnerability.get("Severity"), fixed_versions))
    return packages, vulnerabilities, inventory_capable


# ── Presence And Advisory Evidence Remain Separate ───────────────
# SBOM tools establish package observations while vulnerability scanners attach
# advisories to their own resolved identities. The report compares inventories
# only between sources that actually enumerate packages, and never interprets an
# advisory match as proof that affected code is loaded, reachable, or exploitable.
# ─────────────────────────────────────────────────────────────────
def reconcile_manifest(payload: dict[str, Any], workspace: Path, manifest_sha256: str) -> dict[str, Any]:
    if set(payload) - {"$schema", "sources"}:
        raise SupplyChainError("manifest contains unknown fields")
    raw_sources = payload.get("sources")
    if not isinstance(raw_sources, list) or not raw_sources or len(raw_sources) > MAX_SOURCES:
        raise SupplyChainError(f"sources must contain between 1 and {MAX_SOURCES} entries")
    sources = [_source(value, index) for index, value in enumerate(raw_sources)]
    if len({source["id"] for source in sources}) != len(sources):
        raise SupplyChainError("source ids must be unique")

    packages: list[dict[str, Any]] = []
    vulnerabilities: list[dict[str, Any]] = []
    inventory_sources: set[str] = set()
    digests: list[dict[str, str]] = []
    parsers = {"syft-json": _syft, "grype-json": _grype, "trivy-json": _trivy}
    for source in sources:
        path = _confined_path(workspace, source["path"], must_exist=True)
        raw = _read(path, MAX_SOURCE_BYTES)
        digests.append({"id": source["id"], "sha256": hashlib.sha256(raw).hexdigest()})
        source_packages, source_vulnerabilities, inventory_capable = parsers[source["kind"]](_object(raw, f"source {source['id']}"), source)
        packages.extend(source_packages)
        vulnerabilities.extend(source_vulnerabilities)
        if inventory_capable:
            inventory_sources.add(source["id"])
        if len(packages) > MAX_PACKAGES or len(vulnerabilities) > MAX_VULNERABILITIES:
            raise SupplyChainError("normalized package or vulnerability observations exceed the configured limit")

    package_groups: defaultdict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for package in packages:
        package_groups[(package["artifact"], package["identity"])].append(package)
    normalized_packages: list[dict[str, Any]] = []
    disagreements: list[dict[str, Any]] = []
    for (artifact, identity), observations in sorted(package_groups.items()):
        representative = sorted(observations, key=lambda item: item["source_id"])[0]
        observed_sources = sorted({item["source_id"] for item in observations})
        inventory_observed = sorted(set(observed_sources) & inventory_sources)
        normalized = {
            "artifact": artifact,
            "identity": identity,
            "name": representative["name"],
            "version": representative["version"],
            "purl": representative["purl"],
            "sources": observed_sources,
            "locations": sorted({location for item in observations for location in item["locations"]}),
        }
        normalized_packages.append(normalized)
        if len(inventory_sources) > 1 and set(inventory_observed) != inventory_sources:
            disagreements.append({"artifact": artifact, "package_identity": identity, "observed_in": inventory_observed, "missing_from": sorted(inventory_sources - set(inventory_observed))})

    vulnerability_groups: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for vulnerability in vulnerabilities:
        vulnerability_groups[vulnerability["identity"]].append(vulnerability)
    normalized_vulnerabilities = []
    for identity, observations in sorted(vulnerability_groups.items()):
        representative = sorted(observations, key=lambda item: item["source_id"])[0]
        normalized_vulnerabilities.append({
            **{key: value for key, value in representative.items() if key not in {"source_id", "fixed_versions"}},
            "sources": sorted({item["source_id"] for item in observations}),
            "severities": sorted({item["severity"] for item in observations if item["severity"]}),
            "fixed_versions": sorted({version for item in observations for version in item["fixed_versions"]}),
        })

    return {
        "format": "cyberful.supply-chain-reconciliation.v1",
        "manifest_sha256": manifest_sha256,
        "sources": sorted(digests, key=lambda item: item["id"]),
        "summary": {
            "source_count": len(sources),
            "inventory_source_count": len(inventory_sources),
            "package_observation_count": len(packages),
            "package_count": len(normalized_packages),
            "inventory_disagreement_count": len(disagreements),
            "vulnerability_observation_count": len(vulnerabilities),
            "vulnerability_count": len(normalized_vulnerabilities),
        },
        "packages": normalized_packages,
        "inventory_disagreements": disagreements,
        "vulnerabilities": normalized_vulnerabilities,
        "interpretation": "Inventory and advisory correlations require artifact, reachability, backport, configuration, and runtime validation before a vulnerability conclusion.",
    }


def _write_report(workspace: Path, value: str, report: dict[str, Any], protected_sources: set[Path]) -> None:
    destination = _confined_path(workspace, value, must_exist=False)
    if destination in protected_sources:
        raise SupplyChainError("output must not replace the manifest or input evidence")
    if not destination.parent.is_dir():
        raise SupplyChainError("output parent must be an existing directory")
    if destination.exists() and not destination.is_file():
        raise SupplyChainError("output must be a regular file or a new path")
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
    parser = argparse.ArgumentParser(description="Reconcile Syft, Grype, and Trivy JSON evidence offline.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output")
    arguments = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        workspace = _workspace(arguments.workspace)
        manifest_path = _confined_path(workspace, arguments.input, must_exist=True)
        raw = _read(manifest_path, MAX_MANIFEST_BYTES)
        payload = _object(raw, "manifest")
        report = reconcile_manifest(payload, workspace, hashlib.sha256(raw).hexdigest())
        if arguments.output:
            protected_sources = {manifest_path, *(_confined_path(workspace, source["path"], must_exist=True) for source in payload["sources"])}
            _write_report(workspace, arguments.output, report, protected_sources)
        else:
            print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    except (SupplyChainError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
