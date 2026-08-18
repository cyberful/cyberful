# ── Authorization Comparison Helper Tests ───────────────────────
# Covers observable classification, deterministic output, schema rejection,
# and workarea confinement for the packaged offline helper.
# → cyberful/builtin/skills/test-authorization-boundaries/scripts/compare_authorization_matrix.py — implementation.
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
from typing import Any


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "compare_authorization_matrix.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("compare_authorization_matrix", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load comparison helper")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def observation(case_id: str, expected: str, actual: str) -> dict[str, Any]:
    return {
        "case_id": case_id,
        "actor": "tester-a",
        "identity": "identity-a",
        "tenant": "tenant-b",
        "resource": "tenant-b/object-1",
        "relationship": "none",
        "action": "read",
        "properties": ["summary"],
        "workflow_state": "active",
        "assurance": "authenticated-session",
        "environment": "authorized-test",
        "expected": expected,
        "actual": actual,
        "evidence_ref": f"raw/http/{case_id}.json",
    }


class AuthorizationMatrixTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def test_groups_controls_violations_and_inconclusive_observations(self) -> None:
        payload = {
            "observations": [
                observation("control", "deny", "deny"),
                observation("bypass", "deny", "allow"),
                observation("regression", "allow", "deny"),
                observation("unknown", "deny", "indeterminate"),
            ]
        }

        report = self.module.compare_ledger(payload, "a" * 64)

        self.assertEqual(report["summary"], {"total": 4, "controls": 1, "violations": 2, "inconclusive": 1})
        self.assertEqual(
            [entry["classification"] for entry in report["violations"]],
            ["authorization-bypass-candidate", "authorization-regression"],
        )

    def test_rejects_duplicate_cases_and_unknown_fields(self) -> None:
        duplicate = observation("duplicate", "deny", "allow")
        with self.assertRaisesRegex(self.module.LedgerError, "case_id values must be unique"):
            self.module.compare_ledger({"observations": [duplicate, duplicate]}, "b" * 64)

        malformed = {**observation("malformed", "deny", "allow"), "unexpected": True}
        with self.assertRaisesRegex(self.module.LedgerError, "unknown fields"):
            self.module.compare_ledger({"observations": [malformed]}, "c" * 64)

    def test_cli_writes_deterministic_json_and_rejects_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source = workspace / "ledger.json"
            source.write_text(
                json.dumps({"observations": [observation("bypass", "deny", "allow")]}, sort_keys=True),
                encoding="utf-8",
            )

            command = [
                sys.executable,
                str(SCRIPT),
                "--workspace",
                str(workspace),
                "--input",
                "ledger.json",
                "--output",
                "report.json",
            ]
            first = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            first_report = (workspace / "report.json").read_text(encoding="utf-8")
            second = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual((workspace / "report.json").read_text(encoding="utf-8"), first_report)

            overwrite = subprocess.run(
                [*command[:-1], "ledger.json"],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(overwrite.returncode, 2)
            self.assertIn("must not replace", overwrite.stderr)

            traversal = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--workspace",
                    str(workspace),
                    "--input",
                    "../ledger.json",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(traversal.returncode, 2)
            self.assertIn("non-traversing", traversal.stderr)


if __name__ == "__main__":
    unittest.main()
