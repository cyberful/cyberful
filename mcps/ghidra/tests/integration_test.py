#!/usr/bin/env python3
# ── Dockerized Ghidra Persistence Contract ───────────────────────
# Exercises a native fixture through import, analysis, decompilation, phase bridge
# renewal, and runtime recreation inside the unified engagement image.
# → mcps/cyberful-os/Dockerfile — builds the service and bridge under test.
# @docs/runtimes/ghidra.md
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import json
import os
import platform
import select
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from typing import TextIO

RUNTIME_IMAGE = os.environ.get("CYBERFUL_OS_IMAGE", "cyberful-os:latest")
STARTUP_TIMEOUT = 360
ANALYSIS_TIMEOUT = 600


def run(command: list[str], timeout: int = 60, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=check,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


class McpClient:
    def __init__(self, container: str, key: str) -> None:
        self.closed = False
        self.process = subprocess.Popen(
            [
                "docker",
                "exec",
                "-i",
                "--env",
                f"CYBER_GHIDRA_MCP_KEY={key}",
                container,
                "/opt/cyberful-os-venv/bin/python",
                "/opt/cyberful/ghidra/ghidra_bridge.py",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.identifier = 0
        try:
            self.request(
                "initialize",
                {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "ghidra-integration", "version": "0.1.0"},
                },
            )
            self.notify("notifications/initialized", {})
        except BaseException:
            self.close()
            raise

    def request(self, method: str, params: dict[str, object] | None = None, timeout: int = 30) -> dict[str, object]:
        self.identifier += 1
        payload: dict[str, object] = {"jsonrpc": "2.0", "id": self.identifier, "method": method}
        if params is not None:
            payload["params"] = params
        self._write(payload)
        deadline = time.monotonic() + timeout
        stdout = self._stdout()
        while time.monotonic() < deadline:
            ready, _, _ = select.select([stdout], [], [], min(1, deadline - time.monotonic()))
            if not ready:
                if self.process.poll() is not None:
                    raise RuntimeError(f"Ghidra bridge exited: {self._stderr().read()}")
                continue
            line = stdout.readline()
            if not line:
                raise RuntimeError(f"Ghidra bridge closed stdout: {self._stderr().read()}")
            response = json.loads(line)
            if response.get("id") != self.identifier:
                continue
            if "error" in response:
                raise RuntimeError(f"MCP request failed: {response['error']}")
            result = response.get("result")
            if not isinstance(result, dict):
                raise RuntimeError(f"MCP response result is malformed: {response}")
            return result
        raise TimeoutError(f"MCP request timed out: {method}")

    def notify(self, method: str, params: dict[str, object]) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def tool(self, name: str, arguments: dict[str, object], timeout: int = 30) -> dict[str, object]:
        result = self.request("tools/call", {"name": name, "arguments": arguments}, timeout)
        content = result.get("content")
        if not isinstance(content, list) or not content or not isinstance(content[0], dict):
            raise RuntimeError(f"MCP tool content is malformed: {result}")
        text = content[0].get("text")
        if not isinstance(text, str):
            raise RuntimeError(f"MCP tool text is malformed: {result}")
        payload = json.loads(text)
        if result.get("isError"):
            raise RuntimeError(f"{name} failed: {payload}")
        if not isinstance(payload, dict):
            raise RuntimeError(f"{name} returned a non-object")
        return payload

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        if self.process.stdin and not self.process.stdin.closed:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        finally:
            if self.process.stdout and not self.process.stdout.closed:
                self.process.stdout.close()
            if self.process.stderr and not self.process.stderr.closed:
                self.process.stderr.close()

    def _write(self, value: object) -> None:
        stdin = self.process.stdin
        if stdin is None:
            raise RuntimeError("Ghidra bridge stdin is unavailable")
        stdin.write(json.dumps(value, separators=(",", ":")) + "\n")
        stdin.flush()

    def _stdout(self) -> TextIO:
        if self.process.stdout is None:
            raise RuntimeError("Ghidra bridge stdout is unavailable")
        return self.process.stdout

    def _stderr(self) -> TextIO:
        if self.process.stderr is None:
            raise RuntimeError("Ghidra bridge stderr is unavailable")
        return self.process.stderr


class DockerizedGhidraTests(unittest.TestCase):
    def setUp(self) -> None:
        if shutil.which("docker") is None or shutil.which("cc") is None:
            self.skipTest("Docker and a C compiler are required")
        run(["docker", "version", "--format", "{{.Server.Version}}"])
        self.temporary = tempfile.TemporaryDirectory(prefix="cyberful-ghidra-integration-")
        self.root = Path(self.temporary.name).resolve()
        self.workarea = self.root / "workarea"
        self.store = self.root / "store"
        self.workarea.mkdir(mode=0o700)
        self.store.mkdir(mode=0o700)
        source = self.workarea / "fixture.c"
        source.write_text(
            "static int twice(int value) { return value * 2; }\n"
            "int cyberful_fixture(int value) { return twice(value) + 7; }\n"
            "int main(void) { return cyberful_fixture(4); }\n",
            encoding="utf-8",
        )
        run(["cc", "-g", "-O0", str(source), "-o", str(self.workarea / "fixture")])
        self.runtime_uid = os.getuid() if os.getuid() > 0 else 1000
        self.runtime_gid = os.getgid() if os.getgid() > 0 else 1000
        if os.getuid() == 0:
            for runtime_path in (self.workarea, self.store, source, self.workarea / "fixture"):
                os.chown(runtime_path, self.runtime_uid, self.runtime_gid)
        self.containers: list[str] = []
        self.clients: list[McpClient] = []

    def tearDown(self) -> None:
        for client in self.clients:
            client.close()
        for container in self.containers:
            run(["docker", "rm", "--force", "--volumes", container], check=False)
        self.temporary.cleanup()

    def start_runtime(self, key: str) -> str:
        container = f"cyberful-ghidra-integration-{uuid.uuid4().hex[:8]}"
        run(
            [
                "docker",
                "run",
                "--detach",
                "--name",
                container,
                "--network",
                "none",
                "--mount",
                f"type=bind,source={self.workarea},target=/workspace",
                "--mount",
                f"type=bind,source={self.store},target=/ghidra/store",
                "--env",
                f"CYBER_GHIDRA_MCP_KEY={key}",
                "--env",
                "CYBERFUL_GHIDRA_ENABLED=1",
                "--env",
                "CYBERFUL_ZAP_ENABLED=0",
                "--env",
                f"CYBERFUL_RUNTIME_UID={self.runtime_uid}",
                "--env",
                f"CYBERFUL_RUNTIME_GID={self.runtime_gid}",
                RUNTIME_IMAGE,
            ],
        )
        self.containers.append(container)
        deadline = time.monotonic() + STARTUP_TIMEOUT
        while time.monotonic() < deadline:
            state = run(
                [
                    "docker",
                    "exec",
                    container,
                    "/opt/cyberful-os-venv/bin/python",
                    "/opt/cyberful/ghidra/healthcheck.py",
                ],
                check=False,
            )
            if state.returncode == 0:
                self.assert_runtime_contract(container)
                return container
            running = run(
                ["docker", "inspect", "--format", "{{.State.Running}}", container],
                check=False,
            ).stdout.strip()
            if running != "true":
                logs = run(["docker", "logs", container], check=False).stderr
                raise RuntimeError(f"Ghidra runtime exited during startup: {logs}")
            time.sleep(1)
        logs = run(["docker", "logs", container], check=False).stderr
        raise TimeoutError(f"Ghidra runtime did not become healthy: {logs[-8192:]}")

    def assert_runtime_contract(self, container: str) -> None:
        machine = run(["docker", "exec", container, "uname", "-m"]).stdout.strip()
        normalized = {"arm64": "aarch64", "amd64": "x86_64"}
        self.assertEqual(normalized.get(machine, machine), normalized.get(platform.machine(), platform.machine()))
        decompiler_directory = "linux_arm_64" if machine in {"aarch64", "arm64"} else "linux_x86_64"
        decompiler = f"/usr/share/ghidra/Ghidra/Features/Decompiler/os/{decompiler_directory}/decompile"
        description = run(["docker", "exec", container, "file", decompiler]).stdout
        self.assertIn("ARM aarch64" if machine in {"aarch64", "arm64"} else "x86-64", description)
        self.assertNotEqual(
            run(["docker", "exec", container, "getent", "hosts", "example.com"], check=False).returncode,
            0,
        )
        self.assertNotEqual(
            run(
                ["docker", "exec", container, "curl", "--max-time", "2", "https://example.com"],
                timeout=10,
                check=False,
            ).returncode,
            0,
        )
        deadline = time.monotonic() + 5
        while True:
            status = json.loads(run(["docker", "exec", container, "cat", "/run/cyberful/status.json"]).stdout)
            if status["services"]["ghidra"]["status"] == "ready" or time.monotonic() >= deadline:
                break
            time.sleep(0.1)
        self.assertEqual(status["services"]["ghidra"]["status"], "ready")
        self.assertNotIn("zap", status["services"])

    def client(self, container: str, key: str) -> McpClient:
        client = McpClient(container, key)
        self.clients.append(client)
        return client

    def wait_job(self, client: McpClient, job_id: str) -> dict[str, object]:
        deadline = time.monotonic() + ANALYSIS_TIMEOUT
        while time.monotonic() < deadline:
            job = client.tool("ghidra_job", {"action": "status", "job_id": job_id})
            if job.get("status") == "succeeded":
                return job
            if job.get("status") in {"failed", "cancelled"}:
                raise RuntimeError(f"Ghidra job did not succeed: {job}")
            time.sleep(1)
        raise TimeoutError(f"Ghidra analysis job exceeded {ANALYSIS_TIMEOUT}s")

    def test_project_and_annotations_survive_phase_and_runtime_restarts(self) -> None:
        first_key = uuid.uuid4().hex + uuid.uuid4().hex
        first_container = self.start_runtime(first_key)
        phase_one = self.client(first_container, first_key)
        tools = phase_one.request("tools/list")["tools"]
        self.assertIn("ghidra_decompile", {tool["name"] for tool in tools})

        queued = phase_one.tool("ghidra_import", {"source_path": "fixture", "analyze": True})
        completed = self.wait_job(phase_one, str(queued["job"]["id"]))
        program = str(completed["result"]["program"])
        functions = phase_one.tool(
            "ghidra_search",
            {"program": program, "kind": "functions", "query": "cyberful_fixture", "limit": 20},
        )
        self.assertTrue(functions["items"])
        function = functions["items"][0]
        selector = str(function["entry"])
        decompiled = phase_one.tool("ghidra_decompile", {"program": program, "selector": selector})
        self.assertIn("cyberful_fixture", decompiled["decompiled"])
        graph = phase_one.tool(
            "ghidra_call_graph",
            {"program": program, "root": selector, "depth": 2, "limit": 100},
        )
        self.assertTrue(graph["nodes"])
        phase_one.tool(
            "ghidra_annotations",
            {
                "action": "comment",
                "program": program,
                "selector": selector,
                "value": "persists across Cyberful phases",
                "comment_type": "plate",
            },
        )
        phase_one.close()
        self.clients.remove(phase_one)

        phase_two = self.client(first_container, first_key)
        annotations = phase_two.tool("ghidra_annotations", {"action": "list", "program": program})
        self.assertEqual(annotations["items"][0]["value"], "persists across Cyberful phases")
        phase_two.close()
        self.clients.remove(phase_two)

        run(["docker", "rm", "--force", "--volumes", first_container])
        self.containers.remove(first_container)
        second_key = uuid.uuid4().hex + uuid.uuid4().hex
        second_container = self.start_runtime(second_key)
        resumed = self.client(second_container, second_key)
        projects = resumed.tool("ghidra_project", {"action": "programs"})
        self.assertEqual(projects["programs"][0]["program"], program)
        annotations = resumed.tool("ghidra_annotations", {"action": "list", "program": program})
        self.assertEqual(annotations["items"][0]["value"], "persists across Cyberful phases")
        decompiled_after_restart = resumed.tool(
            "ghidra_decompile",
            {"program": program, "selector": selector},
        )
        self.assertIn("cyberful_fixture", decompiled_after_restart["decompiled"])
        resumed.close()
        self.clients.remove(resumed)

        status = json.loads(
            run(["docker", "exec", second_container, "cat", "/run/cyberful/status.json"]).stdout
        )
        ghidra_pid = int(status["services"]["ghidra"]["pid"])
        run(["docker", "exec", second_container, "kill", "-TERM", str(ghidra_pid)])
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            status = json.loads(
                run(["docker", "exec", second_container, "cat", "/run/cyberful/status.json"]).stdout
            )
            if status["status"] == "degraded":
                break
            time.sleep(0.25)
        self.assertEqual(status["status"], "degraded")
        self.assertEqual(status["services"]["ghidra"]["status"], "exited")
        self.assertEqual(status["services"]["ghidra"]["pid"], ghidra_pid)
        time.sleep(2)
        later = json.loads(
            run(["docker", "exec", second_container, "cat", "/run/cyberful/status.json"]).stdout
        )
        self.assertEqual(later["services"]["ghidra"]["pid"], ghidra_pid)
        self.assertEqual(
            run(["docker", "inspect", "--format", "{{.State.Running}}", second_container]).stdout.strip(),
            "true",
        )
        with self.assertRaises((RuntimeError, TimeoutError)) as failure:
            McpClient(second_container, second_key)
        self.assertRegex(str(failure.exception), "(?:exited|closed|failed|refused|timed out)")


if __name__ == "__main__":
    unittest.main()
