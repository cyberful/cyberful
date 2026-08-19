# ── Authorized SOAP XML Probe Tests ─────────────────────────────
# Exercises SOAP argv construction, runtime proxy routing, literal-loopback
#   isolation, preflight denial, secret redaction, streaming caps, deadline
#   cleanup, and output ownership without contacting an external target.
# → cyberful/builtin/skills/test-soap-xml-services/scripts/run_soap_xml_probe.py — implementation under test.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

from contextlib import redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest.mock import patch
from types import ModuleType


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_soap_xml_probe.py"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("soap_probe", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load SOAP probe")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def campaign(origin: str, *, soap_version: str = "1.1") -> dict[str, object]:
    return {
        "constraints": {
            "authorization_reference": "mission://soap",
            "expires_at": "2099-01-01T00:00:00Z",
            "allowed_origins": [origin],
            "max_requests": 1,
            "requests_per_second": 10,
            "allowed_effects": ["read-only"],
            "actor_id": "tester-a",
            "tenant_id": "tenant-a",
        },
        "cases": [{
            "id": "control",
            "endpoint": f"{origin}/ProfileService",
            "soap_version": soap_version,
            "action": "urn:test:Get",
            "envelope": "<Envelope><Body><Get/></Body></Envelope>",
            "headers": {"X-Test-Case": "control"},
            "effect": "read-only",
            "actor_id": "tester-a",
            "tenant_id": "tenant-a",
        }],
    }


class CountingHandler(BaseHTTPRequestHandler):
    requests = 0
    bodies: list[bytes] = []

    def do_POST(self) -> None:  # noqa: N802
        type(self).requests += 1
        length = int(self.headers.get("Content-Length", "0"))
        type(self).bodies.append(self.rfile.read(length))
        reflected = self.headers.get("Authorization", "ok").encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(reflected)

    def log_message(self, format: str, *arguments: object) -> None:
        return


class TrapHandler(CountingHandler):
    requests = 0


class SoapProbeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()
        CountingHandler.requests = 0
        CountingHandler.bodies = []
        TrapHandler.requests = 0
        TrapHandler.bodies = []

    def _server(self, handler: type[BaseHTTPRequestHandler] = CountingHandler) -> tuple[ThreadingHTTPServer, threading.Thread, str]:
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, thread, f"http://127.0.0.1:{server.server_port}"

    def _forward_helper(self, workspace: Path) -> Path:
        helper = workspace / "soap-forward-fixture.py"
        helper.write_text(textwrap.dedent(f"""\
            #!{sys.executable}
            import os, sys, urllib.request
            body = sys.stdin.buffer.read()
            request = urllib.request.Request(sys.argv[1], data=body, method="POST")
            secret = os.environ.get("{self.module.AUTHORIZATION_ENV}")
            if secret:
                request.add_header("Authorization", secret)
            with urllib.request.urlopen(request, timeout=2) as response:
                sys.stdout.buffer.write(response.read())
        """), encoding="utf-8")
        helper.chmod(0o700)
        return helper

    def _ca_bundle(self, workspace: Path) -> Path:
        bundle = workspace / "runtime-ca.pem"
        bundle.write_text("synthetic runtime CA fixture\n", encoding="utf-8")
        return bundle

    def _forward_command(self, helper: Path):
        def command(case: object, transport: object, secret: str | None, remaining: float) -> list[str]:
            return [sys.executable, str(helper), case.endpoint_url]  # type: ignore[attr-defined]

        return command

    def test_fixed_curl_argv_encodes_soap_versions_and_cannot_be_selected_by_payload(self) -> None:
        for version in ("1.1", "1.2"):
            constraints, cases = self.module._validated(campaign("http://127.0.0.1:8080", soap_version=version))
            command = self.module._build_command(cases[0], self.module._transport(cases[0]), None, 10)
            self.assertEqual(command[0], "curl")
            self.assertEqual(command[1], "--disable")
            self.assertIn("--noproxy", command)
            self.assertEqual(command[command.index("--proto") + 1], "=http,https")
            self.assertEqual(command[command.index("--max-redirs") + 1], "0")
            self.assertEqual(command[command.index("--data-binary") + 1], "@-")
            self.assertNotIn(cases[0].envelope, command)
            rendered = " ".join(command)
            expected = "SOAPAction" if version == "1.1" else "Content-Type: application/soap+xml"
            self.assertIn(expected, rendered)
            self.assertEqual(constraints.max_requests, 1)

    def test_invalid_and_docker_hostnames_route_through_synthetic_runtime_proxy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            helper = self._forward_helper(workspace)
            bundle = self._ca_bundle(workspace)
            server, thread, proxy = self._server()
            try:
                for index, origin in enumerate(("http://soap-target.invalid:8080", "http://soap-service:8080")):
                    environment = {"HTTP_PROXY": proxy, "SSL_CERT_FILE": str(bundle)}
                    with self.subTest(origin=origin), patch.dict(os.environ, environment, clear=True), patch.object(self.module, "_build_command", side_effect=self._forward_command(helper)):
                        report = self.module.run_probe(campaign(origin), str(index) * 64, deadline_seconds=3)
                    self.assertEqual(report["executions"][0]["exit_code"], 0)
                    self.assertEqual(report["transport"]["proxy_environment"], ["HTTP_PROXY"])
                self.assertEqual(CountingHandler.requests, 2)
                self.assertEqual(CountingHandler.bodies, [b"<Envelope><Body><Get/></Body></Envelope>"] * 2)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_docker_runtime_proxy_is_accepted_and_missing_ca_fails_before_process(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            bundle = self._ca_bundle(Path(directory))
            _, cases = self.module._validated(campaign("http://soap-service:8080"))
            environment = {"HTTP_PROXY": "http://cyberful-zap:8080", "SSL_CERT_FILE": str(bundle)}
            with patch.dict(os.environ, environment, clear=True):
                transport = self.module._transport(cases[0])
            self.assertEqual(transport.proxy, "http://cyberful-zap:8080")
            with patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:8080"}, clear=True), patch.object(self.module, "_build_command") as build:
                with self.assertRaisesRegex(self.module.ProbeError, "runtime CA bundle"):
                    self.module.run_probe(campaign("http://soap-service:8080"), "f" * 64)
                build.assert_not_called()

    def test_literal_loopback_is_direct_and_skips_proxy_trap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            helper = self._forward_helper(workspace)
            target, target_thread, origin = self._server()
            trap, trap_thread, proxy = self._server(TrapHandler)
            try:
                with patch.dict(os.environ, {"HTTP_PROXY": proxy}, clear=True), patch.object(self.module, "_build_command", side_effect=self._forward_command(helper)):
                    report = self.module.run_probe(campaign(origin), "a" * 64, deadline_seconds=3)
                self.assertEqual(CountingHandler.requests, 1)
                self.assertEqual(TrapHandler.requests, 0)
                self.assertEqual(report["transport"]["proxy_environment"], [])
            finally:
                target.shutdown()
                target.server_close()
                target_thread.join(timeout=2)
                trap.shutdown()
                trap.server_close()
                trap_thread.join(timeout=2)

    def test_missing_route_and_payload_transport_controls_refuse_before_process(self) -> None:
        origin = "http://soap-target.invalid:8080"
        payloads = [campaign(origin)]
        for field in ("proxy", "ca_file", "confirmed"):
            invalid = campaign(origin)
            invalid["constraints"][field] = True  # type: ignore[index]
            payloads.append(invalid)
        for index, payload in enumerate(payloads):
            expected = "runtime route" if index == 0 else "constraints are malformed"
            with self.subTest(index=index), patch.dict(os.environ, {}, clear=True), patch.object(self.module, "_build_command") as build:
                with self.assertRaisesRegex(self.module.ProbeError, expected):
                    self.module.run_probe(payload, "b" * 64, deadline_seconds=1)
                build.assert_not_called()

    def test_secret_is_redacted_and_only_environment_name_and_digest_are_retained(self) -> None:
        secret = "soap-environment-secret"
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            helper = self._forward_helper(workspace)
            bundle = self._ca_bundle(workspace)
            server, thread, proxy = self._server()
            try:
                origin = "http://soap-target.invalid:8080"
                environment = {"HTTP_PROXY": proxy, "SSL_CERT_FILE": str(bundle), self.module.AUTHORIZATION_ENV: secret}
                with patch.dict(os.environ, environment, clear=True), patch.object(self.module, "_build_command", side_effect=self._forward_command(helper)):
                    report = self.module.run_probe(campaign(origin), "c" * 64, deadline_seconds=3)
                rendered = json.dumps(report)
                self.assertNotIn(secret, rendered)
                authorization = report["executions"][0]["environment"]["authorization"]
                self.assertEqual(authorization["environment"], self.module.AUTHORIZATION_ENV)
                self.assertEqual(len(authorization["sha256"]), 64)
                constraints, cases = self.module._validated(campaign("http://127.0.0.1:8080"))
                with patch.dict(os.environ, {}, clear=True):
                    command = self.module._build_command(cases[0], self.module._transport(cases[0]), secret, 10)
                self.assertNotIn(secret, " ".join(command))
                self.assertIn("Authorization: {{" + self.module.AUTHORIZATION_ENV + "}}", command)
                self.assertEqual(constraints.max_requests, 1)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_action_headers_and_secret_reject_controls_before_process(self) -> None:
        payloads = []
        action = campaign("http://127.0.0.1:8080")
        action["cases"][0]["action"] = "urn:test\r\nX-Leak: yes"  # type: ignore[index]
        payloads.append(action)
        header = campaign("http://127.0.0.1:8080")
        header["cases"][0]["headers"] = {"X-Test": "ok\nAuthorization: leak"}  # type: ignore[index]
        payloads.append(header)
        for payload in payloads:
            with self.subTest(payload=payload), patch.object(self.module, "_build_command") as build:
                with self.assertRaisesRegex(self.module.ProbeError, "control characters"):
                    self.module.run_probe(payload, "1" * 64)
                build.assert_not_called()
        with patch.dict(os.environ, {self.module.AUTHORIZATION_ENV: "bad\r\nsecret"}, clear=True), patch.object(self.module, "_build_command") as build:
            with self.assertRaisesRegex(self.module.ProbeError, "bounded non-empty secret"):
                self.module.run_probe(campaign("http://127.0.0.1:8080"), "2" * 64)
            build.assert_not_called()

    def test_output_cap_kills_noisy_child_before_retaining_excess(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            helper = workspace / "noisy.py"
            helper.write_text("import sys, time\nsys.stdout.write('x' * 1000000)\nsys.stdout.flush()\ntime.sleep(30)\n", encoding="utf-8")
            with patch.dict(os.environ, {}, clear=True), patch.object(self.module, "_build_command", return_value=[sys.executable, str(helper)]):
                with self.assertRaisesRegex(self.module.ProbeError, "output boundary|budget"):
                    self.module.run_probe(campaign("http://127.0.0.1:8080"), "d" * 64, deadline_seconds=3, evidence_limit_bytes=8192)

    def test_global_deadline_terminates_leader_and_descendant(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            pid_file = workspace / "pids"
            helper = workspace / "slow.py"
            helper.write_text(textwrap.dedent(f"""\
                import os, pathlib, signal, subprocess, sys, time
                child = subprocess.Popen([sys.executable, "-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"])
                pathlib.Path({str(pid_file)!r}).write_text(f"{{os.getpid()}} {{child.pid}}", encoding="utf-8")
                def stop(signum, frame):
                    raise SystemExit(0)
                signal.signal(signal.SIGTERM, stop)
                time.sleep(30)
            """), encoding="utf-8")
            with patch.dict(os.environ, {}, clear=True), patch.object(self.module, "_build_command", return_value=[sys.executable, str(helper)]):
                with self.assertRaisesRegex(self.module.ProbeError, "global deadline"):
                    self.module.run_probe(campaign("http://127.0.0.1:8080"), "e" * 64, deadline_seconds=0.6)
            leader, descendant = (int(value) for value in pid_file.read_text(encoding="utf-8").split())
            for process_id in (leader, descendant):
                until = time.monotonic() + 2
                while True:
                    try:
                        os.kill(process_id, 0)
                    except ProcessLookupError:
                        break
                    if time.monotonic() >= until:
                        self.fail(f"process {process_id} survived process-group cleanup")
                    time.sleep(0.02)

    def test_expired_writer_deadline_creates_no_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "late.json"
            with self.assertRaisesRegex(self.module.ProbeError, "global deadline"):
                self.module._write(destination, {"value": True}, time.monotonic() - 1)
            self.assertFalse(destination.exists())

    def test_cli_refuses_output_collision_without_starting_tool(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "request.json").write_text(json.dumps(campaign("http://127.0.0.1:8080")), encoding="utf-8")
            (workspace / "evidence.json").write_text("preserve", encoding="utf-8")
            with redirect_stderr(io.StringIO()), patch.object(self.module, "_build_command") as build:
                result = self.module.main(["--workspace", directory, "--input", "request.json", "--output", "evidence.json"])
            self.assertEqual(result, 2)
            self.assertEqual((workspace / "evidence.json").read_text(encoding="utf-8"), "preserve")
            build.assert_not_called()


if __name__ == "__main__":
    unittest.main()
