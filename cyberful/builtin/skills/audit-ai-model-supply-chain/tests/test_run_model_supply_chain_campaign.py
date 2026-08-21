# ── Model Supply-Chain Campaign Tests ───────────────────────────
# Exercises fixed-command collection, recursive artifact preflight, and real
#   process-group cleanup including a descendant after its leader exits.
# → cyberful/builtin/skills/audit-ai-model-supply-chain/scripts/run_model_supply_chain_campaign.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "run_model_supply_chain_campaign.py"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("model_campaign", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load model campaign")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def payload() -> dict[str, object]:
    return {"authority": {"scope_id": "audit", "allowed_artifacts": ["model"], "max_invocations": 1}, "artifacts": [{"id": "model", "path": "model"}]}


class ModelCampaignTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def test_runtime_uses_only_the_fixed_syft_command(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            (workspace / "model").mkdir()
            (workspace / "model" / "config.json").write_text("{}\n", encoding="utf-8")
            invocations: list[list[str]] = []

            def fake_run(argv: list[str], deadline: float, limit: int) -> dict[str, object]:
                invocations.append(argv)
                return {"argv": argv, "exit_code": 0, "duration_ms": 1, "stdout": '{"artifacts":[]}', "stderr": ""}

            with patch.object(self.module, "_run", side_effect=fake_run):
                report = self.module.run_campaign(payload(), "a" * 64, workspace, deadline_seconds=3)
            self.assertEqual(invocations[0], ["syft", "version", "-o", "json"])
            self.assertEqual(invocations[1], ["syft", "scan", str(workspace / "model"), "-o", "json"])
            self.assertEqual(report["runs"][0]["exit_code"], 0)

    def test_rejects_artifact_outside_constraints_before_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            (workspace / "model").mkdir()
            (workspace / "other").mkdir()
            campaign = payload()
            campaign["artifacts"] = [{"id": "other", "path": "other"}]
            with patch.object(self.module, "_run") as runner:
                with self.assertRaisesRegex(self.module.CampaignError, "outside authority"):
                    self.module.run_campaign(campaign, "b" * 64, workspace, deadline_seconds=1)
                runner.assert_not_called()

    def test_recursive_preflight_rejects_symlink_and_special_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            model = workspace / "model"
            model.mkdir()
            outside = workspace / "outside"
            outside.write_text("bytes", encoding="utf-8")
            (model / "link").symlink_to(outside)
            with patch.object(self.module, "_run") as runner:
                with self.assertRaisesRegex(self.module.CampaignError, "symbolic link"):
                    self.module.run_campaign(payload(), "c" * 64, workspace, deadline_seconds=1)
                runner.assert_not_called()
            (model / "link").unlink()
            if hasattr(os, "mkfifo"):
                os.mkfifo(model / "pipe")
                with patch.object(self.module, "_run") as runner:
                    with self.assertRaisesRegex(self.module.CampaignError, "special file"):
                        self.module.run_campaign(payload(), "d" * 64, workspace, deadline_seconds=1)
                    runner.assert_not_called()

    def test_deadline_cleans_descendant_after_group_leader_exits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            child_pid_file = Path(directory) / "child.pid"
            program = (
                "import pathlib,subprocess,sys; "
                "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); "
                f"pathlib.Path({str(child_pid_file)!r}).write_text(str(child.pid)); "
                "sys.stdout.flush()"
            )
            with self.assertRaisesRegex(self.module.CampaignError, "global deadline"):
                self.module._run([sys.executable, "-c", program], time.monotonic() + 0.3, 4096)
            child_pid = int(child_pid_file.read_text(encoding="utf-8"))
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                try:
                    os.kill(child_pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.02)
            else:
                self.fail("descendant survived process-group cleanup")


if __name__ == "__main__":
    unittest.main()
