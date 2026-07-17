# ── cyberful-os Container Execution Contract ────────────────────────────
# Exercises real command execution, workarea mapping, mount recovery, and the
# timeout and cleanup behavior observable from routine MCP tool calls.
# → mcps/cyberful-os/cyberful_os_mcp.py — owns container creation and bounded exec.
# ─────────────────────────────────────────────────────────────────────

import importlib.util
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cyberful_os_mcp", ROOT / "cyberful_os_mcp.py")
cyberful_os_mcp = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = cyberful_os_mcp
SPEC.loader.exec_module(cyberful_os_mcp)


def _dummy_result():
    return cyberful_os_mcp.CommandResult(
        target="",
        command="",
        exit_code=0,
        timed_out=False,
        duration_ms=0,
        stdout="",
        stderr="",
        truncated=False,
    )


class RunProcessTest(unittest.TestCase):
    def test_captures_routine_command_output(self):
        result = cyberful_os_mcp.run_process(
            [sys.executable, "-c", "print('ready')"],
            timeout_seconds=5,
            max_output_bytes=4096,
        )

        self.assertEqual(result.exit_code, 0)
        self.assertFalse(result.timed_out)
        self.assertEqual(result.stdout.strip(), "ready")

    def test_timeout_stops_and_reaps_the_command(self):
        result = cyberful_os_mcp.run_process(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            timeout_seconds=0.05,
            max_output_bytes=4096,
        )

        self.assertIsNone(result.exit_code)
        self.assertTrue(result.timed_out)
        self.assertIn("Timed out", result.stderr)

    def test_retained_output_is_bounded(self):
        result = cyberful_os_mcp.run_process(
            [sys.executable, "-c", "import sys; sys.stdout.write('x' * 8192)"],
            timeout_seconds=5,
            max_output_bytes=1024,
        )

        self.assertEqual(result.exit_code, 0)
        self.assertTrue(result.truncated)
        self.assertIn("stdout truncated", result.stdout)


class DefaultContainerCwdTest(unittest.TestCase):
    def test_source_builtins_mark_the_workspace_root(self):
        with tempfile.TemporaryDirectory() as root:
            workarea = pathlib.Path(root) / "work" / "engagement"
            workarea.mkdir(parents=True)
            builtins = pathlib.Path(root) / "packages" / "cyberful" / "builtin"
            builtins.mkdir(parents=True)
            (builtins / "cyberful.json").write_text("{}", encoding="utf-8")

            with mock.patch.dict(os.environ, {"CYBERFUL_OS_MOUNT": "/workspace"}, clear=False), mock.patch.object(
                os, "getcwd", return_value=str(workarea)
            ):
                os.environ.pop("CYBERFUL_OS_WORKSPACE", None)
                self.assertEqual(cyberful_os_mcp.default_container_cwd(), "/workspace/work/engagement")


# ── The exec -w Must Never Be A Workarea Path ─────────────────────────
# Regression for the exit-128 runc failure ("current working directory is outside of container
# mount namespace root -- possible container breakout detected"): a computed workarea path used
# as docker exec's -w aborts the WHOLE tool call when that dir is missing / being recreated on the
# shared bind mount. The workarea is entered with an in-container `cd` instead, so a bad workarea
# degrades to running at the mount root rather than killing the exec.
# ──────────────────────────────────────────────────────────────────────

