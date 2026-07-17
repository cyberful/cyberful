# ── cyberful-os Protocol Boundary Contract ──────────────────────────────
# Verifies terminal output sanitization, Docker endpoint precedence, and MCP
# argument validation keep ordinary tool calls readable and correctly scoped.
# → mcps/cyberful-os/cyberful_os_mcp.py — owns the protocol and execution boundaries.
# → mcps/cyberful-os/scripts/container_ctl.py — mirrors Docker endpoint selection.
# ─────────────────────────────────────────────────────────────────────

import importlib.util
import io
import os
import pathlib
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cyberful_os_mcp", ROOT / "cyberful_os_mcp.py")
cyberful_os_mcp = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = cyberful_os_mcp
SPEC.loader.exec_module(cyberful_os_mcp)

CTL_SPEC = importlib.util.spec_from_file_location("container_ctl", ROOT / "scripts" / "container_ctl.py")
container_ctl = importlib.util.module_from_spec(CTL_SPEC)
assert CTL_SPEC.loader is not None
sys.modules[CTL_SPEC.name] = container_ctl
CTL_SPEC.loader.exec_module(container_ctl)


# ── Tests Pin The Boundary Notes To Behavior ──────────────────────────
# The source files document sanitization, Docker endpoint precedence, and MCP
# argument-shape validation. Each test drives the real boundary function with
# representative input, keeping those claims executable instead of leaving them
# as unchecked prose that can drift from user-visible behavior.
# ──────────────────────────────────────────────────────────────────────

class OutputSanitizerTest(unittest.TestCase):
    def test_strips_terminal_controls(self) -> None:
        dirty = "\x1b[1mhttp://example.com\x1b[0m\rprogress\x08done\tok\x1b]0;title\x07"
        self.assertEqual(cyberful_os_mcp.sanitize_terminal_text(dirty), "http://example.com\nprogressdone\tok")

    def test_result_from_run_formats_plain_text(self) -> None:
        result = cyberful_os_mcp.result_from_run(
            cyberful_os_mcp.CommandResult(
                target="cyberful-os",
                command="whatweb",
                exit_code=0,
                timed_out=False,
                duration_ms=10,
                stdout="\x1b[32mok\x1b[0m\rnext",
                stderr="\x1b[31mWARN\x1b[0m",
                truncated=False,
            )
        )

        text = result["content"][0]["text"]
        self.assertFalse(result["isError"])
        self.assertNotIn("\x1b", text)
        self.assertIn("ok\nnext", text)
        self.assertIn("WARN", text)

    def test_result_from_run_omits_empty_stderr(self) -> None:
        result = cyberful_os_mcp.result_from_run(
            cyberful_os_mcp.CommandResult(
                target="cyberful-os",
                command="true",
                exit_code=0,
                timed_out=False,
                duration_ms=2,
                stdout="ok",
                stderr="",
                truncated=False,
            )
        )

        text = result["content"][0]["text"]
        self.assertIn("stdout:\nok", text)
        self.assertNotIn("stderr:", text)


class DockerEnvironmentTest(unittest.TestCase):
    def test_preserves_existing_docker_context(self) -> None:
        for module in (cyberful_os_mcp, container_ctl):
            with self.subTest(module=module.__name__):
                with tempfile.TemporaryDirectory() as tmp:
                    home = pathlib.Path(tmp)
                    docker_dir = home / ".docker"
                    run_dir = docker_dir / "run"
                    run_dir.mkdir(parents=True)
                    (run_dir / "docker.sock").touch()
                    (docker_dir / "config.json").write_text('{"currentContext":"desktop-linux"}\n', encoding="utf-8")

                    with mock.patch.dict(os.environ, {"HOME": str(home)}, clear=True):
                        next_env = module.docker_environment()

                    self.assertNotIn("DOCKER_CONFIG", next_env)
                    self.assertNotIn("DOCKER_HOST", next_env)

    def test_uses_desktop_socket_when_no_context_is_configured(self) -> None:
        for module in (cyberful_os_mcp, container_ctl):
            with self.subTest(module=module.__name__):
                with tempfile.TemporaryDirectory() as tmp:
                    home = pathlib.Path(tmp)
                    run_dir = home / ".docker" / "run"
                    run_dir.mkdir(parents=True)
                    (run_dir / "docker.sock").touch()

                    with mock.patch.dict(os.environ, {"HOME": str(home)}, clear=True):
                        next_env = module.docker_environment()

                    self.assertEqual(next_env.get("DOCKER_HOST"), f"unix://{run_dir / 'docker.sock'}")
                    self.assertNotIn("DOCKER_CONFIG", next_env)

    def test_explicit_cyberful_os_docker_config_is_created(self) -> None:
        for module in (cyberful_os_mcp, container_ctl):
            with self.subTest(module=module.__name__):
                with tempfile.TemporaryDirectory() as tmp:
                    root = pathlib.Path(tmp)
                    docker_config = root / "isolated-docker-config"

                    with mock.patch.dict(
                        os.environ,
                        {"HOME": str(root / "home"), "CYBERFUL_OS_DOCKER_CONFIG": str(docker_config)},
                        clear=True,
                    ):
                        next_env = module.docker_environment()

                    self.assertEqual(next_env.get("DOCKER_CONFIG"), str(docker_config))
                    self.assertTrue((docker_config / "config.json").exists())

    def test_rejects_malformed_docker_configuration_instead_of_switching_endpoints(self) -> None:
        for module in (cyberful_os_mcp, container_ctl):
            with self.subTest(module=module.__name__):
                with tempfile.TemporaryDirectory() as tmp:
                    home = pathlib.Path(tmp)
                    docker_dir = home / ".docker"
                    docker_dir.mkdir()
                    (docker_dir / "config.json").write_text("{broken", encoding="utf-8")

                    with mock.patch.dict(os.environ, {"HOME": str(home)}, clear=True):
                        with self.assertRaisesRegex(ValueError, "invalid JSON"):
                            module.docker_environment()


