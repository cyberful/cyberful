# ── Realtime Event Ledger Analysis Tests ───────────────────────
# Covers policy mismatch, duplicate, missing, replay, and ordering analysis,
# plus malformed-ledger rejection and deterministic CLI confinement.
# → cyberful/builtin/skills/test-realtime-integrations/scripts/analyze_event_ledger.py — implementation.
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
SCRIPT = SKILL_ROOT / "scripts" / "analyze_event_ledger.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("analyze_event_ledger", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load event-ledger analyzer")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def observation(identifier: str, event_id: str, sequence: int, order: int, expected: str, actual: str, *, replay: bool = False) -> dict[str, object]:
    return {"observation_id": identifier, "event_id": event_id, "sequence": sequence, "delivery_order": order, "expected": expected, "actual": actual, "replay": replay, "evidence_ref": f"raw/{identifier}.json"}


class EventLedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def test_keeps_policy_and_delivery_anomalies_separate(self) -> None:
        payload = {"streams": [{
            "stream_id": "stream",
            "principal": "tester",
            "tenant": "tenant-a",
            "channel": "orders",
            "expected_event_ids": ["one", "two", "missing"],
            "observations": [
                observation("first", "one", 2, 1, "deliver", "delivered"),
                observation("second", "two", 1, 2, "deliver", "delivered"),
                observation("duplicate", "one", 2, 3, "reject", "delivered", replay=True),
            ],
        }]}

        report = self.module.analyze_ledger(payload, "a" * 64)

        self.assertEqual(report["summary"]["unexpected_delivery_candidates"], 1)
        self.assertEqual(report["summary"]["duplicate_event_ids"], 1)
        self.assertEqual(report["summary"]["missing_event_ids"], 1)
        self.assertEqual(report["summary"]["replay_deliveries"], 1)
        self.assertEqual(report["summary"]["reordered_observations"], 1)

    def test_rejects_duplicate_observation_ids_and_bad_decisions(self) -> None:
        duplicated = observation("same", "one", 1, 1, "deliver", "delivered")
        stream = {"stream_id": "stream", "principal": "p", "tenant": "t", "channel": "c", "expected_event_ids": ["one"], "observations": [duplicated, duplicated]}
        with self.assertRaisesRegex(self.module.EventLedgerError, "observation_id values must be unique"):
            self.module.analyze_ledger({"streams": [stream]}, "b" * 64)

        malformed = {**duplicated, "actual": "maybe"}
        with self.assertRaisesRegex(self.module.EventLedgerError, "unsupported"):
            self.module.analyze_ledger({"streams": [{**stream, "observations": [malformed]}]}, "c" * 64)

        same_order = [duplicated, {**observation("other", "two", 2, 2, "deliver", "delivered"), "delivery_order": 1}]
        with self.assertRaisesRegex(self.module.EventLedgerError, "unique delivery_order"):
            self.module.analyze_ledger({"streams": [{**stream, "observations": same_order}]}, "d" * 64)

    def test_cli_is_deterministic_and_rejects_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            ledger = {"streams": [{"stream_id": "stream", "principal": "p", "tenant": "t", "channel": "c", "expected_event_ids": [], "observations": []}]}
            (workspace / "events.json").write_text(json.dumps(ledger), encoding="utf-8")
            command = [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "events.json", "--output", "report.json"]
            first = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            rendered = (workspace / "report.json").read_text(encoding="utf-8")
            second = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual((workspace / "report.json").read_text(encoding="utf-8"), rendered)

            overwrite = subprocess.run([*command[:-1], "events.json"], check=False, capture_output=True, text=True)
            self.assertEqual(overwrite.returncode, 2)
            self.assertIn("must not replace", overwrite.stderr)

            traversal = subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "../events.json"], check=False, capture_output=True, text=True)
            self.assertEqual(traversal.returncode, 2)
            self.assertIn("non-traversing", traversal.stderr)


if __name__ == "__main__":
    unittest.main()
