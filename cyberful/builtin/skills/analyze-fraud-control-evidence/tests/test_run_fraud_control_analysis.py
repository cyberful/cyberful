# ── Fraud Control Evidence Analyzer Tests ───────────────────────
# Protects deterministic comparison, bounded local I/O, strict validation,
#   collision refusal, and global deadline behavior without network access.
# → cyberful/builtin/skills/analyze-fraud-control-evidence/scripts/run_fraud_control_analysis.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import json
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
SCRIPT = SKILL_ROOT / "scripts" / "run_fraud_control_analysis.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("run_fraud_control_analysis", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load fraud control analyzer")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


def observation(identifier: str, observed: str, *, control: str = "risk-policy", sequence: int = 1) -> dict[str, Any]:
    return {
        "observation_id": identifier,
        "scenario_id": "controlled-transfer",
        "control_id": control,
        "sequence": sequence,
        "stage": "authorization",
        "channel": "sandbox-api",
        "actor": "controlled-customer",
        "expected_decision": "deny",
        "observed_decision": observed,
        "reason_codes": [f"reason-{identifier}"],
        "signal_refs": [f"signals/{identifier}.json"],
        "durable_effect": "synthetic decision only",
        "evidence_ref": f"evidence/{identifier}.json",
    }


def ledger() -> dict[str, Any]:
    return {
        "$schema": "./fraud-control-observations.schema.json",
        "engagement_id": "synthetic-analysis",
        "authorization_reference": "scope-fraud-evidence",
        "expected_controls": ["risk-policy", "velocity-policy"],
        "observations": [observation("allow-observation", "allow", sequence=2), observation("deny-observation", "deny", sequence=1)],
    }


class FraudControlAnalysisTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _run(self, workspace: Path, output: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "observations.json", "--output", output],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )

    def test_analysis_is_deterministic_and_preserves_conflict_and_coverage_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "observations.json").write_text(json.dumps(ledger()), encoding="utf-8")
            first = self._run(workspace, "first.json")
            second = self._run(workspace, "second.json")
            first_bytes = (workspace / "first.json").read_bytes()
            second_bytes = (workspace / "second.json").read_bytes()
            report = json.loads(first_bytes)

        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(first_bytes, second_bytes)
        self.assertEqual(report["summary"]["matches"], 1)
        self.assertEqual(report["summary"]["mismatches"], 1)
        self.assertEqual(report["coverage"]["missing_controls"], ["velocity-policy"])
        self.assertEqual(report["conflicts"][0]["observed_decisions"], ["allow", "deny"])
        self.assertNotIn("vulnerability", json.dumps(report["observations"]).lower())

    def test_invalid_input_refuses_without_output(self) -> None:
        payload = ledger()
        payload["unexpected"] = True
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "observations.json").write_text(json.dumps(payload), encoding="utf-8")
            process = self._run(workspace, "analysis.json")
            output_exists = (workspace / "analysis.json").exists()
        self.assertEqual(process.returncode, 2)
        self.assertIn("unknown fields", process.stderr)
        self.assertFalse(output_exists)

    def test_schema_identity_refuses_before_output(self) -> None:
        payload = ledger()
        payload["$schema"] = "https://example.invalid/model-selected-schema.json"
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "observations.json").write_text(json.dumps(payload), encoding="utf-8")
            process = self._run(workspace, "analysis.json")
            output_exists = (workspace / "analysis.json").exists()
        self.assertEqual(process.returncode, 2)
        self.assertIn("$schema must reference", process.stderr)
        self.assertFalse(output_exists)

    def test_input_output_collision_preserves_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source = workspace / "observations.json"
            source.write_text(json.dumps(ledger()), encoding="utf-8")
            before = source.read_bytes()
            process = self._run(workspace, "observations.json")
            after = source.read_bytes()
        self.assertEqual(process.returncode, 2)
        self.assertIn("must not replace", process.stderr)
        self.assertEqual(before, after)

    def test_deadline_and_output_limit_fail_closed(self) -> None:
        with self.assertRaisesRegex(self.module.AnalysisError, "deadline"):
            self.module.run_analysis(ledger(), "0" * 64, time.monotonic() - 1)
        with tempfile.TemporaryDirectory() as directory, patch.object(self.module, "MAX_OUTPUT_BYTES", 32):
            destination = Path(directory) / "analysis.json"
            with self.assertRaisesRegex(self.module.AnalysisError, "byte limit"):
                self.module._write_report(destination, {"evidence": "x" * 128}, time.monotonic() + 10)
            self.assertFalse(destination.exists())

    def test_deadline_expiring_after_fsync_does_not_publish_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "analysis.json"
            with patch.object(self.module.time, "monotonic", side_effect=[0.0, 0.0, 2.0]):
                with self.assertRaisesRegex(self.module.AnalysisError, "deadline"):
                    self.module._write_report(destination, {"evidence": "bounded"}, 1.0)
            self.assertFalse(destination.exists())

    def test_output_schema_covers_more_than_256_observed_channels(self) -> None:
        payload = ledger()
        payload["expected_controls"] = ["risk-policy"]
        payload["observations"] = []
        for index in range(257):
            item = observation(f"observation-{index}", "deny", sequence=index)
            item["channel"] = f"channel-{index}"
            payload["observations"].append(item)
        report = self.module.run_analysis(payload, "0" * 64, time.monotonic() + 10)
        channels = report["coverage"]["controls"][0]["channels"]
        output_schema = json.loads((SKILL_ROOT / "assets" / "fraud-control-analysis.schema.json").read_text(encoding="utf-8"))
        declared_maximum = output_schema["$defs"]["dimension_list"]["maxItems"]
        self.assertEqual(len(channels), 257)
        self.assertLessEqual(len(channels), declared_maximum)


if __name__ == "__main__":
    unittest.main()
