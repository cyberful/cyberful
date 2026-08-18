# ── Concurrency Trial Analysis Tests ────────────────────────────
# Verifies durable invariant classification, response/state separation,
# matched controls, malformed-ledger rejection, and deterministic CLI output.
# → cyberful/builtin/skills/test-concurrency-resource-abuse/scripts/analyze_concurrency_trials.py — implementation.
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
SCRIPT = SKILL_ROOT / "scripts" / "analyze_concurrency_trials.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("analyze_concurrency_trials", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load concurrency analyzer")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def trial(case_id: str, mode: str, successes: int, effects: int, *, settled: bool = True) -> dict[str, object]:
    return {
        "case_id": case_id,
        "control_group": "redemption",
        "invariant": "at most one durable effect",
        "mode": mode,
        "attempts": 2,
        "successful_responses": successes,
        "durable_effects": effects,
        "expected_max_durable_effects": 1,
        "settled": settled,
        "final_state": "observed state",
        "evidence_refs": [f"raw/{case_id}.json"],
    }


class ConcurrencyTrialTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def test_classifies_durable_violations_and_response_mismatches(self) -> None:
        payload = {"cases": [
            trial("sequential", "sequential", 1, 1),
            trial("concurrent-violation", "concurrent", 2, 2),
            trial("concurrent-response", "concurrent", 2, 1),
            trial("unsettled", "concurrent", 2, 2, settled=False),
        ]}

        report = self.module.analyze_trials(payload, "a" * 64)

        self.assertEqual(report["summary"]["invariant_violation_candidates"], 1)
        self.assertEqual(report["summary"]["response_state_mismatches"], 1)
        self.assertEqual(report["summary"]["inconclusive"], 1)
        self.assertTrue(report["control_group_comparisons"][0]["comparison_available"])

    def test_rejects_duplicate_ids_and_impossible_success_counts(self) -> None:
        duplicate = trial("same", "sequential", 1, 1)
        with self.assertRaisesRegex(self.module.TrialError, "case_id values must be unique"):
            self.module.analyze_trials({"cases": [duplicate, duplicate]}, "b" * 64)
        malformed = trial("bad", "concurrent", 3, 1)
        with self.assertRaisesRegex(self.module.TrialError, "cannot exceed attempts"):
            self.module.analyze_trials({"cases": [malformed]}, "c" * 64)

    def test_cli_is_deterministic_and_rejects_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "trials.json").write_text(json.dumps({"cases": [trial("one", "sequential", 1, 1)]}), encoding="utf-8")
            command = [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "trials.json", "--output", "report.json"]
            first = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            rendered = (workspace / "report.json").read_text(encoding="utf-8")
            second = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual((workspace / "report.json").read_text(encoding="utf-8"), rendered)

            overwrite = subprocess.run([*command[:-1], "trials.json"], check=False, capture_output=True, text=True)
            self.assertEqual(overwrite.returncode, 2)
            self.assertIn("must not replace", overwrite.stderr)

            traversal = subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "../trials.json"], check=False, capture_output=True, text=True)
            self.assertEqual(traversal.returncode, 2)
            self.assertIn("non-traversing", traversal.stderr)


if __name__ == "__main__":
    unittest.main()