class ContainerExecWorkdirTest(unittest.TestCase):
    WORKAREA = "/workspace/work/launchdarkly"

    def _capture(self, call):
        captured = {}

        def fake_run_process(argv, **kwargs):
            captured["argv"] = argv
            captured["kwargs"] = kwargs
            return _dummy_result()

        with mock.patch.object(cyberful_os_mcp, "ensure_container", lambda *a, **k: None), \
             mock.patch.object(cyberful_os_mcp, "inherited_container_env", lambda extra: {}), \
             mock.patch.object(cyberful_os_mcp, "run_process", fake_run_process):
            call()
        return captured["argv"], captured["kwargs"]

    def _dash_w(self, argv):
        i = argv.index("-w")
        return argv[i + 1]

    def test_run_in_container_pins_w_to_mount_and_cds_into_workarea(self):
        argv, _ = self._capture(
            lambda: cyberful_os_mcp.run_in_container("echo hi", cwd=self.WORKAREA)
        )
        # -w is the always-valid mount root, NOT the fragile workarea.
        self.assertEqual(self._dash_w(argv), cyberful_os_mcp.mount_dir())
        self.assertNotIn(self.WORKAREA, [self._dash_w(argv)])
        # The command cd's into the workarea best-effort, then runs the original command.
        self.assertEqual(argv[-3:-1], ["/bin/bash", "-lc"])
        self.assertEqual(
            argv[-1], f"cd {shlex.quote(self.WORKAREA)} 2>/dev/null || true; echo hi"
        )

    def test_run_argv_in_container_pins_w_to_mount_and_cds_into_workarea(self):
        real_argv = ["python3", "-c", "print(1)"]
        exec_argv, kwargs = self._capture(
            lambda: cyberful_os_mcp.run_argv_in_container(
                list(real_argv), cwd=self.WORKAREA, stdin=b"body"
            )
        )
        self.assertEqual(self._dash_w(exec_argv), cyberful_os_mcp.mount_dir())
        # Wrapped in a shell that cd's then execs the real argv verbatim (stdin preserved).
        self.assertEqual(
            exec_argv[-(4 + len(real_argv)):],
            [
                "/bin/sh",
                "-c",
                f"cd {shlex.quote(self.WORKAREA)} 2>/dev/null || true; " + 'exec "$@"',
                "sh",
                *real_argv,
            ],
        )
        self.assertEqual(kwargs.get("stdin"), b"body")

    def test_missing_cwd_falls_back_to_mount(self):
        argv, _ = self._capture(lambda: cyberful_os_mcp.run_in_container("echo hi"))
        self.assertEqual(self._dash_w(argv), cyberful_os_mcp.mount_dir())
        # With no workarea the prelude cd's to the mount root — a harmless no-op.
        self.assertEqual(
            argv[-1],
            f"cd {shlex.quote(cyberful_os_mcp.mount_dir())} 2>/dev/null || true; echo hi",
        )


# ── A Stale /workspace Mount Must Recreate, Not Reuse ─────────────────
# A container that outlives a previous run can have its /workspace bind mount detach (the host
# workarea dir recreated under it, or a Docker/runc transition). Reusing it makes runc trip its
# CVE-2024-21626 guard on EVERY `docker exec -w /workspace` (exit 128, "possible container breakout
# detected") — which reads as "all tools broken." ensure_container probes the mount once per
# process and recreates a stale container instead of handing it back.
# ──────────────────────────────────────────────────────────────────────

def _completed(returncode=0, stdout=b"", stderr=b""):
    return subprocess.CompletedProcess(args=["docker"], returncode=returncode, stdout=stdout, stderr=stderr)


