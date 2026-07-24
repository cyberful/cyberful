# ── Persistent Ghidra MCP Unit Tests ─────────────────────────────
# Verifies protocol inventory, bounded validation, idempotent job submission,
# cancellation, and recovery from the append-only journal without a JVM.
# → mcps/ghidra/ghidra_mcp.py — owns the tested protocol and job manager.
# @docs/runtimes/ghidra.md
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_ROOT))

from ghidra_mcp import GhidraApplication, JobManager, Protocol, TOOL_NAMES  # noqa: E402


class FakeEngine:
    def __init__(self) -> None:
        self.import_calls: list[tuple[str, str | None, bool]] = []
        self.analysis_calls: list[tuple[str, int]] = []
        self.cancelled = False

    def import_program(self, source_path: str, name: str | None, analyze: bool) -> dict[str, object]:
        self.import_calls.append((source_path, name, analyze))
        return {"program": "/fixture", "analyzed": analyze}

    def analyze_program(self, program: str, timeout_seconds: int) -> dict[str, object]:
        self.analysis_calls.append((program, timeout_seconds))
        return {"program": program, "analyzed": True}

    def cancel_active_operation(self) -> None:
        self.cancelled = True

    def project_status(self) -> dict[str, object]:
        return {"project": "Cyberful", "busy": False, "programs": []}

    def programs(self) -> list[dict[str, object]]:
        return []

    def checkpoint(self) -> dict[str, object]:
        return {"schema": 1}

    def resolve_source(self, source_path: str) -> Path:
        return Path("/workspace") / source_path

    def source_digest(self, _source: Path) -> str:
        return "a" * 64

    def imported_program(self, _digest: str) -> dict[str, object] | None:
        return None

    def search(self, *_args: object) -> dict[str, object]:
        return {"items": []}

    def listing(self, *_args: object) -> dict[str, object]:
        return {"items": []}

    def decompile(self, *_args: object) -> dict[str, object]:
        return {"decompiled": "int fixture(void) { return 7; }"}

    def xrefs(self, *_args: object) -> dict[str, object]:
        return {"items": []}

    def call_graph(self, *_args: object) -> dict[str, object]:
        return {"nodes": [], "edges": []}

    def annotate(self, *_args: object) -> dict[str, object]:
        return {"action": "comment"}

    def annotations(self, *_args: object) -> dict[str, object]:
        return {"items": []}


def wait_for_status(manager: JobManager, job_id: str, expected: str) -> dict[str, object]:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        record = manager.status(job_id)
        if record.get("status") == expected:
            return record
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} did not reach {expected}: {manager.status(job_id)}")


class JobManagerTests(unittest.TestCase):
    def test_runs_an_import_once_and_returns_the_existing_active_job(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            engine = FakeEngine()
            manager = JobManager(engine, Path(directory) / "jobs.jsonl")
            try:
                request = {"source_path": "fixture.bin", "analyze": True}
                first = manager.submit("import", request)
                second = manager.submit("import", request)
                self.assertEqual(second["id"], first["id"])
                completed = wait_for_status(manager, str(first["id"]), "succeeded")
                self.assertEqual(completed["result"], {"program": "/fixture", "analyzed": True})
                self.assertEqual(engine.import_calls, [("fixture.bin", None, True)])
            finally:
                manager.close()

    def test_recovers_an_interrupted_job_from_the_durable_journal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = Path(directory) / "jobs.jsonl"
            job_id = "7f6d1f53-b609-4e18-b945-343897f63c72"
            journal.write_text(
                json.dumps(
                    {
                        "id": job_id,
                        "kind": "analyze",
                        "status": "running",
                        "request": {"program": "/fixture", "timeout_seconds": 10},
                        "created_at": 1,
                        "updated_at": 2,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            engine = FakeEngine()
            manager = JobManager(engine, journal)
            try:
                recovered = wait_for_status(manager, job_id, "succeeded")
                self.assertTrue(recovered["recovered"])
                self.assertEqual(engine.analysis_calls, [("/fixture", 10)])
                self.assertGreater(len(journal.read_text(encoding="utf-8").splitlines()), 2)
            finally:
                manager.close()

    def test_cancels_a_queued_job_without_executing_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            engine = FakeEngine()
            manager = JobManager(engine, Path(directory) / "jobs.jsonl", start_worker=False)
            job = manager.submit("analyze", {"program": "/fixture", "timeout_seconds": 10})
            cancelled = manager.cancel(str(job["id"]))
            manager.close()
            self.assertEqual(cancelled["status"], "cancelled")
            self.assertEqual(engine.analysis_calls, [])


class ProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.engine = FakeEngine()
        self.jobs = JobManager(self.engine, Path(self.temporary.name) / "jobs.jsonl")
        self.protocol = Protocol(GhidraApplication(self.engine, self.jobs))

    def tearDown(self) -> None:
        self.jobs.close()
        self.temporary.cleanup()

    def test_lists_only_the_bounded_first_party_reverse_engineering_tools(self) -> None:
        response = self.protocol.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertIsInstance(response, dict)
        tools = response["result"]["tools"]  # type: ignore[index]
        self.assertEqual({tool["name"] for tool in tools}, TOOL_NAMES)
        self.assertFalse(any("script" in tool["name"] for tool in tools))

    def test_returns_validation_failures_as_mcp_tool_errors(self) -> None:
        response = self.protocol.handle(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "ghidra_decompile", "arguments": {"program": "/fixture"}},
            }
        )
        result = response["result"]  # type: ignore[index]
        self.assertTrue(result["isError"])
        self.assertIn("selector", result["content"][0]["text"])

    def test_queues_imports_instead_of_blocking_the_protocol_call(self) -> None:
        response = self.protocol.handle(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "ghidra_import",
                    "arguments": {"source_path": "fixture.bin", "analyze": True},
                },
            }
        )
        result = response["result"]  # type: ignore[index]
        payload = json.loads(result["content"][0]["text"])
        self.assertEqual(payload["sha256"], "a" * 64)
        self.assertEqual(payload["job"]["status"], "queued")


if __name__ == "__main__":
    unittest.main()
