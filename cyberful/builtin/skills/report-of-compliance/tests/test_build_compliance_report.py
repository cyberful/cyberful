# ── Compliance Report Draft Compiler Tests ──────────────────────
# Protects profile routing, deterministic draft rendering, confined reads,
#   strict evidence states, deadlines, output bounds, and no-replace publish.
# → cyberful/builtin/skills/report-of-compliance/scripts/build_compliance_report.py — implementation.
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
SCRIPT = SKILL_ROOT / "scripts" / "build_compliance_report.py"
TEMPLATE = SKILL_ROOT / "assets" / "templates" / "compliance-report.md"
PCI_PROFILE = SKILL_ROOT / "assets" / "profiles" / "pci-dss-4.0.1.json"
GDPR_PROFILE = SKILL_ROOT / "assets" / "profiles" / "gdpr-eu-2016-679.json"
EXAMPLE = SKILL_ROOT / "assets" / "compliance-report-input.example.json"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("build_compliance_report", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load compliance report compiler")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


def example() -> dict[str, Any]:
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


def gdpr_input() -> dict[str, Any]:
    payload = example()
    payload["report_id"] = "gdpr-accountability-draft-2026"
    payload["profile_id"] = "gdpr-eu-2016-679-accountability"
    payload["report_title"] = "Example GDPR Accountability Evidence Draft"
    payload["entity"] = {"legal_name": "Example Controller", "roles": ["controller"], "jurisdiction": "European Union example context"}
    payload["records"] = [
        {
            "need_id": "gdpr.accountability-governance",
            "status": "supported",
            "summary": "A synthetic accountability-policy reference is present.",
            "evidence_refs": ["raw/example/accountability.json"],
            "finding_refs": [],
            "rationale": "The synthetic record exists only to exercise the GDPR profile.",
            "owner": "Example privacy owner",
            "target_date": None,
        }
    ]
    return payload


class ComplianceReportCompilerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _prepare(self, root: Path, payload: dict[str, Any], profile: Path) -> None:
        (root / "input.json").write_text(json.dumps(payload), encoding="utf-8")
        (root / "profile.json").write_bytes(profile.read_bytes())
        (root / "template.md").write_bytes(TEMPLATE.read_bytes())

    def _run(self, root: Path, output: str = "report.json", *, input_name: str = "input.json") -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--workspace", str(root), "--input", input_name, "--profile", "profile.json", "--template", "template.md", "--output", output],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )

    def test_pci_profile_compiles_deterministically_and_exposes_every_need(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._prepare(root, example(), PCI_PROFILE)
            first = self._run(root, "first.json")
            second = self._run(root, "second.json")
            first_bytes = (root / "first.json").read_bytes()
            second_bytes = (root / "second.json").read_bytes()
            report = json.loads(first_bytes)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(first_bytes, second_bytes)
        self.assertEqual(report["document_status"], "draft")
        self.assertEqual(report["profile"]["id"], "pci-dss-4.0.1-roc-evidence")
        self.assertTrue(report["profile"]["official_template_required"])
        self.assertEqual(report["summary"]["need_count"], len(report["requirements"]))
        self.assertGreater(report["summary"]["status_counts"]["not-tested"], 0)
        self.assertIn("NOT AN OFFICIAL ROC", report["draft_markdown"])
        self.assertIn("pci.requirement-11", report["draft_markdown"])

    def test_gdpr_profile_produces_an_accountability_draft_not_a_universal_roc(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._prepare(root, gdpr_input(), GDPR_PROFILE)
            process = self._run(root)
            report = json.loads((root / "report.json").read_text(encoding="utf-8"))
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(report["profile"]["framework"], "GDPR")
        self.assertFalse(report["profile"]["official_template_required"])
        self.assertIn("NOT LEGAL ADVICE", report["draft_markdown"])
        self.assertIn("gdpr.processing-records", report["summary"]["unresolved_need_ids"])
        self.assertEqual(report["profile"]["source_sha256"], "bd84e63f5b622b739a83389afc3b30d240f792bb88d8eb03a816c9a82b0c2499")

    def test_profile_mismatch_unknown_need_and_unsupported_evidence_claim_refuse(self) -> None:
        mutations = (
            lambda payload: payload.__setitem__("profile_id", "gdpr-eu-2016-679-accountability"),
            lambda payload: payload["records"][0].__setitem__("need_id", "pci.unknown-need"),
            lambda payload: payload["records"][0].__setitem__("evidence_refs", []),
        )
        for mutation in mutations:
            payload = example()
            mutation(payload)
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self._prepare(root, payload, PCI_PROFILE)
                process = self._run(root)
                self.assertEqual(process.returncode, 2)
                self.assertFalse((root / "report.json").exists())

    def test_template_contract_and_input_aliases_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._prepare(root, example(), PCI_PROFILE)
            (root / "template.md").write_text("# {{REPORT_TITLE}}\n", encoding="utf-8")
            malformed = self._run(root)
            self.assertEqual(malformed.returncode, 2)
            self.assertFalse((root / "report.json").exists())
        if os.name != "nt":
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self._prepare(root, example(), PCI_PROFILE)
                (root / "alias.json").hardlink_to(root / "input.json")
                (root / "profile.json").unlink()
                (root / "profile.json").hardlink_to(root / "input.json")
                aliased = self._run(root)
                self.assertEqual(aliased.returncode, 2)
                self.assertFalse((root / "report.json").exists())

    def test_collision_symlink_deadline_and_output_limit_preserve_sources(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._prepare(root, example(), PCI_PROFILE)
            before = (root / "input.json").read_bytes()
            collision = self._run(root, "input.json")
            self.assertEqual(collision.returncode, 2)
            self.assertEqual((root / "input.json").read_bytes(), before)
            if os.name != "nt":
                (root / "linked.json").symlink_to(root / "input.json")
                linked = self._run(root, input_name="linked.json")
                self.assertEqual(linked.returncode, 2)
        with self.assertRaisesRegex(self.module.ReportError, "deadline"):
            self.module.build_report(example(), json.loads(PCI_PROFILE.read_text(encoding="utf-8")), TEMPLATE.read_text(encoding="utf-8"), {"input_sha256": "0" * 64, "profile_sha256": "1" * 64, "template_sha256": "2" * 64}, time.monotonic() - 1)
        with tempfile.TemporaryDirectory() as directory, patch.object(self.module, "MAX_OUTPUT_BYTES", 32):
            destination = Path(directory) / "report.json"
            metadata = destination.parent.stat()
            with self.assertRaisesRegex(self.module.ReportError, "output boundary"):
                self.module._write(destination, {"draft": "x" * 128}, time.monotonic() + 10, (metadata.st_dev, metadata.st_ino))
            self.assertFalse(destination.exists())

    def test_publication_race_preserves_the_existing_destination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "report.json"
            metadata = root.stat()
            real_link = os.link

            def race_link(source: str, target: str, *args: Any, **kwargs: Any) -> None:
                destination.write_bytes(b"racer")
                real_link(source, target, *args, **kwargs)

            with patch.object(self.module.os, "link", side_effect=race_link):
                with self.assertRaisesRegex(self.module.ReportError, "appeared before publication"):
                    self.module._write(destination, {"draft": "bounded"}, time.monotonic() + 10, (metadata.st_dev, metadata.st_ino))
            self.assertEqual(destination.read_bytes(), b"racer")


if __name__ == "__main__":
    unittest.main()
