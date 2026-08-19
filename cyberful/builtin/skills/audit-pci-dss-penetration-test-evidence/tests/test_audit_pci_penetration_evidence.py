# ── PCI DSS Penetration Evidence Audit Tests ────────────────────
# Protects deterministic applicability, strict metadata validation, confined
#   reads, collision refusal, bounded output, deadline, and no-replace publish.
# → cyberful/builtin/skills/audit-pci-dss-penetration-test-evidence/scripts/audit_pci_penetration_evidence.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import ModuleType
from typing import Any
import unittest
from unittest.mock import patch


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "audit_pci_penetration_evidence.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("audit_pci_penetration_evidence", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load PCI evidence analyzer")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


def record(identifier: str, requirement: str, status: str, *, topic: str | None = None) -> dict[str, Any]:
    return {
        "record_id": identifier,
        "requirement": requirement,
        "topic": topic or f"evidence topic {requirement}",
        "status": status,
        "source_type": "methodology" if requirement == "11.4.1" else "segmentation-report",
        "evidence_date": "2026-08-01",
        "evidence_refs": [f"raw/pci/{identifier}.json"] if status == "supported" else [],
        "rationale": f"Synthetic {status} metadata for {requirement}.",
    }


def ledger() -> dict[str, Any]:
    return {
        "$schema": "assets/pci-penetration-evidence.schema.json",
        "assessment_id": "pci-evidence-synthetic",
        "standard_version": "PCI DSS 4.0.1",
        "entity_type": "merchant",
        "segmentation_used": True,
        "assessment_period": {"start": "2026-01-01", "end": "2026-12-31"},
        "records": [record("methodology", "11.4.1", "supported"), record("segmentation-gap", "11.4.5", "gap")],
    }


class PciPenetrationEvidenceAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _run(self, workspace: Path, output: str = "audit.json", input_name: str = "evidence.json") -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", input_name, "--output", output],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )

    def test_audit_is_deterministic_and_exposes_unobserved_requirements_without_a_verdict(self) -> None:
        payload = ledger()
        payload["records"].append(record("segmentation-supported", "11.4.5", "supported", topic="shared segmentation coverage"))
        payload["records"].append(record("segmentation-conflict", "11.4.5", "gap", topic="shared segmentation coverage"))
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "evidence.json").write_text(json.dumps(payload), encoding="utf-8")
            first = self._run(workspace, "first.json")
            second = self._run(workspace, "second.json")
            first_bytes = (workspace / "first.json").read_bytes()
            second_bytes = (workspace / "second.json").read_bytes()
            report = json.loads(first_bytes)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(first_bytes, second_bytes)
        self.assertEqual(report["coverage"]["applicable_requirements"], ["11.4.1", "11.4.2", "11.4.3", "11.4.4", "11.4.5"])
        self.assertEqual(report["coverage"]["unobserved_requirements"], ["11.4.2", "11.4.3", "11.4.4"])
        self.assertEqual(report["conflicts"][0]["statuses"], ["gap", "supported"])
        self.assertIn("without_supported_evidence", report["coverage"])
        self.assertNotIn("compliant", json.dumps(report).lower())

    def test_entity_type_and_segmentation_derive_service_provider_requirements(self) -> None:
        payload = ledger()
        payload["entity_type"] = "multi-tenant-service-provider"
        report = self.module.run_audit(payload, "0" * 64, time.monotonic() + 10)
        self.assertEqual(report["coverage"]["applicable_requirements"], list(self.module.REQUIREMENTS))
        payload["segmentation_used"] = False
        report = self.module.run_audit(payload, "0" * 64, time.monotonic() + 10)
        self.assertEqual(report["coverage"]["applicable_requirements"], ["11.4.1", "11.4.2", "11.4.3", "11.4.4", "11.4.7"])
        self.assertTrue(any("11.4.5" in warning for warning in report["applicability_warnings"]))

    def test_invalid_schema_and_supported_record_without_evidence_refuse_without_output(self) -> None:
        for mutate in (
            lambda value: value.__setitem__("$schema", "https://example.invalid/schema.json"),
            lambda value: value["records"][0].__setitem__("evidence_refs", []),
        ):
            payload = ledger()
            mutate(payload)
            with tempfile.TemporaryDirectory() as directory:
                workspace = Path(directory)
                (workspace / "evidence.json").write_text(json.dumps(payload), encoding="utf-8")
                process = self._run(workspace)
                self.assertEqual(process.returncode, 2)
                self.assertFalse((workspace / "audit.json").exists())

    def test_input_output_collision_and_symlink_input_preserve_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source = workspace / "evidence.json"
            source.write_text(json.dumps(ledger()), encoding="utf-8")
            before = source.read_bytes()
            collision = self._run(workspace, "evidence.json")
            self.assertEqual(collision.returncode, 2)
            self.assertEqual(source.read_bytes(), before)
            if os.name != "nt":
                (workspace / "linked.json").symlink_to(source)
                linked = self._run(workspace, "audit.json", "linked.json")
                self.assertEqual(linked.returncode, 2)
                self.assertFalse((workspace / "audit.json").exists())

    def test_deadline_and_output_limit_fail_closed(self) -> None:
        with self.assertRaisesRegex(self.module.AuditError, "deadline"):
            self.module.run_audit(ledger(), "0" * 64, time.monotonic() - 1)
        with tempfile.TemporaryDirectory() as directory, patch.object(self.module, "MAX_OUTPUT_BYTES", 32):
            destination = Path(directory) / "audit.json"
            metadata = destination.parent.stat()
            with self.assertRaisesRegex(self.module.AuditError, "output boundary"):
                self.module._write(destination, {"evidence": "x" * 128}, time.monotonic() + 10, (metadata.st_dev, metadata.st_ino))
            self.assertFalse(destination.exists())

    def test_publication_race_preserves_existing_destination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "audit.json"
            metadata = root.stat()
            real_link = os.link

            def race_link(source: str, target: str, *args: Any, **kwargs: Any) -> None:
                destination.write_bytes(b"racer")
                real_link(source, target, *args, **kwargs)

            with patch.object(self.module.os, "link", side_effect=race_link):
                with self.assertRaisesRegex(self.module.AuditError, "appeared before publication"):
                    self.module._write(destination, {"evidence": "bounded"}, time.monotonic() + 10, (metadata.st_dev, metadata.st_ino))
            self.assertEqual(destination.read_bytes(), b"racer")


if __name__ == "__main__":
    unittest.main()
