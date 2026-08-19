#!/usr/bin/env python3
# ── Compliance Report Draft Compiler ─────────────────────────────
# Combines one bounded evidence ledger, one pinned reporting profile, and one
#   inert Markdown template into a deterministic draft without a verdict.
# → cyberful/builtin/skills/report-of-compliance/assets/compliance-report-input.schema.json — input contract.
# → cyberful/builtin/skills/report-of-compliance/tests/test_build_compliance_report.py — boundary and behavior tests.
# @docs/runtimes/skill-catalog.md
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
from typing import Any, Final


INPUT_SCHEMA: Final = "assets/compliance-report-input.schema.json"
PROFILE_SCHEMA: Final = "assets/compliance-profile.schema.json"
MAX_INPUT_BYTES: Final = 2_097_152
MAX_PROFILE_BYTES: Final = 524_288
MAX_TEMPLATE_BYTES: Final = 262_144
MAX_OUTPUT_BYTES: Final = 4_194_304
MAX_RECORDS: Final = 2_048
MAX_NEEDS: Final = 128
MAX_TEXT_BYTES: Final = 2_048
MAX_ID_BYTES: Final = 128
MAX_REFERENCES: Final = 64
MAX_LIST_ITEMS: Final = 32
TIMEOUT_SECONDS: Final = 15
STATUSES: Final = (
    "supported",
    "partially-supported",
    "unsupported",
    "not-applicable-with-rationale",
    "not-tested",
    "conflicting-evidence",
)
UNRESOLVED_STATUSES: Final = frozenset(("partially-supported", "unsupported", "not-tested", "conflicting-evidence"))
ROLES: Final = frozenset(("merchant", "service-provider", "controller", "joint-controller", "processor", "representative", "other"))
TEMPLATE_TOKENS: Final = (
    "REPORT_TITLE",
    "DRAFT_LABEL",
    "REPORT_CONTEXT",
    "SUMMARY",
    "REQUIREMENT_TABLE",
    "LIMITATIONS",
    "ATTESTATION_BOUNDARY",
)
INPUT_FIELDS: Final = frozenset(("$schema", "report_id", "profile_id", "report_title", "entity", "assessment", "records"))
PROFILE_FIELDS: Final = frozenset(("$schema", "profile_id", "framework", "version", "source", "deliverable", "needs"))
RECORD_FIELDS: Final = frozenset(("need_id", "status", "summary", "evidence_refs", "finding_refs", "rationale", "owner", "target_date"))


class ReportError(ValueError):
    """Raised when the draft compiler cannot preserve its reporting contract."""


@dataclass(frozen=True)
class ProfileNeed:
    need_id: str
    title: str
    source_refs: tuple[str, ...]
    evidence_expectations: tuple[str, ...]
    required: bool


@dataclass(frozen=True)
class ReportingProfile:
    profile_id: str
    framework: str
    version: str
    source_url: str
    source_sha256: str
    deliverable_title: str
    draft_label: str
    official_template_required: bool
    attestation_authority: str
    needs: tuple[ProfileNeed, ...]


@dataclass(frozen=True)
class EvidenceRecord:
    need_id: str
    status: str
    summary: str
    evidence_refs: tuple[str, ...]
    finding_refs: tuple[str, ...]
    rationale: str
    owner: str
    target_date: str | None


# ── Draft Compilation Never Creates Compliance Authority ─────────
# Profile needs describe what a reviewer expects to see, while input records
#   describe only evidence states supplied by the engagement. The compiler joins
#   those two bounded sets and makes omissions visible; it never tests a control,
#   resolves legal applicability, verifies assessor qualifications, or signs.
# Every output remains a draft even when every need is marked supported, because
#   evidence coverage and formal attestation are separate authority boundaries.
# ─────────────────────────────────────────────────────────────────


def _deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise ReportError("compliance report compilation exceeded its global deadline")


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise ReportError("workspace must be an existing directory")
    return workspace


