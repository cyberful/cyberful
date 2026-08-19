# ── Offline API Contract Coverage Tests ─────────────────────────
# Protects deterministic reconciliation, confined contract reads, operation
#   collision handling, deadlines, output bounds, and output ownership.
# → cyberful/builtin/skills/analyze-api-contract-coverage/scripts/analyze_api_contract_coverage.py — implementation under test.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

from contextlib import redirect_stderr
import io
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from types import ModuleType


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "analyze_api_contract_coverage.py"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("api_contract_coverage", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load API contract analyzer")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def contract(*, security: list[object] | None = None) -> dict[str, object]:
    document: dict[str, object] = {
        "openapi": "3.1.0",
        "paths": {
            "/accounts/{account_id}": {"get": {"responses": {"200": {"description": "ok"}}}},
            "/accounts/{account_id}/transfer": {"post": {"security": [], "responses": {"202": {"description": "accepted"}}}},
        },
    }
    if security is not None:
        document["security"] = security
    return document


class ContractCoverageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _workspace(self, directory: str) -> tuple[Path, dict[str, object]]:
        workspace = Path(directory)
        contracts = workspace / "contracts"
        contracts.mkdir()
        (contracts / "api.json").write_text(json.dumps(contract(security=[{"bearer": []}])), encoding="utf-8")
        payload = {
            "contract_files": ["contracts/api.json"],
            "implementation_operations": ["GET /accounts/{account_id}", "DELETE /legacy"],
            "observed_operations": ["GET /accounts/{account_id}"],
        }
        return workspace, payload

    def test_reconciles_contract_implementation_observation_and_security(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, payload = self._workspace(directory)
            report = self.module.run_analysis(payload, "a" * 64, workspace)
            self.assertEqual([row["key"] for row in report["operations"]], ["GET /accounts/{account_id}", "POST /accounts/{account_id}/transfer"])
            self.assertEqual(report["gaps"]["undocumented_implementation"], ["DELETE /legacy"])
            self.assertEqual(report["gaps"]["unimplemented_contract"], ["POST /accounts/{account_id}/transfer"])
            self.assertEqual(report["gaps"]["explicitly_anonymous"], ["POST /accounts/{account_id}/transfer"])

    def test_empty_security_requirement_is_anonymous_and_malformed_entries_fail(self) -> None:
        self.assertEqual(self.module._security({"security": [{}]}, {}), "explicitly-anonymous")
        self.assertEqual(self.module._security({"security": [{"oauth": []}, {}]}, {}), "explicitly-anonymous")
        with self.assertRaisesRegex(self.module.AnalysisError, "requirement objects"):
            self.module._security({"security": ["oauth"]}, {})

    def test_rejects_symlinked_contract_before_read(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, payload = self._workspace(directory)
            (workspace / "alias.json").symlink_to(workspace / "contracts" / "api.json")
            payload["contract_files"] = ["alias.json"]
            with self.assertRaisesRegex(self.module.AnalysisError, "symbolic links"):
                self.module.run_analysis(payload, "b" * 64, workspace)

    def test_duplicate_operation_across_contracts_is_a_collision(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, payload = self._workspace(directory)
            (workspace / "contracts" / "duplicate.json").write_text(json.dumps(contract()), encoding="utf-8")
            payload["contract_files"] = ["contracts/api.json", "contracts/duplicate.json"]
            with self.assertRaisesRegex(self.module.AnalysisError, "operation collision"):
                self.module.run_analysis(payload, "c" * 64, workspace)

    def test_deadline_and_output_budget_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, payload = self._workspace(directory)
            with self.assertRaisesRegex(self.module.AnalysisError, "global deadline"):
                self.module.run_analysis(payload, "d" * 64, workspace, deadline_seconds=0)
            with self.assertRaisesRegex(self.module.AnalysisError, "output boundary"):
                self.module.run_analysis(payload, "d" * 64, workspace, output_limit_bytes=64)
            destination = workspace / "late.json"
            with self.assertRaisesRegex(self.module.AnalysisError, "global deadline"):
                self.module._write(destination, {"value": True}, time.monotonic() - 1)
            self.assertFalse(destination.exists())

    def test_cli_refuses_output_collision(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, payload = self._workspace(directory)
            (workspace / "request.json").write_text(json.dumps(payload), encoding="utf-8")
            (workspace / "evidence.json").write_text("preserve", encoding="utf-8")
            with redirect_stderr(io.StringIO()):
                result = self.module.main(["--workspace", directory, "--input", "request.json", "--output", "evidence.json"])
            self.assertEqual(result, 2)
            self.assertEqual((workspace / "evidence.json").read_text(encoding="utf-8"), "preserve")


if __name__ == "__main__":
    unittest.main()
