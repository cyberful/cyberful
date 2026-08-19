#!/usr/bin/env python3
# ── PCI DSS Penetration Evidence Audit ──────────────────────────
# Normalizes a bounded local metadata ledger and exposes Requirement 11.4
#   evidence coverage, conflicts, and applicability warnings without verdicts.
# → cyberful/builtin/skills/audit-pci-dss-penetration-test-evidence/assets/pci-penetration-evidence.schema.json — input contract.
# → cyberful/builtin/skills/audit-pci-dss-penetration-test-evidence/tests/test_audit_pci_penetration_evidence.py — boundary tests.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time
from typing import Any, Final


INPUT_SCHEMA: Final = "assets/pci-penetration-evidence.schema.json"
STANDARD_VERSION: Final = "PCI DSS 4.0.1"
MAX_INPUT_BYTES: Final = 1_048_576
MAX_OUTPUT_BYTES: Final = 2_097_152
MAX_RECORDS: Final = 2_048
MAX_TEXT_BYTES: Final = 2_048
MAX_ID_BYTES: Final = 256
MAX_EVIDENCE_REFS: Final = 64
TIMEOUT_SECONDS: Final = 10
ENTITY_TYPES: Final = frozenset(("merchant", "service-provider", "multi-tenant-service-provider"))
REQUIREMENTS: Final = ("11.4.1", "11.4.2", "11.4.3", "11.4.4", "11.4.5", "11.4.6", "11.4.7")
STATUSES: Final = ("supported", "gap", "blocked", "not-applicable")
SOURCE_TYPES: Final = frozenset(("methodology", "scope", "internal-report", "external-report", "segmentation-report", "qualification", "independence", "remediation", "retest", "retention", "provider-customer-support", "other"))
INPUT_FIELDS: Final = frozenset(("$schema", "assessment_id", "standard_version", "entity_type", "segmentation_used", "assessment_period", "records"))
RECORD_FIELDS: Final = frozenset(("record_id", "requirement", "topic", "status", "source_type", "evidence_date", "evidence_refs", "rationale"))


class AuditError(ValueError):
    """Raised when evidence metadata violates the offline audit contract."""


@dataclass(frozen=True)
class EvidenceRecord:
    record_id: str
    requirement: str
    topic: str
    status: str
    source_type: str
    evidence_date: str
    evidence_refs: tuple[str, ...]
    rationale: str


@dataclass(frozen=True)
class AuditInput:
    assessment_id: str
    entity_type: str
    segmentation_used: bool
    period_start: str
    period_end: str
    records: tuple[EvidenceRecord, ...]


# ── Metadata Coverage Is Not A Compliance Verdict ───────────────
# This analyzer never opens a referenced report and therefore cannot judge the
#   competence of a test, the truth of a finding, or the effectiveness of a
#   control. It derives only the requirement set implied by declared entity type
#   and segmentation use, then organizes supplied metadata against that set.
# Conflicts and absent support are review targets; neither a populated ledger nor
#   an empty gap list authorizes a PCI DSS compliance or attestation statement.
# ─────────────────────────────────────────────────────────────────


def _deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise AuditError("PCI evidence audit exceeded its global deadline")


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise AuditError("workspace must be an existing directory")
    return workspace


def _confined(workspace: Path, value: str, *, exists: bool) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise AuditError("paths must be relative and non-traversing")
    cursor = workspace
    for component in requested.parts:
        cursor /= component
        if cursor.is_symlink():
            raise AuditError("symbolic links are not allowed")
    resolved = (workspace / requested).resolve(strict=exists)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise AuditError("path escapes workspace") from error
    return resolved


def _read_json(path: Path, workspace: Path, deadline: float) -> tuple[Any, bytes, tuple[int, int]]:
    expected = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(expected.st_mode) or expected.st_size > MAX_INPUT_BYTES:
        raise AuditError("input must be a bounded regular file")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        canonical = path.resolve(strict=True)
        try:
            canonical.relative_to(workspace)
        except ValueError as error:
            raise AuditError("input resolved outside workspace") from error
        resolved = canonical.stat()
        identities = {(expected.st_dev, expected.st_ino), (opened.st_dev, opened.st_ino), (resolved.st_dev, resolved.st_ino)}
        if len(identities) != 1 or not stat.S_ISREG(opened.st_mode) or opened.st_size > MAX_INPUT_BYTES:
            raise AuditError("input identity changed while opening")
        chunks: list[bytes] = []
        observed = 0
        while True:
            _deadline(deadline)
            chunk = os.read(descriptor, min(65_536, MAX_INPUT_BYTES + 1 - observed))
            if not chunk:
                break
            chunks.append(chunk)
            observed += len(chunk)
            if observed > MAX_INPUT_BYTES:
                raise AuditError("input exceeds its byte boundary")
        final = os.fstat(descriptor)
        if (final.st_dev, final.st_ino, final.st_size) != (opened.st_dev, opened.st_ino, opened.st_size) or observed != opened.st_size:
            raise AuditError("input changed while reading")
        raw = b"".join(chunks)
    finally:
        os.close(descriptor)
    try:
        return json.loads(raw.decode("utf-8")), raw, (opened.st_dev, opened.st_ino)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise AuditError("input must be UTF-8 JSON") from error


