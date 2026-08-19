# ── Workload Identity Probe Tests ────────────────────────────────
# Exercises a real authorized loopback request, complete preflight refusal,
#   secret redaction, bounded cleanup, and child-environment isolation.
# → cyberful/builtin/skills/test-service-workload-identity/scripts/run_workload_identity_probe.py — implementation.
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
SCRIPT = SKILL_ROOT / "scripts" / "run_workload_identity_probe.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("run_workload_identity_probe", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load workload identity probe")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


class RecordingHandler(BaseHTTPRequestHandler):
    requests: list[tuple[str, str]] = []
    secrets: list[str] = []

    def do_GET(self) -> None:
        secret = self.headers.get("Authorization", "")
        self.__class__.requests.append((self.path, self.headers.get("X-Cyberful-Case", "")))
        self.__class__.secrets.append(secret)
        body = json.dumps({"synthetic": True, "echo": secret}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("X-Echo-Authorization", secret)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


class SyntheticProxyHandler(BaseHTTPRequestHandler):
    requests: list[tuple[str, str]] = []

    def do_GET(self) -> None:
        self.__class__.requests.append((self.path, self.headers.get("X-Cyberful-Case", "")))
        body = json.dumps({"synthetic_proxy": True, "target": self.path}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


def campaign(origin: str, *, allowed_origin: str | None = None, cases: int = 1, maximum: int = 1) -> dict[str, Any]:
    return {
        "$schema": "https://cyberful.local/schemas/workload-identity-probe.v1.json",
        "campaign_id": "synthetic-workload",
        "authority": {
            "authorization_reference": "synthetic-test-scope",
            "allowed_origins": [allowed_origin or origin],
            "max_requests": maximum,
            "requests_per_second": 4,
            "request_timeout_seconds": 3,
            "campaign_timeout_seconds": 10,
        },
        "cases": [
            {
                "case_id": f"case-{index}",
                "workload": "controlled-worker",
                "issuer": "https://issuer.test",
                "subject": "workload-a",
                "audience": "service-a",
                "tenant": "tenant-a",
                "expected_binding": "accept",
                "method": "GET",
                "url": f"{origin}/workload/{index}",
                "headers": {"X-Cyberful-Case": f"case-{index}"},
                "secret_headers": {"Authorization": "CYBERFUL_WORKLOAD_AUTHORIZATION"},
                "body_base64": "",
            }
            for index in range(cases)
        ],
    }


class WorkloadIdentityProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.module = load_script()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"
        cls.proxy = ThreadingHTTPServer(("127.0.0.1", 0), SyntheticProxyHandler)
        cls.proxy_thread = threading.Thread(target=cls.proxy.serve_forever, daemon=True)
        cls.proxy_thread.start()
        cls.proxy_origin = f"http://127.0.0.1:{cls.proxy.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.proxy.shutdown()
        cls.proxy.server_close()
        cls.proxy_thread.join(timeout=2)

    def setUp(self) -> None:
        RecordingHandler.requests = []
        RecordingHandler.secrets = []
        SyntheticProxyHandler.requests = []

    def _run_cli(self, payload: dict[str, Any], *, secret: str = "environment-only-secret", routes: dict[str, str] | None = None) -> tuple[subprocess.CompletedProcess[str], dict[str, Any] | None]:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "probe.json").write_text(json.dumps(payload), encoding="utf-8")
            environment = dict(os.environ)
            for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE"):
                environment.pop(name, None)
            environment.update(routes or {})
            environment["CYBERFUL_WORKLOAD_AUTHORIZATION"] = secret
            process = subprocess.run(
                [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "probe.json", "--output", "evidence.json"],
                check=False,
                capture_output=True,
                text=True,
                timeout=15,
                env=environment,
            )
            output = workspace / "evidence.json"
            return process, json.loads(output.read_text(encoding="utf-8")) if output.exists() else None

    def test_authorized_loopback_probe_preserves_redacted_raw_evidence(self) -> None:
        secret = "environment-only-secret"
        process, evidence = self._run_cli(campaign(self.origin), secret=secret, routes={"HTTP_PROXY": self.proxy_origin})
        self.assertEqual(process.returncode, 0, process.stderr)
        assert evidence is not None
        self.assertEqual(RecordingHandler.requests, [("/workload/0", "case-0")])
        self.assertEqual(evidence["cases"][0]["transport"]["http_status"], 200)
        self.assertIn("curl ", evidence["tool"]["version"])
        self.assertNotIn(secret, json.dumps(evidence))
        self.assertGreater(evidence["cases"][0]["response"]["body_redactions"], 0)
        self.assertEqual(SyntheticProxyHandler.requests, [], "loopback request unexpectedly reached the inherited proxy")

    def test_authority_and_limits_refuse_before_any_connection(self) -> None:
        wrong_origin = f"http://127.0.0.1:{self.server.server_port + 1}"
        process, evidence = self._run_cli(campaign(self.origin, allowed_origin=wrong_origin))
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        self.assertEqual(RecordingHandler.requests, [])

    def test_hostname_loopback_alias_refuses_before_any_connection(self) -> None:
        hostname_origin = f"http://localhost:{self.server.server_port}"
        process, evidence = self._run_cli(campaign(hostname_origin))
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        self.assertIn("no mission-bound HTTP_PROXY route", process.stderr)
        self.assertEqual(RecordingHandler.requests, [])

    def test_non_loopback_target_refuses_without_runtime_route(self) -> None:
        external_origin = "http://workload.invalid:80"
        process, evidence = self._run_cli(campaign(external_origin))
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        self.assertIn("no mission-bound HTTP_PROXY route", process.stderr)
        self.assertEqual(RecordingHandler.requests, [])
        self.assertEqual(SyntheticProxyHandler.requests, [])

    def test_non_loopback_target_uses_synthetic_runtime_proxy_without_external_traffic(self) -> None:
        external_origin = "http://workload.invalid:80"
        process, evidence = self._run_cli(campaign(external_origin), routes={"HTTP_PROXY": self.proxy_origin})
        self.assertEqual(process.returncode, 0, process.stderr)
        assert evidence is not None
        self.assertEqual(SyntheticProxyHandler.requests, [("http://workload.invalid/workload/0", "case-0")])
        self.assertEqual(evidence["cases"][0]["transport"]["http_status"], 200)
        self.assertEqual(RecordingHandler.requests, [])

    def test_runtime_route_accepts_a_docker_hostname_and_rejects_json_route_selection(self) -> None:
        external_origin = "http://workload.invalid:80"
        _, _, cases = self.module._campaign(campaign(external_origin))
        with patch.dict(os.environ, {"HTTP_PROXY": "http://cyberful-os:3128"}, clear=False):
            self.assertEqual(self.module._runtime_routes(cases), {"http": "http://cyberful-os:3128"})
        payload = campaign(self.origin)
        payload["authority"]["proxy_url"] = self.proxy_origin
        process, evidence = self._run_cli(payload)
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        self.assertEqual(RecordingHandler.requests, [])
        self.assertEqual(SyntheticProxyHandler.requests, [])
        process, evidence = self._run_cli(campaign(self.origin, cases=2, maximum=1))
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        self.assertEqual(RecordingHandler.requests, [])

    def test_inline_sensitive_header_refuses_before_any_connection(self) -> None:
        payload = campaign(self.origin)
        payload["cases"][0]["headers"] = {"Authorization": "inline-secret"}
        payload["cases"][0]["secret_headers"] = {}
        process, evidence = self._run_cli(payload)
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        self.assertEqual(RecordingHandler.requests, [])

    def test_stream_limit_terminates_a_real_process_group(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            capture = Path(directory) / "capture.bin"
            program = "import pathlib,sys,time; stream=pathlib.Path(sys.argv[1]).open('wb',buffering=0); [(stream.write(b'x'*64),time.sleep(.01)) for _ in range(1000)]"
            result = self.module._run_process(
                [sys.executable, "-c", program, str(capture)],
                time.monotonic() + 5,
                monitored_files=((capture, 256, "response body"),),
            )
            captured_bytes = capture.stat().st_size
        self.assertEqual(result.limit_exceeded, "response body")
        self.assertNotEqual(result.return_code, 0)
        self.assertLessEqual(captured_bytes, 256)

    def test_global_campaign_deadline_is_cumulative_across_requests(self) -> None:
        payload = campaign(self.origin, cases=2, maximum=2)
        payload["authority"]["requests_per_second"] = 0.1
        payload["authority"]["campaign_timeout_seconds"] = 1
        process, evidence = self._run_cli(payload)
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        self.assertIn("global campaign deadline", process.stderr)
        self.assertEqual(RecordingHandler.requests, [("/workload/0", "case-0")])

    def test_child_environment_drops_ambient_sentinel_and_forces_no_telemetry(self) -> None:
        with patch.dict(os.environ, {"CYBERFUL_TEST_SENTINEL": "must-not-leak", "HTTP_PROXY": "http://cyberful-os:8080", "ALL_PROXY": "http://ambient:8080", "NO_PROXY": "*", "SSL_CERT_FILE": "/runtime/ca.pem", "SSL_CERT_DIR": "/ambient", "CURL_CA_BUNDLE": "/runtime/curl-ca.pem", "DO_NOT_TRACK": "0"}, clear=False):
            environment = self.module._process_environment()
        self.assertNotIn("CYBERFUL_TEST_SENTINEL", environment)
        self.assertEqual(environment["HTTP_PROXY"], "http://cyberful-os:8080")
        self.assertEqual(environment["SSL_CERT_FILE"], "/runtime/ca.pem")
        self.assertEqual(environment["CURL_CA_BUNDLE"], "/runtime/curl-ca.pem")
        self.assertNotIn("ALL_PROXY", environment)
        self.assertNotIn("NO_PROXY", environment)
        self.assertNotIn("SSL_CERT_DIR", environment)
        self.assertEqual(environment["DO_NOT_TRACK"], "1")


if __name__ == "__main__":
    unittest.main()
