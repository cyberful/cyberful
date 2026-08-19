# ── Supply-Chain Campaign Tests ─────────────────────────────────
# Exercises fixed-command test injection, authority and input rejection,
# execution-time output bounds, and process-group cleanup.
# → cyberful/builtin/skills/operate-supply-chain-toolchain/scripts/run_supply_chain_campaign.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch
from pathlib import Path
from types import ModuleType


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "run_supply_chain_campaign.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("run_supply_chain_campaign", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load supply-chain campaign")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class SupplyChainCampaignTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _fixture(self, workspace: Path) -> tuple[Path, dict[str, object]]:
        fake = workspace / "fake_syft.py"
        fake.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import json, sys
                if "--version" in sys.argv:
                    print("syft fixture 1.0")
                else:
                    print(json.dumps({"artifacts": [{"name": "fixture", "version": "1.0"}]}))
                """
            ),
            encoding="utf-8",
        )
        fake.chmod(0o700)
        (workspace / "artifact").mkdir()
        (workspace / "artifact" / "package.json").write_text('{"name":"fixture"}\n', encoding="utf-8")
        config: dict[str, object] = {
            "authorized": True,
            "artifact": "artifact",
            "output_directory": "evidence",
            "tools": ["syft"],
            "max_tool_runs": 1,
            "timeout_seconds": 5,
        }
        return fake, config

    def _run_cli(self, workspace: Path, config: dict[str, object]) -> subprocess.CompletedProcess[str]:
        (workspace / "config.json").write_text(json.dumps(config), encoding="utf-8")
        return subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(workspace), "--config", "config.json"], check=False, capture_output=True, text=True)

    def test_unit_campaign_preserves_native_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, config = self._fixture(workspace)
            record = self.module._run_campaign_for_test(config, workspace, {"syft": str(fake)})
            self.assertEqual(json.loads((workspace / "evidence" / "syft.json").read_text(encoding="utf-8"))["artifacts"][0]["name"], "fixture")
            self.assertEqual(record["runs"][0]["version"], "syft fixture 1.0")
            self.assertEqual(record["runs"][0]["exit_code"], 0)
            self.assertEqual((workspace / "evidence" / "syft.json").stat().st_mode & 0o777, 0o600)

    def test_ambient_environment_sentinel_does_not_reach_the_child(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, config = self._fixture(workspace)
            sentinel = workspace / "child-environment.txt"
            fake.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env python3
                    import json, os, pathlib, sys
                    if "--version" in sys.argv:
                        print("syft fixture 1.0")
                    else:
                        pathlib.Path({str(sentinel)!r}).write_text(os.environ.get("CYBERFUL_TEST_SENTINEL", "absent"), encoding="utf-8")
                        print(json.dumps({{"artifacts": []}}))
                    """
                ),
                encoding="utf-8",
            )
            fake.chmod(0o700)
            with patch.dict(os.environ, {"CYBERFUL_TEST_SENTINEL": "must-not-leak"}, clear=False):
                self.module._run_campaign_for_test(config, workspace, {"syft": str(fake)})
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "absent")

    def test_rejects_missing_authority_before_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, config = self._fixture(workspace)
            sentinel = workspace / "called"
            fake.write_text(f'#!/usr/bin/env python3\nfrom pathlib import Path\nPath({str(sentinel)!r}).write_text("called")\n', encoding="utf-8")
            fake.chmod(0o700)
            config["authorized"] = False
            with self.assertRaisesRegex(self.module.CampaignError, "authorized=true"):
                self.module._run_campaign_for_test(config, workspace, {"syft": str(fake)})
            self.assertFalse(sentinel.exists())

    def test_rejects_insufficient_tool_limit_and_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, config = self._fixture(workspace)
            config["tools"] = ["syft", "grype"]
            with self.assertRaisesRegex(self.module.CampaignError, "exceed max_tool_runs"):
                self.module._run_campaign_for_test(config, workspace, {"syft": str(fake), "grype": str(fake)})
            config["tools"] = ["syft"]
            config["artifact"] = "../artifact"
            with self.assertRaisesRegex(self.module.CampaignError, "non-traversing"):
                self.module._run_campaign_for_test(config, workspace, {"syft": str(fake)})

    def test_rejects_secret_and_binary_injection_in_json(self) -> None:
        for field in ("registry_token", "tool_binaries"):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                workspace = Path(directory)
                _, config = self._fixture(workspace)
                config[field] = "must-not-cross-model-boundary"
                result = self._run_cli(workspace, config)
                self.assertEqual(result.returncode, 2)
                self.assertIn("config fields", result.stderr)
                self.assertNotIn("must-not-cross-model-boundary", result.stderr)

    def test_timeout_cleans_up_the_tool_process(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, config = self._fixture(workspace)
            pid_file = workspace / "tool.pid"
            fake.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env python3
                    import os, pathlib, sys, time
                    if "--version" in sys.argv:
                        print("syft fixture 1.0")
                        raise SystemExit(0)
                    pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()))
                    time.sleep(30)
                    """
                ),
                encoding="utf-8",
            )
            fake.chmod(0o700)
            config["timeout_seconds"] = 1
            with self.assertRaisesRegex(self.module.CampaignError, "exceeded timeout_seconds=1"):
                self.module._run_campaign_for_test(config, workspace, {"syft": str(fake)})
            process_id = int(pid_file.read_text(encoding="utf-8"))
            with self.assertRaises(ProcessLookupError):
                os.kill(process_id, 0)

    def test_stdout_limit_stops_process_during_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, config = self._fixture(workspace)
            pid_file = workspace / "tool.pid"
            fake.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env python3
                    import os, pathlib, sys, time
                    if "--version" in sys.argv:
                        print("syft fixture 1.0")
                        raise SystemExit(0)
                    pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()))
                    sys.stdout.write("x" * 2048)
                    sys.stdout.flush()
                    time.sleep(30)
                    """
                ),
                encoding="utf-8",
            )
            fake.chmod(0o700)
            self.module.MAX_OUTPUT_BYTES = 1024
            with self.assertRaisesRegex(self.module.CampaignError, "stdout exceeded"):
                self.module._run_campaign_for_test(config, workspace, {"syft": str(fake)})
            process_id = int(pid_file.read_text(encoding="utf-8"))
            with self.assertRaises(ProcessLookupError):
                os.kill(process_id, 0)


if __name__ == "__main__":
    unittest.main()