def _text(value: Any, label: str, maximum: int = MAX_TEXT_BYTES) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AuditError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized.encode("utf-8")) > maximum or any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise AuditError(f"{label} exceeds its text boundary or contains control characters")
    return normalized


def _iso_date(value: Any, label: str) -> str:
    normalized = _text(value, label, 10)
    try:
        parsed = date.fromisoformat(normalized)
    except ValueError as error:
        raise AuditError(f"{label} must be an ISO date") from error
    if parsed.isoformat() != normalized:
        raise AuditError(f"{label} must be a canonical ISO date")
    return normalized


def _evidence_refs(value: Any, label: str) -> tuple[str, ...]:
    if not isinstance(value, list) or len(value) > MAX_EVIDENCE_REFS:
        raise AuditError(f"{label} must be a bounded array")
    normalized = tuple(sorted(_text(item, f"{label}[]") for item in value))
    if len(set(normalized)) != len(normalized):
        raise AuditError(f"{label} must not contain duplicates")
    return normalized


def _record(value: Any, index: int) -> EvidenceRecord:
    label = f"records[{index}]"
    if not isinstance(value, dict) or set(value) != RECORD_FIELDS:
        raise AuditError(f"{label} contains missing or unknown fields")
    requirement = _text(value["requirement"], f"{label}.requirement", 16)
    status_value = _text(value["status"], f"{label}.status", 32)
    source_type = _text(value["source_type"], f"{label}.source_type", 64)
    if requirement not in REQUIREMENTS or status_value not in STATUSES or source_type not in SOURCE_TYPES:
        raise AuditError(f"{label} contains an unsupported requirement, status, or source type")
    references = _evidence_refs(value["evidence_refs"], f"{label}.evidence_refs")
    if status_value == "supported" and not references:
        raise AuditError(f"{label} supported status requires at least one evidence reference")
    return EvidenceRecord(
        record_id=_text(value["record_id"], f"{label}.record_id", MAX_ID_BYTES),
        requirement=requirement,
        topic=_text(value["topic"], f"{label}.topic"),
        status=status_value,
        source_type=source_type,
        evidence_date=_iso_date(value["evidence_date"], f"{label}.evidence_date"),
        evidence_refs=references,
        rationale=_text(value["rationale"], f"{label}.rationale"),
    )


def _payload(value: Any, deadline: float) -> AuditInput:
    if not isinstance(value, dict) or set(value) != INPUT_FIELDS:
        raise AuditError("input contains missing or unknown fields")
    if value["$schema"] != INPUT_SCHEMA or value["standard_version"] != STANDARD_VERSION:
        raise AuditError("input $schema or standard version is unsupported")
    entity_type = _text(value["entity_type"], "entity_type", 64)
    if entity_type not in ENTITY_TYPES or not isinstance(value["segmentation_used"], bool):
        raise AuditError("entity_type or segmentation_used is invalid")
    period = value["assessment_period"]
    if not isinstance(period, dict) or set(period) != {"start", "end"}:
        raise AuditError("assessment_period must contain exactly start and end")
    period_start = _iso_date(period["start"], "assessment_period.start")
    period_end = _iso_date(period["end"], "assessment_period.end")
    if period_start > period_end:
        raise AuditError("assessment_period start must not follow end")
    values = value["records"]
    if not isinstance(values, list) or not values or len(values) > MAX_RECORDS:
        raise AuditError(f"records must contain between 1 and {MAX_RECORDS} entries")
    records: list[EvidenceRecord] = []
    for index, item in enumerate(values):
        _deadline(deadline)
        records.append(_record(item, index))
    identifiers = [item.record_id for item in records]
    if len(set(identifiers)) != len(identifiers):
        raise AuditError("record_id values must be unique")
    return AuditInput(
        assessment_id=_text(value["assessment_id"], "assessment_id", MAX_ID_BYTES),
        entity_type=entity_type,
        segmentation_used=value["segmentation_used"],
        period_start=period_start,
        period_end=period_end,
        records=tuple(records),
    )


def _applicable(entity_type: str, segmentation_used: bool) -> tuple[str, ...]:
    requirements = list(REQUIREMENTS[:4])
    if segmentation_used:
        requirements.append("11.4.5")
        if entity_type in {"service-provider", "multi-tenant-service-provider"}:
            requirements.append("11.4.6")
    if entity_type == "multi-tenant-service-provider":
        requirements.append("11.4.7")
    return tuple(requirements)