class EnsureContainerStaleMountTest(unittest.TestCase):
    def setUp(self):
        # The once-per-process latch is module state — reset it so each test starts cold.
        cyberful_os_mcp._mount_verified = False

    def tearDown(self):
        cyberful_os_mcp._mount_verified = False

    def _run_ensure(self, responder):
        calls = []

        def fake_docker(argv, **kwargs):
            calls.append(list(argv))
            return responder(list(argv))

        with mock.patch.object(cyberful_os_mcp, "docker", fake_docker):
            cyberful_os_mcp.ensure_container(60)
        return [c[0] for c in calls]  # docker subcommand per call, in order

    @staticmethod
    def _running_healthy(argv):
        # A running container whose image matches the current tag; the mount probe reports healthy.
        if argv[0] == "container":
            return _completed(0, stdout=b"IMGID true")
        if argv[0] == "image":
            return _completed(0, stdout=b"IMGID")
        if argv[0] == "exec":  # container_mount_healthy probe
            return _completed(0)
        raise AssertionError(f"unexpected docker call: {argv}")

    def test_reuses_healthy_container_without_recreating(self):
        kinds = self._run_ensure(self._running_healthy)
        self.assertEqual(kinds.count("exec"), 1)  # probed the mount
        self.assertNotIn("rm", kinds)  # did NOT drop it
        self.assertNotIn("run", kinds)  # did NOT recreate it
        self.assertTrue(cyberful_os_mcp._mount_verified)

    def test_recreates_when_mount_is_stale(self):
        breakout = b"unable to start container process: current working directory is outside of " \
                   b"container mount namespace root -- possible container breakout detected"

        def responder(argv, **_options):
            if argv[0] == "container":
                return _completed(0, stdout=b"IMGID true")
            if argv[0] == "image":
                return _completed(0, stdout=b"IMGID")
            if argv[0] == "exec":  # stale mount -> runc exit 128
                return _completed(128, stderr=breakout)
            if argv[0] == "rm":
                return _completed(0)
            if argv[0] == "run":
                return _completed(0, stdout=b"freshid")
            raise AssertionError(f"unexpected docker call: {argv}")

        kinds = self._run_ensure(responder)
        self.assertEqual(kinds.count("exec"), 1)  # probed once, found it stale
        self.assertIn("rm", kinds)  # dropped the stale container
        self.assertIn("run", kinds)  # recreated fresh
        self.assertLess(kinds.index("rm"), kinds.index("run"))  # remove BEFORE recreate

    def test_probe_runs_once_per_process(self):
        first = self._run_ensure(self._running_healthy)
        self.assertEqual(first.count("exec"), 1)  # first ensure probes
        second = self._run_ensure(self._running_healthy)  # _mount_verified now latched True
        self.assertEqual(second.count("exec"), 0)  # subsequent ensures skip the probe

    def test_absent_container_creates_without_probing(self):
        def responder(argv, **_options):
            if argv[0] == "container":
                return _completed(1, stderr=b"No such container")  # not found
            if argv[0] == "run":
                return _completed(0, stdout=b"freshid")
            raise AssertionError(f"unexpected docker call: {argv}")

        kinds = self._run_ensure(responder)
        self.assertNotIn("exec", kinds)  # nothing to probe
        self.assertIn("run", kinds)  # created fresh
        self.assertTrue(cyberful_os_mcp._mount_verified)

    def test_failed_creation_removes_the_partial_named_container(self):
        calls = []

        def responder(argv, **_options):
            calls.append(list(argv))
            if argv[0] == "container":
                return _completed(1, stderr=b"No such container")
            if argv[0] == "run":
                return _completed(125, stderr=b"sethostname: invalid argument")
            if argv[0] == "rm":
                return _completed(0)
            raise AssertionError(f"unexpected docker call: {argv}")

        with mock.patch.object(cyberful_os_mcp, "docker", responder):
            with self.assertRaisesRegex(RuntimeError, "sethostname: invalid argument"):
                cyberful_os_mcp.ensure_container(60)

        kinds = [call[0] for call in calls]
        self.assertEqual(kinds[-2:], ["run", "rm"])
        self.assertFalse(cyberful_os_mcp._mount_verified)

    def test_cleanup_failure_retains_the_creation_error_as_its_cause(self):
        def responder(argv, **_options):
            if argv[0] == "container":
                return _completed(1, stderr=b"No such container")
            if argv[0] == "run":
                return _completed(125, stderr=b"sethostname: invalid argument")
            if argv[0] == "rm":
                return _completed(1, stderr=b"daemon cleanup failed")
            raise AssertionError(f"unexpected docker call: {argv}")

        with mock.patch.object(cyberful_os_mcp, "docker", responder):
            with self.assertRaisesRegex(RuntimeError, "daemon cleanup failed") as raised:
                cyberful_os_mcp.ensure_container(60)

        self.assertIsInstance(raised.exception.__cause__, RuntimeError)
        self.assertIn("sethostname: invalid argument", str(raised.exception.__cause__))


if __name__ == "__main__":
    unittest.main()
