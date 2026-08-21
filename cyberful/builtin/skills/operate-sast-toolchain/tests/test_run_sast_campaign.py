# ── SAST Campaign Tests ─────────────────────────────────────────
# Exercises authorized local execution, authority rejection, a global deadline,
# hard output caps, and the trusted environment allowlist.
# → cyberful/builtin/skills/operate-sast-toolchain/scripts/run_sast_campaign.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import os
import tempfile
import textwrap
import unittest
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "run_sast_campaign.py"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("sast_campaign", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load SAST campaign")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SastCampaignTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _workspace(self, directory: str) -> tuple[Path, dict[str, object]]:
        workspace = Path(directory).resolve()
        (workspace / "src").mkdir()
        (workspace / "src" / "app.py").write_text("print('ok')\n", encoding="utf-8")
        (workspace / "rules").mkdir()
        (workspace / "rules" / "security.yaml").write_text("rules: []\n", encoding="utf-8")
        payload = {"authority": {"scope_id": "audit", "allowed_roots": ["src"], "max_invocations": 1, "max_jobs": 1}, "scans": [{"id": "baseline", "root": "src", "config": "rules/security.yaml"}]}
        return workspace, payload

    def test_authorized_campaign_preserves_raw_output_without_host_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, payload = self._workspace(directory)
            fake = workspace / "trusted-semgrep-fixture"
            fake.write_text(textwrap.dedent("""\
                #!/usr/bin/env python3
                import json, os, sys
                if "--version" in sys.argv:
                    print("semgrep fixture 1.0")
                else:
                    print(json.dumps({"results": [], "secret_visible": "CYBERFUL_TEST_SECRET" in os.environ}))
            """), encoding="utf-8")
            fake.chmod(0o700)
            os.environ["CYBERFUL_TEST_SECRET"] = "must-not-reach-tool"
            try:
                report = self.module.run_campaign(payload, "a" * 64, workspace, executable=str(fake), deadline_seconds=3)
            finally:
                del os.environ["CYBERFUL_TEST_SECRET"]
            self.assertEqual(report["executions"][0]["exit_code"], 0)
            self.assertIn('"secret_visible": false', report["executions"][0]["stdout"])
            self.assertEqual(report["tool"]["version"], "semgrep fixture 1.0")

    def test_rejects_root_and_invocation_count_before_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, payload = self._workspace(directory)
            (workspace / "other").mkdir()
            payload["scans"][0]["root"] = "other"  # type: ignore[index]
            with self.assertRaisesRegex(self.module.CampaignError, "outside authority"):
                self.module.run_campaign(payload, "b" * 64, workspace, executable="semgrep", deadline_seconds=2)
            payload["scans"] *= 2  # type: ignore[operator]
            with self.assertRaisesRegex(self.module.CampaignError, "scan count"):
                self.module.run_campaign(payload, "b" * 64, workspace, executable="semgrep", deadline_seconds=2)

    def test_global_deadline_terminates_process_group(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, payload = self._workspace(directory)
            pid_file = workspace / "pid"
            fake = workspace / "slow-semgrep"
            fake.write_text(textwrap.dedent(f"""\
                #!/usr/bin/env python3
                import os, pathlib, time
                pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()))
                time.sleep(30)
            """), encoding="utf-8")
            fake.chmod(0o700)
            with self.assertRaisesRegex(self.module.CampaignError, "global deadline"):
                self.module.run_campaign(payload, "c" * 64, workspace, executable=str(fake), deadline_seconds=0.8)
            process_id = int(pid_file.read_text(encoding="utf-8"))
            with self.assertRaises(ProcessLookupError):
                os.kill(process_id, 0)

    def test_output_cap_terminates_tool(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace, payload = self._workspace(directory)
            fake = workspace / "noisy-semgrep"
            fake.write_text("#!/usr/bin/env python3\nimport sys\nsys.stdout.write('x' * 18000000)\n", encoding="utf-8")
            fake.chmod(0o700)
            with self.assertRaisesRegex(self.module.CampaignError, "output boundary"):
                self.module.run_campaign(payload, "d" * 64, workspace, executable=str(fake), deadline_seconds=3)


if __name__ == "__main__":
    unittest.main()