def _confined(workspace: Path, value: str, *, exists: bool) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise ReportError("paths must be relative and non-traversing")
    cursor = workspace
    for component in requested.parts:
        cursor /= component
        if cursor.is_symlink():
            raise ReportError("symbolic links are not allowed")
    resolved = (workspace / requested).resolve(strict=exists)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise ReportError("path escapes workspace") from error
    return resolved


def _read_regular(path: Path, workspace: Path, deadline: float, maximum: int) -> tuple[bytes, tuple[int, int]]:
    expected = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(expected.st_mode) or expected.st_size > maximum:
        raise ReportError("input resource must be a bounded regular file")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        canonical = path.resolve(strict=True)
        try:
            canonical.relative_to(workspace)
        except ValueError as error:
            raise ReportError("input resource resolved outside workspace") from error
        resolved = canonical.stat()
        identities = {(expected.st_dev, expected.st_ino), (opened.st_dev, opened.st_ino), (resolved.st_dev, resolved.st_ino)}
        if len(identities) != 1 or not stat.S_ISREG(opened.st_mode) or opened.st_size > maximum:
            raise ReportError("input resource identity changed while opening")
        chunks: list[bytes] = []
        observed = 0
        while True:
            _deadline(deadline)
            chunk = os.read(descriptor, min(65_536, maximum + 1 - observed))
            if not chunk:
                break
            chunks.append(chunk)
            observed += len(chunk)
            if observed > maximum:
                raise ReportError("input resource exceeds its byte boundary")
        final = os.fstat(descriptor)
        if (final.st_dev, final.st_ino, final.st_size) != (opened.st_dev, opened.st_ino, opened.st_size) or observed != opened.st_size:
            raise ReportError("input resource changed while reading")
        return b"".join(chunks), (opened.st_dev, opened.st_ino)
    finally:
        os.close(descriptor)


def _json(raw: bytes, label: str) -> Any:
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise ReportError(f"{label} must be UTF-8 JSON") from error


def _text(value: Any, label: str, maximum: int = MAX_TEXT_BYTES) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ReportError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized.encode("utf-8")) > maximum or any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise ReportError(f"{label} exceeds its text boundary or contains control characters")
    return normalized


def _identifier(value: Any, label: str) -> str:
    normalized = _text(value, label, MAX_ID_BYTES)
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]*", normalized):
        raise ReportError(f"{label} must be a lowercase reporting identifier")
    return normalized


def _iso_date(value: Any, label: str) -> str:
    normalized = _text(value, label, 10)
    try:
        parsed = date.fromisoformat(normalized)
    except ValueError as error:
        raise ReportError(f"{label} must be an ISO date") from error
    if parsed.isoformat() != normalized:
        raise ReportError(f"{label} must be a canonical ISO date")
    return normalized


def _text_list(value: Any, label: str, *, minimum: int, maximum: int) -> tuple[str, ...]:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ReportError(f"{label} must contain between {minimum} and {maximum} entries")
    normalized = tuple(_text(item, f"{label}[]") for item in value)
    if len(set(normalized)) != len(normalized):
        raise ReportError(f"{label} must not contain duplicates")
    return normalized


