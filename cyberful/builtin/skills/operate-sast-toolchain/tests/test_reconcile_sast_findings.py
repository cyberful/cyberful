# ── SAST Reconciliation Tests ───────────────────────────────────
# Covers Semgrep and SARIF normalization, stable cross-format deduplication,
# scanner-error preservation, host-path redaction, and CLI confinement.
# → cyberful/builtin/skills/operate-sast-toolchain/scripts/reconcile_sast_findings.py — implementation.
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
SCRIPT = SKILL_ROOT / "scripts" / "reconcile_sast_findings.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("reconcile_sast_findings", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load SAST reconciler")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class SastReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def test_deduplicates_equivalent_semgrep_and_sarif_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            semgrep = {"results": [{"check_id": "rule.one", "path": "/workspace/source/app.ts", "start": {"line": 7}, "end": {"line": 7}, "extra": {"message": "Unsafe call", "severity": "ERROR"}}], "errors": [{"message": "one parse error"}]}
            sarif = {"runs": [{"results": [{"ruleId": "rule.one", "level": "error", "message": {"text": "Unsafe call"}, "locations": [{"physicalLocation": {"artifactLocation": {"uri": "file:///workspace/source/app.ts"}, "region": {"startLine": 7, "endLine": 7}}}]}], "invocations": [{"executionSuccessful": True}]}]}
            (workspace / "semgrep.json").write_text(json.dumps(semgrep), encoding="utf-8")
            (workspace / "results.sarif").write_text(json.dumps(sarif), encoding="utf-8")
            payload = {"sources": [
                {"id": "semgrep", "kind": "semgrep-json", "path": "semgrep.json", "scanner": "semgrep", "source_root": "/workspace/source"},
                {"id": "sarif", "kind": "sarif", "path": "results.sarif", "scanner": "semgrep-sarif", "source_root": "/workspace/source"},
            ]}

            report = self.module.reconcile_manifest(payload, workspace, "a" * 64)

            self.assertEqual(report["summary"]["observation_count"], 2)
            self.assertEqual(report["summary"]["unique_finding_count"], 1)
            self.assertEqual(report["findings"][0]["sources"], ["sarif", "semgrep"])
            self.assertEqual(report["findings"][0]["path"], "app.ts")
            self.assertEqual(report["summary"]["error_count"], 1)

    def test_redacts_an_unmapped_absolute_host_path(self) -> None:
        source = {"id": "one", "scanner": "scanner", "source_root": "/workspace/source"}
        finding = self.module._finding(source, "r", "/Users/person/private/repo/app.py", 1, 1, "message", "warning")
        self.assertEqual(finding["path"], "app.py")
        self.assertTrue(finding["path_redacted"])

        with self.assertRaisesRegex(self.module.SastError, "source_root must be a string"):
            self.module._source({"id": "one", "kind": "sarif", "path": "scan.sarif", "scanner": "scanner", "source_root": None}, 0)

    def test_cli_is_deterministic_and_rejects_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "semgrep.json").write_text(json.dumps({"results": [], "errors": []}), encoding="utf-8")
            manifest = {"sources": [{"id": "semgrep", "kind": "semgrep-json", "path": "semgrep.json", "scanner": "semgrep", "source_root": ""}]}
            (workspace / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            command = [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "manifest.json", "--output", "report.json"]
            first = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            rendered = (workspace / "report.json").read_text(encoding="utf-8")
            second = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual((workspace / "report.json").read_text(encoding="utf-8"), rendered)

            overwrite = subprocess.run([*command[:-1], "semgrep.json"], check=False, capture_output=True, text=True)
            self.assertEqual(overwrite.returncode, 2)
            self.assertIn("must not replace", overwrite.stderr)

            traversal = subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "../manifest.json"], check=False, capture_output=True, text=True)
            self.assertEqual(traversal.returncode, 2)
            self.assertIn("non-traversing", traversal.stderr)


if __name__ == "__main__":
    unittest.main()