def run_audit(value: Any, input_sha256: str, deadline: float) -> dict[str, Any]:
    parsed = _payload(value, deadline)
    ordered = tuple(sorted(parsed.records, key=lambda item: (item.requirement, item.topic, item.evidence_date, item.record_id)))
    applicable = _applicable(parsed.entity_type, parsed.segmentation_used)
    by_requirement: dict[str, list[EvidenceRecord]] = defaultdict(list)
    by_topic: dict[tuple[str, str], list[EvidenceRecord]] = defaultdict(list)
    for record in ordered:
        _deadline(deadline)
        by_requirement[record.requirement].append(record)
        by_topic[(record.requirement, record.topic)].append(record)
    conflicts: list[dict[str, Any]] = []
    for (requirement, topic), records in sorted(by_topic.items()):
        _deadline(deadline)
        statuses = sorted({record.status for record in records})
        if len(statuses) > 1:
            conflicts.append({"requirement": requirement, "topic": topic, "statuses": statuses, "record_ids": sorted(record.record_id for record in records)})
    observed = tuple(sorted(by_requirement))
    unobserved = tuple(requirement for requirement in applicable if requirement not in by_requirement)
    without_supported = tuple(requirement for requirement in applicable if not any(record.status == "supported" for record in by_requirement.get(requirement, ())))
    warnings: list[str] = []
    applicable_set = set(applicable)
    for requirement in observed:
        _deadline(deadline)
        statuses = {record.status for record in by_requirement[requirement]}
        if requirement not in applicable_set and statuses != {"not-applicable"}:
            warnings.append(f"{requirement} has active evidence metadata but is not implied by the declared entity type and segmentation use.")
        if requirement in applicable_set and statuses == {"not-applicable"}:
            warnings.append(f"{requirement} is implied by the declared entity type and segmentation use but is recorded only as not-applicable.")
    counts = Counter(record.status for record in ordered)
    return {
        "format": "cyberful.pci-penetration-evidence-audit.raw.v1",
        "assessment_id": parsed.assessment_id,
        "standard_version": STANDARD_VERSION,
        "entity_type": parsed.entity_type,
        "segmentation_used": parsed.segmentation_used,
        "assessment_period": {"start": parsed.period_start, "end": parsed.period_end},
        "input_sha256": input_sha256,
        "limits": {"records": MAX_RECORDS, "input_bytes": MAX_INPUT_BYTES, "output_bytes": MAX_OUTPUT_BYTES, "timeout_seconds": TIMEOUT_SECONDS},
        "summary": {"record_count": len(ordered), "status_counts": {status_value: counts[status_value] for status_value in STATUSES}},
        "coverage": {"applicable_requirements": list(applicable), "observed_requirements": list(observed), "unobserved_requirements": list(unobserved), "without_supported_evidence": list(without_supported)},
        "conflicts": conflicts,
        "applicability_warnings": sorted(warnings),
        "records": [{**asdict(record), "evidence_refs": list(record.evidence_refs)} for record in ordered],
        "interpretation": "Bounded metadata organization only. Review each referenced artifact, applicability decision, technical result, tester qualification, and retest before reaching any PCI DSS assessment conclusion.",
    }


def _write(path: Path, value: dict[str, Any], deadline: float, parent_identity: tuple[int, int]) -> None:
    if path.exists():
        raise AuditError("output path already exists")
    _deadline(deadline)
    rendered = (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")
    if len(rendered) > MAX_OUTPUT_BYTES:
        raise AuditError("PCI evidence audit exceeds the output boundary")
    parent_descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    temporary_name = f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp"
    temporary_descriptor: int | None = None
    try:
        parent_opened = os.fstat(parent_descriptor)
        if not stat.S_ISDIR(parent_opened.st_mode) or (parent_opened.st_dev, parent_opened.st_ino) != parent_identity:
            raise AuditError("output parent identity changed")
        temporary_descriptor = os.open(temporary_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent_descriptor)
        view = memoryview(rendered)
        while view:
            _deadline(deadline)
            view = view[os.write(temporary_descriptor, view):]
        os.fsync(temporary_descriptor)
        _deadline(deadline)
        try:
            os.link(temporary_name, path.name, src_dir_fd=parent_descriptor, dst_dir_fd=parent_descriptor, follow_symlinks=False)
        except FileExistsError as error:
            raise AuditError("output path appeared before publication") from error
        os.fsync(parent_descriptor)
    finally:
        if temporary_descriptor is not None:
            os.close(temporary_descriptor)
        try:
            os.unlink(temporary_name, dir_fd=parent_descriptor)
        except FileNotFoundError:
            pass
        os.close(parent_descriptor)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Audit bounded PCI DSS penetration-test evidence metadata offline.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(argv)
    deadline = time.monotonic() + TIMEOUT_SECONDS
    try:
        workspace = _workspace(arguments.workspace)
        source = _confined(workspace, arguments.input, exists=True)
        destination = _confined(workspace, arguments.output, exists=False)
        if source == destination or destination.exists() or not destination.parent.is_dir():
            raise AuditError("output must be new, distinct, and below an existing directory")
        parent_metadata = destination.parent.lstat()
        payload, raw, source_identity = _read_json(source, workspace, deadline)
        source_now = source.stat()
        if source_identity != (source_now.st_dev, source_now.st_ino):
            raise AuditError("input identity changed after reading")
        report = run_audit(payload, hashlib.sha256(raw).hexdigest(), deadline)
        _write(destination, report, deadline, (parent_metadata.st_dev, parent_metadata.st_ino))
        return 0
    except (AuditError, OSError) as error:
        print(f"PCI evidence audit error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
