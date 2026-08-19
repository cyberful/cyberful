# ── Transaction State Trace Tests ───────────────────────────────
# Protects deterministic causal tracing, bounded local I/O, strict validation,
#   collision refusal, and global deadline behavior without network access.
# → cyberful/builtin/skills/trace-transaction-state/scripts/run_transaction_trace.py — implementation.
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
SCRIPT = SKILL_ROOT / "scripts" / "run_transaction_trace.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("run_transaction_trace", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load transaction trace analyzer")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


def event(identifier: str, sequence: int, before: str, after: str, amount: int, idempotency: str | None) -> dict[str, Any]:
    return {
        "event_id": identifier,
        "sequence": sequence,
        "component": "synthetic-ledger",
        "kind": "post",
        "state_before": before,
        "state_after": after,
        "amount_delta_minor": amount,
        "idempotency_key": idempotency,
        "correlation_ids": ["controlled-correlation"],
        "durable_effect": f"synthetic effect {sequence}",
        "evidence_ref": f"evidence/event-{sequence}.json",
    }


def ledger() -> dict[str, Any]:
    return {
        "$schema": "./transaction-events.schema.json",
        "engagement_id": "synthetic-trace",
        "authorization_reference": "scope-transaction-evidence",
        "transactions": [{
            "transaction_id": "controlled-transaction",
            "currency": "USD",
            "expected_terminal_state": "settled",
            "expected_net_delta_minor": 100,
            "events": [
                event("event-a", 1, "created", "authorized", 100, "reused-key"),
                event("event-b", 2, "pending", "settled", 100, "reused-key"),
                event("event-b", 3, "settled", "settled", 0, None),
            ],
        }],
    }


class TransactionTraceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _run(self, workspace: Path, output: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "events.json", "--output", output],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )

    def test_trace_is_deterministic_and_preserves_causal_indicators(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "events.json").write_text(json.dumps(ledger()), encoding="utf-8")
            first = self._run(workspace, "first.json")
            second = self._run(workspace, "second.json")
            first_bytes = (workspace / "first.json").read_bytes()
            second_bytes = (workspace / "second.json").read_bytes()
            report = json.loads(first_bytes)

        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(first_bytes, second_bytes)
        transaction = report["transactions"][0]
        self.assertEqual(len(transaction["continuity_gaps"]), 1)
        self.assertEqual(transaction["duplicate_event_ids"][0]["event_id"], "event-b")
        self.assertEqual(transaction["idempotency_reuse"][0]["idempotency_key"], "reused-key")
        self.assertFalse(transaction["computed"]["net_delta_matches"])
        self.assertTrue(transaction["computed"]["terminal_state_matches"])
        self.assertNotIn("vulnerability", json.dumps(transaction).lower())

    def test_invalid_input_refuses_without_output(self) -> None:
        payload = ledger()
        payload["transactions"][0]["events"][0]["unexpected"] = True
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "events.json").write_text(json.dumps(payload), encoding="utf-8")
            process = self._run(workspace, "trace.json")
            output_exists = (workspace / "trace.json").exists()
        self.assertEqual(process.returncode, 2)
        self.assertIn("unknown fields", process.stderr)
        self.assertFalse(output_exists)

    def test_schema_identity_refuses_before_output(self) -> None:
        payload = ledger()
        payload["$schema"] = "https://example.invalid/model-selected-schema.json"
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "events.json").write_text(json.dumps(payload), encoding="utf-8")
            process = self._run(workspace, "trace.json")
            output_exists = (workspace / "trace.json").exists()
        self.assertEqual(process.returncode, 2)
        self.assertIn("$schema must reference", process.stderr)
        self.assertFalse(output_exists)

    def test_input_output_collision_preserves_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source = workspace / "events.json"
            source.write_text(json.dumps(ledger()), encoding="utf-8")
            before = source.read_bytes()
            process = self._run(workspace, "events.json")
            after = source.read_bytes()
        self.assertEqual(process.returncode, 2)
        self.assertIn("must not replace", process.stderr)
        self.assertEqual(before, after)

    def test_deadline_and_output_limit_fail_closed(self) -> None:
        with self.assertRaisesRegex(self.module.TraceError, "deadline"):
            self.module.run_trace(ledger(), "0" * 64, time.monotonic() - 1)
        with tempfile.TemporaryDirectory() as directory, patch.object(self.module, "MAX_OUTPUT_BYTES", 32):
            destination = Path(directory) / "trace.json"
            with self.assertRaisesRegex(self.module.TraceError, "byte limit"):
                self.module._write_report(destination, {"evidence": "x" * 128}, time.monotonic() + 10)
            self.assertFalse(destination.exists())

    def test_deadline_expiring_after_fsync_does_not_publish_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "trace.json"
            with patch.object(self.module.time, "monotonic", side_effect=[0.0, 0.0, 2.0]):
                with self.assertRaisesRegex(self.module.TraceError, "deadline"):
                    self.module._write_report(destination, {"evidence": "bounded"}, 1.0)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
