# ── HTTP Traffic Evidence Tests ─────────────────────────────────
# Covers deterministic HAR normalization, confinement, collision, deadline,
#   schema identity, cumulative transaction bounds, and output limits.
# → cyberful/builtin/skills/analyze-http-traffic-evidence/scripts/analyze_http_traffic_evidence.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
from types import ModuleType
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "analyze_http_traffic_evidence.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("analyze_http_traffic_evidence", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load HTTP analyzer")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


class HttpTrafficEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _fixture(self, workspace: Path) -> tuple[dict[str, object], bytes]:
        evidence = workspace / "evidence"
        evidence.mkdir()
        har = {
            "log": {"entries": [{
                "request": {"method": "GET", "url": "https://app.example.test/account?id=7", "headers": [{"name": "Authorization", "value": "redacted"}], "queryString": [{"name": "id", "value": "7"}], "bodySize": 0},
                "response": {"status": 302, "headers": [{"name": "Set-Cookie", "value": "redacted"}], "redirectURL": "https://login.example.test/start", "bodySize": 12, "content": {"size": 12, "mimeType": "text/html"}}
            }]}
        }
        (evidence / "session.har").write_text(json.dumps(har), encoding="utf-8")
        config: dict[str, object] = {"$schema": "./http-traffic-analysis.schema.json", "analysis_id": "fixture-http", "scope_reference": "scope:http", "traffic_files": ["evidence/session.har"], "max_transactions": 8, "max_total_bytes": 65536, "timeout_seconds": 5, "output_limit_bytes": 65536}
        raw = f"{json.dumps(config, sort_keys=True)}\n".encode()
        return config, raw

    def test_cli_is_deterministic_and_emits_structural_evidence_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            config, raw = self._fixture(workspace)
            (workspace / "input.json").write_bytes(raw)
            self.assertEqual(self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "one.json"]), 0)
            self.assertEqual(self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "two.json"]), 0)
            first = json.loads((workspace / "one.json").read_text(encoding="utf-8"))
            second = json.loads((workspace / "two.json").read_text(encoding="utf-8"))
            self.assertEqual(first, second)
            transaction = first["transactions"][0]
            self.assertEqual(transaction["origin"], "https://app.example.test:443")
            self.assertEqual(transaction["query_names"], ["id"])
            self.assertIn("cross-origin-redirect", transaction["evidence_tags"])
            self.assertNotIn("redacted", json.dumps(first))
            self.assertEqual(config["analysis_id"], "fixture-http")

    def test_invalid_schema_and_symlink_refuse_without_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            config, raw = self._fixture(workspace)
            config["$schema"] = "wrong"
            (workspace / "input.json").write_text(json.dumps(config), encoding="utf-8")
            self.assertEqual(self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "out.json"]), 2)
            self.assertFalse((workspace / "out.json").exists())
            (workspace / "input.json").write_bytes(raw)
            (workspace / "link.har").symlink_to(workspace / "evidence" / "session.har")
            config["$schema"] = "./http-traffic-analysis.schema.json"
            config["traffic_files"] = ["link.har"]
            with self.assertRaisesRegex(self.module.AnalysisError, "symbolic"):
                self.module._analyze(config, "0" * 64, workspace, time.monotonic() + 5)

    def test_collision_preserves_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            _, raw = self._fixture(workspace)
            path = workspace / "input.json"
            path.write_bytes(raw)
            self.assertEqual(self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "input.json"]), 2)
            self.assertEqual(path.read_bytes(), raw)

    def test_deadline_transaction_and_output_limits_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            config, _ = self._fixture(workspace)
            with self.assertRaisesRegex(self.module.AnalysisError, "deadline"):
                self.module._analyze(config, "0" * 64, workspace, time.monotonic() - 1)
            config["max_transactions"] = 0
            with self.assertRaisesRegex(self.module.AnalysisError, "max_transactions"):
                self.module._analyze(config, "0" * 64, workspace, time.monotonic() + 5)
            config["max_transactions"] = 8
            config["output_limit_bytes"] = 1024
            report, limit = self.module._analyze(config, "0" * 64, workspace, time.monotonic() + 5)
            with self.assertRaisesRegex(self.module.AnalysisError, "output_limit"):
                self.module._write(workspace / "small.json", report, limit, time.monotonic() + 5)
            self.assertFalse((workspace / "small.json").exists())

    def test_atomic_publish_never_replaces_a_racing_destination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            config, _ = self._fixture(workspace)
            report, _ = self.module._analyze(config, "0" * 64, workspace, time.monotonic() + 5)
            destination = workspace / "raced.json"
            original_link = self.module.os.link

            def race(source: str, target: Path) -> None:
                Path(target).write_bytes(b"racer")
                original_link(source, target)

            with patch.object(self.module.os, "link", side_effect=race):
                with self.assertRaises(FileExistsError):
                    self.module._write(destination, report, 65536, time.monotonic() + 5)
            self.assertEqual(destination.read_bytes(), b"racer")


if __name__ == "__main__":
    unittest.main()