def _profile(value: Any, deadline: float) -> ReportingProfile:
    if not isinstance(value, dict) or set(value) != PROFILE_FIELDS or value["$schema"] != PROFILE_SCHEMA:
        raise ReportError("profile contains missing or unknown fields or an unsupported $schema")
    source = value["source"]
    deliverable = value["deliverable"]
    if not isinstance(source, dict) or set(source) != {"url", "sha256"}:
        raise ReportError("profile source is invalid")
    if not isinstance(deliverable, dict) or set(deliverable) != {"title", "output_name", "draft_label", "official_template_required", "attestation_authority"}:
        raise ReportError("profile deliverable is invalid")
    source_url = _text(source["url"], "profile.source.url")
    source_sha256 = _text(source["sha256"], "profile.source.sha256", 64)
    if not source_url.startswith("https://") or not re.fullmatch(r"[0-9a-f]{64}", source_sha256):
        raise ReportError("profile source URL or digest is invalid")
    if not isinstance(deliverable["official_template_required"], bool):
        raise ReportError("profile official_template_required must be boolean")
    raw_needs = value["needs"]
    if not isinstance(raw_needs, list) or not 1 <= len(raw_needs) <= MAX_NEEDS:
        raise ReportError("profile needs are outside the supported boundary")
    needs: list[ProfileNeed] = []
    for index, raw_need in enumerate(raw_needs):
        _deadline(deadline)
        label = f"profile.needs[{index}]"
        if not isinstance(raw_need, dict) or set(raw_need) != {"id", "title", "source_refs", "evidence_expectations", "required"}:
            raise ReportError(f"{label} contains missing or unknown fields")
        if not isinstance(raw_need["required"], bool):
            raise ReportError(f"{label}.required must be boolean")
        needs.append(
            ProfileNeed(
                need_id=_identifier(raw_need["id"], f"{label}.id"),
                title=_text(raw_need["title"], f"{label}.title"),
                source_refs=_text_list(raw_need["source_refs"], f"{label}.source_refs", minimum=1, maximum=MAX_LIST_ITEMS),
                evidence_expectations=_text_list(raw_need["evidence_expectations"], f"{label}.evidence_expectations", minimum=1, maximum=MAX_LIST_ITEMS),
                required=raw_need["required"],
            )
        )
    if len({need.need_id for need in needs}) != len(needs):
        raise ReportError("profile need identifiers must be unique")
    return ReportingProfile(
        profile_id=_identifier(value["profile_id"], "profile.profile_id"),
        framework=_text(value["framework"], "profile.framework"),
        version=_text(value["version"], "profile.version"),
        source_url=source_url,
        source_sha256=source_sha256,
        deliverable_title=_text(deliverable["title"], "profile.deliverable.title"),
        draft_label=_text(deliverable["draft_label"], "profile.deliverable.draft_label"),
        official_template_required=deliverable["official_template_required"],
        attestation_authority=_text(deliverable["attestation_authority"], "profile.deliverable.attestation_authority"),
        needs=tuple(needs),
    )


def _record(value: Any, index: int) -> EvidenceRecord:
    label = f"records[{index}]"
    if not isinstance(value, dict) or set(value) != RECORD_FIELDS:
        raise ReportError(f"{label} contains missing or unknown fields")
    status_value = _text(value["status"], f"{label}.status", 64)
    if status_value not in STATUSES:
        raise ReportError(f"{label}.status is unsupported")
    evidence_refs = _text_list(value["evidence_refs"], f"{label}.evidence_refs", minimum=0, maximum=MAX_REFERENCES)
    finding_refs = _text_list(value["finding_refs"], f"{label}.finding_refs", minimum=0, maximum=MAX_REFERENCES)
    if status_value in {"supported", "partially-supported", "conflicting-evidence"} and not evidence_refs:
        raise ReportError(f"{label} status requires at least one evidence reference")
    target_date = value["target_date"]
    if target_date is not None:
        target_date = _iso_date(target_date, f"{label}.target_date")
    return EvidenceRecord(
        need_id=_identifier(value["need_id"], f"{label}.need_id"),
        status=status_value,
        summary=_text(value["summary"], f"{label}.summary"),
        evidence_refs=tuple(sorted(evidence_refs)),
        finding_refs=tuple(sorted(finding_refs)),
        rationale=_text(value["rationale"], f"{label}.rationale"),
        owner=_text(value["owner"], f"{label}.owner"),
        target_date=target_date,
    )


