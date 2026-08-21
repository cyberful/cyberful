# ── Loopback Deserialization Harness Tests ───────────────────────
# Exercises real loopback fixture delivery, refusal of non-loopback authority,
#   secret redaction, bounded process output, and descendant cleanup.
# → cyberful/builtin/skills/test-deserialization-object-binding/scripts/run_deserialization_harness.py — implementation under test.
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
SCRIPT = SKILL_ROOT / "scripts" / "run_deserialization_harness.py"
OUTPUT_SCHEMA = SKILL_ROOT / "assets" / "deserialization-evidence.schema.json"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("run_deserialization_harness", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load deserialization harness")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


class RecordingHandler(BaseHTTPRequestHandler):
    observations: list[tuple[str, str, bytes, str]] = []
    delay = 0.0

    def do_POST(self) -> None:
        time.sleep(self.__class__.delay)
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        secret = self.headers.get("Authorization", "")
        self.__class__.observations.append((self.path, self.headers.get("Content-Type", ""), body, secret))
        response = json.dumps({"accepted": True, "echo": secret}).encode()
        self.send_response(202)
        self.send_header("Content-Type", "application/json")
        if secret:
            self.send_header("X-Echo-Authorization", secret)
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format: str, *args: object) -> None:
        return


def harness(origin: str, *, allowed_origin: str | None = None, secret: bool = False) -> dict[str, Any]:
    return {
        "$schema": "./deserialization-harness.schema.json",
        "campaign_id": "loopback-deserialization",
        "authority": {
            "confirmed": True,
            "authorization_reference": "disposable-loopback-lab",
            "allowed_origin": allowed_origin or origin,
            "max_requests": 1,
            "request_timeout_seconds": 3,
        },
        "fixtures": [{
            "fixture_id": "data-control",
            "format": "json",
            "expected_boundary": "closed DTO",
            "url": f"{origin}/lab/decode",
            "content_type": "application/json",
            "secret_headers": {"Authorization": "CYBERFUL_LAB_AUTHORIZATION"} if secret else {},
            "body_base64": "eyJuYW1lIjoiY29udHJvbCJ9",
        }],
    }


class DeserializationHarnessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()
        RecordingHandler.observations = []
        RecordingHandler.delay = 0.0
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
            (workspace / "harness.json").write_text(json.dumps(payload), encoding="utf-8")
            process = subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "harness.json", "--output", "evidence.json"], check=False, capture_output=True, text=True, timeout=10)
            output = workspace / "evidence.json"
            return process, json.loads(output.read_text(encoding="utf-8")) if output.exists() else None

    def test_authorized_loopback_fixture_preserves_raw_evidence(self) -> None:
        process, evidence = self._run_cli(harness(self.origin))
        self.assertEqual(process.returncode, 0, process.stderr)
        assert evidence is not None
        self.assertEqual(RecordingHandler.observations, [("/lab/decode", "application/json", b'{"name":"control"}', "")])
        self.assertEqual(evidence["fixtures"][0]["transport"]["http_status"], 202)
        self.assertEqual(evidence["limits"]["network"], "loopback")

    def test_output_schema_accepts_runtime_language_native_format(self) -> None:
        payload = harness(self.origin)
        payload["fixtures"][0]["format"] = "language-native"
        process, evidence = self._run_cli(payload)
        self.assertEqual(process.returncode, 0, process.stderr)
        assert evidence is not None
        schema = json.loads(OUTPUT_SCHEMA.read_text(encoding="utf-8"))
        formats = schema["$defs"]["evidence"]["properties"]["format"]["enum"]
        self.assertEqual(evidence["fixtures"][0]["format"], "language-native")
        self.assertIn("language-native", formats)
        self.assertNotIn("form", formats)

    def test_non_loopback_and_origin_mismatch_refuse_before_connection(self) -> None:
        process, evidence = self._run_cli(harness(self.origin, allowed_origin="http://example.test:80"))
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        other = f"http://127.0.0.1:{self.server.server_port + 1}"
        process, evidence = self._run_cli(harness(self.origin, allowed_origin=other))
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        self.assertEqual(RecordingHandler.observations, [])

    def test_localhost_and_canonical_output_collision_refuse_without_connection(self) -> None:
        localhost = f"http://localhost:{self.server.server_port}"
        process, evidence = self._run_cli(harness(localhost))
        self.assertEqual(process.returncode, 2)
        self.assertIsNone(evidence)
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source = workspace / "harness.json"
            original = json.dumps(harness(self.origin)).encode()
            source.write_bytes(original)
            result = self.module.main(["--workspace", str(workspace), "--input", "harness.json", "--output", "harness.json"])
            self.assertEqual(result, 2)
            self.assertEqual(source.read_bytes(), original)
        self.assertEqual(RecordingHandler.observations, [])

    def test_secret_is_resolved_after_preflight_and_redacted(self) -> None:
        payload = harness(self.origin, secret=True)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"CYBERFUL_LAB_AUTHORIZATION": ""}, clear=False):
            _, _, fixtures = self.module._campaign(payload, Path(directory))
            with self.assertRaisesRegex(self.module.HarnessError, "absent or invalid"):
                self.module._resolved_secrets(fixtures)
        secret = "loopback-environment-secret"
        with patch.dict(os.environ, {"CYBERFUL_LAB_AUTHORIZATION": secret}, clear=False):
            process, evidence = self._run_cli(payload)
        self.assertEqual(process.returncode, 0, process.stderr)
        assert evidence is not None
        self.assertEqual(RecordingHandler.observations[0][3], secret)
        self.assertNotIn(secret, json.dumps(evidence))
        self.assertEqual(evidence["fixtures"][0]["response"]["headers_redactions"], 1)
        self.assertEqual(evidence["fixtures"][0]["response"]["body_redactions"], 1)
        with patch.dict(os.environ, {"CYBERFUL_LAB_AUTHORIZATION": "bad\u007fsecret"}, clear=False):
            _, _, fixtures = self.module._campaign(payload, Path.cwd())
            with self.assertRaisesRegex(self.module.HarnessError, "absent or invalid"):
                self.module._resolved_secrets(fixtures)

    def test_process_boundaries_and_environment_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            capture = Path(directory) / "capture.bin"
            program = "import pathlib,sys,time; stream=pathlib.Path(sys.argv[1]).open('wb',buffering=0); [(stream.write(b'x'*64),time.sleep(.01)) for _ in range(1000)]"
            result = self.module._run_process([sys.executable, "-c", program, str(capture)], time.monotonic() + 5, ((capture, 256, "response body"),))
            self.assertLessEqual(capture.stat().st_size, 256)
        self.assertEqual(result.limit_exceeded, "response body")
        stdout = self.module._run_process([sys.executable, "-c", "import sys,time; sys.stdout.buffer.write(b'x'*8192); sys.stdout.flush(); time.sleep(30)"], time.monotonic() + 5, ())
        self.assertEqual(stdout.limit_exceeded, "stdout")
        with patch.dict(os.environ, {"SSH_AUTH_SOCK": "/secret", "HTTP_PROXY": "http://127.0.0.1:9000", "CYBERFUL_LAB_AUTHORIZATION": "secret", "DO_NOT_TRACK": "0"}, clear=False):
            environment = self.module._process_environment()
        self.assertNotIn("SSH_AUTH_SOCK", environment)
        self.assertNotIn("CYBERFUL_LAB_AUTHORIZATION", environment)
        self.assertEqual(environment["DO_NOT_TRACK"], "1")

    def test_global_deadline_is_cumulative_across_fixtures(self) -> None:
        payload = harness(self.origin)
        payload["authority"]["max_requests"] = 2
        payload["fixtures"].append(dict(payload["fixtures"][0]))
        payload["fixtures"][1]["fixture_id"] = "second"
        RecordingHandler.delay = 0.1
        with patch.object(self.module, "CAMPAIGN_TIMEOUT_SECONDS", 0.15):
            with self.assertRaisesRegex(self.module.HarnessError, "global deadline"):
                self.module.run_harness(payload, Path.cwd(), "a" * 64)

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