class ContainerControlProcessTest(unittest.TestCase):
    def test_lifecycle_commands_have_a_bounded_process_owner(self) -> None:
        completed = container_ctl.subprocess.CompletedProcess(["docker", "ps"], 0)
        with mock.patch.object(container_ctl, "docker_environment", return_value={"PATH": "/usr/bin"}), mock.patch.object(
            container_ctl.subprocess, "run", return_value=completed
        ) as run, redirect_stderr(io.StringIO()):
            exit_code = container_ctl.run(["docker", "ps"])

        self.assertEqual(exit_code, 0)
        run.assert_called_once_with(
            ["docker", "ps"],
            env={"PATH": "/usr/bin"},
            stdin=None,
            stdout=None,
            stderr=None,
            timeout=120,
            check=False,
            shell=False,
            text=False,
        )

    def test_lifecycle_timeout_returns_a_shell_compatible_status(self) -> None:
        timeout = container_ctl.subprocess.TimeoutExpired(["docker", "pull"], 120)
        with mock.patch.object(container_ctl, "docker_environment", return_value={}), mock.patch.object(
            container_ctl.subprocess, "run", side_effect=timeout
        ), redirect_stderr(io.StringIO()):
            exit_code = container_ctl.run(["docker", "pull", "image"])

        self.assertEqual(exit_code, 124)

    def test_failed_start_removes_its_partial_named_container(self) -> None:
        with mock.patch.object(container_ctl, "run", side_effect=[125, 0]) as run, redirect_stderr(io.StringIO()):
            exit_code = container_ctl.run_container_start(
                ["docker", "run", "-d", "--name", "cyberful-os-test", "image"],
                "cyberful-os-test",
            )

        self.assertEqual(exit_code, 125)
        self.assertEqual(
            [call.args[0] for call in run.call_args_list],
            [
                ["docker", "run", "-d", "--name", "cyberful-os-test", "image"],
                ["docker", "rm", "-f", "cyberful-os-test"],
            ],
        )

    def test_cleanup_failure_does_not_replace_the_start_exit_code(self) -> None:
        diagnostics = io.StringIO()
        with mock.patch.object(container_ctl, "run", side_effect=[125, 1]), redirect_stderr(diagnostics):
            exit_code = container_ctl.run_container_start(
                ["docker", "start", "cyberful-os-test"],
                "cyberful-os-test",
            )

        self.assertEqual(exit_code, 125)
        self.assertIn("cleanup also exited with status 1", diagnostics.getvalue())


class ToolCallValidationTest(unittest.TestCase):
    def test_tool_arguments_must_be_an_object(self) -> None:
        result = cyberful_os_mcp.handle_tool_call({"name": "shell", "arguments": "echo nope"})

        self.assertTrue(result["isError"])
        self.assertIn("tool arguments must be an object", result["content"][0]["text"])

    def test_shell_command_is_required(self) -> None:
        result = cyberful_os_mcp.handle_tool_call({"name": "shell", "arguments": {}})

        self.assertTrue(result["isError"])
        self.assertIn("`command` must be a non-empty string", result["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
