# ── Tenant Context Trace Tests ───────────────────────────────────
# Exercises the real offline CLI, bounded divergence evidence, and preflight
#   refusal without contacting a loopback or external service.
# → cyberful/builtin/skills/trace-tenant-context-propagation/scripts/trace_tenant_context.py — implementation.
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
import unittest
from unittest.mock import patch


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "trace_tenant_context.py"
EXAMPLE = SKILL_ROOT / "assets" / "tenant-context.example.json"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("trace_tenant_context", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load tenant context tracer")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


class TenantContextTraceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.module = load_script()

    def _run(self, payload: dict[str, object]) -> tuple[subprocess.CompletedProcess[str], dict[str, object] | None]:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "input.json").write_text(json.dumps(payload), encoding="utf-8")
            process = subprocess.run(
                [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "input.json", "--output", "evidence.json"],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
            output = workspace / "evidence.json"
            return process, json.loads(output.read_text(encoding="utf-8")) if output.exists() else None

    def test_real_cli_emits_ordered_context_changes_without_verdict(self) -> None:
        payload = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        process, evidence = self._run(payload)
        self.assertEqual(process.returncode, 0, process.stderr)
        assert evidence is not None
        self.assertEqual([event["event_id"] for event in evidence["events"]], ["gateway-route", "repository-query"])
        self.assertEqual(evidence["events"][1]["changes"], ["asserted_tenant", "resource_tenant", "data_partition"])
        self.assertEqual(evidence["events"][1]["divergences"], [])
        self.assertNotIn("vulnerability", json.dumps(evidence).lower())

    def test_non_null_tenant_divergence_is_preserved_for_review(self) -> None:
        payload = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        payload["events"][1]["context"]["data_partition"] = "tenant-b"
        process, evidence = self._run(payload)
        self.assertEqual(process.returncode, 0, process.stderr)
        assert evidence is not None
        self.assertIn("data_partition", evidence["events"][1]["divergences"])
        self.assertIn("authenticated_tenant", evidence["events"][1]["divergences"])

    def test_unknown_context_and_duplicate_order_refuse_without_output(self) -> None:
        payload = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        payload["events"][0]["context"]["workspace"] = "untrusted"
        process, evidence = self._run(payload)
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        payload = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        payload["events"][1]["order"] = payload["events"][0]["order"]
        process, evidence = self._run(payload)
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)

    def test_traversal_refuses_before_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            process = subprocess.run(
                [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "../input.json", "--output", "evidence.json"],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertEqual(process.returncode, 2)
            self.assertFalse((workspace / "evidence.json").exists())

    def test_output_cannot_replace_the_canonical_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source = workspace / "trace.json"
            original = EXAMPLE.read_bytes()
            source.write_bytes(original)
            process = subprocess.run(
                [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "trace.json", "--output", "trace.json"],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertEqual(process.returncode, 2)
            self.assertEqual(source.read_bytes(), original)

    def test_global_deadline_and_output_limit_refuse_without_partial_output(self) -> None:
        raw = EXAMPLE.read_bytes()
        payload = json.loads(raw)
        with self.assertRaisesRegex(self.module.TraceError, "global analysis deadline"):
            self.module._analyze(payload, raw, time.monotonic() - 1)
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            source = workspace / "input.json"
            source.write_bytes(raw)
            output = workspace / "evidence.json"
            evidence = self.module._analyze(payload, raw, time.monotonic() + 2)
            with patch.object(self.module, "MAX_OUTPUT_BYTES", 64), self.assertRaisesRegex(self.module.TraceError, "output exceeds"):
                self.module._write_bounded(workspace, "evidence.json", evidence, time.monotonic() + 2, source)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
