# ── Infrastructure-As-Code Campaign Tests ──────────────────────
# Covers offline success, preflight refusal, hard stream limits, one global
# deadline, descendant cleanup, environment isolation, and deterministic output.
# → cyberful/builtin/skills/audit-infrastructure-as-code/scripts/run_iac_audit_campaign.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import time
from types import ModuleType
import unittest
from unittest.mock import patch


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "run_iac_audit_campaign.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("run_iac_audit_campaign", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load IaC audit campaign")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


class InfrastructureAsCodeCampaignTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _fixture(self, workspace: Path) -> tuple[Path, dict[str, object], bytes]:
        source = workspace / "iac"
        source.mkdir()
        (source / "main.tf").write_text('resource "aws_s3_bucket" "fixture" {}\n', encoding="utf-8")
        fake = workspace / "fake_checkov.py"
        fake.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import json, os, sys
                if "--version" in sys.argv:
                    print("Checkov fixture 1.0")
                else:
                    print(json.dumps({"results": {"failed_checks": []}, "secret_leaked": bool(os.environ.get("CYBERFUL_TEST_SECRET")), "proxy_leaked": bool(os.environ.get("HTTPS_PROXY"))}, sort_keys=True))
                """
            ),
            encoding="utf-8",
        )
        fake.chmod(0o700)
        payload: dict[str, object] = {
            "$schema": "./iac-audit-campaign.schema.json",
            "campaign_id": "fixture-iac",
            "scope_reference": "scope:IAC-1",
            "source_directory": "iac",
            "max_files": 8,
            "max_total_bytes": 65_536,
            "timeout_seconds": 5,
            "stdout_limit_bytes": 16_384,
        }
        raw = f"{json.dumps(payload, sort_keys=True)}\n".encode()
        return fake, payload, raw

    def test_offline_campaign_preserves_raw_evidence_and_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            with patch.dict(os.environ, {"CYBERFUL_TEST_SECRET": "must-not-leak", "HTTPS_PROXY": "http://127.0.0.1:9"}, clear=False):
                first = self.module._run_campaign_for_test(payload, raw, workspace, workspace / "first.json", str(fake))
                second = self.module._run_campaign_for_test(payload, raw, workspace, workspace / "second.json", str(fake))
            self.assertEqual(first, second)
            native = json.loads(base64.b64decode(first["result"]["stdout"]["base64"]))
            self.assertFalse(native["secret_leaked"])
            self.assertFalse(native["proxy_leaked"])
            self.assertEqual(first["command"][0], "checkov")
            self.assertEqual(first["tool"]["version_probe"]["argv"], ["checkov", "--version"])
            self.assertEqual(first["tool"]["version_probe"]["exit_code"], 0)
            self.assertIn(b"Checkov fixture 1.0", base64.b64decode(first["tool"]["version_probe"]["stdout"]["base64"]))
            self.assertEqual(first["network_sandbox"]["network"], "none")
            self.assertEqual(first["source"]["files"], 1)
            self.assertEqual((workspace / "first.json").stat().st_mode & 0o777, 0o600)

    def test_refuses_missing_authority_and_insufficient_file_limit_before_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            sentinel = workspace / "called"
            fake.write_text(f'#!/usr/bin/env python3\nfrom pathlib import Path\nPath({str(sentinel)!r}).write_text("called")\n', encoding="utf-8")
            fake.chmod(0o700)
            payload["scope_reference"] = ""
            with self.assertRaisesRegex(self.module.CampaignError, "scope_reference"):
                self.module._run_campaign_for_test(payload, raw, workspace, workspace / "refused.json", str(fake))
            self.assertFalse(sentinel.exists())
            payload["scope_reference"] = "scope:IAC-1"
            (workspace / "iac" / "variables.tf").write_text('variable "region" {}\n', encoding="utf-8")
            payload["max_files"] = 1
            with self.assertRaisesRegex(self.module.CampaignError, "max_files"):
                self.module._run_campaign_for_test(payload, raw, workspace, workspace / "refused.json", str(fake))
            self.assertFalse(sentinel.exists())

    def test_stdout_is_hard_bounded_during_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            fake.write_text(
                "#!/usr/bin/env python3\nimport sys, time\nif '--version' in sys.argv: print('fixture 1')\nelse:\n sys.stdout.write('x' * 131072)\n sys.stdout.flush()\n time.sleep(30)\n",
                encoding="utf-8",
            )
            fake.chmod(0o700)
            payload["stdout_limit_bytes"] = 1024
            evidence = self.module._run_campaign_for_test(payload, raw, workspace, workspace / "bounded.json", str(fake))
            self.assertEqual(evidence["result"]["limit_exceeded"], "stdout")
            self.assertLessEqual(evidence["result"]["stdout"]["bytes"], 1024)

    def test_global_deadline_cleans_descendant_process_group(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            child_pid = workspace / "descendant.pid"
            child_program = "import time; time.sleep(30)"
            fake.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env python3
                    import pathlib, subprocess, sys, time
                    if "--version" in sys.argv:
                        time.sleep(0.2)
                        print("fixture 1")
                    else:
                        child = subprocess.Popen([sys.executable, "-c", {child_program!r}])
                        pathlib.Path({str(child_pid)!r}).write_text(str(child.pid))
                        time.sleep(30)
                    """
                ),
                encoding="utf-8",
            )
            fake.chmod(0o700)
            payload["timeout_seconds"] = 2
            started = time.monotonic()
            evidence = self.module._run_campaign_for_test(payload, raw, workspace, workspace / "deadline.json", str(fake))
            elapsed = time.monotonic() - started
            self.assertTrue(evidence["result"]["timed_out"])
            self.assertLess(elapsed, 2.5)
            self.assertTrue(child_pid.exists())
            process_id = int(child_pid.read_text(encoding="utf-8"))
            with self.assertRaises(ProcessLookupError):
                os.kill(process_id, 0)

    def test_stream_reader_failure_still_reaps_the_process_group(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake = workspace / "stream_fixture.py"
            pid_file = workspace / "stream.pid"
            fake.write_text(
                f'#!/usr/bin/env python3\nimport os,pathlib,time\npathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()))\nprint("ready", flush=True)\ntime.sleep(30)\n',
                encoding="utf-8",
            )
            fake.chmod(0o700)
            home = workspace / "home"
            home.mkdir()
            direct_sandbox = lambda argv: self.module.NetworkSandbox(argv, "test-fixture-no-network-route", None)
            with patch.object(self.module, "_read_stream", side_effect=OSError("synthetic stream failure")):
                with self.assertRaisesRegex(OSError, "synthetic stream failure"):
                    self.module._run_process(
                        [str(fake)],
                        deadline=time.monotonic() + 5,
                        stdout_limit=1024,
                        stderr_limit=1024,
                        environment=self.module._process_environment(home),
                        cwd=workspace,
                        sandbox_factory=direct_sandbox,
                    )
            process_id = int(pid_file.read_text(encoding="utf-8"))
            with self.assertRaises(ProcessLookupError):
                os.kill(process_id, 0)

    def test_slow_inventory_consumes_the_shared_deadline_before_tool_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            sentinel = workspace / "called"
            fake.write_text(f'#!/usr/bin/env python3\nfrom pathlib import Path\nPath({str(sentinel)!r}).write_text("called")\n', encoding="utf-8")
            fake.chmod(0o700)
            payload["timeout_seconds"] = 2
            original_copy = self.module._copy_regular_file

            def slow_copy(*arguments: object) -> bytes:
                time.sleep(1.1)
                return original_copy(*arguments)

            with patch.object(self.module, "_copy_regular_file", side_effect=slow_copy):
                with self.assertRaisesRegex(self.module.CampaignError, "deadline"):
                    self.module._run_campaign_for_test(payload, raw, workspace, workspace / "slow.json", str(fake))
            self.assertFalse(sentinel.exists())
            self.assertFalse((workspace / "slow.json").exists())

    def test_tool_reads_the_content_snapshot_after_source_swap_and_rejects_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            source_file = workspace / "iac" / "main.tf"
            original = source_file.read_text(encoding="utf-8")
            fake.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env python3
                    import json, pathlib, sys
                    if "--version" in sys.argv:
                        pathlib.Path({str(source_file)!r}).write_text("swapped after snapshot\\n", encoding="utf-8")
                        print("fixture 1")
                    else:
                        root = pathlib.Path(sys.argv[sys.argv.index("--directory") + 1])
                        print(json.dumps({{"snapshot": (root / "main.tf").read_text(encoding="utf-8")}}))
                    """
                ),
                encoding="utf-8",
            )
            fake.chmod(0o700)
            evidence = self.module._run_campaign_for_test(payload, raw, workspace, workspace / "snapshot.json", str(fake))
            observed = json.loads(base64.b64decode(evidence["result"]["stdout"]["base64"]))
            self.assertEqual(observed["snapshot"], original)
            self.assertEqual(source_file.read_text(encoding="utf-8"), "swapped after snapshot\n")

        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            outside = workspace / "outside.tf"
            outside.write_text("outside\n", encoding="utf-8")
            (workspace / "iac" / "linked.tf").symlink_to(outside)
            with self.assertRaisesRegex(self.module.CampaignError, "symbolic link"):
                self.module._run_campaign_for_test(payload, raw, workspace, workspace / "symlink.json", str(fake))
            self.assertFalse((workspace / "symlink.json").exists())

    def test_network_none_sandbox_blocks_an_ipv4_socket_or_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            fake.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env python3
                    import json, socket, sys
                    if "--version" in sys.argv:
                        print("fixture 1")
                    else:
                        blocked = False
                        try:
                            candidate = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                            candidate.close()
                        except OSError:
                            blocked = True
                        print(json.dumps({{"network_blocked": blocked}}))
                    """
                ),
                encoding="utf-8",
            )
            fake.chmod(0o700)
            output = workspace / "network.json"
            try:
                evidence = self.module._run_campaign_for_test(
                    payload,
                    raw,
                    workspace,
                    output,
                    str(fake),
                    self.module._network_sandbox,
                )
            except self.module.CampaignError as error:
                self.assertIn("could not start", str(error))
                self.assertFalse(output.exists())
                return
            raw_stdout = base64.b64decode(evidence["result"]["stdout"]["base64"])
            if not raw_stdout:
                self.assertNotEqual(evidence["result"]["exit_code"], 0)
                return
            observed = json.loads(raw_stdout)
            self.assertTrue(observed["network_blocked"])

    def test_cli_rejects_input_output_collision_without_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            _, payload, raw = self._fixture(workspace)
            input_path = workspace / "campaign.json"
            input_path.write_bytes(raw)
            before = input_path.read_bytes()
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "campaign.json", "--output", "campaign.json"],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertEqual(input_path.read_bytes(), before)
            self.assertEqual(payload["campaign_id"], "fixture-iac")


if __name__ == "__main__":
    unittest.main()
