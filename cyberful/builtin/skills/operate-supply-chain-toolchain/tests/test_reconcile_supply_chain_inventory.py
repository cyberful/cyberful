# ── Supply-Chain Reconciliation Tests ───────────────────────────
# Exercises Syft, Grype, and Trivy correlation, inventory disagreement,
# advisory separation, malformed-source rejection, and deterministic CLI output.
# → cyberful/builtin/skills/operate-supply-chain-toolchain/scripts/reconcile_supply_chain_inventory.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "reconcile_supply_chain_inventory.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("reconcile_supply_chain_inventory", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load supply-chain reconciler")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class SupplyChainReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def test_separates_inventory_disagreement_from_advisory_matches(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            syft = {"artifacts": [
                {"name": "alpha", "version": "1.0", "purl": "pkg:npm/alpha@1.0", "locations": [{"path": "/app/a"}]},
                {"name": "beta", "version": "2.0", "purl": "pkg:npm/beta@2.0", "locations": [{"path": "/app/b"}]},
            ]}
            trivy = {"Results": [{"Target": "image", "Packages": [{"Name": "alpha", "Version": "1.0", "Identifier": {"PURL": "pkg:npm/alpha@1.0"}}], "Vulnerabilities": [{"VulnerabilityID": "CVE-TEST-1", "PkgName": "alpha", "InstalledVersion": "1.0", "FixedVersion": "1.1", "Severity": "HIGH", "PkgIdentifier": {"PURL": "pkg:npm/alpha@1.0"}}]}]}
            grype = {"matches": [{"artifact": {"name": "alpha", "version": "1.0", "purl": "pkg:npm/alpha@1.0", "locations": [{"path": "/app/a"}]}, "vulnerability": {"id": "CVE-TEST-1", "severity": "High", "fix": {"versions": ["1.1"]}}}]}
            for name, payload in (("syft.json", syft), ("trivy.json", trivy), ("grype.json", grype)):
                (workspace / name).write_text(json.dumps(payload), encoding="utf-8")
            manifest = {"sources": [
                {"id": "syft", "kind": "syft-json", "path": "syft.json", "artifact": "image"},
                {"id": "trivy", "kind": "trivy-json", "path": "trivy.json", "artifact": "image"},
                {"id": "grype", "kind": "grype-json", "path": "grype.json", "artifact": "image"},
            ]}

            report = self.module.reconcile_manifest(manifest, workspace, "a" * 64)

            self.assertEqual(report["summary"]["package_count"], 2)
            self.assertEqual(report["summary"]["inventory_disagreement_count"], 1)
            self.assertEqual(report["inventory_disagreements"][0]["package_identity"], "pkg:npm/beta@2.0")
            self.assertEqual(report["summary"]["vulnerability_count"], 1)
            self.assertEqual(report["vulnerabilities"][0]["sources"], ["grype", "trivy"])

    def test_rejects_duplicate_sources_and_malformed_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "bad.json").write_text("{}", encoding="utf-8")
            source = {"id": "same", "kind": "syft-json", "path": "bad.json", "artifact": "image"}
            with self.assertRaisesRegex(self.module.SupplyChainError, "source ids must be unique"):
                self.module.reconcile_manifest({"sources": [source, source]}, workspace, "b" * 64)
            with self.assertRaisesRegex(self.module.SupplyChainError, "artifacts array"):
                self.module.reconcile_manifest({"sources": [source]}, workspace, "c" * 64)

    def test_cli_is_deterministic_and_rejects_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "syft.json").write_text(json.dumps({"artifacts": []}), encoding="utf-8")
            manifest = {"sources": [{"id": "syft", "kind": "syft-json", "path": "syft.json", "artifact": "image"}]}
            (workspace / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            command = [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "manifest.json", "--output", "report.json"]
            first = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            rendered = (workspace / "report.json").read_text(encoding="utf-8")
            second = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual((workspace / "report.json").read_text(encoding="utf-8"), rendered)

            overwrite = subprocess.run([*command[:-1], "syft.json"], check=False, capture_output=True, text=True)
            self.assertEqual(overwrite.returncode, 2)
            self.assertIn("must not replace", overwrite.stderr)

            traversal = subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "../manifest.json"], check=False, capture_output=True, text=True)
            self.assertEqual(traversal.returncode, 2)
            self.assertIn("non-traversing", traversal.stderr)


if __name__ == "__main__":
    unittest.main()
