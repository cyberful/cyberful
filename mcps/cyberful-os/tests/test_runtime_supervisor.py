# ── Unified Runtime Supervisor Tests ─────────────────────────────
# Exercises strict configuration and the durable degraded-state contract
#   without starting the heavyweight ZAP or Ghidra processes.
# → mcps/cyberful-os/runtime_supervisor.py — implements the tested owner loop.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import runtime_supervisor


class RuntimeSupervisorTests(unittest.TestCase):
    def test_boolean_configuration_is_strict(self) -> None:
        with patch.dict(os.environ, {"CYBERFUL_ZAP_ENABLED": "yes"}, clear=False):
            self.assertTrue(runtime_supervisor.environment_boolean("CYBERFUL_ZAP_ENABLED"))
        with patch.dict(os.environ, {"CYBERFUL_ZAP_ENABLED": "sometimes"}, clear=False):
            with self.assertRaisesRegex(ValueError, "must be one of"):
                runtime_supervisor.environment_boolean("CYBERFUL_ZAP_ENABLED")

    def test_runtime_identity_rejects_root_and_malformed_values(self) -> None:
        for values in (
            {"CYBERFUL_RUNTIME_UID": "0", "CYBERFUL_RUNTIME_GID": "1000"},
            {"CYBERFUL_RUNTIME_UID": "user", "CYBERFUL_RUNTIME_GID": "1000"},
        ):
            with self.subTest(values=values), patch.dict(os.environ, values, clear=False):
                with self.assertRaises(ValueError):
                    runtime_supervisor.runtime_identity()

    def test_exited_optional_service_marks_runtime_degraded(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cyberful-supervisor-test-") as temporary:
            directory = Path(temporary)
            with patch.object(runtime_supervisor, "RUN_DIRECTORY", directory):
                runtime_supervisor.write_runtime_status(
                    {
                        "zap": {"status": "ready", "pid": 11},
                        "ghidra": {"status": "exited", "pid": 12, "exit_code": 1},
                    }
                )
            status = json.loads((directory / "status.json").read_text(encoding="utf-8"))
            self.assertEqual(status["status"], "degraded")
            self.assertEqual(status["services"]["ghidra"]["exit_code"], 1)


if __name__ == "__main__":
    unittest.main()
