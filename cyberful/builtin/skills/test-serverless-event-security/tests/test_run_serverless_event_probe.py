# ── Serverless Event Probe Tests ────────────────────────────
# Exercises real direct/proxied event delivery and fail-closed transport,
#   secret, output-cap, deadline, collision, and process-group boundaries.
# → cyberful/builtin/skills/test-serverless-event-security/scripts/run_serverless_event_probe.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import base64
from contextlib import redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
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


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "run_serverless_event_probe.py"
AUTHORIZATION = "Bearer synthetic-event-secret"
SIGNATURE = "v1=synthetic-signature"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("run_serverless_event_probe", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load serverless event probe")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


class EventHandler(BaseHTTPRequestHandler):
    requests: list[tuple[str, str, str, dict[str, Any]]] = []

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        authorization = self.headers.get("Authorization", "")
        signature = self.headers.get("X-Cyberful-Event-Signature", "")
        document = json.loads(body)
        self.__class__.requests.append((self.path, authorization, signature, document))
        response = json.dumps({"auth": authorization, "signature": signature, "event_id": document["event_id"]}).encode()
        self.send_response(202)
        self.send_header("X-Echo-Authorization", authorization)
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format: str, *args: object) -> None:
        return


def payload(origin: str) -> dict[str, Any]:
    return {
        "$schema": "assets/serverless-event-probe.schema.json",
        "attribution": {
            "authorization_reference": "synthetic-loopback", "expires_at": "2999-01-01T00:00:00Z",
            "allowed_origins": [origin], "actor_id": "actor-a", "tenant_id": "tenant-a", "source_id": "source-a",
        },
        "limits": {"max_requests": 1, "requests_per_second": 4},
        "cases": [{
            "id": "event-a", "endpoint": f"{origin}/events", "event_id": "evt-a", "event_type": "order.created",
            "schema_version": "1", "payload": {"order": "synthetic"}, "actor_id": "actor-a", "tenant_id": "tenant-a",
            "source_id": "source-a", "expected_effect": "one synthetic receipt",
        }],
    }


class ServerlessEventProbeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()
        EventHandler.requests = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), EventHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def _run(self, document: dict[str, Any], environment: dict[str, str] | None = None) -> tuple[subprocess.CompletedProcess[str], dict[str, Any] | None]:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "input.json").write_text(json.dumps(document), encoding="utf-8")
            child_environment = {
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "CYBERFUL_SERVERLESS_AUTHORIZATION": AUTHORIZATION,
                "CYBERFUL_SERVERLESS_SIGNATURE": SIGNATURE,
            }
            if environment:
                child_environment.update(environment)
            process = subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "input.json", "--output", "evidence.json"], capture_output=True, text=True, timeout=10, env=child_environment, check=False)
            output = workspace / "evidence.json"
            return process, json.loads(output.read_text()) if output.exists() else None

    def test_literal_loopback_ignores_proxy_and_redacts_both_secrets(self) -> None:
        process, evidence = self._run(payload(self.origin), {"HTTP_PROXY": "http://127.0.0.1:1", "CURL_CA_BUNDLE": "/missing"})
        self.assertEqual(process.returncode, 0, process.stderr)
        assert evidence is not None
        self.assertEqual(EventHandler.requests[0][1:3], (AUTHORIZATION, SIGNATURE))
        execution = evidence["executions"][0]
        raw = base64.b64decode(execution["headers_base64"]) + base64.b64decode(execution["body_base64"])
        self.assertNotIn(AUTHORIZATION.encode(), raw)
        self.assertNotIn(SIGNATURE.encode(), raw)
        self.assertEqual(execution["route"], "direct-loopback")

    def test_scope_localhost_transport_and_secret_refuse_before_connection(self) -> None:
        wrong = payload(self.origin)
        wrong["attribution"]["allowed_origins"] = [f"http://127.0.0.1:{self.server.server_port + 1}"]
        localhost = payload(f"http://localhost:{self.server.server_port}")
        injected = payload(self.origin)
        injected["ca_bundle"] = "/tmp/model.pem"
        for document in (wrong, localhost, injected):
            process, evidence = self._run(document)
            self.assertEqual(process.returncode, 2)
            self.assertIsNone(evidence)
        with patch.dict(os.environ, {"CYBERFUL_SERVERLESS_AUTHORIZATION": "bad\nsecret", "CYBERFUL_SERVERLESS_SIGNATURE": SIGNATURE}, clear=False):
            with self.assertRaisesRegex(self.module.ProbeError, "absent or invalid"):
                self.module._secrets()
        self.assertEqual(EventHandler.requests, [])

    def test_invalid_domain_uses_host_proxy_and_missing_route_is_zero_connection(self) -> None:
        document = payload("http://event-service.invalid:8080")
        _, _, cases = self.module._validated(document)
        with patch.dict(os.environ, {"HTTP_PROXY": "", "CURL_CA_BUNDLE": "", "SSL_CERT_FILE": ""}, clear=False):
            with self.assertRaisesRegex(self.module.ProbeError, "host-provided HTTP_PROXY"):
                self.module._runtime_route(cases)
        with patch.dict(os.environ, {"HTTP_PROXY": "http://cyberful-os:8080", "CURL_CA_BUNDLE": "", "SSL_CERT_FILE": ""}, clear=False):
            with self.assertRaisesRegex(self.module.ProbeError, "CA bundle"):
                self.module._runtime_route(cases)
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), EventHandler)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                ca = Path(directory) / "ca.pem"
                ca.write_text("synthetic")
                process, evidence = self._run(document, {"HTTP_PROXY": f"http://127.0.0.1:{proxy.server_port}", "CURL_CA_BUNDLE": str(ca)})
            self.assertEqual(process.returncode, 0, process.stderr)
            assert evidence is not None
            self.assertEqual(evidence["executions"][0]["route"], "runtime-http-proxy")
        finally:
            proxy.shutdown()
            proxy.server_close()
            thread.join(timeout=2)

    def test_proxy_and_private_ca_are_child_environment_only(self) -> None:
        document = payload("http://event-service.invalid:8080")
        _, _, cases = self.module._validated(document)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ca = root / "ca.pem"
            ca.write_text("synthetic", encoding="utf-8")
            proxy = "http://cyberful-os:8080"
            with patch.dict(os.environ, {"HTTP_PROXY": proxy, "CURL_CA_BUNDLE": str(ca), "SSL_CERT_FILE": ""}, clear=False):
                route = self.module._runtime_route(cases)
            self.assertEqual(route.ca_bundle, b"synthetic")
            copied_ca = root / "private-ca.pem"
            self.module._write_private(copied_ca, route.ca_bundle)
            command = self.module._command(cases[0], route, root / "headers", root / "body")
            environment = self.module._child_environment((AUTHORIZATION, SIGNATURE), ("HTTP_PROXY", proxy), copied_ca)
            self.assertNotIn(proxy, command)
            self.assertNotIn(str(ca), command)
            self.assertNotIn("--cacert", command)
            self.assertEqual(environment["HTTP_PROXY"], proxy)
            self.assertEqual(environment["CURL_CA_BUNDLE"], str(copied_ca))
            for name in ("NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"):
                self.assertEqual(environment[name], "")
            self.assertEqual(copied_ca.stat().st_mode & 0o777, 0o600)

    def test_input_and_ca_reject_symlinks_and_inode_swap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source = workspace / "input.json"
            source.write_text(json.dumps(payload(self.origin)), encoding="utf-8")
            link = workspace / "link.json"
            link.symlink_to(source)
            with self.assertRaisesRegex(self.module.ProbeError, "symbolic links"):
                self.module._read_input(workspace, "link.json")
            real_open = os.open
            replacement = workspace / "replacement.json"
            replacement.write_text(json.dumps(payload(self.origin)), encoding="utf-8")

            def swap_before_open(path: object, flags: int, *args: object, **kwargs: object) -> int:
                if Path(os.path.realpath(path)) == Path(os.path.realpath(source)):
                    os.replace(replacement, source)
                return real_open(path, flags, *args, **kwargs)

            with patch.object(self.module.os, "open", side_effect=swap_before_open):
                with self.assertRaisesRegex(self.module.ProbeError, "changed during open"):
                    self.module._read_input(workspace, "input.json")
            ca = workspace / "ca.pem"
            ca.write_text("synthetic", encoding="utf-8")
            ca_link = workspace / "ca-link.pem"
            ca_link.symlink_to(ca)
            document = payload("http://event-service.invalid:8080")
            _, _, cases = self.module._validated(document)
            with patch.dict(os.environ, {"HTTP_PROXY": "http://cyberful-os:8080", "CURL_CA_BUNDLE": str(ca_link)}, clear=False):
                with self.assertRaisesRegex(self.module.ProbeError, "non-symlink"):
                    self.module._runtime_route(cases)

    def test_collision_preserves_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source = workspace / "input.json"
            original = json.dumps(payload(self.origin)).encode()
            source.write_bytes(original)
            with redirect_stderr(io.StringIO()):
                result = self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "input.json"])
            self.assertEqual(result, 2)
            self.assertEqual(source.read_bytes(), original)
        self.assertEqual(EventHandler.requests, [])

    def test_publication_race_preserves_competing_destination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "evidence.json"

            def win_race(*args: object, **kwargs: object) -> None:
                destination.write_bytes(b"competing-writer")
                raise FileExistsError(destination)

            with patch.object(self.module.os, "link", side_effect=win_race):
                with self.assertRaisesRegex(self.module.ProbeError, "appeared during"):
                    self.module._write(destination, {"result": "probe"}, time.monotonic() + 2)
            self.assertEqual(destination.read_bytes(), b"competing-writer")

    def test_redaction_expansion_sets_truncated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            capture = Path(directory) / "capture"
            capture.write_bytes(b"x" * (self.module.MAX_CAPTURE_BYTES // 2))
            redacted, truncated = self.module._capture(capture, ("x", "not-present"))
            self.assertEqual(len(redacted), self.module.MAX_CAPTURE_BYTES)
            self.assertTrue(truncated)

    def test_global_deadline_is_cumulative_across_events(self) -> None:
        document = payload(self.origin)
        document["limits"] = {"max_requests": 2, "requests_per_second": 0.1}
        second = dict(document["cases"][0])
        second["id"] = "event-b"
        second["event_id"] = "evt-b"
        document["cases"].append(second)
        environment = {"CYBERFUL_SERVERLESS_AUTHORIZATION": AUTHORIZATION, "CYBERFUL_SERVERLESS_SIGNATURE": SIGNATURE}
        with patch.dict(os.environ, environment, clear=False):
            with self.assertRaisesRegex(self.module.ProbeError, "deadline"):
                self.module.run_probe(document, "a" * 64, time.monotonic() + 0.5)
        self.assertEqual(len(EventHandler.requests), 1)

    def test_hard_file_cap_and_deadline_stop_descendant(self) -> None:
        environment = self.module._child_environment((AUTHORIZATION, SIGNATURE))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = root / "request"
            request.write_bytes(b"{}")
            capture = root / "capture"
            writer = "import pathlib,sys,time; f=pathlib.Path(sys.argv[1]).open('wb',buffering=0); [(f.write(b'x'*4096),time.sleep(.001)) for _ in range(1000)]"
            bounded = self.module._run_process([sys.executable, "-c", writer, str(capture)], request, environment, time.monotonic() + 4, (capture, root / "none"))
            self.assertTrue(bounded.limit_exceeded)
            self.assertLessEqual(capture.stat().st_size, self.module.MAX_CAPTURE_BYTES)
            heartbeat = root / "heartbeat"
            parent = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',sys.argv[2],sys.argv[1]]); time.sleep(30)"
            child = "import pathlib,sys,time; f=pathlib.Path(sys.argv[1]).open('ab',buffering=0); [(f.write(b'x'),time.sleep(.01)) for _ in range(3000)]"
            timed = self.module._run_process([sys.executable, "-c", parent, str(heartbeat), child], request, environment, time.monotonic() + 0.2, (root / "a", root / "b"))
            self.assertTrue(timed.timed_out)
            size = heartbeat.stat().st_size
            time.sleep(0.15)
            self.assertEqual(heartbeat.stat().st_size, size)
            exited_heartbeat = root / "exited-heartbeat"
            exited_parent = "import subprocess,sys; subprocess.Popen([sys.executable,'-c',sys.argv[2],sys.argv[1]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)"
            completed = self.module._run_process([sys.executable, "-c", exited_parent, str(exited_heartbeat), child], request, environment, time.monotonic() + 2, (root / "c", root / "d"))
            self.assertEqual(completed.return_code, 0)
            size = exited_heartbeat.stat().st_size if exited_heartbeat.exists() else 0
            time.sleep(0.15)
            self.assertEqual(exited_heartbeat.stat().st_size if exited_heartbeat.exists() else 0, size)


if __name__ == "__main__":
    unittest.main()
