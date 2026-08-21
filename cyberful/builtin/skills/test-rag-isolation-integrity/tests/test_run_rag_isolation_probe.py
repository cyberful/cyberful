# ── RAG Isolation Probe Tests ───────────────────────────────
# Exercises real loopback and runtime-proxy traffic plus preflight, secret,
#   hard-cap, cumulative-deadline, collision, and descendant-cleanup boundaries.
# → cyberful/builtin/skills/test-rag-isolation-integrity/scripts/run_rag_isolation_probe.py — implementation.
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
SCRIPT = ROOT / "scripts" / "run_rag_isolation_probe.py"
SECRET = "Bearer synthetic-rag-secret"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("run_rag_isolation_probe", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load RAG isolation probe")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


class RecordingHandler(BaseHTTPRequestHandler):
    requests: list[tuple[str, str, dict[str, Any]]] = []

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        document = json.loads(body)
        authorization = self.headers.get("Authorization", "")
        self.__class__.requests.append((self.path, authorization, document))
        response = json.dumps({"echo": authorization, "marker": document["marker_ids"]}).encode()
        self.send_response(200)
        self.send_header("X-Reflected-Authorization", authorization)
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, format: str, *args: object) -> None:
        return


def payload(origin: str) -> dict[str, Any]:
    return {
        "$schema": "assets/rag-isolation-probe.schema.json",
        "attribution": {
            "authorization_reference": "synthetic-loopback", "expires_at": "2999-01-01T00:00:00Z",
            "allowed_origins": [origin], "actor_id": "actor-a", "tenant_id": "tenant-a",
        },
        "limits": {"max_requests": 1, "requests_per_second": 4},
        "cases": [{
            "id": "isolation-a", "endpoint": f"{origin}/retrieve", "query": "marker lookup",
            "corpus_id": "corpus-a", "actor_id": "actor-a", "tenant_id": "tenant-a", "marker_ids": ["marker-a"],
        }],
    }


class RagIsolationProbeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()
        RecordingHandler.requests = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
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
            child_environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "CYBERFUL_RAG_AUTHORIZATION": SECRET}
            if environment:
                child_environment.update(environment)
            process = subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "input.json", "--output", "evidence.json"], capture_output=True, text=True, timeout=10, env=child_environment, check=False)
            output = workspace / "evidence.json"
            return process, json.loads(output.read_text()) if output.exists() else None

    def test_literal_loopback_is_direct_and_redacts_secret(self) -> None:
        trap = "http://127.0.0.1:1"
        process, evidence = self._run(payload(self.origin), {"HTTP_PROXY": trap, "CURL_CA_BUNDLE": "/missing"})
        self.assertEqual(process.returncode, 0, process.stderr)
        assert evidence is not None
        self.assertEqual(RecordingHandler.requests[0][1], SECRET)
        execution = evidence["executions"][0]
        self.assertEqual(execution["route"], "direct-loopback")
        raw = base64.b64decode(execution["headers_base64"]) + base64.b64decode(execution["body_base64"])
        self.assertNotIn(SECRET.encode(), raw)
        self.assertIn(b"REDACTED_SECRET", raw)

    def test_invalid_scope_localhost_and_transport_injection_are_zero_connection(self) -> None:
        documents = []
        wrong = payload(self.origin)
        wrong["attribution"]["allowed_origins"] = [f"http://127.0.0.1:{self.server.server_port + 1}"]
        documents.append(wrong)
        documents.append(payload(f"http://localhost:{self.server.server_port}"))
        injected = payload(self.origin)
        injected["proxy_url"] = "http://127.0.0.1:1"
        documents.append(injected)
        for document in documents:
            process, evidence = self._run(document)
            self.assertEqual(process.returncode, 2)
            self.assertIsNone(evidence)
        self.assertEqual(RecordingHandler.requests, [])

    def test_non_loopback_requires_host_route_and_accepts_docker_proxy_name(self) -> None:
        document = payload("http://rag-service.invalid:8080")
        _, _, cases = self.module._validated(document)
        with patch.dict(os.environ, {"HTTP_PROXY": "", "CURL_CA_BUNDLE": "", "SSL_CERT_FILE": ""}, clear=False):
            with self.assertRaisesRegex(self.module.ProbeError, "host-provided HTTP_PROXY"):
                self.module._runtime_route(cases)
        with patch.dict(os.environ, {"HTTP_PROXY": "http://cyberful-os:8080", "CURL_CA_BUNDLE": "", "SSL_CERT_FILE": ""}, clear=False):
            with self.assertRaisesRegex(self.module.ProbeError, "CA bundle"):
                self.module._runtime_route(cases)
        with tempfile.TemporaryDirectory() as directory:
            ca = Path(directory) / "ca.pem"
            ca.write_text("synthetic")
            with patch.dict(os.environ, {"HTTP_PROXY": "http://cyberful-os:8080", "CURL_CA_BUNDLE": str(ca), "SSL_CERT_FILE": ""}, clear=False):
                route = self.module._runtime_route(cases)
            self.assertEqual(dict(route.proxies)["http"], "http://cyberful-os:8080")
            self.assertEqual(route.ca_bundle, b"synthetic")

    def test_proxy_and_private_ca_are_child_environment_only(self) -> None:
        document = payload("http://rag-service.invalid:8080")
        _, _, cases = self.module._validated(document)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ca = root / "ca.pem"
            ca.write_text("synthetic", encoding="utf-8")
            proxy = "http://cyberful-os:8080"
            with patch.dict(os.environ, {"HTTP_PROXY": proxy, "CURL_CA_BUNDLE": str(ca), "SSL_CERT_FILE": ""}, clear=False):
                route = self.module._runtime_route(cases)
            copied_ca = root / "private-ca.pem"
            self.module._write_private(copied_ca, route.ca_bundle)
            command = self.module._command(cases[0], route, root / "headers", root / "body")
            environment = self.module._child_environment(SECRET, ("HTTP_PROXY", proxy), copied_ca)
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
            document = payload("http://rag-service.invalid:8080")
            _, _, cases = self.module._validated(document)
            with patch.dict(os.environ, {"HTTP_PROXY": "http://cyberful-os:8080", "CURL_CA_BUNDLE": str(ca_link)}, clear=False):
                with self.assertRaisesRegex(self.module.ProbeError, "non-symlink"):
                    self.module._runtime_route(cases)

    def test_invalid_domain_uses_real_runtime_proxy(self) -> None:
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                ca = Path(directory) / "ca.pem"
                ca.write_text("synthetic")
                process, evidence = self._run(payload("http://rag-service.invalid:8080"), {"HTTP_PROXY": f"http://127.0.0.1:{proxy.server_port}", "CURL_CA_BUNDLE": str(ca)})
            self.assertEqual(process.returncode, 0, process.stderr)
            assert evidence is not None
            self.assertEqual(evidence["executions"][0]["route"], "runtime-http-proxy")
        finally:
            proxy.shutdown()
            proxy.server_close()
            thread.join(timeout=2)

    def test_collision_preserves_input_and_secret_control_char_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source = workspace / "input.json"
            original = json.dumps(payload(self.origin)).encode()
            source.write_bytes(original)
            with redirect_stderr(io.StringIO()):
                result = self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "input.json"])
            self.assertEqual(result, 2)
            self.assertEqual(source.read_bytes(), original)
        with patch.dict(os.environ, {"CYBERFUL_RAG_AUTHORIZATION": "bad\tsecret"}, clear=False):
            with self.assertRaisesRegex(self.module.ProbeError, "absent or invalid"):
                self.module._secret()

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
            redacted, truncated = self.module._capture(capture, "x")
            self.assertEqual(len(redacted), self.module.MAX_CAPTURE_BYTES)
            self.assertTrue(truncated)

    def test_global_deadline_is_cumulative_across_requests(self) -> None:
        document = payload(self.origin)
        document["limits"] = {"max_requests": 2, "requests_per_second": 0.1}
        second = dict(document["cases"][0])
        second["id"] = "isolation-b"
        second["query"] = "second marker lookup"
        document["cases"].append(second)
        with patch.dict(os.environ, {"CYBERFUL_RAG_AUTHORIZATION": SECRET}, clear=False):
            with self.assertRaisesRegex(self.module.ProbeError, "deadline"):
                self.module.run_probe(document, "a" * 64, time.monotonic() + 0.5)
        self.assertEqual(len(RecordingHandler.requests), 1)

    def test_hard_cap_and_deadline_cleanup_real_descendant(self) -> None:
        environment = self.module._child_environment(SECRET)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = root / "request"
            request.write_bytes(b"{}")
            capture = root / "capture"
            program = "import pathlib,sys,time; f=pathlib.Path(sys.argv[1]).open('wb',buffering=0); [(f.write(b'x'*4096),time.sleep(.001)) for _ in range(1000)]"
            result = self.module._run_process([sys.executable, "-c", program, str(capture)], request, environment, time.monotonic() + 4, (capture, root / "none"))
            self.assertTrue(result.limit_exceeded)
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
