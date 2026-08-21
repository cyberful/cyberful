# ── Request Normalization Harness Tests ──────────────────────────
# Exercises real loopback traffic, preflight refusal before any connection,
#   bounded process output, environment isolation, and descendant cleanup.
# → cyberful/builtin/skills/trace-request-normalization/scripts/run_normalization_harness.py — implementation under test.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import copy
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
from types import ModuleType
from typing import Any
from unittest.mock import patch


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "run_normalization_harness.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("run_normalization_harness", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load normalization harness")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


class RecordingHandler(BaseHTTPRequestHandler):
    observations: list[tuple[str, str]] = []

    def do_GET(self) -> None:
        self.__class__.observations.append((self.path, self.headers.get("X-Cyberful-Variant", "")))
        body = json.dumps({"path": self.path}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


def campaign(origin: str, *, allowed_origin: str | None = None) -> dict[str, Any]:
    return {
        "$schema": "./normalization-campaign.schema.json",
        "campaign_id": "loopback-normalization",
        "authority": {
            "confirmed": True,
            "authorization_reference": "synthetic-loopback",
            "allowed_origins": [allowed_origin or origin],
            "max_requests": 1,
            "requests_per_second": 4,
            "request_timeout_seconds": 3,
        },
        "cases": [{
            "case_id": "encoded-path",
            "dimension": "path",
            "variant": "path-as-is control",
            "method": "GET",
            "url": f"{origin}/objects%2Fcontrolled",
            "headers": {"X-Cyberful-Variant": "encoded-path"},
            "secret_headers": {},
            "body_base64": "",
        }],
    }


class NormalizationHarnessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()
        RecordingHandler.observations = []
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
            process = subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "campaign.json", "--output", "evidence.json"], check=False, capture_output=True, text=True, timeout=10)
            evidence_path = workspace / "evidence.json"
            evidence = json.loads(evidence_path.read_text(encoding="utf-8")) if evidence_path.exists() else None
            return process, evidence

    def test_authorized_loopback_variant_preserves_raw_evidence(self) -> None:
        process, evidence = self._run_cli(campaign(self.origin))
        self.assertEqual(process.returncode, 0, process.stderr)
        assert evidence is not None
        self.assertEqual(RecordingHandler.observations, [("/objects%2Fcontrolled", "encoded-path")])
        self.assertEqual(evidence["cases"][0]["transport"]["http_status"], 200)
        self.assertFalse(evidence["cases"][0]["response"]["body_truncated"])

    def test_preflight_refuses_scope_and_sensitive_header_without_connection(self) -> None:
        wrong = f"http://127.0.0.1:{self.server.server_port + 1}"
        process, evidence = self._run_cli(campaign(self.origin, allowed_origin=wrong))
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        payload = campaign(self.origin)
        payload["cases"][0]["headers"] = {"Authorization": "inline-secret"}
        process, evidence = self._run_cli(payload)
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        self.assertEqual(RecordingHandler.observations, [])

    def test_localhost_and_canonical_output_collision_refuse_without_connection(self) -> None:
        localhost = f"http://localhost:{self.server.server_port}"
        process, evidence = self._run_cli(campaign(localhost))
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source = workspace / "campaign.json"
            original = json.dumps(campaign(self.origin)).encode()
            source.write_bytes(original)
            result = self.module.main(["--workspace", str(workspace), "--input", "campaign.json", "--output", "campaign.json"])
            self.assertEqual(result, 2)
            self.assertEqual(source.read_bytes(), original)
        self.assertEqual(RecordingHandler.observations, [])

    def test_non_loopback_route_is_host_provided_after_campaign_preflight(self) -> None:
        payload = campaign("http://example.test:80")
        _, _, cases = self.module._campaign(payload, Path.cwd())
        with patch.dict(os.environ, {"HTTP_PROXY": "", "CURL_CA_BUNDLE": "", "SSL_CERT_FILE": ""}, clear=False):
            with self.assertRaisesRegex(self.module.HarnessError, "host-provided HTTP_PROXY"):
                self.module._runtime_route(cases)
        with tempfile.TemporaryDirectory() as directory:
            ca_bundle = Path(directory) / "gateway-ca.pem"
            ca_bundle.write_text("synthetic", encoding="utf-8")
            with patch.dict(os.environ, {"HTTP_PROXY": "http://cyberful-os:8080", "CURL_CA_BUNDLE": str(ca_bundle), "SSL_CERT_FILE": ""}, clear=False):
                route = self.module._runtime_route(cases)
            self.assertEqual(route.http_proxy, "http://cyberful-os:8080")
            self.assertEqual(route.ca_bundle, ca_bundle.resolve())

    def test_process_output_and_file_growth_are_bounded_during_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            capture = Path(directory) / "capture.bin"
            program = "import pathlib,sys,time; stream=pathlib.Path(sys.argv[1]).open('wb',buffering=0); [(stream.write(b'x'*64),time.sleep(.01)) for _ in range(1000)]"
            result = self.module._run_process([sys.executable, "-c", program, str(capture)], time.monotonic() + 5, ((capture, 256, "response body"),))
            self.assertLessEqual(capture.stat().st_size, 256)
        self.assertEqual(result.limit_exceeded, "response body")
        stdout = self.module._run_process([sys.executable, "-c", "import sys,time; sys.stdout.buffer.write(b'x'*8192); sys.stdout.flush(); time.sleep(30)"], time.monotonic() + 5, ())
        self.assertEqual(stdout.limit_exceeded, "stdout")
        self.assertEqual(len(stdout.stdout), self.module.MAX_STDOUT_BYTES)

    def test_secret_boundary_and_global_deadline_are_cumulative(self) -> None:
        payload = campaign(self.origin)
        payload["cases"][0]["secret_headers"] = {"Authorization": "CYBERFUL_PROBE_AUTHORIZATION"}
        _, _, cases = self.module._campaign(payload, Path.cwd())
        with patch.dict(os.environ, {"CYBERFUL_PROBE_AUTHORIZATION": "x" * (self.module.MAX_SECRET_BYTES + 1)}, clear=False):
            with self.assertRaisesRegex(self.module.HarnessError, "absent or invalid"):
                self.module._resolved_secrets(cases)
        payload = campaign(self.origin)
        payload["authority"]["max_requests"] = 2
        payload["cases"].append(copy.deepcopy(payload["cases"][0]))
        payload["cases"][1]["case_id"] = "second"
        with patch.object(self.module, "CAMPAIGN_TIMEOUT_SECONDS", 0.15):
            with self.assertRaisesRegex(self.module.HarnessError, "deadline"):
                self.module.run_campaign(payload, Path.cwd(), "a" * 64)

    def test_timeout_reaps_real_descendant_group(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            pid_path = Path(directory) / "child.pid"
            heartbeat = Path(directory) / "heartbeat.bin"
            child = "import pathlib,sys,time; stream=pathlib.Path(sys.argv[1]).open('ab',buffering=0); [(stream.write(b'x'),time.sleep(.01)) for _ in range(3000)]"
            parent = "import pathlib,subprocess,sys,time; child=subprocess.Popen([sys.executable,'-c',sys.argv[3],sys.argv[2]]); pathlib.Path(sys.argv[1]).write_text(str(child.pid)); time.sleep(30)"
            result = self.module._run_process([sys.executable, "-c", parent, str(pid_path), str(heartbeat), child], time.monotonic() + 0.2, ())
            descendant = int(pid_path.read_text(encoding="utf-8"))
            size = heartbeat.stat().st_size
            time.sleep(0.15)
            self.assertEqual(heartbeat.stat().st_size, size)
            deadline = time.monotonic() + 2
            alive = True
            while alive and time.monotonic() < deadline:
                try:
                    os.kill(descendant, 0)
                except ProcessLookupError:
                    alive = False
                else:
                    time.sleep(0.02)
        self.assertTrue(result.timed_out)
        self.assertFalse(alive, "descendant survived process-group cleanup")

    def test_child_environment_is_allowlisted(self) -> None:
        with patch.dict(os.environ, {"SSH_AUTH_SOCK": "/secret", "HTTP_PROXY": "http://127.0.0.1:9000", "CYBERFUL_PROBE_AUTHORIZATION": "secret", "DO_NOT_TRACK": "0"}, clear=False):
            environment = self.module._process_environment()
        self.assertNotIn("SSH_AUTH_SOCK", environment)
        self.assertNotIn("CYBERFUL_PROBE_AUTHORIZATION", environment)
        self.assertNotIn("HTTP_PROXY", environment)
        self.assertEqual(environment["DO_NOT_TRACK"], "1")


if __name__ == "__main__":
    unittest.main()
