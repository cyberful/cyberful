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

    def test_zap_session_generation_is_strict_and_positive(self) -> None:
        with patch.dict(os.environ, {"CYBER_ZAP_SESSION_GENERATION": "3"}, clear=False):
            self.assertEqual(runtime_supervisor.zap_session_generation(), 3)
        with patch.dict(os.environ, {"CYBER_ZAP_SESSION_GENERATION": "0"}, clear=False):
            with self.assertRaises(ValueError):
                runtime_supervisor.zap_session_generation()

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

    def test_unhealthy_service_marks_runtime_degraded_without_restarting_it(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cyberful-supervisor-health-") as temporary:
            directory = Path(temporary)
            with patch.object(runtime_supervisor, "RUN_DIRECTORY", directory):
                runtime_supervisor.write_runtime_status(
                    {"zap": {"status": "unhealthy", "pid": 11, "health_failures": 3}}
                )
            status = json.loads((directory / "status.json").read_text(encoding="utf-8"))
        self.assertEqual(status["status"], "degraded")
        self.assertEqual(status["services"]["zap"]["pid"], 11)

    def test_memory_event_delta_is_bounded_and_ignores_unknown_counters(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cyberful-supervisor-memory-") as temporary:
            source = Path(temporary) / "memory.events"
            source.write_text("low 8\nhigh 4\noom 3\noom_kill 2\nmalformed\n", encoding="utf-8")
            current = runtime_supervisor.memory_events(source)
        self.assertEqual(current, {"high": 4, "oom": 3, "oom_kill": 2})
        self.assertEqual(
            runtime_supervisor.memory_event_delta({"high": 5, "oom": 1}, current),
            {"high": 0, "oom": 2, "oom_kill": 2},
        )

    def test_negative_exit_code_records_terminating_signal(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cyberful-supervisor-state-") as temporary:
            directory = Path(temporary)
            with patch.object(runtime_supervisor, "RUN_DIRECTORY", directory):
                state = runtime_supervisor.write_state(
                    "zap",
                    "exited",
                    pid=42,
                    exit_code=-9,
                    metadata={"restart_count": 0, "session_generation": 1},
                )
        self.assertEqual(state["signal"], 9)
        self.assertEqual(state["session_generation"], 1)


if __name__ == "__main__":
    unittest.main()
