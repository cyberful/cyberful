# ── Authorization Campaign Runner Tests ─────────────────────────
# Exercises preflight authority and request limits, bounded process cleanup,
#   and a real authorized loopback request without contacting an external host.
# → cyberful/builtin/skills/test-authorization-boundaries/scripts/run_authorization_campaign.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from types import ModuleType
from typing import Any


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "run_authorization_campaign.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("run_authorization_campaign", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load authorization campaign runner")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


class RecordingHandler(BaseHTTPRequestHandler):
    requests: list[tuple[str, str]] = []
    secrets: list[str] = []

    def do_GET(self) -> None:
        self.__class__.requests.append((self.path, self.headers.get("X-Cyberful-Case", "")))
        secret = self.headers.get("Authorization", "")
        self.__class__.secrets.append(secret)
        body = json.dumps({"synthetic": "owner-control", "echo": secret}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        if secret:
            self.send_header("X-Echo-Authorization", secret)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


class ProxyTrapHandler(BaseHTTPRequestHandler):
    requests: int = 0

    def do_GET(self) -> None:
        self.__class__.requests += 1
        self.send_response(502)
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        return


def campaign(origin: str, *, allowed_origin: str | None = None, max_requests: int = 1, cases: int = 1, rate: float = 4) -> dict[str, Any]:
    entries = []
    for index in range(cases):
        entries.append({
            "case_id": f"case-{index}",
            "actor": "controlled-user",
            "tenant": "tenant-a",
            "resource": f"project-{index}",
            "action": "read",
            "expected_policy": "allow",
            "method": "GET",
            "url": f"{origin}/objects/{index}",
            "headers": {"X-Cyberful-Case": f"case-{index}"},
            "secret_headers": {},
            "body_base64": "",
        })
    return {
        "$schema": "./authorization-campaign.schema.json",
        "campaign_id": "loopback-campaign",
        "authority": {
            "authorization_reference": "synthetic-loopback-test",
            "allowed_origins": [allowed_origin or origin],
            "max_requests": max_requests,
            "requests_per_second": rate,
            "request_timeout_seconds": 3,
        },
        "cases": entries,
    }


class AuthorizationCampaignTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()
        RecordingHandler.requests = []
        RecordingHandler.secrets = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def _run_cli(self, payload: dict[str, Any]) -> tuple[subprocess.CompletedProcess[str], dict[str, Any] | None]:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "campaign.json").write_text(json.dumps(payload), encoding="utf-8")
            process = subprocess.run(
                [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "campaign.json", "--output", "evidence.json"],
                check=False,
                capture_output=True,
                text=True,
                timeout=10,
            )
            evidence_path = workspace / "evidence.json"
            evidence = json.loads(evidence_path.read_text(encoding="utf-8")) if evidence_path.exists() else None
            return process, evidence

    def test_authorized_loopback_probe_preserves_bounded_raw_evidence(self) -> None:
        process, evidence = self._run_cli(campaign(self.origin))

        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertIsNotNone(evidence)
        assert evidence is not None
        self.assertEqual(RecordingHandler.requests, [("/objects/0", "case-0")])
        self.assertEqual(evidence["cases"][0]["transport"]["http_status"], 200)
        self.assertEqual(evidence["cases"][0]["transport"]["route"], "direct-loopback")
        self.assertFalse(evidence["cases"][0]["response"]["body_truncated"])
        self.assertNotIn("vulnerability", json.dumps(evidence["cases"][0]).lower())

    def test_authority_and_request_limits_reject_before_network(self) -> None:
        wrong_origin = f"http://127.0.0.1:{self.server.server_port + 1}"
        authority_process, authority_evidence = self._run_cli(campaign(self.origin, allowed_origin=wrong_origin))
        self.assertEqual(authority_process.returncode, 2)
        self.assertIsNone(authority_evidence)
        self.assertIn("outside authority.allowed_origins", authority_process.stderr)

        path_process, path_evidence = self._run_cli(campaign(self.origin, allowed_origin=f"{self.origin}/narrow"))
        self.assertEqual(path_process.returncode, 2)
        self.assertIsNone(path_evidence)
        self.assertIn("without path or query", path_process.stderr)

        limit_process, limit_evidence = self._run_cli(campaign(self.origin, max_requests=1, cases=2))
        self.assertEqual(limit_process.returncode, 2)
        self.assertIsNone(limit_evidence)
        self.assertIn("must not exceed", limit_process.stderr)

        localhost_process, localhost_evidence = self._run_cli(campaign(f"http://localhost:{self.server.server_port}"))
        self.assertEqual(localhost_process.returncode, 2)
        self.assertIsNone(localhost_evidence)
        self.assertIn("literal loopback IP", localhost_process.stderr)
        self.assertEqual(RecordingHandler.requests, [])

    def test_json_cannot_select_transport_or_declare_authority(self) -> None:
        for name, value in (("confirmed", True), ("proxy_url", "http://127.0.0.1:8080"), ("ca_bundle", "ca.pem")):
            payload = campaign(self.origin)
            payload["authority"][name] = value
            process, evidence = self._run_cli(payload)
            self.assertEqual(process.returncode, 2)
            self.assertIsNone(evidence)
            self.assertIn("unknown fields", process.stderr)
        self.assertEqual(RecordingHandler.requests, [])

    def test_runtime_route_accepts_docker_hostname_and_no_route_refuses_zero_connection(self) -> None:
        payload = campaign("http://target.example.invalid:80", allowed_origin="http://target.example.invalid:80")
        with tempfile.TemporaryDirectory() as directory:
            ca_bundle = Path(directory) / "runtime-ca.pem"
            ca_bundle.write_text("synthetic runtime trust", encoding="utf-8")
            _, _, cases = self.module._campaign(payload, Path(directory))
            with patch.dict(os.environ, {"HTTP_PROXY": "http://cyberful-os.invalid:8080", "CURL_CA_BUNDLE": str(ca_bundle)}, clear=True):
                route = self.module._runtime_route(cases)
            self.assertEqual(route.http_proxy, "http://cyberful-os.invalid:8080")
            with patch.dict(os.environ, {}, clear=True), patch.object(self.module, "_execute_case") as execute:
                with self.assertRaisesRegex(self.module.CampaignError, "host-provided HTTP_PROXY"):
                    self.module.run_campaign(payload, Path(directory), "synthetic-sha")
                execute.assert_not_called()
            with patch.dict(os.environ, {"HTTP_PROXY": "http://cyberful-os.invalid:8080"}, clear=True), patch.object(self.module, "_execute_case") as execute:
                with self.assertRaisesRegex(self.module.CampaignError, "CA_BUNDLE or SSL_CERT_FILE"):
                    self.module.run_campaign(payload, Path(directory), "synthetic-sha")
                execute.assert_not_called()
        self.assertEqual(RecordingHandler.requests, [])

    def test_loopback_disables_host_proxy_trap(self) -> None:
        ProxyTrapHandler.requests = 0
        trap = ThreadingHTTPServer(("127.0.0.1", 0), ProxyTrapHandler)
        thread = threading.Thread(target=trap.serve_forever, daemon=True)
        thread.start()
        try:
            proxy = f"http://127.0.0.1:{trap.server_port}"
            with patch.dict(os.environ, {"HTTP_PROXY": proxy, "HTTPS_PROXY": proxy}, clear=False):
                process, evidence = self._run_cli(campaign(self.origin))
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertIsNotNone(evidence)
            self.assertEqual(ProxyTrapHandler.requests, 0)
            self.assertEqual(RecordingHandler.requests, [("/objects/0", "case-0")])
        finally:
            trap.shutdown()
            trap.server_close()
            thread.join(timeout=2)

    def test_sensitive_and_declared_secret_headers_reject_before_network(self) -> None:
        for name in ("Authorization", "Cookie", "Proxy-Authorization"):
            payload = campaign(self.origin)
            payload["cases"][0]["headers"] = {name: "inline-secret"}
            process, evidence = self._run_cli(payload)
            self.assertEqual(process.returncode, 2)
            self.assertIsNone(evidence)
            self.assertIn("forbidden header", process.stderr)
        payload = campaign(self.origin)
        payload["cases"][0]["headers"] = {"X-Api-Key": "inline-secret"}
        payload["cases"][0]["secret_headers"] = {"X-Api-Key": "CYBERFUL_PROBE_AUTHORIZATION"}
        with patch.dict(os.environ, {"CYBERFUL_PROBE_AUTHORIZATION": "environment-secret"}, clear=False):
            process, evidence = self._run_cli(payload)
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        self.assertEqual(RecordingHandler.requests, [])

    def test_secret_is_resolved_after_preflight_and_redacted_from_evidence(self) -> None:
        payload = campaign(self.origin)
        payload["cases"][0]["secret_headers"] = {"Authorization": "CYBERFUL_PROBE_AUTHORIZATION"}
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"CYBERFUL_PROBE_AUTHORIZATION": ""}, clear=False):
            _, _, cases = self.module._campaign(payload, Path(directory))
            with self.assertRaisesRegex(self.module.CampaignError, "absent or invalid"):
                self.module._resolved_secrets(cases)
        secret = "environment-only-secret"
        with patch.dict(os.environ, {"CYBERFUL_PROBE_AUTHORIZATION": secret}, clear=False):
            process, evidence = self._run_cli(payload)
        self.assertEqual(process.returncode, 0, process.stderr)
        assert evidence is not None
        self.assertEqual(RecordingHandler.secrets, [secret])
        self.assertNotIn(secret, json.dumps(evidence))
        self.assertEqual(evidence["cases"][0]["response"]["headers_redactions"], 1)
        self.assertEqual(evidence["cases"][0]["response"]["body_redactions"], 1)

    def test_output_limit_terminates_process_during_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            capture = Path(directory) / "body.bin"
            program = "import pathlib,sys,time; stream=pathlib.Path(sys.argv[1]).open('wb', buffering=0); [(stream.write(b'x'*64), time.sleep(.01)) for _ in range(1000)]"
            result = self.module._run_process(
                [sys.executable, "-c", program, str(capture)],
                5,
                monitored_files=((capture, 256, "response body"),),
            )
            self.assertLessEqual(capture.stat().st_size, 256)
        self.assertEqual(result.limit_exceeded, "response body")
        self.assertNotEqual(result.return_code, 0)

    def test_stdout_limit_terminates_process_during_execution(self) -> None:
        program = "import sys,time; sys.stdout.buffer.write(b'x'*8192); sys.stdout.flush(); time.sleep(30)"
        result = self.module._run_process([sys.executable, "-c", program], 5)
        self.assertEqual(result.limit_exceeded, "stdout")
        self.assertEqual(len(result.stdout), self.module.MAX_STDOUT_BYTES)
        self.assertNotEqual(result.return_code, 0)

    def test_timed_out_process_group_reaps_real_descendant(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            pid_path = Path(directory) / "descendant.pid"
            heartbeat = Path(directory) / "heartbeat.bin"
            child = "import pathlib,sys,time; stream=pathlib.Path(sys.argv[1]).open('ab', buffering=0); [(stream.write(b'x'), time.sleep(.01)) for _ in range(3000)]"
            parent = "import pathlib,subprocess,sys,time; child=subprocess.Popen([sys.executable,'-c',sys.argv[3],sys.argv[2]]); pathlib.Path(sys.argv[1]).write_text(str(child.pid)); time.sleep(30)"
            result = self.module._run_process([sys.executable, "-c", parent, str(pid_path), str(heartbeat), child], 0.2)
            descendant_pid = int(pid_path.read_text(encoding="utf-8"))
            size_after_cleanup = heartbeat.stat().st_size
            time.sleep(0.15)
            self.assertEqual(heartbeat.stat().st_size, size_after_cleanup)
            deadline = time.monotonic() + 2
            alive = True
            while alive and time.monotonic() < deadline:
                try:
                    os.kill(descendant_pid, 0)
                except ProcessLookupError:
                    alive = False
                else:
                    time.sleep(0.02)

        self.assertTrue(result.timed_out)
        self.assertNotEqual(result.return_code, 0)
        self.assertFalse(alive, "descendant survived process-group cleanup")

    def test_campaign_deadline_is_cumulative(self) -> None:
        payload = campaign(self.origin, max_requests=2, cases=2, rate=0.1)
        with patch.object(self.module, "CAMPAIGN_TIMEOUT_SECONDS", 0.5):
            with self.assertRaisesRegex(self.module.CampaignError, "deadline"):
                self.module.run_campaign(payload, Path.cwd(), "synthetic-sha")
        self.assertEqual(len(RecordingHandler.requests), 1)

    def test_child_environment_is_allowlisted_and_forces_no_telemetry(self) -> None:
        with patch.dict(os.environ, {"SSH_AUTH_SOCK": "/secret/socket", "HTTP_PROXY": "http://127.0.0.1:8080", "DO_NOT_TRACK": "0", "CYBERFUL_PROBE_AUTHORIZATION": "secret"}, clear=False):
            environment = self.module._process_environment()
        self.assertNotIn("SSH_AUTH_SOCK", environment)
        self.assertNotIn("CYBERFUL_PROBE_AUTHORIZATION", environment)
        self.assertNotIn("HTTP_PROXY", environment)
        self.assertEqual(environment["DO_NOT_TRACK"], "1")


if __name__ == "__main__":
    unittest.main()
