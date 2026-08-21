# ── Scan Finding Evidence Tests ─────────────────────────────────
# Covers deterministic cross-format correlation, fingerprint and structural
#   keys, malformed inputs, symlinks, collision, deadline, and output bounds.
# → cyberful/builtin/skills/analyze-scan-findings/scripts/analyze_scan_findings.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
from types import ModuleType
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "analyze_scan_findings.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("analyze_scan_findings", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load scan analyzer")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


class ScanFindingEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _fixture(self, workspace: Path) -> tuple[dict[str, object], bytes]:
        sarif = {"version": "2.1.0", "runs": [{"results": [{"ruleId": "RULE-1", "level": "warning", "message": {"text": "fixture message"}, "locations": [{"physicalLocation": {"artifactLocation": {"uri": "src/app.py"}, "region": {"startLine": 7}}}], "fingerprints": {"stable": "shared-7"}}]}]}
        normalized = {"findings": [{"rule_id": "RULE-1", "level": "error", "message": "different scanner wording", "locations": [{"uri": "src/app.py", "line": 7}], "fingerprint": "stable:shared-7", "suppressed": False, "evidence_ref": "normalized#finding-1"}]}
        (workspace / "one.sarif").write_text(json.dumps(sarif), encoding="utf-8")
        (workspace / "two.json").write_text(json.dumps(normalized), encoding="utf-8")
        config: dict[str, object] = {"$schema": "./scan-finding-analysis.schema.json", "analysis_id": "fixture-scan", "scope_reference": "scope:scan", "scan_files": [{"path": "one.sarif", "format": "sarif-2.1"}, {"path": "two.json", "format": "normalized-json"}], "max_findings": 8, "max_total_bytes": 65536, "timeout_seconds": 5, "output_limit_bytes": 65536}
        raw = f"{json.dumps(config, sort_keys=True)}\n".encode()
        return config, raw

    def test_cli_is_deterministic_and_correlates_supplied_fingerprints(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            _, raw = self._fixture(workspace)
            (workspace / "input.json").write_bytes(raw)
            self.assertEqual(self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "one.json"]), 0)
            self.assertEqual(self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "two-out.json"]), 0)
            first = json.loads((workspace / "one.json").read_text())
            second = json.loads((workspace / "two-out.json").read_text())
            self.assertEqual(first, second)
            self.assertEqual(first["summary"]["occurrences"], 2)
            self.assertEqual(first["summary"]["groups"], 1)
            self.assertEqual(first["summary"]["cross_source_groups"], 1)
            self.assertNotIn("fixture message", json.dumps(first))

    def test_malformed_normalized_input_and_symlink_refuse(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            config, _ = self._fixture(workspace)
            (workspace / "two.json").write_text(json.dumps({"findings": [{"unknown": True}]}), encoding="utf-8")
            with self.assertRaisesRegex(self.module.AnalysisError, "missing or unknown"):
                self.module._analyze(config, "0" * 64, workspace, time.monotonic() + 5)
            target = workspace / "target.json"
            target.write_text('{"findings": []}', encoding="utf-8")
            (workspace / "link.json").symlink_to(target)
            config["scan_files"] = [{"path": "link.json", "format": "normalized-json"}]
            with self.assertRaisesRegex(self.module.AnalysisError, "symbolic"):
                self.module._analyze(config, "0" * 64, workspace, time.monotonic() + 5)

    def test_collision_preserves_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            _, raw = self._fixture(workspace)
            path = workspace / "input.json"
            path.write_bytes(raw)
            self.assertEqual(self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "input.json"]), 2)
            self.assertEqual(path.read_bytes(), raw)

    def test_deadline_finding_and_output_limits_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            config, _ = self._fixture(workspace)
            with self.assertRaisesRegex(self.module.AnalysisError, "deadline"):
                self.module._analyze(config, "0" * 64, workspace, time.monotonic() - 1)
            config["max_findings"] = 1
            with self.assertRaisesRegex(self.module.AnalysisError, "max_findings"):
                self.module._analyze(config, "0" * 64, workspace, time.monotonic() + 5)
            config["max_findings"] = 8
            config["output_limit_bytes"] = 1024
            report, limit = self.module._analyze(config, "0" * 64, workspace, time.monotonic() + 5)
            with self.assertRaisesRegex(self.module.AnalysisError, "output_limit"):
                self.module._write(workspace / "small.json", report, limit, time.monotonic() + 5)
            self.assertFalse((workspace / "small.json").exists())

    def test_pathological_sarif_collections_and_outer_deadline_are_bounded(self) -> None:
        with self.assertRaisesRegex(self.module.AnalysisError, "runs"):
            self.module._sarif({"version": "2.1.0", "runs": [{}] * 257}, "many.sarif", 1000, time.monotonic() + 5)
        base = {"ruleId": "R", "message": {"text": "m"}, "locations": []}
        fingerprint_heavy = dict(base, fingerprints={str(index): "v" for index in range(65)})
        with self.assertRaisesRegex(self.module.AnalysisError, "fingerprints"):
            self.module._sarif({"version": "2.1.0", "runs": [{"results": [fingerprint_heavy]}]}, "fingerprints.sarif", 1, time.monotonic() + 5)
        suppression_heavy = dict(base, suppressions=[{}] * 65)
        with self.assertRaisesRegex(self.module.AnalysisError, "suppressions"):
            self.module._sarif({"version": "2.1.0", "runs": [{"results": [suppression_heavy]}]}, "suppressions.sarif", 1, time.monotonic() + 5)
        with patch.object(self.module.time, "monotonic", side_effect=[0.0, 2.0]):
            with self.assertRaisesRegex(self.module.AnalysisError, "deadline"):
                self.module._sarif({"version": "2.1.0", "runs": [{}, {}]}, "deadline.sarif", 1, 1.0)

    def test_atomic_publish_never_replaces_a_racing_destination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            config, _ = self._fixture(workspace)
            report, _ = self.module._analyze(config, "0" * 64, workspace, time.monotonic() + 5)
            destination = workspace / "raced.json"
            original_link = self.module.os.link

            def race(source: str, target: Path) -> None:
                Path(target).write_bytes(b"racer")
                original_link(source, target)

            with patch.object(self.module.os, "link", side_effect=race):
                with self.assertRaises(FileExistsError):
                    self.module._write(destination, report, 65536, time.monotonic() + 5)
            self.assertEqual(destination.read_bytes(), b"racer")


if __name__ == "__main__":
    unittest.main()