def _payload(value: Any, profile: ReportingProfile, deadline: float) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != INPUT_FIELDS or value["$schema"] != INPUT_SCHEMA:
        raise ReportError("input contains missing or unknown fields or an unsupported $schema")
    if _identifier(value["profile_id"], "profile_id") != profile.profile_id:
        raise ReportError("input profile_id does not match the selected profile")
    entity = value["entity"]
    assessment = value["assessment"]
    if not isinstance(entity, dict) or set(entity) != {"legal_name", "roles", "jurisdiction"}:
        raise ReportError("entity contains missing or unknown fields")
    roles = _text_list(entity["roles"], "entity.roles", minimum=1, maximum=8)
    if any(role not in ROLES for role in roles):
        raise ReportError("entity.roles contains an unsupported role")
    if not isinstance(assessment, dict) or set(assessment) != {"scope", "period", "evidence_cutoff", "assessor_name", "assessor_organization", "declared_qualification", "review_authority"}:
        raise ReportError("assessment contains missing or unknown fields")
    period = assessment["period"]
    if not isinstance(period, dict) or set(period) != {"start", "end"}:
        raise ReportError("assessment.period must contain exactly start and end")
    period_start = _iso_date(period["start"], "assessment.period.start")
    period_end = _iso_date(period["end"], "assessment.period.end")
    evidence_cutoff = _iso_date(assessment["evidence_cutoff"], "assessment.evidence_cutoff")
    if period_start > period_end or evidence_cutoff < period_start:
        raise ReportError("assessment dates are inconsistent")
    raw_records = value["records"]
    if not isinstance(raw_records, list) or len(raw_records) > MAX_RECORDS:
        raise ReportError("records exceed the supported boundary")
    records = tuple(_record(item, index) for index, item in enumerate(raw_records))
    identifiers = [record.need_id for record in records]
    if len(set(identifiers)) != len(identifiers):
        raise ReportError("records must contain at most one entry per profile need")
    known_needs = {need.need_id for need in profile.needs}
    unknown = sorted(set(identifiers) - known_needs)
    if unknown:
        raise ReportError(f"records contain unknown profile needs: {', '.join(unknown)}")
    _deadline(deadline)
    return {
        "report_id": _identifier(value["report_id"], "report_id"),
        "report_title": _text(value["report_title"], "report_title"),
        "entity": {"legal_name": _text(entity["legal_name"], "entity.legal_name"), "roles": sorted(roles), "jurisdiction": _text(entity["jurisdiction"], "entity.jurisdiction")},
        "assessment": {
            "scope": _text(assessment["scope"], "assessment.scope"),
            "period": {"start": period_start, "end": period_end},
            "evidence_cutoff": evidence_cutoff,
            "assessor_name": _text(assessment["assessor_name"], "assessment.assessor_name"),
            "assessor_organization": _text(assessment["assessor_organization"], "assessment.assessor_organization"),
            "declared_qualification": _text(assessment["declared_qualification"], "assessment.declared_qualification"),
            "review_authority": _text(assessment["review_authority"], "assessment.review_authority"),
        },
        "records": records,
    }


def _template(raw: bytes) -> str:
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ReportError("template must be UTF-8 text") from error
    observed = set(re.findall(r"\{\{([A-Z_]+)\}\}", source))
    if observed != set(TEMPLATE_TOKENS) or any(source.count(f"{{{{{token}}}}}") != 1 for token in TEMPLATE_TOKENS):
        raise ReportError("template must contain each supported token exactly once and no unknown token")
    return source


def _markdown(value: str) -> str:
    return value.replace("\\", "\\\\").replace("|", "\\|").replace("`", "'").replace("<", "&lt;").replace(">", "&gt;")


