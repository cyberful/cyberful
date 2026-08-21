# ── Smart-Contract Invariant Harness Tests ─────────────────────
# Covers deterministic offline execution, local-scope refusal, immutable
#   snapshots, network denial, stream limits, deadlines, cleanup, and output.
# → cyberful/builtin/skills/test-smart-contract-invariants/scripts/run_smart_contract_invariant_harness.py — implementation under test.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
from types import ModuleType
import unittest
from unittest.mock import patch


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "run_smart_contract_invariant_harness.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("run_smart_contract_invariant_harness", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load invariant harness")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


class SmartContractInvariantHarnessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _fixture(self, workspace: Path) -> tuple[Path, dict[str, object], bytes]:
        source = workspace / "contracts"
        (source / "test").mkdir(parents=True)
        (source / "foundry.toml").write_text("[profile.default]\nsrc = 'src'\n", encoding="utf-8")
        (source / "test" / "Invariant.t.sol").write_text("contract InvariantFixture {}\n", encoding="utf-8")
        fake = workspace / "fake_forge.py"
        fake.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import json, os, pathlib, sys
                if "--version" in sys.argv:
                    print("forge fixture 1.0")
                else:
                    root = pathlib.Path(sys.argv[sys.argv.index("--root") + 1])
                    print(json.dumps({
                        "fixture": (root / "test" / "Invariant.t.sol").read_text(encoding="utf-8"),
                        "offline": "--offline" in sys.argv,
                        "ffi_disabled": os.environ.get("FOUNDRY_FFI") == "false",
                        "runtime_caches": sorted(name for name in ("SVM_HOME", "FOUNDRY_DIR", "XDG_CACHE_HOME") if os.environ.get(name)),
                        "secret_leaked": bool(os.environ.get("CYBERFUL_TEST_SECRET")),
                        "proxy_leaked": bool(os.environ.get("HTTPS_PROXY")),
                    }, sort_keys=True))
                """
            ),
            encoding="utf-8",
        )
        fake.chmod(0o700)
        payload: dict[str, object] = {
            "$schema": "assets/smart-contract-invariant-campaign.schema.json",
            "campaign_id": "fixture-invariant",
            "scope_reference": "mission://fixture-local-source",
            "source_directory": "contracts",
            "test_pattern": "invariant_totalAssets",
            "fuzz_seed": "0x" + "42" * 32,
            "max_files": 16,
            "max_total_bytes": 65_536,
            "timeout_seconds": 5,
            "stdout_limit_bytes": 16_384,
        }
        raw = f"{json.dumps(payload, sort_keys=True)}\n".encode()
        return fake, payload, raw

    def test_offline_campaign_is_deterministic_and_leaks_no_host_routes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            for name in ("svm", "foundry", "xdg"):
                (workspace / name).mkdir()
            environment = {"CYBERFUL_TEST_SECRET": "must-not-leak", "HTTPS_PROXY": "http://127.0.0.1:9"}
            environment.update({"SVM_HOME": str(workspace / "svm"), "FOUNDRY_DIR": str(workspace / "foundry"), "XDG_CACHE_HOME": str(workspace / "xdg")})
            with patch.dict(os.environ, environment, clear=False):
                first = self.module._run_campaign_for_test(payload, raw, workspace, workspace / "first.json", str(fake))
                second = self.module._run_campaign_for_test(payload, raw, workspace, workspace / "second.json", str(fake))
            self.assertEqual(first, second)
            observed = json.loads(base64.b64decode(first["result"]["stdout"]["base64"]))
            self.assertTrue(observed["offline"])
            self.assertTrue(observed["ffi_disabled"])
            self.assertEqual(observed["runtime_caches"], ["FOUNDRY_DIR", "SVM_HOME", "XDG_CACHE_HOME"])
            self.assertFalse(observed["secret_leaked"])
            self.assertFalse(observed["proxy_leaked"])
            self.assertEqual(first["command"][0:3], ["forge", "test", "--offline"])
            self.assertEqual(first["tool"]["version_probe"]["argv"], ["forge", "--version"])
            self.assertEqual(first["tool"]["runtime_cache_environment"], ["FOUNDRY_DIR", "SVM_HOME", "XDG_CACHE_HOME"])
            self.assertEqual(first["network_sandbox"]["network"], "none")
            self.assertEqual(first["source"]["files"], 2)
            self.assertEqual((workspace / "first.json").stat().st_mode & 0o777, 0o600)

    def test_self_asserted_authority_and_nonlocal_scope_refuse_before_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            sentinel = workspace / "called"
            fake.write_text(f'#!/usr/bin/env python3\nfrom pathlib import Path\nPath({str(sentinel)!r}).write_text("called")\n', encoding="utf-8")
            fake.chmod(0o700)
            payload["authority"] = {"confirmed": True}
            with self.assertRaisesRegex(self.module.HarnessError, "input fields"):
                self.module._run_campaign_for_test(payload, raw, workspace, workspace / "authority.json", str(fake))
            self.assertFalse(sentinel.exists())
            payload.pop("authority")
            payload["source_directory"] = "../outside"
            with self.assertRaisesRegex(self.module.HarnessError, "non-traversing"):
                self.module._run_campaign_for_test(payload, raw, workspace, workspace / "scope.json", str(fake))
            self.assertFalse(sentinel.exists())

    def test_symlinks_limits_and_open_time_swaps_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            outside = workspace / "outside.sol"
            outside.write_text("outside\n", encoding="utf-8")
            (workspace / "contracts" / "linked.sol").symlink_to(outside)
            with self.assertRaisesRegex(self.module.HarnessError, "symbolic link"):
                self.module._run_campaign_for_test(payload, raw, workspace, workspace / "symlink.json", str(fake))
            (workspace / "contracts" / "linked.sol").unlink()
            payload["max_files"] = 1
            with self.assertRaisesRegex(self.module.HarnessError, "max_files"):
                self.module._run_campaign_for_test(payload, raw, workspace, workspace / "limit.json", str(fake))
            source = workspace / "contracts" / "foundry.toml"
            parent_descriptor = os.open(source.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                expected = os.stat(source.name, dir_fd=parent_descriptor, follow_symlinks=False)
                replacement = workspace / "replacement"
                replacement.write_text("replacement\n", encoding="utf-8")
                os.replace(replacement, source)
                with self.assertRaisesRegex(self.module.HarnessError, "changed while opening"):
                    self.module._copy_regular_at(parent_descriptor, source.name, workspace / "copy", expected, time.monotonic() + 1)
            finally:
                os.close(parent_descriptor)

    def test_source_root_and_directory_swaps_cannot_redirect_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            _, _, _ = self._fixture(workspace)
            source = self.module._open_directory(workspace, Path("contracts"))
            original = workspace / "original-contracts"
            outside = workspace / "outside"
            outside.mkdir()
            (outside / "poison.sol").write_text("poison\n", encoding="utf-8")
            (workspace / "contracts").rename(original)
            (workspace / "contracts").symlink_to(outside, target_is_directory=True)
            snapshot = workspace / "snapshot"
            try:
                inventory = self.module._snapshot(source, snapshot, 16, 65_536, time.monotonic() + 2)
            finally:
                os.close(source.descriptor)
            self.assertEqual(inventory["files"], 2)
            self.assertFalse((snapshot / "poison.sol").exists())
            parent_descriptor = os.open(original, os.O_RDONLY | os.O_DIRECTORY)
            child = original / "test"
            expected = os.stat("test", dir_fd=parent_descriptor, follow_symlinks=False)
            moved = original / "moved-test"
            child.rename(moved)
            child.symlink_to(outside, target_is_directory=True)
            try:
                with self.assertRaisesRegex(self.module.HarnessError, "changed while opening"):
                    self.module._open_child_directory(parent_descriptor, "test", expected)
            finally:
                os.close(parent_descriptor)

    def test_tool_reads_snapshot_when_source_changes_after_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            source_file = workspace / "contracts" / "test" / "Invariant.t.sol"
            original = source_file.read_text(encoding="utf-8")
            fake.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env python3
                    import json, pathlib, sys
                    if "--version" in sys.argv:
                        pathlib.Path({str(source_file)!r}).write_text("swapped after snapshot\\n", encoding="utf-8")
                        print("forge fixture 1.0")
                    else:
                        root = pathlib.Path(sys.argv[sys.argv.index("--root") + 1])
                        print(json.dumps({{"snapshot": (root / "test" / "Invariant.t.sol").read_text(encoding="utf-8")}}))
                    """
                ),
                encoding="utf-8",
            )
            fake.chmod(0o700)
            evidence = self.module._run_campaign_for_test(payload, raw, workspace, workspace / "snapshot.json", str(fake))
            observed = json.loads(base64.b64decode(evidence["result"]["stdout"]["base64"]))
            self.assertEqual(observed["snapshot"], original)
            self.assertEqual(source_file.read_text(encoding="utf-8"), "swapped after snapshot\n")

    def test_network_none_sandbox_blocks_socket_or_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            listener.settimeout(2)
            accepted: list[bool] = []

            def accept_connection() -> None:
                try:
                    connection, _ = listener.accept()
                except OSError:
                    return
                accepted.append(True)
                connection.close()

            thread = threading.Thread(target=accept_connection, daemon=True)
            thread.start()
            fake.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env python3
                    import ctypes, errno, json, os, platform, socket, sys
                    if "--version" in sys.argv:
                        print("forge fixture 1.0")
                    else:
                        blocked = False
                        try:
                            candidate = socket.create_connection(("127.0.0.1", {listener.getsockname()[1]}), timeout=1)
                            candidate.close()
                        except OSError:
                            blocked = True
                        io_uring_blocked = True
                        x32_blocked = True
                        if sys.platform.startswith("linux"):
                            libc = ctypes.CDLL(None, use_errno=True)
                            ctypes.set_errno(0)
                            io_uring_blocked = libc.syscall(425, 2, 0) == -1 and ctypes.get_errno() == errno.EACCES
                            if platform.machine().lower() == "x86_64":
                                ctypes.set_errno(0)
                                x32_blocked = libc.syscall(0x40000000 | 41, 2, 1, 0) == -1 and ctypes.get_errno() == errno.EACCES
                        print(json.dumps({{"ffi_disabled": os.environ.get("FOUNDRY_FFI") == "false", "io_uring_blocked": io_uring_blocked, "network_blocked": blocked, "x32_blocked": x32_blocked}}))
                    """
                ),
                encoding="utf-8",
            )
            fake.chmod(0o700)
            output = workspace / "network.json"
            try:
                evidence = self.module._run_campaign_for_test(payload, raw, workspace, output, str(fake), self.module._network_sandbox)
            except self.module.HarnessError as error:
                self.assertIn("could not start", str(error))
                self.assertFalse(output.exists())
                listener.close()
                thread.join(timeout=2)
                return
            observed = json.loads(base64.b64decode(evidence["result"]["stdout"]["base64"]))
            listener.close()
            thread.join(timeout=2)
            self.assertTrue(observed["network_blocked"])
            self.assertTrue(observed["io_uring_blocked"])
            self.assertTrue(observed["x32_blocked"])
            self.assertTrue(observed["ffi_disabled"])
            self.assertFalse(accepted)

    def test_runtime_cache_validation_and_missing_offline_compiler_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            cache = workspace / "compiler-cache"
            cache.mkdir()
            linked_cache = workspace / "linked-cache"
            linked_cache.symlink_to(cache, target_is_directory=True)
            with patch.dict(os.environ, {"SVM_HOME": str(linked_cache)}, clear=False):
                with self.assertRaisesRegex(self.module.HarnessError, "symbolic link"):
                    self.module._run_campaign_for_test(payload, raw, workspace, workspace / "bad-cache.json", str(fake))
            self.assertFalse((workspace / "bad-cache.json").exists())
            fake.write_text(
                "#!/usr/bin/env python3\nimport sys\nif '--version' in sys.argv: print('forge fixture 1')\nelse:\n print('solc 0.8.25 is not installed; cannot install compiler in offline mode', file=sys.stderr)\n raise SystemExit(1)\n",
                encoding="utf-8",
            )
            fake.chmod(0o700)
            with patch.dict(os.environ, {"SVM_HOME": str(cache)}, clear=False):
                with self.assertRaisesRegex(self.module.HarnessError, "compiler is unavailable"):
                    self.module._run_campaign_for_test(payload, raw, workspace, workspace / "missing-compiler.json", str(fake))
            self.assertFalse((workspace / "missing-compiler.json").exists())

    def test_output_is_hard_bounded_during_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            fake.write_text("#!/usr/bin/env python3\nimport sys,time\nif '--version' in sys.argv: print('forge fixture 1')\nelse:\n sys.stdout.write('x' * 131072)\n sys.stdout.flush()\n time.sleep(30)\n", encoding="utf-8")
            fake.chmod(0o700)
            payload["stdout_limit_bytes"] = 1024
            evidence = self.module._run_campaign_for_test(payload, raw, workspace, workspace / "bounded.json", str(fake))
            self.assertEqual(evidence["result"]["limit_exceeded"], "stdout")
            self.assertLessEqual(evidence["result"]["stdout"]["bytes"], 1024)

    def test_deadline_kills_descendant_after_leader_exits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, payload, raw = self._fixture(workspace)
            descendant_pid = workspace / "descendant.pid"
            child_program = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"
            fake.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env python3
                    import pathlib, signal, subprocess, sys, time
                    if "--version" in sys.argv:
                        print("forge fixture 1")
                    else:
                        child = subprocess.Popen([sys.executable, "-c", {child_program!r}])
                        pathlib.Path({str(descendant_pid)!r}).write_text(str(child.pid), encoding="utf-8")
                        signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))
                        time.sleep(30)
                    """
                ),
                encoding="utf-8",
            )
            fake.chmod(0o700)
            payload["timeout_seconds"] = 2
            evidence = self.module._run_campaign_for_test(payload, raw, workspace, workspace / "deadline.json", str(fake))
            self.assertTrue(evidence["result"]["timed_out"])
            process_id = int(descendant_pid.read_text(encoding="utf-8"))
            until = time.monotonic() + 2
            while True:
                try:
                    os.kill(process_id, 0)
                except ProcessLookupError:
                    break
                if time.monotonic() >= until:
                    self.fail(f"descendant {process_id} survived process-group cleanup")
                time.sleep(0.02)

    def test_expired_writer_and_collision_preserve_owned_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            _, payload, raw = self._fixture(workspace)
            late = self.module._open_output_target(workspace, "late.json")
            try:
                with self.assertRaisesRegex(self.module.HarnessError, "deadline"):
                    self.module._atomic_json(late, {"value": True}, time.monotonic() - 1)
                self.assertFalse((workspace / "late.json").exists())
            finally:
                os.close(late.parent_descriptor)
            raced = self.module._open_output_target(workspace, "raced.json")
            (workspace / "raced.json").write_text("attacker-owned\n", encoding="utf-8")
            try:
                with self.assertRaisesRegex(self.module.HarnessError, "created before publication"):
                    self.module._atomic_json(raced, {"value": True}, time.monotonic() + 2)
                self.assertEqual((workspace / "raced.json").read_text(encoding="utf-8"), "attacker-owned\n")
            finally:
                os.close(raced.parent_descriptor)
            expiring = self.module._open_output_target(workspace, "expiring.json")
            publication_checks = 0

            def expire_after_link(deadline: float, stage: str) -> None:
                nonlocal publication_checks
                if stage == "evidence publication":
                    publication_checks += 1
                    if publication_checks == 2:
                        raise self.module.HarnessError("harness deadline expired during evidence publication")

            try:
                with patch.object(self.module, "_check_deadline", side_effect=expire_after_link):
                    with self.assertRaisesRegex(self.module.HarnessError, "deadline"):
                        self.module._atomic_json(expiring, {"value": True}, time.monotonic() + 2)
                self.assertFalse((workspace / "expiring.json").exists())
            finally:
                os.close(expiring.parent_descriptor)
            input_path = workspace / "campaign.json"
            input_path.write_bytes(raw)
            before = input_path.read_bytes()
            result = subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "campaign.json", "--output", "campaign.json"], check=False, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(input_path.read_bytes(), before)
            self.assertEqual(payload["campaign_id"], "fixture-invariant")

    def test_output_parent_swap_stays_on_owned_descriptor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            parent = workspace / "evidence"
            parent.mkdir()
            target = self.module._open_output_target(workspace, "evidence/result.json")
            owned_parent = workspace / "owned-evidence"
            outside = workspace / "outside"
            outside.mkdir()
            parent.rename(owned_parent)
            parent.symlink_to(outside, target_is_directory=True)
            try:
                self.module._atomic_json(target, {"value": True}, time.monotonic() + 2)
            finally:
                os.close(target.parent_descriptor)
            self.assertEqual(json.loads((owned_parent / "result.json").read_text(encoding="utf-8")), {"value": True})
            self.assertFalse((outside / "result.json").exists())

    @unittest.skipUnless(shutil.which("forge"), "real forge is not installed")
    def test_real_forge_smoke_is_offline_or_refuses_missing_compiler(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            _, payload, raw = self._fixture(workspace)
            output = workspace / "real-forge.json"
            try:
                evidence = self.module._run_campaign_for_test(payload, raw, workspace, output, shutil.which("forge"), self.module._network_sandbox)
            except self.module.HarnessError as error:
                self.assertIn("compiler is unavailable", str(error))
                self.assertFalse(output.exists())
                return
            self.assertEqual(evidence["tool"]["name"], "forge")
            self.assertEqual(evidence["command"][0:3], ["forge", "test", "--offline"])


if __name__ == "__main__":
    unittest.main()
