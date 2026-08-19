# ── Isolated Web Cache Probe Tests ───────────────────────────────
# Exercises real paired loopback traffic, preflight refusal before connection,
#   bounded output, environment isolation, and descendant process cleanup.
# → cyberful/builtin/skills/test-web-cache-behavior/scripts/run_cache_probe.py — implementation under test.
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
from types import ModuleType
from typing import Any
from unittest.mock import patch


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "run_cache_probe.py"
TOKEN = "cyberful_case_7f31"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("run_cache_probe", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load cache probe")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


class RecordingHandler(BaseHTTPRequestHandler):
    observations: list[tuple[str, str]] = []

    def do_GET(self) -> None:
        language = self.headers.get("Accept-Language", "")
        self.__class__.observations.append((self.path, language))
        body = json.dumps({"language": language, "marker": TOKEN}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, max-age=30")
        self.send_header("Cache-Status", "Synthetic; hit")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


def probe(origin: str, *, allowed_origin: str | None = None, include_token: bool = True) -> dict[str, Any]:
    path = f"/cache/{TOKEN}" if include_token else "/cache/shared"
    request = lambda language: {"method": "GET", "url": f"{origin}{path}", "headers": {"Accept-Language": language}, "secret_headers": {}, "body_base64": ""}
    return {
        "$schema": "./cache-probe.schema.json",
        "campaign_id": "loopback-cache",
        "authority": {
            "confirmed": True,
            "authorization_reference": "synthetic-loopback",
            "allowed_origins": [allowed_origin or origin],
            "isolation_token": TOKEN,
            "max_requests": 2,
            "requests_per_second": 2,
            "request_timeout_seconds": 3,
        },
        "pairs": [{"pair_id": "language", "dimension": "Accept-Language", "prime": request("en"), "observe": request("fr")}],
    }


class CacheProbeTests(unittest.TestCase):
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
            (workspace / "probe.json").write_text(json.dumps(payload), encoding="utf-8")
            process = subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "probe.json", "--output", "evidence.json"], check=False, capture_output=True, text=True, timeout=10)
            output = workspace / "evidence.json"
            return process, json.loads(output.read_text(encoding="utf-8")) if output.exists() else None

    def test_authorized_loopback_pair_preserves_raw_evidence(self) -> None:
        process, evidence = self._run_cli(probe(self.origin))
        self.assertEqual(process.returncode, 0, process.stderr)
        assert evidence is not None
        self.assertEqual(RecordingHandler.observations, [(f"/cache/{TOKEN}", "en"), (f"/cache/{TOKEN}", "fr")])
        self.assertEqual([entry["role"] for entry in evidence["pairs"][0]["observations"]], ["prime", "observe"])
        self.assertEqual(evidence["pairs"][0]["observations"][0]["transport"]["http_status"], 200)

    def test_preflight_refuses_scope_and_missing_isolation_without_connection(self) -> None:
        wrong = f"http://127.0.0.1:{self.server.server_port + 1}"
        process, evidence = self._run_cli(probe(self.origin, allowed_origin=wrong))
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        process, evidence = self._run_cli(probe(self.origin, include_token=False))
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        self.assertEqual(RecordingHandler.observations, [])

    def test_localhost_and_canonical_output_collision_refuse_without_connection(self) -> None:
        localhost = f"http://localhost:{self.server.server_port}"
        process, evidence = self._run_cli(probe(localhost))
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source = workspace / "probe.json"
            original = json.dumps(probe(self.origin)).encode()
            source.write_bytes(original)
            result = self.module.main(["--workspace", str(workspace), "--input", "probe.json", "--output", "probe.json"])
            self.assertEqual(result, 2)
            self.assertEqual(source.read_bytes(), original)
        self.assertEqual(RecordingHandler.observations, [])

    def test_non_loopback_route_is_host_provided_after_campaign_preflight(self) -> None:
        payload = probe("http://example.test:80")
        _, _, pairs = self.module._campaign(payload, Path.cwd())
        with patch.dict(os.environ, {"HTTP_PROXY": "", "CURL_CA_BUNDLE": "", "SSL_CERT_FILE": ""}, clear=False):
            with self.assertRaisesRegex(self.module.ProbeError, "host-provided HTTP_PROXY"):
                self.module._runtime_route(pairs)
        with tempfile.TemporaryDirectory() as directory:
            ca_bundle = Path(directory) / "gateway-ca.pem"
            ca_bundle.write_text("synthetic", encoding="utf-8")
            with patch.dict(os.environ, {"HTTP_PROXY": "http://cyberful-os:8080", "CURL_CA_BUNDLE": str(ca_bundle), "SSL_CERT_FILE": ""}, clear=False):
                route = self.module._runtime_route(pairs)
            self.assertEqual(route.http_proxy, "http://cyberful-os:8080")
            self.assertEqual(route.ca_bundle, ca_bundle.resolve())

    def test_process_boundaries_and_environment_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            capture = Path(directory) / "capture.bin"
            program = "import pathlib,sys,time; stream=pathlib.Path(sys.argv[1]).open('wb',buffering=0); [(stream.write(b'x'*64),time.sleep(.01)) for _ in range(1000)]"
            result = self.module._run_process([sys.executable, "-c", program, str(capture)], time.monotonic() + 5, ((capture, 256, "response body"),))
            self.assertLessEqual(capture.stat().st_size, 256)
        self.assertEqual(result.limit_exceeded, "response body")
        stdout = self.module._run_process([sys.executable, "-c", "import sys,time; sys.stdout.buffer.write(b'x'*8192); sys.stdout.flush(); time.sleep(30)"], time.monotonic() + 5, ())
        self.assertEqual(stdout.limit_exceeded, "stdout")
        with patch.dict(os.environ, {"SSH_AUTH_SOCK": "/secret", "HTTP_PROXY": "http://127.0.0.1:9000", "CYBERFUL_PROBE_COOKIE": "secret", "DO_NOT_TRACK": "0"}, clear=False):
            environment = self.module._process_environment()
        self.assertNotIn("SSH_AUTH_SOCK", environment)
        self.assertNotIn("CYBERFUL_PROBE_COOKIE", environment)
        self.assertNotIn("HTTP_PROXY", environment)
        self.assertEqual(environment["DO_NOT_TRACK"], "1")

    def test_secret_boundary_and_global_deadline_are_cumulative(self) -> None:
        payload = probe(self.origin)
        payload["pairs"][0]["prime"]["secret_headers"] = {"Cookie": "CYBERFUL_PROBE_COOKIE"}
        _, _, pairs = self.module._campaign(payload, Path.cwd())
        with patch.dict(os.environ, {"CYBERFUL_PROBE_COOKIE": "bad\tsecret"}, clear=False):
            with self.assertRaisesRegex(self.module.ProbeError, "absent or invalid"):
                self.module._resolved_secrets(pairs)
        with patch.object(self.module, "CAMPAIGN_TIMEOUT_SECONDS", 0.2):
            with self.assertRaisesRegex(self.module.ProbeError, "deadline"):
                self.module.run_probe(probe(self.origin), Path.cwd(), "a" * 64)

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


if __name__ == "__main__":
    unittest.main()