def _markdown_report(template: str, report: dict[str, Any], deadline: float) -> str:
    profile = report["profile"]
    entity = report["entity"]
    assessment = report["assessment"]
    summary = report["summary"]
    context = "\n".join(
        (
            f"- **Document status:** draft",
            f"- **Framework/profile:** {_markdown(profile['framework'])} {_markdown(profile['version'])} (`{_markdown(profile['id'])}`)",
            f"- **Entity:** {_markdown(entity['legal_name'])} — {_markdown(', '.join(entity['roles']))}",
            f"- **Jurisdiction:** {_markdown(entity['jurisdiction'])}",
            f"- **Assessment period:** {assessment['period']['start']} through {assessment['period']['end']}",
            f"- **Evidence cutoff:** {assessment['evidence_cutoff']}",
            f"- **Scope:** {_markdown(assessment['scope'])}",
            f"- **Assessor:** {_markdown(assessment['assessor_name'])}, {_markdown(assessment['assessor_organization'])}",
            f"- **Declared qualification:** {_markdown(assessment['declared_qualification'])}",
            f"- **Review authority:** {_markdown(assessment['review_authority'])}",
        )
    )
    status_lines = [f"- **{status_value}:** {summary['status_counts'][status_value]}" for status_value in STATUSES]
    status_lines.insert(0, f"- **Profile needs:** {summary['need_count']} ({summary['observed_count']} supplied; {summary['need_count'] - summary['observed_count']} unobserved)")
    table = ["| Need | Sources | Required | Status | Evidence | Findings | Summary | Rationale | Owner | Target |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for requirement in report["requirements"]:
        _deadline(deadline)
        table.append(
            "| "
            + " | ".join(
                (
                    f"`{_markdown(requirement['need_id'])}` — {_markdown(requirement['title'])}",
                    _markdown("; ".join(requirement["source_refs"])),
                    "yes" if requirement["required"] else "conditional",
                    _markdown(requirement["status"]),
                    _markdown("; ".join(requirement["evidence_refs"]) or "—"),
                    _markdown("; ".join(requirement["finding_refs"]) or "—"),
                    _markdown(requirement["summary"]),
                    _markdown(requirement["rationale"]),
                    _markdown(requirement["owner"]),
                    requirement["target_date"] or "—",
                )
            )
            + " |"
        )
    unresolved = summary["unresolved_need_ids"]
    not_applicable = summary["not_applicable_need_ids"]
    limitation_lines = [f"- {_markdown(item)}" for item in report["limitations"]]
    limitation_lines.append(f"- Unresolved need identifiers: {_markdown(', '.join(unresolved) or 'none recorded')}")
    limitation_lines.append(f"- Not-applicable rationales requiring reviewer acceptance: {_markdown(', '.join(not_applicable) or 'none recorded')}")
    substitutions = {
        "REPORT_TITLE": _markdown(report["report_title"]),
        "DRAFT_LABEL": _markdown(profile["draft_label"]),
        "REPORT_CONTEXT": context,
        "SUMMARY": "\n".join(status_lines),
        "REQUIREMENT_TABLE": "\n".join(table),
        "LIMITATIONS": "\n".join(limitation_lines),
        "ATTESTATION_BOUNDARY": _markdown(profile["attestation_authority"]),
    }
    rendered = template
    for token in TEMPLATE_TOKENS:
        _deadline(deadline)
        rendered = rendered.replace(f"{{{{{token}}}}}", substitutions[token])
    return rendered.rstrip() + "\n"


def build_report(value: Any, profile_value: Any, template: str, digests: dict[str, str], deadline: float) -> dict[str, Any]:
    profile = _profile(profile_value, deadline)
    parsed = _payload(value, profile, deadline)
    by_need = {record.need_id: record for record in parsed["records"]}
    requirements: list[dict[str, Any]] = []
    for need in profile.needs:
        _deadline(deadline)
        record = by_need.get(need.need_id)
        if record is None:
            record = EvidenceRecord(
                need_id=need.need_id,
                status="not-tested",
                summary="No evidence record was supplied for this profile need.",
                evidence_refs=(),
                finding_refs=(),
                rationale="Unobserved in compiler input; reviewer disposition and supporting evidence remain required.",
                owner="Unassigned",
                target_date=None,
            )
        requirements.append(
            {
                "need_id": need.need_id,
                "title": need.title,
                "source_refs": list(need.source_refs),
                "evidence_expectations": list(need.evidence_expectations),
                "required": need.required,
                "observed": need.need_id in by_need,
                **asdict(record),
                "evidence_refs": list(record.evidence_refs),
                "finding_refs": list(record.finding_refs),
            }
        )
    counts = Counter(requirement["status"] for requirement in requirements)
    unresolved = [requirement["need_id"] for requirement in requirements if requirement["status"] in UNRESOLVED_STATUSES]
    not_applicable = [requirement["need_id"] for requirement in requirements if requirement["status"] == "not-applicable-with-rationale"]
    report: dict[str, Any] = {
        "format": "cyberful.compliance-report-draft.raw.v1",
        "document_status": "draft",
        "report_id": parsed["report_id"],
        "report_title": parsed["report_title"],
        "profile": {
            "id": profile.profile_id,
            "framework": profile.framework,
            "version": profile.version,
            "source_url": profile.source_url,
            "source_sha256": profile.source_sha256,
            "deliverable_title": profile.deliverable_title,
            "draft_label": profile.draft_label,
            "official_template_required": profile.official_template_required,
            "attestation_authority": profile.attestation_authority,
        },
        "entity": parsed["entity"],
        "assessment": parsed["assessment"],
        "digests": digests,
        "limits": {"records": MAX_RECORDS, "needs": MAX_NEEDS, "input_bytes": MAX_INPUT_BYTES, "profile_bytes": MAX_PROFILE_BYTES, "template_bytes": MAX_TEMPLATE_BYTES, "output_bytes": MAX_OUTPUT_BYTES, "timeout_seconds": TIMEOUT_SECONDS},
        "summary": {
            "need_count": len(requirements),
            "observed_count": len(by_need),
            "status_counts": {status_value: counts[status_value] for status_value in STATUSES},
            "unresolved_need_ids": unresolved,
            "not_applicable_need_ids": not_applicable,
        },
        "requirements": requirements,
        "draft_markdown": "pending",
        "limitations": [
            "The compiler organizes supplied references and does not inspect or validate the referenced evidence bodies.",
            "Supported is an evidence-coverage status, not a compliance, legal, certification, or attestation conclusion.",
            "Assessor identity, qualification, applicability decisions, jurisdictional interpretation, approvals, and signatures require independent review.",
        ],
    }
    report["draft_markdown"] = _markdown_report(template, report, deadline)
    return report


def _write(path: Path, value: dict[str, Any], deadline: float, parent_identity: tuple[int, int]) -> None:
    if path.exists():
        raise ReportError("output path already exists")
    _deadline(deadline)
    rendered = (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")
    if len(rendered) > MAX_OUTPUT_BYTES:
        raise ReportError("compliance report draft exceeds the output boundary")
    parent_descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    temporary_name = f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp"
    temporary_descriptor: int | None = None
    try:
        parent_opened = os.fstat(parent_descriptor)
        if not stat.S_ISDIR(parent_opened.st_mode) or (parent_opened.st_dev, parent_opened.st_ino) != parent_identity:
            raise ReportError("output parent identity changed")
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
            raise ReportError("output path appeared before publication") from error
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
    parser = argparse.ArgumentParser(description="Compile a bounded compliance evidence report draft offline.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--template", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(argv)
    deadline = time.monotonic() + TIMEOUT_SECONDS
    try:
        workspace = _workspace(arguments.workspace)
        source = _confined(workspace, arguments.input, exists=True)
        profile_path = _confined(workspace, arguments.profile, exists=True)
        template_path = _confined(workspace, arguments.template, exists=True)
        destination = _confined(workspace, arguments.output, exists=False)
        if destination.exists() or not destination.parent.is_dir() or destination in {source, profile_path, template_path}:
            raise ReportError("output must be new, distinct, and below an existing directory")
        parent_metadata = destination.parent.lstat()
        input_raw, input_identity = _read_regular(source, workspace, deadline, MAX_INPUT_BYTES)
        profile_raw, profile_identity = _read_regular(profile_path, workspace, deadline, MAX_PROFILE_BYTES)
        template_raw, template_identity = _read_regular(template_path, workspace, deadline, MAX_TEMPLATE_BYTES)
        if len({input_identity, profile_identity, template_identity}) != 3:
            raise ReportError("input, profile, and template must be distinct regular files")
        report = build_report(
            _json(input_raw, "input"),
            _json(profile_raw, "profile"),
            _template(template_raw),
            {
                "input_sha256": hashlib.sha256(input_raw).hexdigest(),
                "profile_sha256": hashlib.sha256(profile_raw).hexdigest(),
                "template_sha256": hashlib.sha256(template_raw).hexdigest(),
            },
            deadline,
        )
        _write(destination, report, deadline, (parent_metadata.st_dev, parent_metadata.st_ino))
        return 0
    except (ReportError, OSError) as error:
        print(f"compliance report compiler error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
